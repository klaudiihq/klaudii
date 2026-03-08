const fs = require("fs");
const path = require("path");
const os = require("os");

const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const HISTORY_FILE = path.join(CLAUDE_DIR, "history.jsonl");
const PROJECTS_DIR = path.join(CLAUDE_DIR, "projects");

function encodeProjectPath(projectPath) {
  return projectPath.replace(/\//g, "-");
}

function getHistory(limit = 50) {
  if (!fs.existsSync(HISTORY_FILE)) return [];

  const lines = fs.readFileSync(HISTORY_FILE, "utf-8").trim().split("\n").filter(Boolean);

  const entries = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }

  // Most recent first
  entries.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return entries.slice(0, limit);
}

function getHistoryForProject(projectPath, limit = 20) {
  return getHistory(500)
    .filter((e) => e.project === projectPath)
    .slice(0, limit);
}

function getSessionSummary(projectPath, sessionId) {
  const encoded = encodeProjectPath(projectPath);
  const sessionFile = path.join(PROJECTS_DIR, encoded, `${sessionId}.jsonl`);

  if (!fs.existsSync(sessionFile)) return null;

  const lines = fs.readFileSync(sessionFile, "utf-8").trim().split("\n").filter(Boolean);
  let firstUserMessage = null;
  let messageCount = 0;
  let startTime = null;
  let endTime = null;

  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      if (record.timestamp) {
        const t = new Date(record.timestamp).getTime();
        if (!startTime || t < startTime) startTime = t;
        if (!endTime || t > endTime) endTime = t;
      }
      if (record.type === "user" && record.message?.content && !firstUserMessage) {
        const content = record.message.content;
        firstUserMessage = typeof content === "string" ? content : JSON.stringify(content);
        if (firstUserMessage.length > 120) {
          firstUserMessage = firstUserMessage.slice(0, 120) + "...";
        }
      }
      messageCount++;
    } catch {
      // Skip
    }
  }

  return { sessionId, messageCount, firstUserMessage, startTime, endTime };
}

function getRecentSessions(projectPath, limit = 10) {
  const history = getHistoryForProject(projectPath, limit);
  const seen = new Set();
  const sessions = [];

  for (const entry of history) {
    if (!entry.sessionId || seen.has(entry.sessionId)) continue;
    seen.add(entry.sessionId);
    sessions.push({
      sessionId: entry.sessionId,
      timestamp: entry.timestamp,
      display: entry.display,
    });
  }

  return sessions;
}

/**
 * Find the most recent session ID in history.jsonl that appeared after `afterTimestamp` (ms).
 * Not filtered by project path — relies on the caller knowing this is their session.
 */
function findLatestSessionId(afterTimestamp) {
  const entries = getHistory(50);
  for (const entry of entries) {
    if (!entry.sessionId || !entry.timestamp) continue;
    // Handle both seconds and milliseconds timestamps
    const entryMs = entry.timestamp < 1e12 ? entry.timestamp * 1000 : entry.timestamp;
    if (entryMs > afterTimestamp) {
      return entry.sessionId;
    }
  }
  return null;
}

/**
 * Look up history entries for a specific set of session IDs.
 * Used by the session tracker to get display info for tracked sessions.
 */
function getSessionsByIds(sessionIds, limit = 20) {
  if (!sessionIds.length) return [];
  const idSet = new Set(sessionIds);
  const history = getHistory(500);
  const seen = new Set();
  const sessions = [];

  for (const entry of history) {
    if (!entry.sessionId || !idSet.has(entry.sessionId) || seen.has(entry.sessionId)) continue;
    seen.add(entry.sessionId);
    sessions.push({
      sessionId: entry.sessionId,
      timestamp: entry.timestamp,
      display: entry.display,
    });
    if (sessions.length >= limit) break;
  }

  return sessions;
}

/**
 * Get the last activity timestamp for a project by checking the mtime of its
 * session .jsonl files in ~/.claude/projects/. These files are written to
 * continuously as Claude works, so their mtime reflects real activity.
 * Returns milliseconds since epoch, or 0 if no session files found.
 */
