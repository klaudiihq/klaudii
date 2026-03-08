// Lightweight test server for E2E tests.
// Serves static files + mock API routes — no external deps (tmux, bd, etc.).

const express = require("express");
const path = require("path");
const { WebSocketServer } = require("ws");

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

const mockTasks = [
  { id: "klaudii-abc", title: "Fix login button", status: "open", priority: 1, type: "bug", assignee: null, created: "2026-03-01", updated: "2026-03-01" },
  { id: "klaudii-def", title: "Add dark mode", status: "in_progress", priority: 2, type: "feature", assignee: "Alice", created: "2026-03-02", updated: "2026-03-05" },
  { id: "klaudii-ghi", title: "Update docs", status: "blocked", priority: 3, type: "task", assignee: null, created: "2026-03-03", updated: "2026-03-04" },
  { id: "klaudii-jkl", title: "Refactor CSS", status: "closed", priority: 2, type: "chore", assignee: "Alice", created: "2026-02-28", updated: "2026-03-06" },
];

const mockSchedulerTasks = [
  { name: "shepherd", intervalMs: 300000, enabled: true, running: false, lastRunAt: new Date(Date.now() - 120000).toISOString(), lastResult: "ok", lastError: null },
];

const mockSettings = { workerVisibility: "hide", theme: "dark" };

const mockChatHistory = {
  "nova-frontend": [
    { role: "user", content: "Add dark mode support", ts: Date.now() - 60000 },
    { role: "assistant", content: "I'll add dark mode support to the app. Let me start by creating a theme toggle.", ts: Date.now() - 55000 },
  ],
  "aurora-api": [
    { role: "user", content: "Fix the auth middleware", ts: Date.now() - 30000 },
    { role: "assistant", content: "I'll review the auth middleware and fix the issue.", ts: Date.now() - 25000 },
  ],
};

const mockWorkspaceStates = {};

