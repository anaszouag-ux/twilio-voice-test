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

// Twilio poste en x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));

const twiml = (xml) => `<?xml version="1.0" encoding="UTF-8"?><Response>${xml}</Response>`;

// Santé
app.get("/", (req, res) => res.send("✅ Voice AI server running"));

// 1) Entrée d'appel : on donne la consigne et on enregistre
app.all("/voice", (req, res) => {
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
        action="/thanks"
        recordingStatusCallback="/recording-done"
        recordingStatusCallbackMethod="POST"
      />
      <Say voice="alice" language="${LOCALE}">Je n'ai rien reçu.</Say>
      <Hangup/>
    `)
  );
});

// 2) On remercie immédiatement l'appelant (réponse rapide TwiML)
app.post("/thanks", (req, res) => {
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

  try {
    const from = req.body.From;                       // numéro de l’appelant (E.164)
    const recUrlBase = req.body.RecordingUrl;         // ex: https://api.twilio.com/2010-04-01/Accounts/.../Recordings/RE....
    const recUrl = `${recUrlBase}.mp3`;               // on récupère en MP3

    // 3a) Télécharger l'audio de Twilio (avec auth SID/TOKEN)
    const audioResponse = await axios.get(recUrl, {
      responseType: "stream",
      auth: {
        username: process.env.TWILIO_ACCOUNT_SID,
        password: process.env.TWILIO_AUTH_TOKEN,
      },
    });

    // 3b) Transcription Whisper
    const transcription = await openai.audio.transcriptions.create({
      file: audioResponse.data,
      model: "whisper-1",
      // language: "fr" // facultatif : Whisper auto-détecte très bien le FR
    });

    const text = (transcription?.text || "").trim();
    console.log("📝 Transcription =", text);

    // 3c) Extraction structurée de la commande avec GPT
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

    let parsed;
    try {
      parsed = JSON.parse(completion.choices[0].message.content);
    } catch {
      parsed = { items: [], intent: "order", summary: text || "Commande non comprise" };
    }

    // Construire un résumé lisible pour SMS
    const lines = (parsed.items || []).map(
      (it) => `• ${it.quantity || 1} x ${it.name}${it.notes ? " (" + it.notes + ")" : ""}`
    );
    const smsBody =
      lines.length > 0
        ? `Récapitulatif de votre commande :\n${lines.join("\n")}\n\n${parsed.summary || ""}`
        : `Nous avons bien reçu votre message :\n"${text}"\n(Nous reviendrons vers vous si besoin)`;

    // 3d) Envoyer le SMS au client
    if (SMS_FROM && from) {
      await client.messages.create({
        from: SMS_FROM,
        to: from,
        body: smsBody,
      });
      console.log("📩 SMS envoyé à", from);
    } else {
      console.warn("⚠️ SMS non envoyé (TWILIO_SMS_FROM ou From manquant)");
    }
  } catch (err) {
    console.error("❌ Erreur traitement callback:", err?.response?.data || err.message);
  }
});

app.listen(PORT, () => console.log(`✅ Voice AI live on ${PORT}`));

