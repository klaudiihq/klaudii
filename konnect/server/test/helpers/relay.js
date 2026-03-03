// Test helper: creates an Express app with the relay v1 router and mock dependencies.

const express = require("express");
const cookieSession = require("cookie-session");
const createRelayV1Router = require("../../routes/v1");

// --- Mock data ---

const mockUser = { id: "user-001", google_id: "g-123", email: "test@example.com", name: "Test User" };

const mockServers = [
  { id: "srv-001", name: "MacBook Pro", user_id: "user-001", public_key: "ed25519-key", last_seen: Date.now() / 1000, created_at: Date.now() / 1000 - 86400 },
  { id: "srv-002", name: "Mac Mini", user_id: "user-001", public_key: "ed25519-key-2", last_seen: null, created_at: Date.now() / 1000 - 172800 },
];

// --- Mock dependencies ---

function createMockDeps(overrides = {}) {
  return {
    db: {
      upsertUser: () => mockUser,
      getUserById: (id) => (id === mockUser.id ? mockUser : null),
      getUserByGoogleId: () => mockUser,
      getServersByUser: (userId) => mockServers.filter((s) => s.user_id === userId),
      registerServer: (_userId, name, _publicKey) => ({
        id: "srv-new",
        name,
      }),
      removeServer: (id, userId) => {
        return mockServers.some((s) => s.id === id && s.user_id === userId);
      },
      createPairingCode: () => {},
      consumePairingCode: (code) =>
        code === "TESTCODE" ? { user_id: mockUser.id } : null,
      cleanExpiredPairingCodes: () => {},
    },

    wsHub: {
      getOnlineServerIds: () => ["srv-001"],
      isServerOnline: (id) => id === "srv-001",
      getServerPlatform: (id) => (id === "srv-001" ? "darwin" : null),
    },

    auth: {
      setupRoutes: (router, db) => {
        // Simplified auth routes for testing (no real Google OAuth)
        router.get("/auth/me", (req, res) => {
          if (!req.session || !req.session.userId) {
            return res.status(401).json({ error: "Not authenticated" });
          }
          const user = db.getUserById(req.session.userId);
          if (!user) {
            req.session = null;
            return res.status(401).json({ error: "User not found" });
          }
          res.json({ id: user.id, email: user.email, name: user.name });
        });

        router.post("/auth/token-exchange", (req, res) => {
          const { token } = req.body;
          if (!token || token !== "valid-token") {
            return res.status(401).json({ error: "Invalid or expired token" });
          }
          req.session.userId = mockUser.id;
          res.json({ ok: true });
        });

        router.post("/auth/logout", (req, res) => {
          req.session = null;
          res.json({ ok: true });
        });
      },
      requireAuth: (req, res, next) => {
        if (!req.session || !req.session.userId) {
          return res.status(401).json({ error: "Not authenticated" });
        }
        next();
      },
    },

    pairing: {
      setupRoutes: (router, { requireAuth }) => {
        router.post("/api/pairing/create", requireAuth, (req, res) => {
          res.json({ code: "ABC123", expiresIn: 600 });
        });

        router.post("/api/pairing/redeem", (req, res) => {
          const { code, name, publicKey } = req.body;
          if (!code || !name || !publicKey) {
            return res.status(400).json({ error: "code, name, and publicKey required" });
          }
          if (code !== "TESTCODE") {
            return res.status(404).json({ error: "Invalid or expired pairing code" });
          }
          res.json({
            serverId: "srv-new",
            relayUrl: "wss://konnect.klaudii.com/ws",
          });
        });

        router.get("/api/servers", requireAuth, (req, res) => {
          const deps = createMockDeps();
          const servers = deps.db.getServersByUser(req.session.userId);
          const result = servers.map((s) => ({
            id: s.id,
            name: s.name,
            online: deps.wsHub.isServerOnline(s.id),
            platform: deps.wsHub.getServerPlatform(s.id),
            lastSeen: s.last_seen,
            createdAt: s.created_at,
          }));
          res.json(result);
        });

        router.delete("/api/servers/:id", requireAuth, (req, res) => {
          const ok = mockServers.some(
            (s) => s.id === req.params.id && s.user_id === req.session.userId
          );
          if (!ok) {
            return res.status(404).json({ error: "Server not found" });
          }
          res.json({ ok: true });
        });
      },
    },

    proxy: {
      setupRoutes: (router) => {
        router.get("/api/servers/:id/status", (req, res) => {
          const online = req.params.id === "srv-001";
          res.json({ online });
        });
      },
    },

    ...overrides,
  };
}

/**
 * Create a test Express app with the relay v1 router and mock dependencies.
 * Includes cookie-session middleware so auth tests work.
 */
function createTestApp(overrides = {}) {
  const deps = createMockDeps(overrides);
  const app = express();
  app.use(express.json());
  app.use(
    cookieSession({
      name: "klaudii_session",
      keys: ["test-secret"],
      maxAge: 24 * 60 * 60 * 1000,
    })
  );
  app.use(createRelayV1Router(deps));
  return { app, deps };
}

/**
 * Create a test app with a pre-authenticated session.
 * Returns a supertest agent that maintains cookies across requests.
 */
function createAuthenticatedAgent(supertest, overrides = {}) {
  const { app, deps } = createTestApp(overrides);
  const agent = supertest.agent(app);

  // Set up authenticated session by directly manipulating the session
  // We'll use a middleware that sets the session for testing
  return {
    app,
    deps,
    agent,
    // Call this to authenticate the agent
    async authenticate() {
      await agent
        .post("/auth/token-exchange")
        .send({ token: "valid-token" })
        .expect(200);
      return agent;
    },
  };
}

module.exports = {
  createTestApp,
  createMockDeps,
  createAuthenticatedAgent,
  mockUser,
  mockServers,
};
