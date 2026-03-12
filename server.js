// ── Parse --config before any requires so lib/paths.js picks it up ──
(function() {
  const i = process.argv.indexOf("--config");
  if (i >= 0 && process.argv[i + 1]) {
    // Use require("path").resolve so relative paths work from any cwd
    process.env.KLAUDII_CONFIG = require("path").resolve(process.argv[i + 1]);
  }
})();

const path = require("path");
const fs = require("fs");
const os = require("os");
const { DATA_DIR } = require("./lib/paths");

// ── PID lockfile: displace any existing instance ──
(function checkPidLock() {
  const pidPath = path.join(DATA_DIR, "server.pid");
  try {
    const pid = parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10);
    if (!isNaN(pid)) {
      try {
        process.kill(pid, 0); // alive?
        console.log(`[server] Displacing existing instance (PID ${pid})...`);
        try { process.kill(pid, "SIGTERM"); } catch {}
        // Give it a moment to release the port; if it doesn't, we'll get EADDRINUSE
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          try { process.kill(pid, 0); } catch { break; } // gone
          const buf = new SharedArrayBuffer(4);
          Atomics.wait(new Int32Array(buf), 0, 0, 100);
        }
      } catch { /* already gone — stale pidfile */ }
      fs.unlinkSync(pidPath);
    }
  } catch { /* no pidfile — first launch */ }
})();

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { loadConfig, getProjects, addProject, removeProject, getProject, setPermissionMode } = require("./lib/projects");
const tmux = require("./lib/tmux");
const ttyd = require("./lib/ttyd");
const claude = require("./lib/claude");
const github = require("./lib/github");
const git = require("./lib/git");
const processes = require("./lib/processes");
const sessionTracker = require("./lib/session-tracker");
const createV1Router = require("./routes/v1");
const gemini = require("./lib/gemini");
const claudeChat = require("./lib/claude-chat");
const workspaceState = require("./lib/workspace-state");
claudeChat.init({ workspaceState });
const setup = require("./lib/setup");
const { mountMcp } = require("./lib/mcp");
const scheduler = require("./lib/scheduler");
const memory = require("./lib/memory");

process.on('uncaughtException', (err) => {
  // Relay socket errors are recoverable — the relay reconnects on next message.
  // Don't crash the whole server for a single workspace failure.
  if (err.message === 'relay heartbeat timeout' || /relay socket/i.test(err.message)) {
    console.error('[warn] Recovered relay exception (non-fatal):', err.message);
    return;
  }
  console.error('[fatal] Uncaught exception:', err);
  process.exit(1);
});

// Log unhandled rejections but don't exit — most are from transient
// network failures (e.g. Konnect WebSocket drops) that are non-fatal.
process.on('unhandledRejection', (reason) => {
  console.error('[warn] Unhandled rejection:', reason);
});

let config = loadConfig();
const app = express();
app.use(express.json());

// Allow Chrome extension to reach the API from any origin
app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  if (origin.startsWith("chrome-extension://") || origin.startsWith("moz-extension://")) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.sendStatus(204);
  }
  next();
});

// --- Setup / limp-mode routes (registered before static middleware) ---
setup.start();

app.get("/", (_req, res, next) => {
  if (setup.limpMode) return res.redirect("/setup.html");
  next();
});
app.get("/api/setup/status",   (_req, res) => res.json(setup.getStatus()));
app.get("/api/setup/stream",   (req, res)  => setup.addSseClient(req, res));
app.post("/api/setup/install", (_req, res) => {
  setup.installMissing().catch(() => {});
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, "public")));

// Catch-all for non-API routes: redirect to setup page when in limp mode
app.get(/^(?!\/api\/).*$/, (_req, res, next) => {
  if (setup.limpMode) return res.redirect("/setup.html");
  next();
});

// --- Mount v1 API routes ---

app.use(
  "/api",
  createV1Router({
    tmux,
    ttyd,
    claude,
    git,
    github,
    processes,
    sessionTracker,
    projects: { getProjects, getProject, addProject, removeProject, setPermissionMode },
    config,
    gemini,
    claudeChat,
    workspaceState,
    broadcastAll: (payload) => { if (typeof broadcastAll === "function") broadcastAll(payload); },
  })
);

// --- MCP SSE ---

mountMcp(app, {
  tmux,
  ttyd,
  git,
  github,
  sessionTracker,
  projects: { getProjects, getProject, addProject, removeProject, setPermissionMode },
  config,
  claudeChat,
  workspaceState,
});

// --- Scheduler ---

app.get("/api/scheduler", (_req, res) => {
  res.json(scheduler.list());
});

app.post("/api/scheduler/:name/pause", (req, res) => {
  const ok = scheduler.pause(req.params.name);
  if (!ok) return res.status(404).json({ error: `task "${req.params.name}" not found` });
  res.json({ ok: true });
});

app.post("/api/scheduler/:name/resume", (req, res) => {
  const ok = scheduler.resume(req.params.name);
  if (!ok) return res.status(404).json({ error: `task "${req.params.name}" not found` });
  res.json({ ok: true });
});

app.post("/api/scheduler/:name/trigger", async (req, res) => {
  const result = await scheduler.trigger(req.params.name);
  if (!result) return res.status(404).json({ error: `task "${req.params.name}" not found` });
  res.json({ ok: true, ...result });
});

// --- Tasks ---

// Tasks CRUD endpoints are in routes/v1.js

// --- Gemini ---

app.get("/api/gemini/status", (_req, res) => {
  res.json({ installed: gemini.isInstalled(config), binPath: gemini.getBinPath(config) });
});

app.post("/api/gemini/install", async (_req, res) => {
  if (gemini.isInstalled(config)) {
    return res.json({ ok: true, binPath: gemini.getBinPath(config), alreadyInstalled: true });
  }
  try {
    const binPath = gemini.install();
    // Persist the resolved path to config so launchd can find it
    config.geminiPath = binPath;
    const { saveConfig } = require("./lib/projects");
    if (saveConfig) saveConfig(config);
    res.json({ ok: true, binPath });
  } catch (err) {
    res.status(500).json({ error: `Failed to install gemini-cli: ${err.message}` });
  }
});

// Available Gemini models (cached, refreshed hourly)
app.get("/api/gemini/models", async (_req, res) => {
  const models = await gemini.fetchModels(config);
  res.json(models);
});

// Gemini quota (OAuth users — reads cached tokens from ~/.gemini/oauth_creds.json)
app.get("/api/gemini/quota", async (_req, res) => {
  const quota = await gemini.fetchQuota();
  res.json(quota || { buckets: [] });
});

// Force an immediate auth re-check (used after OAuth login)
app.post("/api/gemini/auth/recheck", async (_req, res) => {
  const result = await gemini.checkAuth(config);
  res.json(result);
});

app.get("/api/gemini/sessions/:project", (req, res) => {
  const { project } = req.params;
  const sessData = gemini.getSessions(project);
  res.json({
    ...sessData,
    active: gemini.isActive(project),
  });
});

// New Chat — creates a new session slot, preserves old ones
app.post("/api/gemini/clear/:project", (req, res) => {
  const { project } = req.params;
  const session = gemini.newSession(project);
  res.json({ ok: true, session });
});

