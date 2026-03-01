const { generatePairingCode, generateId } = require("../../shared/crypto");
const db = require("./db");

function setupRoutes(app, { requireAuth }) {
  // Generate a new pairing code for the authenticated user
  app.post("/api/pairing/create", requireAuth, (req, res) => {
    const userId = req.session.userId;

    // Clean up old codes
    db.cleanExpiredPairingCodes();

    const code = generatePairingCode();
    db.createPairingCode(code, userId);

    res.json({ code, expiresIn: 600 });
  });

  // Called by the Klaudii server to redeem a pairing code
  // This is an unauthenticated endpoint — the pairing code IS the auth
  app.post("/api/pairing/redeem", (req, res) => {
    const { code, name, publicKey } = req.body;
    if (!code || !name || !publicKey) {
      return res.status(400).json({ error: "code, name, and publicKey required" });
    }

    // Normalize code: strip whitespace, uppercase
    const normalized = code.replace(/\s/g, "").toUpperCase();

    const pairing = db.consumePairingCode(normalized);
    if (!pairing) {
      return res.status(404).json({ error: "Invalid or expired pairing code" });
    }

    // Register the server under the user who created the pairing code
    const server = db.registerServer(pairing.user_id, name, publicKey);

    res.json({
      serverId: server.id,
      relayUrl: process.env.RELAY_WS_URL || `wss://${req.headers.host}/ws`,
    });
  });

  // List servers for the authenticated user
  app.get("/api/servers", requireAuth, (req, res) => {
    const userId = req.session.userId;
    const servers = db.getServersByUser(userId);
    const wsHub = require("./ws-hub");

    const result = servers.map((s) => ({
      id: s.id,
      name: s.name,
      online: wsHub.isServerOnline(s.id),
      platform: wsHub.getServerPlatform(s.id),
      lastSeen: s.last_seen,
      createdAt: s.created_at,
    }));

    res.json(result);
  });

  // Remove a server
  app.delete("/api/servers/:id", requireAuth, (req, res) => {
    const userId = req.session.userId;
    const ok = db.removeServer(req.params.id, userId);
    if (!ok) {
      return res.status(404).json({ error: "Server not found" });
    }
    res.json({ ok: true });
  });
}

module.exports = { setupRoutes };
