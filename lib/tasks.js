// SQLite-backed task management — replaces tasks/Dolt/bd CLI.
//
// DB location: ~/Library/Application Support/com.klaudii/klaudii.db
// Schema: tasks + task_comments + task_deps
// Task IDs are integer autoincrement.

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const lifecycle = require("./lifecycle");

const DB_DIR = path.join(require("os").homedir(), "Library", "Application Support", "com.klaudii");
const DB_PATH = path.join(DB_DIR, "klaudii.db");

let _db = null;

function getDb() {
  if (_db) return _db;

  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  // Check if we need to migrate from text IDs to integer IDs
  const tableInfo = _db.pragma("table_info(tasks)");
  const idCol = tableInfo.find(c => c.name === "id");
  const needsMigration = idCol && idCol.type === "TEXT";

  if (needsMigration) {
    migrateToIntegerIds(_db);
  } else {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'open',
        priority INTEGER DEFAULT 2,
        difficulty TEXT DEFAULT 'hard',
        type TEXT DEFAULT 'task',
        assignee TEXT,
        project TEXT,
        close_reason TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        closed_at DATETIME
      );

      CREATE TABLE IF NOT EXISTS task_comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks(id),
        author TEXT,
        body TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS task_deps (
        task_id INTEGER NOT NULL REFERENCES tasks(id),
        depends_on INTEGER NOT NULL REFERENCES tasks(id),
        PRIMARY KEY (task_id, depends_on)
      );
    `);
  }

  return _db;
}

// Migrate existing DB from text IDs (klaudii-abc) to integer autoincrement.
function migrateToIntegerIds(db) {
  console.log("[tasks] migrating from text IDs to integer IDs...");

  // Disable FK checks during migration
  db.pragma("foreign_keys = OFF");

  db.exec(`
    CREATE TABLE tasks_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'open',
      priority INTEGER DEFAULT 2,
      difficulty TEXT DEFAULT 'hard',
      type TEXT DEFAULT 'task',
      assignee TEXT,
      project TEXT,
      close_reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      closed_at DATETIME
    );

    INSERT INTO tasks_new (title, description, status, priority, difficulty, type, assignee, project, close_reason, created_at, updated_at, closed_at)
    SELECT title, description, status, priority, difficulty, type, assignee, project, close_reason, created_at, updated_at, closed_at
    FROM tasks ORDER BY created_at ASC;
  `);

  // Build old text ID → new integer ID mapping
  const oldTasks = db.prepare("SELECT id FROM tasks ORDER BY created_at ASC").all();
  const newTasks = db.prepare("SELECT id FROM tasks_new ORDER BY id ASC").all();
  const idMap = new Map();
  for (let i = 0; i < oldTasks.length; i++) {
    idMap.set(oldTasks[i].id, newTasks[i].id);
  }

  // Migrate comments
  const hasComments = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_comments'").get();
  if (hasComments) {
    db.exec(`
      CREATE TABLE task_comments_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks_new(id),
        author TEXT,
        body TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    const comments = db.prepare("SELECT * FROM task_comments ORDER BY id ASC").all();
    const insertComment = db.prepare("INSERT INTO task_comments_new (task_id, author, body, created_at) VALUES (?, ?, ?, ?)");
    for (const c of comments) {
      const newTaskId = idMap.get(c.task_id);
      if (newTaskId) insertComment.run(newTaskId, c.author, c.body, c.created_at);
    }
    db.exec("DROP TABLE task_comments");
    db.exec("ALTER TABLE task_comments_new RENAME TO task_comments");
  } else {
    db.exec(`
      CREATE TABLE task_comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks(id),
        author TEXT,
        body TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  // Migrate deps
  const hasDeps = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_deps'").get();
  if (hasDeps) {
    db.exec(`
      CREATE TABLE task_deps_new (
        task_id INTEGER NOT NULL REFERENCES tasks_new(id),
        depends_on INTEGER NOT NULL REFERENCES tasks_new(id),
        PRIMARY KEY (task_id, depends_on)
      );
    `);
    const deps = db.prepare("SELECT * FROM task_deps").all();
    const insertDep = db.prepare("INSERT OR IGNORE INTO task_deps_new (task_id, depends_on) VALUES (?, ?)");
    for (const d of deps) {
      const newTaskId = idMap.get(d.task_id);
      const newDepId = idMap.get(d.depends_on);
      if (newTaskId && newDepId) insertDep.run(newTaskId, newDepId);
    }
    db.exec("DROP TABLE task_deps");
    db.exec("ALTER TABLE task_deps_new RENAME TO task_deps");
  } else {
    db.exec(`
      CREATE TABLE task_deps (
        task_id INTEGER NOT NULL REFERENCES tasks(id),
        depends_on INTEGER NOT NULL REFERENCES tasks(id),
        PRIMARY KEY (task_id, depends_on)
      );
    `);
  }

  db.exec("DROP TABLE tasks");
  db.exec("ALTER TABLE tasks_new RENAME TO tasks");
  db.pragma("foreign_keys = ON");

  console.log(`[tasks] migrated ${idMap.size} tasks to integer IDs`);
}

// --- Core CRUD ---

function create({ title, description, priority, difficulty, type, project }) {
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO tasks (title, description, priority, difficulty, type, project)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(title, description || null, priority ?? 2, difficulty || "hard", type || "task", project || null);
  return get(info.lastInsertRowid);
}

function get(id) {
  const db = getDb();
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  if (!task) return null;
  task.comments = getComments(id);
  return task;
}

function list(filters = {}) {
  const db = getDb();
  const where = [];
  const params = [];

  if (filters.status) { where.push("status = ?"); params.push(filters.status); }
  if (filters.project) { where.push("project = ?"); params.push(filters.project); }
  if (filters.priority !== undefined) { where.push("priority = ?"); params.push(filters.priority); }
  if (filters.assignee) { where.push("assignee = ?"); params.push(filters.assignee); }
  if (filters.type) { where.push("type = ?"); params.push(filters.type); }

  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM tasks ${clause} ORDER BY priority ASC, created_at DESC`).all(...params);
}

