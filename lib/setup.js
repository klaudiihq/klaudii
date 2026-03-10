"use strict";

const { execSync, spawn } = require("child_process");

// ---------------------------------------------------------------------------
// Dependency manifest
// order matters — brew must be first
// ---------------------------------------------------------------------------
const IS_MAC = process.platform === "darwin";

const DEPS = [
  ...(IS_MAC ? [{ id: "brew", label: "Homebrew", bin: "brew", install: null }] : []),
  { id: "tmux",   label: "tmux",        bin: "tmux",   install: IS_MAC ? { cmd: "brew", args: ["install", "tmux"] } : null },
  { id: "ttyd",   label: "ttyd",        bin: "ttyd",   install: IS_MAC ? { cmd: "brew", args: ["install", "ttyd"] } : null },
  { id: "gh",     label: "GitHub CLI",  bin: "gh",     install: IS_MAC ? { cmd: "brew", args: ["install", "gh"] } : null },
  { id: "claude", label: "Claude Code", bin: "claude", install: { cmd: "npm", args: ["install", "-g", "@anthropic-ai/claude-code"] } },
];

const BREW_PATH = "/opt/homebrew/bin:/usr/local/bin";
const CHECK_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let depStatus   = {};   // { [id]: boolean }
let limpMode    = true;
let installing  = false;
let currentDep  = null; // id of dep currently being installed
let logRing     = [];   // recent install output lines (ring buffer)
const LOG_MAX   = 300;
let sseClients  = [];   // live SSE response objects
let _checkTimer = null;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
function which(bin) {
  try {
    execSync(`which ${bin}`, {
      stdio: "pipe",
      env: { ...process.env, PATH: `${BREW_PATH}:${process.env.PATH}` },
    });
    return true;
  } catch {
    return false;
  }
}

function pushLog(text) {
  logRing.push(text);
  if (logRing.length > LOG_MAX) logRing.shift();
}

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients = sseClients.filter((res) => {
    try { res.write(msg); return true; } catch { return false; }
  });
}

// ---------------------------------------------------------------------------
// Dep check (also called on the periodic timer)
// ---------------------------------------------------------------------------
function checkDeps() {
  const prev = limpMode;
  for (const dep of DEPS) {
    depStatus[dep.id] = which(dep.bin);
  }
  const missing = DEPS.filter((d) => !depStatus[d.id]);
  limpMode = missing.length > 0;

  // If we just became healthy, tell any open clients
  if (prev && !limpMode) {
    broadcast("ready", { message: "All dependencies installed — reloading." });
  }

  return missing;
}

// ---------------------------------------------------------------------------
// Install loop (runs once; clients watch via SSE)
// ---------------------------------------------------------------------------
async function installMissing() {
  if (installing) return;
  installing = true;

  const missing = checkDeps();

  for (const dep of missing) {
    if (!dep.install) {
      // brew itself can't be auto-installed
      broadcast("depStatus", { id: dep.id, status: "error", label: dep.label,
        message: "Homebrew must be installed first. Visit https://brew.sh" });
      continue;
    }

    currentDep = dep.id;
    broadcast("depStatus", { id: dep.id, status: "installing", label: dep.label });

    await new Promise((resolve) => {
      const proc = spawn(dep.install.cmd, dep.install.args, {
        env: { ...process.env, PATH: `${BREW_PATH}:${process.env.PATH}`, HOMEBREW_NO_AUTO_UPDATE: "1" },
      });

      const onData = (chunk) => {
        const text = chunk.toString();
        pushLog(text);
        broadcast("output", { dep: dep.id, text });
      };

      proc.stdout.on("data", onData);
      proc.stderr.on("data", onData);

      proc.on("close", (code) => {
        const ok = code === 0 && which(dep.bin);
        depStatus[dep.id] = ok;
        broadcast("depStatus", { id: dep.id, status: ok ? "done" : "error", label: dep.label, code });
        resolve();
      });
    });
  }

  currentDep = null;
  installing = false;
  checkDeps(); // recompute limpMode
}

// ---------------------------------------------------------------------------
// SSE client registration
// ---------------------------------------------------------------------------
function addSseClient(req, res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Immediately send current state so the page can render without waiting
  res.write(`event: state\ndata: ${JSON.stringify({
    depStatus,
    limpMode,
    currentDep,
    installing,
    log: logRing.join(""),
  })}\n\n`);

  sseClients.push(res);

  req.on("close", () => {
    sseClients = sseClients.filter((c) => c !== res);
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
function start() {
  checkDeps();

  _checkTimer = setInterval(() => {
    const wasLimp = limpMode;
    checkDeps();
    if (!wasLimp && limpMode) {
      // A dep disappeared — tell clients
      broadcast("limpMode", { depStatus, message: "A dependency went missing." });
    }
  }, CHECK_INTERVAL_MS);

  return { limpMode };
}

function getStatus() {
  return { depStatus, limpMode, currentDep, installing };
}

module.exports = { start, checkDeps, installMissing, addSseClient, getStatus,
  get limpMode() { return limpMode; } };
