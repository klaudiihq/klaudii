#!/usr/bin/env node
/**
 * Turn chunker — processes raw Claude Code session JSONL into turns.
 *
 * Reads the JSONL format used by Claude Code CLI (~/.claude/projects/.../*.jsonl)
 * and extracts user/agent turns, stripping tool call noise.
 *
 * Usage:
 *   node chunk.js /path/to/session.jsonl [--project klaudii] [--embed] [--dry-run]
 *   node chunk.js /path/to/session.jsonl --summarize  # use LLM to summarize (future)
 */

const fs = require("fs");
const db = require("./db");
const embedder = require("./embed");

async function main() {
  const args = process.argv.slice(2);
  const flags = parseFlags(args);
  const filePath = flags._positional?.[0];

  if (!filePath || flags.help) {
    console.log(`Usage:
  chunk SESSION.jsonl [--project P] [--session S] [--embed] [--dry-run]

Processes a Claude Code session JSONL file into conversation turns.
Strips tool call noise, preserves user messages in full, compresses agent responses.`);
    process.exit(0);
  }

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  // Derive session ID from filename
  const sessionId = flags.session || require("path").basename(filePath, ".jsonl");

  // Check if already chunked
  const existing = db.recentTurns({ session: sessionId, limit: 1 });
  if (existing.length && !flags.force) {
    console.error(`Session ${sessionId} already chunked (${existing.length} turns). Use --force to re-chunk.`);
    process.exit(1);
  }

  const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
  console.error(`Processing ${lines.length} lines from ${filePath}...`);

  const turns = extractTurns(lines);
  console.error(`Extracted ${turns.length} turns`);

  if (flags["dry-run"]) {
    for (const t of turns) {
      const userPreview = t.userText ? t.userText.slice(0, 100) : "(no user text)";
      const agentPreview = t.agentText ? t.agentText.slice(0, 100) : "(no agent text)";
      console.log(`\n--- Turn (${new Date(t.ts).toISOString()}) ---`);
      console.log(`User: ${userPreview}`);
      console.log(`Agent: ${agentPreview}`);
      if (t.summary) console.log(`Summary: ${t.summary}`);
      if (t.stateChanges.length) console.log(`State changes: ${t.stateChanges.join(", ")}`);
    }
    console.log(`\n${turns.length} turns (dry run, nothing saved)`);
    return;
  }

  // Store turns
  let embedded = 0;
  const doEmbed = flags.embed;

  for (const t of turns) {
    const summary = t.summary || buildSummary(t);
    let embeddingVec = null;

    if (doEmbed) {
      try {
        embeddingVec = await embedder.embed(summary);
        if (embeddingVec) embedded++;
      } catch {
        // skip
      }
    }

    db.addTurn({
      ts: t.ts,
      session: sessionId,
      project: flags.project || null,
      user_text: t.userText,
      agent_text: t.agentText,
      summary,
      embedding: embeddingVec ? db.float32ToBlob(embeddingVec) : null,
    });
  }

  console.log(`Saved ${turns.length} turns${embedded ? ` (${embedded} embedded)` : ""}`);
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

/**
 * Extract conversation turns from Claude Code JSONL.
 *
 * A turn = one user message + the agent's full response (text only, tools stripped).
 * Tool calls that change state are noted in the summary.
 */
function extractTurns(lines) {
  const turns = [];
  let currentTurn = null;

  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const role = obj.role || obj.type;

    // Skip non-message entries (progress, queue-operation, etc.)
    if (!["user", "assistant"].includes(role)) continue;

    const content = obj.message?.content || obj.content;
    const ts = obj.timestamp || obj.ts || 0;

    if (role === "user") {
      const userText = extractUserText(content);

      // Skip system-context, system-reminder, and empty messages
      if (!userText) continue;
      if (userText.startsWith("<system-context>") || userText.startsWith("<system-reminder>")) continue;

      // Skip tool result messages (user role with tool_result content)
      if (Array.isArray(content) && content.some(b => b.type === "tool_result")) continue;

      // Deduplicate — same user text as current turn means duplicate line
      if (currentTurn && currentTurn.userText === userText) continue;

      // Start a new turn
      if (currentTurn && (currentTurn.userText || currentTurn.agentText)) {
        turns.push(currentTurn);
      }

      currentTurn = {
        ts: ts || Date.now(),
        userText,
        agentText: "",
        stateChanges: [],
        toolCalls: [],
        summary: null,
      };
    } else if (role === "assistant" && currentTurn) {
      processAssistantContent(content, currentTurn);
    }
  }

  // Don't forget the last turn
  if (currentTurn && (currentTurn.userText || currentTurn.agentText)) {
    turns.push(currentTurn);
  }

  return turns;
}

