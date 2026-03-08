#!/usr/bin/env node
/**
 * Context loader — generates the session-start briefing document.
 *
 * Combines:
 *   1. Decision recall (all active record entries, grouped by type)
 *   2. Precise recall (tail of recent turns)
 *   3. Optionally, a semantic sidebar for a given query
 *
 * Usage:
 *   node loader.js                              # full briefing
 *   node loader.js --project klaudii            # project-scoped
 *   node loader.js --tokens 50000              # token budget for precise recall
 *   node loader.js --query "restart server"     # include semantic sidebar
 */

const db = require("./db");

// Rough token estimator: ~4 chars per token
const CHARS_PER_TOKEN = 4;

async function main() {
  const args = process.argv.slice(2);
  const flags = parseFlags(args);

  if (flags.help) {
    console.log(`Usage:
  loader [--project P] [--tokens N] [--query "..."] [--decisions-only] [--recent-only]

Generates a session-start briefing combining decision recall and precise recall.`);
    process.exit(0);
  }

  const project = flags.project || null;
  const tokenBudget = Number(flags.tokens) || 50000;
  const query = flags.query || null;

  const output = [];

  // --- Decision Recall ---
  if (!flags["recent-only"]) {
    const decisionSection = generateDecisionRecall(project);
    if (decisionSection) {
      output.push(decisionSection);
    }
  }

  // --- Precise Recall ---
  if (!flags["decisions-only"]) {
    // Reserve ~60% of token budget for precise recall, ~30% for decisions, ~10% for sidebar
    const decisionTokens = estimateTokens(output.join("\n"));
    const preciseTokenBudget = tokenBudget - decisionTokens - 2000; // reserve 2k for sidebar

    const preciseSection = generatePreciseRecall(project, preciseTokenBudget);
    if (preciseSection) {
      output.push(preciseSection);
    }
  }

  // --- Semantic Sidebar ---
  if (query) {
    const sidebarSection = await generateSidebar(query, project);
    if (sidebarSection) {
      output.push(sidebarSection);
    }
  }

  console.log(output.join("\n\n"));
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

function estimateTokens(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function generateDecisionRecall(project) {
  const entries = db.activeRecords(project);
  if (!entries.length) return null;

  const grouped = {};
  for (const e of entries) {
    if (!grouped[e.type]) grouped[e.type] = [];
    grouped[e.type].push(e);
  }

  const typeLabels = {
    "preference": "Your Preferences",
    "correction": "Corrections (don't repeat these mistakes)",
    "state": "Current State",
    "decision": "Active Decisions",
    "design": "Design Decisions",
    "user-input": "User Requirements",
    "discovery": "Discoveries & Gotchas",
    "bug": "Known Bugs",
  };

  const order = ["preference", "correction", "state", "decision", "design", "user-input", "discovery", "bug"];

  const lines = ["# Decision Recall\n"];
  for (const type of order) {
    if (!grouped[type]) continue;
    lines.push(`## ${typeLabels[type] || type}\n`);
    for (const e of grouped[type]) {
      lines.push(`- [${e.id}] ${e.summary}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function generatePreciseRecall(project, tokenBudget) {
  if (tokenBudget <= 0) return null;

  // Load recent turns, working backwards until we fill the budget
  const allTurns = db.recentTurns({ project, limit: 200 });
  if (!allTurns.length) return null;

  const lines = ["# Recent Conversation\n"];
  let tokensUsed = estimateTokens(lines[0]);
  const includedTurns = [];

  // Work backwards from most recent
  for (let i = allTurns.length - 1; i >= 0; i--) {
    const t = allTurns[i];
    const turnText = formatTurn(t);
    const turnTokens = estimateTokens(turnText);

    if (tokensUsed + turnTokens > tokenBudget) break;

    includedTurns.unshift(turnText);
    tokensUsed += turnTokens;
  }

  if (!includedTurns.length) return null;

  lines.push(...includedTurns);
  lines.push(`\n(${includedTurns.length} of ${allTurns.length} recent turns shown, ~${tokensUsed} tokens)`);
  return lines.join("\n");
}

function formatTurn(turn) {
  const lines = [];
  const time = new Date(turn.ts).toISOString().replace("T", " ").replace(/\.\d+Z/, " UTC");

  lines.push(`---`);

  if (turn.user_text) {
    lines.push(`**User** _${time}_\n`);
    lines.push(turn.user_text);
    lines.push("");
  }

  if (turn.agent_text) {
    lines.push(`**Agent** _${time}_\n`);
    lines.push(turn.agent_text);
    lines.push("");
  } else if (turn.summary) {
    lines.push(`**Agent** _${time}_\n`);
    lines.push(`_${turn.summary}_`);
    lines.push("");
  }

  return lines.join("\n");
}

async function generateSidebar(query, project) {
  let vec;
  try {
    const embedder = require("./embed");
    vec = await embedder.embed(query);
  } catch {
    return null;
  }

  if (!vec) return null;

  const results = db.semanticSearch(vec, {
    project,
    topN: 10,
    minSimilarity: 0.05,
  });

  if (!results.length) return null;

  const lines = ["## Potentially Relevant History\n"];
  for (const r of results) {
    const prefix = r.source === "record" ? `R${r.id}` : `T${r.id}`;
    const typeTag = r.type ? ` [${r.type}]` : "";
    const truncSummary = r.summary.length > 120 ? r.summary.slice(0, 120) + "..." : r.summary;
    lines.push(`- [${prefix}] (${r.similarity.toFixed(2)})${typeTag} ${truncSummary}`);
  }
  lines.push(`\nUse recall(ID, ...) to load full context.`);
  return lines.join("\n");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
