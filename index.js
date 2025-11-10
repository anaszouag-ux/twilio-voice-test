// index.js — Flux 100% Twilio : prise de commande vocale + SMS récap, sans OpenAI

import express from "express";
import Twilio from "twilio";

const app = express();
const PORT = process.env.PORT || 5000;

// ENV attendus : TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_SMS_FROM, LOCALE (facultatif)
const client = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const LOCALE = process.env.LOCALE || "fr-FR";
const SMS_FROM = process.env.TWILIO_SMS_FROM;

// Twilio envoie les webhooks en x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));

const twiml = (xml) => `<?xml version="1.0" encoding="UTF-8"?><Response>${xml}</Response>`;

app.get("/", (req, res) => res.send("✅ Voice AI (Twilio-only) running"));

/**
 * 1) Accueil + <Gather input="speech"> pour capter la commande
 * - Twilio fera la STT côté plate-forme et renverra SpeechResult à /process
 */
app.all("/voice", (req, res) => {
  res.type("text/xml").send(
    twiml(`
      <Gather input="speech"
              language="${LOCALE}"
              speechTimeout="auto"
              action="/process"
              method="POST">
        <Say voice="alice" language="${LOCALE}">
          Bonjour ! Dites votre commande après le bip. 
          Par exemple : deux tacos bœuf, une pizza quatre fromages, et un coca zéro.
          Quand vous avez terminé, dites simplement "c'est tout".
        </Say>
        <Pause length="1"/>
      </Gather>
      <Say voice="alice" language="${LOCALE}">
        Pardon, je n'ai rien entendu. Je vous invite à rappeler.
      </Say>
      <Hangup/>
    `)
  );
});

/**
 * 2) Réception du résultat STT de Twilio -> SMS au client et confirmation vocale
 */
app.post("/process", async (req, res) => {
  const speech = (req.body.SpeechResult || "").trim();
  const from = req.body.From;

  // Si Twilio n'a rien compris, on redemande une fois
  if (!speech) {
    return res.type("text/xml").send(
      twiml(`
        <Say voice="alice" language="${LOCALE}">
          Désolé, je n'ai pas compris. Pouvez-vous répéter votre commande ?
        </Say>
        <Redirect method="POST">/voice</Redirect>
      `)
    );
  }

  // Message SMS à envoyer au client
  const smsBody =
    `Récap de votre commande :\n` +
    `"${speech}"\n\n` +
    `Si c'est correct, aucun retour n'est nécessaire. Merci !`;

  // On tente d'envoyer le SMS (si la config SMS est OK)
  try {
    if (SMS_FROM && from) {
      await client.messages.create({ from: SMS_FROM, to: from, body: smsBody });
      console.log("📩 SMS envoyé à", from, "=>", smsBody);
    } else {
      console.warn("⚠️ SMS non envoyé (TWILIO_SMS_FROM ou From manquant)");
    }
  } catch (e) {
    console.error("❌ Erreur envoi SMS:", e?.message || e);
  }

  // Confirmation à l'appelant + on répète ce qu'on a compris
  res.type("text/xml").send(
    twiml(`
      <Say voice="alice" language="${LOCALE}">
        Merci. J'ai bien noté : ${speech}.
        Vous allez recevoir un SMS récapitulatif.
        Bonne journée !
      </Say>
      <Hangup/>
    `)
  );
});

app.listen(PORT, () => console.log(`✅ Voice AI (Twilio-only) live on ${PORT}`));