function update(id, fields) {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  if (!existing) return null;

  if (fields.status && fields.status !== existing.status) {
    lifecycle.warnIfInvalid(id, existing.status, fields.status);
  }

  const allowed = ["title", "description", "status", "priority", "difficulty", "type", "assignee", "project", "close_reason"];
  const sets = [];
  const params = [];

  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      params.push(fields[key]);
    }
  }

  if (fields.status === "closed" && !existing.closed_at) {
    sets.push("closed_at = CURRENT_TIMESTAMP");
  }

  if (sets.length === 0) return get(id);

  sets.push("updated_at = CURRENT_TIMESTAMP");
  params.push(id);

  db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return get(id);
}

function close(id, reason) {
  return update(id, { status: "closed", close_reason: reason || "Done" });
}

function remove(id) {
  const db = getDb();
  db.prepare("DELETE FROM task_comments WHERE task_id = ?").run(id);
  db.prepare("DELETE FROM task_deps WHERE task_id = ? OR depends_on = ?").run(id, id);
  db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
}

// --- Comments ---

function addComment(taskId, { author, body }) {
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO task_comments (task_id, author, body) VALUES (?, ?, ?)
  `).run(taskId, author || null, body);
  db.prepare("UPDATE tasks SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(taskId);
  return db.prepare("SELECT * FROM task_comments WHERE id = ?").get(info.lastInsertRowid);
}

function getComments(taskId) {
  const db = getDb();
  return db.prepare("SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC").all(taskId);
}

// --- Dependencies ---

function addDep(taskId, dependsOnId) {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO task_deps (task_id, depends_on) VALUES (?, ?)").run(taskId, dependsOnId);
}

function removeDep(taskId, dependsOnId) {
  const db = getDb();
  db.prepare("DELETE FROM task_deps WHERE task_id = ? AND depends_on = ?").run(taskId, dependsOnId);
}

function getDeps(taskId) {
  const db = getDb();
  return db.prepare(`
    SELECT t.* FROM tasks t
    JOIN task_deps d ON d.depends_on = t.id
    WHERE d.task_id = ?
  `).all(taskId);
}

// --- Queries ---

function ready(filters = {}) {
  const db = getDb();
  // Tasks that are open, unassigned, and have no unmet dependencies
  const where = ["t.status = 'open'", "t.assignee IS NULL"];
  const params = [];

  if (filters.project) { where.push("t.project = ?"); params.push(filters.project); }

  return db.prepare(`
    SELECT t.* FROM tasks t
    WHERE ${where.join(" AND ")}
    AND NOT EXISTS (
      SELECT 1 FROM task_deps d
      JOIN tasks dep ON dep.id = d.depends_on
      WHERE d.task_id = t.id AND dep.status != 'closed'
    )
    ORDER BY t.priority ASC, t.created_at ASC
  `).all(...params);
}

// --- Import/Export ---

function importFromJSONL(filePath) {
  if (!fs.existsSync(filePath)) return 0;

  const db = getDb();
  const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
  let count = 0;

  const insertTask = db.prepare(`
    INSERT INTO tasks (title, description, status, priority, difficulty, type, assignee, project, close_reason, created_at, updated_at, closed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }

      insertTask.run(
        entry.title || "(untitled)",
        entry.description || null,
        entry.status || "open",
        entry.priority ?? 2,
        entry.difficulty || "hard",
        entry.issue_type || entry.type || "task",
        entry.assignee || null,
        entry.project || null,
        entry.close_reason || null,
        entry.created_at || new Date().toISOString(),
        entry.updated_at || new Date().toISOString(),
        entry.closed_at || null
      );
      count++;
    }
  });

  tx();
  return count;
}

function exportToJSONL(filePath) {
  const db = getDb();
  const allTasks = db.prepare("SELECT * FROM tasks ORDER BY id ASC").all();
  const lines = allTasks.map((t) => JSON.stringify(t));
  fs.writeFileSync(filePath, lines.join("\n") + "\n");
  return allTasks.length;
}

// --- Lifecycle ---

function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// Auto-import from JSONL on first use if DB is empty
function autoImport() {
  return 0;
}

/**
 * Initialize the DB with a custom path (for tests).
 * Closes any existing connection and opens a new one.
 */
function initDb(dbPath) {
  closeDb();
  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'open',
      priority INTEGER DEFAULT 2,
      difficulty TEXT DEFAULT 'hard',
      type TEXT DEFAULT 'task',
      assignee TEXT,
      project TEXT,
      close_reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      closed_at DATETIME
    );
    CREATE TABLE IF NOT EXISTS task_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id),
      author TEXT,
      body TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS task_deps (
      task_id INTEGER NOT NULL REFERENCES tasks(id),
      depends_on INTEGER NOT NULL REFERENCES tasks(id),
      PRIMARY KEY (task_id, depends_on)
    );
  `);
  return _db;
}

// Initialize on require
autoImport();

module.exports = {
  create,
  get,
  list,
  update,
  close,
  remove,
  addComment,
  getComments,
  addDep,
  removeDep,
  getDeps,
  ready,
  importFromJSONL,
  exportToJSONL,
  closeDb,
  getDb,
  initDb,
};
