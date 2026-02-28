const { execSync } = require("child_process");
const os = require("os");
const path = require("path");

// Use a fixed socket path so launchd and interactive shells share the same tmux server
// Hardcode the path since os.homedir() may differ under launchd
const TMUX_SOCKET = "/Volumes/Fast/bryantinsley/.claude/klaudii-tmux.sock";
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

  const claudeCmd = claudeArgs ? `claude --dangerously-skip-permissions ${claudeArgs}` : "claude --dangerously-skip-permissions remote-control";
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
  getManagedPids,
  TMUX_SOCKET,
};
