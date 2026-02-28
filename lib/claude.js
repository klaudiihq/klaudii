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

module.exports = { getHistory, getHistoryForProject, getSessionSummary, getRecentSessions };
