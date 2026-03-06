// Functional test helper: builds an Express app using the real v1 router
// with stateful mocks that track side effects across multi-step workflows.
//
// Unlike the contract test helper (test/helpers/server.js), these mocks
// maintain state so that create → verify → delete sequences work correctly.

const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const createV1Router = require("../../routes/v1");

/**
 * Create a temp directory that is automatically cleaned up via the returned
 * cleanup function. Callers should invoke cleanup() in afterEach/afterAll.
 */
function makeTempDir(prefix = "klaudii-func-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup() {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

/**
 * Create a stateful mock for workspace-state that uses temp file persistence.
 */
function createWorkspaceState(tmpDir) {
  const stateFile = path.join(tmpDir, "workspace-state.json");
  const VALID_MODES = ["gemini", "claude-local", "claude-remote"];
  const DEFAULT_MODE = "claude-local";
  let state = {};
  const chatActivity = new Map();
  const streaming = new Map();
  const pendingPermissions = new Map();

  function save() { fs.writeFileSync(stateFile, JSON.stringify(state, null, 2)); }
  function ensureWorkspace(ws) {
    if (!state[ws]) state[ws] = { mode: DEFAULT_MODE, sessions: {}, drafts: {} };
    if (!state[ws].sessions) state[ws].sessions = {};
    if (!state[ws].drafts) state[ws].drafts = {};
    return state[ws];
  }

  return {
    getWorkspace(ws) {
      const s = ensureWorkspace(ws);
      const mode = s.mode || DEFAULT_MODE;
      const sessionNum = s.sessions[mode] || null;
      const draftKey = sessionNum ? `${mode}:${sessionNum}` : `${mode}:new`;
      return { mode, sessionNum, draft: s.drafts[draftKey] || "" };
    },
    setState(ws, updates) {
      const s = ensureWorkspace(ws);
      if (updates.mode && VALID_MODES.includes(updates.mode)) s.mode = updates.mode;
      const effectiveMode = s.mode || DEFAULT_MODE;
      if (updates.sessionNum != null) {
        const targetMode = updates.draftMode || effectiveMode;
        s.sessions[targetMode] = updates.sessionNum;
      }
      if (updates.draft !== undefined) {
        const draftMode = updates.draftMode || effectiveMode;
        const draftSession = updates.draftSession || s.sessions[draftMode] || "new";
        const key = `${draftMode}:${draftSession}`;
        if (updates.draft) s.drafts[key] = updates.draft;
        else delete s.drafts[key];
      }
      save();
    },
    touchChatActivity(ws) {
      const ts = Date.now();
      chatActivity.set(ws, ts);
      const s = ensureWorkspace(ws);
      s.lastChatActivity = ts;
      save();
    },
    getLastChatActivity(ws) { return chatActivity.get(ws) || (state[ws] && state[ws].lastChatActivity) || 0; },
    setStreaming(ws, active) { if (active) streaming.set(ws, true); else streaming.delete(ws); },
    isStreaming(ws) { return streaming.has(ws); },
    setPendingPermission(ws, event) { if (event) pendingPermissions.set(ws, event); else pendingPermissions.delete(ws); },
    getPendingPermission(ws) { return pendingPermissions.get(ws) || null; },
    validModes() { return VALID_MODES; },
    setWorkspaceType(ws, type) { const s = ensureWorkspace(ws); s.type = type; save(); },
    getWorkspaceType(ws) { return (state[ws] && state[ws].type) || "user"; },
    // For test inspection
    _state: state,
    _stateFile: stateFile,
    _reload() {
      try { state = JSON.parse(fs.readFileSync(stateFile, "utf-8")); } catch { state = {}; }
      // Re-wire the _state reference
      this._state = state;
    },
  };
}

/**
 * Create a stateful mock for the memory module backed by in-memory arrays.
 */
function createMemoryMock() {
  const store = { architect: [], shepherd: [] };
  let nextId = 1;

  return {
    store(agent, { content, category, workspace, session_id }) {
      const entry = { id: nextId++, agent, content, category: category || null, workspace: workspace || null, session_id: session_id || null, created_at: new Date().toISOString() };
      store[agent].push(entry);
      return entry;
    },
    list(agent, { limit = 50, workspace } = {}) {
      let entries = store[agent] || [];
      if (workspace) entries = entries.filter(e => e.workspace === workspace || !e.workspace);
      return entries.slice(-limit).reverse();
    },
    search(agent, query, { limit = 50 } = {}) {
      return (store[agent] || []).filter(e => e.content.includes(query)).slice(-limit).reverse();
    },
    remove(agent, id) {
      const arr = store[agent] || [];
      const idx = arr.findIndex(e => e.id === id);
      if (idx < 0) return false;
      arr.splice(idx, 1);
      return true;
    },
    close() {},
  };
}

/**
 * Create a stateful mock for claudeChat that tracks sessions and history.
 */
function createClaudeChatMock() {
  const history = {}; // workspace → sessionNum → messages[]
  const sessions = {}; // workspace → { current, total }
  const active = new Set();
  const streamPartials = {};

  function ensureSession(ws) {
    if (!sessions[ws]) sessions[ws] = { current: 1, total: 1 };
    return sessions[ws];
  }
  function ensureHistory(ws, num) {
    if (!history[ws]) history[ws] = {};
    if (!history[ws][num]) history[ws][num] = [];
    return history[ws][num];
  }

  return {
    isInstalled: () => true,
    getBinPath: () => "/usr/local/bin/claude",
    getAuthStatus: () => ({ loggedIn: true }),
    startAuthCheck: () => {},
    isActive: (ws) => active.has(ws),
    getSessions: (ws) => {
      const s = ensureSession(ws);
      return { current: s.current, total: s.total, sessions: Array.from({ length: s.total }, (_, i) => i + 1) };
    },
    newSession: (ws) => {
      const s = ensureSession(ws);
      s.total++;
      s.current = s.total;
      return s.current;
    },
    setCurrentSession: (ws, num) => {
      const s = ensureSession(ws);
      if (num < 1 || num > s.total) return false;
      s.current = num;
      return true;
    },
    getHistory: (ws, sessionNum) => {
      const s = ensureSession(ws);
      const num = sessionNum || s.current;
      return ensureHistory(ws, num);
    },
    pushHistory: (ws, role, content, meta) => {
      const s = ensureSession(ws);
      const msgs = ensureHistory(ws, s.current);
      msgs.push({ role, content, ts: Date.now(), ...(meta || {}) });
    },
    pushHistoryBatch: (ws, batch) => {
      const s = ensureSession(ws);
      const msgs = ensureHistory(ws, s.current);
      for (const entry of batch) msgs.push({ ...entry, ts: Date.now() });
    },
    sendMessage: async (ws, projPath, message, config, opts) => {
      active.add(ws);
      const eventHandlers = [];
      const doneHandlers = [];
      const errorHandlers = [];

      // Simulate an async response after a microtask
      Promise.resolve().then(() => {
        for (const fn of eventHandlers) {
          fn({ type: "message", role: "assistant", content: `Mock response to: ${message}`, delta: true });
          fn({ type: "result", stats: { inputTokens: 10, outputTokens: 20 } });
        }
        active.delete(ws);
        for (const fn of doneHandlers) fn({ code: 0, stderr: "" });
      });

      return {
        onEvent: (fn) => eventHandlers.push(fn),
        onDone: (fn) => doneHandlers.push(fn),
        onError: (fn) => errorHandlers.push(fn),
      };
    },
    appendMessage: (ws, message) => {},
    stopProcess: (ws) => { active.delete(ws); },
    getStreamPartial: (ws) => streamPartials[ws] || null,
    getModels: () => [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }],
    getLastMessageTime: (ws) => {
      const s = sessions[ws];
      if (!s) return 0;
      const msgs = history[ws] && history[ws][s.current];
      if (!msgs || !msgs.length) return 0;
      return msgs[msgs.length - 1].ts || 0;
    },
    sendControlResponse: () => {},
    sendToolResult: () => {},
    sendControlRequest: () => {},
    recoverStreams: () => {},
    reconnectActiveRelays: () => {},
    checkAuth: () => ({ loggedIn: true }),
    // For test manipulation
    _setActive: (ws, val) => { if (val) active.add(ws); else active.delete(ws); },
    _setStreamPartial: (ws, text) => { streamPartials[ws] = text; },
  };
}

