require("dotenv").config();
const express = require("express");
const db = require("./db");
const { router: apiV1, limiteAbonnement } = require("./integrations");

// ---------- Utilitaires ----------
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (m) => new HttpError(400, m);

const LIMITES = { etudiant: 3, enseignant: 6 };
const DUREE_DEFAUT_JOURS = 14;

const isStr = (v) => typeof v === "string" && v.trim() !== "";
const isInt = (v) => Number.isInteger(v);
const isDate = (v) =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  !isNaN(new Date(v + "T00:00:00Z"));
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => {
  const x = new Date(d + "T00:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const pid = (req) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw bad("Identifiant invalide");
  return id;
};
const getOr404 = (table, id, label) => {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!row) throw new HttpError(404, `${label} introuvable`);
  return row;
};
const nbEmpruntsEnCours = (membreId) =>
  db
    .prepare(
      "SELECT COUNT(*) AS n FROM emprunts WHERE membre_id = ? AND date_retour_reelle IS NULL",
    )
    .get(membreId).n;

// Sélection d'un emprunt avec calcul automatique du retard.
// jours_retard : (date de retour réelle, ou aujourd'hui si non rendu) - date prévue, minimum 0.
const EMPRUNT_SELECT = `
SELECT e.id, e.membre_id, m.nom AS membre_nom, e.livre_id, l.titre AS livre_titre,
       e.date_emprunt, e.date_retour_prevue, e.date_retour_reelle,
       CASE WHEN e.date_retour_reelle IS NULL THEN 'en_cours' ELSE 'retourne' END AS statut,
       MAX(0, CAST(julianday(COALESCE(e.date_retour_reelle, :today))
                   - julianday(e.date_retour_prevue) AS INTEGER)) AS jours_retard
FROM emprunts e
JOIN membres m ON m.id = e.membre_id
JOIN livres  l ON l.id = e.livre_id`;

const LIVRE_SELECT = `
SELECT l.*, c.nom AS categorie_nom
FROM livres l JOIN categories c ON c.id = l.categorie_id`;

const app = express();
// rawBody est nécessaire pour vérifier la signature du webhook Stripe
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  }),
);
app.use("/emprunts", limiteAbonnement); // doit précéder les routes /emprunts

app.get("/", (req, res) =>
  res.json({ status: "ok", service: "bibliotheque-api" }),
);

// ---------- Catégories ----------
app.get("/categories", (req, res) => {
  res.json(db.prepare("SELECT * FROM categories ORDER BY nom").all());
});

app.get("/categories/:id", (req, res) => {
  res.json(getOr404("categories", pid(req), "Catégorie"));
});

app.post("/categories", (req, res) => {
  const { nom } = req.body || {};
  if (!isStr(nom)) throw bad('Le champ "nom" est obligatoire');
  const info = db
    .prepare("INSERT INTO categories (nom) VALUES (?)")
    .run(nom.trim());
  res
    .status(201)
    .json(getOr404("categories", info.lastInsertRowid, "Catégorie"));
});

app.put("/categories/:id", (req, res) => {
  const id = pid(req);
  getOr404("categories", id, "Catégorie");
  const { nom } = req.body || {};
  if (!isStr(nom)) throw bad('Le champ "nom" est obligatoire');
  db.prepare("UPDATE categories SET nom = ? WHERE id = ?").run(nom.trim(), id);
  res.json(getOr404("categories", id, "Catégorie"));
});

app.delete("/categories/:id", (req, res) => {
  const id = pid(req);
  getOr404("categories", id, "Catégorie");
  const { n } = db
    .prepare("SELECT COUNT(*) AS n FROM livres WHERE categorie_id = ?")
    .get(id);
  if (n > 0)
    throw new HttpError(
      409,
      "Impossible de supprimer : des livres appartiennent à cette catégorie",
    );
  db.prepare("DELETE FROM categories WHERE id = ?").run(id);
  res.status(204).end();
});

// ---------- Livres ----------
function validerLivre(b) {
  if (!b || typeof b !== "object") throw bad("Corps JSON requis");
  if (!isStr(b.titre)) throw bad('"titre" obligatoire');
  if (!isStr(b.auteur)) throw bad('"auteur" obligatoire');
  if (!isStr(b.isbn)) throw bad('"isbn" obligatoire');
  if (!isInt(b.annee) || b.annee < 0 || b.annee > new Date().getFullYear() + 1)
    throw bad('"annee" doit être un entier valide');
  if (!isInt(b.exemplaires_total) || b.exemplaires_total < 0)
    throw bad('"exemplaires_total" doit être un entier >= 0');
  if (!isInt(b.categorie_id)) throw bad('"categorie_id" doit être un entier');
  if (!db.prepare("SELECT 1 FROM categories WHERE id = ?").get(b.categorie_id))
    throw bad('"categorie_id" ne correspond à aucune catégorie');
}

