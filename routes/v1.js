// v1 API Router — the contract the iOS App Store binary depends on.
//
// This router is mounted at /api in server.js. The paths here are relative
// (e.g., /health not /api/health) because Express strips the mount prefix.
//
// Dependencies are injected so this router can be tested with mocks.
// When a v2 is needed, create routes/v2.js and mount at /v2/api.

const express = require("express");
const path = require("path");
const fs = require("fs");

module.exports = function createV1Router(deps) {
  const {
    tmux,
    ttyd,
    claude,
    git,
    github,
    processes,
    sessionTracker,
    projects, // { getProjects, getProject, addProject, removeProject, setPermissionMode }
    config,
    gemini,         // optional — Gemini CLI chat backend
    claudeChat,     // optional — Claude CLI chat backend
    workspaceState, // optional — per-workspace chat mode/session/draft persistence
    memory,         // optional — persistent memory for architect/shepherd
  } = deps;

  const completion = require("../lib/completion");

  const router = express.Router();

  // Version header on every response
  router.use((_req, res, next) => {
    res.set("X-Klaudii-API-Version", "1");
    next();
  });

  // --- Health check ---

  router.get("/health", (_req, res) => {
    const { execSync } = require("child_process");

    let ghAuth = null;
    try {
      const ghOut = execSync("gh auth status 2>&1", {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const acctMatch = ghOut.match(/Logged in to .* account (\S+)/);
      ghAuth = { loggedIn: true, account: acctMatch ? acctMatch[1] : "unknown" };
    } catch {
      ghAuth = { loggedIn: false };
    }

    let claudeAuth = null;
    const claudeBin = (() => {
      try {
        return execSync("which claude 2>/dev/null", { encoding: "utf-8" }).trim();
      } catch {}
      const home = require("os").homedir();
      const candidates = [
        path.join(home, ".local", "bin", "claude"),
        "/usr/local/bin/claude",
        "/opt/homebrew/bin/claude",
      ];
      return candidates.find((p) => fs.existsSync(p)) || null;
    })();
    if (claudeBin) {
      try {
        const claudeOut = execSync(`${JSON.stringify(claudeBin)} auth status 2>&1`, {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        claudeAuth = JSON.parse(claudeOut);
      } catch {
        claudeAuth = { loggedIn: false };
      }
    }

    res.json({
      ok: true,
      tmux: tmux.isTmuxInstalled(),
      ttyd: ttyd.isTtydInstalled(),
      ghAuth,
      claudeAuth,
      geminiAuth: gemini ? gemini.getAuthStatus() : undefined,
      claudeChatAuth: claudeChat ? claudeChat.getAuthStatus() : undefined,
    });
  });

  router.get("/debug", (_req, res) => {
    const { execSync } = require("child_process");
    let raw = "";
    try {
      raw = execSync(`tmux -S '${tmux.TMUX_SOCKET}' list-sessions 2>&1`, { encoding: "utf-8" });
    } catch (e) {
      raw = e.message;
    }
    res.json({
      socket: tmux.TMUX_SOCKET,
      homedir: require("os").homedir(),
      sessions: tmux.listSessions(),
      claudeSessions: tmux.getClaudeSessions(),
      rawTmux: raw,
    });
  });

  // --- Projects ---

  router.get("/projects", (_req, res) => {
    res.json(projects.getProjects());
  });

  router.post("/projects", (req, res) => {
    const { name, path: projectPath } = req.body;
    if (!name || !projectPath) {
      return res.status(400).json({ error: "name and path required" });
    }
    try {
      const result = projects.addProject(name, projectPath);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // --- Processes ---

  router.get("/processes", (_req, res) => {
    const managedPids = tmux.getManagedPids();
    const allProcs = processes.findClaudeProcesses(managedPids);
    res.json(allProcs);
  });

  router.post("/processes/kill", (req, res) => {
    const { pid } = req.body;
    if (!pid) {
      return res.status(400).json({ error: "pid required" });
    }
    const ok = processes.killProcess(pid);
    res.json({ ok });
  });

  // --- Permission-aware Claude args builder ---

  function buildClaudeArgs(permissionMode, opts = {}) {
    const parts = [];
    if (opts.resumeSessionId) parts.push("--resume", opts.resumeSessionId);
    else if (opts.continueSession) parts.push("--continue");
    parts.push("remote-control");
    if (permissionMode === "yolo") {
      parts.push("--permission-mode", "bypassPermissions");
    } else if (permissionMode === "strict") {
      parts.push("--permission-mode", "plan");
    }
    return parts.join(" ");
  }

  // --- Sessions ---

  router.get("/sessions", (_req, res) => {
    const allProjects = projects.getProjects();
    const claudeSessions = tmux.getClaudeSessions();
    const ttydInstances = ttyd.getRunning();

    const sessions = allProjects.map((project) => {
      const tmuxName = tmux.sessionName(project.name);
      const tmuxSession = claudeSessions.find((s) => s.name === tmuxName);
      const ttydInstance = ttydInstances.find((t) => t.project === project.name);

      const gitStatus = git.getStatus(project.path);
      const remoteUrl = git.getRemoteUrl(project.path);

      const tracked = sessionTracker.getSessions(project.name);
      const lastActivity = Math.max(
        claude.getProjectLastActivity(project.path) || 0,
        tracked.length ? tracked[0].startedAt : 0,
        workspaceState ? workspaceState.getLastChatActivity(project.name) : 0,
        gemini ? gemini.getLastMessageTime(project.name) : 0,
        claudeChat ? claudeChat.getLastMessageTime(project.name) : 0,
      );

      let status = "stopped";
      if (tmuxSession) {
        status = tmux.isClaudeAlive(tmuxName) ? "running" : "exited";
      }

      // Chat mode + streaming state
      const wsState = workspaceState ? workspaceState.getWorkspace(project.name) : {};
      const chatMode = wsState.mode || "claude-local";
      const chatActive = workspaceState ? workspaceState.isStreaming(project.name) : false;

      const result = {
        project: project.name,
        projectPath: project.path,
        permissionMode: project.permissionMode || "yolo",
        running: status === "running",
        status,
        claudeUrl: tmuxSession ? sessionTracker.getClaudeUrl(project.name) : null,
        tmux: tmuxSession || null,
        ttyd: ttydInstance || null,
        git: gitStatus,
        remoteUrl,
        sessionCount: tracked.length,
        lastActivity,
        chatMode,
        chatActive,
        relayActive: claudeChat ? claudeChat.isActive(project.name) : false,
        workspaceType: workspaceState ? workspaceState.getWorkspaceType(project.name) : "user",
      };
      // Relay details: array of active relays for this workspace (one per session)
      result.activeRelays = claudeChat ? claudeChat.getActiveRelayInfo(project.name) : [];
      result.relays = result.activeRelays.map((r, i) => ({ id: `relay-${i}`, ...r }));
      if (wsState.taskId) result.taskId = wsState.taskId;
      return result;
    });

    res.json(sessions);
  });

  // --- Workspace chat state (mode / session / draft) ---

  router.get("/workspace-state/:workspace", (req, res) => {
    if (!workspaceState) return res.json({ mode: "claude-local", sessionNum: null, draft: "" });
    const workspace = decodeURIComponent(req.params.workspace);
    const state = workspaceState.getWorkspace(workspace);
    const pending = workspaceState.getPendingPermission(workspace);
    res.json({ ...state, streaming: workspaceState.isStreaming(workspace), ...(pending ? { pendingPermission: pending } : {}) });
  });

  router.patch("/workspace-state/:workspace", (req, res) => {
    if (!workspaceState) return res.status(501).json({ error: "workspace-state not available" });
    const workspace = decodeURIComponent(req.params.workspace);
    const { mode, sessionNum, draft, draftMode, draftSession } = req.body;
    workspaceState.setState(workspace, { mode, sessionNum, draft, draftMode, draftSession });
    res.json(workspaceState.getWorkspace(workspace));
  });

  router.get("/history", (req, res) => {
    const { project } = req.query;
    if (!project) {
      return res.status(400).json({ error: "project query param required" });
    }

    const proj = projects.getProject(project);
    if (!proj) {
      return res.status(404).json({ error: `project "${project}" not found` });
    }

    const trackedIds = sessionTracker.getSessionIds(project);
    const trackedSessions = claude.getSessionsByIds(trackedIds);
    const pathSessions = claude.getRecentSessions(proj.path);

    const seen = new Set(trackedSessions.map((s) => s.sessionId));
    for (const s of pathSessions) {
      if (!seen.has(s.sessionId)) {
        trackedSessions.push(s);
        seen.add(s.sessionId);
      }
    }

    trackedSessions.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    res.json(trackedSessions.slice(0, 20));
  });

  router.post("/sessions/start", async (req, res) => {
    const { project, resumeSessionId, continueSession } = req.body;
    if (!project) {
      return res.status(400).json({ error: "project required" });
    }

    const proj = projects.getProject(project);
    if (!proj) {
      return res.status(404).json({ error: `project "${project}" not found` });
    }

    const tmuxName = tmux.sessionName(project);

    if (tmux.sessionExists(tmuxName)) {
      return res.status(409).json({ error: "Session already running" });
    }

    // Clean worktree before starting session (only for worktree paths, not main repos)
    const dotGitPath = path.join(proj.path, ".git");
    if (fs.existsSync(dotGitPath) && fs.statSync(dotGitPath).isFile()) {
      try {
        git.cleanWorktree(proj.path);
      } catch (err) {
        console.error(`[sessions/start] Failed to clean worktree: ${err.message}`);
      }
    }

    const startTs = Date.now();

    try {
      const permissionMode = proj.permissionMode || "yolo";
      const claudeArgs = buildClaudeArgs(permissionMode, { resumeSessionId, continueSession });

      tmux.createSession(tmuxName, proj.path, claudeArgs);

      await new Promise((r) => setTimeout(r, 500));
      if (!tmux.sessionExists(tmuxName)) {
        return res.status(500).json({
          error: `Session "${tmuxName}" died immediately after creation. Check that claude can start in ${proj.path}`,
        });
      }

      const port = ttyd.allocatePort(config.ttydBasePort);
      try {
        ttyd.start(project, tmuxName, port);
      } catch (err) {
        console.error(`Failed to start ttyd for ${project}:`, err.message);
      }

      if (resumeSessionId) {
        sessionTracker.addSession(project, resumeSessionId, "resume");
      } else {
        sessionTracker.detectAndTrack(project, startTs)
          .catch((err) => console.error("[session-tracker] detectAndTrack:", err.message));
      }

      sessionTracker.captureClaudeUrl(project, tmuxName)
        .catch((err) => console.error("[session-tracker] captureClaudeUrl:", err.message));

      res.json({ ok: true, tmuxSession: tmuxName, ttydPort: port });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/sessions/stop", (req, res) => {
    const { project } = req.body;
    if (!project) {
      return res.status(400).json({ error: "project required" });
    }

    const tmuxName = tmux.sessionName(project);

    try {
      ttyd.stop(project);
    } catch {
      // ttyd may not be running
    }

    sessionTracker.clearClaudeUrl(project);

    try {
      tmux.killSession(tmuxName);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/projects/remove", (req, res) => {
    const { project, force } = req.body;
    if (!project) {
      return res.status(400).json({ error: "project required" });
    }

    const proj = projects.getProject(project);
    if (!proj) {
      return res.status(404).json({ error: `project "${project}" not found` });
    }

    const tmuxName = tmux.sessionName(project);
    if (tmux.sessionExists(tmuxName)) {
      return res.status(409).json({ error: "Stop the workspace before removing it" });
    }

    const status = git.getStatus(proj.path);
    if (status && (status.dirtyFiles || status.unpushed) && !force) {
      return res.status(409).json({
        error: "Workspace has uncommitted or unpushed changes",
        dirty: true,
        dirtyFiles: status.dirtyFiles,
        unpushed: status.unpushed,
      });
    }

    try {
      const dotGit = path.join(proj.path, ".git");
      const isWorktree = fs.existsSync(dotGit) && fs.statSync(dotGit).isFile();
      if (isWorktree && config.reposDir) {
        const repoName = project.split("--")[0];
        const mainRepoDir = path.join(config.reposDir, repoName);
        if (git.isGitRepo(mainRepoDir)) {
          git.removeWorktree(mainRepoDir, proj.path);
        }
      }

      sessionTracker.clearClaudeUrl(project);
      projects.removeProject(project);

      res.json({ ok: true, worktreeRemoved: isWorktree });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/projects/permission", (req, res) => {
    const { project, mode } = req.body;
    if (!project || !mode) {
      return res.status(400).json({ error: "project and mode required" });
    }
    try {
      projects.setPermissionMode(project, mode);
      res.json({ ok: true, mode });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post("/sessions/restart", async (req, res) => {
    const { project } = req.body;
    if (!project) {
      return res.status(400).json({ error: "project required" });
    }

    const proj = projects.getProject(project);
    if (!proj) {
      return res.status(404).json({ error: `project "${project}" not found` });
    }

    const tmuxName = tmux.sessionName(project);

    sessionTracker.clearClaudeUrl(project);
    try {
      ttyd.stop(project);
    } catch {}
    try {
      tmux.killSession(tmuxName);
    } catch {}

    await new Promise((r) => setTimeout(r, 1000));

    const startTs = Date.now();

    try {
      const permissionMode = proj.permissionMode || "yolo";
      const claudeArgs = buildClaudeArgs(permissionMode, { continueSession: true });
      tmux.createSession(tmuxName, proj.path, claudeArgs);

      const port = ttyd.allocatePort(config.ttydBasePort);
      try {
        ttyd.start(project, tmuxName, port);
      } catch (err) {
        console.error(`Failed to start ttyd for ${project}:`, err.message);
      }

      sessionTracker.detectAndTrack(project, startTs)
        .catch((err) => console.error("[session-tracker] detectAndTrack:", err.message));
      sessionTracker.captureClaudeUrl(project, tmuxName)
        .catch((err) => console.error("[session-tracker] captureClaudeUrl:", err.message));

      res.json({ ok: true, tmuxSession: tmuxName, ttydPort: port });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Token usage ---

  router.get("/usage", (req, res) => {
    const hours = Math.min(parseInt(req.query.hours) || 24, 168);
    const buckets = claude.getTokenUsage(hours);
    const rateLimits = claude.getRateLimitEvents(168);
    res.json({ buckets, rateLimits });
  });

  // --- GitHub & Repos ---

  router.get("/github/repos", (_req, res) => {
    try {
      const repos = github.listRepos();
      const reposDir = config.reposDir;

      const annotated = repos.map((r) => ({
        ...r,
        cloned: reposDir ? fs.existsSync(path.join(reposDir, r.name, ".git")) : false,
      }));

      res.json(annotated);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/repos", (_req, res) => {
    if (!config.reposDir) {
      return res.status(400).json({ error: "reposDir not configured" });
    }
    const repos = git.scanRepos(config.reposDir);
    res.json(repos);
  });

  router.get("/repos/:name/worktrees", (req, res) => {
    if (!config.reposDir) {
      return res.status(400).json({ error: "reposDir not configured" });
    }
    const repoDir = path.join(config.reposDir, req.params.name);
    if (!git.isGitRepo(repoDir)) {
      return res.status(404).json({ error: `repo "${req.params.name}" not found locally` });
    }
    const worktrees = git.listWorktrees(repoDir);
    res.json(worktrees);
  });

  // --- Create new repo ---

  router.post("/repos/create", (req, res) => {
    const { name, remoteUrl } = req.body;
    if (!name) {
      return res.status(400).json({ error: "name required" });
    }
    if (!config.reposDir) {
      return res.status(400).json({ error: "reposDir not configured" });
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
      return res.status(400).json({
        error: "Invalid repo name (letters, numbers, dots, hyphens, underscores only)",
      });
    }

    const repoDir = path.join(config.reposDir, name);
    if (fs.existsSync(repoDir)) {
      return res.status(409).json({ error: `Directory already exists: ${name}` });
    }

    try {
      git.initRepo(repoDir, remoteUrl || null);

      try {
        projects.addProject(name, repoDir);
      } catch {
        // Already registered is fine
      }

      res.json({ ok: true, name, path: repoDir });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- New session (clone + worktree + start) ---

  router.post("/sessions/new", (req, res) => {
    const { repo, owner, branch } = req.body;
    if (!repo) {
      return res.status(400).json({ error: "repo required" });
    }
    if (!config.reposDir) {
      return res.status(400).json({ error: "reposDir not configured" });
    }

    const repoDir = path.join(config.reposDir, repo);
    const branchName = branch || `claude-${Date.now()}`;
    const worktreeDir = path.join(config.reposDir, `${repo}--${branchName}`);
    const projectName = `${repo}--${branchName}`;

    try {
      if (!git.isGitRepo(repoDir)) {
        let sshUrl;
        try {
          const repos = github.listRepos();
          const ghRepo = owner
            ? repos.find((r) => r.name === repo && r.owner === owner)
            : repos.find((r) => r.name === repo);
          if (!ghRepo) {
            return res
              .status(404)
              .json({ error: `repo "${owner ? owner + "/" : ""}${repo}" not found on GitHub` });
          }
          sshUrl = ghRepo.sshUrl;
        } catch (err) {
          return res
            .status(500)
            .json({ error: `Failed to list GitHub repos: ${err.message}` });
        }

        git.cloneRepo(sshUrl, repoDir);
      }

      if (fs.existsSync(worktreeDir)) {
        return res
          .status(409)
          .json({ error: `Worktree directory already exists: ${worktreeDir}` });
      }

      git.addWorktree(repoDir, worktreeDir, branchName);

      // Verify clean state after worktree creation
      const wtStatus = git.getStatus(worktreeDir);
      if (wtStatus && wtStatus.dirtyFiles > 0) {
        console.warn(`[sessions/new] Worktree ${worktreeDir} has ${wtStatus.dirtyFiles} dirty files after creation`);
      }

      try {
        projects.addProject(projectName, worktreeDir);
      } catch {
        // Already registered is fine
      }

      const tmuxName = tmux.sessionName(projectName);
      if (tmux.sessionExists(tmuxName)) {
        return res.status(409).json({ error: `tmux session "${tmuxName}" already exists` });
      }

      const startTs = Date.now();
      const claudeArgs = buildClaudeArgs("yolo");
      tmux.createSession(tmuxName, worktreeDir, claudeArgs);

      const port = ttyd.allocatePort(config.ttydBasePort);
      try {
        ttyd.start(projectName, tmuxName, port);
      } catch (err) {
        console.error(`Failed to start ttyd for ${projectName}:`, err.message);
      }

      sessionTracker.detectAndTrack(projectName, startTs)
        .catch((err) => console.error("[session-tracker] detectAndTrack:", err.message));
      sessionTracker.captureClaudeUrl(projectName, tmuxName)
        .catch((err) => console.error("[session-tracker] captureClaudeUrl:", err.message));

      res.json({
        ok: true,
        project: projectName,
        worktree: worktreeDir,
        branch: branchName,
        tmuxSession: tmuxName,
        ttydPort: port,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Chat: send message to workspace (REST wrapper for WS send) ---

  router.post("/chat/:workspace/send", async (req, res) => {
    if (!claudeChat) return res.status(501).json({ error: "claude-chat not available" });

    const workspace = decodeURIComponent(req.params.workspace);
    const { message, sender } = req.body;

    if (!message) return res.status(400).json({ error: "message required" });

    const proj = projects.getProject(workspace);
    if (!proj) return res.status(404).json({ error: `workspace "${workspace}" not found` });

    const senderField = sender || "user";

    try {
      const chatSessions = claudeChat.getSessions(workspace);
      const currentSNum = chatSessions.current || 1;
      if (claudeChat.isSessionActive(workspace, currentSNum)) {
        claudeChat.pushHistory(workspace, "user", message, { sender: senderField });
        claudeChat.sendMessage(workspace, message);
      } else {
        claudeChat.pushHistory(workspace, "user", message, { sender: senderField });
        await claudeChat.startChat(workspace, proj.path, message, config);
      }
      res.json({ ok: true, workspace });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Chat: workspace status ---

  router.get("/chat/:workspace/status", (req, res) => {
    const workspace = decodeURIComponent(req.params.workspace);

    const proj = projects.getProject(workspace);
    if (!proj) return res.status(404).json({ error: `workspace "${workspace}" not found` });

    const wsState = workspaceState ? workspaceState.getWorkspace(workspace) : {};
    const pending = workspaceState ? workspaceState.getPendingPermission(workspace) : null;

    res.json({
      workspace,
      relayActive: claudeChat ? claudeChat.isActive(workspace) : false,
      activeRelays: claudeChat ? claudeChat.getActiveRelayInfo(workspace) : [],
      streaming: workspaceState ? workspaceState.isStreaming(workspace) : false,
      chatMode: wsState.mode || "claude-local",
      lastActivity: workspaceState ? workspaceState.getLastChatActivity(workspace) : 0,
      pendingPermission: pending || null,
    });
  });

  // --- Stop individual relay ---

  router.post("/chat/:workspace/stop", (req, res) => {
    if (!claudeChat) return res.status(501).json({ error: "claude-chat not available" });
    const workspace = decodeURIComponent(req.params.workspace);
    const { sessionNum } = req.body || {};
    claudeChat.stopProcess(workspace, sessionNum !== undefined ? Number(sessionNum) : undefined);
    if (workspaceState) {
      const remaining = claudeChat.getActiveRelayInfo(workspace);
      if (remaining.length === 0) workspaceState.setStreaming(workspace, false);
    }
    res.json({ ok: true, workspace, stoppedSession: sessionNum !== undefined ? Number(sessionNum) : "all" });
  });

  // --- User settings ---

  const SETTINGS_DIR = path.join(
    require("os").homedir(),
    "Library",
    "Application Support",
    "com.klaudii.server"
  );
  const SETTINGS_PATH = path.join(SETTINGS_DIR, "settings.json");

  const DEFAULT_SETTINGS = {
    workerVisibility: "hide",   // "hide" | "show" | "auto-clean"
    theme: "dark",              // "dark" | "light" | "auto"
  };

  function loadSettings() {
    try {
      const raw = fs.readFileSync(SETTINGS_PATH, "utf-8");
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings(settings) {
    if (!fs.existsSync(SETTINGS_DIR)) {
      fs.mkdirSync(SETTINGS_DIR, { recursive: true });
    }
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
  }

  router.get("/settings", (_req, res) => {
    res.json(loadSettings());
  });

  router.patch("/settings", (req, res) => {
    const current = loadSettings();
    const allowed = ["workerVisibility", "theme"];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        current[key] = req.body[key];
      }
    }
    saveSettings(current);
    res.json(current);
  });

  // --- Tasks CRUD ---
  // Task routes — backed by SQLite (replaced bd/Dolt)
  const tasks = require("../lib/tasks");

  router.get("/tasks", (_req, res) => {
    try {
      const list = tasks.list();
      res.json(list);
    } catch (err) {
      res.status(500).json({ error: `tasks list failed: ${err.message}` });
    }
  });

  router.get("/tasks/:id", (req, res) => {
    const id = req.params.id;
    try {
      const task = tasks.get(id);
      if (!task) return res.status(404).json({ error: "task not found" });
      res.json(task);
    } catch (err) {
      res.status(500).json({ error: `tasks get failed: ${err.message}` });
    }
  });

  // --- Task worker sessions ---

  router.get("/tasks/:id/sessions", (req, res) => {
    const id = req.params.id;
    if (!/^[a-zA-Z0-9-]+$/.test(id)) return res.status(400).json({ error: "invalid task ID" });

    // Collect sessions from claude-chat that are tagged with this task
    const chatSessions = claudeChat ? claudeChat.getSessionsForTask(id) : [];

    // Collect workspaces associated with this task
    const workspaces = workspaceState ? workspaceState.getWorkspacesForTask(id) : [];

    // Enrich with live status
    const allProjects = projects.getProjects();
    const claudeSessions = tmux.getClaudeSessions();

    const workerSessions = chatSessions.map(cs => {
      const proj = allProjects.find(p => p.name === cs.workspace);
      if (!proj) return { ...cs, status: "unknown" };

      const tmuxName = tmux.sessionName(cs.workspace);
      const tmuxSession = claudeSessions.find(s => s.name === tmuxName);
      let status = "stopped";
      if (tmuxSession) {
        status = tmux.isClaudeAlive(tmuxName) ? "running" : "exited";
      }
      return { ...cs, status, projectPath: proj.path };
    });

    // Include any workspaces associated but not yet in chat sessions
    for (const wsName of workspaces) {
      if (!chatSessions.some(cs => cs.workspace === wsName)) {
        const proj = allProjects.find(p => p.name === wsName);
        const tmuxName = tmux.sessionName(wsName);
        const tmuxSession = claudeSessions.find(s => s.name === tmuxName);
        let status = "stopped";
        if (tmuxSession) {
          status = tmux.isClaudeAlive(tmuxName) ? "running" : "exited";
        }
        workerSessions.push({
          workspace: wsName,
          sessionNum: null,
          cliSessionId: null,
          status,
          projectPath: proj ? proj.path : null,
        });
      }
    }

    res.json({ taskId: id, sessions: workerSessions });
  });

  router.post("/tasks", (req, res) => {
    const { title, description, priority, type, deps } = req.body;
    if (!title) return res.status(400).json({ error: "title required" });

    try {
      const task = tasks.create({ title, description, priority, type });
      res.status(201).json(task);
    } catch (err) {
      res.status(500).json({ error: `tasks create failed: ${err.message}` });
    }
  });

  router.patch("/tasks/:id", (req, res) => {
    const id = req.params.id;
    const { status, comment, assignee, priority } = req.body;

    try {
      if (status || assignee !== undefined || priority !== undefined) {
        const updates = {};
        if (status) updates.status = status;
        if (assignee !== undefined) updates.assignee = assignee;
        if (priority !== undefined) updates.priority = Number(priority);
        tasks.update(id, updates);
      }

      if (comment) {
        tasks.addComment(id, { author: "user", body: comment });
      }

      const task = tasks.get(id);
      if (!task) return res.status(404).json({ error: "task not found" });
      res.json(task);
    } catch (err) {
      res.status(500).json({ error: `tasks update failed: ${err.message}` });
    }
  });

  // --- Worker stats ---

  router.get("/workspace-stats/:workspace", (req, res) => {
    const workspace = decodeURIComponent(req.params.workspace);
    const proj = projects.getProject(workspace);
    if (!proj) return res.status(404).json({ error: "workspace not found" });

    // Git diff stats
    let filesChanged = 0, linesAdded = 0, linesRemoved = 0;
    try {
      const { execSync } = require("child_process");
      const stat = execSync("git diff --stat HEAD 2>/dev/null || git diff --stat 2>/dev/null || true", {
        cwd: proj.path, encoding: "utf-8", timeout: 5000,
      });
      const match = stat.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
      if (match) {
        filesChanged = parseInt(match[1]) || 0;
        linesAdded = parseInt(match[2]) || 0;
        linesRemoved = parseInt(match[3]) || 0;
      }
    } catch {}

    // Process stats
    const managedPids = tmux.getManagedPids();
    const procs = processes.findClaudeProcesses(managedPids);
    const proc = procs.find(p => p.managed && p.project === workspace);

    // Last activity
    const tracked = sessionTracker.getSessions(workspace);
    const lastActivity = Math.max(
      claude.getProjectLastActivity(proj.path) || 0,
      tracked.length ? tracked[0].startedAt : 0,
      workspaceState ? workspaceState.getLastChatActivity(workspace) : 0,
    );

    // Running time
    const tmuxName = tmux.sessionName(workspace);
    const isRunning = tmux.sessionExists(tmuxName) && tmux.isClaudeAlive(tmuxName);

    res.json({
      filesChanged,
      linesAdded,
      linesRemoved,
      cpu: proc ? proc.cpu : null,
      memMB: proc ? proc.memMB : null,
      uptime: proc ? proc.uptime : null,
      lastActivity,
      isRunning,
    });
  });

  // --- Worker activity (Claude native session messages) ---

  router.get("/worker-activity/:workspace", (req, res) => {
    const workspace = decodeURIComponent(req.params.workspace);
    const proj = projects.getProject(workspace);
    if (!proj) return res.status(404).json({ error: "workspace not found" });

    // Get tracked session IDs
    const trackedIds = sessionTracker.getSessionIds(workspace);
    if (!trackedIds.length) {
      // Try to find sessions from Claude's native storage
      const sessions = claude.getRecentSessions(proj.path, 5);
      if (sessions.length) {
        const messages = claude.getSessionMessages(proj.path, sessions[0].sessionId);
        return res.json({ sessionId: sessions[0].sessionId, messages });
      }
      return res.json({ sessionId: null, messages: [] });
    }

    // Use the most recent tracked session
    const sessionId = trackedIds[0];
    const messages = claude.getSessionMessages(proj.path, sessionId);
    res.json({ sessionId, messages });
  });

  // --- Task Completion Pipeline ---

  router.post("/tasks/:id/complete", async (req, res) => {
    const id = req.params.id;
    if (!/^[a-zA-Z0-9-]+$/.test(id)) return res.status(400).json({ error: "invalid task ID" });

    const { workspace } = req.body;
    if (!workspace) return res.status(400).json({ error: "workspace required" });

    const ctx = { claudeChat, tmux, projects, config, workspaceState };

    try {
      const result = await completion.runPipeline(id, workspace, ctx);
      const status = result.ok ? 200 : 422;
      res.status(status).json(result);
    } catch (err) {
      res.status(500).json({ error: `Completion pipeline failed: ${err.message}` });
    }
  });

  // --- Agent Memory ---

  router.get("/memory/:agent", (req, res) => {
    if (!memory) return res.status(501).json({ error: "memory not available" });
    const { agent } = req.params;
    if (agent !== "architect" && agent !== "shepherd") {
      return res.status(400).json({ error: "agent must be 'architect' or 'shepherd'" });
    }
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const workspace = req.query.workspace || undefined;
    res.json(memory.list(agent, { limit, workspace }));
  });

  router.post("/memory/:agent", (req, res) => {
    if (!memory) return res.status(501).json({ error: "memory not available" });
    const { agent } = req.params;
    if (agent !== "architect" && agent !== "shepherd") {
      return res.status(400).json({ error: "agent must be 'architect' or 'shepherd'" });
    }
    const { content, category, workspace, session_id } = req.body;
    if (!content) return res.status(400).json({ error: "content required" });
    try {
      const entry = memory.store(agent, { content, category, workspace, session_id });
      res.json(entry);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/memory/:agent/search", (req, res) => {
    if (!memory) return res.status(501).json({ error: "memory not available" });
    const { agent } = req.params;
    if (agent !== "architect" && agent !== "shepherd") {
      return res.status(400).json({ error: "agent must be 'architect' or 'shepherd'" });
    }
    const { q, limit } = req.query;
    if (!q) return res.status(400).json({ error: "q query param required" });
    res.json(memory.search(agent, q, { limit: limit ? Number(limit) : 50 }));
  });

  // --- Agent Chat (Architect / Shepherd dedicated chat) ---

  const klaudiiRoot = path.resolve(__dirname, "..");

  router.post("/agent-chat/:role/start", (req, res) => {
    const { role } = req.params;
    if (role !== "architect" && role !== "shepherd") {
      return res.status(400).json({ error: "role must be 'architect' or 'shepherd'" });
    }

    // Find or create a workspace for the agent chat
    const workspaceName = `__${role}__`;
    let proj = projects.getProject(workspaceName);
    if (!proj) {
      try {
        projects.addProject(workspaceName, klaudiiRoot);
      } catch {
        // Already exists is fine
      }
      proj = projects.getProject(workspaceName);
    }
    if (!proj) {
      return res.status(500).json({ error: "Could not create agent workspace" });
    }

    // Load context files
    let systemPrompt = "";
    try {
      if (role === "architect") {
        const startup = fs.readFileSync(path.join(klaudiiRoot, "ARCHITECT_STARTUP.md"), "utf-8");
        const planningDir = path.join(klaudiiRoot, "..", "klaudii-planning");
        const system = fs.readFileSync(path.join(planningDir, "architect-system.md"), "utf-8");
        systemPrompt = `${startup}\n\n---\n\n${system}`;
      } else {
        const prompt = fs.readFileSync(path.join(klaudiiRoot, "lib", "shepherd-prompt.md"), "utf-8");
        systemPrompt = prompt;
      }
    } catch (err) {
      return res.status(500).json({ error: `Failed to load context files: ${err.message}` });
    }

    // Load recent memories
    const memories = memory ? memory.list(role, { limit: 50 }) : [];
    if (memories.length > 0) {
      systemPrompt += "\n\n---\n\n## Your Recent Memories\n\n";
      systemPrompt += "The following are your memories from previous sessions (most recent first).\n";
      systemPrompt += "These are marked as [HISTORICAL MEMORY] so you know they are from past sessions, not the current one.\n\n";
      for (const m of memories) {
        const cat = m.category ? ` [${m.category}]` : "";
        systemPrompt += `- [HISTORICAL MEMORY] [${m.created_at}]${cat} ${m.content}\n`;
      }
    }

    // Add memory instructions
    systemPrompt += `\n\n## Memory Instructions\n\n`;
    systemPrompt += `You have access to your memory journal. Store important decisions and observations before ending this session.\n\n`;
    systemPrompt += `Memory API (use curl):\n`;
    systemPrompt += `- Store: curl -s -X POST http://localhost:9876/api/memory/${role} -H 'Content-Type: application/json' -d '{"content":"...","category":"decision|observation|context"}'  \n`;
    systemPrompt += `- List: curl -s http://localhost:9876/api/memory/${role}?limit=50\n`;
    systemPrompt += `- Search: curl -s "http://localhost:9876/api/memory/${role}/search?q=keyword"\n`;
    systemPrompt += `- Delete: curl -s -X DELETE http://localhost:9876/api/memory/${role}/<id>\n`;

    res.json({
      workspace: workspaceName,
      workspacePath: klaudiiRoot,
      systemPrompt,
      memoriesCount: memories.length,
    });
  });

  router.delete("/memory/:agent/:id", (req, res) => {
    if (!memory) return res.status(501).json({ error: "memory not available" });
    const { agent, id } = req.params;
    if (agent !== "architect" && agent !== "shepherd") {
      return res.status(400).json({ error: "agent must be 'architect' or 'shepherd'" });
    }
    try {
      const deleted = memory.remove(agent, Number(id));
      if (!deleted) return res.status(404).json({ error: "memory not found" });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
