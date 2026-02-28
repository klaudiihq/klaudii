const { generateSigningKeypair, generateConnectionKey, connectionKeyToWords } = require("../shared/crypto");
const QRCode = require("qrcode");
const { loadConfig, saveConfig } = require("../../lib/projects");

async function redeemPairingCode(relayBaseUrl, code, serverName) {
  // Generate Ed25519 signing keypair for server authentication
  const keypair = generateSigningKeypair();

  // Generate the Connection Key (256-bit secret for E2E encryption)
  const connectionKeyBuf = generateConnectionKey();
  const connectionKeyHex = connectionKeyBuf.toString("hex");
  const connectionKeyWords = connectionKeyToWords(connectionKeyBuf);

  // Normalize the code
  const normalized = code.replace(/\s/g, "").toUpperCase();

  // Send to relay to redeem the pairing code
  const resp = await fetch(`${relayBaseUrl}/api/pairing/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: normalized,
      name: serverName,
      publicKey: keypair.publicKey,
    }),
  });

  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.error || `Pairing failed: ${resp.status}`);
  }

  const { serverId, relayUrl } = await resp.json();

  // Store cloud config
  const config = loadConfig();
  config.cloud = {
    relayUrl,
    serverId,
    serverName,
    signingKey: keypair.privateKey,
    publicKey: keypair.publicKey,
    connectionKey: connectionKeyHex,
    pairedAt: Date.now(),
  };
  saveConfig(config);

  return {
    serverId,
    relayUrl,
    connectionKeyWords,
    connectionKeyHex,
  };
}

function getCloudStatus() {
  const config = loadConfig();
  if (!config.cloud) {
    return { paired: false };
  }
  return {
    paired: true,
    serverId: config.cloud.serverId,
    serverName: config.cloud.serverName,
    relayUrl: config.cloud.relayUrl,
    pairedAt: config.cloud.pairedAt,
  };
}

function unpair() {
  const config = loadConfig();
  delete config.cloud;
  saveConfig(config);
}

function getConnectionKeyDisplay() {
  const config = loadConfig();
  if (!config.cloud || !config.cloud.connectionKey) {
    return null;
  }
  const buf = Buffer.from(config.cloud.connectionKey, "hex");
  return connectionKeyToWords(buf);
}

function getConnectionKeyQR() {
  const config = loadConfig();
  if (!config.cloud || !config.cloud.connectionKey || !config.cloud.serverId) {
    return null;
  }
  // QR encodes an HTTPS URL so iOS Camera / Android Camera can open it directly.
  // pair.html reads ?serverId + ?key from the URL and auto-stores the connection key.
  const relayBase = (config.cloud.relayUrl || "https://konnect.klaudii.com")
    .replace(/^wss?:\/\//, "https://")
    .replace(/\/ws$/, "")
    .replace(/\/$/, "");
  const payload = `${relayBase}/pair.html?serverId=${config.cloud.serverId}&key=${config.cloud.connectionKey}`;
  // Use qrcode package — battle-tested, correct QR generation
  return QRCode.toString(payload, { type: "svg", margin: 2, color: { dark: "#000000", light: "#ffffff" } });
}

module.exports = { redeemPairingCode, getCloudStatus, unpair, getConnectionKeyDisplay, getConnectionKeyQR };
