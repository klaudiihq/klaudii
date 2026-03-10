/**
 * Claude CLI subprocess manager.
 *
 * Spawns `claude` in headless mode with `--output-format stream-json --verbose`,
 * normalizes the JSONL events to match the Gemini event format so the frontend
 * can handle both backends identically, and tracks session IDs per workspace
 * for multi-turn conversations via `--resume`.
 *
 * Event normalization:
 *   Claude {type:"system", subtype:"init"}  →  {type:"init", session_id}
 *   Claude {type:"assistant"} text blocks    →  {type:"message", role:"assistant", content, delta:true}
 *   Claude {type:"assistant"} tool_use blocks → {type:"tool_use", tool_name, tool_id, parameters}
 *   Claude {type:"user"} tool_result         →  {type:"tool_result", tool_id, status, output}
 *   Claude {type:"rate_limit_event"}         →  {type:"status", message}
 *   Claude {type:"result"}                   →  {type:"result", stats}
 */

const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { DATA_DIR, RELAY_DIR: PATHS_RELAY_DIR } = require("./paths");

// --- Logging ---
const LOG_PREFIX = "[claude-chat]";
function log(...args) { console.log(LOG_PREFIX, new Date().toISOString(), ...args); }
function logErr(...args) { console.error(LOG_PREFIX, new Date().toISOString(), ...args); }

// App data
const CONVERSATIONS_DIR = path.join(DATA_DIR, "conversations");
const SESSIONS_FILE_OLD = path.join(DATA_DIR, "claude-chat-sessions.json");
const LEGACY_HISTORY_FILE = path.join(CONVERSATIONS_DIR, "claude-chat-history.json");

// Ensure conversations directory exists
if (!fs.existsSync(CONVERSATIONS_DIR)) {
  fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
}

// --- Per-workspace / per-session file helpers ---
function historyDir(workspace) {
  return path.join(CONVERSATIONS_DIR, workspace, "claude-local");
}
function historyFile(workspace, sessionNum) {
  return path.join(historyDir(workspace), `${sessionNum}.json`);
}
function readSessionHistory(workspace, sessionNum) {
  try {
    return JSON.parse(fs.readFileSync(historyFile(workspace, String(sessionNum)), "utf-8"));
  } catch { return []; }
}
function writeSessionHistory(workspace, sessionNum, messages) {
  const dir = historyDir(workspace);
  fs.mkdirSync(dir, { recursive: true });
  const dest = historyFile(workspace, String(sessionNum));
  const tmp = dest + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(messages, null, 2));
  fs.renameSync(tmp, dest);
}

// --- Per-session metadata sidecar (.meta.json) ---
// Replaces the old claude-chat-sessions.json registry. Metadata lives
// alongside each conversation file so it can't drift out of sync.

function metaFile(workspace, sessionNum) {
  return path.join(historyDir(workspace), `${sessionNum}.meta.json`);
}

function readMeta(workspace, sessionNum) {
  try {
    return JSON.parse(fs.readFileSync(metaFile(workspace, String(sessionNum)), "utf-8"));
  } catch { return {}; }
}

function writeMeta(workspace, sessionNum, meta) {
  const dir = historyDir(workspace);
  fs.mkdirSync(dir, { recursive: true });
  const dest = metaFile(workspace, String(sessionNum));
  const tmp = dest + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
  fs.renameSync(tmp, dest);
}

/** Discover session numbers from files on disk. */
function discoverSessions(workspace) {
  const dir = historyDir(workspace);
  try {
    return fs.readdirSync(dir)
      .filter(f => /^\d+\.json$/.test(f))
      .map(f => parseInt(f, 10))
      .sort((a, b) => a - b);
  } catch { return []; }
}

// Workspace-state reference (injected via init())
let workspaceStateRef = null;

function init({ workspaceState }) {
  workspaceStateRef = workspaceState;
}

// --- Relay management ---

const RELAY_DIR = PATHS_RELAY_DIR;
const RELAY_DAEMON = path.join(__dirname, "relay-daemon.js");

/** Relay directory name: workspace for session 1, workspace__s{N} for N>1. */
function relayDirName(workspace, sessionNum) {
  const n = sessionNum || 1;
  return n > 1 ? `${workspace}__s${n}` : workspace;
}

/** Parse a relay directory name back to { workspace, sessionNum }. */
function parseRelayDirName(name) {
  const m = name.match(/^(.+)__s(\d+)$/);
  return m ? { workspace: m[1], sessionNum: Number(m[2]) } : { workspace: name, sessionNum: 1 };
}

function relayPaths(workspace, sessionNum) {
  const dir = path.join(RELAY_DIR, relayDirName(workspace, sessionNum));
  return {
    dir,
    socket: path.join(dir, "relay.sock"),
    log:    path.join(dir, "events.log"),
    pid:    path.join(dir, "relay.pid"),
  };
}

