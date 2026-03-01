// The relay proxy doesn't decrypt anything — it just routes encrypted blobs
// between browsers and Klaudii servers. This module handles the REST fallback
// for browsers that can't use WebSockets (e.g., initial page loads).

const { requireAuth } = require("./auth");
const wsHub = require("./ws-hub");

function setupRoutes(app) {
  // Check server online status (not encrypted — just metadata)
  app.get("/api/servers/:id/status", requireAuth, (req, res) => {
    const online = wsHub.isServerOnline(req.params.id);
    res.json({ online });
  });
}

module.exports = { setupRoutes };
