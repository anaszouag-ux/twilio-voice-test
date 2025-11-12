// Voice order with ChatGPT NLU (no realtime). Twilio STT -> OpenAI JSON -> SMS
import express from "express";
import Twilio from "twilio";
import OpenAI from "openai";

const app = express();
const PORT = process.env.PORT || 5000;

// ===== ENV =====
const LOCALE = process.env.LOCALE || "fr-FR";               // ex: fr-FR
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;          // sk-...
const OPENAI_MODEL   = process.env.OPENAI_MODEL || "gpt-4o-mini";

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_SMS_FROM    = process.env.TWILIO_SMS_FROM;     // +33...

if (!OPENAI_API_KEY) console.warn("⚠️ Missing OPENAI_API_KEY");
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_SMS_FROM) {
  console.warn("⚠️ Missing Twilio vars (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_SMS_FROM)");
}

const client = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Twilio envoie x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));

const twiml = (xml) => `<?xml version="1.0" encoding="UTF-8"?><Response>${xml}</Response>`;

// ===== 1) Entrée d’appel : Gather (STT Twilio) =====
app.all("/voice", (req, res) => {
  const xml = twiml(`
    <Gather input="speech"
            language="${LOCALE}"
            speechTimeout="auto"
            action="/process"
            method="POST">
      <Say voice="alice" language="${LOCALE}">
        Bonjour ! Dites votre commande naturellement. Par exemple :
        "Deux tacos boeuf, une pizza quatre fromages et un coca zéro".
        Quand vous avez fini, restez silencieux quelques secondes.
      </Say>
    </Gather>
    <Say voice="alice" language="${LOCALE}">
      Je n'ai rien entendu. N'hésitez pas à rappeler.
    </Say>
    <Hangup/>
  `);
  res.type("text/xml").send(xml);
});

// ===== 2) Traitement : SpeechResult -> OpenAI -> SMS -> confirmation =====
app.post("/process", async (req, res) => {
  const from = req.body.From;
  const transcript = (req.body.SpeechResult || "").trim();

  console.log("🎤 Transcript:", transcript || "<vide>");

  // Réponse Twilio immédiate pour l’appelant
  const ack = twiml(`
    <Say voice="alice" language="${LOCALE}">
      Merci, je traite votre commande et je vous envoie un SMS récapitulatif.
    </Say>
    <Hangup/>
  `);
  res.type("text/xml").send(ack);

  try {
    // Appel OpenAI pour structurer la commande
    const system = `Tu es un assistant de restauration.
Retourne STRICTEMENT un JSON valide (pas de texte autour) selon ce schéma:
{
  "items":[{"name":"string","quantity":number,"notes":"string"}],
  "summary":"string courte en français"
}
- Déduis la quantité si absente (par défaut 1).
- "notes" peut être vide.
- Concentre-toi sur les aliments/boissons.`;

    const user = `Transcription client (français): """${transcript}"""`;

    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
      max_completion_tokens: 400
    });

    let parsed;
    try {
      parsed = JSON.parse(completion.choices[0].message.content);
    } catch {
      parsed = { items: [], summary: transcript || "" };
    }

    const lines = (parsed.items || []).map(
      (it) => `• ${it.quantity || 1} x ${it.name}${it.notes ? " ("+it.notes+")" : ""}`
    );

    const smsBody = lines.length
      ? `Récapitulatif de votre commande:\n${lines.join("\n")}\n\n${parsed.summary || ""}`
      : `Message reçu:\n"${transcript || "—"}"\n(Aucun article reconnu)`;

    if (from) {
      await client.messages.create({ from: TWILIO_SMS_FROM, to: from, body: smsBody });
      console.log("📩 SMS envoyé à", from);
    }
  } catch (err) {
    console.error("❌ OpenAI/Traitement error:", err?.response?.data || err.message);
    // Pas de renvoi TwiML ici : on a déjà répondu
  }
});

// Health
app.get("/", (_, res) => res.send("✅ Voice+ChatGPT order is running"));

app.listen(PORT, () => console.log(`✅ Server on ${PORT}`));

