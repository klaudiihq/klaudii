/**
 * Persistent per-workspace chat state.
 *
 * Stores: which mode each workspace is in, which session number was last active
 * per mode, and the current input draft per mode+session.
 *
 * All writes are synchronous so state survives server crashes.
 */

const fs = require("fs");
const path = require("path");

const APP_DATA_DIR = path.join(require("os").homedir(), "Library", "Application Support", "com.klaudii.server");
const STATE_FILE = path.join(APP_DATA_DIR, "workspace-state.json");

const VALID_MODES = ["gemini", "claude-local", "claude-remote"];
const DEFAULT_MODE = "claude-local";

// In-memory state (persisted to disk)
let state = {};
try {
  state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
} catch {
  // Fresh start
}

// In-memory only — chat activity timestamps for all modes.
// Not persisted: file mtime fallback covers cross-restart sorting for Claude sessions;
// Gemini/Claude Local reset to that fallback after a restart until the next message.
const chatActivity = new Map(); // workspace → timestamp (ms)

// In-memory only — tracks which workspaces have an active streaming response.
// Set by the WS handler on send, cleared on done/error/stop/disconnect.
const streaming = new Map(); // workspace → true

function save() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function ensureWorkspace(workspace) {
  if (!state[workspace]) {
    state[workspace] = { mode: DEFAULT_MODE, sessions: {}, drafts: {} };
  }
  if (!state[workspace].sessions) state[workspace].sessions = {};
  if (!state[workspace].drafts) state[workspace].drafts = {};
  return state[workspace];
}

/**
 * Get full state for a workspace.
 * @returns {{ mode, sessionNum, draft, taskId?, type? }}  sessionNum and draft are for the current mode
 */
function getWorkspace(workspace) {
  const ws = ensureWorkspace(workspace);
  const mode = ws.mode || DEFAULT_MODE;
  const sessionNum = ws.sessions[mode] || null;
  const draftKey = sessionNum ? `${mode}:${sessionNum}` : `${mode}:new`;
  const draft = ws.drafts[draftKey] || "";
  const result = { mode, sessionNum, draft };
  if (ws.taskId) result.taskId = ws.taskId;
  if (ws.type) result.type = ws.type;
  return result;
}

/**
 * Associate a workspace with a task ID and optionally mark its type.
 * @param {string} workspace
 * @param {string} taskId
 * @param {string} [type] - "worker" or "user"
 */
function setTaskId(workspace, taskId, type) {
  const ws = ensureWorkspace(workspace);
  ws.taskId = taskId;
  if (type) ws.type = type;
  save();
}

/**
 * Get the task ID associated with a workspace (or null).
 */
function getTaskId(workspace) {
  const ws = state[workspace];
  return ws ? ws.taskId || null : null;
}

/**
 * Find all workspaces associated with a given task ID.
 * @returns {string[]} workspace names
 */
function getWorkspacesForTask(taskId) {
  return Object.keys(state).filter(ws => state[ws].taskId === taskId);
}

/**
 * Update state for a workspace. All fields optional.
 * @param {string} workspace
 * @param {{ mode?, sessionNum?, draft?, draftMode?, draftSession? }} updates
 *   - mode: new chat mode
 *   - sessionNum: current session number for the mode (defaults to current mode)
 *   - draft: draft text to save
 *   - draftMode: mode for the draft (defaults to current mode after any mode update)
 *   - draftSession: session number for the draft
 */
function setState(workspace, updates) {
  const ws = ensureWorkspace(workspace);

  if (updates.mode && VALID_MODES.includes(updates.mode)) {
    ws.mode = updates.mode;
  }

  const effectiveMode = ws.mode || DEFAULT_MODE;

  if (updates.sessionNum != null) {
    const targetMode = updates.draftMode || effectiveMode;
    ws.sessions[targetMode] = updates.sessionNum;
  }

  if (updates.draft !== undefined) {
    const draftMode = updates.draftMode || effectiveMode;
    const draftSession = updates.draftSession || ws.sessions[draftMode] || "new";
    const key = `${draftMode}:${draftSession}`;
    if (updates.draft) {
      ws.drafts[key] = updates.draft;
    } else {
      delete ws.drafts[key];
    }
  }

  save();
}

/**
 * Record that chat activity just occurred for a workspace (any mode).
 * Called on every WebSocket send/receive event.
 */