/** True if the relay pid file exists and that process is still alive and is actually our relay daemon. */
function isRelayAlive(workspace, sessionNum) {
  const rp = relayPaths(workspace, sessionNum);
  try {
    const p = parseInt(fs.readFileSync(rp.pid, "utf-8").trim(), 10);
    if (!p) return false;
    process.kill(p, 0); // throws if process not found
    // Verify the socket file also exists — if the PID is alive but socket is
    // gone, it's a recycled PID from an unrelated process.
    if (!fs.existsSync(rp.socket)) {
      // Stale PID file — clean it up
      try { fs.unlinkSync(rp.pid); } catch {}
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawn the relay daemon for a workspace (detached, unreffed).
 * Returns when the socket is ready (polls up to 5 s).
 */
async function startRelay(workspace, sessionNum, workspacePath, bin, args, env, initMsg, closeStin) {
  const rp = relayPaths(workspace, sessionNum);
  fs.mkdirSync(rp.dir, { recursive: true });

  // Write initial message to a temp file so env doesn't have size limits
  let initFile = "";
  if (initMsg) {
    initFile = path.join(rp.dir, "init.tmp");
    fs.writeFileSync(initFile, initMsg);
  }

  // Clean up stale log from previous run
  try { fs.unlinkSync(rp.log); } catch {}

  const relayEnv = {
    ...env,
    CLAUDECODE:        "",  // ensure Claude CLI doesn't think it's nested
    RELAY_SOCKET:      rp.socket,
    RELAY_LOG:         rp.log,
    RELAY_PID:         rp.pid,
    RELAY_BIN:         bin,
    RELAY_ARGS:        JSON.stringify(args),
    RELAY_CWD:         workspacePath,
    RELAY_INIT_FILE:   initFile,
    RELAY_CLOSE_STDIN: closeStin ? "1" : "0",
  };
  if (env.ANTHROPIC_API_KEY) relayEnv.RELAY_APIKEY = env.ANTHROPIC_API_KEY;

  // Capture daemon stderr to a file for debugging (detached processes can't use pipes)
  const daemonStderrPath = path.join(rp.dir, "daemon.stderr");
  const daemonStderrFd = fs.openSync(daemonStderrPath, "w");
  const proc = spawn(process.execPath, [RELAY_DAEMON], {
    detached: true,
    stdio: ["ignore", "ignore", daemonStderrFd],
    env: relayEnv,
  });
  proc.unref();
  fs.closeSync(daemonStderrFd);
  log(`relay started pid=${proc.pid} workspace=${workspace}`);

  // Poll until the socket is actually accepting connections (up to 5 s).
  // fs.existsSync is insufficient — the file appears before listen() completes.
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (fs.existsSync(rp.socket)) {
      const ready = await new Promise(resolve => {
        const probe = net.connect(rp.socket, () => { probe.destroy(); resolve(true); });
        probe.on("error", () => resolve(false));
      });
      if (ready) return rp;
    }
  }
  throw new Error(`relay socket never appeared for workspace=${workspace}`);
}

/**
 * Connect to the relay socket and return a handle with the same interface
 * as the old sendMessage return value (onEvent / onDone / onError / kill).
 *
 * Events before relay_replay_end are replay events — they are NOT emitted
 * to the onEvent callback (history already recovered separately).  Only
 * live events (after the sentinel) are emitted.  Pass replayCallback to
 * receive replay events (used by reconnectActiveRelays to rebuild history).
 */
function connectRelay(workspace, { sessionNum, replayCallback, replayDoneCallback } = {}) {
  const sNum = sessionNum || currentSessionNum(workspace);
  const pKey = partialKey(workspace, sNum);
  const rp = relayPaths(workspace, sNum);
  const socket = new net.Socket();

  let eventCallback = null;
  let doneCallback  = null;
  let errorCallback = null;
  let replayDone    = false;
  let pendingControlRequest = null; // stashed during replay, re-emitted after

  const handle = {
    onEvent(cb)  { eventCallback = cb; },
    onDone(cb)   { doneCallback  = cb; },
    onError(cb)  { errorCallback = cb; },
    get socket() { return socket; },
    kill() {
      // Kill relay process, which kills Claude and cleans up
      try {
        const p = parseInt(fs.readFileSync(rp.pid, "utf-8").trim(), 10);
        if (p) process.kill(p, "SIGTERM");
      } catch {}
      socket.destroy();
      deleteRelay(workspace, sNum);
    },
    /** Flush accumulated content from the previous turn (called before appending a new user message). */
    flushTurn() {
      if (eventCallback) {
        eventCallback({ type: "result", stats: {} });
      }
      partialStreams.delete(pKey);
      try { fs.unlinkSync(streamLogPath(workspace, sNum)); } catch {}
    },
  };

  // Heartbeat watchdog: if we don't receive any data for 45s (relay sends
  // heartbeats every 15s), the relay is hung — force disconnect.
  let heartbeatTimer = null;
  function resetHeartbeat() {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      logErr(`relay heartbeat timeout workspace=${workspace} — closing socket`);
      socket.destroy(new Error("relay heartbeat timeout"));
    }, 45000);
    heartbeatTimer.unref();
  }

  // Register immediately so isActive() returns true as soon as we start connecting.
  // Node.js socket writes before connect are buffered and flushed on connect.
  setRelay(workspace, sNum, { handle, killed: false, startedAt: Date.now() });

  socket.connect(rp.socket, () => {
    log(`relay connected workspace=${workspace}`);
    resetHeartbeat();
  });

  const rl = readline.createInterface({ input: socket });
  rl.on("line", (line) => {
    const t = line.trim();
    if (!t) return;
    resetHeartbeat(); // any data = relay is alive
    let raw;
    try { raw = JSON.parse(t); } catch { return; }

    // Heartbeat ping — just resets the timer above, no further processing needed
    if (raw.type === "relay_heartbeat") return;

    if (!replayDone) {
      if (raw.type === "relay_replay_end") {
        replayDone = true;
        log(`relay replay done workspace=${workspace}`);
        // If there's accumulated text from an in-progress turn (no `result`
        // during replay), emit a seed event so the server's onEvent handler
        // starts with the pre-restart content instead of empty string.
        const seedText = partialStreams.get(pKey);
        if (seedText && eventCallback) {
          eventCallback({ type: "_replay_seed", _assistantText: seedText });
        }
        if (replayDoneCallback) replayDoneCallback();
        // Re-emit any pending control_request that was captured during replay.
        // Claude is blocked waiting for this response, and the original request
        // was lost because replayCallback doesn't forward it to the frontend.
        if (pendingControlRequest && eventCallback) {
          log(`re-emitting pending control_request after replay workspace=${workspace} req=${pendingControlRequest.request_id}`);
          eventCallback(pendingControlRequest);
        }
        return;
      }
      // Capture control_request during replay — Claude is blocked on this and
      // we need to re-emit it after replay ends so the frontend can respond.
      // Only the last one matters (earlier ones were already answered).
      if (raw.type === "control_request") {
        const req = raw.request || {};
        if (req.subtype === "can_use_tool") {
          pendingControlRequest = {
            type: "permission_request",
            request_id: raw.request_id,
            tool_name: req.tool_name,
            tool_input: req.input || {},
          };
        }
        // Don't pass to replayCallback — it doesn't handle control_requests
        return;
      }
      // Rebuild partial buffer from replayed events so stream-partial works
      // after a server restart. Result events clear the buffer, so only the
      // current in-progress turn (if any) survives replay.
      const replayNorm = normalizeEvent(raw);
      for (const evt of replayNorm) {
        if (evt.type === "message" && (evt.role === "assistant" || !evt.role)) {
          partialStreams.set(pKey, (partialStreams.get(pKey) || "") + (evt.content || ""));
        } else if (evt.type === "result") {
          partialStreams.delete(pKey);
          // A result after a control_request means it was already answered
          pendingControlRequest = null;
        }
      }
      // Replay event — pass to replayCallback if provided, don't emit to UI
      if (replayCallback) replayCallback(raw);
      return;
    }

    // Live event
    if (raw.type === "relay_stdin_error") {
      log(`relay stdin error workspace=${workspace} session#${sNum}: ${raw.error}`);
      deleteRelay(workspace, sNum);
      partialStreams.delete(pKey);
      if (errorCallback) errorCallback(new Error(raw.error || "claude process has exited"));
      return;
    }

    if (raw.type === "relay_exit") {
      log(`relay exit workspace=${workspace} session#${sNum} code=${raw.code}`);
      deleteRelay(workspace, sNum);
      partialStreams.delete(pKey);
      if (doneCallback) doneCallback({ code: raw.code, stderr: "" });
      // doneCallback persists history — safe to delete stream log now
      try { fs.unlinkSync(streamLogPath(workspace, sNum)); } catch {}
      return;
    }

    // control_request handling (interactive modes)
    if (raw.type === "control_request") {
      const req = raw.request || {};
      log(`control_request workspace=${workspace} subtype=${req.subtype} tool=${req.tool_name || "N/A"} request_id=${raw.request_id}`);
      if (req.subtype === "can_use_tool") {
        const evt = {
          type: "permission_request",
          request_id: raw.request_id,
          tool_name: req.tool_name,
          tool_input: req.input || {},
          description: req.description || "",
          decision_reason: req.decision_reason || "",
        };
        if (eventCallback) eventCallback(evt);
      }
      return;
    }

    // Capture session ID from init event → sidecar metadata
    if (raw.type === "system" && raw.subtype === "init" && raw.session_id) {
      const sNumCurrent = currentSessionNum(workspace);
      const meta = readMeta(workspace, sNumCurrent);
      meta.cliSessionId = raw.session_id;
      if (!meta.createdAt) meta.createdAt = Date.now();
      writeMeta(workspace, sNumCurrent, meta);
      log(`session-id workspace=${workspace} session#${sNumCurrent} sessionId=${raw.session_id}`);
    }

    const normalized = normalizeEvent(raw);
    const logPath = streamLogPath(workspace, sNum);
    for (const evt of normalized) {
      // Write-through: durable log for crash recovery (before processing, so
      // content survives even if the server crashes during eventCallback).
      if (evt.type === "message" || evt.type === "tool_use" || evt.type === "tool_result") {
        try { fs.appendFileSync(logPath, JSON.stringify(evt) + '\n'); } catch {}
      }
      // Keep partial buffer in sync for workspace-switch recovery
      if (evt.type === "message" && (evt.role === "assistant" || !evt.role)) {
        partialStreams.set(pKey, (partialStreams.get(pKey) || "") + (evt.content || ""));
      }
      if (eventCallback) eventCallback(evt);
      // Clean up after eventCallback has persisted (pushHistoryBatch runs inside it)
      if (evt.type === "result") {
        partialStreams.delete(pKey);
        try { fs.unlinkSync(logPath); } catch {}
      }
    }
  });

  let socketErrorFired = false;

  socket.on("error", (err) => {
    socketErrorFired = true;
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    logErr(`relay socket error workspace=${workspace}: ${err.message}`);
    deleteRelay(workspace, sNum);
    partialStreams.delete(pKey);
    if (errorCallback) errorCallback(err);
  });

  socket.on("close", () => {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    deleteRelay(workspace, sNum);
    // If error already fired callbacks, don't double-fire.
    // But if the socket closed cleanly without error (relay exited without
    // sending relay_exit, or crashed), we must still signal done so the
    // streaming flag gets cleared.
    if (!socketErrorFired) {
      partialStreams.delete(pKey);
      if (doneCallback) doneCallback({ code: null, stderr: "relay socket closed" });
    }
  });

  return handle;
}

// workspace → Map<sessionNum, { handle, killed, startedAt }>
const activeRelays = new Map();

function getRelay(workspace, sessionNum) {
  const inner = activeRelays.get(workspace);
  return inner ? inner.get(sessionNum) : undefined;
}

function setRelay(workspace, sessionNum, entry) {
  if (!activeRelays.has(workspace)) activeRelays.set(workspace, new Map());
  activeRelays.get(workspace).set(sessionNum, entry);
}

function deleteRelay(workspace, sessionNum) {
  const inner = activeRelays.get(workspace);
  if (inner) {
    inner.delete(sessionNum);
    if (inner.size === 0) activeRelays.delete(workspace);
  }
}

/** Get the session number of any active relay for a workspace (or null). */
function getActiveSessionNum(workspace) {
  const inner = activeRelays.get(workspace);
  if (inner && inner.size > 0) return inner.keys().next().value;
  return null;
}