function extractUserText(content) {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    const texts = [];
    for (const block of content) {
      if (block.type === "text" && block.text) {
        texts.push(block.text.trim());
      }
    }
    return texts.join("\n").trim() || null;
  }
  return null;
}

function processAssistantContent(content, turn) {
  if (!content) return;

  if (typeof content === "string") {
    if (content.trim()) turn.agentText += content.trim() + "\n";
    return;
  }

  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (block.type === "text" && block.text?.trim()) {
      // Skip preamble noise
      const text = block.text.trim();
      if (!isPreamble(text)) {
        turn.agentText += text + "\n";
      }
    } else if (block.type === "tool_use") {
      const summary = summarizeToolCall(block);
      if (summary) {
        turn.toolCalls.push(summary);
        if (summary.stateChange) {
          turn.stateChanges.push(summary.description);
        }
      }
    }
    // Skip 'thinking' blocks entirely
  }
}

function isPreamble(text) {
  // Filter out low-signal agent preamble
  const lower = text.toLowerCase();
  const preambles = [
    /^let me (check|look|read|search|find|see|verify|examine)/,
    /^i('ll| will) (check|look|read|search|find|now|start)/,
    /^(good|great|perfect|ok|okay)[.,!]?\s*$/i,
    /^(now let me|let me now|let me also)/,
  ];
  return preambles.some(p => p.test(lower));
}

function summarizeToolCall(block) {
  const name = block.name;
  const input = block.input || {};

  // State-changing tools
  if (name === "Edit" || name === "Write") {
    const fp = shortenPath(input.file_path || "?");
    return { description: `[${name}] ${fp}`, stateChange: true };
  }

  if (name === "Bash") {
    const cmd = input.command || "";
    const desc = input.description || "";

    // Detect state-changing bash commands
    const isStateChange = /\b(git commit|git push|npm install|launchctl|mkdir|rm |mv |cp )/i.test(cmd);
    const shortCmd = desc || (cmd.length > 80 ? cmd.slice(0, 80) + "..." : cmd);

    return { description: `[Bash] ${shortCmd}`, stateChange: isStateChange };
  }

  // Read/search tools — low signal, just note the exploration
  if (name === "Read" || name === "Glob" || name === "Grep") {
    return null; // Skip entirely — these are exploration noise
  }

  // Agent tool
  if (name === "Agent") {
    return { description: `[Agent] ${input.description || "subagent"}`, stateChange: false };
  }

  return { description: `[${name}]`, stateChange: false };
}

function shortenPath(fp) {
  return fp
    .replace(/\/Volumes\/Fast\/bryantinsley\/repos\/klaudii\/?/, "")
    .replace(/\/Volumes\/Fast\/bryantinsley\//, "~/");
}

/**
 * Build a summary from a processed turn.
 * Combines the last meaningful agent text with state changes.
 */
function buildSummary(turn) {
  const parts = [];

  if (turn.userText) {
    const userPreview = turn.userText.length > 200 ? turn.userText.slice(0, 200) + "..." : turn.userText;
    parts.push(`User: ${userPreview}`);
  }

  if (turn.agentText) {
    // Take the last paragraph of agent text as the conclusion
    const paragraphs = turn.agentText.trim().split(/\n\n+/);
    const conclusion = paragraphs[paragraphs.length - 1];
    const preview = conclusion.length > 300 ? conclusion.slice(0, 300) + "..." : conclusion;
    parts.push(`Agent: ${preview}`);
  }

  if (turn.stateChanges.length) {
    parts.push(`Changes: ${turn.stateChanges.join(", ")}`);
  }

  return parts.join("\n") || "(empty turn)";
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
