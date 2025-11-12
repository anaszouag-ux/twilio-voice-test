// Minimal ChatGPT test on Render
import express from "express";
import OpenAI from "openai";

const app = express();
const PORT = process.env.PORT || 5000;

// --- ENV ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

if (!OPENAI_API_KEY) {
  console.warn("⚠️ OPENAI_API_KEY manquante ! Ajoute-la dans Render → Environment");
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Parse forms & JSON
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Page de test simple (formulaire)
app.get("/", (_req, res) => {
  res.type("html").send(`
    <!doctype html>
    <html lang="fr">
      <head><meta charset="utf-8"><title>Test ChatGPT</title></head>
      <body style="font-family:sans-serif;max-width:720px;margin:40px auto">
        <h1>Test ChatGPT (Render ➜ OpenAI)</h1>
        <form method="POST" action="/ask">
          <label>Votre question :</label><br/>
          <textarea name="prompt" rows="4" style="width:100%;font-size:16px" placeholder="Pose une question..."></textarea>
          <br/><br/>
          <button type="submit" style="padding:10px 16px;font-size:16px">Envoyer</button>
        </form>
        <p style="color:#555">Modèle utilisé : <code>${OPENAI_MODEL}</code></p>
        <p>Endpoint API dispo : <code>POST /ask</code> (JSON: { "prompt": "..." })</p>
      </body>
    </html>
  `);
});

// Endpoint: appelle OpenAI et renvoie la réponse
app.post("/ask", async (req, res) => {
  try {
    const prompt = (req.body.prompt || "").toString().trim();
    if (!prompt) {
      return res.status(400).json({ error: "prompt manquant" });
    }

    console.log("🧠 Appel OpenAI…", { model: OPENAI_MODEL, prompt: prompt.slice(0, 80) });

    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: "Tu es un assistant bref et utile. Réponds en français." },
        { role: "user", content: prompt }
      ],
      temperature: 0.6,
      max_completion_tokens: 300
    });

    const text = completion.choices?.[0]?.message?.content ?? "";
    console.log("✅ Réponse OpenAI OK (longueur:", text.length, ")");

    // Si la requête vient du formulaire HTML, renvoyer une page lisible
    if (req.headers["content-type"]?.includes("application/x-www-form-urlencoded")) {
      return res.type("html").send(`
        <pre style="white-space:pre-wrap;font-family:ui-monospace,monospace">${escapeHtml(text)}</pre>
        <p><a href="/">← Retour</a></p>
      `);
    }

    // Sinon, renvoyer en JSON
    res.json({ ok: true, model: OPENAI_MODEL, prompt, answer: text });

  } catch (err) {
    console.error("❌ Erreur OpenAI:", err?.response?.data || err.message);
    res.status(500).json({ ok: false, error: "OpenAI error", detail: err.message });
  }
});

// Health
app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`✅ Minimal ChatGPT server on ${PORT}`);
});

// Petite fonction pour échapper le HTML
function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
