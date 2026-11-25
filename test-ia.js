require("dotenv").config();
(async () => {
  const base = process.env.OPENAI_BASE_URL;
  console.log(
    "URL :",
    base,
    "| modèle :",
    process.env.OPENAI_MODEL,
    "| clé présente :",
    !!process.env.OPENAI_API_KEY,
  );
  try {
    const r = await fetch(base + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + process.env.OPENAI_API_KEY,
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL,
        messages: [{ role: "user", content: "Dis bonjour en français." }],
      }),
    });
    console.log("Statut :", r.status);
    console.log((await r.text()).slice(0, 500));
  } catch (e) {
    console.log("Erreur réseau :", e.message);
  }
})();
