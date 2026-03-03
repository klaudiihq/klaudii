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
  } = deps;

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
    if (permissionMode === "yolo") {
      parts.push("--dangerously-skip-permissions");
    } else if (permissionMode === "strict") {
      parts.push("--dangerously-skip-permissions");
      parts.push("--allowedTools", "Read,Glob,Grep,WebSearch,WebFetch");
    }
    if (opts.resumeSessionId) parts.push("--resume", opts.resumeSessionId);
    else if (opts.continueSession) parts.push("--continue");
    parts.push("remote-control");
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
      );

      let status = "stopped";
      if (tmuxSession) {
        status = tmux.isClaudeAlive(tmuxName) ? "running" : "exited";
      }

      // Chat mode + streaming state
      const wsState = workspaceState ? workspaceState.getWorkspace(project.name) : {};
      const chatMode = wsState.mode || "claude-local";
      const chatActive =
        (chatMode === "gemini" && gemini && gemini.isActive(project.name)) ||
        (chatMode === "claude-local" && claudeChat && claudeChat.isActive(project.name)) ||
        false;

      return {
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
      };
    });

    res.json(sessions);
  });

  // --- Workspace chat state (mode / session / draft) ---

  router.get("/workspace-state/:workspace", (req, res) => {
    if (!workspaceState) return res.json({ mode: "claude-local", sessionNum: null, draft: "" });
    const state = workspaceState.getWorkspace(decodeURIComponent(req.params.workspace));
    res.json(state);
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
        sessionTracker.detectAndTrack(project, startTs);
      }

      sessionTracker.captureClaudeUrl(project, tmuxName);

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

      sessionTracker.detectAndTrack(project, startTs);
      sessionTracker.captureClaudeUrl(project, tmuxName);

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

      sessionTracker.detectAndTrack(projectName, startTs);
      sessionTracker.captureClaudeUrl(projectName, tmuxName);

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

  return router;
};
