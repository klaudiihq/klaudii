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

// --- Logging ---
const LOG_PREFIX = "[claude-chat]";
function log(...args) { console.log(LOG_PREFIX, new Date().toISOString(), ...args); }
function logErr(...args) { console.error(LOG_PREFIX, new Date().toISOString(), ...args); }

// App data
const CONVERSATIONS_DIR = path.join(require("os").homedir(), "Library", "Application Support", "com.klaudii.server", "conversations");
const SESSIONS_FILE = path.join(__dirname, "..", "claude-chat-sessions.json");
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

// --- Relay management ---

const RELAY_DIR = path.join(os.tmpdir(), "klaudii-relay");
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

/** True if the relay pid file exists and that process is still alive. */
function isRelayAlive(workspace, sessionNum) {
  const { pid } = relayPaths(workspace, sessionNum);
  try {
    const p = parseInt(fs.readFileSync(pid, "utf-8").trim(), 10);
    if (!p) return false;
    process.kill(p, 0); // throws if process not found
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
    CLAUDE_CODE_REMOTE: "1", // enables tool_progress events for elapsed time display
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

  const proc = spawn(process.execPath, [RELAY_DAEMON], {
    detached: true,
    stdio: "ignore",
    env: relayEnv,
  });
  proc.unref();
  log(`relay started pid=${proc.pid} workspace=${workspace}`);

  // Poll for socket to appear (up to 5 s)
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (fs.existsSync(rp.socket)) return rp;
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
        eventCallback({ type: "result", stats: {}, _flush: true });
      }
      partialStreams.delete(pKey);
      try { fs.unlinkSync(streamLogPath(workspace, sNum)); } catch {}
    },
  };

  // Register immediately so isActive() returns true as soon as we start connecting.
  // Node.js socket writes before connect are buffered and flushed on connect.
  setRelay(workspace, sNum, { handle, killed: false, startedAt: Date.now() });

  socket.connect(rp.socket, () => {
    log(`relay connected workspace=${workspace}`);
  });

  const rl = readline.createInterface({ input: socket });
  rl.on("line", (line) => {
    const t = line.trim();
    if (!t) return;
    let raw;
    try { raw = JSON.parse(t); } catch { return; }

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

    // Capture session ID from init event
    if (raw.type === "system" && raw.subtype === "init" && raw.session_id) {
      if (!sessions[workspace]) sessions[workspace] = { current: 1, sessions: {} };
      const ws = sessions[workspace];
      ws.sessions[String(ws.current)] = raw.session_id;
      saveSessions();
      log(`session-id workspace=${workspace} session#${ws.current} sessionId=${raw.session_id}`);
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

  socket.on("error", (err) => {
    logErr(`relay socket error workspace=${workspace}: ${err.message}`);
    deleteRelay(workspace, sNum);
    partialStreams.delete(pKey);
    if (errorCallback) errorCallback(err);
  });

  socket.on("close", () => {
    deleteRelay(workspace, sNum);
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

// In-memory partial stream buffer — tracks accumulated assistant text for the
// current turn so clients can display it when switching back mid-stream.
const partialStreams = new Map(); // "workspace\0sessionNum" → string

function partialKey(workspace, sessionNum) {
  return `${workspace}\0${sessionNum || 1}`;
}

function getStreamPartial(workspace) {
  const sNum = currentSessionNum(workspace);
  return partialStreams.get(partialKey(workspace, sNum)) || null;
}

/** Deterministic log path for an active stream (per workspace+session). */
function streamLogPath(workspace, sessionNum) {
  const n = sessionNum || 1;
  const suffix = n > 1 ? `-s${n}` : "";
  return path.join(CONVERSATIONS_DIR, `stream-claude-chat-${workspace}${suffix}.jsonl`);
}

// workspace → { current: N, sessions: { "1": cliSessionId, "2": cliSessionId } } (persisted)
let sessions = {};

// Load persisted data on startup
try {
  if (fs.existsSync(SESSIONS_FILE)) {
    sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf-8"));
  }
} catch { sessions = {}; }

// Migrate sessions format + old monolithic history file → per-workspace/per-session files
(function migrateData() {
  let sessionsChanged = false;
  for (const [ws, val] of Object.entries(sessions)) {
    if (typeof val === "string") {
      sessions[ws] = { current: 1, sessions: { "1": val } };
      sessionsChanged = true;
    }
  }
  if (sessionsChanged) {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
    log("migrated session data to multi-session format");
  }

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
})();

function saveSessions() {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

/** Get the current session number for a workspace (default 1). */
function currentSessionNum(workspace) {
  const entry = sessions[workspace];
  return entry ? entry.current : 1;
}

/** Get the CLI session ID for the current (or specified) session number. */
function getCliSessionId(workspace, num) {
  const entry = sessions[workspace];
  if (!entry) return null;
  const n = String(num || entry.current);
  return entry.sessions[n] || null;
}

function pushHistory(workspace, role, content, meta) {
  const num = String(currentSessionNum(workspace));
  const messages = readSessionHistory(workspace, num);
  const entry = { role, content, ts: Date.now() };
  if (meta && meta.sender) entry.sender = meta.sender;
  messages.push(entry);
  writeSessionHistory(workspace, num, messages);
}

/** Save a batch of messages in a single read+write (efficient for multi-event turns). */
function pushHistoryBatch(workspace, messages) {
  const num = String(currentSessionNum(workspace));
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
  const logPath = streamLogPath(workspace);
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
      break;
    }

    case "user": {
      // A "user" event means Claude received a new message — the previous
      // assistant turn is complete.  Emit a synthetic "result" so the server
      // persists the turn (Claude CLI with stream-json never emits "result").
      events.push({ type: "result", stats: {} });

      // User messages contain tool_result content blocks
      const msg = raw.message;
      if (!msg || !msg.content) break;
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
      if (raw.usage) {
        stats.total_tokens = (raw.usage.input_tokens || 0) + (raw.usage.output_tokens || 0) +
          (raw.usage.cache_read_input_tokens || 0) + (raw.usage.cache_creation_input_tokens || 0);
        stats.input_tokens = raw.usage.input_tokens;
        stats.output_tokens = raw.usage.output_tokens;
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
 * @deprecated Use sendMessage with images instead — images now go via temp files + CLI.
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

// --- Send message ---

async function sendMessage(workspace, workspacePath, userMessage, config, opts = {}) {
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

  const fullMessage = imagePaths.length
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

  const sessionId = getCliSessionId(workspace);
  if (sessionId) args.push("--resume", sessionId);

  const env = { ...process.env };
  delete env.CLAUDECODE;
  if (opts.apiKey) env.ANTHROPIC_API_KEY = opts.apiKey;

  // Build the initial stdin payload (always stream-json format)
  const initMsg = JSON.stringify({
    type: "user",
    session_id: sessionId || "",
    message: { role: "user", content: fullMessage },
  }) + "\n";

  log(`spawn workspace=${workspace} bin=${claudeBin} model=${opts.model || "auto"} permMode=${permMode} hasSession=${!!sessionId} images=${imagePaths.length}`);

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
function sendControlRequest(workspace, subtype, payload = {}) {
  const sNum = currentSessionNum(workspace);
  const entry = getRelay(workspace, sNum);
  if (!entry) {
    log(`sendControlRequest workspace=${workspace} session#${sNum} subtype=${subtype} no active relay`);
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

function sendControlResponse(workspace, requestId, behavior, updatedInput) {
  const sNum = currentSessionNum(workspace);
  const entry = getRelay(workspace, sNum);
  if (!entry) {
    log(`sendControlResponse workspace=${workspace} no active relay`);
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
  log(`sendControlResponse workspace=${workspace} requestId=${requestId} behavior=${behavior}`);
  try { entry.handle.socket.write(msg + "\n"); } catch (e) { logErr(`sendControlResponse write failed: ${e.message}`); }
}

function sendToolResult(workspace, toolId, content) {
  const sNum = currentSessionNum(workspace);
  const entry = getRelay(workspace, sNum);
  if (!entry) {
    log(`sendToolResult workspace=${workspace} no active relay`);
    return;
  }
  const msg = JSON.stringify({
    type: "tool_result",
    tool_use_id: toolId,
    content: String(content),
  });
  log(`sendToolResult workspace=${workspace} tool_id=${toolId} content=${JSON.stringify(content)}`);
  try { entry.handle.socket.write(msg + "\n"); } catch (e) { logErr(`sendToolResult write failed: ${e.message}`); }
}

/** Stop a single session's relay for a workspace. */
function stopSessionRelay(workspace, sessionNum) {
  const entry = getRelay(workspace, sessionNum);
  if (entry) {
    log(`stop relay workspace=${workspace} session#${sessionNum}`);
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

/** True if a specific session has an active relay. */
function isSessionActive(workspace, sessionNum) {
  return !!getRelay(workspace, sessionNum);
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

/** Write an additional user message to Claude's open stdin via the relay socket. */
function appendMessage(workspace, message) {
  const sNum = currentSessionNum(workspace);
  const entry = getRelay(workspace, sNum);
  if (!entry) { logErr(`appendMessage: no active relay for workspace=${workspace} session#${sNum}`); return false; }
  // Flush accumulated content from the previous turn so it's persisted before
  // the new message.  Without this, text-only responses (no tool use) never
  // trigger a "result" event and the assistant text sits in memory unpersisted.
  if (entry.handle.flushTurn) entry.handle.flushTurn();
  const line = JSON.stringify({ type: "user", message: { role: "user", content: message } });
  try { entry.handle.socket.write(line + "\n"); return true; }
  catch (e) { logErr(`appendMessage write failed: ${e.message}`); return false; }
}

/** Return session metadata for the API. */
function getSessions(workspace) {
  const entry = sessions[workspace];
  if (!entry) return { current: null, sessions: [] };
  return {
    current: entry.current,
    sessions: Object.keys(entry.sessions).map(Number).sort((a, b) => a - b),
    beadIds: entry.beadIds || {},
  };
}

/**
 * Tag a chat session with a bead ID.
 * @param {string} workspace
 * @param {number|string} sessionNum - session number (defaults to current)
 * @param {string} beadId
 */
function tagSessionWithBead(workspace, sessionNum, beadId) {
  if (!sessions[workspace]) sessions[workspace] = { current: 1, sessions: {} };
  const entry = sessions[workspace];
  if (!entry.beadIds) entry.beadIds = {};
  const num = String(sessionNum || entry.current);
  if (!entry.beadIds[num]) entry.beadIds[num] = [];
  if (!entry.beadIds[num].includes(beadId)) {
    entry.beadIds[num].push(beadId);
    saveSessions();
  }
}

/**
 * Find all workspaces+sessions that worked on a given bead ID.
 * @returns {{ workspace: string, sessionNum: number, cliSessionId: string|null }[]}
 */
function getSessionsForBead(beadId) {
  const results = [];
  for (const [workspace, entry] of Object.entries(sessions)) {
    if (!entry.beadIds) continue;
    for (const [num, ids] of Object.entries(entry.beadIds)) {
      if (Array.isArray(ids) && ids.includes(beadId)) {
        results.push({
          workspace,
          sessionNum: Number(num),
          cliSessionId: entry.sessions[num] || null,
        });
      }
    }
  }
  return results;
}

/** Create a new session (increment counter, preserve old sessions). */
function newSession(workspace) {
  // Don't stop other sessions' relays — they can run concurrently
  const entry = sessions[workspace];
  if (!entry) {
    sessions[workspace] = { current: 1, sessions: {} };
    saveSessions();
    return 1;
  }
  const nums = Object.keys(entry.sessions).map(Number);
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  entry.current = next;
  entry.sessions[String(next)] = null;
  saveSessions();
  log(`new-session workspace=${workspace} session#${next}`);
  return next;
}

/** Switch to an existing session number. */
function setCurrentSession(workspace, num) {
  const entry = sessions[workspace];
  if (!entry || !entry.sessions.hasOwnProperty(String(num))) return false;
  // Don't stop relays — allow concurrent sessions
  entry.current = num;
  saveSessions();
  log(`switch-session workspace=${workspace} session#${num}`);
  return true;
}

/** Delete everything for a workspace (nuclear option). */
function clearSession(workspace) {
  delete sessions[workspace];
  saveSessions();
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
              pushHistoryBatch(ws, batch);
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
            if (!sessions[ws]) sessions[ws] = { current: 1, sessions: {} };
            const entry = sessions[ws];
            entry.sessions[String(sNum)] = raw.session_id;
            saveSessions();
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
                  pushHistoryBatch(ws, batch);
                  log(`replay-recovered ${batch.length} event(s) for workspace=${ws} session#${sNum}`);
                }
              }
              replayAssistantText = "";
              replayToolEvents.length = 0;
            }
          }
        },
      });

      onWorkspace(ws, handle);
    } catch (e) {
      logErr(`reconnect failed workspace=${ws} session#${sNum}: ${e.message}`);
    }
  }
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
  isInstalled,
  getBinPath,
  sendMessage,
  appendMessage,
  sendControlRequest,
  sendControlResponse,
  sendToolResult,
  stopProcess,
  stopAllProcesses,
  reconnectActiveRelays,
  isRelayAlive,
  getSessionId,
  isActive,
  isSessionActive,
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
  tagSessionWithBead,
  getSessionsForBead,
  checkAuth,
  getAuthStatus,
  startAuthCheck,
  getModels,
  getStreamPartial,
  recoverStreams,
  // Exported for testing — these are load-bearing internal functions
  _normalizeEvent: normalizeEvent,
};
