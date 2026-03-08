/**
 * Memory database — SQLite storage for conversation record + turn chunks.
 *
 * Location: ~/Library/Application Support/com.klaudii/memory.db
 */

const Database = require("better-sqlite3");
const path = require("path");
const os = require("os");
const fs = require("fs");

const DB_DIR = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "com.klaudii"
);
const DB_PATH = path.join(DB_DIR, "memory.db");

let _db = null;

function getDb() {
  if (_db) return _db;
  fs.mkdirSync(DB_DIR, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  migrate(_db);
  return _db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS record (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      session TEXT,
      project TEXT,
      type TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      superseded_by INTEGER REFERENCES record(id),
      refs TEXT,
      summary TEXT NOT NULL,
      details TEXT,
      embedding BLOB
    );

    CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      session TEXT,
      project TEXT,
      user_text TEXT,
      agent_text TEXT,
      summary TEXT,
      record_ids TEXT,
      embedding BLOB
    );

    CREATE INDEX IF NOT EXISTS idx_record_status ON record(status);
    CREATE INDEX IF NOT EXISTS idx_record_type ON record(type);
    CREATE INDEX IF NOT EXISTS idx_record_project ON record(project);
    CREATE INDEX IF NOT EXISTS idx_turns_project ON turns(project);
    CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session);
  `);
}

// --- Record CRUD ---

function addRecord({ type, summary, details, refs, supersedes, project, session, ts }) {
  const db = getDb();
  const now = ts || Date.now();

  if (supersedes) {
    db.prepare("UPDATE record SET status = 'superseded', superseded_by = ? WHERE id = ?")
      .run(null, supersedes); // superseded_by gets set after insert
  }

  const result = db.prepare(`
    INSERT INTO record (ts, session, project, type, summary, details, refs)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(now, session || null, project || null, type, summary, details || null, refs ? JSON.stringify(refs) : null);

  const newId = result.lastInsertRowid;

  if (supersedes) {
    db.prepare("UPDATE record SET superseded_by = ? WHERE id = ?").run(newId, supersedes);
  }

  return { id: Number(newId), ts: now, type, summary };
}

function supersedeRecord(oldId, newId) {
  const db = getDb();
  db.prepare("UPDATE record SET status = 'superseded', superseded_by = ? WHERE id = ?").run(newId, oldId);
}

function getRecord(id) {
  return getDb().prepare("SELECT * FROM record WHERE id = ?").get(id);
}

function listRecords({ type, status, project, limit } = {}) {
  const db = getDb();
  let sql = "SELECT * FROM record WHERE 1=1";
  const params = [];

  if (status) {
    sql += " AND status = ?";
    params.push(status);
  }
  if (type) {
    sql += " AND type = ?";
    params.push(type);
  }
  if (project) {
    sql += " AND project = ?";
    params.push(project);
  }

  sql += " ORDER BY ts ASC";

  if (limit) {
    sql += " LIMIT ?";
    params.push(limit);
  }

  return db.prepare(sql).all(...params);
}

function activeRecords(project) {
  return listRecords({ status: "active", project });
}

// --- Turn CRUD ---

function addTurn({ ts, session, project, user_text, agent_text, summary, record_ids, embedding }) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO turns (ts, session, project, user_text, agent_text, summary, record_ids, embedding)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ts || Date.now(),
    session || null,
    project || null,
    user_text || null,
    agent_text || null,
    summary || null,
    record_ids ? JSON.stringify(record_ids) : null,
    embedding || null
  );
  return { id: Number(result.lastInsertRowid) };
}

function getTurn(id) {
  return getDb().prepare("SELECT * FROM turns WHERE id = ?").get(id);
}

function recentTurns({ project, session, limit = 50 } = {}) {
  const db = getDb();
  let sql = "SELECT * FROM turns WHERE 1=1";
  const params = [];

  if (project) {
    sql += " AND project = ?";
    params.push(project);
  }
  if (session) {
    sql += " AND session = ?";
    params.push(session);
  }

  sql += " ORDER BY ts DESC LIMIT ?";
  params.push(limit);

  return db.prepare(sql).all(...params).reverse();
}

// --- Embedding search ---

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB) || 1);
}

function blobToFloat32(blob) {
  if (!blob) return null;
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

function float32ToBlob(arr) {
  return Buffer.from(arr.buffer);
}

/**
 * Search both record and turns tables by embedding similarity.
 * Returns top-N results across both tables, sorted by similarity.
 */
function semanticSearch(queryEmbedding, { project, topN = 10, minSimilarity = 0.1 } = {}) {
  const db = getDb();
  const results = [];

  // Search record entries
  let recordSql = "SELECT id, type, summary, details, embedding FROM record WHERE status = 'active' AND embedding IS NOT NULL";
  const recordParams = [];
  if (project) {
    recordSql += " AND (project = ? OR project IS NULL)";
    recordParams.push(project);
  }

  for (const row of db.prepare(recordSql).all(...recordParams)) {
    const emb = blobToFloat32(row.embedding);
    if (!emb) continue;
    const sim = cosineSimilarity(queryEmbedding, emb);
    if (sim >= minSimilarity) {
      results.push({ source: "record", id: row.id, type: row.type, summary: row.summary, similarity: sim });
    }
  }

  // Search turns
  let turnsSql = "SELECT id, summary, user_text, embedding FROM turns WHERE embedding IS NOT NULL";
  const turnsParams = [];
  if (project) {
    turnsSql += " AND (project = ? OR project IS NULL)";
    turnsParams.push(project);
  }

  for (const row of db.prepare(turnsSql).all(...turnsParams)) {
    const emb = blobToFloat32(row.embedding);
    if (!emb) continue;
    const sim = cosineSimilarity(queryEmbedding, emb);
    if (sim >= minSimilarity) {
      const preview = row.summary || (row.user_text ? row.user_text.slice(0, 120) : "");
      results.push({ source: "turn", id: row.id, summary: preview, similarity: sim });
    }
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, topN);
}

function updateEmbedding(table, id, embedding) {
  const db = getDb();
  const blob = float32ToBlob(embedding);
  db.prepare(`UPDATE ${table} SET embedding = ? WHERE id = ?`).run(blob, id);
}

function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

module.exports = {
  getDb,
  DB_PATH,
  // Record
  addRecord,
  supersedeRecord,
  getRecord,
  listRecords,
  activeRecords,
  // Turns
  addTurn,
  getTurn,
  recentTurns,
  // Embedding
  semanticSearch,
  updateEmbedding,
  float32ToBlob,
  blobToFloat32,
  cosineSimilarity,
  closeDb,
};
