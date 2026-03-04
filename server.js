const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");
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
const setup = require("./lib/setup");

process.on('uncaughtException', (err) => {
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

// --- Setup / limp-mode routes (registered before static middleware) ---
setup.start();

app.get("/", (_req, res, next) => {
  if (setup.limpMode) return res.sendFile(path.join(__dirname, "public", "setup.html"));
  next();
});
app.get("/api/setup/status",   (_req, res) => res.json(setup.getStatus()));
app.get("/api/setup/stream",   (req, res)  => setup.addSseClient(req, res));
app.post("/api/setup/install", (_req, res) => {
  setup.installMissing().catch(() => {});
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, "public")));

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
  })
);

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
    config.geminiBin = binPath;
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

// Chat history (server-side, synced across devices)
app.get("/api/gemini/history/:project", (req, res) => {
  const sessionNum = req.query.session ? Number(req.query.session) : undefined;
  res.json(gemini.getHistory(req.params.project, sessionNum));
});

app.post("/api/gemini/history/:project", (req, res) => {
  const { role, content } = req.body;
  if (!role || !content) return res.status(400).json({ error: "role and content required" });
  gemini.pushHistory(req.params.project, role, content);
  res.json({ ok: true });
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
  // Run bare `gemini` which will print an OAuth URL if not authenticated
  const shellCmd = `source ~/.zshrc 2>/dev/null; ${geminiBin}`;
  const tmuxCmd = `${TMUX} new-session -d -s '${tmuxName}' /bin/zsh -c '${shellCmd.replace(/'/g, "'\\''")}'`;

  try {
    execSync(tmuxCmd, { stdio: "pipe", env: { ...process.env } });
  } catch (err) {
    return res.status(500).json({ error: `Failed to create auth session: ${err.message}` });
  }

  // Poll tmux pane output to find the OAuth URL (up to 15s)
  const urlRe = /https:\/\/accounts\.google\.com[^\s]+|https:\/\/[^\s]*google[^\s]*\/auth[^\s]*/;
  let authUrl = null;

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const paneText = tmux.capturePane(tmuxName);
    if (!paneText) continue;
    const match = paneText.match(urlRe);
    if (match) {
      authUrl = match[0];
      break;
    }
    // Session may have already exited (e.g. already authenticated)
    if (!tmux.sessionExists(tmuxName)) break;
  }

  if (authUrl) {
    // Open the URL directly in the user's default browser
    try { execSync(`open ${JSON.stringify(authUrl)}`, { stdio: "pipe" }); } catch {}
    res.json({ ok: true, url: authUrl, message: "Browser opened for authentication" });
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
  res.json({ ok: true, session });
});

// Switch to a specific session number
app.post("/api/claude-chat/sessions/:project/switch", (req, res) => {
  const { project } = req.params;
  const { session } = req.body;
  if (!session) return res.status(400).json({ error: "session number required" });
  const ok = claudeChat.setCurrentSession(project, Number(session));
  if (!ok) return res.status(404).json({ error: `session ${session} not found` });
  res.json({ ok: true, current: Number(session) });
});

app.get("/api/claude-chat/history/:project", (req, res) => {
  const sessionNum = req.query.session ? Number(req.query.session) : undefined;
  res.json(claudeChat.getHistory(req.params.project, sessionNum));
});

app.post("/api/claude-chat/history/:project", (req, res) => {
  const { role, content } = req.body;
  if (!role || !content) return res.status(400).json({ error: "role and content required" });
  claudeChat.pushHistory(req.params.project, role, content);
  res.json({ ok: true });
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

// --- Port hunting ---
const net = require("net");
const os  = require("os");

function tryPort(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(port, "0.0.0.0", () => probe.close(() => resolve(port)));
  });
}

async function findPort(preferred = 9876, max = 9950) {
  for (let p = preferred; p <= max; p++) {
    try { return await tryPort(p); } catch {}
  }
  throw new Error("No available port found in range 9876–9950");
}