/**
 * Create stateful mock for projects backed by an in-memory list.
 */
function createProjectsMock(initial = []) {
  const projectsList = [...initial];

  return {
    getProjects: () => projectsList,
    getProject: (name) => projectsList.find(p => p.name === name) || null,
    addProject: (name, projPath) => {
      if (projectsList.find(p => p.name === name)) throw new Error(`project "${name}" already exists`);
      projectsList.push({ name, path: projPath, permissionMode: "yolo" });
      return projectsList;
    },
    removeProject: (name) => {
      const idx = projectsList.findIndex(p => p.name === name);
      if (idx >= 0) projectsList.splice(idx, 1);
    },
    setPermissionMode: (name, mode) => {
      const p = projectsList.find(p => p.name === name);
      if (!p) throw new Error(`project "${name}" not found`);
      p.permissionMode = mode;
    },
  };
}

/**
 * Create stateful tmux mock that tracks active sessions.
 */
function createTmuxMock() {
  const activeSessions = new Set();
  return {
    isTmuxInstalled: () => true,
    TMUX_SOCKET: "/tmp/test-tmux.sock",
    listSessions: () => [...activeSessions].map(name => ({ name, created: "2024-01-01" })),
    getClaudeSessions: () => [...activeSessions].map(name => ({ name, created: "2024-01-01" })),
    sessionName: (name) => `klaudii-${name}`,
    sessionExists: (name) => activeSessions.has(name),
    isClaudeAlive: (name) => activeSessions.has(name),
    getManagedPids: () => [],
    createSession: (name) => { activeSessions.add(name); },
    killSession: (name) => { activeSessions.delete(name); },
    capturePane: () => "",
    sendKeys: () => {},
  };
}

