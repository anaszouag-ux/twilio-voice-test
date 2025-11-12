// Minimal Realtime test (browser ↔ OpenAI Realtime via WebRTC)
// ENV: OPENAI_API_KEY, OPENAI_REALTIME_MODEL (ex: gpt-4o-realtime-preview), VOICE (ex: alloy)

import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 5000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";
const VOICE = process.env.VOICE || "alloy";

if (!OPENAI_API_KEY) {
  console.warn("⚠️  OPENAI_API_KEY manquante (Render → Environment).");
}

app.use(cors());
app.use(express.json());

// Page client
app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <title>Realtime Test</title>
  <style>
    body{font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:720px;margin:48px auto;padding:0 16px}
    button{padding:10px 16px;font-size:16px}
    pre{white-space:pre-wrap;background:#f6f8fa;padding:12px;border-radius:8px}
  </style>
</head>
<body>
  <h1>Test OpenAI Realtime (WebRTC)</h1>
  <p>1) Clique <b>Start</b> • 2) Autorise le micro • 3) Parle naturellement</p>
  <button id="startBtn">Start</button>
  <audio id="assistantAudio" autoplay></audio>
  <pre id="log"></pre>
  <script>
    const logEl = document.getElementById('log');
    function log(){ logEl.textContent += Array.from(arguments).join(' ') + "\\n"; }

    async function getEphemeralKey(){
      const r = await fetch('/session', { method:'POST' });
      if(!r.ok) throw new Error('session failed');
      return await r.json(); // { client_secret: { value }, ... }
    }

    async function startRealtime(){
      try{
        log('🔐 Requesting ephemeral key…');
        const session = await getEphemeralKey();
        const EPHEMERAL = session?.client_secret?.value;
        if(!EPHEMERAL) throw new Error('No ephemeral client_secret');

        const pc = new RTCPeerConnection();
        const audioEl = document.getElementById('assistantAudio');

        pc.ontrack = (e) => { audioEl.srcObject = e.streams[0]; };

        const dc = pc.createDataChannel("oai-events");
        dc.onopen = () => {
          log('🔗 DataChannel open');
          dc.send(JSON.stringify({
            type: "response.create",
            response: {
              modalities: ["audio"],
              instructions: "Bonjour ! Je suis un test Realtime. Parle-moi naturellement en français."
            }
          }));
        };

        const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
        ms.getTracks().forEach(t => pc.addTrack(t, ms));

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        log('📡 Sending SDP offer to OpenAI…');
        const sdpRes = await fetch("https://api.openai.com/v1/realtime?model=${REALTIME_MODEL}", {
          method: "POST",
          body: offer.sdp,
          headers: {
            "Authorization": "Bearer " + EPHEMERAL,
            "Content-Type": "application/sdp",
            "OpenAI-Beta": "realtime=v1"
          }
        });

        if(!sdpRes.ok){
          const errTxt = await sdpRes.text();
          throw new Error("Realtime SDP failed: " + errTxt);
        }

        const answer = { type: "answer", sdp: await sdpRes.text() };
        await pc.setRemoteDescription(answer);
        log('🧠 Realtime connected. Parle et écoute la réponse.');
      } catch (e){
        log('❌ Error:', e.message);
        console.error(e);
      }
    }

    document.getElementById('startBtn').onclick = () => {
      document.getElementById('startBtn').disabled = true;
      startRealtime();
    };
  </script>
</body>
</html>`);
});

// Endpoint pour créer une clé éphémère
app.post("/session", async (_req, res) => {
  try {
    const r = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "OpenAI-Beta": "realtime=v1"
      },
      body: JSON.stringify({
        model: REALTIME_MODEL,
        voice: VOICE,
        modalities: ["audio"]
      })
    });

    const data = await r.json();
    if (!r.ok) {
      console.error("Realtime session error:", data);
      return res.status(500).json({ error: "session_failed", detail: data });
    }
    res.json(data);
  } catch (e) {
    console.error("Session exception:", e);
    res.status(500).json({ error: "session_exception", detail: e.message });
  }
});

app.get("/health", (_req, res) =>
  res.json({ ok: true, model: REALTIME_MODEL, voice: VOICE })
);

app.listen(PORT, () => {
  console.log(`✅ Realtime minimal server on ${PORT}`);
});