// Switch to a specific session number
app.post("/api/gemini/sessions/:project/switch", (req, res) => {
  const { project } = req.params;
  const { session } = req.body;
  if (!session) return res.status(400).json({ error: "session number required" });
  const ok = gemini.setCurrentSession(project, Number(session));
  if (!ok) return res.status(404).json({ error: `session ${session} not found` });
  res.json({ ok: true, current: Number(session) });
});

// Partial stream content — accumulated text for the current in-progress turn.
// Gemini uses the crash-recovery stream log (disk); Claude uses an in-memory buffer.
// Used by clients switching back to a workspace mid-stream so they can show what
// was generated before they left (Claude only — Gemini A2A maintains its own state).
app.get("/api/gemini/stream-partial/:project", (req, res) => {
  const sessionNum = req.query.session ? Number(req.query.session) : undefined;
  const text = claudeChat.getStreamPartial(req.params.project, sessionNum);
  if (text === null) return res.status(404).json({ error: "no active stream" });
  res.json({ text });
});

// Chat history (server-side, synced across devices)
app.get("/api/gemini/history/:project", (req, res) => {
  const sessionNum = req.query.session ? Number(req.query.session) : undefined;
  const history = gemini.getHistory(req.params.project, sessionNum);
  const limit = req.query.limit ? Number(req.query.limit) : 0;
  const offset = req.query.offset ? Number(req.query.offset) : 0;
  if (limit > 0) {
    const start = Math.max(0, history.length - offset - limit);
    const end = history.length - offset;
    res.json({ messages: history.slice(start, end), total: history.length });
  } else {
    res.json({ messages: history, total: history.length });
  }
});

app.post("/api/gemini/history/:project", (req, res) => {
  const { role, content } = req.body;
  if (!role || !content) return res.status(400).json({ error: "role and content required" });
  gemini.pushHistory(req.params.project, role, content);
  res.json({ ok: true });
});

app.get("/api/gemini/stats/:project", (req, res) => {
  res.json(workspaceState.getCumulativeStats(req.params.project));
});

// Save Gemini API key (global or per-workspace)
app.post("/api/gemini/apikey", (req, res) => {
  const { apiKey, workspace } = req.body;
  if (!apiKey) return res.status(400).json({ error: "apiKey required" });

  const { loadConfig, saveConfig } = require("./lib/projects");
  const cfg = loadConfig();

  if (workspace) {
    // Per-workspace key
    const proj = (cfg.projects || []).find((p) => p.name === workspace);
    if (!proj) return res.status(404).json({ error: `workspace "${workspace}" not found` });
    proj.geminiApiKey = apiKey;
  } else {
    // Global key
    cfg.geminiApiKey = apiKey;
  }

  saveConfig(cfg);
  config = cfg; // refresh in-memory config

  // Re-probe auth with the new key
  gemini.checkAuth(config);

  res.json({ ok: true, scope: workspace || "global" });
});

// Delete Gemini API key
app.delete("/api/gemini/apikey", (req, res) => {
  const { workspace } = req.body || {};
  const { loadConfig, saveConfig } = require("./lib/projects");
  const cfg = loadConfig();

  if (workspace) {
    const proj = (cfg.projects || []).find((p) => p.name === workspace);
    if (proj) delete proj.geminiApiKey;
  } else {
    delete cfg.geminiApiKey;
  }

  saveConfig(cfg);
  config = cfg;
  gemini.checkAuth(config);
  res.json({ ok: true });
});

// Get current API key info (masked) for UI
function geminiApiKeyInfo(workspace) {
  const proj = workspace ? (config.projects || []).find((p) => p.name === workspace) : null;
  const workspaceKey = proj && proj.geminiApiKey ? proj.geminiApiKey : null;
  const globalKey = config.geminiApiKey || null;
  const activeKey = workspaceKey || globalKey;

  return {
    hasKey: !!activeKey,
    scope: workspaceKey ? "workspace" : (globalKey ? "global" : null),
    masked: activeKey ? activeKey.slice(0, 6) + "..." + activeKey.slice(-4) : null,
    hasGlobalKey: !!globalKey,
    hasWorkspaceKey: !!workspaceKey,
  };
}

app.get("/api/gemini/apikey/:workspace", (req, res) => {
  res.json(geminiApiKeyInfo(req.params.workspace));
});

