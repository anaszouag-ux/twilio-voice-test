// index.js — Twilio <Stream> -> WebSocket /realtime (base de la conversation temps réel)

import express from "express";
import { WebSocketServer } from "ws";

const app = express();
const PORT = process.env.PORT || 5000;

// Twilio envoie en x-www-form-urlencoded sur /voice (webhook)
app.use(express.urlencoded({ extended: false }));

// Petit helper TwiML
const twiml = (body) => `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;

// Santé
app.get("/", (_req, res) => res.send("✅ Voice streaming server running"));
app.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * 1) Webhook Twilio « A call comes in »
 *    -> on lui répond avec une <Connect><Stream> vers notre WebSocket /realtime
 */
app.post("/voice", (req, res) => {
  // Si tu renseignes PUBLIC_BASE_URL=https://ton-app.onrender.com dans Render,
  // on l'utilise pour construire l'URL WSS. Sinon on prend l'host de la requête.
  const hostBase =
    process.env.PUBLIC_BASE_URL && process.env.PUBLIC_BASE_URL.startsWith("http")
      ? process.env.PUBLIC_BASE_URL
      : `https://${req.get("host")}`;

  const wsUrl = hostBase.replace(/^http/, "ws") + "/realtime";

  res.type("text/xml").send(
    twiml(`
      <Say language="fr-FR">Un instant, je vous mets en relation avec notre assistant.</Say>
      <Connect>
        <Stream url="${wsUrl}" />
      </Connect>
    `)
  );
});

/**
 * 2) Serveur HTTP + WebSocket /realtime
 *    Twilio se connecte ici et envoie les événements:
 *    - "start" (infos appel)
 *    - "media" (trames audio base64, 20 ms)
 *    - "stop" (fin du flux)
 *
 *    Pour le moment, on logge tout. Ensuite on branchera GPT-5 Realtime ici.
 */
const server = app.listen(PORT, () =>
  console.log(`✅ Voice streaming server listening on ${PORT}`)
);

const wss = new WebSocketServer({ server, path: "/realtime" });

wss.on("connection", (socket) => {
  console.log("🔊 Twilio stream connected");

  let streamSid = null;
  let packets = 0;

  socket.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      switch (data.event) {
        case "start":
          streamSid = data.start?.streamSid || null;
          console.log("▶️  start:", { streamSid, from: data.start?.from, to: data.start?.to });
          break;

        case "media":
          // data.media.payload contient l'audio (base64, PCM 8k mono 16-bit)
          packets += 1;
          if (packets % 50 === 0) {
            console.log(`🎧 media packets: ${packets} (streamSid=${streamSid || "?"})`);
          }
          // ICI plus tard: envoyer ces trames vers GPT-5 Realtime et renvoyer l'audio généré vers Twilio
          break;

        case "stop":
          console.log("⏹️  stop:", { streamSid });
          break;

        default:
          console.log("ℹ️  event:", data.event);
      }
    } catch (e) {
      console.error("⚠️ WS parse error:", e.message);
    }
  });

  socket.on("close", () => {
    console.log("❌ Twilio stream closed");
  });

  // (optionnel) ping pour garder la connexion en vie
  const pingIv = setInterval(() => {
    if (socket.readyState === socket.OPEN) socket.ping();
  }, 15000);

  socket.on("pong", () => { /* ok */ });
  socket.on("close", () => clearInterval(pingIv));
});
