// lib/memory.js — Persistent memory/journal for Architect and Shepherd agents
//
// SQLite database at ~/.klaudii/memory.sqlite
// Uses better-sqlite3 for synchronous, fast access.

const path = require("path");
const fs = require("fs");
const { DATA_DIR } = require("./paths");

const DB_DIR = DATA_DIR;
const DB_PATH = path.join(DB_DIR, "memory.sqlite");

let db = null;

function getDb() {
  if (db) return db;
  try {
    fs.mkdirSync(DB_DIR, { recursive: true });
  } catch {}
  try {
    const Database = require("better-sqlite3");
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    initSchema(db);
    return db;
  } catch (err) {
    console.error("[memory] Failed to open database:", err.message);
    return null;
  }
}

function initSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      workspace TEXT,
      content TEXT NOT NULL,
      category TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      session_id TEXT
    );

    CREATE TABLE IF NOT EXISTS memory_metadata (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent);
    CREATE INDEX IF NOT EXISTS idx_memories_agent_workspace ON memories(agent, workspace);
  `);
}

// Store a new memory
function store(agent, { content, category, workspace, session_id }) {
  const database = getDb();
  if (!database) throw new Error("Memory database unavailable");

  const stmt = database.prepare(
    "INSERT INTO memories (agent, content, category, workspace, session_id) VALUES (?, ?, ?, ?, ?)"
  );
  const result = stmt.run(agent, content, category || null, workspace || null, session_id || null);

  // Update metadata
  const countStmt = database.prepare("SELECT COUNT(*) as cnt FROM memories WHERE agent = ?");
  const { cnt } = countStmt.get(agent);
  setMeta(`total_memories_${agent}`, String(cnt));

  return { id: result.lastInsertRowid, agent, content, category, workspace, session_id };
}

// Get recent memories for an agent
function list(agent, { limit = 50, workspace } = {}) {
  const database = getDb();
  if (!database) return [];

  const safeLimit = Math.min(Math.max(1, Number(limit) || 50), 500);

  if (workspace) {
    const stmt = database.prepare(
      "SELECT * FROM memories WHERE agent = ? AND (workspace = ? OR workspace IS NULL) ORDER BY id DESC LIMIT ?"
    );
    return stmt.all(agent, workspace, safeLimit);
  }

  const stmt = database.prepare(
    "SELECT * FROM memories WHERE agent = ? ORDER BY id DESC LIMIT ?"
  );
  return stmt.all(agent, safeLimit);
}

// Full-text search memories
function search(agent, query, { limit = 50 } = {}) {
  const database = getDb();
  if (!database) return [];

  const safeLimit = Math.min(Math.max(1, Number(limit) || 50), 500);
  const pattern = `%${query}%`;

  const stmt = database.prepare(
    "SELECT * FROM memories WHERE agent = ? AND content LIKE ? ORDER BY id DESC LIMIT ?"
  );
  return stmt.all(agent, pattern, safeLimit);
}

// Delete a specific memory
function remove(agent, id) {
  const database = getDb();
  if (!database) throw new Error("Memory database unavailable");

  const stmt = database.prepare("DELETE FROM memories WHERE id = ? AND agent = ?");
  const result = stmt.run(id, agent);
  return result.changes > 0;
}

// Metadata helpers
function getMeta(key) {
  const database = getDb();
  if (!database) return null;
  const row = database.prepare("SELECT value FROM memory_metadata WHERE key = ?").get(key);
  return row ? row.value : null;
}

function setMeta(key, value) {
  const database = getDb();
  if (!database) return;
  database.prepare(
    "INSERT OR REPLACE INTO memory_metadata (key, value) VALUES (?, ?)"
  ).run(key, value);
}

// Close database (for graceful shutdown)
function close() {
  if (db) {
    try { db.close(); } catch {}
    db = null;
  }
}

module.exports = { store, list, search, remove, getMeta, setMeta, close, DB_PATH };
