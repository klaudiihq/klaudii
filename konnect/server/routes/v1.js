// v1 Relay API Router
//
// Consolidates all relay HTTP routes (auth, pairing, servers, proxy, health)
// with dependency injection for testability.

const express = require("express");

module.exports = function createRelayV1Router(deps) {
  const { db, wsHub, auth, pairing, proxy } = deps;

  const router = express.Router();

  // Version header on every response
  router.use((_req, res, next) => {
    res.set("X-Klaudii-API-Version", "1");
    next();
  });

  // --- Health ---
  router.get("/api/relay/health", (_req, res) => {
    res.json({
      ok: true,
      onlineServers: wsHub.getOnlineServerIds().length,
    });
  });

  // --- Auth routes ---
  auth.setupRoutes(router, db);

  // --- Pairing routes ---
  pairing.setupRoutes(router, { requireAuth: auth.requireAuth });

  // --- Proxy routes ---
  proxy.setupRoutes(router);

  return router;
};
