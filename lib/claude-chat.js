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
  fs.writeFileSync(historyFile(workspace, String(sessionNum)), JSON.stringify(messages, null, 2));
}

// workspace → { proc, sessionId, buffer, killed }
const activeProcesses = new Map();

/** Deterministic log path for an active stream (one per workspace). */
function streamLogPath(workspace) {
  return path.join(CONVERSATIONS_DIR, `stream-claude-chat-${workspace}.jsonl`);
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

function pushHistory(workspace, role, content) {
  const num = String(currentSessionNum(workspace));
  const messages = readSessionHistory(workspace, num);
  messages.push({ role, content, ts: Date.now() });
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
  return readSessionHistory(workspace, num);
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
      }
      break;

    case "assistant": {
      // Assistant messages contain content blocks: text and tool_use
      const msg = raw.message;
      if (!msg || !msg.content) break;

      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          events.push({
            type: "message",
            role: "assistant",
            content: block.text,
            delta: true,
          });
        } else if (block.type === "tool_use") {
          events.push({
            type: "tool_use",
            tool_name: block.name,
            tool_id: block.id,
            parameters: block.input || {},
          });
        }
      }
      break;
    }

    case "user": {
      // User messages contain tool_result content blocks
      const msg = raw.message;
      if (!msg || !msg.content) break;

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
              // Extract text from Claude content blocks: [{type:"text",text:"..."}]
              output = block.content
                .filter(b => b.type === "text")
                .map(b => b.text || "")
                .join("\n")
                .trim();
              // If still empty (e.g. non-text blocks), fall back to JSON
              if (!output) output = JSON.stringify(block.content);
            } else {
              output = JSON.stringify(block.content);
            }
          }
          events.push({
            type: "tool_result",
            tool_id: block.tool_use_id,
            status: block.is_error ? "error" : "success",
            output,
          });
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
      events.push({ type: "result", stats });
      break;
    }

    default:
      // Forward unknown event types as-is so we can discover what Plan/allowEdits mode emits
      events.push({ type: "unknown_raw", raw_type: raw.type, raw_subtype: raw.subtype, payload: raw });
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

function sendMessage(workspace, workspacePath, userMessage, config, opts = {}) {
  stopProcess(workspace);

  // Write any attached images to temp files so the CLI can read them.
  // Claude CLI in bypassPermissions mode uses the Read tool to read images
  // and pass them as vision content blocks — confirmed working with proper PNGs/JPGs.
  let imagePaths = [];
  if (opts.images && opts.images.length > 0) {
    try {
      imagePaths = writeImageTempFiles(workspace, opts.images);
      log(`wrote ${imagePaths.length} image temp file(s) for workspace=${workspace}`);
    } catch (err) {
      log(`image temp write failed: ${err.message} — sending without images`);
    }
  }

  // Build the full message: prepend image paths so Claude reads them before the user text.
  const fullMessage = imagePaths.length
    ? `[The user has attached ${imagePaths.length} image file(s). Please read each one using the Read tool before responding.]\n${imagePaths.map((p) => `- ${p}`).join("\n")}\n\n${userMessage}`
    : userMessage;

  // Clean up any stale log file from a previous crash
  const logPath = streamLogPath(workspace);
  try { fs.unlinkSync(logPath); } catch {}

  const claudeBin = findClaudeBin(config);
  if (!claudeBin) {
    throw new Error("Claude CLI not found — install from https://docs.anthropic.com/en/docs/claude-code");
  }

  const permMode = opts.permissionMode || "bypassPermissions";
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", permMode];

  if (opts.model) {
    args.push("--model", opts.model);
  }

  const sessionId = getCliSessionId(workspace);
  if (sessionId) {
    args.push("--resume", sessionId);
  }

  // Build env — strip CLAUDECODE to avoid nested-session detection
  const env = { ...process.env };
  delete env.CLAUDECODE;
  if (opts.apiKey) {
    env.ANTHROPIC_API_KEY = opts.apiKey;
  }

  const spawnStart = Date.now();
  log(`spawn workspace=${workspace} bin=${claudeBin} model=${opts.model || "auto"} permMode=${permMode} hasSession=${!!sessionId} images=${imagePaths.length}`);

  const proc = spawn(claudeBin, args, {
    cwd: workspacePath,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });

  // Write the message to stdin and close it — Claude -p reads the full prompt until EOF then responds.
  proc.stdin.write(fullMessage);
  proc.stdin.end();

  log(`spawned pid=${proc.pid} workspace=${workspace}`);

  const entry = { proc, sessionId: sessionId || null, killed: false };
  activeProcesses.set(workspace, entry);

  let eventCallback = null;
  let doneCallback = null;
  let errorCallback = null;
  let eventCount = 0;
  let firstEventAt = null;

  const rl = readline.createInterface({ input: proc.stdout });

  rl.on("line", (line) => {
    if (entry.killed) return;
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const raw = JSON.parse(trimmed);
      eventCount++;
      if (!firstEventAt) {
        firstEventAt = Date.now();
        log(`first-event workspace=${workspace} elapsed=${firstEventAt - spawnStart}ms type=${raw.type}`);
      }
      log(`raw-event workspace=${workspace} #${eventCount} type=${raw.type}${raw.subtype ? " subtype=" + raw.subtype : ""}`);

      // Capture session ID from init event — store in current session slot
      if (raw.type === "system" && raw.subtype === "init" && raw.session_id) {
        entry.sessionId = raw.session_id;
        if (!sessions[workspace]) {
          sessions[workspace] = { current: 1, sessions: {} };
        }
        const ws = sessions[workspace];
        ws.sessions[String(ws.current)] = raw.session_id;
        saveSessions();
        log(`session-id workspace=${workspace} session#${ws.current} sessionId=${raw.session_id}`);
      }

      // Normalize and emit
      const normalized = normalizeEvent(raw);
      for (const evt of normalized) {
        // Write-through: durable log for crash recovery (normalized events)
        try { fs.appendFileSync(logPath, JSON.stringify(evt) + '\n'); } catch {}
        if (eventCallback) eventCallback(evt);
      }
    } catch {
      log(`non-json-line workspace=${workspace} line=${trimmed.slice(0, 200)}`);
    }
  });

  let stderrBuf = "";
  proc.stderr.on("data", (chunk) => {
    if (entry.killed) return;
    const text = chunk.toString();
    stderrBuf += text;
    log(`stderr workspace=${workspace} pid=${proc.pid}: ${text.trim().slice(0, 300)}`);

    const line = text.trim();
    if (line && (line.includes("Retrying") || line.includes("rate") || line.includes("limit") || line.includes("Error"))) {
      if (eventCallback) eventCallback({ type: "status", message: line.split("\n")[0] });
    }
  });

  proc.on("close", (code) => {
    const elapsed = Date.now() - spawnStart;
    log(`close workspace=${workspace} pid=${proc.pid} code=${code} elapsed=${elapsed}ms events=${eventCount} killed=${entry.killed}`);
    activeProcesses.delete(workspace);
    if (!entry.killed && doneCallback) doneCallback({ code, stderr: stderrBuf });
    // Delete log file after doneCallback has persisted history
    try { fs.unlinkSync(logPath); } catch {}
    // Clean up image temp files
    for (const p of imagePaths) { try { fs.unlinkSync(p); } catch {} }
  });

  proc.on("error", (err) => {
    logErr(`spawn-error workspace=${workspace} pid=${proc.pid} err=${err.message}`);
    activeProcesses.delete(workspace);
    if (!entry.killed && errorCallback) errorCallback(err);
    // Clean up image temp files on error too
    for (const p of imagePaths) { try { fs.unlinkSync(p); } catch {} }
  });

  return {
    onEvent(cb) { eventCallback = cb; },
    onDone(cb) { doneCallback = cb; },
    onError(cb) { errorCallback = cb; },
    kill() { stopProcess(workspace); },
  };
}