app.post("/api/gemini/:workspace/confirm", (req, res) => {
  const { workspace } = req.params;
  const { callId, outcome, answer, sessionNum } = req.body;
  console.log(`[confirm] workspace=${workspace} session=${sessionNum} callId=${callId} outcome=${outcome} answer=${JSON.stringify(answer)}`);
  try {
    // Record the user's tool confirmation/answer in history
    if (answer) {
      const answerText = typeof answer === "string" ? answer : JSON.stringify(answer);
      gemini.pushHistoryBatch(workspace, [{ role: "tool_result", content: JSON.stringify({ tool_id: callId, status: outcome === "approve" ? "success" : "denied", output: answerText }) }], sessionNum);
    } else {
      gemini.pushHistoryBatch(workspace, [{ role: "tool_result", content: JSON.stringify({ tool_id: callId, status: outcome === "approve" ? "success" : "denied", output: outcome }) }], sessionNum);
    }

    const handle = gemini.confirmToolCall(workspace, sessionNum, callId, outcome, answer);

    // Accumulate events for history persistence (mirrors main chat handler)
    let assistantText = "";
    const toolEvents = [];

    handle.onEvent((event) => {
      broadcastToWorkspace(workspace, { ...event, workspace, sessionNum });
      // Accumulate for persistence
      if (event.type === "message" && (event.role === "assistant" || !event.role)) {
        assistantText += event.content || "";
      } else if (event.type === "tool_use") {
        toolEvents.push({
          role: "tool_use",
          content: JSON.stringify({
            tool_name: event.tool_name,
            tool_id: event.tool_id,
            parameters: event.parameters || {},
          }),
        });
      } else if (event.type === "tool_result") {
        const out = event.output || "";
        toolEvents.push({
          role: "tool_result",
          content: JSON.stringify({
            tool_id: event.tool_id,
            status: event.status || "success",
            output: out.length > 3000 ? out.slice(0, 3000) + "\n...(truncated)" : out,
          }),
        });
        // Incremental flush after every tool_result
        const midBatch = [...toolEvents];
        if (assistantText) midBatch.push({ role: "assistant", content: assistantText });
        if (midBatch.length > 0) gemini.pushHistoryBatch(workspace, midBatch, sessionNum);
        assistantText = "";
        toolEvents.length = 0;
      } else if (event.type === "result") {
        // Turn boundary — flush any remaining assistant text after last tool_result
        const batch = [...toolEvents];
        if (assistantText) batch.push({ role: "assistant", content: assistantText });
        if (batch.length > 0) gemini.pushHistoryBatch(workspace, batch, sessionNum);
        assistantText = "";
        toolEvents.length = 0;
      }
    });
    handle.onDone(() => {
      // Flush any remaining events not yet persisted by a result event
      const batch = [...toolEvents];
      if (assistantText) batch.push({ role: "assistant", content: assistantText });
      if (batch.length > 0) gemini.pushHistoryBatch(workspace, batch, sessionNum);
      workspaceState.setStreaming(workspace, false, sessionNum);
      broadcastToWorkspace(workspace, { type: "done", workspace, sessionNum, exitCode: 0 });
    });
    handle.onError((err) => {
      // Still persist whatever we accumulated before the error
      const batch = [...toolEvents];
      if (assistantText) batch.push({ role: "assistant", content: assistantText });
      if (batch.length > 0) gemini.pushHistoryBatch(workspace, batch, sessionNum);
      console.error(`[confirm] error workspace=${workspace} session=${sessionNum}:`, err.message);
      broadcastToWorkspace(workspace, { type: "error", workspace, sessionNum, message: err.message });
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/gemini/apikey", (_req, res) => {
  res.json(geminiApiKeyInfo(null));
});

// Spawn gemini in tmux, scrape the OAuth URL from pane output, and open it in the browser
app.post("/api/gemini/auth/login", async (_req, res) => {
  const tmuxName = "gemini-auth";

  // Kill existing auth session if any
  try { tmux.killSession(tmuxName); } catch {}

  const geminiBin = gemini.getBinPath(config) || "gemini";
  const { execSync } = require("child_process");
  const TMUX = `tmux -S '${tmux.TMUX_SOCKET}'`;
  // NO_BROWSER=true: gemini prints the OAuth URL and waits for the user to paste the auth code
  const shellCmd = `source ~/.zshrc 2>/dev/null; NO_BROWSER=true ${geminiBin}`;
  const tmuxCmd = `${TMUX} new-session -d -x 500 -y 50 -s '${tmuxName}' /bin/zsh -c '${shellCmd.replace(/'/g, "'\\''")}'`;

  try {
    execSync(tmuxCmd, { stdio: "pipe" });
  } catch (err) {
    return res.status(500).json({ error: `Failed to create auth session: ${err.message}` });
  }

  // Poll for the URL (up to 15s) — NO_BROWSER prints it on one line immediately
  const urlRe = /https:\/\/accounts\.google\.com\S+|https:\/\/\S*google\S*\/auth\S*/;
  let authUrl = null;

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const paneText = tmux.capturePane(tmuxName);
    if (!paneText) continue;
    const joined = paneText.replace(/\n/g, " ");
    const match = joined.match(urlRe);
    if (match) {
      authUrl = match[0].trim();
      break;
    }
    if (!tmux.sessionExists(tmuxName)) break;
  }

  if (authUrl) {
    // Return URL — client shows it as a link + prompts for the auth code
    res.json({ ok: true, url: authUrl });
  } else {
    // No URL found — maybe already authenticated, or gemini printed something unexpected
    try { tmux.killSession(tmuxName); } catch {}
    const status = await gemini.checkAuth(config);
    if (status.loggedIn) {
      res.json({ ok: true, alreadyAuthenticated: true });
    } else {
      res.status(500).json({ error: "Could not extract OAuth URL. Try running `gemini` in your terminal to authenticate." });
    }
  }

  // Auto-cleanup: poll for session end, then re-check auth
  const cleanup = setInterval(() => {
    if (!tmux.sessionExists(tmuxName)) {
      clearInterval(cleanup);
      gemini.checkAuth(config);
    }
  }, 3000);

  // Safety: stop polling after 10 min
  setTimeout(() => {
    clearInterval(cleanup);
    try { tmux.killSession(tmuxName); } catch {}
  }, 10 * 60 * 1000);
});

// Submit the auth code that Google gave the user back to the waiting gemini session
app.post("/api/gemini/auth/code", (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "code required" });
  try {
    tmux.sendKeys("gemini-auth", code.trim());
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Claude Chat ---

app.get("/api/claude-chat/status", (_req, res) => {
  res.json({ installed: claudeChat.isInstalled(config), binPath: claudeChat.getBinPath(config) });
});

app.get("/api/claude-chat/models", (_req, res) => {
  res.json(claudeChat.getModels());
});

app.get("/api/claude-chat/sessions/:project", (req, res) => {
  const { project } = req.params;
  const sessData = claudeChat.getSessions(project);
  res.json({
    ...sessData,
    active: claudeChat.isActive(project),
  });
});

// New Chat — creates a new session slot, preserves old ones
app.post("/api/claude-chat/clear/:project", (req, res) => {
  const { project } = req.params;
  const session = claudeChat.newSession(project);
  workspaceState.resetCumulativeStats(project);
  res.json({ ok: true, session });
});

// Switch to a specific session number
app.post("/api/claude-chat/sessions/:project/switch", (req, res) => {
  const { project } = req.params;
  const { session } = req.body;
  if (!session) return res.status(400).json({ error: "session number required" });
  const ok = claudeChat.setCurrentSession(project, Number(session));
  if (!ok) return res.status(404).json({ error: `session ${session} not found` });
  workspaceState.resetCumulativeStats(project);
  res.json({ ok: true, current: Number(session) });
});

app.get("/api/claude-chat/history/:project", (req, res) => {
  const sessionNum = req.query.session ? Number(req.query.session) : undefined;
  const history = claudeChat.getHistory(req.params.project, sessionNum);
  const limit = req.query.limit ? Number(req.query.limit) : 0;
  const offset = req.query.offset ? Number(req.query.offset) : 0;
  if (limit > 0) {
    const start = Math.max(0, history.length - offset - limit);
    const end = history.length - offset;
    res.json({ messages: history.slice(start, end), total: history.length });
  } else {
    res.json({ messages: history, total: history.length });
  }
});

app.post("/api/claude-chat/history/:project", (req, res) => {
  const { role, content } = req.body;
  if (!role || !content) return res.status(400).json({ error: "role and content required" });
  claudeChat.pushHistory(req.params.project, role, content);
  res.json({ ok: true });
});

app.get("/api/claude-chat/stats/:project", (req, res) => {
  res.json(workspaceState.getCumulativeStats(req.params.project));
});

app.get("/api/claude-chat/briefing/:project", (req, res) => {
  const proj = getProject(req.params.project);
  const briefing = claudeChat.generateBriefing(req.params.project, proj ? proj.path : null);
  res.json({ briefing: briefing || "(No conversation history — nothing to hand off)" });
});

// Save Claude API key (global or per-workspace)
app.post("/api/claude-chat/apikey", (req, res) => {
  const { apiKey, workspace } = req.body;
  if (!apiKey) return res.status(400).json({ error: "apiKey required" });

  const { loadConfig, saveConfig } = require("./lib/projects");
  const cfg = loadConfig();

  if (workspace) {
    const proj = (cfg.projects || []).find((p) => p.name === workspace);
    if (!proj) return res.status(404).json({ error: `workspace "${workspace}" not found` });
    proj.claudeApiKey = apiKey;
  } else {
    cfg.claudeApiKey = apiKey;
  }

  saveConfig(cfg);
  config = cfg;
  claudeChat.checkAuth(config);
  res.json({ ok: true, scope: workspace || "global" });
});

app.delete("/api/claude-chat/apikey", (req, res) => {
  const { workspace } = req.body || {};
  const { loadConfig, saveConfig } = require("./lib/projects");
  const cfg = loadConfig();

  if (workspace) {
    const proj = (cfg.projects || []).find((p) => p.name === workspace);
    if (proj) delete proj.claudeApiKey;
  } else {
    delete cfg.claudeApiKey;
  }

  saveConfig(cfg);
  config = cfg;
  claudeChat.checkAuth(config);
  res.json({ ok: true });
});

app.get("/api/claude-chat/apikey/:workspace", (req, res) => {
  const proj = req.params.workspace ? (config.projects || []).find((p) => p.name === req.params.workspace) : null;
  const workspaceKey = proj && proj.claudeApiKey ? proj.claudeApiKey : null;
  const globalKey = config.claudeApiKey || null;
  const activeKey = workspaceKey || globalKey;
  res.json({
    hasKey: !!activeKey,
    scope: workspaceKey ? "workspace" : (globalKey ? "global" : null),
  });
});

// --- Start server ---

// Recover ttyd instances from before restart
ttyd.recoverInstances();

// Re-capture claude.ai URLs for running sessions that survived a server restart
sessionTracker.recoverUrls(() => {
  const projects = getProjects();
  const claudeSessions = tmux.getClaudeSessions();
  const running = [];
  for (const project of projects) {
    const tmuxName = tmux.sessionName(project.name);
    if (claudeSessions.some((s) => s.name === tmuxName)) {
      running.push({ workspace: project.name, tmuxName });
    }
  }
  return running;
});

// Cloud connector (optional — only activates if cloud is configured in config.json)
const connector = require("./konnect/client");
connector.init(app, config);

const server = http.createServer(app);

const SUPPORT_DIR = DATA_DIR;

function writePortFile(port) {
  try {
    fs.mkdirSync(SUPPORT_DIR, { recursive: true });
    fs.writeFileSync(path.join(SUPPORT_DIR, "port"), String(port));
  } catch {}
}

function clearPortFile() {
  try { fs.unlinkSync(path.join(SUPPORT_DIR, "port")); } catch {}
}

function writePidFile() {
  try {
    fs.mkdirSync(SUPPORT_DIR, { recursive: true });
    fs.writeFileSync(path.join(SUPPORT_DIR, "server.pid"), String(process.pid));
  } catch {}
}

function clearPidFile() {
  try { fs.unlinkSync(path.join(SUPPORT_DIR, "server.pid")); } catch {}
}

process.on("exit", () => { clearPortFile(); clearPidFile(); });

// --- Chat WebSocket ---

const wss = new WebSocket.Server({ server, path: "/ws/chat" });

let wsClientId = 0;
// Per-workspace flag: has the "processing" ack been sent for the current user turn?
const wsProcessingAcked = {};
// Per-workspace response-timeout timer handle (prevents stacking if messages arrive quickly)
const wsResponseTimers = {};
function broadcastToWorkspace(workspace, payload, excludeClientId) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && client._clientId !== excludeClientId) {
      client.send(data);
    }
  }
}
function broadcastAll(payload) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}

