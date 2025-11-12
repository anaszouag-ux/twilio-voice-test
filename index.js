// index.js — Twilio <Stream> ⇄ OpenAI Realtime (full-duplex, robuste)

import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import WebSocket from "ws";

/* ====== ENV ====== */
const PORT = process.env.PORT || 5000;
const BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, ""); // ex: https://xxx.onrender.com
const LOCALE = process.env.LOCALE || "fr-FR";
const VOICE = process.env.VOICE || "alloy";
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-5-realtime-preview";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!BASE_URL) console.warn("⚠️ PUBLIC_BASE_URL manquant (ajoute-le dans Render → Environment)");
if (!OPENAI_API_KEY) console.warn("⚠️ OPENAI_API_KEY manquant (aucune réponse IA possible)");
console.log("ℹ️ Config:", { BASE_URL, LOCALE, VOICE, REALTIME_MODEL });

/* ====== µ-law / PCM helpers ====== */
// µ-law decode (-> Int16 sample)
function muLawDecode(sample) {
  sample = ~sample & 0xff;
  const sign = (sample & 0x80) ? -1 : 1;
  const exponent = (sample >> 4) & 0x07;
  const mantissa = sample & 0x0f;
  const magnitude = ((mantissa << 4) + 0x08) << (exponent + 3);
  return sign * magnitude;
}
// base64 µ-law -> Int16Array (8kHz)
function decodeMuLawBase64ToInt16(base64) {
  const ulaw = Buffer.from(base64, "base64");
  const pcm = new Int16Array(ulaw.length);
  for (let i = 0; i < ulaw.length; i++) pcm[i] = muLawDecode(ulaw[i]);
  return pcm;
}
// simple upsample 8k -> 16k (duplication)
function upsample8kTo16k(int16_8k) {
  const out = new Int16Array(int16_8k.length * 2);
  for (let i = 0; i < int16_8k.length; i++) {
    out[2 * i] = int16_8k[i];
    out[2 * i + 1] = int16_8k[i];
  }
  return out;
}
// PCM16 -> µ-law (un sample)
function linearToMuLaw(sample) {
  const CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  const mantissa = (sample >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}
// Int16Array 16k -> base64 µ-law 8k (downsample x2)
function pcm16_16k_ToMuLawBase64(int16_16k) {
  const len8k = Math.floor(int16_16k.length / 2);
  const ulaw = Buffer.alloc(len8k);
  for (let i = 0; i < len8k; i++) {
    const s = int16_16k[i * 2];
    ulaw[i] = linearToMuLaw(s);
  }
  return ulaw.toString("base64");
}

/* ====== App HTTP ====== */
const app = express();
app.use(express.urlencoded({ extended: false }));

// Health
app.get("/", (_, res) => res.send("✅ Realtime voice bridge is up"));

// TwiML: connecte l'appel à notre WebSocket /stream
app.all("/voice", (req, res) => {
  const wsUrl = `${BASE_URL.replace(/^http/, "ws")}/stream`;
  const xml = `
    <?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Say voice="alice" language="${LOCALE}">Bonjour, je vous écoute. Parlez naturellement s'il vous plaît.</Say>
      <Connect>
        <Stream url="${wsUrl}" track="both_tracks" />
      </Connect>
    </Response>
  `.trim();
  res.type("text/xml").send(xml);
});

/* ====== HTTP + WS server ====== */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/stream" });

/* ====== Bridge Twilio <-> OpenAI Realtime ====== */
wss.on("connection", (twilioWS) => {
  console.log("🔌 Twilio stream connected");

  // Ouvre le WS Realtime OpenAI
  const openaiWS = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY || ""}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  let openaiReady = false;

  openaiWS.on("open", () => {
    openaiReady = true;
    console.log("🧠 OpenAI Realtime connected");

    // Configure la session
    openaiWS.send(JSON.stringify({
      type: "session.update",
      session: {
        voice: VOICE,
        input_audio_format: { type: "pcm16", sample_rate_hz: 16000 },
        output_audio_format: { type: "pcm16", sample_rate_hz: 16000 },
        instructions:
          `Tu es un assistant de prise de commande pour un restaurant rapide. 
           Parle ${LOCALE}. Réponds vite, poliment, brièvement.
           Interromps-toi si l'utilisateur parle (barge-in implicite).
           Reformule et confirme les éléments de commande.`
      }
    }));

    // Premier message (évite le blanc)
    openaiWS.send(JSON.stringify({
      type: "response.create",
      response: { modalities: ["audio"], instructions: "Bonjour ! Que puis-je vous préparer aujourd’hui ?" }
    }));
  });

  openaiWS.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // Audio sortant de l'IA (PCM16 16k base64) -> μ-law 8k -> Twilio
      if (msg.type === "response.output_audio.delta" && msg.delta) {
        const raw = Buffer.from(msg.delta, "base64");
        const int16 = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
        const ulawB64 = pcm16_16k_ToMuLawBase64(int16);

        const media = { event: "media", media: { payload: ulawB64 } };
        try { twilioWS.readyState === 1 && twilioWS.send(JSON.stringify(media)); } catch {}
      }

      // (debug texte facultatif)
      if (msg.type === "response.output_text.delta") process.stdout.write(msg.delta);
      if (msg.type === "response.completed") process.stdout.write("\n");

    } catch (e) {
      console.warn("OpenAI msg parse error:", e.message);
    }
  });

  openaiWS.on("error", (e) => console.error("❌ OpenAI WS error:", e.message));
  openaiWS.on("close", () => console.log("🧠 OpenAI WS closed"));

  // Audio entrant Twilio -> OpenAI
  twilioWS.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (!openaiReady) return;

      switch (msg.event) {
        case "start":
          console.log("▶️  Twilio start:", msg.start?.streamSid, msg.start?.mediaFormat);
          break;

        case "media": {
          // Twilio -> μ-law 8k base64 -> Int16 -> upsample 16k -> base64 PCM16
          const pcm8k = decodeMuLawBase64ToInt16(msg.media.payload);
          const pcm16k = upsample8kTo16k(pcm8k);
          const base64Pcm16 = Buffer.from(pcm16k.buffer).toString("base64");

          // Push audio dans le buffer d'entrée
          openaiWS.send(JSON.stringify({ type: "input_audio_buffer.append", audio: base64Pcm16 }));
          // Commit ce chunk et demande une réponse (modale audio)
          openaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          openaiWS.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio"] } }));
          break;
        }

        case "stop":
          console.log("⏹️  Twilio stop");
          try { openaiWS.close(); } catch {}
          break;

        default:
          // mark, clear, etc.
          break;
      }
    } catch (e) {
      console.warn("Twilio msg parse error:", e.message);
    }
  });

  // Keepalive pour éviter la coupure idle
  const pingIv = setInterval(() => {
    if (twilioWS.readyState === 1) twilioWS.ping();
  }, 15000);

  twilioWS.on("close", () => {
    console.log("🔌 Twilio WS closed");
    clearInterval(pingIv);
    try { openaiWS.close(); } catch {}
  });

  twilioWS.on("error", (err) => console.error("❌ Twilio WS error:", err.message));
});

/* ====== Start ====== */
server.listen(PORT, () => {
  console.log(`✅ Realtime voice bridge listening on ${PORT}`);
  console.log(`🌐 Base URL: ${BASE_URL || "(unset)"} | WS path: /stream`);
});
