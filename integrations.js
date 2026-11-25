const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("./db");

const FREE_LIMIT = 2;
const PREMIUM_AMOUNT = 500; // centimes, soit 5 EUR

// ---------- Migrations (additives, sans casser l'existant) ----------
const hasCol = (t, c) =>
  db
    .prepare(`PRAGMA table_info(${t})`)
    .all()
    .some((x) => x.name === c);
const addCol = (t, c, def) => {
  if (!hasCol(t, c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`);
};
addCol("livres", "summary", "TEXT");
addCol("livres", "summary_model", "TEXT");
addCol("livres", "summary_generated_at", "TEXT");
addCol("emprunts", "payment_status", "TEXT NOT NULL DEFAULT 'free'"); // pending / paid / free
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT NOT NULL,
  email               TEXT NOT NULL UNIQUE,
  password_hash       TEXT NOT NULL,
  subscription_status TEXT NOT NULL DEFAULT 'free' CHECK (subscription_status IN ('free','premium')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);`);

// ---------- Utilitaires ----------
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
const jwtSecret = () => process.env.JWT_SECRET || "dev-secret-a-changer";
if (!process.env.JWT_SECRET)
  console.warn("[!] JWT_SECRET absent du .env : secret de dev utilisé");

function userFromRequest(req) {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer (.+)$/i.exec(h);
  if (!m)
    throw new ApiError(
      401,
      "En-tête Authorization invalide (attendu : Bearer <token>)",
    );
  let payload;
  try {
    payload = jwt.verify(m[1], jwtSecret());
  } catch {
    throw new ApiError(401, "Token invalide ou expiré");
  }
  const u = db
    .prepare(
      "SELECT id, name, email, subscription_status FROM users WHERE id = ?",
    )
    .get(payload.sub);
  if (!u) throw new ApiError(401, "Utilisateur introuvable");
  return u;
}
function requireAuth(req, res, next) {
  const u = userFromRequest(req);
  if (!u) throw new ApiError(401, "Authentification requise (Bearer token)");
  req.user = u;
  next();
}

function getLivre(idParam) {
  const id = Number(idParam);
  if (!Number.isInteger(id) || id < 1)
    throw new ApiError(422, "Identifiant de livre invalide");
  const livre = db.prepare("SELECT * FROM livres WHERE id = ?").get(id);
  if (!livre) throw new ApiError(404, `Livre ${id} introuvable`);
  return livre;
}
const summaryData = (l) => ({
  book_id: l.id,
  title: l.titre,
  summary: l.summary,
  generated_by: l.summary_model,
  generated_at: l.summary_generated_at,
});

// Membre rattaché à un utilisateur : même email, sinon membre_id fourni
const membreIdFor = (user, fallback) => {
  const m = db
    .prepare("SELECT id FROM membres WHERE lower(email) = lower(?)")
    .get(user.email);
  if (m) return m.id;
  return Number.isInteger(fallback) ? fallback : null;
};
const activeCount = (membreId) =>
  db
    .prepare(
      "SELECT COUNT(*) AS n FROM emprunts WHERE membre_id = ? AND date_retour_reelle IS NULL",
    )
    .get(membreId).n;

// ---------- OpenAI (ou API compatible) ----------
async function openaiRequest(messages, stream = false) {
  const key = process.env.OPENAI_API_KEY;
  if (!key)
    throw new ApiError(
      503,
      "Service IA non configuré (OPENAI_API_KEY manquante)",
    );
  const base = (
    process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"
  ).replace(/\/$/, "");
  let r;
  try {
    r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        messages,
        temperature: 0.4,
        stream,
      }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    throw new ApiError(503, `Service OpenAI indisponible : ${e.message}`);
  }
  if (!r.ok) {
    const txt = (await r.text().catch(() => "")).slice(0, 200);
    throw new ApiError(503, `OpenAI a répondu ${r.status} : ${txt}`);
  }
  return r;
}
async function chat(messages) {
  const r = await openaiRequest(messages);
  const j = await r.json();
  const text = j.choices?.[0]?.message?.content?.trim();
  if (!text) throw new ApiError(503, "Réponse OpenAI vide");
  return text;
}
const summaryMessages = (l) => [
  {
    role: "system",
    content:
      "Tu es un expert en littérature. Tu génères des résumés concis et accrocheurs pour des fiches de bibliothèque. Réponds toujours en français. Maximum 3 phrases.",
  },
  {
    role: "user",
    content: `Génère un résumé pour le livre intitulé "${l.titre}" écrit par ${l.auteur}, publié en ${l.annee}.`,
  },
];
const saveSummary = (id, text) => {
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const at = new Date().toISOString();
  db.prepare(
    "UPDATE livres SET summary=?, summary_model=?, summary_generated_at=? WHERE id=?",
  ).run(text, model, at, id);
  return { model, at };
};
function parseKeywords(raw) {
  let list = [];
  const m = raw.match(/\[[\s\S]*\]/);
  try {
    list = JSON.parse(m ? m[0] : raw);
  } catch {
    list = raw.split(/[,\n]/);
  }
  return [
    ...new Set(
      list
        .filter((k) => typeof k === "string")
        .map((k) => k.trim())
        .filter(Boolean),
    ),
  ].slice(0, 8);
}

// ---------- Stripe ----------
let stripeClient;
function stripe() {
  if (!process.env.STRIPE_SECRET_KEY)
    throw new ApiError(
      503,
      "Stripe non configuré (STRIPE_SECRET_KEY manquante)",
    );
  if (!stripeClient) {
    const Stripe = require("stripe");
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return stripeClient;
}
// Vérification manuelle de Stripe-Signature : t=...,v1=HMAC_SHA256("t.payload", secret)
function verifyStripeSignature(raw, header, secret, toleranceSec = 300) {
  if (!raw || !header) return false;
  let t;
  const sigs = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=");
    if (k === "t") t = v;
    else if (k === "v1") sigs.push(v);
  }
  if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${t}.`)
    .update(raw)
    .digest();
  return sigs.some((s) => {
    const b = Buffer.from(s, "hex");
    return b.length === expected.length && crypto.timingSafeEqual(b, expected);
  });
}

// ---------- Middleware : limite d'emprunts du mode free ----------
function limiteAbonnement(req, res, next) {
  if (req.method !== "POST" || req.path !== "/") return next();
  let user;
  try {
    user = userFromRequest(req);
  } catch (e) {
    return res
      .status(e.status || 401)
      .json({ success: false, message: e.message });
  }
  if (!user) return next(); // appel anonyme : comportement historique (Séance 3)

  const membreId = membreIdFor(user, req.body && req.body.membre_id);
  if (
    user.subscription_status === "free" &&
    membreId &&
    activeCount(membreId) >= FREE_LIMIT
  ) {
    return res.status(403).json({
      success: false,
      message: `Abonnement gratuit limité à ${FREE_LIMIT} emprunts actifs. Passez premium pour emprunter davantage.`,
    });
  }
  const paymentStatus =
    user.subscription_status === "premium" ? "paid" : "free";
  const orig = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode === 201 && body && body.id) {
      db.prepare("UPDATE emprunts SET payment_status = ? WHERE id = ?").run(
        paymentStatus,
        body.id,
      );
      body.payment_status = paymentStatus;
    }
    return orig(body);
  };
  next();
}

// ---------- Routes /api/v1 ----------
const router = express.Router();

// Authentification (pour obtenir un JWT)
router.post(
  "/auth/register",
  wrap(async (req, res) => {
    const { name, email, password } = req.body || {};
    if (typeof name !== "string" || !name.trim())
      throw new ApiError(422, '"name" obligatoire');
    if (typeof email !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      throw new ApiError(422, '"email" invalide');
    if (typeof password !== "string" || password.length < 6)
      throw new ApiError(422, '"password" : 6 caractères minimum');
    const hash = await bcrypt.hash(password, 10);
    const info = db
      .prepare(
        "INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)",
      )
      .run(name.trim(), email.trim().toLowerCase(), hash);
    const user = db
      .prepare(
        "SELECT id, name, email, subscription_status FROM users WHERE id = ?",
      )
      .get(info.lastInsertRowid);
    const token = jwt.sign({ sub: user.id }, jwtSecret(), { expiresIn: "24h" });
    res.status(201).json({ success: true, data: { token, user } });
  }),
);

router.post(
  "/auth/login",
  wrap(async (req, res) => {
    const { email, password } = req.body || {};
    if (typeof email !== "string" || typeof password !== "string")
      throw new ApiError(422, '"email" et "password" obligatoires');
    const row = db
      .prepare("SELECT * FROM users WHERE email = ?")
      .get(email.trim().toLowerCase());
    if (!row || !(await bcrypt.compare(password, row.password_hash)))
      throw new ApiError(401, "Identifiants incorrects");
    const token = jwt.sign({ sub: row.id }, jwtSecret(), { expiresIn: "24h" });
    res.json({
      success: true,
      data: {
        token,
        user: {
          id: row.id,
          name: row.name,
          email: row.email,
          subscription_status: row.subscription_status,
        },
      },
    });
  }),
);

// --- Partie 1 : OpenAI ---
router.post(
  "/books/smart-search",
  wrap(async (req, res) => {
    const query = req.body && req.body.query;
    if (typeof query !== "string" || query.trim().length < 3)
      throw new ApiError(422, '"query" est obligatoire (3 caractères minimum)');
    const raw = await chat([
      {
        role: "system",
        content:
          'Extrais de 2 à 6 mots-clés pertinents (en français, sans doublons) de la description d\'un livre. Réponds UNIQUEMENT par un tableau JSON de chaînes, par exemple ["mot1","mot2"].',
      },
      { role: "user", content: query.trim() },
    ]);
    const keywords = parseKeywords(raw);
    let data = [];
    if (keywords.length) {
      const cond = keywords
        .map(
          () =>
            "(l.titre LIKE ? OR l.auteur LIKE ? OR c.nom LIKE ? OR l.summary LIKE ?)",
        )
        .join(" OR ");
      const params = keywords.flatMap((k) => Array(4).fill(`%${k}%`));
      const rows = db
        .prepare(
          `
      SELECT l.*, c.nom AS categorie_nom FROM livres l
      JOIN categories c ON c.id = l.categorie_id WHERE ${cond}`,
        )
        .all(...params);
      const lower = keywords.map((k) => k.toLowerCase());
      data = rows
        .map((l) => {
          const hay =
            `${l.titre} ${l.auteur} ${l.categorie_nom} ${l.summary || ""}`.toLowerCase();
          return { ...l, score: lower.filter((k) => hay.includes(k)).length };
        })
        .sort((a, b) => b.score - a.score || a.titre.localeCompare(b.titre))
        .slice(0, 20);
    }
    res.json({ success: true, query: query.trim(), keywords, data });
  }),
);

router.post(
  "/books/:id/summary",
  requireAuth,
  wrap(async (req, res) => {
    const livre = getLivre(req.params.id);
    if (livre.summary) {
      return res.json({
        success: true,
        data: summaryData(livre),
        message: "Résumé existant retourné (pas de nouvel appel API)",
      });
    }
    const text = await chat(summaryMessages(livre));
    saveSummary(livre.id, text);
    res.json({
      success: true,
      data: summaryData(
        db.prepare("SELECT * FROM livres WHERE id = ?").get(livre.id),
      ),
    });
  }),
);

router.get(
  "/books/:id/summary",
  wrap(async (req, res) => {
    const livre = getLivre(req.params.id);
    if (!livre.summary)
      throw new ApiError(
        404,
        `Aucun résumé pour le livre ${livre.id} : générez-le d'abord (POST)`,
      );
    res.json({ success: true, data: summaryData(livre) });
  }),
);

