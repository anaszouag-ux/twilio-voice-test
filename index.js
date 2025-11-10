// Assistant vocal conversationnel (speech only) + SMS récap
// - Voix naturelle : Polly.Celine (FR)
// - Pas de touches, barge-in = true, speechTimeout = auto
// - Mémoire courte par appel (CallSid) pour accumuler les items
// - Envoi d'un SMS récapitulatif quand le client dit "c'est tout / c'est bon / terminé"

import express from "express";
import Twilio from "twilio";
import OpenAI from "openai";

const app = express();
const PORT = process.env.PORT || 5000;

const LOCALE = process.env.LOCALE || "fr-FR";
const SMS_FROM = process.env.TWILIO_SMS_FROM;
const client = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Twilio envoie du x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));

// État minimal par appel (mémoire RAM, ok pour démo)
const callState = new Map(); // key: CallSid -> { items: [{name, quantity, notes}], started: bool }

// Helpers
const twiml = (inner) => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
const buildSummary = (items = []) =>
  items.length
    ? items.map(i => `• ${i.quantity || 1} x ${i.name}${i.notes ? ` (${i.notes})` : ""}`).join("\n")
    : "Aucune ligne pour l’instant.";

function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const host = req.get("host");
  const proto = req.get("x-forwarded-proto") || req.protocol || "https";
  return `${proto}://${host}`;
}

// Sémantique "fin de commande"
const DONE_RE = /\b(c'?est (tout|bon)|termin(é|ee)|ça suffit|non merci|pas (autre|autre chose)|rien d'autre)\b/i;

// Santé
app.get("/", (req, res) => res.send("✅ Voice AI conversationnel en ligne"));

// ───────────────────────────────────────────────────────────────────────────────
// 1) Entrée d'appel : message d'accueil + Gather (speech only)
// ───────────────────────────────────────────────────────────────────────────────
app.post("/voice", (req, res) => {
  const BASE = baseUrl(req);
  const callSid = req.body.CallSid;
  if (!callState.has(callSid)) callState.set(callSid, { items: [], started: true });

  const xml = twiml(`
    <Say voice="Polly.Celine" language="${LOCALE}">
      Bonjour ! Dites-moi votre commande quand vous voulez, je vous écoute.
    </Say>
    <Gather input="speech"
            language="${LOCALE}"
            bargeIn="true"
            speechTimeout="auto"
            action="${BASE}/nlu"
            method="POST"
            hints="tacos,kebab,pizza,menu,frites,coca,sans oignons,supplément fromage,taille,boisson">
      <Say voice="Polly.Celine" language="${LOCALE}">
        Vous pouvez parler maintenant.
      </Say>
    </Gather>
    <Say voice="Polly.Celine" language="${LOCALE}">Je n'ai pas entendu. Au revoir.</Say>
    <Hangup/>
  `);
  res.type("text/xml").send(xml);
});

// ───────────────────────────────────────────────────────────────────────────────
// 2) Compréhension + gestion du tour de parole -> confirmation/relance
// ───────────────────────────────────────────────────────────────────────────────
app.post("/nlu", async (req, res) => {
  const BASE = baseUrl(req);
  const from = req.body.From;
  const callSid = req.body.CallSid;
  console.log("🧾 Twilio request body =", req.body);
  const speech = (req.body.SpeechResult || "").trim();
  const state = callState.get(callSid) || { items: [], started: false };

  console.log("🗣️ SpeechResult:", speech);

  // Si l'utilisateur dit "c'est tout" & on a des items -> envoyer SMS + raccrocher
  if (DONE_RE.test(speech) && state.items.length) {
    const recap = `Récapitulatif de votre commande :\n${buildSummary(state.items)}`;
    if (SMS_FROM && from) {
      try {
        const msg = await client.messages.create({ from: SMS_FROM, to: from, body: recap });
        console.log("📩 SMS envoyé:", msg.sid);
      } catch (e) {
        console.error("❌ Erreur envoi SMS:", e?.message || e);
      }
    } else {
      console.warn("⚠️ SMS non envoyé (TWILIO_SMS_FROM ou From manquant)");
    }
    callState.delete(callSid);
    const xml = twiml(`
      <Say voice="Polly.Celine" language="${LOCALE}">
        Parfait ! Je vous envoie un SMS récapitulatif. Merci, à bientôt.
      </Say>
      <Hangup/>
    `);
    return res.type("text/xml").send(xml);
  }

  // Appel à l'IA pour parser la commande (items + éventuelle relance)
  let parsed = { items: [], followup: "" };
  try {
    const system = `Tu es un assistant de prise de commande de restauration rapide par téléphone.
Retourne STRICTEMENT un JSON valide, sans texte autour, comme :
{
  "items":[{"name":"string","quantity":number,"notes":"string"}],
  "followup":"string courte en français ou vide"
}
Règles :
- Corrige les noms de plats si besoin (français).
- Si quantité absente => 1.
- notes peut contenir "sans oignons", "supplément fromage", "boisson grande", etc.
- Si le message n'est pas une commande claire, renvoie items=[] et une followup polie pour demander une précision.`;

    const user = `Client: """${speech}"""
Contexte actuel:
${buildSummary(state.items)}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      max_completion_tokens: 400
    });

    parsed = JSON.parse(completion.choices[0].message.content);
  } catch (e) {
    console.error("❌ NLU error:", e?.message || e);
    parsed = { items: [], followup: "Je n'ai pas bien compris. Pourriez-vous formuler votre commande à nouveau, s'il vous plaît ?" };
  }

  // Met à jour l'état avec les nouveaux items
  if (Array.isArray(parsed.items) && parsed.items.length) {
    state.items.push(...parsed.items.map(it => ({
      name: it.name,
      quantity: it.quantity || 1,
      notes: it.notes || ""
    })));
  }
  callState.set(callSid, state);

  // Construction du message vocal (confirmation + relance)
  const confirm = state.items.length
    ? `J'ai noté : ${state.items.map(i => `${i.quantity || 1} ${i.name}${i.notes ? ` (${i.notes})` : ""}`).join(", ")}. `
    : "";

  const follow = (parsed.followup && parsed.followup.trim())
    ? parsed.followup.trim()
    : "Souhaitez-vous autre chose, ou je récapitule ? Vous pouvez dire : c'est tout.";

  // Reboucle un Gather pour continuer naturellement
  const xml = twiml(`
    <Say voice="Polly.Celine" language="${LOCALE}">
      ${confirm}${follow}
    </Say>
    <Gather 
  input="speech"
  language="fr-FR"
  enhanced="true"
  speechModel="phone_call"
  speechTimeout="auto"
  hints="tacos,kebab,pizza,menu,frites,coca,supplément fromage,sans oignons"
  bargeIn="true"
  action="${BASE}/nlu"
  method="POST">
  <Say voice="Polly.Celine" language="${LOCALE}">
    Je vous écoute.
  </Say>
</Gather>

    <Say voice="Polly.Celine" language="${LOCALE}">Je n'ai pas entendu. Au revoir.</Say>
    <Hangup/>
  `);

  res.type("text/xml").send(xml);
});

// ───────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`✅ Voice AI conversationnel live on ${PORT}`);
});

