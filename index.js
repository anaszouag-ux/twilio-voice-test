// Voice AI hybrid: Twilio STT first, fallback to Whisper if needed
import express from "express";
import axios from "axios";
import Twilio from "twilio";
import OpenAI from "openai";

const app = express();
const PORT = process.env.PORT || 5000;

const client = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const LOCALE = process.env.LOCALE || "fr-FR";
const BASE = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "") || `http://localhost:${PORT}`;
const SMS_FROM = process.env.TWILIO_SMS_FROM || "";

// Twilio envoie du x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));

const twiml = (inner) => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
const sayTag = (text) => `<Say voice="alice" language="${LOCALE}">${text}</Say>`;

// ---------- Helpers ----------
async function parseOrderFromText(text) {
  const system = `Tu es un assistant de prise de commande de restauration rapide.
Retourne STRICTEMENT un JSON valide, sans texte autour, suivant ce schéma:
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

  try {
    return JSON.parse(completion.choices[0].message.content);
  } catch {
    return { items: [], intent: "order", summary: text || "Commande non comprise" };
  }
}

function orderToSms(parsed, fallbackText) {
  const lines = (parsed.items || []).map(
    (it) => `• ${it.quantity || 1} x ${it.name}${it.notes ? " (" + it.notes + ")" : ""}`
  );
  if (lines.length) {
    return `Récapitulatif de votre commande :\n${lines.join("\n")}\n\n${parsed.summary || ""}`;
  }
  return `Nous avons bien reçu votre message :\n"${fallbackText}"\n(Nous reviendrons vers vous si besoin)`;
}

async function sendSms(to, body) {
  if (!SMS_FROM || !to) {
    console.warn("⚠️ SMS non envoyé (TWILIO_SMS_FROM ou numéro 'to' manquant)");
    return;
  }
  await client.messages.create({ from: SMS_FROM, to, body });
  console.log("📩 SMS envoyé à", to);
}

// ---------- Routes ----------

// Santé
app.get("/", (_req, res) => res.send("✅ Voice AI hybrid server running"));

// 1) Accueil + Gather (reconnaissance Twilio)
//    actionOnEmptyResult="true" -> on reçoit /nlu même si rien n'est compris
app.all("/voice", (_req, res) => {
  res.type("text/xml").send(
    twiml(`
      ${sayTag(
        `Bienvenue. Dites simplement votre commande quand vous êtes prêt. 
         Par exemple : "Deux tacos bœuf, une pizza 4 fromages et un coca zéro".`
      )}
      <Gather
        input="speech"
        language="fr-FR"
        enhanced="true"
        speechModel="phone_call"
        speechTimeout="auto"
        hints="tacos,kebab,pizza,menu,frites,coca,supplément,fromage,sans oignons,boisson"
        bargeIn="true"
        action="${BASE}/nlu"
        actionOnEmptyResult="true"
        method="POST">
        ${sayTag("Je vous écoute.")}
      </Gather>
      ${sayTag("Je n'ai pas entendu. Laissez un message après le bip.")}
      <Redirect method="POST">${BASE}/record</Redirect>
    `)
  );
});

// 2) Traitement du résultat de Twilio STT
app.post("/nlu", async (req, res) => {
  console.log("🧾 Twilio body @/nlu =", req.body);
  const from = req.body.From;
  const speech = (req.body.SpeechResult || "").trim();
  console.log("🗣️ SpeechResult =", speech);

  // Si Twilio n'a rien compris -> bascule vers enregistrement
  if (!speech || speech.length < 3) {
    return res.type("text/xml").send(
      twiml(`
        ${sayTag("Pardon, ce n'était pas clair. Laissez votre commande après le bip.")}
        <Redirect method="POST">${BASE}/record</Redirect>
      `)
    );
  }

  try {
    const parsed = await parseOrderFromText(speech);
    const sms = orderToSms(parsed, speech);

    // Confirmation vocale + envoi SMS (asynchrone non bloquant)
    sendSms(from, sms).catch((e) => console.error("SMS error:", e.message));

    return res.type("text/xml").send(
      twiml(`
        ${sayTag("Merci, j'ai bien noté votre commande. Je vous envoie un récapitulatif par SMS.")}
        <Hangup/>
      `)
    );
  } catch (err) {
    console.error("❌ NLU error:", err.message);
    return res.type("text/xml").send(
      twiml(`
        ${sayTag("Petit souci de traitement. Laissez votre commande après le bip.")}
        <Redirect method="POST">${BASE}/record</Redirect>
      `)
    );
  }
});

// 3) Démarrage du mode enregistrement (fallback)
app.post("/record", (_req, res) => {
  res.type("text/xml").send(
    twiml(`
      <Record
        playBeep="true"
        finishOnKey="#"
        maxLength="90"
        action="${BASE}/thanks"
        recordingStatusCallback="${BASE}/recording-done"
        recordingStatusCallbackMethod="POST"/>
      ${sayTag("Je n'ai rien reçu. Au revoir.")}
      <Hangup/>
    `)
  );
});

// 4) Retour direct au client (rapide, pendant que l'ASR tourne en fond)
app.post("/thanks", (_req, res) => {
  res.type("text/xml").send(
    twiml(`
      ${sayTag("Merci ! Nous traitons votre message et vous enverrons un SMS.")}
      <Hangup/>
    `)
  );
});

// 5) Callback quand l'enregistrement est prêt -> on télécharge → Whisper → GPT → SMS
app.post("/recording-done", async (req, res) => {
  res.status(200).send("OK"); // répondre vite à Twilio
  try {
    const from = req.body.From;
    const recUrlBase = req.body.RecordingUrl; // sans extension
    const recUrl = `${recUrlBase}.mp3`;
    console.log("🎙️ recording url =", recUrl);

    // Télécharger l'audio depuis Twilio (auth basique SID/TOKEN)
    const audioStream = await axios.get(recUrl, {
      responseType: "stream",
      auth: {
        username: process.env.TWILIO_ACCOUNT_SID,
        password: process.env.TWILIO_AUTH_TOKEN,
      },
    });

    // Whisper
    const transcription = await openai.audio.transcriptions.create({
      file: audioStream.data,
      model: "whisper-1",
    });
    const text = (transcription?.text || "").trim();
    console.log("📝 Whisper text =", text);

    if (!text) return console.warn("⚠️ Whisper vide");

    // GPT extraction
    const parsed = await parseOrderFromText(text);
    const sms = orderToSms(parsed, text);

    // SMS
    await sendSms(from, sms);
  } catch (e) {
    console.error("❌ recording-done error:", e.response?.data || e.message);
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`✅ Voice AI hybrid live on ${PORT}`);
  console.log(`➡️ Base URL: ${BASE}`);
});
