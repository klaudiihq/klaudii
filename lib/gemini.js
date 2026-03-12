/**
 * Gemini manager — auth, history, models, quota, session tracking.
 * All message sending is handled by gemini-a2a.js (A2A JSON-RPC protocol).
 */

const fs = require("fs");
const path = require("path");

// --- Logging ---
const LOG_PREFIX = "[gemini]";
function log(...args) { console.log(LOG_PREFIX, new Date().toISOString(), ...args); }
function logErr(...args) { console.error(LOG_PREFIX, new Date().toISOString(), ...args); }

// --- Core driver (direct gemini-cli-core integration) ---
const a2a = require("./gemini-core");

// App data — platform-aware paths
const { DATA_DIR, CHATS_DIR } = require("./paths");
const CONVERSATIONS_DIR = CHATS_DIR;
const SESSIONS_FILE = path.join(__dirname, "..", "gemini-sessions.json");
const LEGACY_HISTORY_FILE = path.join(CONVERSATIONS_DIR, "gemini-history.json");
const GEMINI_DIR = path.join(require("os").homedir(), ".gemini");
const TRUSTED_FOLDERS_FILE = path.join(GEMINI_DIR, "trustedFolders.json");
const GOOGLE_ACCOUNTS_FILE = path.join(GEMINI_DIR, "google_accounts.json");

// Ensure conversations directory exists
if (!fs.existsSync(CONVERSATIONS_DIR)) {
  fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
}

// --- Per-workspace / per-session file helpers ---
function historyDir(workspace) {
  return path.join(CONVERSATIONS_DIR, workspace, "gemini");
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

// workspace → { current: N, sessions: { "1": cliSessionId, "2": cliSessionId } } (persisted)
let geminiSessions = {};

// Load persisted sessions on startup
try {
  if (fs.existsSync(SESSIONS_FILE)) {
    geminiSessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf-8"));
  }
} catch {
  geminiSessions = {};
}

// Migrate sessions format + old monolithic history file → per-workspace/per-session files
(function migrateData() {
  let sessionsChanged = false;
  for (const [ws, val] of Object.entries(geminiSessions)) {
    if (typeof val === "string") {
      geminiSessions[ws] = { current: 1, sessions: { "1": val } };
      sessionsChanged = true;
    }
  }
  if (sessionsChanged) {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(geminiSessions, null, 2));
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
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(geminiSessions, null, 2));
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

/**
 * Get the chat history for a workspace session (default: current).
 */
function getHistory(workspace, sessionNum) {
  const num = sessionNum || currentSessionNum(workspace);
  return readSessionHistory(workspace, num);
}

/**
 * Clear all chat history for a workspace.
 */
function clearHistory(workspace) {
  try { fs.rmSync(historyDir(workspace), { recursive: true, force: true }); } catch { /* ignore */ }
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
  if (config && config.geminiPath && fs.existsSync(config.geminiPath)) {
    cachedBinPath = config.geminiPath;
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

/** Send a message to Gemini for a workspace via A2A. */
function startChat(workspace, workspacePath, userMessage, config, opts = {}) {
  const sessionNum = opts.sessionNum || currentSessionNum(workspace);
  return a2a.startChat(workspace, sessionNum, workspacePath, userMessage, config, opts);
}

/** Kill active Gemini A2A server for a workspace (or specific session). */
function stopProcess(workspace, sessionNum) {
  a2a.stopProcess(workspace, sessionNum);
}

/**
 * Get the current Gemini CLI session ID for a workspace (for resume).
 */
function getSessionId(workspace) {
  return getCliSessionId(workspace);
}

/** Check if a Gemini A2A server is currently running for a workspace (or specific session). */
function isActive(workspace, sessionNum) {
  return a2a.isActive(workspace, sessionNum);
}

/** Return session metadata for the API (includes per-session activity info). */
function getSessions(workspace) {
  const entry = geminiSessions[workspace];
  if (!entry) return { current: null, sessions: [] };
  const nums = Object.keys(entry.sessions).map(Number);
  const details = nums.map(num => {
    let lastActivity = 0;
    try {
      const f = historyFile(workspace, String(num));
      lastActivity = fs.statSync(f).mtimeMs;
    } catch {}
    return {
      num,
      lastActivity,
      active: a2a.isActive(workspace, num),
    };
  });
  details.sort((a, b) => b.lastActivity - a.lastActivity);
  return {
    current: entry.current,
    sessions: details,
  };
}

/** Create a new session (increment counter, preserve old sessions). */
function newSession(workspace) {
  // Don't stop existing sessions — they stay alive for concurrent use
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
  // Don't stop existing sessions — they stay alive for concurrent use
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

    const { spawn } = require("child_process");
    const proc = spawn(bin, ["--list-sessions"], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });

    let stderr = "";
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    proc.on("close", (code) => {
      // Check google_accounts.json — active !== null means OAuth session exists.
      // Gemini CLI exits 0 (not 41) even when logged out if stdin is ignored,
      // so we can't rely on exit code alone for OAuth auth detection.
      let oauthEmail = null;
      try {
        if (fs.existsSync(GOOGLE_ACCOUNTS_FILE)) {
          const accounts = JSON.parse(fs.readFileSync(GOOGLE_ACCOUNTS_FILE, "utf-8"));
          if (accounts.active) oauthEmail = accounts.active;
        }
      } catch {}

      const cliOk = code !== 41;
      const oauthOk = oauthEmail !== null;

      authStatus = {
        installed: true,
        binPath: bin,
        loggedIn: cliOk && oauthOk,
        error: (!cliOk || !oauthOk) ? (stderr.trim().split("\n")[0] || null) : null,
      };
      if (authStatus.loggedIn) {
        authStatus.method = "oauth";
        authStatus.email = oauthEmail;
      }
      // Fall back to stored API key if OAuth auth failed
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

/** Kill all active Gemini A2A servers (for graceful shutdown). */
function stopAllProcesses() {
  a2a.stopAllProcesses();
}

module.exports = {
  isInstalled,
  getBinPath,
  install,
  ensureFolderTrust,
  startChat,
  stopProcess,
  stopAllProcesses,
  currentSessionNum,
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
  fetchModels,
  getModels,
  startModelRefresh,
  fetchQuota,
  getQuota,
  startQuotaRefresh,
  confirmToolCall(workspace, sessionNum, callId, outcome, answer) {
    return a2a.confirmToolCall(workspace, sessionNum, callId, outcome, answer);
  },
  executeCommand(workspace, sessionNum, command, args) {
    return a2a.executeCommand(workspace, sessionNum, command, args);
  },
};
