const WebSocket = require("ws");
const wsClient = require("./ws-client");
const clientCrypto = require("./crypto");
const pairing = require("./pairing");
const http = require("http");

let localPort = 9876;

function init(app, config) {
  localPort = Number(process.env.PORT || config.port || 9876);

  // Add cloud API routes to the local Klaudii server
  setupRoutes(app);

  // If cloud is configured, connect to relay
  if (config.cloud && config.cloud.relayUrl && config.cloud.serverId) {
    clientCrypto.setConnectionKey(config.cloud.connectionKey);
    wsClient.connect(config, handleRelayMessage, closeAllLocalChannels);
    console.log(`[cloud] Connecting to relay at ${config.cloud.relayUrl}`);
  } else {
    console.log("[cloud] Not configured — run pairing to enable cloud access");
  }
}

// Active proxied WebSocket channels: channelId → WebSocket
const localChannels = new Map();

function handleRelayMessage(msg) {
  if (msg.type === "api_request") {
    handleApiRequest(msg)
      .catch((err) => console.error("[cloud] handleApiRequest unhandled:", err.message));
    return;
  }

  if (msg.type === "ws_connect") {
    handleWsConnect(msg)
      .catch((err) => console.error("[cloud] handleWsConnect unhandled:", err.message));
    return;
  }

  if (msg.type === "ws_message") {
    const localWs = localChannels.get(msg.channelId);
    if (localWs && localWs.readyState === WebSocket.OPEN) {
      try {
        const { data } = JSON.parse(clientCrypto.decryptPayload(msg.encrypted));
        localWs.send(data);
      } catch (err) {
        console.error(`[cloud] ws_message decrypt error (channel ${msg.channelId}):`, err.message);
      }
    }
    return;
  }

  if (msg.type === "ws_close") {
    const localWs = localChannels.get(msg.channelId);
    if (localWs) {
      localWs.close();
      localChannels.delete(msg.channelId);
    }
    return;
  }
}

function closeAllLocalChannels() {
  for (const [, localWs] of localChannels) {
    localWs.close();
  }
  localChannels.clear();
}

async function handleWsConnect(msg) {
  const { channelId } = msg;
  let path;
  try {
    ({ path } = JSON.parse(clientCrypto.decryptPayload(msg.encrypted)));
  } catch (err) {
    console.error(`[cloud] ws_connect decrypt error (channel ${channelId}):`, err.message);
    wsClient.send({ type: "ws_close", channelId });
    return;
  }

  const localUrl = `ws://127.0.0.1:9876${path}`;
  const localWs = new WebSocket(localUrl);
  localChannels.set(channelId, localWs);

  localWs.on("open", () => {
    const encrypted = clientCrypto.encryptPayload(JSON.stringify({ ok: true }));
    wsClient.send({ type: "ws_connected", channelId, encrypted });
  });

  localWs.on("message", (raw) => {
    const data = raw instanceof Buffer ? raw.toString() : raw;
    const encrypted = clientCrypto.encryptPayload(JSON.stringify({ data }));
    wsClient.send({ type: "ws_message", channelId, encrypted });
  });

  localWs.on("close", () => {
    localChannels.delete(channelId);
    wsClient.send({ type: "ws_close", channelId });
  });

  localWs.on("error", (err) => {
    console.error(`[cloud] local WS error (channel ${channelId}):`, err.message);
    localChannels.delete(channelId);
    wsClient.send({ type: "ws_close", channelId });
  });
}

async function handleApiRequest(msg) {
  try {
    // Decrypt the request
    const decrypted = JSON.parse(clientCrypto.decryptPayload(msg.encrypted));
    const { method, path, body } = decrypted;

    // Make a local HTTP request to our own Express server
    const response = await localRequest(method, path, body);

    // Encrypt just the response body (browser's api() expects the raw JSON body)
    const encrypted = clientCrypto.encryptPayload(JSON.stringify(response.body ?? response));

    // Send back through relay
    wsClient.send({
      type: "api_response",
      requestId: msg.requestId,
      encrypted,
    });
  } catch (err) {
    console.error("[cloud] API request error:", err.message);

    // If it looks like a GCM auth failure, the browser has the wrong key — tell it to re-pair
    const isWrongKey = /unable to authenticate|unsupported state/i.test(err.message);
    wsClient.send({
      type: "api_response",
      requestId: msg.requestId,
      error: isWrongKey ? "wrong_key" : "server_error",
    });
  }
}

function localRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "127.0.0.1",
      port: localPort,
      path: urlPath,
      method: method.toUpperCase(),
      headers: { "Content-Type": "application/json" },
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("error", (err) => reject(err));
      res.on("end", () => {
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = data;
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });

    req.on("error", (err) => reject(err));

    if (body && method.toUpperCase() !== "GET") {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

function setupRoutes(app) {
  // Cloud status — is the server paired? Is it connected to the relay?
  app.get("/api/cloud/status", (_req, res) => {
    const status = pairing.getCloudStatus();
    res.json({
      ...status,
      connected: wsClient.isConnected(),
    });
  });

  // Start pairing — user enters the code from connect.klaudii.com
  app.post("/api/cloud/pair", async (req, res) => {
    const { code, relayUrl, serverName } = req.body;
    if (!code) {
      return res.status(400).json({ error: "Pairing code required" });
    }

    const relay = relayUrl || "https://konnect.klaudii.com";
    const name = serverName || require("os").hostname();

    try {
      const result = await pairing.redeemPairingCode(relay, code, name);

      // Set the connection key and connect to relay
      clientCrypto.setConnectionKey(result.connectionKeyHex);

      // Reload config and connect
      const { loadConfig } = require("../../lib/projects");
      const config = loadConfig();
      wsClient.connect(config, handleRelayMessage, closeAllLocalChannels);

      res.json({
        ok: true,
        serverId: result.serverId,
        connectionKey: result.connectionKeyWords,
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Get connection key display (for pairing additional browsers)
  app.get("/api/cloud/connection-key", async (_req, res) => {
    const key = pairing.getConnectionKeyDisplay();
    if (!key) {
      return res.status(404).json({ error: "Not paired" });
    }
    const qr = await pairing.getConnectionKeyQR().catch(() => null);
    res.json({ connectionKey: key, qrSvg: qr });
  });

  // Unpair from cloud
  app.post("/api/cloud/unpair", (_req, res) => {
    wsClient.disconnect();
    pairing.unpair();
    res.json({ ok: true });
  });
}

module.exports = { init };
