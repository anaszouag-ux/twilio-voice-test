import express from "express";

const app = express();
const PORT = process.env.PORT || 5000;

// Route utilisée par Twilio
app.all("/voice", (req, res) => {
  res.type("text/xml");
  res.send(`
    <Response>
      <Say voice="alice" language="fr-FR">
        Bonjour, ceci est un test Twilio hébergé sur Render. Si vous entendez ce message, tout fonctionne !
      </Say>
      <Pause length="1"/>
      <Say voice="alice" language="fr-FR">Fin du test. Au revoir.</Say>
      <Hangup/>
    </Response>
  `);
});

// Page d'accueil pour test navigateur
app.get("/", (_, res) => res.send("Serveur Twilio OK ✅"));

app.listen(PORT, "0.0.0.0", () => {
  console.log("✅ Serveur Twilio actif sur le port", PORT);
});
