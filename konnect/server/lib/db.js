const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const { generateId } = require("../../shared/crypto");

let db;

function init(dbPath) {
  db = new Database(dbPath || path.join(__dirname, "..", "relay.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Run migrations
  const migrationsDir = path.join(__dirname, "..", "migrations");
  const files = fs.readdirSync(migrationsDir).sort();
  for (const file of files) {
    if (file.endsWith(".sql")) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      db.exec(sql);
    }
  }
}

// --- Users ---

function createUser(googleId, email, name) {
  const id = generateId();
  db.prepare("INSERT INTO users (id, google_id, email, name) VALUES (?, ?, ?, ?)").run(id, googleId, email, name);
  return { id, googleId, email, name };
}

function getUserByGoogleId(googleId) {
  return db.prepare("SELECT * FROM users WHERE google_id = ?").get(googleId);
}

function getUserById(id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}

function upsertUser(googleId, email, name) {
  const existing = getUserByGoogleId(googleId);
  if (existing) {
    db.prepare("UPDATE users SET email = ?, name = ? WHERE google_id = ?").run(email, name, googleId);
    return { ...existing, email, name };
  }
  return createUser(googleId, email, name);
}

// --- Servers ---

function registerServer(userId, name, publicKey) {
  const id = generateId();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    "INSERT INTO servers (id, user_id, name, ed25519_public_key, last_seen, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, userId, name, publicKey, now, now);
  return { id, userId, name, publicKey };
}

function getServerById(id) {
  return db.prepare("SELECT * FROM servers WHERE id = ?").get(id);
}

function getServersByUser(userId) {
  return db.prepare("SELECT * FROM servers WHERE user_id = ? ORDER BY created_at DESC").all(userId);
}

function updateServerLastSeen(serverId) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare("UPDATE servers SET last_seen = ? WHERE id = ?").run(now, serverId);
}

function removeServer(serverId, userId) {
  const result = db.prepare("DELETE FROM servers WHERE id = ? AND user_id = ?").run(serverId, userId);
  return result.changes > 0;
}

// --- Pairing Codes ---

function createPairingCode(code, userId, ttlSeconds = 600) {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  db.prepare("INSERT INTO pairing_codes (code, user_id, expires_at) VALUES (?, ?, ?)").run(code, userId, expiresAt);
  return { code, userId, expiresAt };
}

function consumePairingCode(code) {
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare("SELECT * FROM pairing_codes WHERE code = ? AND used = 0 AND expires_at > ?").get(code, now);
  if (!row) return null;
  db.prepare("UPDATE pairing_codes SET used = 1 WHERE code = ?").run(code);
  return row;
}

function cleanExpiredPairingCodes() {
  const now = Math.floor(Date.now() / 1000);
  db.prepare("DELETE FROM pairing_codes WHERE expires_at < ? OR used = 1").run(now);
}

module.exports = {
  init,
  upsertUser,
  getUserById,
  getUserByGoogleId,
  registerServer,
  getServerById,
  getServersByUser,
  updateServerLastSeen,
  removeServer,
  createPairingCode,
  consumePairingCode,
  cleanExpiredPairingCodes,
};