function touchChatActivity(workspace) {
  const ts = Date.now();
  chatActivity.set(workspace, ts);
  // Persist so sorting survives server restarts
  const ws = ensureWorkspace(workspace);
  ws.lastChatActivity = ts;
  save();
}

/**
 * Get the last known chat activity timestamp for a workspace (ms epoch).
 * Returns 0 if never seen since last server start.
 */
function getLastChatActivity(workspace) {
  return chatActivity.get(workspace) || (state[workspace] && state[workspace].lastChatActivity) || 0;
}

/**
 * Mark a workspace as actively streaming (or done).
 * Called by the WS handler on send (true) and on done/error/stop (false).
 */
function setStreaming(workspace, active) {
  if (active) streaming.set(workspace, true);
  else streaming.delete(workspace);
}

/**
 * Check whether a workspace has an active streaming response.
 */
function isStreaming(workspace) {
  return streaming.has(workspace);
}

// In-memory cumulative cost/token stats per workspace (resets on server restart or new session).
const cumulativeStats = new Map(); // workspace → { cost, input_tokens, output_tokens, total_tokens, last_input_tokens, context_window_size }

// Default context window sizes by model family
const CONTEXT_WINDOW_SIZES = {
  "claude-opus-4": 200000,
  "claude-sonnet-4": 200000,
  "claude-haiku-4": 200000,
  default: 200000,
};

/**
 * Accumulate turn stats into cumulative totals for a workspace.
 * stats.input_tokens on a given turn represents the full context sent to the model,
 * so the latest value is a proxy for context window fill level.
 */
function addTurnStats(workspace, stats) {
  if (!stats) return;
  const cur = cumulativeStats.get(workspace) || { cost: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, last_input_tokens: 0, context_window_size: CONTEXT_WINDOW_SIZES.default };
  if (stats.cost != null) cur.cost += stats.cost;
  if (stats.input_tokens) {
    cur.input_tokens += stats.input_tokens;
    cur.last_input_tokens = stats.input_tokens;
  }
  if (stats.output_tokens) cur.output_tokens += stats.output_tokens;
  if (stats.total_tokens) cur.total_tokens += stats.total_tokens;
  cumulativeStats.set(workspace, cur);
}

/**
 * Get cumulative stats for a workspace.
 */
function getCumulativeStats(workspace) {
  const cur = cumulativeStats.get(workspace) || { cost: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, last_input_tokens: 0, context_window_size: CONTEXT_WINDOW_SIZES.default };
  const used = cur.last_input_tokens / cur.context_window_size;
  cur.context_used_pct = Math.round(used * 100);
  cur.context_remaining_pct = Math.max(0, 100 - cur.context_used_pct);
  return cur;
}

/**
 * Reset cumulative stats for a workspace (e.g. on new session).
 */
function resetCumulativeStats(workspace) {
  cumulativeStats.delete(workspace);
}

// In-memory pending permission requests (not persisted — only relevant while relay is alive)
const pendingPermissions = new Map(); // workspace → permission_request event

/**
 * Store a pending permission_request for a workspace. Claude is blocked waiting
 * for this response. Cleared when a permission_response is sent or the relay exits.
 */
function setPendingPermission(workspace, event) {
  if (event) pendingPermissions.set(workspace, event);
  else pendingPermissions.delete(workspace);
}

/**
 * Get any pending permission_request for a workspace (or null).
 */
function getPendingPermission(workspace) {
  return pendingPermissions.get(workspace) || null;
}

/**
 * List of valid modes.
 */
function validModes() {
  return VALID_MODES;
}

/**
 * Tag a workspace as "worker" or "user".
 */
function setWorkspaceType(workspace, type) {
  const ws = ensureWorkspace(workspace);
  ws.type = type;
  save();
}

/**
 * Get workspace type ("worker" or "user"). Defaults to "user".
 */
function getWorkspaceType(workspace) {
  return (state[workspace] && state[workspace].type) || "user";
}

module.exports = { getWorkspace, setState, setTaskId, getTaskId, getWorkspacesForTask, touchChatActivity, getLastChatActivity, setStreaming, isStreaming, setPendingPermission, getPendingPermission, validModes, setWorkspaceType, getWorkspaceType, addTurnStats, getCumulativeStats, resetCumulativeStats };