app.get("/livres", (req, res) => {
  const { q, categorie_id, disponible } = req.query;
  const cond = [];
  const p = {};
  if (q) {
    cond.push("(l.titre LIKE :q OR l.auteur LIKE :q OR l.isbn LIKE :q)");
    p.q = `%${q}%`;
  }
  if (categorie_id) {
    cond.push("l.categorie_id = :cid");
    p.cid = Number(categorie_id);
  }
  if (disponible === "true") cond.push("l.exemplaires_disponibles > 0");
  const sql =
    LIVRE_SELECT +
    (cond.length ? " WHERE " + cond.join(" AND ") : "") +
    " ORDER BY l.titre";
  res.json(db.prepare(sql).all(p));
});

app.get("/livres/:id", (req, res) => {
  const livre = db.prepare(LIVRE_SELECT + " WHERE l.id = ?").get(pid(req));
  if (!livre) throw new HttpError(404, "Livre introuvable");
  res.json(livre);
});

app.post("/livres", (req, res) => {
  const b = req.body;
  validerLivre(b);
  const info = db
    .prepare(
      `
    INSERT INTO livres (titre, auteur, isbn, annee, exemplaires_total, exemplaires_disponibles, categorie_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      b.titre.trim(),
      b.auteur.trim(),
      b.isbn.trim(),
      b.annee,
      b.exemplaires_total,
      b.exemplaires_total,
      b.categorie_id,
    );
  res
    .status(201)
    .json(
      db.prepare(LIVRE_SELECT + " WHERE l.id = ?").get(info.lastInsertRowid),
    );
});

app.put("/livres/:id", (req, res) => {
  const id = pid(req);
  const livre = getOr404("livres", id, "Livre");
  const b = req.body;
  validerLivre(b);
  const enCours = livre.exemplaires_total - livre.exemplaires_disponibles;
  if (b.exemplaires_total < enCours)
    throw new HttpError(
      409,
      `Impossible : ${enCours} exemplaire(s) actuellement emprunté(s)`,
    );
  db.prepare(
    `
    UPDATE livres SET titre=?, auteur=?, isbn=?, annee=?, exemplaires_total=?,
                      exemplaires_disponibles=?, categorie_id=? WHERE id=?`,
  ).run(
    b.titre.trim(),
    b.auteur.trim(),
    b.isbn.trim(),
    b.annee,
    b.exemplaires_total,
    b.exemplaires_total - enCours,
    b.categorie_id,
    id,
  );
  res.json(db.prepare(LIVRE_SELECT + " WHERE l.id = ?").get(id));
});

// Règle : suppression impossible si des emprunts sont en cours.
app.delete("/livres/:id", (req, res) => {
  const id = pid(req);
  getOr404("livres", id, "Livre");
  const { n } = db
    .prepare(
      "SELECT COUNT(*) AS n FROM emprunts WHERE livre_id = ? AND date_retour_reelle IS NULL",
    )
    .get(id);
  if (n > 0)
    throw new HttpError(
      409,
      "Impossible de supprimer : ce livre a des emprunts en cours",
    );
  db.prepare("DELETE FROM livres WHERE id = ?").run(id); // l'historique rendu est supprimé en cascade
  res.status(204).end();
});

// ---------- Membres ----------
function validerMembre(b) {
  if (!b || typeof b !== "object") throw bad("Corps JSON requis");
  if (!isStr(b.nom)) throw bad('"nom" obligatoire');
  if (!isStr(b.email) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email))
    throw bad('"email" invalide');
  if (!LIMITES[b.type])
    throw bad('"type" doit valoir "etudiant" ou "enseignant"');
}

app.get("/membres", (req, res) => {
  const { type } = req.query;
  if (type !== undefined && !LIMITES[type]) throw bad("type invalide");
  const sql =
    "SELECT * FROM membres" + (type ? " WHERE type = ?" : "") + " ORDER BY nom";
  res.json(type ? db.prepare(sql).all(type) : db.prepare(sql).all());
});

app.get("/membres/:id", (req, res) => {
  const m = getOr404("membres", pid(req), "Membre");
  res.json({
    ...m,
    emprunts_en_cours: nbEmpruntsEnCours(m.id),
    limite: LIMITES[m.type],
  });
});

app.post("/membres", (req, res) => {
  const b = req.body;
  validerMembre(b);
  const info = db
    .prepare("INSERT INTO membres (nom, email, type) VALUES (?, ?, ?)")
    .run(b.nom.trim(), b.email.trim().toLowerCase(), b.type);
  res.status(201).json(getOr404("membres", info.lastInsertRowid, "Membre"));
});

app.put("/membres/:id", (req, res) => {
  const id = pid(req);
  getOr404("membres", id, "Membre");
  const b = req.body;
  validerMembre(b);
  if (nbEmpruntsEnCours(id) > LIMITES[b.type])
    throw new HttpError(
      409,
      `Le membre a plus d'emprunts en cours que la limite d'un ${b.type}`,
    );
  db.prepare("UPDATE membres SET nom=?, email=?, type=? WHERE id=?").run(
    b.nom.trim(),
    b.email.trim().toLowerCase(),
    b.type,
    id,
  );
  res.json(getOr404("membres", id, "Membre"));
});

// Règle : suppression impossible si des emprunts sont en cours.
app.delete("/membres/:id", (req, res) => {
  const id = pid(req);
  getOr404("membres", id, "Membre");
  if (nbEmpruntsEnCours(id) > 0)
    throw new HttpError(
      409,
      "Impossible de supprimer : ce membre a des emprunts en cours",
    );
  db.prepare("DELETE FROM membres WHERE id = ?").run(id);
  res.status(204).end();
});

// Rapport 4 : historique complet des emprunts d'un membre
app.get("/membres/:id/historique", (req, res) => {
  const membre = getOr404("membres", pid(req), "Membre");
  const emprunts = db
    .prepare(
      EMPRUNT_SELECT +
        " WHERE e.membre_id = :mid ORDER BY e.date_emprunt DESC, e.id DESC",
    )
    .all({ today: today(), mid: membre.id });
  res.json({
    membre,
    total_emprunts: emprunts.length,
    en_cours: emprunts.filter((e) => e.statut === "en_cours").length,
    avec_retard: emprunts.filter((e) => e.jours_retard > 0).length,
    emprunts,
  });
});

// ---------- Emprunts ----------
const creerEmprunt = db.transaction(
  ({ membre_id, livre_id, date_emprunt, duree_jours }) => {
    const membre = getOr404("membres", membre_id, "Membre");
    const livre = getOr404("livres", livre_id, "Livre");

    // Règle 1 : au moins un exemplaire disponible
    if (livre.exemplaires_disponibles < 1)
      throw new HttpError(409, "Aucun exemplaire disponible pour ce livre");

    // Règle 2 : quota par type de membre
    const max = LIMITES[membre.type];
    if (nbEmpruntsEnCours(membre_id) >= max)
      throw new HttpError(
        409,
        `Limite d'emprunts atteinte (${max} maximum pour un ${membre.type})`,
      );

    const info = db
      .prepare(
        `
    INSERT INTO emprunts (membre_id, livre_id, date_emprunt, date_retour_prevue)
    VALUES (?, ?, ?, ?)`,
      )
      .run(
        membre_id,
        livre_id,
        date_emprunt,
        addDays(date_emprunt, duree_jours),
      );
    db.prepare(
      "UPDATE livres SET exemplaires_disponibles = exemplaires_disponibles - 1 WHERE id = ?",
    ).run(livre_id);
    return info.lastInsertRowid;
  },
);