function writePortFile(port) {
  const dir = path.join(os.homedir(), "Library", "Application Support", "com.klaudii.server");
  try {
    require("fs").mkdirSync(dir, { recursive: true });
    require("fs").writeFileSync(path.join(dir, "port"), String(port));
  } catch {}
}

function clearPortFile() {
  const f = path.join(os.homedir(), "Library", "Application Support", "com.klaudii.server", "port");
  try { require("fs").unlinkSync(f); } catch {}
}

process.on("exit",    clearPortFile);
process.on("SIGINT",  () => { clearPortFile(); process.exit(); });
process.on("SIGTERM", () => { clearPortFile(); process.exit(); });

// --- Gemini WebSocket ---

const wss = new WebSocket.Server({ server, path: "/ws/gemini" });

let wsClientId = 0;
function broadcastToWorkspace(workspace, payload, excludeClientId) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && client._clientId !== excludeClientId) {
      client.send(data);
    }
  }
}

wss.on("connection", (ws) => {
  const clientId = ++wsClientId;
  ws._clientId = clientId;
  console.log(`[gemini-ws] client #${clientId} connected`);

  // Track which workspaces this client has active sends — cleared on disconnect
  const pendingWorkspaces = new Set();

  ws.on("close", (code, reason) => {
    console.log(`[gemini-ws] client #${clientId} disconnected code=${code} reason=${reason || ""}`);
    // Clear streaming flags for any workspaces this client was handling
    for (const w of pendingWorkspaces) workspaceState.setStreaming(w, false);
    pendingWorkspaces.clear();
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.log(`[gemini-ws] client #${clientId} invalid JSON`);
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    const { type, workspace, message, model, cli, images: rawImages, permissionMode } = msg;
    const backend = cli === "claude" ? "claude" : "gemini";
    const backendModule = backend === "claude" ? claudeChat : gemini;

    // Parse dataUrls → { mediaType, data } — only for claude-local (gemini CLI doesn't support images yet)
    const images = (rawImages && rawImages.length && backend === "claude")
      ? rawImages.map((dataUrl) => {
          const m = typeof dataUrl === "string" && dataUrl.match(/^data:([^;]+);base64,(.+)$/);
          return m ? { mediaType: m[1], data: m[2] } : null;
        }).filter(Boolean)
      : [];

    console.log(`[gemini-ws] client #${clientId} msg type=${type} workspace=${workspace || ""} model=${model || "auto"} cli=${backend} msgLen=${message ? message.length : 0} images=${images.length}`);

    if (type === "send") {
      if (!workspace || !message) {
        ws.send(JSON.stringify({ type: "error", workspace, message: "workspace and message required" }));
        return;
      }

      const proj = getProject(workspace);
      if (!proj) {
        console.log(`[gemini-ws] project not found: ${workspace}`);
        ws.send(JSON.stringify({ type: "error", workspace, message: `project "${workspace}" not found` }));
        return;
      }

      // Reject if another client is already streaming for this workspace
      if (workspaceState.isStreaming(workspace)) {
        ws.send(JSON.stringify({ type: "error", workspace, message: "A response is already in progress" }));
        return;
      }

      try {
        // Stamp chat activity for sort ordering (all modes)
        workspaceState.touchChatActivity(workspace);
        // Mark workspace as actively streaming
        workspaceState.setStreaming(workspace, true);
        pendingWorkspaces.add(workspace);

        // Persist user message
        backendModule.pushHistory(workspace, "user", message);

        // Notify other windows about the user message and streaming start
        broadcastToWorkspace(workspace, { type: "user_message", workspace, content: message, ts: Date.now() }, clientId);
        broadcastToWorkspace(workspace, { type: "streaming_start", workspace }, clientId);

        // Resolve API key: per-workspace > global
        const apiKeyField = backend === "claude" ? "claudeApiKey" : "geminiApiKey";
        const globalKeyField = backend === "claude" ? "claudeApiKey" : "geminiApiKey";
        const apiKey = proj[apiKeyField] || config[globalKeyField] || undefined;
        console.log(`[gemini-ws] spawning ${backend} for workspace=${workspace} path=${proj.path} hasApiKey=${!!apiKey}`);
        const handle = backendModule.sendMessage(workspace, proj.path, message, config, { apiKey, model, images, permissionMode });

        // Accumulate assistant text and tool events for history persistence
        let assistantText = "";
        let eventsSent = 0;
        const toolEvents = []; // buffered tool_use/tool_result for batch save

        handle.onEvent((event) => {
          eventsSent++;
          broadcastToWorkspace(workspace, { ...event, workspace });
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
          }
        });

        handle.onDone(({ code, stderr }) => {
          console.log(`[gemini-ws] done workspace=${workspace} cli=${backend} code=${code} eventsSent=${eventsSent} assistantLen=${assistantText.length} toolEvents=${toolEvents.length}`);
          // Clear streaming flag — response is complete
          workspaceState.setStreaming(workspace, false);
          pendingWorkspaces.delete(workspace);
          // Stamp activity on completion so sorting reflects response time
          workspaceState.touchChatActivity(workspace);
          // Persist turn: tool events (in order) + assistant reply in one batch write
          const batch = [...toolEvents];
          if (assistantText) batch.push({ role: "assistant", content: assistantText });
          if (batch.length > 0) {
            backendModule.pushHistoryBatch(workspace, batch);
          }
          broadcastToWorkspace(workspace, {
            type: "done",
            workspace,
            exitCode: code,
            stderr: stderr || undefined,
          });
        });

        handle.onError((err) => {
          console.error(`[gemini-ws] error workspace=${workspace}: ${err.message}`);
          // Clear streaming flag on error
          workspaceState.setStreaming(workspace, false);
          pendingWorkspaces.delete(workspace);
          broadcastToWorkspace(workspace, {
            type: "error",
            workspace,
            message: err.message,
          });
        });
      } catch (err) {
        console.error(`[gemini-ws] catch workspace=${workspace}: ${err.message}`);
        workspaceState.setStreaming(workspace, false);
        pendingWorkspaces.delete(workspace);
        ws.send(JSON.stringify({ type: "error", workspace, message: err.message }));
      }
    } else if (type === "stop") {
      console.log(`[gemini-ws] stop workspace=${workspace} cli=${backend}`);
      if (workspace) {
        backendModule.stopProcess(workspace);
        workspaceState.setStreaming(workspace, false);
        pendingWorkspaces.delete(workspace);
        // Broadcast done to all clients viewing this workspace
        broadcastToWorkspace(workspace, { type: "done", workspace, exitCode: null, stopped: true });
      }
    } else if (type === "draft") {
      // Relay draft text to other windows and persist to disk
      if (workspace) {
        const { text, draftMode, draftSession } = msg;
        broadcastToWorkspace(workspace, { type: "draft", workspace, text: text || "", draftMode, draftSession }, clientId);
        workspaceState.setState(workspace, { draft: text || "", draftMode, draftSession });
      }
    } else if (type === "input") {
      // User responded to a permission/approval request — pipe back to the Claude process stdin
      if (workspace && msg.text != null) {
        console.log(`[gemini-ws] input workspace=${workspace} text=${JSON.stringify(msg.text)}`);
        claudeChat.sendInput(workspace, msg.text);
      }
    }
  });
});

// --- Crash recovery: replay orphaned stream logs from last run ---

gemini.recoverStreams();
claudeChat.recoverStreams();

// --- Graceful shutdown: flush partial streams before exit ---

function gracefulShutdown(signal) {
  console.log(`[server] ${signal} received, shutting down...`);
  gemini.stopAllProcesses();
  claudeChat.stopAllProcesses();
  // Small delay for close handlers to persist history and delete log files
  setTimeout(() => {
    // Recover anything that didn't flush in time
    gemini.recoverStreams();
    claudeChat.recoverStreams();
    process.exit(0);
  }, 200);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

const preferredPort = Number(process.env.PORT || config.port || 9876);
findPort(preferredPort).then((PORT) => {
  server.listen(PORT, "0.0.0.0", () => {
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
  });
}).catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});

server.on('error', (err) => {
  console.error('[fatal] HTTP server error:', err);
  process.exit(1);
});
