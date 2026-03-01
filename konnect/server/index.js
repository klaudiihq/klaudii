const express = require("express");
const http = require("http");
const path = require("path");
const cookieSession = require("cookie-session");
const db = require("./lib/db");
const wsHub = require("./lib/ws-hub");
const auth = require("./lib/auth");
const pairing = require("./lib/pairing");
const proxy = require("./lib/proxy");

// --- Config from environment ---
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || "klaudii-dev-secret-change-in-prod";
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "relay.db");

// --- Initialize ---
db.init(DB_PATH);

const app = express();

// Trust Fly.io's TLS-terminating proxy so secure cookies work in production
app.set("trust proxy", 1);

app.use(express.json());

// Session cookies
app.use(
  cookieSession({
    name: "klaudii_session",
    keys: [SESSION_SECRET],
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "lax",
  })
);

// Serve the Klaudii dashboard files (same UI as local)
// Cloud-specific pages (login, server picker) are served from relay's own public/
app.use(express.static(path.join(__dirname, "public")));

// Also serve the main Klaudii dashboard files under /dashboard/
// This lets the cloud UI load the exact same frontend
app.use("/dashboard", express.static(path.join(__dirname, "..", "..", "public")));

// Also serve main Klaudii assets at root (index:false so SPA fallback stays in charge of /)
// Needed because index.html uses absolute paths like /style.css and /app.js
app.use(express.static(path.join(__dirname, "..", "..", "public"), { index: false }));

// --- Health ---
app.get("/api/relay/health", (_req, res) => {
  res.json({
    ok: true,
    onlineServers: wsHub.getOnlineServerIds().length,
  });
});

// --- Auth routes ---
auth.setupRoutes(app, db);

// --- Pairing routes ---
pairing.setupRoutes(app, { requireAuth: auth.requireAuth });

// --- Proxy routes ---
proxy.setupRoutes(app);

// --- SPA fallback: serve login page for unauthenticated, dashboard for authenticated ---
app.get("/", (req, res) => {
  if (req.session && req.session.userId) {
    res.sendFile(path.join(__dirname, "public", "dashboard.html"));
  } else {
    res.sendFile(path.join(__dirname, "public", "login.html"));
  }
});

// --- Start ---
const server = http.createServer(app);
wsHub.init(server);

server.listen(PORT, () => {
  console.log(`Klaudii Cloud Relay running on port ${PORT}`);
  console.log(`  Google OAuth: ${process.env.GOOGLE_CLIENT_ID ? "configured" : "NOT CONFIGURED"}`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down...");
  wsHub.shutdown();
  server.close(() => process.exit(0));
});