// Bonus : streaming SSE
router.get(
  "/books/:id/summary/stream",
  requireAuth,
  wrap(async (req, res) => {
    const livre = getLivre(req.params.id);
    const send = (event, data) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const sseHeaders = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    };

    if (livre.summary) {
      res.set(sseHeaders);
      res.flushHeaders();
      send("delta", { text: livre.summary });
      send("done", { ...summaryData(livre), already_existing: true });
      return res.end();
    }
    const upstream = await openaiRequest(summaryMessages(livre), true); // erreurs 503 avant d'ouvrir le flux
    res.set(sseHeaders);
    res.flushHeaders();
    let full = "",
      buf = "";
    const dec = new TextDecoder();
    try {
      for await (const chunk of upstream.body) {
        buf += dec.decode(chunk, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const d = line.slice(5).trim();
          if (!d || d === "[DONE]") continue;
          try {
            const delta = JSON.parse(d).choices?.[0]?.delta?.content;
            if (delta) {
              full += delta;
              send("delta", { text: delta });
            }
          } catch {
            /* fragment incomplet ignoré */
          }
        }
      }
    } catch {
      send("error", { message: "Flux OpenAI interrompu" });
      return res.end();
    }
    if (full.trim()) {
      saveSummary(livre.id, full.trim());
      send("done", {
        ...summaryData(
          db.prepare("SELECT * FROM livres WHERE id = ?").get(livre.id),
        ),
        already_existing: false,
      });
    } else send("error", { message: "Réponse OpenAI vide" });
    res.end();
  }),
);