const retournerEmprunt = db.transaction((id) => {
  const e = getOr404("emprunts", id, "Emprunt");
  if (e.date_retour_reelle)
    throw new HttpError(409, "Ce livre a déjà été retourné");
  db.prepare("UPDATE emprunts SET date_retour_reelle = ? WHERE id = ?").run(
    today(),
    id,
  );
  // Règle 5 : le retour remet un exemplaire en disponibilité
  db.prepare(
    "UPDATE livres SET exemplaires_disponibles = exemplaires_disponibles + 1 WHERE id = ?",
  ).run(e.livre_id);
});

const empruntParId = (id) =>
  db.prepare(EMPRUNT_SELECT + " WHERE e.id = :id").get({ today: today(), id });

app.get("/emprunts", (req, res) => {
  const { statut, membre_id, livre_id } = req.query;
  const cond = [];
  const p = { today: today() };
  if (statut === "en_cours") cond.push("e.date_retour_reelle IS NULL");
  else if (statut === "retourne") cond.push("e.date_retour_reelle IS NOT NULL");
  else if (statut === "en_retard")
    cond.push("e.date_retour_reelle IS NULL AND e.date_retour_prevue < :today");
  else if (statut !== undefined)
    throw bad("statut doit valoir en_cours, retourne ou en_retard");
  if (membre_id) {
    cond.push("e.membre_id = :mid");
    p.mid = Number(membre_id);
  }
  if (livre_id) {
    cond.push("e.livre_id = :lid");
    p.lid = Number(livre_id);
  }
  const sql =
    EMPRUNT_SELECT +
    (cond.length ? " WHERE " + cond.join(" AND ") : "") +
    " ORDER BY e.id DESC";
  res.json(db.prepare(sql).all(p));
});

