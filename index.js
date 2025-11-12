// Minimal Realtime test (browser ↔ OpenAI Realtime via WebRTC)
// Server creates an ephemeral client token; browser talks directly to OpenAI.
// ENV needed: OPENAI_API_KEY, OPENAI_REALTIME_MODEL (ex: gpt-4o-realtime-preview), VOICE (ex: alloy)

import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 5000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";
const VOICE = process.env.VOICE || "alloy";

if (!OPENAI_API_KEY) {
  console.warn("⚠️ OPENAI_API_KEY manquante. Ajoute-la dans Render → Environment.");
}

app.use(cors());
app.use(express.json());

// Minimal home page (client)
app.get("/", (_req, res) => {
  res.type("html").send(`
<!doctype html>
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
    function log(...args){ logEl.textContent += args.join(' ') + "\\n"; }

    async function getEphemeralKey(){
      const r = await fetch('/session', {method:'POST'});
      if(!r.ok) throw new Error('session failed');
      return await r.json(); // { client_secret: { value, expires_at }, id, ... }
    }

    async function startRealtime(){
      log('🔐 Requesting ephemeral key…');
      const session = await getEphemeralKey();
      const EPHEMERAL = session?.client_secret?.value;
      if(!EPHEMERAL){ throw new Error('No ephemeral client_secret in response'); }
      log('✅ Ephemeral key OK (expires soon)');

      // Create WebRTC PeerConnection
      const pc = new RTCPeerConnection();
      const audioEl = document.getElementById('assistantAudio');

      // Play remote audio
      pc.ontrack = (e) => {
        audioEl.srcObject = e.streams[0];
      };

      // Data channel for control messages
      const dc = pc.createDataChannel("oai-events");
      dc.onopen = () => {
        log('🔗 DataChannel open');
        // Ask the assistant to greet in French (first response)
        dc.send(JSON.stringify({
          type: "response.create",
          response: {
            modalities: ["audio"],
            instructions: "Bonjour ! Je suis un test Realtime. Parle-moi naturellement en français."
          }
        }));
      };
      dc.onmessage = (e) => {
        // Optional debug of events coming from the model
        // log('📥 DC msg:', e.data);
      };

      // Get mic and send to PC
      const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
      ms.getTracks().forEach(t => pc.addTrack(t, ms));

      // Create and send SDP offer to OpenAI Realtime (with ephemeral token)
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      log('📡 Sending SDP offer to OpenAI…');
      const sdpResponse = await fetch("https://api.openai.com/v1/realtime?model=${REALTIME_MODEL}", {
        method: "POST",
        body: offer.sdp,
        headers: {
          "Authorization": "Bearer " + EPHEMERAL,
          "Content-Type": "application/sdp",
          "OpenAI-Beta": "realtime=v1"
        }
      });

      if(!sdpResponse.ok){
        const errTxt = await sdpResponse.text();
        throw new Error("Realtime SDP failed: " + errTxt);
      }

      const answer = { type: "answer", sdp: await sdpResponse.text() };
      await pc.setRemoteDescription(answer);
      log('🧠 Realtime connected. Parle et écoute la réponse.');
    }

    document.getElementById('startBtn').onclick = () => {
      document.getElementById('startBtn').disabled = true;
      startRealtime().catch(err => {
        log('❌ Error:', err.message);
        console.error(err);
      });
    };
  </script>
</body>
</html>
  `);
});

// Ephemeral session: creates a short-lived client token for the browser
app.post("/session", async (_req, res) => {
  try {
    const r = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        "Authorization": \`Bearer \${process.env.OPENAI_API_KEY}\`,
        "Content-Type": "application/json",
        "OpenAI-Beta": "realtime=v1"
      },
      body: JSON.stringify({
        model: REALTIME_MODEL,
        voice: VOICE,              // e.g. "alloy", "aria"…
        modalities: ["audio"],     // we want audio back
        // You can tune instructions defaults here:
        // instructions: "Tu es un assistant bref, poli, en français."
      })
    });
    const data = await r.json();
    if (!r.ok) {
      console.error("Realtime session error:", data);
      return res.status(500).json({ error: "session_failed", detail: data });
    }
    res.json(data);
  } catch (e) {
    console.error("Session exception:", e.message);
    res.status(500).json({ error: "session_exception", detail: e.message });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true, model: REALTIME_MODEL, voice: VOICE }));

app.listen(PORT, () => {
  console.log(\`✅ Realtime minimal server on \${PORT}\`);
});