// In-memory partial stream buffer — tracks accumulated assistant text for the
// current turn so clients can display it when switching back mid-stream.
const partialStreams = new Map(); // "workspace\0sessionNum" → string

function partialKey(workspace, sessionNum) {
  return `${workspace}\0${sessionNum || 1}`;
}

function getStreamPartial(workspace, sessionNum) {
  const { sNum } = findRelay(workspace, sessionNum);
  return partialStreams.get(partialKey(workspace, sNum)) || null;
}

/** Deterministic log path for an active stream (per workspace+session). */
function streamLogPath(workspace, sessionNum) {
  const n = sessionNum || 1;
  const suffix = n > 1 ? `-s${n}` : "";
  return path.join(CONVERSATIONS_DIR, `stream-claude-chat-${workspace}${suffix}.jsonl`);
}

// --- One-time migration from old registry to sidecar files ---
(function migrateData() {
  // Migrate old monolithic history file
  if (fs.existsSync(LEGACY_HISTORY_FILE)) {
    try {
      const old = JSON.parse(fs.readFileSync(LEGACY_HISTORY_FILE, "utf-8"));
      for (const [ws, val] of Object.entries(old)) {
        const sessionMap = Array.isArray(val) ? { "1": val } : val;
        for (const [num, messages] of Object.entries(sessionMap)) {
          if (Array.isArray(messages) && messages.length > 0) {
            const dest = historyFile(ws, num);
            if (!fs.existsSync(dest)) writeSessionHistory(ws, num, messages);
          }
        }
      }
      fs.renameSync(LEGACY_HISTORY_FILE, LEGACY_HISTORY_FILE + ".migrated");
      log("migrated history to per-workspace/per-session files");
    } catch (e) {
      logErr("history migration failed:", e.message);
    }
  }

  // Migrate old claude-chat-sessions.json → per-session .meta.json sidecars
  if (fs.existsSync(SESSIONS_FILE_OLD)) {
    try {
      const oldSessions = JSON.parse(fs.readFileSync(SESSIONS_FILE_OLD, "utf-8"));
      for (const [ws, entry] of Object.entries(oldSessions)) {
        if (!entry || typeof entry !== "object") continue;
        // Handle old format: sessions[ws] = "uuid" (string)
        const sessionMap = typeof entry === "string"
          ? { "1": entry }
          : (entry.sessions || {});
        const taskIdsMap = entry.taskIds || entry.beadIds || {};

        for (const [num, cliSessionId] of Object.entries(sessionMap)) {
          const existing = readMeta(ws, num);
          if (!existing.cliSessionId && cliSessionId) {
            existing.cliSessionId = cliSessionId;
          }
          const tids = taskIdsMap[num] || [];
          if (tids.length && !existing.taskIds?.length) {
            existing.taskIds = tids;
          }
          writeMeta(ws, num, existing);
        }
      }
      fs.renameSync(SESSIONS_FILE_OLD, SESSIONS_FILE_OLD + ".migrated");
      log("migrated claude-chat-sessions.json to per-session .meta.json sidecars");
    } catch (e) {
      logErr("sessions migration failed:", e.message);
    }
  }
})();

/** Get the current session number for a workspace (default 1). */
function currentSessionNum(workspace) {
  if (workspaceStateRef) {
    const ws = workspaceStateRef.getWorkspace(workspace);
    if (ws.sessionNum) return ws.sessionNum;
  }
  // Fallback: highest numbered session on disk
  const nums = discoverSessions(workspace);
  return nums.length ? Math.max(...nums) : 1;
}

/** Get the CLI session ID for the current (or specified) session number. */
function getCliSessionId(workspace, num) {
  const n = num || currentSessionNum(workspace);
  const meta = readMeta(workspace, n);
  return meta.cliSessionId || null;
}

function pushHistory(workspace, role, content, meta, sessionNum) {
  const num = String(sessionNum || currentSessionNum(workspace));
  const messages = readSessionHistory(workspace, num);
  const entry = { role, content, ts: Date.now() };
  if (meta && meta.sender) entry.sender = meta.sender;
  messages.push(entry);
  writeSessionHistory(workspace, num, messages);
}

/** Save a batch of messages in a single read+write (efficient for multi-event turns). */
function pushHistoryBatch(workspace, messages, sessionNum) {
  const num = String(sessionNum || currentSessionNum(workspace));
  const existing = readSessionHistory(workspace, num);
  const ts = Date.now();
  writeSessionHistory(workspace, num, [
    ...existing,
    ...messages.map(m => ({ ...m, ts: m.ts || ts })),
  ]);
}

/** Return the mtime of the most recently written session file for a workspace. */
function getLastMessageTime(workspace) {
  try {
    const dir = historyDir(workspace);
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
    if (!files.length) return 0;
    return Math.max(...files.map(f => fs.statSync(path.join(dir, f)).mtimeMs));
  } catch { return 0; }
}

function getHistory(workspace, sessionNum) {
  const num = sessionNum || currentSessionNum(workspace);
  const history = readSessionHistory(workspace, num);

  // Merge in-progress stream log content so the client always sees the latest
  // data — even if a "result" event hasn't fired yet (text-only turns, mid-stream).
  const logPath = streamLogPath(workspace, num);
  try {
    const raw = fs.readFileSync(logPath, "utf-8");
    if (raw) {
      let assistantText = "";
      const toolBatch = [];
      for (const line of raw.split("\n")) {
        if (!line) continue;
        const evt = JSON.parse(line);
        if (evt.type === "message" && (evt.role === "assistant" || !evt.role)) {
          assistantText += evt.content || "";
        } else if (evt.type === "tool_use") {
          toolBatch.push({
            role: "tool_use",
            content: JSON.stringify({ tool_name: evt.tool_name, tool_id: evt.tool_id, parameters: evt.parameters || {} }),
            ts: Date.now(),
          });
        } else if (evt.type === "tool_result") {
          const out = evt.output || "";
          toolBatch.push({
            role: "tool_result",
            content: JSON.stringify({ tool_id: evt.tool_id, status: evt.status || "success", output: out.length > 3000 ? out.slice(0, 3000) + "\n...(truncated)" : out }),
            ts: Date.now(),
          });
        }
      }
      if (toolBatch.length > 0 || assistantText) {
        history.push(...toolBatch);
        if (assistantText) history.push({ role: "assistant", content: assistantText, ts: Date.now() });
      }
    }
  } catch {}

  return history;
}

function clearHistory(workspace) {
  try { fs.rmSync(historyDir(workspace), { recursive: true, force: true }); } catch { /* ignore */ }
}

// --- Binary discovery ---

let cachedBinPath = null;

