const { execSync } = require("child_process");

/**
 * Discover all running Claude and Gemini processes on this machine.
 * managedPids = PIDs from tmux panes (direct children of tmux).
 * A process is "managed" if its PID or any ancestor PID is in managedPids.
 */
function findClaudeProcesses(managedPids) {
  const managedSet = new Set((managedPids || []).map(String));

  let lines;
  try {
    lines = execSync('ps -eo pid,ppid,pcpu,rss,etime,command', { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] })
      .trim()
      .split("\n");
  } catch {
    return [];
  }

  // Build lookups for ancestor walking and resource aggregation
  const ppidMap = {};
  const cpuMap = {};
  const rssMap = {};
  const childrenMap = {}; // parent pid -> [child pids]
  for (const line of lines) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+([\d:.-]+)\s+(.*)$/);
    if (!match) continue;
    const [, pid, ppid, pcpu, rss] = match;
    ppidMap[pid] = ppid;
    cpuMap[pid] = parseFloat(pcpu);
    rssMap[pid] = parseInt(rss);
    if (!childrenMap[ppid]) childrenMap[ppid] = [];
    childrenMap[ppid].push(pid);
  }

  // Noise filter shared by both claude and gemini scans
  const noiseRe = /node|tmux|ttyd|KlaudiiMenu|grep|pgrep|shell-snapshots/;

  // --- Claude processes ---
  const claudeProcs = [];
  for (const line of lines) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+([\d:.-]+)\s+(.*)$/);
    if (!match) continue;
    const [, pid, ppid, , , etime, command] = match;

    if (!command.includes("claude")) continue;
    if (noiseRe.test(command)) continue;
    if (command.includes("--sdk-url")) continue;
    if (/\bclaude\b.*\bauth\b/.test(command)) continue;

    claudeProcs.push({ pid, ppid, etime: etime.trim(), command: command.trim(), provider: "claude" });
  }

  // --- Gemini processes ---
  const geminiProcs = [];
  for (const line of lines) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+([\d:.-]+)\s+(.*)$/);
    if (!match) continue;
    const [, pid, ppid, , , etime, command] = match;

    if (!command.includes("gemini")) continue;
    if (noiseRe.test(command)) continue;
    // Skip Klaudii auth probes (gemini --list-sessions)
    if (/--list-sessions/.test(command)) continue;
    // Skip if this line also matched as a claude process (e.g. path contains both words)
    if (command.includes("claude")) continue;

    geminiProcs.push({ pid, ppid, etime: etime.trim(), command: command.trim(), provider: "gemini" });
  }

  const allProcs = [...claudeProcs, ...geminiProcs];

  // Sum CPU and RSS for a process and all its descendants
  function sumResources(pid) {
    let cpu = cpuMap[pid] || 0;
    let rss = rssMap[pid] || 0;
    const children = childrenMap[pid] || [];
    for (const child of children) {
      const sub = sumResources(child);
      cpu += sub.cpu;
      rss += sub.rss;
    }
    return { cpu, rss };
  }

  // Check if a PID has a managed ancestor (walk up to 10 levels)
  function isManaged(pid) {
    let current = String(pid);
    for (let i = 0; i < 10; i++) {
      if (managedSet.has(current)) return true;
      const parent = ppidMap[current];
      if (!parent || parent === "0" || parent === "1" || parent === current) break;
      current = parent;
    }
    return false;
  }

  const results = [];
  for (const proc of allProcs) {
    let cwd = null;
    try {
      const lsofOut = execSync(`lsof -a -d cwd -p ${proc.pid} 2>/dev/null`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
      const lines2 = lsofOut.trim().split("\n");
      // Last line has the CWD path as the last space-separated field
      if (lines2.length >= 2) {
        const fields = lines2[lines2.length - 1].trim().split(/\s+/);
        cwd = fields[fields.length - 1];
      }
    } catch {}

    let project = null;
    if (cwd) {
      const parts = cwd.split("/");
      project = parts[parts.length - 1];
    }

    const managed = isManaged(proc.pid);

    let type = "interactive";
    if (proc.command.includes("remote-control")) type = "remote-control";

    const resources = sumResources(proc.pid);

    // Walk ancestors to find the launching app
    const launchedBy = findAncestorApp(proc.pid, ppidMap);

    results.push({
      pid: parseInt(proc.pid),
      ppid: parseInt(proc.ppid),
      cwd,
      project,
      type,
      managed,
      uptime: formatEtime(proc.etime),
      cpu: Math.round(resources.cpu * 10) / 10,
      memMB: Math.round(resources.rss / 1024),
      launchedBy,
      command: proc.command,
      provider: proc.provider,
    });
  }

  return results;
}

/**
 * Walk the parent chain to find which app launched a process.
 * Looks for .app bundles or recognizable terminal names.
 */
function findAncestorApp(pid, ppidMap) {
  // Get comm for all processes in one shot
  let commMap;
  try {
    const lines = execSync('ps -eo pid,comm', { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim().split("\n");
    commMap = {};
    for (const line of lines) {
      const m = line.trim().match(/^(\d+)\s+(.+)$/);
      if (m) commMap[m[1]] = m[2];
    }
  } catch {
    return null;
  }

  let current = String(pid);
  for (let i = 0; i < 15; i++) {
    const parent = ppidMap[current];
    if (!parent || parent === "0" || parent === "1" || parent === current) break;
    const comm = commMap[parent] || "";

    // Match .app bundle path
    const appMatch = comm.match(/\/([^/]+)\.app\//);
    if (appMatch) return appMatch[1];

    current = parent;
  }
  return null;
}

/**
 * Parse ps etime format (e.g. "03:12", "1:03:12", "2-01:03:12") into human-readable string.
 */
function formatEtime(etime) {
  if (!etime) return null;
  // etime formats: "MM:SS", "HH:MM:SS", "D-HH:MM:SS"
  const dayMatch = etime.match(/^(\d+)-(\d+):(\d+):(\d+)$/);
  if (dayMatch) {
    const [, d, h, m] = dayMatch;
    const days = parseInt(d), hours = parseInt(h), mins = parseInt(m);
    const parts = [];
    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (mins) parts.push(`${mins}m`);
    return parts.join(" ") || "<1m";
  }
  const hmsMatch = etime.match(/^(\d+):(\d+):(\d+)$/);
  if (hmsMatch) {
    const [, h, m] = hmsMatch;
    const hours = parseInt(h), mins = parseInt(m);
    const parts = [];
    if (hours) parts.push(`${hours}h`);
    if (mins) parts.push(`${mins}m`);
    return parts.join(" ") || "<1m";
  }
  const msMatch = etime.match(/^(\d+):(\d+)$/);
  if (msMatch) {
    const mins = parseInt(msMatch[1]);
    return mins ? `${mins}m` : "<1m";
  }
  return etime;
}

function killProcess(pid) {
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

module.exports = { findClaudeProcesses, killProcess };
