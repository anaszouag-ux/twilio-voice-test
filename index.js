// Voice ordering (no OpenAI) — Twilio Speech-to-Text + simple parser + SMS
import express from "express";
import Twilio from "twilio";

const app = express();
const PORT = process.env.PORT || 5000;

// ====== ENV ======
const LOCALE = process.env.LOCALE || "fr-FR"; // ex: fr-FR
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_SMS_FROM    = process.env.TWILIO_SMS_FROM;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_SMS_FROM) {
  console.warn("⚠️ Missing Twilio ENV vars. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_SMS_FROM");
}

const client = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Twilio envoie du x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));

// Petit helper TwiML
const twiml = (xml) => `<?xml version="1.0" encoding="UTF-8"?><Response>${xml}</Response>`;

// ====== Menu basique (à personnaliser) ======
const MENU = [
  "pizza", "tacos", "kebab", "burger", "sandwich",
  "wrap", "salade", "frites", "nuggets", "sushi",
  "boisson", "coca", "coca zéro", "eau", "jus"
];

// chiffres FR -> nombre
const FR_NUM = {
  "un":1, "une":1, "deux":2, "trois":3, "quatre":4, "cinq":5,
  "six":6, "sept":7, "huit":8, "neuf":9, "dix":10, "onze":11, "douze":12
};

// ====== Parser très simple ======
function parseOrder(text) {
  if (!text) return { items: [], notes: "" };

  const lower = text.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu,"");
  const tokens = lower.split(/\s+/);

  // repérer quantités ("2", "deux") + items du MENU
  const items = [];
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    let qty = 1;

    // nombre en chiffre
    if (/^\d+$/.test(tk)) qty = parseInt(tk, 10);

    // nombre en lettres FR
    if (FR_NUM[tk] !== undefined) qty = FR_NUM[tk];

    // regarder l’item juste après ou le même token
    // cas 1: "deux pizzas"
    if (i+1 < tokens.length) {
      const next = tokens[i+1];
      const candidate = [tk, next, `${tk} ${next}`]; // simple essais
      for (const c of candidate) {
        const hit = MENU.find(m => c.includes(m));
        if (hit) {
          items.push({ name: hit, quantity: qty });
          i++; // on saute le token suivant supposé être l'item
          break;
        }
      }
    }

    // cas 2: "pizza", sans quantité explicite avant
    const direct = MENU.find(m => tk.includes(m));
    if (direct) {
      items.push({ name: direct, quantity: qty });
    }
  }

  // notes très basiques (tout ce qui suit "sans" / "avec")
  let notes = "";
  const sansIdx = tokens.indexOf("sans");
  if (sansIdx >= 0) notes += "sans " + tokens.slice(sansIdx+1, sansIdx+4).join(" ");
  const avecIdx = tokens.indexOf("avec");
  if (avecIdx >= 0) {
    if (notes) notes += " | ";
    notes += "avec " + tokens.slice(avecIdx+1, avecIdx+4).join(" ");
  }

  // fusionner items identiques
  const merged = [];
  for (const it of items) {
    const found = merged.find(x => x.name === it.name);
    if (found) found.quantity += it.quantity || 1;
    else merged.push({ name: it.name, quantity: it.quantity || 1 });
  }

  return { items: merged, notes: notes.trim() };
}

// ====== ENDPOINTS ======

// 1) Accueil d’appel : reconnaissance vocale avec Gather
app.all("/voice", (req, res) => {
  const twimlXml = twiml(`
    <Gather input="speech"
            language="${LOCALE}"
            speechTimeout="auto"
            hintTimeoutMs="12000"
            action="/process"
            method="POST">
      <Say voice="alice" language="${LOCALE}">
        Bonjour ! Dites votre commande naturellement. Par exemple : 
        "Deux tacos boeuf, une pizza quatre fromages et un coca zéro".
        Quand vous avez terminé, restez silencieux quelques secondes.
      </Say>
    </Gather>
    <Say voice="alice" language="${LOCALE}">
      Désolé, je n'ai rien entendu. Rappelez si besoin.
    </Say>
    <Hangup/>
  `.trim());

  res.type("text/xml").send(twimlXml);
});

// 2) Réception du résultat speech -> parsing -> SMS -> confirmation
app.post("/process", async (req, res) => {
  try {
    const from = req.body.From;             // numéro appelant (E.164)
    const transcript = (req.body.SpeechResult || "").trim();

    console.log("🎤 Transcription:", transcript || "<vide>");

    const parsed = parseOrder(transcript);
    const lines = parsed.items.map(it => `• ${it.quantity} x ${it.name}`);
    let smsBody = "";

    if (lines.length > 0) {
      smsBody = `Récapitulatif de votre commande:\n${lines.join("\n")}`;
      if (parsed.notes) smsBody += `\nNotes: ${parsed.notes}`;
    } else {
      smsBody = `Message reçu:\n"${transcript || "—"}"\n(aucun article reconnu)`;
    }

    // SMS à l’appelant
    if (from) {
      await client.messages.create({
        from: TWILIO_SMS_FROM,
        to: from,
        body: smsBody,
      });
      console.log("📩 SMS envoyé à", from);
    } else {
      console.warn("⚠️ From manquant. SMS non envoyé.");
    }

    // Réponse vocale
    const voiceConfirm = lines.length
      ? `Merci ! Je vous ai envoyé votre récapitulatif par SMS.`
      : `Merci ! J'ai reçu votre message.`;

    const twimlXml = twiml(`
      <Say voice="alice" language="${LOCALE}">${voiceConfirm}</Say>
      <Hangup/>
    `.trim());

    res.type("text/xml").send(twimlXml);
  } catch (err) {
    console.error("❌ /process error:", err.message);
    res.type("text/xml").send(
      twiml(`<Say voice="alice" language="${LOCALE}">Désolé, une erreur est survenue.</Say><Hangup/>`)
    );
  }
});

// 3) Healthcheck simple
app.get("/", (req, res) => {
  res.send("✅ Voice order (no-OpenAI) is running!");
});

app.listen(PORT, () => {
  console.log(`✅ Server on : ${PORT}`);
});
