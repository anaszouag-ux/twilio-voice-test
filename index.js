// index.js — Twilio <-> GPT-5 Realtime bridge (full-duplex)
// Node 18+, "type": "module" dans package.json

import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import WebSocket from "ws";

// ---------- ENV ----------
const PORT = process.env.PORT || 5000;
const BASE_URL = process.env.PUBLIC_BASE_URL; // https://xxx.onrender.com
const LOCALE = process.env.LOCALE || "fr-FR";
const VOICE = process.env.VOICE || "alloy";
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-5-realtime-preview";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ---------- HELPERS (audio) ----------
// Twilio envoie du µ-law (G.711 u-law) 8kHz mono en base64.
// OpenAI Realtime préfère PCM 16-bit LE 16kHz.
// On décode µ-law -> PCM16 8kHz, on "downsample/up-sample" simple si besoin.

// µ-law constantes
const MULAW_MAX = 0x1FFF;
const MULAW_BIAS = 0x84;

function muLawDecode(sample) {
  sample = ~sample & 0xff;
  let sign = (sample & 0x80) ? -1 : 1;
  let exponent = (sample >> 4) & 0x07;
  let mantissa = sample & 0x0f;
  let magnitude = ((mantissa << 4) + 0x08) << (exponent + 3);
  return sign * magnitude;
}

// Decode base64 µ-law -> Int16Array (PCM 8kHz)
function decodeMuLaw(base64) {
  const ulaw = Buffer.from(base64, "base64");
  const pcm = new Int16Array(ulaw.length);
  for (let i = 0; i < ulaw.length; i++) {
    pcm[i] = muLawDecode(ulaw[i]);
  }
  return pcm;
}

// Down/Up sample très simple : 8k -> 16k (duplication) / 16k -> 8k (skipping)
function upsampleTo16k(int16_8k) {
  const out = new Int16Array(int16_8k.length * 2);
  for (let i = 0; i < int16_8k.length; i++) {
    // duplication naïve (zero-order hold)
    out[2 * i] = int16_8k[i];
    out[2 * i + 1] = int16_8k[i];
  }
  return out;
}