function getProjectLastActivity(projectPath) {
  try {
    const encoded = encodeProjectPath(projectPath);
    const dir = path.join(PROJECTS_DIR, encoded);
    if (!fs.existsSync(dir)) return 0;

    let latest = 0;
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(".jsonl")) continue;
      const mtime = fs.statSync(path.join(dir, entry)).mtimeMs;
      if (mtime > latest) latest = mtime;
    }
    return latest;
  } catch {
    return 0;
  }
}

/**
 * Aggregate output/input token usage from session .jsonl files, bucketed by hour.
 * Returns an array of { hour (ms epoch), outputTokens, inputTokens }, oldest-first,
 * covering the last `hours` hours. Files older than the window are skipped via mtime.
 */
function getTokenUsage(hours = 24) {
  const now = Date.now();
  const cutoffMs = now - hours * 60 * 60 * 1000;
  const hourMs = 60 * 60 * 1000;

  // Pre-populate every bucket in the window
  const buckets = new Map();
  for (let i = 0; i < hours; i++) {
    const h = Math.floor((now - (hours - 1 - i) * hourMs) / hourMs) * hourMs;
    buckets.set(h, { hour: h, outputTokens: 0, inputTokens: 0 });
  }

  try {
    if (!fs.existsSync(PROJECTS_DIR)) return [...buckets.values()];

    for (const projectDir of fs.readdirSync(PROJECTS_DIR)) {
      const projectPath = path.join(PROJECTS_DIR, projectDir);
      try {
        if (!fs.statSync(projectPath).isDirectory()) continue;
      } catch { continue; }

      for (const file of fs.readdirSync(projectPath)) {
        if (!file.endsWith(".jsonl")) continue;
        const filePath = path.join(projectPath, file);

        // Skip files with no recent writes — can't contain data in our window
        try {
          if (fs.statSync(filePath).mtimeMs < cutoffMs) continue;
        } catch { continue; }

        try {
          const lines = fs.readFileSync(filePath, "utf-8").split("\n");
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const record = JSON.parse(line);
              // usage lives in message.usage (assistant records)
              const usage = record.message?.usage;
              if (!usage || !record.timestamp) continue;
              const ts = new Date(record.timestamp).getTime();
              if (isNaN(ts) || ts < cutoffMs) continue;
              const bucket = Math.floor(ts / hourMs) * hourMs;
              if (!buckets.has(bucket)) continue;
              const b = buckets.get(bucket);
              b.outputTokens += usage.output_tokens || 0;
              b.inputTokens += usage.input_tokens || 0;
            } catch { /* skip malformed lines */ }
          }
        } catch { /* skip unreadable files */ }
      }
    }
  } catch { /* skip if PROJECTS_DIR unreadable */ }

  return [...buckets.values()];
}

/**
 * Parse a reset time string like "resets 4pm (America/New_York)" into a UTC ms timestamp.
 * Returns null if the string can't be parsed.
 */