// Ping all connected WebSocket clients every 30s to keep connections alive
const WS_PING_INTERVAL = 30000;
setInterval(() => {
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      if (client._alive === false) {
        // Didn't respond to last ping — terminate
        console.log(`[chat-ws] client #${client._clientId} unresponsive, terminating`);
        client.terminate();
        continue;
      }
      client._alive = false;
      client.ping();
    }
  }
}, WS_PING_INTERVAL);

wss.on("connection", (ws) => {
  const clientId = ++wsClientId;
  ws._clientId = clientId;
  ws._alive = true;
  console.log(`[chat-ws] client #${clientId} connected`);

  ws.on("pong", () => { ws._alive = true; });

  // Track which workspaces this client has active sends — cleared on disconnect
  const pendingWorkspaces = new Set();

  ws.on("close", (code, reason) => {
    console.log(`[chat-ws] client #${clientId} disconnected code=${code} reason=${reason || ""}`);
    // Clear streaming flags for any workspaces this client was handling
    for (const w of pendingWorkspaces) workspaceState.setStreaming(w, false);
    pendingWorkspaces.clear();
  });

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.log(`[chat-ws] client #${clientId} invalid JSON`);
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    const { type, workspace, message, model, cli, images: rawImages, permissionMode, systemPrompt, thinking, sessionNum: clientSessionNum } = msg;
    const backend = cli === "claude" ? "claude" : "gemini";
    const backendModule = backend === "claude" ? claudeChat : gemini;

    // Parse dataUrls → { mediaType, data } — only for claude-local (gemini CLI doesn't support images yet)
    const images = (rawImages && rawImages.length && backend === "claude")
      ? rawImages.map((dataUrl) => {
          const m = typeof dataUrl === "string" && dataUrl.match(/^data:([^;]+);base64,(.+)$/);
          return m ? { mediaType: m[1], data: m[2] } : null;
        }).filter(Boolean)
      : [];

    console.log(`[chat-ws] client #${clientId} msg type=${type} workspace=${workspace || ""} model=${model || "auto"} cli=${backend} msgLen=${message ? message.length : 0} images=${images.length}`);

    if (type === "send") {
      if (!workspace || !message) {
        ws.send(JSON.stringify({ type: "error", workspace, message: "workspace and message required" }));
        return;
      }

      let proj = getProject(workspace);
      if (!proj) {
        console.log(`[chat-ws] project not found: ${workspace}`);
        ws.send(JSON.stringify({ type: "error", workspace, message: `project "${workspace}" not found` }));
        return;
      }

      // Message received by server — single grey check
      ws.send(JSON.stringify({ type: "ack", workspace, status: "received" }));

      // For Claude with an active relay, append to the existing session instead of spawning a new one
      if (backend === "claude" && claudeChat.isActive(workspace)) {
        const relaySessionNum = clientSessionNum || claudeChat.getActiveSessionNum(workspace);
        const delivered = claudeChat.sendMessage(workspace, message, clientSessionNum);
        if (delivered) {
          workspaceState.touchChatActivity(workspace);
          workspaceState.setStreaming(workspace, true);
          claudeChat.pushHistory(workspace, "user", message, { sender: msg.sender || "user" }, relaySessionNum);
          broadcastToWorkspace(workspace, { type: "user_message", workspace, content: message, sender: msg.sender || "user", ts: Date.now() }, clientId);
          broadcastToWorkspace(workspace, { type: "streaming_start", workspace }, clientId);
          wsProcessingAcked[workspace] = false;
          broadcastToWorkspace(workspace, { type: "ack", workspace, status: "delivered" });

          // Schrodinger timeout: if Claude doesn't produce any event within 30s,
          // it's functionally dead. Kill the relay and spawn a fresh session with
          // the same message so the user doesn't have to resend.
          // Cancel any existing timer to prevent stacking if messages arrive quickly.
          if (wsResponseTimers[workspace]) clearTimeout(wsResponseTimers[workspace]);
          wsResponseTimers[workspace] = setTimeout(async () => {
            delete wsResponseTimers[workspace];
            if (!wsProcessingAcked[workspace] && workspaceState.isStreaming(workspace)) {
              console.log(`[chat-ws] response timeout (30s) workspace=${workspace} — killing stuck relay and restarting`);
              claudeChat.stopProcess(workspace);
              workspaceState.setStreaming(workspace, false);
              broadcastToWorkspace(workspace, { type: "status", workspace, message: "Session unresponsive — restarting..." });
              try {
                const apiKeyField = "claudeApiKey";
                const apiKey = proj[apiKeyField] || config[apiKeyField] || undefined;
                const handle = await claudeChat.startChat(workspace, proj.path, message, config, { apiKey, model, permissionMode });
                workspaceState.setStreaming(workspace, true);
                broadcastToWorkspace(workspace, { type: "ack", workspace, status: "delivered" });
                wireRelayEvents(workspace, handle, claudeChat.currentSessionNum(workspace));
              } catch (err) {
                console.error(`[chat-ws] restart after timeout failed workspace=${workspace}: ${err.message}`);
                broadcastToWorkspace(workspace, { type: "error", workspace, message: "Failed to restart: " + err.message });
                broadcastToWorkspace(workspace, { type: "done", workspace, exitCode: null, stopped: true });
              }
            }
          }, 30000);

          return;
        }
        // Relay is dead — clean up and fall through to startChat to auto-restart
        console.log(`[chat-ws] relay dead for workspace=${workspace}, auto-restarting new session`);
        claudeChat.stopProcess(workspace);
        workspaceState.setStreaming(workspace, false);
      }

      try {
        // Stamp chat activity for sort ordering (all modes)
        workspaceState.touchChatActivity(workspace);

        // Use the client's explicit session number; fall back to currentSessionNum only for first-ever chat
        const chatSessionNum = clientSessionNum || backendModule.currentSessionNum(workspace);

        // Reject if this specific session is already streaming (allows concurrent sessions)
        if (workspaceState.isStreaming(workspace, chatSessionNum)) {
          ws.send(JSON.stringify({ type: "error", workspace, message: "A response is already in progress for this session" }));
          return;
        }

        // Mark session as actively streaming
        workspaceState.setStreaming(workspace, true, chatSessionNum);
        pendingWorkspaces.add(workspace);

        // Persist user message
        backendModule.pushHistory(workspace, "user", message, { sender: msg.sender || "user" }, chatSessionNum);

        // Notify other windows about the user message and streaming start
        broadcastToWorkspace(workspace, { type: "user_message", workspace, sessionNum: chatSessionNum, content: message, sender: msg.sender || "user", ts: Date.now() }, clientId);
        broadcastToWorkspace(workspace, { type: "streaming_start", workspace, sessionNum: chatSessionNum }, clientId);

        // Resolve API key: per-workspace > global
        const apiKeyField = backend === "claude" ? "claudeApiKey" : "geminiApiKey";
        const globalKeyField = backend === "claude" ? "claudeApiKey" : "geminiApiKey";
        const apiKey = proj[apiKeyField] || config[globalKeyField] || undefined;
        console.log(`[chat-ws] spawning ${backend} for workspace=${workspace} path=${proj.path} hasApiKey=${!!apiKey}`);
        // Gemini uses A2A: bypassPermissions = YOLO (auto-approve all tools), else interactive approval
        const autoExecute = backend === "gemini" ? (permissionMode === "bypassPermissions") : undefined;
        // If systemPrompt is provided (agent chat), prepend it to the message sent to Claude
        // but NOT to the history (which already stored the raw user message above).
        const effectiveMessage = systemPrompt
          ? `<system-context>\n${systemPrompt}\n</system-context>\n\n${message}`
          : message;
        const handle = await backendModule.startChat(workspace, proj.path, effectiveMessage, config, { apiKey, model, images, permissionMode, autoExecute, thinking, sessionNum: chatSessionNum });

        // Delivery ack — CLI process spawned and message written to stdin
        broadcastToWorkspace(workspace, { type: "ack", workspace, status: "delivered" });

        // Accumulate assistant text and tool events for history persistence
        let assistantText = "";
        let eventsSent = 0;
        const toolEvents = []; // buffered tool_use/tool_result for batch save
        // Reset "processing" ack for this workspace (new user turn)
        wsProcessingAcked[workspace] = false;

        handle.onEvent((event) => {
          eventsSent++;
          // First substantive event from agent = "processing" ack (double green checks)
          if (!wsProcessingAcked[workspace] && (event.type === "message" || event.type === "tool_use")) {
            wsProcessingAcked[workspace] = true;
            if (wsResponseTimers[workspace]) {
              clearTimeout(wsResponseTimers[workspace]);
              delete wsResponseTimers[workspace];
            }
            broadcastToWorkspace(workspace, { type: "ack", workspace, status: "processing" });
          }
          if (event.type === "permission_request") {
            workspaceState.setPendingPermission(workspace, event, chatSessionNum);
          }
          // Don't broadcast raw result events — we handle them below with
          // a curated version (stats only) + "done" sentinel.
          if (event.type !== "result") {
            broadcastToWorkspace(workspace, { ...event, workspace, sessionNum: chatSessionNum });
          }
          // Accumulate assistant message content
          if (event.type === "message" && (event.role === "assistant" || !event.role)) {
            assistantText += event.content || "";
          } else if (event.type === "tool_use") {
            toolEvents.push({
              role: "tool_use",
              content: JSON.stringify({
                tool_name: event.tool_name,
                tool_id: event.tool_id,
                parameters: event.parameters || {},
              }),
            });
          } else if (event.type === "tool_result") {
            const out = event.output || "";
            toolEvents.push({
              role: "tool_result",
              content: JSON.stringify({
                tool_id: event.tool_id,
                status: event.status || "success",
                output: out.length > 3000 ? out.slice(0, 3000) + "\n...(truncated)" : out,
              }),
            });
            // Incremental flush — persist assistant text + tool events so far
            // so history survives refresh/crash mid-turn
            const midBatch = [...toolEvents];
            if (assistantText) midBatch.push({ role: "assistant", content: assistantText });
            if (midBatch.length > 0) backendModule.pushHistoryBatch(workspace, midBatch, chatSessionNum);
            assistantText = "";
            toolEvents.length = 0;
          } else if (event.type === "usage") {
            // Per-turn usage from assistant message — update context tracking
            if (event.stats) {
              workspaceState.addTurnStats(workspace, event.stats);
              const cumulative = workspaceState.getCumulativeStats(workspace);
              broadcastToWorkspace(workspace, { type: "usage", workspace, stats: event.stats, cumulative });
            }
          } else if (event.type === "result") {
            // Turn completed — persist history, reset streaming, reset accumulators for next turn
            const isSyntheticFlush = !event.stats || Object.keys(event.stats).length === 0;
            console.log(`[chat-ws] turn done workspace=${workspace} cli=${backend} session#${chatSessionNum} eventsSent=${eventsSent} assistantLen=${assistantText.length} toolEvents=${toolEvents.length} synthetic=${isSyntheticFlush}`);
            const batch = [...toolEvents];
            if (assistantText) batch.push({ role: "assistant", content: assistantText });
            if (batch.length > 0) backendModule.pushHistoryBatch(workspace, batch, chatSessionNum);
            assistantText = "";
            toolEvents.length = 0;
            eventsSent = 0;
            workspaceState.setPendingPermission(workspace, null, chatSessionNum);
            // Synthetic results (empty stats) come from normalizeEvent between tool-call
            // turns — persist history but don't broadcast "done" or clear streaming.
            if (!isSyntheticFlush) {
              // Forward result event with stats so client can show cost/token footer
              if (event.stats && Object.keys(event.stats).length > 0) {
                workspaceState.addTurnStats(workspace, event.stats);
                const cumulative = workspaceState.getCumulativeStats(workspace);
                broadcastToWorkspace(workspace, { type: "result", workspace, sessionNum: chatSessionNum, stats: event.stats, cumulative, subtype: event.subtype, errors: event.errors });
              }
              workspaceState.setStreaming(workspace, false, chatSessionNum);
              workspaceState.touchChatActivity(workspace);

              // --- Auto-handoff: check if context is running low ---
              const cumStats = workspaceState.getCumulativeStats(workspace);
              const usedPct = cumStats.context_used_pct || 0;
              if (usedPct >= 75 && backend === "claude") {
                console.log(`[server] AUTO-HANDOFF triggered workspace=${workspace} usedPct=${usedPct}%`);
                // Record handover in history so it's visible on refresh
                backendModule.pushHistoryBatch(workspace, [{ role: "system", content: `Context handover triggered (${usedPct}% used)` }], chatSessionNum);
                broadcastToWorkspace(workspace, { type: "context_reload", workspace, reason: "auto", usedPct });
                const proj = getProject(workspace);
                if (proj) {
                  workspaceState.resetCumulativeStats(workspace);
                  claudeChat.performHandoff(workspace, proj.path, config, { permissionMode: "bypassPermissions" })
                    .then((result) => {
                      if (result) {
                        console.log(`[server] handoff complete workspace=${workspace} session#${result.sessionNum} (same chat)`);
                        wireRelayEvents(workspace, result.handle, result.sessionNum);
                        broadcastToWorkspace(workspace, { type: "handoff_complete", workspace });
                      } else {
                        console.log(`[server] handoff returned null workspace=${workspace}`);
                        broadcastToWorkspace(workspace, { type: "done", workspace, exitCode: 0 });
                      }
                    })
                    .catch((err) => {
                      console.error(`[server] handoff failed workspace=${workspace}: ${err.message}`);
                      broadcastToWorkspace(workspace, { type: "done", workspace, exitCode: 0 });
                    });
                } else {
                  broadcastToWorkspace(workspace, { type: "done", workspace, exitCode: 0 });
                }
              } else {
                if (usedPct >= 60) {
                  broadcastToWorkspace(workspace, { type: "context_warning", workspace, sessionNum: chatSessionNum, usedPct, remaining: 100 - usedPct });
                }
                broadcastToWorkspace(workspace, { type: "done", workspace, sessionNum: chatSessionNum, exitCode: 0 });
              }
            }
          }
        });

        handle.onDone(({ code, stderr }) => {
          console.log(`[chat-ws] relay exited workspace=${workspace} cli=${backend} session#${chatSessionNum} code=${code}`);
          // Relay died — flush any incomplete turn and clean up
          workspaceState.setStreaming(workspace, false, chatSessionNum);
          workspaceState.setPendingPermission(workspace, null, chatSessionNum);
          pendingWorkspaces.delete(workspace);
          workspaceState.touchChatActivity(workspace);
          const batch = [...toolEvents];
          if (assistantText) batch.push({ role: "assistant", content: assistantText });
          if (batch.length > 0) backendModule.pushHistoryBatch(workspace, batch, chatSessionNum);
          broadcastToWorkspace(workspace, {
            type: "done",
            workspace,
            sessionNum: chatSessionNum,
            exitCode: code,
            stderr: stderr || undefined,
          });
        });

        handle.onError((err) => {
          console.error(`[chat-ws] error workspace=${workspace} session#${chatSessionNum}: ${err.message}`);
          workspaceState.setStreaming(workspace, false, chatSessionNum);
          pendingWorkspaces.delete(workspace);
          // Auth errors (e.g. A2A server couldn't find credentials) → exitCode 41
          // so the frontend shows the login panel instead of a generic error message.
          if (err.isAuthError) {
            broadcastToWorkspace(workspace, { type: "done", workspace, exitCode: 41 });
          // Auto-reconnect if the relay daemon survived
          } else if (backend === "claude" && claudeChat.isRelayAlive(workspace, chatSessionNum)) {
            console.log(`[chat-ws] relay daemon still alive — auto-reconnecting workspace=${workspace}`);
            broadcastToWorkspace(workspace, { type: "status", workspace, message: "Reconnecting..." });
            try {
              const newHandle = claudeChat.connectRelay(workspace, { sessionNum: chatSessionNum });
              wireRelayEvents(workspace, newHandle, chatSessionNum);
              console.log(`[chat-ws] relay auto-reconnected workspace=${workspace}`);
            } catch (reconnErr) {
              console.error(`[chat-ws] relay auto-reconnect failed: ${reconnErr.message}`);
              broadcastToWorkspace(workspace, { type: "error", workspace, message: err.message });
            }
          } else {
            broadcastToWorkspace(workspace, { type: "error", workspace, message: err.message });
          }
        });
      } catch (err) {
        console.error(`[chat-ws] catch workspace=${workspace} session#${chatSessionNum}: ${err.message}`);
        workspaceState.setStreaming(workspace, false, chatSessionNum);
        pendingWorkspaces.delete(workspace);
        if (err.isAuthError) {
          ws.send(JSON.stringify({ type: "done", workspace, sessionNum: chatSessionNum, exitCode: 41 }));
        } else {
          ws.send(JSON.stringify({ type: "error", workspace, sessionNum: chatSessionNum, message: err.message }));
        }
      }
    } else if (type === "stop") {
      const stopSession = msg.sessionNum !== undefined ? Number(msg.sessionNum) : undefined;
      console.log(`[chat-ws] stop workspace=${workspace} cli=${backend} session=${stopSession ?? "all"}`);
      if (workspace) {
        backendModule.stopProcess(workspace, stopSession);
        // Clear streaming for the stopped session (or all if no session specified)
        if (backend === "claude") {
          const remaining = claudeChat.getActiveRelayInfo(workspace);
          if (remaining.length === 0) {
            workspaceState.setStreaming(workspace, false);
            pendingWorkspaces.delete(workspace);
          }
        } else {
          // Gemini: clear per-session streaming
          workspaceState.setStreaming(workspace, false, stopSession);
          if (!workspaceState.isStreaming(workspace)) pendingWorkspaces.delete(workspace);
        }
        // Broadcast done to all clients viewing this workspace
        broadcastToWorkspace(workspace, { type: "done", workspace, exitCode: null, stopped: true, sessionNum: stopSession });
      }
    } else if (type === "command") {
      // Execute a slash command on the Gemini A2A server
      const { command: cmdName, args: cmdArgs, sessionNum: cmdSession } = msg;
      console.log(`[chat-ws] command workspace=${workspace} command=${cmdName} session=${cmdSession}`);
      if (!workspace || !cmdName) {
        ws.send(JSON.stringify({ type: "command_error", workspace, command: cmdName, message: "workspace and command required" }));
      } else if (backend !== "gemini") {
        ws.send(JSON.stringify({ type: "command_error", workspace, command: cmdName, message: "Slash commands are only available for Gemini" }));
      } else {
        const geminiA2A = require("./lib/gemini-a2a");
        geminiA2A.executeCommand(workspace, cmdSession, cmdName, cmdArgs || [])
          .then((result) => {
            ws.send(JSON.stringify({ type: "command_result", workspace, command: cmdName, data: result.data ?? result, sessionNum: cmdSession }));
          })
          .catch((err) => {
            ws.send(JSON.stringify({ type: "command_error", workspace, command: cmdName, message: err.message, sessionNum: cmdSession }));
          });
      }
    } else if (type === "draft") {
      // Relay draft text to other windows and persist to disk
      if (workspace) {
        const { text, draftMode, draftSession } = msg;
        broadcastToWorkspace(workspace, { type: "draft", workspace, text: text || "", draftMode, draftSession }, clientId);
        workspaceState.setState(workspace, { draft: text || "", draftMode, draftSession });
      }
    } else if (type === "permission_response") {
      // User approved or denied a permission request — send control response back to Claude stdin.
      // Only the FIRST response for a given request_id is forwarded; duplicates from other
      // WS clients are silently dropped. This prevents race conditions when multiple tabs
      // are open and one sends a stale/auto response.
      const { request_id, behavior, updatedInput } = msg;
      if (workspace && request_id && behavior) {
        const pending = workspaceState.getPendingPermission(workspace);
        if (!pending || pending.request_id !== request_id) {
          console.log(`[chat-ws] permission_response IGNORED (already resolved) workspace=${workspace} request_id=${request_id}`);
        } else if (
          behavior === "allow" &&
          /ask.*question/i.test(pending.tool_name) &&
          (!updatedInput || !updatedInput.answers || !Object.keys(updatedInput.answers).length)
        ) {
          // AskUserQuestion requires answers in updatedInput.answers. Reject empty
          // responses — these come from stale clients that auto-approve without the
          // AskUserQuestion special-casing.
          console.log(`[chat-ws] permission_response REJECTED (AskUserQuestion with no answers) workspace=${workspace} request_id=${request_id} client=#${clientId}`);
        } else {
          console.log(`[chat-ws] permission_response workspace=${workspace} request_id=${request_id} behavior=${behavior} client=#${clientId}`);
          workspaceState.setPendingPermission(workspace, null);
          claudeChat.sendControlResponse(workspace, request_id, behavior, updatedInput, clientSessionNum);
          // Notify all other clients that this permission was resolved so they can
          // disable their approval UI (e.g. another tab had the same prompt open).
          broadcastToWorkspace(workspace, {
            type: "permission_resolved",
            workspace,
            request_id,
            behavior,
            tool_name: pending.tool_name,
            updatedInput: behavior === "allow" ? updatedInput : undefined,
          }, clientId);
        }
      }
    } else if (type === "tool_result_response") {
      // User answered a question tool (AskUserQuestion/ask_followup_question)
      const { tool_id, content } = msg;
      if (workspace && tool_id) {
        console.log(`[chat-ws] tool_result_response workspace=${workspace} tool_id=${tool_id}`);
        claudeChat.sendToolResult(workspace, tool_id, content, clientSessionNum);
      }
    } else if (type === "set_model") {
      // Runtime model switch — send control_request to Claude relay
      const { model: newModel } = msg;
      if (workspace && newModel) {
        console.log(`[chat-ws] set_model workspace=${workspace} model=${newModel}`);
        claudeChat.sendControlRequest(workspace, "set_model", { model: newModel }, clientSessionNum);
      }
    } else if (type === "set_permission_mode") {
      // Runtime permission mode switch
      const { mode: newMode } = msg;
      if (workspace && newMode) {
        console.log(`[chat-ws] set_permission_mode workspace=${workspace} mode=${newMode}`);
        claudeChat.sendControlRequest(workspace, "set_permission_mode", { permissionMode: newMode }, clientSessionNum);
      }
    } else if (type === "interrupt") {
      // Soft interrupt — tell Claude to stop current turn gracefully
      if (workspace) {
        console.log(`[chat-ws] interrupt workspace=${workspace}`);
        claudeChat.sendControlRequest(workspace, "interrupt", {}, clientSessionNum);
      }
    }
  });
});