function getWorkspaceState(workspace) {
  if (!mockWorkspaceStates[workspace]) {
    mockWorkspaceStates[workspace] = { mode: "claude-local", streaming: false, draft: "", pendingPermission: null, sessionNum: 1 };
  }
  return mockWorkspaceStates[workspace];
}

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
    res.json(getWorkspaceState(req.params.workspace));
  });

  app.patch("/api/workspace-state/:workspace", (req, res) => {
    const state = getWorkspaceState(req.params.workspace);
    Object.assign(state, req.body);
    res.json(state);
  });

  // Settings
  app.get("/api/settings", (_req, res) => res.json({ ...mockSettings }));
  app.patch("/api/settings", (req, res) => {
    Object.assign(mockSettings, req.body);
    res.json({ ...mockSettings });
  });

  // Projects list (for gemini.js workspace picker)
  app.get("/api/projects", (_req, res) => {
    res.json(mockSessions.map((s) => ({ name: s.project, path: s.path })));
  });

  // Chat stop
  app.post("/api/chat/:project/stop", (req, res) => res.json({ ok: true }));

  // Agent chat start
  app.post("/api/agent-chat/:role/start", (req, res) => {
    res.json({ ok: true, workspace: `agent-${req.params.role}`, workspacePath: "/tmp/agent" });
  });

  app.get("/api/history", (_req, res) => res.json([]));

  app.get("/api/scheduler", (_req, res) => res.json(mockSchedulerTasks));

  app.post("/api/scheduler/:name/pause", (req, res) => res.json({ ok: true }));
  app.post("/api/scheduler/:name/resume", (req, res) => res.json({ ok: true }));
  app.post("/api/scheduler/:name/trigger", (req, res) => res.json({ ok: true }));

  // Tasks
  app.get("/api/tasks", (_req, res) => res.json([...mockTasks]));

  app.get("/api/tasks/:id", (req, res) => {
    const task = mockTasks.find((b) => b.id === req.params.id);
    if (!task) return res.status(404).json({ error: "not found" });
    res.json(task);
  });

  app.post("/api/tasks", (req, res) => {
    const { title, description, priority, type } = req.body;
    if (!title) return res.status(400).json({ error: "title required" });
    const task = {
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
    mockTasks.push(task);
    res.status(201).json(task);
  });

  app.patch("/api/tasks/:id", (req, res) => {
    const task = mockTasks.find((b) => b.id === req.params.id);
    if (!task) return res.status(404).json({ error: "not found" });
    // Support comment field — append to description for mock
    if (req.body.comment) {
      task.description = (task.description || "") + "\n---\n" + req.body.comment;
      delete req.body.comment;
    }
    Object.assign(task, req.body);
    res.json(task);
  });

  // Task sessions (workers assigned to task)
  app.get("/api/tasks/:id/sessions", (req, res) => {
    const task = mockTasks.find((b) => b.id === req.params.id);
    if (!task) return res.status(404).json({ error: "not found" });
    // Return mock sessions for in_progress tasks
    if (task.status === "in_progress" && task.assignee) {
      res.json([{ workspace: `task-${task.id}`, status: "running", assignee: task.assignee }]);
    } else {
      res.json([]);
    }
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
  app.get("/api/cloud/connection-key", (_req, res) => res.json({ key: "test-key-123" }));
  app.post("/api/cloud/pair", (req, res) => res.json({ ok: true }));
  app.post("/api/cloud/unpair", (req, res) => res.json({ ok: true }));
  app.get("/api/gemini/status", (_req, res) => res.json({ installed: false }));
  app.get("/api/gemini/sessions/:project", (_req, res) => res.json({ sessions: [], current: 0, active: false }));
  app.get("/api/gemini/history/:project", (_req, res) => res.json([]));
  app.get("/api/gemini/quota", (_req, res) => res.json({ buckets: [] }));
  app.get("/api/gemini/models", (_req, res) => res.json([]));
  app.get("/api/gemini/apikey/:project", (_req, res) => res.json({ hasKey: false }));
  app.get("/api/gemini/stream-partial/:workspace", (_req, res) => res.json({ content: "", done: false }));
  app.post("/api/gemini/auth/login", (_req, res) => res.json({ ok: true }));
  app.post("/api/gemini/auth/recheck", (_req, res) => res.json({ ok: true, loggedIn: false }));
  app.post("/api/gemini/:workspace/confirm", (_req, res) => res.json({ ok: true }));
  app.get("/api/claude-chat/status", (_req, res) => res.json({ installed: true }));
  app.get("/api/claude-chat/sessions/:project", (req, res) => {
    const project = req.params.project;
    const history = mockChatHistory[project];
    res.json({ sessions: history ? [1] : [], current: history ? 1 : 0, active: false });
  });
  app.get("/api/claude-chat/history/:project", (req, res) => {
    const project = req.params.project;
    res.json(mockChatHistory[project] || []);
  });
  app.get("/api/claude-chat/models", (_req, res) => res.json(["claude-sonnet-4-6"]));
  app.get("/api/claude-chat/apikey/:project", (_req, res) => res.json({ hasKey: false }));
  app.get("/api/setup/status", (_req, res) => res.json({ ready: true, limpMode: false, deps: {} }));
  app.post("/api/repos/create", (req, res) => res.json({ ok: true, name: req.body.name }));

  return { app, mockSessions, mockTasks, mockSchedulerTasks, mockChatHistory, mockSettings };
}

function attachWebSocket(server) {
  const wss = new WebSocketServer({ server, path: "/ws/chat" });

  wss.on("connection", (ws) => {
    // Send a mock response when a message is sent
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === "send") {
        // Acknowledge
        ws.send(JSON.stringify({ type: "ack", workspace: msg.workspace, status: "received" }));

        // Simulate assistant response with tool_use and message
        setTimeout(() => {
          ws.send(JSON.stringify({
            type: "tool_use",
            workspace: msg.workspace,
            tool_name: "Read",
            tool_id: "tool_001",
            parameters: { file_path: "/src/app.js" },
          }));
        }, 50);

        setTimeout(() => {
          ws.send(JSON.stringify({
            type: "tool_result",
            workspace: msg.workspace,
            tool_id: "tool_001",
            tool_name: "Read",
            status: "success",
            output: "file contents here",
          }));
        }, 100);

        setTimeout(() => {
          ws.send(JSON.stringify({
            type: "message",
            workspace: msg.workspace,
            role: "assistant",
            content: `Mock response to: ${msg.message}`,
          }));
        }, 150);

        setTimeout(() => {
          ws.send(JSON.stringify({
            type: "done",
            workspace: msg.workspace,
            exitCode: 0,
          }));
        }, 200);
      }
    });
  });

  return wss;
}

// If run directly, start the server
if (require.main === module) {
  const port = Number(process.env.PORT || 9899);
  const { app } = createTestServer();
  const server = app.listen(port, () => console.log(`E2E test server on http://localhost:${port}`));
  attachWebSocket(server);
}

module.exports = { createTestServer, attachWebSocket };
