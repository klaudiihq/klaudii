/**
 * Gemini CLI subprocess manager.
 *
 * Spawns `gemini` in headless mode with `--output-format stream-json`,
 * parses JSONL events from stdout, and tracks session IDs per workspace
 * so that multi-turn conversations work via `--resume`.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

// --- Logging ---
const LOG_PREFIX = "[gemini]";
function log(...args) { console.log(LOG_PREFIX, new Date().toISOString(), ...args); }
function logErr(...args) { console.error(LOG_PREFIX, new Date().toISOString(), ...args); }

// App data — macOS reverse-DNS convention
const CONVERSATIONS_DIR = path.join(require("os").homedir(), "Library", "Application Support", "com.klaudii.server", "conversations");
const SESSIONS_FILE = path.join(__dirname, "..", "gemini-sessions.json");
const HISTORY_FILE = path.join(CONVERSATIONS_DIR, "gemini-history.json");
const GEMINI_DIR = path.join(require("os").homedir(), ".gemini");
const TRUSTED_FOLDERS_FILE = path.join(GEMINI_DIR, "trustedFolders.json");

// Ensure conversations directory exists
if (!fs.existsSync(CONVERSATIONS_DIR)) {
  fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
}

// workspace → { proc, sessionId, buffer }
const activeProcesses = new Map();

// workspace → { current: N, sessions: { "1": cliSessionId, "2": cliSessionId } } (persisted)
let geminiSessions = {};

// workspace → { "1": [ { role, content } ], "2": [ { role, content } ] } (persisted)
let geminiChatHistory = {};

// Load persisted sessions on startup
try {
  if (fs.existsSync(SESSIONS_FILE)) {
    geminiSessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf-8"));
  }
} catch {
  geminiSessions = {};
}

// Load persisted chat history on startup
try {
  if (fs.existsSync(HISTORY_FILE)) {
    geminiChatHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
  }
} catch {
  geminiChatHistory = {};
}

// Migrate old format: { workspace: "sessionId" } → { workspace: { current: 1, sessions: { "1": "sessionId" } } }
(function migrateData() {
  let changed = false;
  for (const [ws, val] of Object.entries(geminiSessions)) {
    if (typeof val === "string") {
      geminiSessions[ws] = { current: 1, sessions: { "1": val } };
      changed = true;
    }
  }
  for (const [ws, val] of Object.entries(geminiChatHistory)) {
    if (Array.isArray(val)) {
      geminiChatHistory[ws] = { "1": val };
      changed = true;
    }
  }
  if (changed) {
    log("migrated session/history data to multi-session format");
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(geminiSessions, null, 2));
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(geminiChatHistory, null, 2));
  }
})();

function saveSessions() {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(geminiSessions, null, 2));
}

function saveHistory() {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(geminiChatHistory, null, 2));
}

/** Get the current session number for a workspace (default 1). */
function currentSessionNum(workspace) {
  const entry = geminiSessions[workspace];
  return entry ? entry.current : 1;
}

/** Get the CLI session ID for the current (or specified) session number. */
function getCliSessionId(workspace, num) {
  const entry = geminiSessions[workspace];
  if (!entry) return null;
  const n = String(num || entry.current);
  return entry.sessions[n] || null;
}

/**
 * Append a message to a workspace's current session history.
 */
function pushHistory(workspace, role, content) {
  const num = String(currentSessionNum(workspace));
  if (!geminiChatHistory[workspace]) geminiChatHistory[workspace] = {};
  if (!geminiChatHistory[workspace][num]) geminiChatHistory[workspace][num] = [];
  geminiChatHistory[workspace][num].push({ role, content });
  saveHistory();
}

/**
 * Get the chat history for a workspace session (default: current).
 */
function getHistory(workspace, sessionNum) {
  const ws = geminiChatHistory[workspace];
  if (!ws) return [];
  const num = String(sessionNum || currentSessionNum(workspace));
  return ws[num] || [];
}

/**
 * Clear all chat history for a workspace.
 */
function clearHistory(workspace) {
  delete geminiChatHistory[workspace];
  saveHistory();
}

// Cached binary path (resolved once, reused)
let cachedBinPath = null;

