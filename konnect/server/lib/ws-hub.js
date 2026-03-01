const WebSocket = require("ws");
const crypto = require("crypto");
const { verify } = require("../../shared/crypto");
const db = require("./db");

// Connected Klaudii servers: serverId → { ws, authenticated, lastHeartbeat }
const servers = new Map();

// Connected browsers: browserId → { ws, userId, serverId }
const browsers = new Map();

// Pending challenges: serverId → nonce
const challenges = new Map();

const HEARTBEAT_INTERVAL = 30000;
const HEARTBEAT_TIMEOUT = 65000;

let heartbeatTimer;

function init(httpServer) {
  const wss = new WebSocket.Server({ server: httpServer, path: "/ws" });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const role = url.searchParams.get("role"); // "server" or "browser"

    if (role === "server") {
      handleServerConnection(ws, url);
    } else if (role === "browser") {
      handleBrowserConnection(ws, url, req);
    } else {
      ws.close(4000, "Missing role parameter");
    }
  });

  // Heartbeat check
  heartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const [serverId, conn] of servers) {
      if (now - conn.lastHeartbeat > HEARTBEAT_TIMEOUT) {
        console.log(`Server ${serverId} heartbeat timeout, disconnecting`);
        conn.ws.terminate();
        servers.delete(serverId);
      }
    }
  }, HEARTBEAT_INTERVAL);

  return wss;
}

function handleServerConnection(ws, url) {
  const serverId = url.searchParams.get("serverId");
  if (!serverId) {
    ws.close(4001, "Missing serverId");
    return;
  }

  const server = db.getServerById(serverId);
  if (!server) {
    ws.close(4002, "Unknown server");
    return;
  }

  // Send auth challenge
  const nonce = crypto.randomBytes(32).toString("hex");
  challenges.set(serverId, nonce);
  ws.send(JSON.stringify({ type: "auth_challenge", nonce }));

  const tempConn = { ws, authenticated: false, lastHeartbeat: Date.now() };

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "auth_response") {
      const expectedNonce = challenges.get(serverId);
      if (!expectedNonce) {
        ws.close(4003, "No pending challenge");
        return;
      }
      challenges.delete(serverId);

      const valid = verify(server.ed25519_public_key, expectedNonce, msg.signature);
      if (!valid) {
        ws.close(4004, "Invalid signature");
        return;
      }

      tempConn.authenticated = true;
      tempConn.platform = msg.platform || null;
      servers.set(serverId, tempConn);
      db.updateServerLastSeen(serverId);
      ws.send(JSON.stringify({ type: "auth_result", ok: true }));
      console.log(`Server ${serverId} (${server.name}) authenticated`);
      return;
    }

    if (!tempConn.authenticated) {
      ws.close(4005, "Not authenticated");
      return;
    }

    if (msg.type === "heartbeat") {
      tempConn.lastHeartbeat = Date.now();
      db.updateServerLastSeen(serverId);
      ws.send(JSON.stringify({ type: "heartbeat_ack" }));
      return;
    }

    // API response from server → forward to the requesting browser
    if (msg.type === "api_response") {
      const browser = findBrowserByRequestId(msg.requestId);
      if (browser && browser.ws.readyState === WebSocket.OPEN) {
        browser.ws.send(JSON.stringify({
          type: "api_response",
          requestId: msg.requestId,
          encrypted: msg.encrypted,
        }));
      }
      return;
    }
  });

  ws.on("close", () => {
    if (servers.get(serverId)?.ws === ws) {
      servers.delete(serverId);
      console.log(`Server ${serverId} disconnected`);
    }
    challenges.delete(serverId);
  });

  ws.on("error", (err) => {
    console.error(`Server ${serverId} WebSocket error:`, err.message);
  });
}

function handleBrowserConnection(ws, url, req) {
  const browserId = crypto.randomUUID();
  const serverId = url.searchParams.get("serverId");

  // User auth is checked via session cookie before WebSocket upgrade
  // For now, extract userId from query param (set by the auth middleware)
  const userId = url.searchParams.get("userId");
  if (!userId || !serverId) {
    ws.close(4010, "Missing userId or serverId");
    return;
  }

  // Verify the user owns this server
  const server = db.getServerById(serverId);
  if (!server || server.user_id !== userId) {
    ws.close(4011, "Unauthorized");
    return;
  }

  browsers.set(browserId, { ws, userId, serverId, pendingRequests: new Map() });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "api_request") {
      const serverConn = servers.get(serverId);
      if (!serverConn || !serverConn.authenticated) {
        ws.send(JSON.stringify({
          type: "api_response",
          requestId: msg.requestId,
          error: "server_offline",
        }));
        return;
      }

      // Store request mapping for response routing
      const browser = browsers.get(browserId);
      if (browser) {
        browser.pendingRequests.set(msg.requestId, true);
      }

      // Forward encrypted payload to server (relay cannot decrypt)
      serverConn.ws.send(JSON.stringify({
        type: "api_request",
        requestId: msg.requestId,
        encrypted: msg.encrypted,
      }));
      return;
    }
  });

  ws.on("close", () => {
    browsers.delete(browserId);
  });

  ws.on("error", (err) => {
    console.error(`Browser ${browserId} WebSocket error:`, err.message);
  });

  // Notify browser of connection status
  const serverConn = servers.get(serverId);
  const online = !!(serverConn && serverConn.authenticated);
  ws.send(JSON.stringify({
    type: "server_status",
    online,
    platform: online ? serverConn.platform : null,
  }));
}

function findBrowserByRequestId(requestId) {
  for (const [, browser] of browsers) {
    if (browser.pendingRequests.has(requestId)) {
      browser.pendingRequests.delete(requestId);
      return browser;
    }
  }
  return null;
}

function isServerOnline(serverId) {
  const conn = servers.get(serverId);
  return !!(conn && conn.authenticated);
}

function getServerPlatform(serverId) {
  const conn = servers.get(serverId);
  return conn && conn.authenticated ? conn.platform : null;
}

function getOnlineServerIds() {
  const ids = [];
  for (const [id, conn] of servers) {
    if (conn.authenticated) ids.push(id);
  }
  return ids;
}

function shutdown() {
  clearInterval(heartbeatTimer);
  for (const [, conn] of servers) {
    conn.ws.close(1001, "Relay shutting down");
  }
  for (const [, conn] of browsers) {
    conn.ws.close(1001, "Relay shutting down");
  }
  servers.clear();
  browsers.clear();
}

module.exports = {
  init,
  isServerOnline,
  getServerPlatform,
  getOnlineServerIds,
  shutdown,
};
