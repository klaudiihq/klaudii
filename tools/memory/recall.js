#!/usr/bin/env node
/**
 * Recall CLI — load full context for specific entries, search semantically.
 *
 * Usage:
 *   node recall.js 1 2 3                    # load entries by ID
 *   node recall.js --search "restart server" # semantic search (requires embeddings)
 *   node recall.js --turn 47                 # load a turn by ID
 *   node recall.js --recent 20              # last 20 turns
 *   node recall.js --sidebar "user message"  # format semantic sidebar for a query
 */

const db = require("./db");
const embedder = require("./embed");

async function main() {
  const args = process.argv.slice(2);

  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    console.log(`Usage:
  recall ID [ID...]                  Load full record entries by ID
  recall --search "query"            Semantic search across records + turns
  recall --sidebar "user message"    Format the semantic sidebar (top-10 relevant)
  recall --turn ID                   Load a specific turn
  recall --recent [N]                Load last N turns (default: 20)
  recall --project P                 Filter by project (combine with other flags)`);
    process.exit(0);
  }

  const flags = parseFlags(args);

  if (flags.search) {
    await cmdSearch(flags);
  } else if (flags.sidebar) {
    await cmdSidebar(flags);
  } else if (flags.turn) {
    cmdTurn(flags);
  } else if (flags.recent !== undefined) {
    cmdRecent(flags);
  } else if (flags._positional?.length) {
    cmdGetIds(flags);
  } else {
    console.error("No command specified. Use --help for usage.");
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

function cmdGetIds(flags) {
  const ids = flags._positional.map(Number);
  for (const id of ids) {
    const entry = db.getRecord(id);
    if (!entry) {
      console.error(`Record ${id} not found`);
      continue;
    }
    console.log(`\n--- [R${entry.id}] ${entry.type} (${entry.status}) ---`);
    console.log(`Summary: ${entry.summary}`);
    if (entry.details) {
      console.log(`Details:\n${entry.details}`);
    }
    if (entry.refs) console.log(`Refs: ${entry.refs}`);
    if (entry.superseded_by) console.log(`Superseded by: ${entry.superseded_by}`);
  }
}

async function cmdSearch(flags) {
  const query = flags.search;
  let vec;
  try {
    vec = await embedder.embed(query);
  } catch (err) {
    console.error(`Embedding not available: ${err.message}`);
    console.error("Falling back to keyword search...");
    keywordSearch(query, flags.project);
    return;
  }

  if (!vec) {
    keywordSearch(query, flags.project);
    return;
  }

  const results = db.semanticSearch(vec, {
    project: flags.project || null,
    topN: Number(flags.top) || 10,
  });

  if (!results.length) {
    console.log("No results found.");
    return;
  }

  for (const r of results) {
    const prefix = r.source === "record" ? `R${r.id}` : `T${r.id}`;
    const typeTag = r.type ? ` [${r.type}]` : "";
    console.log(`[${prefix}] (${r.similarity.toFixed(3)})${typeTag} ${r.summary}`);
  }
}

async function cmdSidebar(flags) {
  const query = flags.sidebar;
  let vec;
  try {
    vec = await embedder.embed(query);
  } catch {
    vec = null;
  }

  if (!vec) {
    console.log("## Potentially Relevant History\n(Embedding not available — semantic search disabled)\n");
    return;
  }

  const results = db.semanticSearch(vec, {
    project: flags.project || null,
    topN: 10,
    minSimilarity: 0.05,
  });

  if (!results.length) {
    console.log("## Potentially Relevant History\n(No relevant entries found)\n");
    return;
  }

  console.log("## Potentially Relevant History\n");
  for (const r of results) {
    const prefix = r.source === "record" ? `R${r.id}` : `T${r.id}`;
    const typeTag = r.type ? ` [${r.type}]` : "";
    const truncSummary = r.summary.length > 120 ? r.summary.slice(0, 120) + "..." : r.summary;
    console.log(`- [${prefix}] (${r.similarity.toFixed(2)})${typeTag} ${truncSummary}`);
  }
  console.log(`\nUse recall(ID, ...) to load full context.`);
}

function keywordSearch(query, project) {
  // Fallback: simple keyword match against summaries
  const words = query.toLowerCase().split(/\s+/);
  const records = db.listRecords({ status: "active", project });

  const scored = records
    .map((r) => {
      const text = (r.summary + " " + (r.details || "")).toLowerCase();
      const hits = words.filter((w) => text.includes(w)).length;
      return { ...r, score: hits / words.length };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  if (!scored.length) {
    console.log("No keyword matches found.");
    return;
  }

  for (const r of scored) {
    console.log(`[R${r.id}] (kw:${r.score.toFixed(2)}) [${r.type}] ${r.summary}`);
  }
}

function cmdTurn(flags) {
  const id = Number(flags.turn);
  const turn = db.getTurn(id);
  if (!turn) {
    console.error(`Turn ${id} not found`);
    process.exit(1);
  }

  console.log(`\n--- Turn ${turn.id} (${new Date(turn.ts).toISOString()}) ---`);
  if (turn.user_text) console.log(`\nUser:\n${turn.user_text}`);
  if (turn.agent_text) console.log(`\nAgent:\n${turn.agent_text}`);
  if (turn.summary) console.log(`\nSummary: ${turn.summary}`);
  if (turn.record_ids) console.log(`\nRecord entries: ${turn.record_ids}`);
}

function cmdRecent(flags) {
  const limit = flags.recent === true ? 20 : Number(flags.recent);
  const turns = db.recentTurns({
    project: flags.project || null,
    limit,
  });

  if (!turns.length) {
    console.log("No turns found.");
    return;
  }

  for (const t of turns) {
    console.log(`\n--- Turn ${t.id} (${new Date(t.ts).toISOString()}) ---`);
    if (t.user_text) {
      const preview = t.user_text.length > 200 ? t.user_text.slice(0, 200) + "..." : t.user_text;
      console.log(`User: ${preview}`);
    }
    if (t.summary) {
      console.log(`Summary: ${t.summary}`);
    }
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