function findClaudeBin(config) {
  if (cachedBinPath && fs.existsSync(cachedBinPath)) return cachedBinPath;

  if (config && config.claudeChatBin && fs.existsSync(config.claudeChatBin)) {
    cachedBinPath = config.claudeChatBin;
    return cachedBinPath;
  }

  const { execSync } = require("child_process");
  try {
    const found = execSync("which claude 2>/dev/null", { encoding: "utf-8" }).trim();
    if (found) { cachedBinPath = found; return cachedBinPath; }
  } catch {}

  const home = require("os").homedir();
  const candidates = [
    path.join(home, ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  const found = candidates.find((p) => fs.existsSync(p)) || null;
  if (found) cachedBinPath = found;
  return found;
}

function isInstalled(config) {
  return !!findClaudeBin(config);
}

function getBinPath(config) {
  return findClaudeBin(config);
}

// --- Event normalization ---

/**
 * Normalize a Claude CLI JSONL event into the Gemini-compatible format
 * that the frontend already handles.
 * Returns an array of normalized events (one Claude event may produce multiple).
 */
function normalizeEvent(raw) {
  const events = [];

  switch (raw.type) {
    case "system":
      if (raw.subtype === "init") {
        events.push({
          type: "init",
          session_id: raw.session_id,
          model: raw.model,
        });
      } else if (raw.subtype === "status") {
        // Permission mode change or other status update
        events.push({
          type: "system_status",
          status: raw.status,
          permissionMode: raw.permissionMode,
        });
      } else if (raw.subtype === "compact_boundary") {
        const meta = raw.compact_metadata || {};
        events.push({
          type: "compact_boundary",
          trigger: meta.trigger,
          pre_tokens: meta.pre_tokens,
          post_tokens: meta.post_tokens,
        });
      } else if (raw.subtype === "task_started") {
        events.push({
          type: "task_started",
          task_id: raw.task_id,
          description: raw.description || "",
          tool_use_id: raw.tool_use_id,
        });
      } else if (raw.subtype === "task_progress") {
        events.push({
          type: "task_progress",
          task_id: raw.task_id,
          usage: raw.usage,
          tool_name: raw.tool_name,
        });
      } else if (raw.subtype === "task_notification") {
        events.push({
          type: "task_notification",
          task_id: raw.task_id,
          status: raw.status,
          summary: raw.summary || "",
          tool_use_id: raw.tool_use_id,
          usage: raw.usage,
          duration_ms: raw.duration_ms,
        });
      }
      break;

    case "assistant": {
      // Assistant messages contain content blocks: text, tool_use, thinking
      const msg = raw.message;
      if (!msg || !msg.content) break;
      const parentId = raw.parent_tool_use_id || null;

      for (const block of msg.content) {
        if (block.type === "thinking" && block.thinking) {
          const evt = { type: "thinking", content: block.thinking };
          if (parentId) evt.parent_tool_use_id = parentId;
          events.push(evt);
        } else if (block.type === "text" && block.text) {
          const evt = { type: "message", role: "assistant", content: block.text, delta: true };
          if (parentId) evt.parent_tool_use_id = parentId;
          events.push(evt);
        } else if (block.type === "tool_use") {
          const evt = {
            type: "tool_use",
            tool_name: block.name,
            tool_id: block.id,
            parameters: block.input || {},
          };
          if (parentId) evt.parent_tool_use_id = parentId;
          events.push(evt);
        }
      }

      // Extract per-turn usage from the assistant message — this is the real
      // context window fill signal.  input_tokens from the API only counts
      // non-cached tokens; the FULL context sent to the model is the sum of
      // input_tokens + cache_read + cache_creation.
      if (msg.usage) {
        const u = msg.usage;
        const inputNonCached = u.input_tokens || 0;
        const cacheRead = u.cache_read_input_tokens || 0;
        const cacheCreation = u.cache_creation_input_tokens || 0;
        const stats = {};
        stats.input_tokens = inputNonCached + cacheRead + cacheCreation;
        stats.output_tokens = u.output_tokens || 0;
        stats.total_tokens = stats.input_tokens + stats.output_tokens;
        events.push({ type: "usage", stats });
      }
      break;
    }

    case "user": {
      // User messages contain tool_result content blocks.
      // IMPORTANT: tool_result events must be emitted BEFORE the synthetic
      // "result" event.  The server broadcasts events in order — if "result"
      // (which triggers "done") is emitted first, the client resets streaming
      // state before tool pills are finalized, leaving them stuck as "running"
      // in the originating window.  Emitting tool_results first also ensures
      // they are included in the same history-persistence batch as the
      // preceding tool_use events.
      const msg = raw.message;
      if (msg && msg.content) {
        const parentId = raw.parent_tool_use_id || null;

        for (const block of msg.content) {
          if (block.type === "tool_result") {
            const toolResult = raw.tool_use_result;
            let output = "";
            if (toolResult) {
              // Read tool: file.content
              if (toolResult.file && toolResult.file.content) {
                output = toolResult.file.content;
              // Bash tool: stdout + stderr
              } else if (toolResult.stdout !== undefined) {
                output = (toolResult.stdout || "") + (toolResult.stderr ? "\n" + toolResult.stderr : "");
              } else if (typeof toolResult === "string") {
                output = toolResult;
              } else if (toolResult.content) {
                output = typeof toolResult.content === "string" ? toolResult.content : JSON.stringify(toolResult.content);
              }
            }
            // Fall back to the block content if tool_use_result is empty
            if (!output && block.content) {
              if (typeof block.content === "string") {
                output = block.content;
              } else if (Array.isArray(block.content)) {
                output = block.content
                  .filter(b => b.type === "text")
                  .map(b => b.text || "")
                  .join("\n")
                  .trim();
                if (!output) output = JSON.stringify(block.content);
              } else {
                output = JSON.stringify(block.content);
              }
            }
            const evt = {
              type: "tool_result",
              tool_id: block.tool_use_id,
              tool_name: raw.tool_name || "",
              status: block.is_error ? "error" : "success",
              output,
            };
            if (parentId) evt.parent_tool_use_id = parentId;
            events.push(evt);
          }
        }
      }

      // Synthetic "result" — the previous assistant turn is complete (tool results
      // are about to be sent back to the model for the next turn).
      // Has empty stats {} so the server can distinguish it from a real final result
      // (which always carries cost/duration/token stats) and skip broadcasting "done".
      events.push({ type: "result", stats: {} });
      break;
    }

    case "rate_limit_event": {
      const info = raw.rate_limit_info;
      if (info) {
        const status = info.status === "allowed" ? "OK" : info.status;
        const resetTime = info.resetsAt ? new Date(info.resetsAt * 1000).toLocaleTimeString() : "";
        const msg = status === "OK"
          ? ""
          : `Rate limited (${info.rateLimitType || "unknown"})${resetTime ? ` — resets at ${resetTime}` : ""}`;
        if (msg) {
          events.push({ type: "status", message: msg });
        }
      }
      break;
    }

    case "result": {
      const stats = {};
      if (raw.total_cost_usd !== undefined) stats.cost = raw.total_cost_usd;
      if (raw.duration_ms !== undefined) stats.duration_ms = raw.duration_ms;
      if (raw.num_turns !== undefined) stats.turns = raw.num_turns;
      // NOTE: result.usage contains CUMULATIVE session totals (across all API
      // calls), NOT per-turn values.  Do NOT use it for context fill tracking.
      // Use result.usage only for cumulative output_tokens (session cost).
      if (raw.usage) {
        const u = raw.usage;
        stats.output_tokens = u.output_tokens || 0;
        const inputTotal = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        stats.total_tokens = inputTotal + stats.output_tokens;
      }
      // Extract context window size from modelUsage (per-model breakdown)
      if (raw.modelUsage) {
        for (const model of Object.keys(raw.modelUsage)) {
          const mu = raw.modelUsage[model];
          if (mu.contextWindow) {
            stats.context_window_size = mu.contextWindow;
            break; // use first model's context window
          }
        }
      }
      const evt = { type: "result", stats };
      // Include error subtype for max_turns, budget, execution errors
      if (raw.subtype && raw.subtype !== "success") {
        evt.subtype = raw.subtype;
        if (raw.errors) evt.errors = raw.errors;
      }
      events.push(evt);
      break;
    }

    case "tool_progress": {
      events.push({
        type: "tool_progress",
        tool_use_id: raw.tool_use_id,
        tool_name: raw.tool_name || "",
        elapsed_time_seconds: raw.elapsed_time_seconds,
        parent_tool_use_id: raw.parent_tool_use_id || null,
      });
      break;
    }

    default:
      break;
  }

  return events;
}

// --- Direct API path (used when images are attached) ---

/**
 * Write image buffers to temp files so the Claude CLI can read them.
 * Returns an array of absolute file paths; caller is responsible for cleanup.
 */
function writeImageTempFiles(workspace, images) {
  const os = require("os");
  const dir = path.join(os.tmpdir(), "klaudii-uploads");
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return images.map((img, i) => {
    const ext = (img.mediaType || "image/png").split("/")[1].replace("jpeg", "jpg") || "png";
    const filePath = path.join(dir, `${workspace.replace(/[^a-z0-9]/gi, "_")}-${Date.now()}-${i}.${ext}`);
    fs.writeFileSync(filePath, Buffer.from(img.data, "base64"));
    return filePath;
  });
}

// --- Dead code kept for reference only — direct API path replaced by temp-file CLI approach ---
// The direct API path was removed because it bypassed all CLI benefits:
// session persistence, tool use, agent mode, and auth via claude CLI.
// Track pending direct-API requests so stopProcess can abort them.
const directRequests = new Map(); // workspace → { abort }

/**
 * @deprecated Use startChat with images instead — images now go via temp files + CLI.
 */
function sendMessageDirect(workspace, workspacePath, userMessage, config, opts) {
  const https = require("https");

  const apiKey = opts.apiKey || config.claudeApiKey;
  if (!apiKey) {
    throw new Error(
      "Anthropic API key required for image attachments — add a Claude API key in workspace settings"
    );
  }

  // Build conversation history
  const history = getHistory(workspace);
  const messages = history.map((h) => ({ role: h.role, content: h.content }));

  // Build new user content block: images first, then text
  const userContent = [];
  for (const img of opts.images || []) {
    userContent.push({
      type: "image",
      source: { type: "base64", media_type: img.mediaType, data: img.data },
    });
  }
  userContent.push({ type: "text", text: userMessage });
  messages.push({ role: "user", content: userContent });

  const model = opts.model || "claude-opus-4-6";
  const reqBody = JSON.stringify({ model, messages, max_tokens: 8096, stream: true });

  const reqOptions = {
    hostname: "api.anthropic.com",
    path: "/v1/messages",
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "content-length": Buffer.byteLength(reqBody),
    },
  };

  let eventCallback = null;
  let doneCallback = null;
  let errorCallback = null;
  let aborted = false;

  const handle = {
    onEvent(cb) { eventCallback = cb; },
    onDone(cb)  { doneCallback = cb; },
    onError(cb) { errorCallback = cb; },
    kill() {
      aborted = true;
      directRequests.delete(workspace);
      req.destroy();
    },
  };

  const req = https.request(reqOptions, (res) => {
    if (res.statusCode !== 200) {
      let errBody = "";
      res.on("data", (d) => { errBody += d; });
      res.on("end", () => {
        directRequests.delete(workspace);
        if (errorCallback) {
          try {
            const parsed = JSON.parse(errBody);
            errorCallback(new Error(parsed.error?.message || `API error ${res.statusCode}`));
          } catch {
            errorCallback(new Error(`API error ${res.statusCode}: ${errBody.slice(0, 200)}`));
          }
        }
      });
      return;
    }

    let buf = "";

    res.on("data", (chunk) => {
      if (aborted) return;
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop(); // keep incomplete trailing line

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;
        try {
          const ev = JSON.parse(data);
          if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
            const text = ev.delta.text || "";
            if (text && eventCallback) {
              eventCallback({ type: "message", role: "assistant", content: text });
            }
          }
        } catch { /* skip malformed SSE lines */ }
      }
    });

    res.on("end", () => {
      directRequests.delete(workspace);
      if (!aborted && doneCallback) doneCallback({ code: 0, stderr: "" });
    });

    res.on("error", (err) => {
      directRequests.delete(workspace);
      if (errorCallback) errorCallback(err);
    });
  });

  req.on("error", (err) => {
    directRequests.delete(workspace);
    if (errorCallback) errorCallback(err);
  });

  req.write(reqBody);
  req.end();

  directRequests.set(workspace, handle);
  log(`direct-api workspace=${workspace} model=${model} images=${opts.images?.length || 0}`);
  return handle;
}

