const fs = require("fs");
const path = require("path");
const claude = require("./claude");
const tmux = require("./tmux");

const SESSIONS_FILE = path.join(__dirname, "..", "sessions.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function save(data) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2) + "\n");
}

/**
 * Record a session ID for a workspace.
 * Returns true if the session was newly added, false if it was a duplicate.
 */
function addSession(workspace, sessionId, mode = "fresh") {
  if (!sessionId) return false;
  const data = load();
  if (!data[workspace]) data[workspace] = [];
  if (data[workspace].some((s) => s.sessionId === sessionId)) return false;
  data[workspace].push({ sessionId, startedAt: Date.now(), mode });
  save(data);
  return true;
}

/**
 * Get all tracked sessions for a workspace, most recent first.
 */
function getSessions(workspace) {
  return (load()[workspace] || []).sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * Get just the session IDs for a workspace.
 */
function getSessionIds(workspace) {
  return getSessions(workspace).map((s) => s.sessionId);
}

/**
 * Get the cached claude.ai URL for a workspace, or null if not yet captured.
 */
function getClaudeUrl(workspace) {
  const data = load();
  return (data._urls && data._urls[workspace]) || null;
}

/**
 * Clear the cached URL for a workspace (call on stop/restart).
 */
function clearClaudeUrl(workspace) {
  const data = load();
  if (data._urls) {
    delete data._urls[workspace];
    save(data);
  }
}

/**
 * Persist a URL for a workspace.
 */
function setClaudeUrl(workspace, url) {
  const data = load();
  if (!data._urls) data._urls = {};
  data._urls[workspace] = url;
  save(data);
}

/**
 * Capture the claude.ai URL for a workspace using a layered strategy:
 *  1. Immediately try to extract session ID from process args (instant, reliable)
 *  2. Then poll the tmux pane for the full URL with bridge param (async upgrade)
 * Runs async after session start — the URL is stable for the process lifetime.
 */
async function captureClaudeUrl(workspace, tmuxName, maxAttempts = 20, delayMs = 1500) {
  let hasBridgeUrl = false;

  // Layer 1: extract from process args (try a few times for process to spawn)
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const processUrl = tmux.getClaudeUrlFromProcess(tmuxName);
    if (processUrl) {
      setClaudeUrl(workspace, processUrl);
      console.log(`[session-tracker] Captured URL (from process) for ${workspace}: ${processUrl}`);
      break;
    }
  }

  // Layer 2: try to upgrade with the full URL (includes bridge param) from tmux pane
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    const fullUrl = tmux.getClaudeUrl(tmuxName);
    if (fullUrl) {
      setClaudeUrl(workspace, fullUrl);
      console.log(`[session-tracker] Upgraded URL (with bridge) for ${workspace}: ${fullUrl}`);
      hasBridgeUrl = true;
      break;
    }
  }

  if (!hasBridgeUrl) {
    console.log(`[session-tracker] Bridge URL not found for ${workspace} — using process-based URL`);
  }

  return getClaudeUrl(workspace);
}

/**
 * Re-capture URLs for any running sessions that don't have a cached URL.
 * Call on server startup to recover state after a Klaudii restart.
 */
function recoverUrls(getRunningWorkspaces) {
  const running = getRunningWorkspaces();
  for (const { workspace, tmuxName } of running) {
    const existing = getClaudeUrl(workspace);
    if (!existing) {
      // Process-based extraction works instantly even after a restart
      const processUrl = tmux.getClaudeUrlFromProcess(tmuxName);
      if (processUrl) {
        setClaudeUrl(workspace, processUrl);
        console.log(`[session-tracker] Recovered URL (from process) for ${workspace}: ${processUrl}`);
      } else {
        console.log(`[session-tracker] Recovering URL for running workspace ${workspace} via tmux scrape...`);
        captureClaudeUrl(workspace, tmuxName);
      }
    }
  }
}

/**
 * Poll history.jsonl for a new session that appeared after `afterTs`.
 * Runs async — call fire-and-forget from the session start endpoints.
 */
async function detectAndTrack(workspace, afterTs, maxAttempts = 15, delayMs = 2000) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    const id = claude.findLatestSessionId(afterTs);
    if (id) {
      const added = addSession(workspace, id, "detected");
      if (added) {
        console.log(`[session-tracker] Detected session ${id.slice(0, 8)} for workspace ${workspace}`);
      }
      return id;
    }
  }
  console.warn(`[session-tracker] Could not detect session for workspace ${workspace} after ${maxAttempts} attempts`);
  return null;
}

module.exports = {
  addSession,
  getSessions,
  getSessionIds,
  getClaudeUrl,
  clearClaudeUrl,
  captureClaudeUrl,
  recoverUrls,
  detectAndTrack,
};
