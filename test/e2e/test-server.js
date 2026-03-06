// Lightweight test server for E2E tests.
// Serves static files + mock API routes — no external deps (tmux, bd, etc.).

const express = require("express");
const path = require("path");

const mockSessions = [
  {
    project: "nova-frontend",
    path: "/Users/demo/repos/nova-frontend",
    running: true,
    permissionMode: "ask",
    chatMode: "claude-local",
    git: { branch: "feature/dark-mode", dirtyFiles: 0, unpushed: 0, files: null },
    remoteUrl: "https://github.com/demo/nova-frontend.git",
    process: { pid: 42187, uptime: "47m", cpu: 4.0, memMB: 189.0 },
    ttydPort: 9877,
  },
  {
    project: "aurora-api",
    path: "/Users/demo/repos/aurora-api",
    running: true,
    permissionMode: "yolo",
    chatMode: "gemini",
    git: {
      branch: "main",
      dirtyFiles: 3,
      unpushed: 1,
      files: [
        { status: "M", path: "src/routes/auth.ts" },
        { status: "M", path: "src/middleware/cors.ts" },
        { status: "A", path: "src/utils/jwt.ts" },
      ],
    },
    remoteUrl: "https://github.com/demo/aurora-api.git",
    process: { pid: 42203, uptime: "2h 15m", cpu: 12.0, memMB: 245.0 },
    ttydPort: 9878,
  },
  {
    project: "stellar-ml",
    path: "/Users/demo/repos/stellar-ml",
    running: false,
    permissionMode: "strict",
    chatMode: "claude-local",
    git: { branch: "develop", dirtyFiles: 7, unpushed: 2, files: [] },
    remoteUrl: "https://github.com/demo/stellar-ml.git",
    process: null,
    ttydPort: null,
  },
];

const mockBeads = [
  { id: "klaudii-abc", title: "Fix login button", status: "open", priority: 1, type: "bug", assignee: null, created: "2026-03-01", updated: "2026-03-01" },
  { id: "klaudii-def", title: "Add dark mode", status: "in_progress", priority: 2, type: "feature", assignee: "Bryan", created: "2026-03-02", updated: "2026-03-05" },
  { id: "klaudii-ghi", title: "Update docs", status: "blocked", priority: 3, type: "task", assignee: null, created: "2026-03-03", updated: "2026-03-04" },
  { id: "klaudii-jkl", title: "Refactor CSS", status: "closed", priority: 2, type: "chore", assignee: "Bryan", created: "2026-02-28", updated: "2026-03-06" },
];

const mockSchedulerTasks = [
  { name: "shepherd", intervalMs: 300000, paused: false, lastRun: Date.now() - 120000, nextRun: Date.now() + 180000 },
];