// --- Start a new chat (spawns a fresh CLI process) ---

async function startChat(workspace, workspacePath, userMessage, config, opts = {}) {
  const sNum = currentSessionNum(workspace);
  // Only stop the relay for the current session, not all sessions
  stopSessionRelay(workspace, sNum);

  // Write any attached images to temp files so the CLI can read them.
  let imagePaths = [];
  if (opts.images && opts.images.length > 0) {
    try {
      imagePaths = writeImageTempFiles(workspace, opts.images);
      log(`wrote ${imagePaths.length} image temp file(s) for workspace=${workspace}`);
    } catch (err) {
      log(`image temp write failed: ${err.message} — sending without images`);
    }
  }

  let fullMessage = imagePaths.length
    ? `[The user has attached ${imagePaths.length} image file(s). Please read each one using the Read tool before responding.]\n${imagePaths.map((p) => `- ${p}`).join("\n")}\n\n${userMessage}`
    : userMessage;

  const claudeBin = findClaudeBin(config);
  if (!claudeBin) {
    throw new Error("Claude CLI not found — install from https://docs.anthropic.com/en/docs/claude-code");
  }

  const permMode = opts.permissionMode || "bypassPermissions";

  const args = ["--output-format", "stream-json", "--input-format", "stream-json", "--verbose",
                "--permission-prompt-tool", "stdio", "--permission-mode", permMode];

  if (opts.model) args.push("--model", opts.model);
  if (opts.thinking) args.push("--effort", "high");

  // Always start fresh — no --resume. Inject conversation history as a briefing
  // so the new Claude instance has continuity from previous sessions.
  const briefing = generateBriefing(workspace, workspacePath);
  if (briefing) {
    log(`startChat: injecting briefing as system prompt for workspace=${workspace} briefingLen=${briefing.length}`);
    args.push("--append-system-prompt", briefing);
  }

  const env = { ...process.env };
  delete env.CLAUDECODE;
  if (opts.apiKey) env.ANTHROPIC_API_KEY = opts.apiKey;

  // Build the initial stdin payload (always stream-json format)
  const initMsg = JSON.stringify({
    type: "user",
    session_id: "",
    message: { role: "user", content: fullMessage },
  }) + "\n";

  log(`spawn workspace=${workspace} bin=${claudeBin} model=${opts.model || "auto"} permMode=${permMode} thinking=${!!opts.thinking} images=${imagePaths.length}`);

  // Start relay daemon — Claude runs inside it, detached from us (stdin always open)
  const rp = await startRelay(workspace, sNum, workspacePath, claudeBin, args, env, initMsg, false);

  log(`relay ready workspace=${workspace} session#${sNum} socket=${rp.socket}`);

  // Clean up image temp files after relay starts (message already written to init file)
  // We defer cleanup until done to avoid race; relay copies init file before Claude reads it
  const handle = connectRelay(workspace, { sessionNum: sNum });

  // Wrap kill to also clean up images
  const origKill = handle.kill.bind(handle);
  handle.kill = () => {
    origKill();
    for (const p of imagePaths) { try { fs.unlinkSync(p); } catch {} }
  };

  // Also clean up images on done
  const origOnDone = handle.onDone.bind(handle);
  handle.onDone = (cb) => {
    origOnDone(({ code, stderr }) => {
      for (const p of imagePaths) { try { fs.unlinkSync(p); } catch {} }
      cb({ code, stderr });
    });
  };

  return handle;
}

/**
 * Send a proactive control_request to Claude's stdin via the relay socket.
 * Used for model switching, permission mode changes, interrupt, etc.
 * Returns the generated request_id, or null if no active relay.
 */
/** Find the relay for a workspace, trying currentSessionNum first then any active relay. */
function findRelay(workspace, sessionNum) {
  // 1. If caller specified an explicit session, try that first
  if (sessionNum != null) {
    const entry = getRelay(workspace, Number(sessionNum));
    if (entry) return { entry, sNum: Number(sessionNum) };
  }
  // 2. Try workspace-state's current session
  const sNum = currentSessionNum(workspace);
  let entry = getRelay(workspace, sNum);
  if (entry) return { entry, sNum };
  // 3. Fallback: find any active relay for this workspace
  const inner = activeRelays.get(workspace);
  if (inner && inner.size > 0) {
    const [actualNum, actualEntry] = inner.entries().next().value;
    return { entry: actualEntry, sNum: actualNum };
  }
  return { entry: null, sNum };
}

function sendControlRequest(workspace, subtype, payload = {}, sessionNum) {
  const { entry, sNum } = findRelay(workspace, sessionNum);
  if (!entry) {
    log(`sendControlRequest workspace=${workspace} session#=${sNum} subtype=${subtype} no active relay`);
    return null;
  }
  const crypto = require("crypto");
  const requestId = crypto.randomUUID();
  const msg = JSON.stringify({
    type: "control_request",
    request_id: requestId,
    request: { subtype, ...payload },
  });
  log(`sendControlRequest workspace=${workspace} session#${sNum} subtype=${subtype} requestId=${requestId}`);
  try { entry.handle.socket.write(msg + "\n"); } catch (e) { logErr(`sendControlRequest write failed: ${e.message}`); }
  return requestId;
}

function sendControlResponse(workspace, requestId, behavior, updatedInput, sessionNum) {
  const { entry } = findRelay(workspace, sessionNum);
  if (!entry) {
    log(`sendControlResponse workspace=${workspace} session#=${sessionNum} no active relay`);
    return;
  }
  const msg = JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: behavior === "allow"
        ? { behavior: "allow", updatedInput: updatedInput || {} }
        : { behavior: "deny", message: "User denied" },
    },
  });
  log(`sendControlResponse workspace=${workspace} session#=${sessionNum} requestId=${requestId} behavior=${behavior}`);
  try { entry.handle.socket.write(msg + "\n"); } catch (e) { logErr(`sendControlResponse write failed: ${e.message}`); }
}

function sendToolResult(workspace, toolId, content, sessionNum) {
  const { entry } = findRelay(workspace, sessionNum);
  if (!entry) {
    log(`sendToolResult workspace=${workspace} session#=${sessionNum} no active relay`);
    return;
  }
  const msg = JSON.stringify({
    type: "tool_result",
    tool_use_id: toolId,
    content: String(content),
  });
  log(`sendToolResult workspace=${workspace} session#=${sessionNum} tool_id=${toolId} content=${JSON.stringify(content)}`);
  try { entry.handle.socket.write(msg + "\n"); } catch (e) { logErr(`sendToolResult write failed: ${e.message}`); }
}

/** Flush the in-progress turn before killing a relay so accumulated assistant
 *  text and tool events are persisted to history and the stream log is cleaned
 *  up.  Without this, the stale stream log survives and its events get mixed
 *  into the next turn's history, causing message ordering bugs. */
