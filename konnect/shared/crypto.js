// Shared cryptographic primitives for Klaudii Kloud Konnector
// Used by both the relay server and connector client (Node.js)
// Browser equivalent uses Web Crypto API (see cloud.js)

const crypto = require("crypto");

// --- AES-256-GCM Encrypt/Decrypt ---

function encrypt(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = typeof plaintext === "string" ? plaintext : JSON.stringify(plaintext);
  const encrypted = Buffer.concat([cipher.update(data, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // iv(12) + ciphertext(N) + tag(16) — matches Web Crypto AES-GCM output layout
  return Buffer.concat([iv, encrypted, tag]).toString("base64");
}

function decrypt(key, payload) {
  const buf = Buffer.from(payload, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16); // tag is last 16 bytes
  const ciphertext = buf.subarray(12, buf.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}

// --- HKDF Key Derivation ---

function deriveKey(sharedSecret, salt, info = "klaudii-e2e") {
  // sharedSecret: 32-byte Buffer or hex string
  const secret = typeof sharedSecret === "string" ? Buffer.from(sharedSecret, "hex") : sharedSecret;
  const saltBuf = typeof salt === "string" ? Buffer.from(salt, "hex") : salt;
  return crypto.hkdfSync("sha256", secret, saltBuf, info, 32);
}

// --- Ed25519 Key Generation ---

function generateSigningKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  return {
    publicKey: publicKey.toString("base64"),
    privateKey: privateKey.toString("base64"),
  };
}

// --- Ed25519 Sign/Verify ---

function sign(privateKeyBase64, data) {
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(privateKeyBase64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const signature = crypto.sign(null, Buffer.from(data), privateKey);
  return signature.toString("base64");
}

function verify(publicKeyBase64, data, signatureBase64) {
  const publicKey = crypto.createPublicKey({
    key: Buffer.from(publicKeyBase64, "base64"),
    format: "der",
    type: "spki",
  });
  return crypto.verify(null, Buffer.from(data), publicKey, Buffer.from(signatureBase64, "base64"));
}

// --- Connection Key Generation ---

function generateConnectionKey() {
  // 256-bit random secret
  return crypto.randomBytes(32);
}

function connectionKeyToWords(keyBuffer) {
  // Simple word encoding: split 256 bits into 12 chunks, map to a word list
  // Using a curated 256-word list (8 bits per word, 12 words = 96 bits of the key displayed)
  // For full security, we encode all 32 bytes as 24 words from a 2048-word list
  // Simplified: use hex encoding grouped into readable chunks
  const hex = keyBuffer.toString("hex");
  // Group into 4-char chunks with dashes: XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX
  return hex.match(/.{4}/g).join("-");
}

function connectionKeyFromWords(words) {
  const hex = words.replace(/-/g, "");
  return Buffer.from(hex, "hex");
}

// --- Pairing Code Generation ---

// Uppercase alphanumeric, no ambiguous chars (0/O, 1/I/L)
const PAIRING_CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

function generatePairingCode() {
  let code = "";
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) {
    code += PAIRING_CHARS[bytes[i] % PAIRING_CHARS.length];
  }
  // Format as XXX-XXX for readability
  return code.slice(0, 3) + "-" + code.slice(3);
}

// --- UUID Generation ---

function generateId() {
  return crypto.randomUUID();
}

module.exports = {
  encrypt,
  decrypt,
  deriveKey,
  generateSigningKeypair,
  sign,
  verify,
  generateConnectionKey,
  connectionKeyToWords,
  connectionKeyFromWords,
  generatePairingCode,
  generateId,
};