function createTestServer() {
  const app = express();
  app.use(express.json());

  // Static files
  app.use(express.static(path.join(__dirname, "..", "..", "public")));

  // --- Mock API routes ---

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      tmux: true,
      ttyd: true,
      claudeAuth: { loggedIn: true },
      ghAuth: { loggedIn: true, account: "demo" },
      geminiAuth: { loggedIn: false },
      claudeChatAuth: { loggedIn: true },
    });
  });

  app.get("/api/sessions", (_req, res) => res.json(mockSessions));

  app.get("/api/processes", (_req, res) => {
    res.json(mockSessions.filter((s) => s.process).map((s) => ({
      pid: s.process.pid,
      ppid: 1,
      cwd: s.path,
      project: s.project,
      type: "claude",
      managed: true,
      uptime: s.process.uptime,
      cpu: s.process.cpu,
      memMB: s.process.memMB,
      launchedBy: "klaudii",
      command: "claude",
    })));
  });

  app.get("/api/usage", (_req, res) => {
    res.json({ buckets: [], rateLimits: [] });
  });

  app.get("/api/workspace-state/:workspace", (req, res) => {
    res.json({ mode: "claude-local", streaming: false, draft: "", pendingPermission: null });
  });

  app.patch("/api/workspace-state/:workspace", (req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/history", (_req, res) => res.json([]));

  app.get("/api/scheduler", (_req, res) => res.json(mockSchedulerTasks));

  app.post("/api/scheduler/:name/pause", (req, res) => res.json({ ok: true }));
  app.post("/api/scheduler/:name/resume", (req, res) => res.json({ ok: true }));
  app.post("/api/scheduler/:name/trigger", (req, res) => res.json({ ok: true }));

  // Beads
  app.get("/api/beads", (_req, res) => res.json([...mockBeads]));

  app.get("/api/beads/:id", (req, res) => {
    const bead = mockBeads.find((b) => b.id === req.params.id);
    if (!bead) return res.status(404).json({ error: "not found" });
    res.json(bead);
  });

  app.post("/api/beads", (req, res) => {
    const { title, description, priority, type } = req.body;
    if (!title) return res.status(400).json({ error: "title required" });
    const bead = {
      id: `klaudii-${Math.random().toString(36).slice(2, 5)}`,
      title,
      description: description || "",
      status: "open",
      priority: priority ?? 2,
      type: type || "task",
      assignee: null,
      created: new Date().toISOString().slice(0, 10),
      updated: new Date().toISOString().slice(0, 10),
    };
    mockBeads.push(bead);
    res.status(201).json(bead);
  });

  app.patch("/api/beads/:id", (req, res) => {
    const bead = mockBeads.find((b) => b.id === req.params.id);
    if (!bead) return res.status(404).json({ error: "not found" });
    Object.assign(bead, req.body);
    res.json(bead);
  });

  // GitHub repos (for new session modal)
  app.get("/api/github/repos", (_req, res) => {
    res.json([
      { name: "nova-frontend", owner: "demo", sshUrl: "git@github.com:demo/nova-frontend.git", cloned: true },
      { name: "aurora-api", owner: "demo", sshUrl: "git@github.com:demo/aurora-api.git", cloned: true },
      { name: "new-project", owner: "demo", sshUrl: "git@github.com:demo/new-project.git", cloned: false },
    ]);
  });

  app.get("/api/repos", (_req, res) => {
    res.json([{ name: "nova-frontend" }, { name: "aurora-api" }]);
  });

  app.get("/api/repos/:name/worktrees", (req, res) => {
    res.json([{ path: `/Users/demo/repos/${req.params.name}`, branch: "main" }]);
  });

  app.post("/api/sessions/new", (req, res) => {
    res.json({ ok: true, project: req.body.repo, branch: req.body.branch });
  });

  app.post("/api/sessions/start", (req, res) => {
    res.json({ ok: true, project: req.body.project });
  });

  app.post("/api/sessions/stop", (req, res) => {
    res.json({ ok: true });
  });

  app.post("/api/sessions/restart", (req, res) => {
    res.json({ ok: true });
  });

  app.post("/api/projects/permission", (req, res) => {
    res.json({ ok: true });
  });

  app.post("/api/projects/remove", (req, res) => {
    res.json({ ok: true });
  });

  app.post("/api/processes/kill", (req, res) => {
    res.json({ ok: true });
  });

  // Cloud / Gemini / Claude-chat stubs
  app.get("/api/cloud/status", (_req, res) => res.json({ paired: false, connected: false }));
  app.get("/api/gemini/status", (_req, res) => res.json({ installed: false }));
  app.get("/api/gemini/sessions/:project", (_req, res) => res.json({ sessions: [], current: 0, active: false }));
  app.get("/api/gemini/history/:project", (_req, res) => res.json([]));
  app.get("/api/gemini/quota", (_req, res) => res.json({ buckets: [] }));
  app.get("/api/gemini/models", (_req, res) => res.json([]));
  app.get("/api/claude-chat/status", (_req, res) => res.json({ installed: true }));
  app.get("/api/claude-chat/sessions/:project", (_req, res) => res.json({ sessions: [], current: 0, active: false }));
  app.get("/api/claude-chat/history/:project", (_req, res) => res.json([]));
  app.get("/api/claude-chat/models", (_req, res) => res.json(["claude-sonnet-4-6"]));
  app.get("/api/setup/status", (_req, res) => res.json({ ready: true, limpMode: false, deps: {} }));

  return { app, mockSessions, mockBeads, mockSchedulerTasks };
}

// If run directly, start the server
if (require.main === module) {
  const port = Number(process.env.PORT || 9899);
  const { app } = createTestServer();
  app.listen(port, () => console.log(`E2E test server on http://localhost:${port}`));
}

module.exports = { createTestServer };
