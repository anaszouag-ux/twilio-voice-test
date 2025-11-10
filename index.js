// Appel -> enregistrement -> callback de traitement -> SMS au client
import express from "express";
import axios from "axios";
import Twilio from "twilio";
import OpenAI from "openai";

const app = express();
const PORT = process.env.PORT || 5000;

const client = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const LOCALE = process.env.LOCALE || "fr-FR";
const SMS_FROM = process.env.TWILIO_SMS_FROM;
const BASE = process.env.PUBLIC_BASE_URL?.replace(/\/$/, ""); // ex: https://twilio-voice-test-xxxxx.onrender.com

// Twilio poste en x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));

const twiml = (xml) => `<?xml version="1.0" encoding="UTF-8"?><Response>${xml}</Response>`;

// Santé
app.get("/", (req, res) => res.send("✅ Voice AI server running"));

// 1) Entrée d'appel : on donne la consigne et on enregistre
app.all("/voice", (req, res) => {
  console.log("📞 /voice hit. From:", req.body?.From);
  if (!BASE) console.warn("⚠️ PUBLIC_BASE_URL manquant : ajoute-le dans Render !");
  const thanksUrl = `${BASE}/thanks`;
  const recCbUrl  = `${BASE}/recording-done`;

  res.type("text/xml").send(
    twiml(`
      <Say voice="alice" language="${LOCALE}">
        Bienvenue. Après le bip, dictez votre commande (par exemple :
        "Deux tacos bœuf, une pizza 4 fromages, et un coca zéro").
        Appuyez sur dièse pour terminer.
      </Say>
      <Record
        playBeep="true"
        finishOnKey="#"
        maxLength="90"
        action="${thanksUrl}"
        method="POST"
        recordingStatusCallback="${recCbUrl}"
        recordingStatusCallbackMethod="POST"
      />
      <Say voice="alice" language="${LOCALE}">Je n'ai rien reçu.</Say>
      <Hangup/>
    `)
  );
});

// 2) On remercie immédiatement l'appelant (réponse rapide TwiML)
app.post("/thanks", (req, res) => {
  console.log("🙏 /thanks hit. From:", req.body?.From, "RecordingUrl:", req.body?.RecordingUrl);
  res.type("text/xml").send(
    twiml(`
      <Say voice="alice" language="${LOCALE}">
        Merci ! Nous préparons votre commande et nous vous envoyons un récapitulatif par SMS.
      </Say>
      <Hangup/>
    `)
  );
});

// 3) Callback Twilio quand l'enregistrement est prêt -> on traite en BACK-END
app.post("/recording-done", async (req, res) => {
  // Toujours répondre vite à Twilio
  res.status(200).send("OK");

  const from = req.body?.From;
  const recUrlBase = req.body?.RecordingUrl;
  const recUrl = recUrlBase ? `${recUrlBase}.mp3` : null;

  console.log("🎧 /recording-done hit. From:", from, "RecordingUrl:", recUrlBase);

  // Si quoi que ce soit cloche, on envoie quand même un SMS générique
  async function safeSms(body) {
    if (!SMS_FROM || !from) {
      console.warn("⚠️ SMS non envoyé (TWILIO_SMS_FROM ou From manquant)", { SMS_FROM, from });
      return;
    }
    try {
      const msg = await client.messages.create({ from: SMS_FROM, to: from, body });
      console.log("📩 SMS envoyé:", msg.sid);
    } catch (e) {
      console.error("❌ Erreur envoi SMS:", e?.message || e);
    }
  }

  try {
    if (!recUrl) {
      await safeSms("Nous avons bien reçu votre appel. Impossible de récupérer l’enregistrement, nous vous recontacterons si besoin.");
      return;
    }

    // 3a) Télécharger l'audio de Twilio (avec auth SID/TOKEN)
    const audioResponse = await axios.get(recUrl, {
      responseType: "stream",
      auth: {
        username: process.env.TWILIO_ACCOUNT_SID,
        password: process.env.TWILIO_AUTH_TOKEN,
      },
    });

    // 3b) Transcription Whisper
    let text = "";
    try {
      const transcription = await openai.audio.transcriptions.create({
        file: audioResponse.data, // Readable stream
        model: "whisper-1",
      });
      text = (transcription?.text || "").trim();
    } catch (err) {
      console.error("❌ Erreur Whisper:", err?.response?.data || err.message);
    }
    console.log("📝 Transcription =", text);

    // 3c) Extraction structurée avec GPT (si on a du texte)
    let smsBody = "";
    if (text) {
      const system = `Tu es un assistant de prise de commande de restauration rapide.
Retourne STRICTEMENT un JSON valide, sans texte autour, suivant ce schéma :
{
  "items":[{"name":"string","quantity":number,"notes":"string"}],
  "intent":"order",
  "summary":"string courte en français"
}
- Déduis la quantité si elle n'est pas dite explicitement (par défaut 1).
- "notes" peut être vide si aucune précision.`;

      const user = `Transcript client (français) : """${text}"""`;

      let parsed = null;
      try {
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          response_format: { type: "json_object" },
          temperature: 0.2,
          max_completion_tokens: 400,
        });
        parsed = JSON.parse(completion.choices[0].message.content);
      } catch (err) {
        console.error("❌ Erreur parsing JSON GPT:", err?.message || err);
      }

      if (parsed?.items?.length) {
        const lines = parsed.items.map(
          (it) => `• ${it.quantity || 1} x ${it.name}${it.notes ? " (" + it.notes + ")" : ""}`
        );
        smsBody = `Récapitulatif de votre commande :\n${lines.join("\n")}\n\n${parsed.summary || ""}`;
      } else {
        smsBody = `Nous avons bien reçu votre message :\n"${text}"\n(Nous reviendrons vers vous si besoin)`;
      }
    } else {
      smsBody = "Nous avons bien reçu votre appel, mais la transcription a échoué. Nous vous recontacterons si besoin.";
    }

    // 3d) Envoi SMS (toujours)
    await safeSms(smsBody);

  } catch (err) {
    console.error("❌ Erreur traitement callback:", err?.response?.data || err.message);
    await safeSms("Nous avons bien reçu votre appel. Un incident technique est survenu pendant le traitement.");
  }
});

app.listen(PORT, () => console.log(`✅ Voice AI live on ${PORT}`));