// --- Crash recovery: replay orphaned Claude stream logs from last run ---

claudeChat.recoverStreams();

// --- Wire up event routing for a Claude relay handle ---

function wireRelayEvents(workspace, handle, sessionNum) {
  const chatSessionNum = sessionNum || claudeChat.currentSessionNum(workspace);
  workspaceState.setStreaming(workspace, false);

  let assistantText = "";
  const toolEvents = [];

  handle.onEvent((event) => {
    // Seed accumulators with content from replay (turn was in-progress when server restarted)
    if (event.type === "_replay_seed") {
      assistantText = event._assistantText || "";
      if (assistantText) workspaceState.setStreaming(workspace, true);
      console.log(`[server] replay-seed workspace=${workspace} assistantLen=${assistantText.length}`);
      return; // don't broadcast internal event
    }
    // Store pending permission requests so late-connecting clients get them
    if (event.type === "permission_request") {
      workspaceState.setPendingPermission(workspace, event);
    }
    // Don't broadcast raw result/usage events — handled below with curated stats
    if (event.type !== "result" && event.type !== "usage") {
      if (event.type === "tool_use" || event.type === "tool_result" || event.type === "message") {
        console.log(`[server] reconnect-broadcast workspace=${workspace} type=${event.type}${event.role ? " role=" + event.role : ""}${event.tool_name ? " tool=" + event.tool_name : ""}`);
      }
      broadcastToWorkspace(workspace, { ...event, workspace });
    }
    if (event.type === "message" && (event.role === "assistant" || !event.role)) {
      workspaceState.setStreaming(workspace, true);
      wsProcessingAcked[workspace] = true; // relay is alive and responding
      assistantText += event.content || "";
    } else if (event.type === "tool_use") {
      workspaceState.setStreaming(workspace, true);
      wsProcessingAcked[workspace] = true; // relay is alive and responding
      toolEvents.push({ role: "tool_use", content: JSON.stringify({ tool_name: event.tool_name, tool_id: event.tool_id, parameters: event.parameters || {} }) });
    } else if (event.type === "tool_result") {
      const out = event.output || "";
      toolEvents.push({ role: "tool_result", content: JSON.stringify({ tool_id: event.tool_id, status: event.status || "success", output: out.length > 3000 ? out.slice(0, 3000) + "\n...(truncated)" : out }) });
      // Incremental flush after every tool_result
      const midBatch = [...toolEvents];
      if (assistantText) midBatch.push({ role: "assistant", content: assistantText });
      if (midBatch.length > 0) claudeChat.pushHistoryBatch(workspace, midBatch, chatSessionNum);
      assistantText = "";
      toolEvents.length = 0;
    } else if (event.type === "usage") {
      if (event.stats) {
        workspaceState.addTurnStats(workspace, event.stats);
        const cumulative = workspaceState.getCumulativeStats(workspace);
        broadcastToWorkspace(workspace, { type: "usage", workspace, stats: event.stats, cumulative });
      }
    } else if (event.type === "result") {
      const isSyntheticFlush = !event.stats || Object.keys(event.stats).length === 0;
      console.log(`[server] reconnect-handler result workspace=${workspace} session#${chatSessionNum} synthetic=${isSyntheticFlush} statsKeys=${Object.keys(event.stats || {}).join(",")} assistantLen=${assistantText.length} toolEvents=${toolEvents.length}`);
      const batch = [...toolEvents];
      if (assistantText) batch.push({ role: "assistant", content: assistantText });
      if (batch.length > 0) claudeChat.pushHistoryBatch(workspace, batch, chatSessionNum);
      assistantText = "";
      toolEvents.length = 0;
      workspaceState.setPendingPermission(workspace, null); // turn complete, clear any pending prompt
      if (!isSyntheticFlush) {
        if (event.stats && Object.keys(event.stats).length > 0) {
          workspaceState.addTurnStats(workspace, event.stats);
          const cumulative = workspaceState.getCumulativeStats(workspace);
          broadcastToWorkspace(workspace, { type: "result", workspace, stats: event.stats, cumulative, subtype: event.subtype, errors: event.errors });
        }
        workspaceState.setStreaming(workspace, false);
        workspaceState.touchChatActivity(workspace);

        // --- Auto-handoff: check if context is running low ---
        // Two tiers:
        //   60-74%: warn the user (visual indicator, no interruption)
        //   75%+:   auto-handoff to a fresh session before Claude hits compaction (~80-85%)
        const cumStats = workspaceState.getCumulativeStats(workspace);
        const usedPct = cumStats.context_used_pct || 0;
        if (usedPct >= 75) {
          console.log(`[server] AUTO-HANDOFF triggered workspace=${workspace} usedPct=${usedPct}%`);
          // Record handover in history so it's visible on refresh
          claudeChat.pushHistoryBatch(workspace, [{ role: "system", content: `Context handover triggered (${usedPct}% used)` }], chatSessionNum);
          broadcastToWorkspace(workspace, { type: "context_reload", workspace, reason: "auto", usedPct });
          const proj = getProject(workspace);
          if (proj) {
            workspaceState.resetCumulativeStats(workspace);
            claudeChat.performHandoff(workspace, proj.path, config, { permissionMode: "bypassPermissions" })
              .then((result) => {
                if (result) {
                  console.log(`[server] handoff complete workspace=${workspace} session#${result.sessionNum} (same chat)`);
                  wireRelayEvents(workspace, result.handle, result.sessionNum);
                  broadcastToWorkspace(workspace, { type: "handoff_complete", workspace });
                } else {
                  console.log(`[server] handoff returned null workspace=${workspace}`);
                  broadcastToWorkspace(workspace, { type: "done", workspace, exitCode: 0 });
                }
              })
              .catch((err) => {
                console.error(`[server] handoff failed workspace=${workspace}: ${err.message}`);
                broadcastToWorkspace(workspace, { type: "done", workspace, exitCode: 0 });
              });
          } else {
            broadcastToWorkspace(workspace, { type: "done", workspace, exitCode: 0 });
          }
        } else {
          // Emit a context_warning at 60%+ so the UI can show a visual indicator
          if (usedPct >= 60) {
            broadcastToWorkspace(workspace, { type: "context_warning", workspace, usedPct, remaining: 100 - usedPct });
          }
          broadcastToWorkspace(workspace, { type: "done", workspace, exitCode: 0 });
        }
      }
    }
  });

  handle.onDone(({ code, stderr }) => {
    console.log(`[server] relay exited workspace=${workspace} code=${code}`);
    workspaceState.setStreaming(workspace, false);
    workspaceState.setPendingPermission(workspace, null);
    workspaceState.touchChatActivity(workspace);
    const batch = [...toolEvents];
    if (assistantText) batch.push({ role: "assistant", content: assistantText });
    if (batch.length > 0) claudeChat.pushHistoryBatch(workspace, batch, chatSessionNum);
    broadcastToWorkspace(workspace, { type: "done", workspace, exitCode: code, stderr: stderr || undefined });
  });

  handle.onError((err) => {
    console.error(`[server] relay error workspace=${workspace}: ${err.message}`);
    workspaceState.setStreaming(workspace, false);

    // Auto-reconnect if the relay daemon is still alive (e.g. heartbeat timeout
    // killed our socket but the daemon process is fine).
    if (claudeChat.isRelayAlive(workspace, sessionNum)) {
      console.log(`[server] relay daemon still alive — auto-reconnecting workspace=${workspace}`);
      broadcastToWorkspace(workspace, { type: "status", workspace, message: "Reconnecting..." });
      try {
        const newHandle = claudeChat.connectRelay(workspace, { sessionNum });
        wireRelayEvents(workspace, newHandle, sessionNum);
        console.log(`[server] relay auto-reconnected workspace=${workspace}`);
      } catch (reconnErr) {
        console.error(`[server] relay auto-reconnect failed workspace=${workspace}: ${reconnErr.message}`);
        broadcastToWorkspace(workspace, { type: "error", workspace, message: err.message });
      }
    } else {
      broadcastToWorkspace(workspace, { type: "error", workspace, message: err.message });
    }
  });
}