// PCM16 -> µ-law (pour renvoyer l'audio vers Twilio)
function linearToMuLaw(sample) {
  const CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  let mantissa = (sample >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0f;
  const ulaw = ~(sign | (exponent << 4) | mantissa);
  return ulaw & 0xff;
}

function pcm16ToMuLawBase64(pcm16_16k) {
  // On downsample grossièrement 16k -> 8k en prenant 1 échantillon sur 2
  const len8k = Math.floor(pcm16_16k.length / 2);
  const ulaw = Buffer.alloc(len8k);
  for (let i = 0; i < len8k; i++) {
    const s = pcm16_16k[i * 2]; // sample sur 2
    const u = linearToMuLaw(s);
    ulaw[i] = u;
  }
  return ulaw.toString("base64");
}

// ---------- APP/HTTP ----------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// TwiML qui ouvre le flux bidirectionnel vers /realtime
app.all("/voice", (req, res) => {
  const wsUrl = `${BASE_URL.replace(/^http/, "ws")}/realtime`;
  const twiml = `
    <?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Say voice="alice" language="${LOCALE}">
        Bonjour, je vous écoute. Parlez naturellement s'il vous plaît.
      </Say>
      <Connect>
        <Stream url="${wsUrl}" track="both_tracks" />
      </Connect>
    </Response>
  `.trim();
  res.type("text/xml").send(twiml);
});

app.get("/", (req, res) => res.send("✅ Realtime voice bridge is up"));

const server = http.createServer(app);

// ---------- WS SERVER (Twilio side) ----------
const wss = new WebSocketServer({ server, path: "/realtime" });

wss.on("connection", async (twilioWs) => {
  console.log("🔌 Twilio stream connected");

  // Ouvre un WS Realtime côté OpenAI
  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  // File d’attente audio à envoyer vers Twilio quand GPT parle
  let openaiReady = false;

  openaiWs.on("open", () => {
    openaiReady = true;
    console.log("🧠 OpenAI Realtime connected");

    // Configure la session Realtime (langue & voix)
    const sessionUpdate = {
      type: "session.update",
      session: {
        voice: VOICE,
        input_audio_format: { type: "pcm16", sample_rate_hz: 16000 },
        output_audio_format: { type: "pcm16", sample_rate_hz: 16000 },
        instructions: `Tu es un assistant pour la prise de commande au restaurant.
- Parle ${LOCALE}.
- Raccourcis les silences, réponds vite et naturellement.
- Redemande poliment si tu n'es pas sûr.
- Résume quand la commande est finie.`,
      },
    };
    openaiWs.send(JSON.stringify(sessionUpdate));

    // Lance une 1ère réponse “bonjour…”
    openaiWs.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio"], instructions: "Bonjour ! Que puis-je vous préparer aujourd’hui ?" } }));
  });

  // Messages ↔ OpenAI
  openaiWs.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      // Quand GPT stream du son vers nous (PCM16 base64), on renvoie à Twilio en µ-law
      if (msg.type === "response.output_audio.delta" && msg.delta) {
        const pcm16 = Buffer.from(msg.delta, "base64"); // Int16LE 16kHz
        const int16 = new Int16Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength / 2);
        const ulawB64 = pcm16ToMuLawBase64(int16);

        const mediaMsg = {
          event: "media",
          media: {
            payload: ulawB64,
          },
        };
        // “Talkback” : Twilio accepte des frames media en retour quand track="both_tracks"
        twilioWs.send(JSON.stringify(mediaMsg));
      }

      // Fin d’un tour de parole
      if (msg.type === "response.completed") {
        // Rien de spécial ici ; si tu veux enchaîner, tu peux relancer un response.create
      }

      // Logs utiles
      if (msg.type === "response.output_text.delta") {
        process.stdout.write(msg.delta);
      }
      if (msg.type === "response.completed") {
        process.stdout.write("\n");
      }
    } catch (e) {
      console.warn("OpenAI msg parse error:", e.message);
    }
  });

  openaiWs.on("close", () => console.log("🧠 OpenAI WS closed"));
  openaiWs.on("error", (e) => console.error("OpenAI WS error:", e.message));

  // Messages ↔ Twilio (audio entrant µ-law 8k → GPT)
  twilioWs.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      switch (data.event) {
        case "start":
          console.log("▶️ Twilio start:", data.start?.callSid);
          break;

        case "media": {
          if (!openaiReady) break;
          const pcm8k = decodeMuLaw(data.media.payload);     // Int16Array 8 kHz
          const pcm16k = upsampleTo16k(pcm8k);                // Int16Array 16 kHz (naïf)
          const buf = Buffer.from(pcm16k.buffer);

          // Envoie à GPT-5 Realtime
          const audioAppend = {
            type: "input_audio_buffer.append",
            audio: buf.toString("base64"), // PCM16LE 16kHz en base64
          };
          openaiWs.send(JSON.stringify(audioAppend));

          // Demande à GPT de traiter ce qu’on vient d’ajouter (tour de parole court)
          const commit = { type: "input_audio_buffer.commit" };
          openaiWs.send(JSON.stringify(commit));

          // Déclenche une réponse (audio) si nécessaire
          const respond = { type: "response.create", response: { modalities: ["audio"] } };
          openaiWs.send(JSON.stringify(respond));
          break;
        }

        case "stop":
          console.log("⏹ Twilio stop");
          try { openaiWs.close(); } catch {}
          break;
      }
    } catch (e) {
      console.warn("Twilio msg parse error:", e.message);
    }
  });

  twilioWs.on("close", () => {
    console.log("🔌 Twilio WS closed");
    try { openaiWs.close(); } catch {}
  });
});

// ---------- START ----------
server.listen(PORT, () => {
  console.log(`✅ Realtime voice bridge listening on ${PORT}`);
});
