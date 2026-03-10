const { spawn, execSync } = require("child_process");
const { TMUX_SOCKET, sessionName } = require("./tmux");

// Track running ttyd processes: { [projectName]: { process, port, pid } }
const instances = {};

let _ttydBin;
try { _ttydBin = require("./projects").loadConfig().ttydPath || null; } catch {}
const TTYD_BIN = _ttydBin || "ttyd";

function isTtydInstalled() {
  try {
    execSync(`which ${TTYD_BIN}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Recover tracking of ttyd processes that survived a server restart.
 * Scans running ttyd processes and re-registers them.
 */
function recoverInstances() {
  let lines;
  try {
    lines = execSync("ps -eo pid,command", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] })
      .trim()
      .split("\n");
  } catch {
    return;
  }

  for (const line of lines) {
    const match = line.trim().match(/^(\d+)\s+ttyd\s+-p\s+(\d+)\s+.*attach\s+-t\s+(claude-\S+)/);
    if (!match) continue;
    const [, pid, port, tmuxName] = match;
    // Derive project name from tmux session name (strip "claude-" prefix)
    const project = tmuxName.replace(/^claude-/, "");

    if (!instances[project]) {
      instances[project] = { process: null, port: parseInt(port), pid: parseInt(pid) };
    }
  }
}

function start(projectName, tmuxSessionName, port) {
  if (instances[projectName]) {
    throw new Error(`ttyd already running for "${projectName}" on port ${instances[projectName].port}`);
  }

  const proc = spawn(TTYD_BIN, ["-p", String(port), "-W", "tmux", "-S", TMUX_SOCKET, "attach", "-t", tmuxSessionName], {
    stdio: "ignore",
    detached: true,
  });

  proc.unref();

  proc.on("exit", () => {
    delete instances[projectName];
  });

  instances[projectName] = { process: proc, port, pid: proc.pid };
  return { port, pid: proc.pid };
}

function stop(projectName) {
  const instance = instances[projectName];
  if (!instance) return false;

  try {
    process.kill(instance.pid, "SIGTERM");
  } catch {
    // Already dead
  }
  delete instances[projectName];
  return true;
}

function getRunning() {
  return Object.entries(instances).map(([name, info]) => ({
    project: name,
    port: info.port,
    pid: info.pid,
  }));
}

function getPort(projectName) {
  return instances[projectName]?.port ?? null;
}

function allocatePort(basePort) {
  const usedPorts = new Set(Object.values(instances).map((i) => i.port));
  let port = basePort;
  while (usedPorts.has(port)) port++;
  return port;
}

module.exports = { isTtydInstalled, start, stop, getRunning, getPort, allocatePort, recoverInstances };
