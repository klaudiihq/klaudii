// Test helper: creates an Express app with the v1 router and mock dependencies.
// Mock data mirrors the iOS app's demo/mock data (SessionsViewModel.swift:290-384)
// to ensure the server produces shapes the iOS app can decode.

const express = require("express");
const createV1Router = require("../../routes/v1");

// --- Mock data (matches iOS mock shapes) ---

const mockProjects = [
  { name: "nova-frontend", path: "/Users/demo/repos/nova-frontend", permissionMode: "ask" },
  { name: "aurora-api", path: "/Users/demo/repos/aurora-api", permissionMode: "yolo" },
  { name: "stellar-ml", path: "/Users/demo/repos/stellar-ml", permissionMode: "strict" },
  { name: "orbit-docs", path: "/Users/demo/repos/orbit-docs", permissionMode: "ask" },
];

const mockGitStatuses = {
  "/Users/demo/repos/nova-frontend": { branch: "feature/dark-mode", dirtyFiles: 0, unpushed: 0, files: null },
  "/Users/demo/repos/aurora-api": {
    branch: "main",
    dirtyFiles: 3,
    unpushed: 1,
    files: [
      { status: "M", path: "src/routes/auth.ts" },
      { status: "M", path: "src/middleware/cors.ts" },
      { status: "A", path: "src/utils/jwt.ts" },
    ],
  },
  "/Users/demo/repos/stellar-ml": {
    branch: "develop",
    dirtyFiles: 7,
    unpushed: 2,
    files: [
      { status: "M", path: "app/page.tsx" },
      { status: "M", path: "app/layout.tsx" },
      { status: "A", path: "components/Hero.tsx" },
      { status: "A", path: "components/Nav.tsx" },
      { status: "M", path: "styles/globals.css" },
      { status: "D", path: "components/OldHeader.tsx" },
      { status: "M", path: "package.json" },
    ],
  },
  "/Users/demo/repos/orbit-docs": { branch: "main", dirtyFiles: 0, unpushed: 0, files: null },
};

const mockRemoteUrls = {
  "/Users/demo/repos/nova-frontend": "https://github.com/demo/nova-frontend.git",
  "/Users/demo/repos/aurora-api": "https://github.com/demo/aurora-api.git",
  "/Users/demo/repos/stellar-ml": "https://github.com/demo/stellar-ml.git",
  "/Users/demo/repos/orbit-docs": "https://github.com/demo/orbit-docs.git",
};

const mockProcesses = [
  {
    pid: 42187,
    ppid: 1,
    cwd: "/Users/demo/repos/nova-frontend",
    project: "nova-frontend",
    type: "claude",
    managed: true,
    uptime: "47m",
    cpu: 4.0,
    memMB: 189.0,
    launchedBy: "klaudii",
    command: "claude",
  },
  {
    pid: 42203,
    ppid: 1,
    cwd: "/Users/demo/repos/aurora-api",
    project: "aurora-api",
    type: "claude",
    managed: true,
    uptime: "2h 15m",
    cpu: 12.0,
    memMB: 245.0,
    launchedBy: "klaudii",
    command: "claude --dangerously-skip-permissions",
  },
];

const mockHistoryEntries = [
  { sessionId: "sess-001", timestamp: Date.now() - 3600000, display: "Implement dark mode toggle" },
  { sessionId: "sess-002", timestamp: Date.now() - 7200000, display: "Fix CSS grid layout" },
  { sessionId: "sess-003", timestamp: Date.now() - 10800000, display: "Add unit tests for auth module" },
];

const mockGitHubRepos = [
  { name: "nova-frontend", owner: "demo", sshUrl: "git@github.com:demo/nova-frontend.git", cloned: true },
  { name: "aurora-api", owner: "demo", sshUrl: "git@github.com:demo/aurora-api.git", cloned: true },
  { name: "new-project", owner: "demo", sshUrl: "git@github.com:demo/new-project.git", cloned: false },
];

// --- Mock dependencies ---