function sendInput(workspace, text) {
  const entry = activeProcesses.get(workspace);
  if (entry && entry.proc && !entry.killed) {
    log(`sendInput workspace=${workspace} text=${JSON.stringify(text)}`);
    entry.proc.stdin.write(text + "\n");
  } else {
    log(`sendInput workspace=${workspace} no active process`);
  }
}

function stopProcess(workspace) {
  // Abort any pending direct-API request first
  const direct = directRequests.get(workspace);
  if (direct) direct.kill();

  const entry = activeProcesses.get(workspace);
  if (entry && entry.proc) {
    log(`stop workspace=${workspace} pid=${entry.proc.pid}`);
    entry.killed = true;
    try {
      process.kill(-entry.proc.pid, "SIGKILL");
    } catch {
      try { entry.proc.kill("SIGKILL"); } catch {}
    }
    activeProcesses.delete(workspace);
  }
}

function getSessionId(workspace) {
  return getCliSessionId(workspace);
}

function isActive(workspace) {
  return activeProcesses.has(workspace);
}

/** Return session metadata for the API. */
function getSessions(workspace) {
  const entry = sessions[workspace];
  if (!entry) return { current: null, sessions: [] };
  return {
    current: entry.current,
    sessions: Object.keys(entry.sessions).map(Number).sort((a, b) => a - b),
  };
}

/** Create a new session (increment counter, preserve old sessions). */
function newSession(workspace) {
  stopProcess(workspace);
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
  stopProcess(workspace);
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
    const workspace = file.slice(prefix.length, -6); // strip prefix + .jsonl
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

/** Kill all active processes (for graceful shutdown). */
function stopAllProcesses() {
  for (const workspace of [...activeProcesses.keys()]) {
    stopProcess(workspace);
  }
}

module.exports = {
  isInstalled,
  getBinPath,
  sendMessage,
  sendInput,
  stopProcess,
  stopAllProcesses,
  getSessionId,
  isActive,
  getSessions,
  newSession,
  setCurrentSession,
  clearSession,
  pushHistory,
  pushHistoryBatch,
  getLastMessageTime,
  getHistory,
  clearHistory,
  checkAuth,
  getAuthStatus,
  startAuthCheck,
  getModels,
  recoverStreams,
};
