#!/usr/bin/env node
/**
 * Record CLI — add, supersede, and list conversation record entries.
 *
 * Usage:
 *   node record.js add --type decision --summary "All agents use MCP" --details "..." --refs 1,2
 *   node record.js add --type preference --summary "Use Opus for hard tasks"
 *   node record.js supersede 3 --by 7
 *   node record.js list                          # all active entries
 *   node record.js list --type decision           # active decisions only
 *   node record.js list --all                     # include superseded
 *   node record.js get 5                          # full entry with details
 *   node record.js briefing                       # decision recall document
 */

const db = require("./db");
const embedder = require("./embed");

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(`Usage:
  record add --type TYPE --summary "..." [--details "..."] [--refs 1,2] [--supersedes ID] [--project P] [--session S]
  record supersede OLD_ID --by NEW_ID
  record list [--type TYPE] [--all] [--project P]
  record get ID
  record briefing [--project P]

Types: user-input, decision, preference, correction, discovery, bug, design, state`);
    process.exit(0);
  }

  if (cmd === "add") {
    await cmdAdd(args.slice(1));
  } else if (cmd === "supersede") {
    cmdSupersede(args.slice(1));
  } else if (cmd === "list") {
    cmdList(args.slice(1));
  } else if (cmd === "get") {
    cmdGet(args.slice(1));
  } else if (cmd === "briefing") {
    cmdBriefing(args.slice(1));
  } else {
    console.error(`Unknown command: ${cmd}`);
    process.exit(1);
  }

  db.closeDb();
}

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
      flags[key] = val;
    } else {
      flags._positional = flags._positional || [];
      flags._positional.push(args[i]);
    }
  }
  return flags;
}

async function cmdAdd(args) {
  const f = parseFlags(args);

  if (!f.type || !f.summary) {
    console.error("Required: --type and --summary");
    process.exit(1);
  }

  const validTypes = ["user-input", "decision", "preference", "correction", "discovery", "bug", "design", "state"];
  if (!validTypes.includes(f.type)) {
    console.error(`Invalid type: ${f.type}. Valid: ${validTypes.join(", ")}`);
    process.exit(1);
  }

  const refs = f.refs ? f.refs.split(",").map(Number) : null;
  const supersedes = f.supersedes ? Number(f.supersedes) : null;

  const entry = db.addRecord({
    type: f.type,
    summary: f.summary,
    details: f.details || null,
    refs,
    supersedes,
    project: f.project || null,
    session: f.session || null,
  });

  // Try to embed the summary
  try {
    const vec = await embedder.embed(entry.summary);
    if (vec) {
      db.updateEmbedding("record", entry.id, vec);
    }
  } catch {
    // Embedding not available, skip silently
  }

  console.log(`Recorded [${entry.id}] ${entry.type}: ${entry.summary}`);
  if (supersedes) {
    console.log(`  (supersedes entry ${supersedes})`);
  }
}

function cmdSupersede(args) {
  const f = parseFlags(args);
  const oldId = Number(f._positional?.[0]);
  const newId = Number(f.by);

  if (!oldId || !newId) {
    console.error("Usage: record supersede OLD_ID --by NEW_ID");
    process.exit(1);
  }

  db.supersedeRecord(oldId, newId);
  console.log(`Entry ${oldId} superseded by ${newId}`);
}

function cmdList(args) {
  const f = parseFlags(args);
  const entries = db.listRecords({
    type: f.type || null,
    status: f.all ? null : "active",
    project: f.project || null,
  });

  if (entries.length === 0) {
    console.log("No entries found.");
    return;
  }

  for (const e of entries) {
    const status = e.status === "superseded" ? " [SUPERSEDED]" : "";
    const refs = e.refs ? ` refs:${e.refs}` : "";
    console.log(`[${e.id}] ${e.type}${status}: ${e.summary}${refs}`);
  }
  console.log(`\n${entries.length} entries`);
}

function cmdGet(args) {
  const id = Number(args[0]);
  if (!id) {
    console.error("Usage: record get ID");
    process.exit(1);
  }

  const entry = db.getRecord(id);
  if (!entry) {
    console.error(`Entry ${id} not found`);
    process.exit(1);
  }

  console.log(`[${entry.id}] ${entry.type} (${entry.status})`);
  console.log(`Summary: ${entry.summary}`);
  if (entry.details) console.log(`Details:\n${entry.details}`);
  if (entry.refs) console.log(`Refs: ${entry.refs}`);
  if (entry.superseded_by) console.log(`Superseded by: ${entry.superseded_by}`);
  console.log(`Recorded: ${new Date(entry.ts).toISOString()}`);
  if (entry.session) console.log(`Session: ${entry.session}`);
  if (entry.project) console.log(`Project: ${entry.project}`);
}

function cmdBriefing(args) {
  const f = parseFlags(args);
  const entries = db.activeRecords(f.project || null);

  if (entries.length === 0) {
    console.log("No active record entries.");
    return;
  }

  // Group by type
  const grouped = {};
  for (const e of entries) {
    if (!grouped[e.type]) grouped[e.type] = [];
    grouped[e.type].push(e);
  }

  const typeLabels = {
    "preference": "Preferences",
    "correction": "Corrections",
    "decision": "Active Decisions",
    "user-input": "User Requirements",
    "discovery": "Discoveries",
    "bug": "Known Bugs",
    "design": "Design Decisions",
    "state": "Current State",
  };

  // Preferred display order
  const order = ["preference", "correction", "state", "decision", "design", "user-input", "discovery", "bug"];

  console.log("# Decision Recall\n");
  for (const type of order) {
    if (!grouped[type]) continue;
    console.log(`## ${typeLabels[type] || type}\n`);
    for (const e of grouped[type]) {
      console.log(`- [${e.id}] ${e.summary}`);
    }
    console.log();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
