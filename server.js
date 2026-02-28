const express = require("express");
const path = require("path");
const { loadConfig, getProjects, addProject, getProject } = require("./lib/projects");
const tmux = require("./lib/tmux");
const ttyd = require("./lib/ttyd");
const claude = require("./lib/claude");
const github = require("./lib/github");
const git = require("./lib/git");
const fs = require("fs");
const processes = require("./lib/processes");
const sessionTracker = require("./lib/session-tracker");

const config = loadConfig();
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- Health check ---

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    tmux: tmux.isTmuxInstalled(),
    ttyd: ttyd.isTtydInstalled(),
  });
});

app.get("/api/debug", (_req, res) => {
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

app.get("/api/projects", (_req, res) => {
  res.json(getProjects());
});

app.post("/api/projects", (req, res) => {
  const { name, path: projectPath } = req.body;
  if (!name || !projectPath) {
    return res.status(400).json({ error: "name and path required" });
  }
  try {
    const projects = addProject(name, projectPath);
    res.json(projects);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Processes (all Claude instances on this machine) ---

app.get("/api/processes", (_req, res) => {
  // Get PIDs directly from tmux panes — these are the managed shell processes
  const managedPids = tmux.getManagedPids();
  const allProcs = processes.findClaudeProcesses(managedPids);
  res.json(allProcs);
});

app.post("/api/processes/kill", (req, res) => {
  const { pid } = req.body;
  if (!pid) {
    return res.status(400).json({ error: "pid required" });
  }
  const ok = processes.killProcess(pid);
  res.json({ ok });
});

// --- Sessions ---

app.get("/api/sessions", (_req, res) => {
  const projects = getProjects();
  const claudeSessions = tmux.getClaudeSessions();
  const ttydInstances = ttyd.getRunning();

  const sessions = projects.map((project) => {
    const tmuxName = tmux.sessionName(project.name);
    const tmuxSession = claudeSessions.find((s) => s.name === tmuxName);
    const ttydInstance = ttydInstances.find((t) => t.project === project.name);

    const gitStatus = git.getStatus(project.path);

    const tracked = sessionTracker.getSessions(project.name);

    return {
      project: project.name,
      projectPath: project.path,
      running: !!tmuxSession,
      claudeUrl: tmuxSession ? sessionTracker.getClaudeUrl(project.name) : null,
      tmux: tmuxSession || null,
      ttyd: ttydInstance || null,
      git: gitStatus,
      sessionCount: tracked.length,
    };
  });

  res.json(sessions);
});

app.get("/api/history", (req, res) => {
  const { project } = req.query;
  if (!project) {
    return res.status(400).json({ error: "project query param required" });
  }

  const proj = getProject(project);
  if (!proj) {
    return res.status(404).json({ error: `project "${project}" not found` });
  }

  // Primary: use our tracked session IDs (correct workspace mapping)
  const trackedIds = sessionTracker.getSessionIds(project);
  const trackedSessions = claude.getSessionsByIds(trackedIds);

  // Fallback: also include path-based sessions (for pre-tracking history)
  const pathSessions = claude.getRecentSessions(proj.path);

  // Merge and dedup by sessionId, tracked takes priority
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

app.post("/api/sessions/start", async (req, res) => {
  const { project, resumeSessionId, continueSession } = req.body;
  if (!project) {
    return res.status(400).json({ error: "project required" });
  }

  const proj = getProject(project);
  if (!proj) {
    return res.status(404).json({ error: `project "${project}" not found` });
  }

  const tmuxName = tmux.sessionName(project);

  if (tmux.sessionExists(tmuxName)) {
    return res.status(409).json({ error: "Session already running" });
  }

  const startTs = Date.now();

  try {
    let claudeArgs = "";
    if (resumeSessionId) {
      claudeArgs = `--resume ${resumeSessionId} remote-control`;
    } else if (continueSession) {
      claudeArgs = "--continue remote-control";
    }

    tmux.createSession(tmuxName, proj.path, claudeArgs);

    // Wait briefly, then verify the session survived (shell might exit if claude fails)
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

    // Track session ID: known for resume, detect in background for fresh/continue
    if (resumeSessionId) {
      sessionTracker.addSession(project, resumeSessionId, "resume");
    } else {
      sessionTracker.detectAndTrack(project, startTs);
    }

    // Capture the claude.ai URL in background (stable for process lifetime)
    sessionTracker.captureClaudeUrl(project, tmuxName);

    res.json({ ok: true, tmuxSession: tmuxName, ttydPort: port });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/sessions/stop", (req, res) => {
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

app.post("/api/sessions/restart", async (req, res) => {
  const { project } = req.body;
  if (!project) {
    return res.status(400).json({ error: "project required" });
  }

  const proj = getProject(project);
  if (!proj) {
    return res.status(404).json({ error: `project "${project}" not found` });
  }

  const tmuxName = tmux.sessionName(project);

  // Stop existing
  sessionTracker.clearClaudeUrl(project);
  try {
    ttyd.stop(project);
  } catch {}
  try {
    tmux.killSession(tmuxName);
  } catch {}

  // Wait for old processes to die before starting new ones
  await new Promise((r) => setTimeout(r, 1000));

  const startTs = Date.now();

  try {
    tmux.createSession(tmuxName, proj.path, "--continue remote-control");

    const port = ttyd.allocatePort(config.ttydBasePort);
    try {
      ttyd.start(project, tmuxName, port);
    } catch (err) {
      console.error(`Failed to start ttyd for ${project}:`, err.message);
    }

    // Detect the (continued) session ID and capture URL in background
    sessionTracker.detectAndTrack(project, startTs);
    sessionTracker.captureClaudeUrl(project, tmuxName);

    res.json({ ok: true, tmuxSession: tmuxName, ttydPort: port });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GitHub & Repos ---

app.get("/api/github/repos", (_req, res) => {
  try {
    const repos = github.listRepos();
    const reposDir = config.reposDir;

    // Annotate with local clone status
    const annotated = repos.map((r) => ({
      ...r,
      cloned: reposDir ? fs.existsSync(path.join(reposDir, r.name, ".git")) : false,
    }));

    res.json(annotated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/repos", (_req, res) => {
  if (!config.reposDir) {
    return res.status(400).json({ error: "reposDir not configured" });
  }
  const repos = git.scanRepos(config.reposDir);
  res.json(repos);
});

app.get("/api/repos/:name/worktrees", (req, res) => {
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

// --- New session (clone + worktree + start) ---

app.post("/api/sessions/new", (req, res) => {
  const { repo, branch } = req.body;
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
    // Clone if not present
    if (!git.isGitRepo(repoDir)) {
      // Look up SSH URL from GitHub
      let sshUrl;
      try {
        const repos = github.listRepos();
        const ghRepo = repos.find((r) => r.name === repo);
        if (!ghRepo) {
          return res.status(404).json({ error: `repo "${repo}" not found on GitHub` });
        }
        sshUrl = ghRepo.sshUrl;
      } catch (err) {
        return res.status(500).json({ error: `Failed to list GitHub repos: ${err.message}` });
      }

      git.cloneRepo(sshUrl, repoDir);
    }

    // Create worktree
    if (fs.existsSync(worktreeDir)) {
      return res.status(409).json({ error: `Worktree directory already exists: ${worktreeDir}` });
    }

    git.addWorktree(repoDir, worktreeDir, branchName);

    // Register as project
    try {
      addProject(projectName, worktreeDir);
    } catch {
      // Already registered is fine
    }

    // Start tmux + ttyd
    const tmuxName = tmux.sessionName(projectName);
    if (tmux.sessionExists(tmuxName)) {
      return res.status(409).json({ error: `tmux session "${tmuxName}" already exists` });
    }

    const startTs = Date.now();
    tmux.createSession(tmuxName, worktreeDir, "");

    const port = ttyd.allocatePort(config.ttydBasePort);
    try {
      ttyd.start(projectName, tmuxName, port);
    } catch (err) {
      console.error(`Failed to start ttyd for ${projectName}:`, err.message);
    }

    // Detect the new session ID and capture URL in background
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

const PORT = config.port || 9876;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Klaudii manager running at http://0.0.0.0:${PORT}`);
  console.log(`  tmux: ${tmux.isTmuxInstalled() ? "installed" : "NOT FOUND — run: brew install tmux"}`);
  console.log(`  ttyd: ${ttyd.isTtydInstalled() ? "installed" : "NOT FOUND — run: brew install ttyd"}`);
  const recovered = ttyd.getRunning();
  if (recovered.length) {
    console.log(`  recovered ${recovered.length} ttyd instance(s): ${recovered.map(r => `${r.project}:${r.port}`).join(", ")}`);
  }
});
