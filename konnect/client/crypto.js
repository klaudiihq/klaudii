const { encrypt, decrypt, deriveKey } = require("../shared/crypto");
const crypto = require("crypto");

let connectionKey = null; // 32-byte Buffer

function setConnectionKey(key) {
  if (typeof key === "string") {
    connectionKey = Buffer.from(key, "hex");
  } else {
    connectionKey = key;
  }
}

function getConnectionKey() {
  return connectionKey;
}

function encryptPayload(data) {
  if (!connectionKey) throw new Error("Connection key not set");

  // Generate a random salt for this message
  const salt = crypto.randomBytes(16);
  const sessionKey = Buffer.from(deriveKey(connectionKey, salt));
  const encrypted = encrypt(sessionKey, data);

  // Return salt + encrypted data (both base64)
  return {
    salt: salt.toString("base64"),
    data: encrypted,
  };
}

function decryptPayload(envelope) {
  if (!connectionKey) throw new Error("Connection key not set");

  const salt = Buffer.from(envelope.salt, "base64");
  const sessionKey = Buffer.from(deriveKey(connectionKey, salt));
  return decrypt(sessionKey, envelope.data);
}

module.exports = { setConnectionKey, getConnectionKey, encryptPayload, decryptPayload };