// --- Partie 2 : Stripe ---
router.post(
  "/subscriptions/payment-intent",
  requireAuth,
  wrap(async (req, res) => {
    if (req.user.subscription_status === "premium")
      throw new ApiError(409, "Vous êtes déjà abonné premium");
    let pi;
    try {
      pi = await stripe().paymentIntents.create({
        amount: PREMIUM_AMOUNT,
        currency: "eur",
        automatic_payment_methods: { enabled: true },
        metadata: { user_id: String(req.user.id), plan: "premium" },
      });
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(503, `Stripe indisponible : ${e.message}`);
    }
    res.json({
      success: true,
      data: {
        client_secret: pi.client_secret,
        amount: pi.amount,
        currency: pi.currency,
        publishable_key: process.env.STRIPE_PUBLISHABLE_KEY || null,
      },
    });
  }),
);

router.get("/subscriptions/status", requireAuth, (req, res) => {
  const membreId = membreIdFor(req.user, null);
  const premium = req.user.subscription_status === "premium";
  res.json({
    success: true,
    data: {
      user_id: req.user.id,
      subscription_status: req.user.subscription_status,
      max_active_borrows: premium ? null : FREE_LIMIT,
      active_borrows: membreId ? activeCount(membreId) : 0,
    },
  });
});