/**
 * Find the gemini binary — check config.json first, then PATH, then common locations.
 * Caches the result for subsequent calls.
 */
function findGeminiBin(config) {
  if (cachedBinPath && fs.existsSync(cachedBinPath)) return cachedBinPath;

  // 1. Check config.json (absolute path stored at install/detection time)
  if (config && config.geminiBin && fs.existsSync(config.geminiBin)) {
    cachedBinPath = config.geminiBin;
    return cachedBinPath;
  }

  // 2. Check PATH
  const { execSync } = require("child_process");
  try {
    const found = execSync("which gemini 2>/dev/null", { encoding: "utf-8" }).trim();
    if (found) {
      cachedBinPath = found;
      return cachedBinPath;
    }
  } catch {}

  // 3. Common install locations
  const home = require("os").homedir();
  const candidates = [
    "/opt/homebrew/bin/gemini",
    "/usr/local/bin/gemini",
    path.join(home, ".local", "bin", "gemini"),
  ];
  const found = candidates.find((p) => fs.existsSync(p)) || null;
  if (found) cachedBinPath = found;
  return found;
}

/**
 * Check if gemini CLI is installed.
 */
function isInstalled(config) {
  return !!findGeminiBin(config);
}

/**
 * Get the resolved binary path (for storing in config).
 */
function getBinPath(config) {
  return findGeminiBin(config);
}

/**
 * Install gemini CLI via Homebrew. Returns the installed binary path.
 * Throws on failure.
 */
function install() {
  const { execSync } = require("child_process");
  execSync("brew install gemini-cli", { encoding: "utf-8", stdio: "pipe", timeout: 120000 });
  cachedBinPath = null; // clear cache so next findGeminiBin re-resolves
  const binPath = findGeminiBin();
  if (!binPath) throw new Error("gemini-cli installed but binary not found");
  return binPath;
}

/**
 * Ensure a directory is trusted by Gemini CLI.
 * Writes/updates ~/.gemini/trustedFolders.json with TRUST_PARENT for the
 * repos directory so all workspace subdirectories are auto-trusted.
 */
function ensureFolderTrust(reposDir) {
  if (!reposDir) return;

  let trusted = {};
  try {
    if (fs.existsSync(TRUSTED_FOLDERS_FILE)) {
      trusted = JSON.parse(fs.readFileSync(TRUSTED_FOLDERS_FILE, "utf-8"));
    }
  } catch {
    trusted = {};
  }

  // Use TRUST_PARENT on the reposDir — this trusts dirname(reposDir) and everything under it,
  // but we actually want to trust reposDir itself and its children.
  // The source code does: effectivePath = path.dirname(rulePath) when TRUST_PARENT.
  // So to trust /repos and all children, we set TRUST_PARENT on /repos/ANY_CHILD.
  // Simpler: just use TRUST_FOLDER on the reposDir itself — but that only trusts that exact folder.
  // Actually looking at the code: isWithinRoot checks if location is within effectivePath.
  // For TRUST_PARENT: effectivePath = dirname(reposDir) = parent of repos.
  // That would trust everything under the parent, which is too broad.
  //
  // Safest approach: set TRUST_FOLDER on reposDir. The isWithinRoot check will match
  // any path that starts with reposDir, so all workspace subdirs are trusted.
  if (trusted[reposDir] === "TRUST_FOLDER") return; // already set

  trusted[reposDir] = "TRUST_FOLDER";

  if (!fs.existsSync(GEMINI_DIR)) {
    fs.mkdirSync(GEMINI_DIR, { recursive: true });
  }
  fs.writeFileSync(TRUSTED_FOLDERS_FILE, JSON.stringify(trusted, null, 2), { mode: 0o600 });
}

/**
 * Send a message to Gemini for a workspace.
 *
 * Spawns `gemini "message" --output-format stream-json [--resume sessionId]`
 * in the workspace directory.
 *
 * Returns an object with:
 *   - onEvent(callback): register a handler for parsed JSONL events
 *   - onDone(callback): register a handler for process exit
 *   - onError(callback): register a handler for spawn/parse errors
 *   - kill(): kill the subprocess
 */