app.get("/emprunts/:id", (req, res) => {
  const e = empruntParId(pid(req));
  if (!e) throw new HttpError(404, "Emprunt introuvable");
  res.json(e);
});

app.post("/emprunts", (req, res) => {
  const b = req.body || {};
  if (!isInt(b.membre_id)) throw bad('"membre_id" doit être un entier');
  if (!isInt(b.livre_id)) throw bad('"livre_id" doit être un entier');
  // date_emprunt et duree_jours sont optionnels (utiles pour simuler des retards en test)
  const date_emprunt = b.date_emprunt === undefined ? today() : b.date_emprunt;
  if (!isDate(date_emprunt))
    throw bad('"date_emprunt" doit être au format AAAA-MM-JJ');
  const duree_jours =
    b.duree_jours === undefined ? DUREE_DEFAUT_JOURS : b.duree_jours;
  if (!isInt(duree_jours) || duree_jours < 1 || duree_jours > 90)
    throw bad('"duree_jours" doit être un entier entre 1 et 90');

  const id = creerEmprunt({
    membre_id: b.membre_id,
    livre_id: b.livre_id,
    date_emprunt,
    duree_jours,
  });
  res.status(201).json(empruntParId(id));
});

app.post("/emprunts/:id/retour", (req, res) => {
  const id = pid(req);
  retournerEmprunt(id);
  res.json(empruntParId(id));
});

// ---------- Rapports ----------
// Rapport 1 : top des livres les plus empruntés
app.get("/rapports/top-livres", (req, res) => {
  const limit = req.query.limit === undefined ? 10 : Number(req.query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw bad("limit doit être entre 1 et 100");
  res.json(
    db
      .prepare(
        `
    SELECT l.id, l.titre, l.auteur, c.nom AS categorie_nom, COUNT(e.id) AS nb_emprunts
    FROM livres l
    JOIN emprunts e   ON e.livre_id = l.id
    JOIN categories c ON c.id = l.categorie_id
    GROUP BY l.id
    ORDER BY nb_emprunts DESC, l.titre
    LIMIT ?`,
      )
      .all(limit),
  );
});

// Rapport 2 : emprunts en retard avec nom du membre
app.get("/rapports/emprunts-en-retard", (req, res) => {
  res.json(
    db
      .prepare(
        `
    ${EMPRUNT_SELECT}
    WHERE e.date_retour_reelle IS NULL AND e.date_retour_prevue < :today
    ORDER BY jours_retard DESC, e.id`,
      )
      .all({ today: today() }),
  );
});

// Rapport 3 : nombre d'emprunts par catégorie
app.get("/rapports/emprunts-par-categorie", (req, res) => {
  res.json(
    db
      .prepare(
        `
    SELECT c.id AS categorie_id, c.nom AS categorie_nom, COUNT(e.id) AS nb_emprunts
    FROM categories c
    LEFT JOIN livres l   ON l.categorie_id = c.id
    LEFT JOIN emprunts e ON e.livre_id = l.id
    GROUP BY c.id
    ORDER BY nb_emprunts DESC, c.nom`,
      )
      .all(),
  );
});

app.use("/api/v1", apiV1);

// ---------- Erreurs ----------
app.use((req, res) => res.status(404).json({ erreur: "Route introuvable" }));

app.use((err, req, res, next) => {
  if (err instanceof HttpError)
    return res.status(err.status).json({ erreur: err.message });
  if (err.type === "entity.parse.failed")
    return res.status(400).json({ erreur: "JSON invalide" });
  if (err.code === "SQLITE_CONSTRAINT_UNIQUE")
    return res.status(409).json({
      erreur: "Valeur déjà existante (ISBN, email ou nom en doublon)",
    });
  if (err.code === "SQLITE_CONSTRAINT_FOREIGNKEY")
    return res
      .status(409)
      .json({ erreur: "Opération refusée : des données liées existent" });
  console.error(err);
  res.status(500).json({ erreur: "Erreur interne du serveur" });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () =>
    console.log(`API bibliothèque sur http://localhost:${PORT}`),
  );
}
module.exports = app;