router.post("/webhooks/stripe", (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret)
    throw new ApiError(
      503,
      "Webhook non configuré (STRIPE_WEBHOOK_SECRET manquante)",
    );
  const sig = req.headers["stripe-signature"];
  if (!sig) throw new ApiError(401, "En-tête Stripe-Signature manquant");
  if (!verifyStripeSignature(req.rawBody, sig, secret))
    throw new ApiError(401, "Signature Stripe invalide");

  const event = req.body || {};
  if (event.type === "payment_intent.succeeded") {
    const obj = (event.data && event.data.object) || {};
    const userId = Number(obj.metadata && obj.metadata.user_id);
    if (
      obj.metadata &&
      obj.metadata.plan === "premium" &&
      Number.isInteger(userId)
    ) {
      db.prepare(
        "UPDATE users SET subscription_status = 'premium' WHERE id = ?",
      ).run(userId);
    }
  }
  res.json({ received: true });
});

// ---------- Erreurs du routeur ----------
router.use((req, res) =>
  res.status(404).json({ success: false, message: "Route introuvable" }),
);
router.use((err, req, res, next) => {
  if (err instanceof ApiError)
    return res
      .status(err.status)
      .json({ success: false, message: err.message });
  if (err.code === "SQLITE_CONSTRAINT_UNIQUE")
    return res
      .status(409)
      .json({ success: false, message: "Email déjà utilisé" });
  console.error(err);
  res
    .status(500)
    .json({ success: false, message: "Erreur interne du serveur" });
});

module.exports = { router, limiteAbonnement };