function sendMessage(workspace, workspacePath, userMessage, config, opts = {}) {
  // Kill any existing process for this workspace
  stopProcess(workspace);

  const geminiBin = findGeminiBin(config);
  if (!geminiBin) {
    throw new Error("gemini CLI not found — install with: brew install gemini-cli");
  }

  const args = [userMessage, "--output-format", "stream-json", "--approval-mode", "yolo"];

  if (opts.model) {
    args.push("--model", opts.model);
  }

  const sessionId = getCliSessionId(workspace);
  if (sessionId) {
    args.push("--resume", sessionId);
  }

  // Build env — inject API key if provided (per-workspace > global)
  const env = { ...process.env };
  if (opts.apiKey) {
    env.GEMINI_API_KEY = opts.apiKey;
  }

  const spawnStart = Date.now();
  log(`spawn workspace=${workspace} bin=${geminiBin} args=${JSON.stringify(args)} cwd=${workspacePath} hasApiKey=${!!opts.apiKey}`);

  // detached: true so we get a process group we can kill cleanly
  const proc = spawn(geminiBin, args, {
    cwd: workspacePath,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  log(`spawned pid=${proc.pid} workspace=${workspace}`);

  const entry = { proc, sessionId: sessionId || null, killed: false };
  activeProcesses.set(workspace, entry);

  let eventCallback = null;
  let doneCallback = null;
  let errorCallback = null;
  let eventCount = 0;
  let firstEventAt = null;

  // Parse stdout line by line as JSONL
  const rl = readline.createInterface({ input: proc.stdout });

  rl.on("line", (line) => {
    // Drop events after kill
    if (entry.killed) return;

    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const event = JSON.parse(trimmed);
      eventCount++;
      if (!firstEventAt) {
        firstEventAt = Date.now();
        log(`first-event workspace=${workspace} elapsed=${firstEventAt - spawnStart}ms type=${event.type}`);
      }
      log(`event workspace=${workspace} #${eventCount} type=${event.type}${event.role ? " role=" + event.role : ""}${event.content ? " len=" + event.content.length : ""}${event.name ? " name=" + event.name : ""}`);

      // Capture session ID from init event — store in current session slot
      const sid = event.session_id || event.sessionId;
      if (event.type === "init" && sid) {
        entry.sessionId = sid;
        if (!geminiSessions[workspace]) {
          geminiSessions[workspace] = { current: 1, sessions: {} };
        }
        const ws = geminiSessions[workspace];
        ws.sessions[String(ws.current)] = sid;
        saveSessions();
        log(`session-id workspace=${workspace} session#${ws.current} sessionId=${sid}`);
      }

      if (eventCallback) eventCallback(event);
    } catch {
      log(`non-json-line workspace=${workspace} line=${trimmed.slice(0, 200)}`);
    }
  });

  // Capture stderr for error reporting — forward retry/quota messages as status events
  let stderrBuf = "";
  proc.stderr.on("data", (chunk) => {
    if (entry.killed) return;
    const text = chunk.toString();
    stderrBuf += text;
    log(`stderr workspace=${workspace} pid=${proc.pid}: ${text.trim().slice(0, 300)}`);

    // Forward retry/quota/rate-limit messages so the UI can show them
    const line = text.trim();
    if (line && (line.includes("Retrying") || line.includes("exhausted") || line.includes("quota") || line.includes("rate"))) {
      if (eventCallback) eventCallback({ type: "status", message: line.split("\n")[0] });
    }
  });

  proc.on("close", (code) => {
    const elapsed = Date.now() - spawnStart;
    log(`close workspace=${workspace} pid=${proc.pid} code=${code} elapsed=${elapsed}ms events=${eventCount} killed=${entry.killed} stderr=${stderrBuf.trim().slice(0, 200) || "(none)"}`);
    activeProcesses.delete(workspace);
    if (!entry.killed && doneCallback) doneCallback({ code, stderr: stderrBuf });
  });

  proc.on("error", (err) => {
    logErr(`spawn-error workspace=${workspace} pid=${proc.pid} err=${err.message}`);
    activeProcesses.delete(workspace);
    if (!entry.killed && errorCallback) errorCallback(err);
  });

  return {
    onEvent(cb) { eventCallback = cb; },
    onDone(cb) { doneCallback = cb; },
    onError(cb) { errorCallback = cb; },
    kill() { stopProcess(workspace); },
  };
}

/**
 * Kill active Gemini process for a workspace.
 * Kills the entire process group (detached) so child processes die too.
 */
function stopProcess(workspace) {
  const entry = activeProcesses.get(workspace);
  if (entry && entry.proc) {
    log(`stop workspace=${workspace} pid=${entry.proc.pid}`);
    entry.killed = true;
    try {
      // Kill the process group (negative PID) — this kills gemini and all its children
      process.kill(-entry.proc.pid, "SIGKILL");
    } catch {
      // Fallback: kill just the process
      try { entry.proc.kill("SIGKILL"); } catch {}
    }
    activeProcesses.delete(workspace);
  }
}

/**
 * Get the current Gemini CLI session ID for a workspace (for resume).
 */
function getSessionId(workspace) {
  return getCliSessionId(workspace);
}

/**
 * Check if a Gemini process is currently running for a workspace.
 */
function isActive(workspace) {
  return activeProcesses.has(workspace);
}

/** Return session metadata for the API. */
function getSessions(workspace) {
  const entry = geminiSessions[workspace];
  if (!entry) return { current: null, sessions: [] };
  return {
    current: entry.current,
    sessions: Object.keys(entry.sessions).map(Number).sort((a, b) => a - b),
  };
}

/** Create a new session (increment counter, preserve old sessions). */
function newSession(workspace) {
  stopProcess(workspace);
  const entry = geminiSessions[workspace];
  if (!entry) {
    geminiSessions[workspace] = { current: 1, sessions: {} };
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
  const entry = geminiSessions[workspace];
  if (!entry || !entry.sessions.hasOwnProperty(String(num))) return false;
  stopProcess(workspace);
  entry.current = num;
  saveSessions();
  log(`switch-session workspace=${workspace} session#${num}`);
  return true;
}

/** Delete everything for a workspace (nuclear option). */
function clearSession(workspace) {
  delete geminiSessions[workspace];
  saveSessions();
  clearHistory(workspace);
  stopProcess(workspace);
}

// --- Auth status (cached, refreshed periodically) ---

let authStatus = { installed: false, loggedIn: false, error: null };
let authCheckInterval = null;

/**
 * Probe auth by spawning `gemini --list-sessions`.
 * This triggers the auth check without making any inference calls.
 * Exit code 41 = not authenticated. Exit code 0 = authenticated.
 */
function checkAuth(config) {
  const bin = findGeminiBin(config);
  if (!bin) {
    authStatus = { installed: false, loggedIn: false, binPath: null, error: null };
    log("auth-check: not installed");
    return Promise.resolve(authStatus);
  }

  const start = Date.now();
  log("auth-check: starting");

  return new Promise((resolve) => {
    // Inject stored API key so the CLI recognizes it as authenticated
    const env = { ...process.env };
    if (config && config.geminiApiKey) {
      env.GEMINI_API_KEY = config.geminiApiKey;
    }

    const proc = spawn(bin, ["--list-sessions"], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });

    let stderr = "";
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    proc.on("close", (code) => {
      authStatus = {
        installed: true,
        binPath: bin,
        loggedIn: code !== 41,
        error: code === 41 ? stderr.trim().split("\n")[0] : null,
      };
      // Try to extract email from Google OAuth ID token
      if (authStatus.loggedIn) {
        authStatus.method = "oauth";
        try {
          const creds = readOAuthCreds();
          if (creds && creds.id_token) {
            const parts = creds.id_token.split(".");
            if (parts.length >= 2) {
              const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
              if (payload.email) authStatus.email = payload.email;
            }
          }
        } catch {}
      }
      // Fall back to stored API key if CLI auth failed
      if (!authStatus.loggedIn && config) {
        const apiKey = config.geminiApiKey;
        if (apiKey) {
          authStatus.loggedIn = true;
          authStatus.method = "api_key";
          authStatus.error = null;
        }
      }
      log(`auth-check: done in ${Date.now() - start}ms code=${code} loggedIn=${authStatus.loggedIn} method=${authStatus.method || "none"} email=${authStatus.email || "none"}`);
      resolve(authStatus);
    });

    proc.on("error", (err) => {
      authStatus = { installed: true, binPath: bin, loggedIn: false, error: "failed to spawn" };
      logErr(`auth-check: spawn error: ${err.message}`);
      resolve(authStatus);
    });

    // Safety timeout
    setTimeout(() => {
      try { proc.kill("SIGTERM"); } catch {}
    }, 10000);
  });
}

/**
 * Get the last cached auth status (synchronous).
 */
function getAuthStatus() {
  return authStatus;
}

/**
 * Start periodic auth checks (every intervalMs, default 5 min).
 */
function startAuthCheck(config, intervalMs = 5 * 60 * 1000) {
  // Run immediately
  checkAuth(config);
  // Then every interval
  if (authCheckInterval) clearInterval(authCheckInterval);
  authCheckInterval = setInterval(() => checkAuth(config), intervalMs);
}

// --- Model discovery (cached, refreshed periodically) ---

// Matches VALID_GEMINI_MODELS from gemini-cli source (packages/core/src/config/models.ts)
// This is the canonical list — the CLI hardcodes it too.
const KNOWN_MODELS = [
  { id: "gemini-3-pro-preview", name: "3 Pro" },
  { id: "gemini-3-flash-preview", name: "3 Flash" },
  { id: "gemini-2.5-pro", name: "2.5 Pro" },
  { id: "gemini-2.5-flash", name: "2.5 Flash" },
  { id: "gemini-2.5-flash-lite", name: "2.5 Flash Lite" },
];

let cachedModels = null;
let modelsCheckInterval = null;

/**
 * Helper: make an HTTPS GET/POST request and return parsed JSON.
 */
function httpsRequest(url, opts = {}) {
  const https = require("https");
  return new Promise((resolve, reject) => {
    const method = opts.method || "GET";
    const urlObj = new URL(url);
    const reqOpts = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: { ...opts.headers },
    };
    if (opts.body) {
      reqOpts.headers["Content-Type"] = "application/json";
      reqOpts.headers["Content-Length"] = Buffer.byteLength(opts.body);
    }
    const req = https.request(reqOpts, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("timeout")); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/**
 * Fetch available models from the Google Generative AI API.
 * Uses API key when available; falls back to KNOWN_MODELS (matching CLI source).
 */
async function fetchModels(config) {
  const apiKey = config && config.geminiApiKey;
  if (!apiKey) {
    // No API key — use the CLI's known model list
    if (!cachedModels) cachedModels = KNOWN_MODELS;
    return cachedModels;
  }

  try {
    const data = await httpsRequest(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
    );

    if (!data.models || !Array.isArray(data.models)) {
      return cachedModels || KNOWN_MODELS;
    }

    // Filter: must support generateContent, must be a gemini model
    const models = data.models
      .filter((m) =>
        m.name && m.name.startsWith("models/gemini") &&
        m.supportedGenerationMethods &&
        m.supportedGenerationMethods.includes("generateContent")
      )
      .map((m) => {
        const id = m.name.replace("models/", "");
        // Use short display name from KNOWN_MODELS if we recognize it, else API displayName
        const known = KNOWN_MODELS.find((k) => k.id === id);
        return { id, name: known ? known.name : (m.displayName || id) };
      })
      // Sort: latest generation first, pro before flash, lite last
      .sort((a, b) => {
        const genA = (a.id.match(/gemini-(\d+\.?\d*)/)?.[1] || "0");
        const genB = (b.id.match(/gemini-(\d+\.?\d*)/)?.[1] || "0");
        if (genA !== genB) return parseFloat(genB) - parseFloat(genA);
        const tier = (id) => id.includes("pro") ? 0 : id.includes("flash-lite") ? 2 : id.includes("flash") ? 1 : 3;
        return tier(a.id) - tier(b.id);
      });

    cachedModels = models.length ? models : KNOWN_MODELS;
  } catch {
    if (!cachedModels) cachedModels = KNOWN_MODELS;
  }

  return cachedModels;
}

/**
 * Get cached models (synchronous). Returns KNOWN_MODELS if not yet fetched.
 */
function getModels() {
  return cachedModels || KNOWN_MODELS;
}

/**
 * Start periodic model list refresh (every intervalMs, default 1 hour).
 */
function startModelRefresh(config, intervalMs = 60 * 60 * 1000) {
  fetchModels(config);
  if (modelsCheckInterval) clearInterval(modelsCheckInterval);
  modelsCheckInterval = setInterval(() => fetchModels(config), intervalMs);
}

// --- OAuth credential reuse (read tokens from gemini CLI) ---

const OAUTH_CREDS_FILE = path.join(GEMINI_DIR, "oauth_creds.json");
const OAUTH_CLIENT_ID = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";

/**
 * Read the gemini CLI's cached OAuth credentials.
 * Returns { access_token, refresh_token, expiry_date } or null.
 */
function readOAuthCreds() {
  try {
    if (!fs.existsSync(OAUTH_CREDS_FILE)) return null;
    const creds = JSON.parse(fs.readFileSync(OAUTH_CREDS_FILE, "utf-8"));
    if (!creds.refresh_token && !creds.access_token) return null;
    return creds;
  } catch {
    return null;
  }
}

/**
 * Get a valid access token — refresh if expired.
 * Returns the access_token string or null.
 */
async function getAccessToken() {
  const creds = readOAuthCreds();
  if (!creds) return null;

  // If token is still fresh (with 60s buffer), use it directly
  if (creds.access_token && creds.expiry_date && creds.expiry_date > Date.now() + 60000) {
    return creds.access_token;
  }

  // Refresh the token
  if (!creds.refresh_token) return creds.access_token || null;

  try {
    const querystring = require("querystring");
    const body = querystring.stringify({
      client_id: OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: creds.refresh_token,
    });

    const result = await httpsRequest("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    return result.access_token || null;
  } catch {
    // Refresh failed — return stale token as last resort
    return creds.access_token || null;
  }
}

// --- Quota (cached, refreshed periodically) ---

let cachedQuota = null;
let quotaCheckInterval = null;

/**
 * Fetch user quota from the CloudCode API (OAuth users) or return null.
 * Uses the gemini CLI's stored OAuth credentials.
 *
 * Based on gemini-cli source: packages/core/src/code_assist/server.ts
 * Endpoint: POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota
 */
async function fetchQuota() {
  const token = await getAccessToken();
  if (!token) {
    cachedQuota = null;
    return null;
  }

  try {
    const data = await httpsRequest(
      "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      }
    );

    if (data.buckets && Array.isArray(data.buckets)) {
      cachedQuota = {
        buckets: data.buckets.map((b) => ({
          remainingAmount: b.remainingAmount ? parseInt(b.remainingAmount, 10) : null,
          remainingFraction: b.remainingFraction ?? null,
          resetTime: b.resetTime || null,
          tokenType: b.tokenType || null,
          modelId: b.modelId || null,
        })),
        fetchedAt: Date.now(),
      };
    } else {
      cachedQuota = { buckets: [], fetchedAt: Date.now() };
    }
  } catch {
    // API may not be available (API key users, etc.) — that's fine
    if (!cachedQuota) cachedQuota = null;
  }

  return cachedQuota;
}

/**
 * Get cached quota (synchronous).
 */
function getQuota() {
  return cachedQuota;
}

/**
 * Start periodic quota refresh (every intervalMs, default 5 min).
 */
function startQuotaRefresh(intervalMs = 5 * 60 * 1000) {
  fetchQuota();
  if (quotaCheckInterval) clearInterval(quotaCheckInterval);
  quotaCheckInterval = setInterval(fetchQuota, intervalMs);
}

module.exports = {
  isInstalled,
  getBinPath,
  install,
  ensureFolderTrust,
  sendMessage,
  stopProcess,
  getSessionId,
  isActive,
  getSessions,
  newSession,
  setCurrentSession,
  clearSession,
  pushHistory,
  getHistory,
  clearHistory,
  checkAuth,
  getAuthStatus,
  startAuthCheck,
  fetchModels,
  getModels,
  startModelRefresh,
  fetchQuota,
  getQuota,
  startQuotaRefresh,
};