function flushBeforeKill(entry, workspace, sessionNum) {
  if (entry.handle.flushTurn) {
    try { entry.handle.flushTurn(); } catch (e) { logErr(`flushTurn on stop failed (ws=${workspace} s#${sessionNum}): ${e.message}`); }
  }
}

/** Stop a single session's relay for a workspace. */
function stopSessionRelay(workspace, sessionNum) {
  const entry = getRelay(workspace, sessionNum);
  if (entry) {
    log(`stop relay workspace=${workspace} session#${sessionNum}`);
    flushBeforeKill(entry, workspace, sessionNum);
    entry.handle.kill();
  }
}

/** Stop all relays for a workspace (+ abort direct-API requests). */
function stopProcess(workspace, sessionNum) {
  // Abort any pending direct-API request first
  const direct = directRequests.get(workspace);
  if (direct) direct.kill();

  if (sessionNum !== undefined) {
    stopSessionRelay(workspace, sessionNum);
  } else {
    const inner = activeRelays.get(workspace);
    if (inner) {
      for (const [sNum, entry] of [...inner.entries()]) {
        log(`stop relay workspace=${workspace} session#${sNum}`);
        flushBeforeKill(entry, workspace, sNum);
        entry.handle.kill();
      }
    }
  }
}

function getSessionId(workspace) {
  return getCliSessionId(workspace);
}

/** True if ANY session in this workspace has an active relay. */
function isActive(workspace) {
  return activeRelays.has(workspace);
}

/** True if a specific session has an active relay (in-memory or on-disk). */
function isSessionActive(workspace, sessionNum) {
  return !!getRelay(workspace, sessionNum) || isRelayAlive(workspace, sessionNum);
}

/** Return info about all active relays for a workspace (for the API). */
function getActiveRelayInfo(workspace) {
  const inner = activeRelays.get(workspace);
  if (!inner) return [];
  return [...inner.entries()].map(([sNum, entry]) => {
    const rp = relayPaths(workspace, sNum);
    let pid = null;
    try { pid = parseInt(fs.readFileSync(rp.pid, "utf-8").trim(), 10); } catch {}
    return { sessionNum: sNum, pid, startedAt: entry.startedAt || null };
  });
}

/** Send a message to Claude's active relay session via the Unix socket. */
function sendMessage(workspace, message, sessionNum) {
  const { entry, sNum } = findRelay(workspace, sessionNum);
  if (!entry) { logErr(`sendMessage: no active relay for workspace=${workspace} session#${sNum}`); return false; }
  // Flush accumulated content from the previous turn so it's persisted before
  // the new message.  Without this, text-only responses (no tool use) never
  // trigger a "result" event and the assistant text sits in memory unpersisted.
  if (entry.handle.flushTurn) entry.handle.flushTurn();
  const line = JSON.stringify({ type: "user", message: { role: "user", content: message } });
  try { entry.handle.socket.write(line + "\n"); return true; }
  catch (e) { logErr(`sendMessage write failed: ${e.message}`); return false; }
}

/** Return session metadata for the API (includes per-session activity info). */
function getSessions(workspace) {
  const nums = discoverSessions(workspace);
  if (!nums.length) return { current: null, sessions: [], taskIds: {} };

  const cur = currentSessionNum(workspace);
  const details = nums.map(num => {
    let lastActivity = 0;
    try {
      lastActivity = fs.statSync(historyFile(workspace, String(num))).mtimeMs;
    } catch {}
    return {
      num,
      lastActivity,
      active: isSessionActive(workspace, num),
    };
  });
  // Sort by lastActivity descending (most recent first)
  details.sort((a, b) => b.lastActivity - a.lastActivity);

  // Collect taskIds from sidecar metadata
  const taskIds = {};
  for (const num of nums) {
    const meta = readMeta(workspace, num);
    if (meta.taskIds && meta.taskIds.length) {
      taskIds[String(num)] = meta.taskIds;
    }
  }

  return { current: cur, sessions: details, taskIds };
}

/**
 * Tag a chat session with a task ID.
 * @param {string} workspace
 * @param {number|string} sessionNum - session number (defaults to current)
 * @param {string} taskId
 */
function tagSessionWithTask(workspace, sessionNum, taskId) {
  const num = sessionNum || currentSessionNum(workspace);
  const meta = readMeta(workspace, num);
  if (!meta.taskIds) meta.taskIds = [];
  if (!meta.taskIds.includes(taskId)) {
    meta.taskIds.push(taskId);
    writeMeta(workspace, num, meta);
  }
}

/**
 * Find all workspaces+sessions that worked on a given task ID.
 * @returns {{ workspace: string, sessionNum: number, cliSessionId: string|null }[]}
 */
function getSessionsForTask(taskId) {
  const results = [];
  let workspaces;
  try {
    workspaces = fs.readdirSync(CONVERSATIONS_DIR).filter(f => {
      const full = path.join(CONVERSATIONS_DIR, f, "claude-local");
      try { return fs.statSync(full).isDirectory(); } catch { return false; }
    });
  } catch { return []; }

  for (const workspace of workspaces) {
    const nums = discoverSessions(workspace);
    for (const num of nums) {
      const meta = readMeta(workspace, num);
      if (meta.taskIds && meta.taskIds.includes(taskId)) {
        results.push({
          workspace,
          sessionNum: num,
          cliSessionId: meta.cliSessionId || null,
        });
      }
    }
  }
  return results;
}

/** Create a new session (increment counter, preserve old sessions). */
function newSession(workspace, { switchTo = true } = {}) {
  const nums = discoverSessions(workspace);
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  // Create empty history file + metadata sidecar
  writeSessionHistory(workspace, next, []);
  writeMeta(workspace, next, { cliSessionId: null, taskIds: [], createdAt: Date.now() });
  // Update workspace-state to point to the new session (unless caller opts out,
  // e.g. auto-handoff creates the session but shouldn't hijack the user's view)
  if (switchTo && workspaceStateRef) {
    workspaceStateRef.setState(workspace, { sessionNum: next });
  }
  log(`new-session workspace=${workspace} session#${next} switchTo=${switchTo}`);
  return next;
}

/** Switch to an existing session number. */
function setCurrentSession(workspace, num) {
  const nums = discoverSessions(workspace);
  if (!nums.includes(num)) return false;
  if (workspaceStateRef) {
    workspaceStateRef.setState(workspace, { sessionNum: num });
  }
  log(`switch-session workspace=${workspace} session#${num}`);
  return true;
}

/** Delete everything for a workspace (nuclear option). */
function clearSession(workspace) {
  clearHistory(workspace);
  stopProcess(workspace);
}

// --- Auth status ---

let authStatus = { installed: false, loggedIn: false, error: null };
let authCheckInterval = null;

function checkAuth(config) {
  const bin = findClaudeBin(config);
  if (!bin) {
    authStatus = { installed: false, loggedIn: false, binPath: null, error: null };
    log("auth-check: not installed");
    return Promise.resolve(authStatus);
  }

  const start = Date.now();
  log("auth-check: starting");

  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    // Inject stored API key so the CLI recognizes it as authenticated
    if (config && config.claudeApiKey) {
      env.ANTHROPIC_API_KEY = config.claudeApiKey;
    }

    const proc = spawn(bin, ["auth", "status"], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    proc.on("close", (code) => {
      try {
        const data = JSON.parse(stdout);
        authStatus = {
          installed: true,
          binPath: bin,
          loggedIn: !!data.loggedIn,
          email: data.email || null,
          authMethod: data.authMethod || null,
          error: data.loggedIn ? null : "Not authenticated",
        };
      } catch {
        authStatus = {
          installed: true,
          binPath: bin,
          loggedIn: code === 0,
          error: code !== 0 ? (stderr.trim().split("\n")[0] || "Unknown error") : null,
        };
      }
      // Fall back to stored API key if CLI auth failed
      if (!authStatus.loggedIn && config) {
        const apiKey = config.claudeApiKey;
        if (apiKey) {
          authStatus.loggedIn = true;
          authStatus.authMethod = "api_key";
          authStatus.error = null;
        }
      }
      log(`auth-check: done in ${Date.now() - start}ms code=${code} loggedIn=${authStatus.loggedIn} method=${authStatus.authMethod || "none"}`);
      resolve(authStatus);
    });

    proc.on("error", (err) => {
      authStatus = { installed: true, binPath: bin, loggedIn: false, error: "failed to spawn" };
      logErr(`auth-check: spawn error: ${err.message}`);
      resolve(authStatus);
    });

    setTimeout(() => {
      try { proc.kill("SIGTERM"); } catch {}
    }, 10000);
  });
}

function getAuthStatus() {
  return authStatus;
}

