// Browser-side E2E encryption and WebSocket tunnel for Klaudii Cloud Connect
// Uses Web Crypto API — no dependencies

let tunnelWs = null;
let connectionKeyRaw = null; // Uint8Array (32 bytes)
let pendingRequests = new Map(); // requestId → { resolve, reject, timeout }
let tunnelReady = false;

// --- Crypto (Web Crypto API) ---

async function deriveSessionKey(sharedSecret, salt) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw", sharedSecret, "HKDF", false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("klaudii-e2e") },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptPayload(data) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveSessionKey(connectionKeyRaw, salt);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(typeof data === "string" ? data : JSON.stringify(data));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);

  // Pack: iv(12) + authTag is included in encrypted output by Web Crypto
  const encryptedArray = new Uint8Array(encrypted);
  const combined = new Uint8Array(iv.length + encryptedArray.length);
  combined.set(iv);
  combined.set(encryptedArray, iv.length);

  return {
    salt: btoa(String.fromCharCode(...salt)),
    data: btoa(String.fromCharCode(...combined)),
  };
}

async function decryptPayload(envelope) {
  const salt = Uint8Array.from(atob(envelope.salt), c => c.charCodeAt(0));
  const combined = Uint8Array.from(atob(envelope.data), c => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  const key = await deriveSessionKey(connectionKeyRaw, salt);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(decrypted);
}

// --- WebSocket Tunnel ---

function initCloudTunnel(serverId, connectionKeyHex, userId) {
  // Convert hex key to Uint8Array
  connectionKeyRaw = new Uint8Array(connectionKeyHex.match(/.{2}/g).map(b => parseInt(b, 16)));

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/ws?role=browser&serverId=${encodeURIComponent(serverId)}&userId=${encodeURIComponent(userId)}`;

  tunnelWs = new WebSocket(wsUrl);

  tunnelWs.onopen = () => {
    console.log("[cloud] Tunnel connected");
  };

  tunnelWs.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.type === "server_status") {
      tunnelReady = msg.online;
      if (tunnelReady) {
        // Load the dashboard in the iframe, but with cloud transport
        loadCloudDashboard();
      }
      return;
    }

    if (msg.type === "api_response") {
      const pending = pendingRequests.get(msg.requestId);
      if (!pending) return;
      pendingRequests.delete(msg.requestId);
      clearTimeout(pending.timeout);

      if (msg.error) {
        if (msg.error === "wrong_key") {
          // Server couldn't decrypt — our stored key is stale. Clear it and redirect to pair.
          const keys = JSON.parse(localStorage.getItem("klaudii-connection-keys") || "{}");
          if (currentServerId) delete keys[currentServerId];
          localStorage.setItem("klaudii-connection-keys", JSON.stringify(keys));
          window.location.href = `/pair.html?serverId=${currentServerId}`;
          return;
        }
        pending.reject(new Error(msg.error));
        return;
      }

      try {
        const decrypted = await decryptPayload(msg.encrypted);
        pending.resolve(JSON.parse(decrypted));
      } catch (err) {
        pending.reject(err);
      }
      return;
    }
  };

  tunnelWs.onclose = () => {
    console.log("[cloud] Tunnel disconnected");
    tunnelReady = false;
    // Reject all pending requests
    for (const [id, pending] of pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Tunnel disconnected"));
    }
    pendingRequests.clear();
  };

  tunnelWs.onerror = (err) => {
    console.error("[cloud] Tunnel error:", err);
  };
}

function disconnectCloudTunnel() {
  if (tunnelWs) {
    tunnelWs.close();
    tunnelWs = null;
  }
  tunnelReady = false;
  connectionKeyRaw = null;
  pendingRequests.clear();
}

// Send an encrypted API request through the tunnel
async function cloudApi(path, opts = {}) {
  if (!tunnelWs || tunnelWs.readyState !== WebSocket.OPEN) {
    throw new Error("Cloud tunnel not connected");
  }

  const requestId = crypto.randomUUID();
  const payload = {
    method: opts.method || "GET",
    path,
    body: opts.body || null,
  };

  const encrypted = await encryptPayload(JSON.stringify(payload));

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error("Request timeout"));
    }, 30000);

    pendingRequests.set(requestId, { resolve, reject, timeout });

    tunnelWs.send(JSON.stringify({
      type: "api_request",
      requestId,
      encrypted,
    }));
  });
}

// Load the Klaudii dashboard in the iframe with cloud transport injected
function loadCloudDashboard() {
  const frame = document.getElementById("dashboard-frame");

  // We serve the same dashboard files at /dashboard/
  // But we need to intercept the API calls inside the iframe
  frame.src = "/dashboard/index.html";

  frame.onload = () => {
    try {
      const frameWindow = frame.contentWindow;

      // Override the api() function inside the iframe to use our cloud tunnel
      frameWindow.eval(`
        // Cloud mode: override the api function to use parent's cloud tunnel
        const originalApi = window.api;
        window.api = async function cloudApiOverride(path, opts = {}) {
          return window.parent.cloudApi(path, opts);
        };

        // Signal that we're in cloud mode
        window.KLAUDII_CLOUD_MODE = true;

        // Re-trigger refresh with the cloud transport
        if (window.refresh) window.refresh();
      `);
    } catch (err) {
      console.error("[cloud] Failed to inject cloud transport:", err);
    }
  };
}