// --- Reconnect to any Claude relay daemons that survived a server restart ---

claudeChat.reconnectActiveRelays(config, (workspace, handle, sessionNum) => {
  console.log(`[server] reconnected to relay workspace=${workspace} session#${sessionNum}`);
  // Don't assume streaming=true — relay may be idle between turns
  workspaceState.setStreaming(workspace, false);
  wireRelayEvents(workspace, handle, sessionNum);
});

// --- Graceful shutdown: flush partial streams before exit ---

function gracefulShutdown(signal) {
  console.log(`[server] ${signal} received, shutting down...`);
  scheduler.stop();
  memory.close();
  gemini.stopAllProcesses();
  // Do NOT kill Claude relay daemons — they are detached and designed to survive server
  // restarts so reconnectActiveRelays() can pick them up on the next boot.
  // Killing them here would destroy in-progress turns with no recovery path.
  // Small delay for close handlers to persist history and delete log files
  setTimeout(() => {
    // Recover any Claude turns that didn't flush in time
    claudeChat.recoverStreams();
    process.exit(0);
  }, 200);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

const PORT = Number(process.env.PORT || config.port || 9876);
server.listen(PORT, "0.0.0.0", () => {
  writePidFile();
  writePortFile(PORT);
  console.log(`Klaudii manager running at http://0.0.0.0:${PORT}`);
  console.log(`  tmux: ${tmux.isTmuxInstalled() ? "installed" : "NOT FOUND — run: brew install tmux"}`);
  console.log(`  ttyd: ${ttyd.isTtydInstalled() ? "installed" : "NOT FOUND — run: brew install ttyd"}`);
  console.log(`  gemini: ${gemini.isInstalled(config) ? "installed" : "not found"}`);
  console.log(`  claude-chat: ${claudeChat.isInstalled(config) ? "installed" : "not found"}`);
  const recovered = ttyd.getRunning();
  if (recovered.length) {
    console.log(`  recovered ${recovered.length} ttyd instance(s): ${recovered.map(r => `${r.project}:${r.port}`).join(", ")}`);
  }

  // Ensure all workspace folders are trusted by Gemini CLI
  gemini.ensureFolderTrust(config.reposDir);

  // Start periodic gemini auth probe (immediate + every 5 min)
  gemini.startAuthCheck(config);

  // Start periodic gemini model list refresh (immediate + every hour)
  gemini.startModelRefresh(config);

  // Start periodic gemini quota refresh (immediate + every 5 min, OAuth users only)
  gemini.startQuotaRefresh();

  // Start periodic claude-chat auth probe (immediate + every 5 min)
  claudeChat.startAuthCheck(config);

  // scheduler.start();
});

server.on('error', (err) => {
  console.error('[fatal] HTTP server error:', err);
  process.exit(1);
});