function startAuthCheck(config, intervalMs = 5 * 60 * 1000) {
  checkAuth(config);
  if (authCheckInterval) clearInterval(authCheckInterval);
  authCheckInterval = setInterval(() => checkAuth(config), intervalMs);
}

// --- Models (hardcoded — Claude uses simple model names) ---

const MODELS = [
  { id: "sonnet", name: "Sonnet" },
  { id: "opus", name: "Opus" },
  { id: "haiku", name: "Haiku" },
];

function getModels() {
  return MODELS;
}

/**
 * Recover partial conversations from orphaned stream log files (crash recovery).
 * Called on server startup — replays JSONL events, extracts assistant text,
 * persists to history, then deletes the log file.
 */
function recoverStreams() {
  const prefix = "stream-claude-chat-";
  let files;
  try {
    files = fs.readdirSync(CONVERSATIONS_DIR).filter(f => f.startsWith(prefix) && f.endsWith(".jsonl"));
  } catch { return; }

  for (const file of files) {
    const filePath = path.join(CONVERSATIONS_DIR, file);
    const stem = file.slice(prefix.length, -6); // strip prefix + .jsonl
    // Parse session number from stem: "workspace-s2" → session 2, "workspace" → session 1
    const sMatch = stem.match(/^(.+)-s(\d+)$/);
    const workspace = sMatch ? sMatch[1] : stem;
    const sessionNum = sMatch ? Number(sMatch[2]) : 1;

    // If the relay daemon is still alive, reconnectActiveRelays will handle
    // recovery via _replay_seed — don't double-persist.
    if (isRelayAlive(workspace, sessionNum)) {
      log(`recover: skipping ${workspace} session#${sessionNum} — relay still alive`);
      continue;
    }

    let assistantText = "";

    try {
      const lines = fs.readFileSync(filePath, "utf-8").split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line.trim());
          if (event.type === "message" && (event.role === "assistant" || !event.role)) {
            assistantText += event.content || "";
          }
        } catch {}
      }
    } catch {}

    if (assistantText) {
      pushHistory(workspace, "assistant", assistantText);
      log(`recovered ${assistantText.length} chars of assistant text for ${workspace}`);
    }
    try { fs.unlinkSync(filePath); } catch {}
  }
}

/**
 * Scan /tmp/klaudii-relay for running relays from a previous server instance.
 * For each live relay, connect and set up event routing.
 * onWorkspace(workspace, handle) is called synchronously before any events flow.
 */
function reconnectActiveRelays(config, onWorkspace) {
  if (!fs.existsSync(RELAY_DIR)) return;
  let dirs;
  try { dirs = fs.readdirSync(RELAY_DIR); } catch { return; }

  for (const dirName of dirs) {
    const { workspace: ws, sessionNum: sNum } = parseRelayDirName(dirName);
    if (!isRelayAlive(ws, sNum)) continue;
    log(`reconnecting to relay workspace=${ws} session#${sNum}`);
    try {
      let replayAssistantText = "";
      const replayToolEvents = [];

      const handle = connectRelay(ws, {
        sessionNum: sNum,
        replayDoneCallback() {
          // After replay: persist any accumulated text-only turn content that
          // completed before the restart (no "result" event = never persisted).
          // Use readSessionHistory (not getHistory) to avoid the stream log merge.
          if (replayAssistantText) {
            const num = String(sNum);
            const hist = readSessionHistory(ws, num);
            const lastMsg = hist[hist.length - 1];
            if (lastMsg && lastMsg.role === "user") {
              const batch = [...replayToolEvents];
              batch.push({ role: "assistant", content: replayAssistantText });
              pushHistoryBatch(ws, batch, sNum);
              log(`replay-flushed text-only turn for workspace=${ws} session#${sNum} (${replayAssistantText.length} chars)`);
            }
          }
          // Clean up stale stream log from the previous server run (content is
          // now either persisted via replay or will come through live events).
          try { fs.unlinkSync(streamLogPath(ws, sNum)); } catch {}
        },
        replayCallback(raw) {
          // Process replay events for history catch-up (don't broadcast to WS)
          if (raw.type === "system" && raw.subtype === "init" && raw.session_id) {
            const meta = readMeta(ws, sNum);
            meta.cliSessionId = raw.session_id;
            if (!meta.createdAt) meta.createdAt = Date.now();
            writeMeta(ws, sNum, meta);
          }

          // Accumulate content from replayed events.  When we see a "result"
          // event it means Claude finished a full turn before the server
          // restarted.  Persist the content only if the history doesn't already
          // have the assistant reply (i.e. last history entry is the user
          // message, meaning the server crashed before calling pushHistoryBatch).
          const normalized = normalizeEvent(raw);
          for (const evt of normalized) {
            if (evt.type === "message" && (evt.role === "assistant" || !evt.role)) {
              replayAssistantText += evt.content || "";
            } else if (evt.type === "tool_use") {
              replayToolEvents.push({
                role: "tool_use",
                content: JSON.stringify({ tool_name: evt.tool_name, tool_id: evt.tool_id, parameters: evt.parameters || {} }),
              });
            } else if (evt.type === "tool_result") {
              const out = evt.output || "";
              replayToolEvents.push({
                role: "tool_result",
                content: JSON.stringify({ tool_id: evt.tool_id, status: evt.status || "success", output: out }),
              });
            } else if (evt.type === "result") {
              // Only persist if the assistant reply is missing from history
              const num = String(sNum);
              const hist = readSessionHistory(ws, num);
              const lastMsg = hist[hist.length - 1];
              if (lastMsg && lastMsg.role === "user") {
                const batch = [...replayToolEvents];
                if (replayAssistantText) batch.push({ role: "assistant", content: replayAssistantText });
                if (batch.length > 0) {
                  pushHistoryBatch(ws, batch, sNum);
                  log(`replay-recovered ${batch.length} event(s) for workspace=${ws} session#${sNum}`);
                }
              }
              replayAssistantText = "";
              replayToolEvents.length = 0;
            }
          }
        },
      });

      onWorkspace(ws, handle, sNum);
    } catch (e) {
      logErr(`reconnect failed workspace=${ws} session#${sNum}: ${e.message}`);
    }
  }
}

// --- Context Handoff (Infinite Conversations) ---

const HANDOFF_CONVERSATION_PAIRS = 20; // max user/assistant pairs in briefing
const HANDOFF_RECENT_TOOLS = 30;       // max recent tool calls to include

// Memory database — loads decision recall for briefings
let memoryDb = null;
function getMemoryDb() {
  if (memoryDb) return memoryDb;
  try {
    memoryDb = require("../tools/memory/db");
    return memoryDb;
  } catch (e) {
    log(`memory db not available: ${e.message}`);
    return null;
  }
}

/**
 * Generate decision recall section from the memory database.
 * Returns all active preferences, corrections, decisions, etc.
 */