/**
 * Create stateful git mock.
 */
function createGitMock(tmpDir) {
  const worktrees = {};
  return {
    getStatus: () => ({ branch: "main", dirtyFiles: 0, unpushed: 0, files: null }),
    getRemoteUrl: () => "https://github.com/test/test.git",
    isGitRepo: (dir) => fs.existsSync(dir),
    scanRepos: () => [],
    listWorktrees: (dir) => worktrees[dir] || [],
    initRepo: (dir) => { fs.mkdirSync(dir, { recursive: true }); },
    cloneRepo: (url, dir) => { fs.mkdirSync(dir, { recursive: true }); },
    addWorktree: (repoDir, wtDir, branch) => {
      fs.mkdirSync(wtDir, { recursive: true });
      // Simulate .git file (worktree marker)
      fs.writeFileSync(path.join(wtDir, ".git"), `gitdir: ${repoDir}/.git/worktrees/${branch}`);
      if (!worktrees[repoDir]) worktrees[repoDir] = [];
      worktrees[repoDir].push({ path: wtDir, branch });
    },
    removeWorktree: (repoDir, wtDir) => {
      if (worktrees[repoDir]) {
        worktrees[repoDir] = worktrees[repoDir].filter(w => w.path !== wtDir);
      }
      try { fs.rmSync(wtDir, { recursive: true, force: true }); } catch {}
    },
    cleanWorktree: () => {},
  };
}

/**
 * Build a complete functional test app with all deps wired up.
 * Returns { app, deps, tmpDir, cleanup }.
 */
function createFunctionalApp(overrides = {}) {
  const tmp = makeTempDir();
  const workspaceState = createWorkspaceState(tmp.dir);
  const memory = createMemoryMock();
  const claudeChat = createClaudeChatMock();
  const projectsMock = createProjectsMock(overrides.initialProjects || []);
  const tmuxMock = createTmuxMock();
  const gitMock = createGitMock(tmp.dir);

  const deps = {
    tmux: tmuxMock,
    ttyd: {
      isTtydInstalled: () => true,
      getRunning: () => [],
      allocatePort: () => 9900,
      start: () => {},
      stop: () => {},
    },
    claude: {
      getProjectLastActivity: () => 0,
      getSessionsByIds: () => [],
      getRecentSessions: () => [],
      getTokenUsage: () => [],
      getRateLimitEvents: () => [],
    },
    git: gitMock,
    github: {
      listRepos: () => overrides.githubRepos || [],
    },
    processes: {
      findClaudeProcesses: () => [],
      killProcess: () => true,
    },
    sessionTracker: {
      getSessions: () => [],
      getSessionIds: () => [],
      getClaudeUrl: () => null,
      addSession: () => {},
      detectAndTrack: async () => {},
      captureClaudeUrl: async () => {},
      clearClaudeUrl: () => {},
    },
    projects: projectsMock,
    config: {
      port: 9876,
      ttydBasePort: 9900,
      reposDir: path.join(tmp.dir, "repos"),
    },
    gemini: {
      isInstalled: () => false,
      getBinPath: () => null,
      getAuthStatus: () => ({ loggedIn: false }),
      getLastMessageTime: () => 0,
    },
    claudeChat,
    workspaceState,
    memory,
    ...overrides,
  };

  // Ensure repos dir exists
  fs.mkdirSync(deps.config.reposDir, { recursive: true });

  const app = express();
  app.use(express.json());
  app.use("/api", createV1Router(deps));

  return { app, deps, tmpDir: tmp.dir, cleanup: tmp.cleanup };
}

module.exports = {
  makeTempDir,
  createFunctionalApp,
  createWorkspaceState,
  createMemoryMock,
  createClaudeChatMock,
  createProjectsMock,
  createTmuxMock,
  createGitMock,
};
