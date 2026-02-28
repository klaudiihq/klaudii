const { execSync } = require("child_process");
const os = require("os");
const fs = require("fs");
const path = require("path");

// WARNING: The tmux socket MUST resolve to an absolute path that is identical
// when accessed from launchd (the background service) and interactive shells.
// This is critical — if they see different paths, they talk to different tmux
// servers and nothing works.
//
// The socket path is read from config.json ("tmuxSocket"), which is written
// at install time with the correct absolute path for this machine. This avoids
// depending on runtime values like os.homedir() or env vars that may differ
// under launchd.
//
// DO NOT CHANGE THIS TO USE:
//   os.homedir()  — may return wrong value under launchd (e.g. /var/root)
//   /tmp/         — private per-process on macOS (sandboxed via /var/folders/)
//   process.env.HOME — not set under launchd unless explicitly configured
//
// Fallback: project-relative path if config doesn't specify one.
// This was extremely hard to debug. Do not regress it.
let _configSocket;
try {
  _configSocket = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "config.json"), "utf-8")
  ).tmuxSocket;
} catch {}
const TMUX_SOCKET = _configSocket || path.join(__dirname, "..", ".klaudii-tmux.sock");
const TMUX = `tmux -S '${TMUX_SOCKET}'`;

function isTmuxInstalled() {
  try {
    execSync("which tmux", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function listSessions() {
  try {
    const output = execSync(
      `${TMUX} list-sessions -F '#{session_name}|||#{session_created}|||#{session_attached}|||#{pane_current_command}'`,
      { stdio: "pipe", encoding: "utf-8" }
    );
    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, created, attached, command] = line.split("|||");
        return {
          name,
          created: parseInt(created, 10),
          attached: attached === "1",
          command,
        };
      });
  } catch {
    return [];
  }
}

function getClaudeSessions() {
  return listSessions().filter((s) => s.name.startsWith("claude-"));
}

function sessionExists(name) {
  return listSessions().some((s) => s.name === name);
}

function ensureWorkspaceTrust(projectDir) {
  const fs = require("fs");
  const claudeJsonPath = path.join(os.homedir(), ".claude.json");

  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(claudeJsonPath, "utf-8"));
  } catch {
    // File doesn't exist or is invalid — start fresh
  }

  if (!config.projects) config.projects = {};

  const absPath = path.resolve(projectDir);
  if (!config.projects[absPath]) {
    config.projects[absPath] = {};
  }

  if (!config.projects[absPath].hasTrustDialogAccepted) {
    config.projects[absPath].hasTrustDialogAccepted = true;
    fs.writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  }
}

function createSession(name, projectDir, claudeArgs = "") {
  if (sessionExists(name)) {
    throw new Error(`tmux session "${name}" already exists`);
  }

  const fs = require("fs");
  if (!fs.existsSync(projectDir)) {
    throw new Error(`Project directory does not exist: ${projectDir}`);
  }

  // Pre-accept workspace trust by writing to ~/.claude.json
  ensureWorkspaceTrust(projectDir);

  const cleanEnv = { ...process.env };
  delete cleanEnv.CLAUDECODE;

  const claudeCmd = claudeArgs ? `claude ${claudeArgs}` : "claude --dangerously-skip-permissions remote-control";
  const shellCmd = `cd '${projectDir}' && unset CLAUDECODE && ${claudeCmd}`;
  const wrappedCmd = `source ~/.zshrc 2>/dev/null; ${shellCmd}`;
  const tmuxCmd = `${TMUX} new-session -d -s '${name}' /bin/zsh -c '${wrappedCmd.replace(/'/g, "'\\''")}'`;

  execSync(tmuxCmd, {
    stdio: "pipe",
    env: cleanEnv,
  });
}

function killSession(name) {
  if (!sessionExists(name)) {
    throw new Error(`tmux session "${name}" does not exist`);
  }
  execSync(`${TMUX} kill-session -t '${name}'`, { stdio: "pipe" });
}

function sessionName(projectName) {
  return `claude-${projectName}`;
}

/**
 * Capture the pane output and extract the claude.ai/code URL if present.
 */
function getClaudeUrl(sessionName) {
  try {
    const output = execSync(
      `${TMUX} capture-pane -t '${sessionName}' -p -J`,
      { stdio: "pipe", encoding: "utf-8" }
    );
    const match = output.match(/https:\/\/claude\.ai\/code\/[^\s]+/);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

/**
 * Get all descendant processes of a tmux pane.
 * Returns [{pid, ppid, command}, ...] or empty array.
 */
function getPaneProcessTree(sessionName) {
  try {
    const panePid = execSync(
      `${TMUX} list-panes -t '${sessionName}' -F '#{pane_pid}'`,
      { stdio: "pipe", encoding: "utf-8" }
    ).trim();
    if (!panePid) return [];

    const allPs = execSync(
      `ps -eo pid,ppid,command`,
      { stdio: "pipe", encoding: "utf-8" }
    );
    const children = new Set([panePid]);
    const lines = allPs.trim().split("\n");

    // BFS to find all descendants
    let changed = true;
    while (changed) {
      changed = false;
      for (const line of lines) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+/);
        if (m && children.has(m[2]) && !children.has(m[1])) {
          children.add(m[1]);
          changed = true;
        }
      }
    }

    const procs = [];
    for (const line of lines) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)/);
      if (m && children.has(m[1])) {
        procs.push({ pid: m[1], ppid: m[2], command: m[3] });
      }
    }
    return procs;
  } catch {
    return [];
  }
}

/**
 * Get the claude.ai URL by extracting --session-id from process args.
 * Returns a URL like https://claude.ai/code/session_XXXXX or null.
 */
function getClaudeUrlFromProcess(sessionName) {
  for (const p of getPaneProcessTree(sessionName)) {
    const m = p.command.match(/--session-id\s+(session_[^\s]+)/);
    if (m) return `https://claude.ai/code/${m[1]}`;
  }
  return null;
}

/**
 * Check if a Claude process is alive in the tmux pane.
 * Looks for the claude binary or a child with --session-id.
 */
function isClaudeAlive(sessionName) {
  const procs = getPaneProcessTree(sessionName);
  return procs.some((p) =>
    p.command.includes("--session-id") ||
    /\bclaude\b.*--dangerously-skip-permissions/.test(p.command)
  );
}

/**
 * Get PIDs of all processes running in managed tmux panes.
 * Used to identify which claude processes are managed vs orphaned.
 */
function getManagedPids() {
  try {
    const output = execSync(
      `${TMUX} list-panes -a -F '#{pane_pid}'`,
      { stdio: "pipe", encoding: "utf-8" }
    );
    return output.trim().split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

module.exports = {
  isTmuxInstalled,
  listSessions,
  getClaudeSessions,
  sessionExists,
  createSession,
  killSession,
  sessionName,
  getClaudeUrl,
  getClaudeUrlFromProcess,
  isClaudeAlive,
  getManagedPids,
  TMUX_SOCKET,
};