function generateDecisionRecall() {
  const db = getMemoryDb();
  if (!db) return "";

  try {
    const entries = db.activeRecords();
    if (!entries.length) return "";

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

    const lines = ["## Decision Recall\n"];
    for (const type of order) {
      if (!grouped[type]) continue;
      lines.push(`### ${typeLabels[type] || type}`);
      for (const e of grouped[type]) {
        lines.push(`- [${e.id}] ${e.summary}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  } catch (e) {
    log(`decision recall failed: ${e.message}`);
    return "";
  }
}

/**
 * Generate a briefing message from conversation history + memory database.
 * Used to prime a new Claude instance so it can seamlessly continue.
 *
 * Includes three sections:
 * 1. Decision recall — all-time preferences, corrections, decisions from memory DB
 * 2. Conversation transcript — last N user/assistant exchanges
 * 3. Recent activity — compressed tool calls showing what was being worked on
 */
function generateBriefing(workspace, workspacePath) {
  const history = getHistory(workspace);
  if (!history || history.length === 0) return null;

  // --- Section 0: Project context files (AGENTS.md + CODEMAP.md) ---
  // These give the new instance knowledge of the codebase architecture
  // and team conventions without needing to re-explore.
  let projectContext = "";
  if (workspacePath) {
    for (const fname of ["AGENTS.md", "CODEMAP.md"]) {
      try {
        const content = fs.readFileSync(path.join(workspacePath, fname), "utf-8");
        if (content.trim()) {
          projectContext += `## ${fname}\n\n${content.trim()}\n\n`;
        }
      } catch {}
    }
  }

  // --- Section 1: Conversation transcript (two tiers) ---
  // Recent exchanges get full detail; earlier ones are compressed summaries.
  const conversational = history.filter(m => m.role === "user" || m.role === "assistant");
  const RECENT_FULL = 6; // last 3 pairs get full text (2000 chars each)
  const EARLIER_SUMMARY = HANDOFF_CONVERSATION_PAIRS - (RECENT_FULL / 2); // earlier pairs get 500 chars

  const recentFull = conversational.slice(-RECENT_FULL);
  const earlierRange = conversational.slice(-(HANDOFF_CONVERSATION_PAIRS * 2), -RECENT_FULL);

  const earlierTranscript = earlierRange.map(m => {
    const role = m.role === "user" ? "User" : "A";
    const text = (m.content || "").slice(0, 500);
    return `${role}: ${text}`;
  }).join("\n\n");

  const recentTranscript = recentFull.map(m => {
    const role = m.role === "user" ? "User" : "Assistant";
    const text = (m.content || "").slice(0, 2000);
    return `${role}: ${text}`;
  }).join("\n\n");

  // --- Section 2: Recent tool activity ---
  // Shows what files/operations the agent was working on so the new instance
  // knows the current state of the codebase and can continue mid-task.
  const toolEntries = history.filter(m => m.role === "tool_use" || m.role === "tool_result");
  const recentTools = toolEntries.slice(-HANDOFF_RECENT_TOOLS);

  let activitySection = "";
  if (recentTools.length > 0) {
    const lines = [];
    for (const entry of recentTools) {
      try {
        const data = JSON.parse(entry.content);
        if (entry.role === "tool_use") {
          const name = data.tool_name || "unknown";
          const params = data.parameters || {};
          let detail = "";
          if (params.file_path) detail = params.file_path;
          else if (params.command) detail = params.command.slice(0, 200);
          else if (params.pattern) detail = `pattern="${params.pattern}"` + (params.path ? ` in ${params.path}` : "");
          else if (params.query) detail = `"${params.query}"`;
          else if (params.prompt) detail = params.prompt.slice(0, 100);
          else {
            const keys = Object.keys(params).filter(k => typeof params[k] === "string");
            if (keys.length) detail = `${keys[0]}=${String(params[keys[0]]).slice(0, 100)}`;
          }
          lines.push(`  ${name}: ${detail}`);
        } else if (entry.role === "tool_result") {
          const status = data.status || "success";
          if (status !== "success") lines.push(`    → ${status}`);
        }
      } catch {}
    }
    if (lines.length > 0) {
      activitySection = "\n\n## Recent Tool Activity\n(Compressed — shows what was being worked on)\n\n" + lines.join("\n");
    }
  }

  // --- Section 3: Decision recall from memory database ---
  const decisionRecall = generateDecisionRecall();

  // --- Section 4: Active task extraction ---
  // Find the last user request and the assistant's progress on it.
  // This gives the new instance a clear "you were doing X" directive.
  let activeTaskSection = "";
  const lastUserIdx = conversational.findLastIndex(m => m.role === "user");
  if (lastUserIdx >= 0) {
    const lastUserMsg = (conversational[lastUserIdx].content || "").slice(0, 1500);
    // Gather all assistant replies after the last user message
    const repliesAfter = conversational.slice(lastUserIdx + 1)
      .filter(m => m.role === "assistant")
      .map(m => (m.content || "").slice(0, 1000));
    const assistantProgress = repliesAfter.join("\n");

    activeTaskSection = "## Active Task\nThe user's last request was:\n> " + lastUserMsg;
    if (assistantProgress) {
      activeTaskSection += "\n\nYour progress so far:\n" + assistantProgress;
    }
  }

  // --- Assemble briefing ---
  const sections = [];
  sections.push("This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.");

  // Project context (AGENTS.md, CODEMAP.md) — codebase architecture + conventions
  if (projectContext) {
    sections.push("## Project Context\n\n" + projectContext.trim());
  }

  if (decisionRecall) {
    sections.push(decisionRecall);
  }

  // Active task first — most important for continuity
  if (activeTaskSection) {
    sections.push(activeTaskSection);
  }

  if (activitySection) {
    sections.push(activitySection);
  }

  // Conversation history — provides background context
  let conversationSection = "## Conversation History\n\n";
  if (earlierTranscript) {
    conversationSection += "### Earlier Context\n\n" + earlierTranscript + "\n\n";
  }
  conversationSection += "### Recent Exchanges\n\n" + recentTranscript;
  sections.push(conversationSection);

  // --- Verbatim tail: last 12 messages exactly as they appeared ---
  // This gives the new instance a precise, untruncated view of where things stand.
  const VERBATIM_COUNT = 12;
  const verbatimTail = conversational.slice(-VERBATIM_COUNT);
  if (verbatimTail.length > 0) {
    const verbatimLines = verbatimTail.map(m => {
      const role = m.role === "user" ? "User" : "Assistant";
      return `${role}: ${m.content || ""}`;
    }).join("\n\n");
    sections.push("## Exact Recent Messages\nHere are the last " + verbatimTail.length + " messages exactly as they appeared:\n\n" + verbatimLines);
  }

  // --- CRITICAL closing instruction ---
  sections.push([
    "CRITICAL INSTRUCTIONS:",
    "- This is a seamless context handoff. The user does NOT know you were restarted or handed off.",
    "- Do NOT greet the user, do NOT say \"I'm continuing\", do NOT acknowledge this briefing in any way.",
    "- Do NOT take any action until you receive a user message. Wait silently.",
    "- When the user sends a message, respond naturally as if the conversation never had a break.",
    "- If you were mid-task, do NOT resume it unprompted — wait for the user to ask you to continue.",
  ].join("\n"));

  return sections.join("\n\n");
}

/**
 * Perform a context handoff — stop the current relay, start a new session
 * with a briefing, and return the new handle.
 * Returns { handle, sessionNum } or null if handoff fails.
 */
async function performHandoff(workspace, workspacePath, config, opts = {}) {
  const briefing = generateBriefing(workspace, workspacePath);
  if (!briefing) {
    log(`handoff: no history for workspace=${workspace}, skipping`);
    return null;
  }

  log(`handoff: starting for workspace=${workspace} briefingLen=${briefing.length}`);

  // Reuse the current session number — the user sees one continuous chat,
  // not a new "Chat 2" / "Chat 3" every time we hand off.
  const sNum = currentSessionNum(workspace);
  stopSessionRelay(workspace, sNum);

  // Start fresh — no sessionId (no --resume), so it's a clean context window,
  // but keep the same session number so history appends to the same chat.
  const claudeBin = findClaudeBin(config);
  if (!claudeBin) {
    logErr("handoff: Claude CLI not found");
    return null;
  }

  const permMode = opts.permissionMode || "bypassPermissions";
  const args = ["--output-format", "stream-json", "--input-format", "stream-json", "--verbose",
                "--permission-prompt-tool", "stdio", "--permission-mode", permMode];
  if (opts.model) args.push("--model", opts.model);

  // Inject briefing as system prompt context (not user message) so Claude
  // treats it as background knowledge rather than something to respond to.
  args.push("--append-system-prompt", briefing);

  const env = { ...process.env };
  delete env.CLAUDECODE;
  if (opts.apiKey) env.ANTHROPIC_API_KEY = opts.apiKey;

  // No init message — the new instance should wait silently for the next
  // user message. The briefing is injected via --append-system-prompt so
  // Claude already has full context; it just needs to wait for the user.
  const rp = await startRelay(workspace, sNum, workspacePath, claudeBin, args, env, "", false);
  log(`handoff: relay ready workspace=${workspace} session#${sNum} (same chat)`);

  const handle = connectRelay(workspace, { sessionNum: sNum });
  return { handle, sessionNum: sNum };
}

/** Kill all active relays (for graceful shutdown). */
function stopAllProcesses() {
  for (const [workspace, inner] of [...activeRelays.entries()]) {
    for (const [sNum, entry] of [...inner.entries()]) {
      log(`shutdown: stop relay workspace=${workspace} session#${sNum}`);
      entry.handle.kill();
    }
  }
}

module.exports = {
  init,
  isInstalled,
  getBinPath,
  startChat,
  sendMessage,
  sendControlRequest,
  sendControlResponse,
  sendToolResult,
  stopProcess,
  stopAllProcesses,
  reconnectActiveRelays,
  isRelayAlive,
  currentSessionNum,
  getSessionId,
  isActive,
  isSessionActive,
  getActiveSessionNum,
  getActiveRelayInfo,
  getSessions,
  newSession,
  setCurrentSession,
  clearSession,
  pushHistory,
  pushHistoryBatch,
  getLastMessageTime,
  getHistory,
  clearHistory,
  tagSessionWithTask,
  getSessionsForTask,
  checkAuth,
  getAuthStatus,
  startAuthCheck,
  getModels,
  getStreamPartial,
  recoverStreams,
  generateBriefing,
  performHandoff,
  // Exported for testing — these are load-bearing internal functions
  _normalizeEvent: normalizeEvent,
};
