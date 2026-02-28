const WebSocket = require("ws");
const { sign } = require("../shared/crypto");

let ws = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 60000;
let heartbeatTimer = null;
let onMessage = null;

function connect(config, messageHandler) {
  if (!config.cloud || !config.cloud.relayUrl || !config.cloud.serverId) {
    return;
  }

  onMessage = messageHandler;
  const { relayUrl, serverId, signingKey } = config.cloud;
  const url = `${relayUrl}?role=server&serverId=${encodeURIComponent(serverId)}`;

  try {
    ws = new WebSocket(url);
  } catch (err) {
    console.error("[cloud] WebSocket connection error:", err.message);
    scheduleReconnect(config);
    return;
  }

  ws.on("open", () => {
    console.log("[cloud] Connected to relay");
    reconnectDelay = 1000; // Reset backoff on successful connection
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Handle auth challenge
    if (msg.type === "auth_challenge") {
      const signature = sign(signingKey, msg.nonce);
      send({ type: "auth_response", signature });
      return;
    }

    // Handle auth result
    if (msg.type === "auth_result") {
      if (msg.ok) {
        console.log("[cloud] Authenticated with relay");
        startHeartbeat();
      } else {
        console.error("[cloud] Authentication failed");
        ws.close();
      }
      return;
    }

    // Handle heartbeat ack
    if (msg.type === "heartbeat_ack") {
      return;
    }

    // Forward all other messages to the handler
    if (onMessage) {
      onMessage(msg);
    }
  });

  ws.on("close", (code, reason) => {
    console.log(`[cloud] Disconnected from relay (code=${code}, reason=${reason})`);
    stopHeartbeat();
    ws = null;
    scheduleReconnect(config);
  });

  ws.on("error", (err) => {
    console.error("[cloud] WebSocket error:", err.message);
  });
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    send({ type: "heartbeat" });
  }, 30000);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function scheduleReconnect(config) {
  if (reconnectTimer) return;

  // Add jitter: ±25% of current delay
  const jitter = reconnectDelay * 0.25 * (Math.random() * 2 - 1);
  const delay = Math.min(reconnectDelay + jitter, MAX_RECONNECT_DELAY);

  console.log(`[cloud] Reconnecting in ${Math.round(delay / 1000)}s...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    connect(config, onMessage);
  }, delay);
}

function disconnect() {
  stopHeartbeat();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.close(1000, "Client shutdown");
    ws = null;
  }
}

function isConnected() {
  return ws && ws.readyState === WebSocket.OPEN;
}

module.exports = { connect, send, disconnect, isConnected };