function createMockDeps(overrides = {}) {
  const projectsList = [...mockProjects];

  // Track created sessions so sessionExists returns true after createSession
  const activeSessions = new Set(["klaudii-nova-frontend", "klaudii-aurora-api"]);

  return {
    tmux: {
      isTmuxInstalled: () => true,
      isTtydInstalled: () => true,
      TMUX_SOCKET: "/tmp/test-tmux.sock",
      listSessions: () => [],
      getClaudeSessions: () => [
        { name: "klaudii-nova-frontend", created: "2024-01-01" },
        { name: "klaudii-aurora-api", created: "2024-01-01" },
      ],
      sessionName: (name) => `klaudii-${name}`,
      sessionExists: (name) => activeSessions.has(name),
      isClaudeAlive: (name) => activeSessions.has(name),
      getManagedPids: () => [42187, 42203],
      createSession: (name) => { activeSessions.add(name); },
      killSession: (name) => { activeSessions.delete(name); },
    },

    ttyd: {
      isTtydInstalled: () => true,
      getRunning: () => [
        { project: "nova-frontend", port: 9877, pid: 50001 },
        { project: "aurora-api", port: 9878, pid: 50002 },
      ],
      allocatePort: () => 9879,
      start: () => {},
      stop: () => {},
    },

    claude: {
      getProjectLastActivity: () => Date.now() / 1000,
      getSessionsByIds: () => mockHistoryEntries,
      getRecentSessions: () => [],
      getTokenUsage: () => [],
      getRateLimitEvents: () => [],
    },

    git: {
      getStatus: (p) => mockGitStatuses[p] || null,
      getRemoteUrl: (p) => mockRemoteUrls[p] || null,
      isGitRepo: () => true,
      scanRepos: () => [{ name: "nova-frontend" }, { name: "aurora-api" }],
      listWorktrees: () => [{ path: "/Users/demo/repos/nova-frontend", branch: "main" }],
      initRepo: () => {},
      cloneRepo: () => {},
      addWorktree: () => {},
      removeWorktree: () => {},
      cleanWorktree: () => {},
    },

    github: {
      listRepos: () => mockGitHubRepos,
    },

    processes: {
      findClaudeProcesses: () => mockProcesses,
      killProcess: () => true,
    },

    sessionTracker: {
      getSessions: () => [{ startedAt: Date.now() }],
      getSessionIds: () => ["sess-001", "sess-002", "sess-003"],
      getClaudeUrl: () => null,
      addSession: () => {},
      detectAndTrack: () => Promise.resolve(),
      captureClaudeUrl: () => Promise.resolve(),
      clearClaudeUrl: () => {},
    },

    projects: {
      getProjects: () => projectsList,
      getProject: (name) => projectsList.find((p) => p.name === name) || null,
      addProject: (name, path) => {
        projectsList.push({ name, path, permissionMode: "yolo" });
        return projectsList;
      },
      removeProject: (name) => {
        const idx = projectsList.findIndex((p) => p.name === name);
        if (idx >= 0) projectsList.splice(idx, 1);
      },
      setPermissionMode: (name, mode) => {
        const p = projectsList.find((p) => p.name === name);
        if (!p) throw new Error(`project "${name}" not found`);
        p.permissionMode = mode;
      },
    },

    config: {
      port: 9876,
      ttydBasePort: 9877,
      reposDir: "/Users/demo/repos",
    },

    tasks: {
      getDb: () => ({}), // truthy — signals tasks are available
      list: () => [],
      get: () => null,
      create: () => ({}),
      update: () => null,
      close: () => ({}),
      remove: () => {},
      addComment: () => ({}),
      getComments: () => [],
      ready: () => [],
      closeDb: () => {},
    },

    authCheck: () => Promise.resolve({
      ghAuth: { loggedIn: true, account: "demo" },
      claudeAuth: { loggedIn: true },
    }),

    ...overrides,
  };
}

/**
 * Create a test Express app with the v1 router and mock dependencies.
 * Returns the app (for supertest) and the deps (for inspection/override).
 */
function createTestApp(overrides = {}) {
  const deps = createMockDeps(overrides);
  const app = express();
  app.use(express.json());
  app.use("/api", createV1Router(deps));
  return { app, deps };
}

module.exports = {
  createTestApp,
  createMockDeps,
  mockProjects,
  mockProcesses,
  mockHistoryEntries,
  mockGitHubRepos,
  mockGitStatuses,
};