function parseResetTimestamp(text, eventTs) {
  const m = text.match(/resets (\d+)(am|pm)\s*\(([^)]+)\)/i);
  if (!m) return null;
  let hour = parseInt(m[1]);
  if (m[2].toLowerCase() === "pm" && hour !== 12) hour += 12;
  if (m[2].toLowerCase() === "am" && hour === 12) hour = 0;
  const tz = m[3];
  const ref = new Date(eventTs);
  try {
    // Compute the TZ's UTC offset at the event time using the toLocaleString trick.
    // Both strings are parsed as system-local time, but their *difference* is the
    // offset between UTC and the target TZ, independent of the system timezone.
    const utcStr = ref.toLocaleString("en-US", { timeZone: "UTC", hour12: false }).replace(",", "");
    const tzStr = ref.toLocaleString("en-US", { timeZone: tz, hour12: false }).replace(",", "");
    const offsetMs = new Date(tzStr).getTime() - new Date(utcStr).getTime();

    // Get the calendar date in the target TZ (en-CA gives YYYY-MM-DD)
    const dtf = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    for (let d = 0; d <= 2; d++) {
      const [yyyy, mm, dd] = dtf.format(new Date(ref.getTime() + d * 86400000)).split("-").map(Number);
      const resetUTC = Date.UTC(yyyy, mm - 1, dd, hour, 0, 0) - offsetMs;
      if (resetUTC >= ref.getTime()) return resetUTC;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Scan all session .jsonl files for rate_limit error records in the last `hours` hours.
 * Returns an array of { timestamp, resetText, resetAt } sorted newest-first.
 */
function getRateLimitEvents(hours = 168) {
  const now = Date.now();
  const cutoffMs = now - hours * 60 * 60 * 1000;
  const events = [];
  try {
    if (!fs.existsSync(PROJECTS_DIR)) return events;
    for (const projectDir of fs.readdirSync(PROJECTS_DIR)) {
      const projectPath = path.join(PROJECTS_DIR, projectDir);
      try { if (!fs.statSync(projectPath).isDirectory()) continue; } catch { continue; }
      for (const file of fs.readdirSync(projectPath)) {
        if (!file.endsWith(".jsonl")) continue;
        const filePath = path.join(projectPath, file);
        try { if (fs.statSync(filePath).mtimeMs < cutoffMs) continue; } catch { continue; }
        try {
          const lines = fs.readFileSync(filePath, "utf-8").split("\n");
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const record = JSON.parse(line);
              if (record.error !== "rate_limit" || !record.timestamp) continue;
              const ts = new Date(record.timestamp).getTime();
              if (isNaN(ts) || ts < cutoffMs) continue;
              let resetText = null;
              const content = record.message?.content;
              if (Array.isArray(content)) {
                for (const c of content) {
                  if (typeof c.text === "string" && c.text.includes("resets")) { resetText = c.text; break; }
                }
              } else if (typeof content === "string" && content.includes("resets")) {
                resetText = content;
              }
              events.push({ timestamp: ts, resetText, resetAt: resetText ? parseResetTimestamp(resetText, ts) : null });
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
  return events.sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Read the full message history from a Claude session JSONL file.
 * Returns normalized messages: [{ role, content, ts, toolName, toolId, params, output, status }]
 * suitable for rendering in the worker activity view.
 */
function getSessionMessages(projectPath, sessionId) {
  const encoded = encodeProjectPath(projectPath);
  const sessionFile = path.join(PROJECTS_DIR, encoded, `${sessionId}.jsonl`);

  if (!fs.existsSync(sessionFile)) return [];

  const lines = fs.readFileSync(sessionFile, "utf-8").trim().split("\n").filter(Boolean);
  const messages = [];

  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      const ts = record.timestamp ? new Date(record.timestamp).getTime() : null;

      if (record.type === "user") {
        const content = record.message?.content;
        if (typeof content === "string") {
          messages.push({ role: "user", content, ts });
        } else if (Array.isArray(content)) {
          // Tool results come as user messages with tool_result content blocks
          for (const block of content) {
            if (block.type === "tool_result") {
              const output = typeof block.content === "string"
                ? block.content
                : Array.isArray(block.content)
                  ? block.content.map(c => c.text || "").join("\n")
                  : "";
              messages.push({
                role: "tool_result",
                content: JSON.stringify({
                  tool_id: block.tool_use_id,
                  output: output.slice(0, 4000),
                  status: block.is_error ? "error" : "success",
                }),
                ts,
              });
            } else if (block.type === "text") {
              messages.push({ role: "user", content: block.text, ts });
            }
          }
        }
      } else if (record.type === "assistant") {
        const content = record.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text) {
              messages.push({ role: "assistant", content: block.text, ts });
            } else if (block.type === "thinking" && block.thinking) {
              messages.push({ role: "thinking", content: block.thinking, ts });
            } else if (block.type === "tool_use") {
              messages.push({
                role: "tool_use",
                content: JSON.stringify({
                  tool_name: block.name,
                  tool_id: block.id,
                  parameters: block.input || {},
                }),
                ts,
              });
            }
          }
        } else if (typeof content === "string") {
          messages.push({ role: "assistant", content, ts });
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  return messages;
}

module.exports = {
  getHistory,
  getHistoryForProject,
  getSessionSummary,
  getRecentSessions,
  findLatestSessionId,
  getSessionsByIds,
  getProjectLastActivity,
  getTokenUsage,
  getRateLimitEvents,
  getSessionMessages,
};
