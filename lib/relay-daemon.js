#!/usr/bin/env node
/**
 * lib/relay-daemon.js — per-workspace Claude relay daemon.
 *
 * Spawned detached by claude-chat.js; outlives server restarts.
 * Manages one Claude subprocess, buffers all raw JSONL events to an
 * append-only log file, and serves them over a Unix socket.
 *
 * Protocol (server ↔ relay, newline-delimited JSON):
 *   relay → server:  raw Claude JSONL lines, then {"type":"relay_replay_end"}
 *                    sentinel once all historical events have been sent,
 *                    then live events as they arrive.
 *                    Final: {"type":"relay_exit","code":N}
 *   server → relay:  raw JSONL lines forwarded verbatim to Claude's stdin
 *                    (control_response, tool_result, additional user messages)
 *
 * Env vars (all required unless noted):
 *   RELAY_SOCKET      — Unix socket path
 *   RELAY_LOG         — append-only raw event log path
 *   RELAY_PID         — path to write our own PID
 *   RELAY_BIN         — path to claude binary
 *   RELAY_ARGS        — JSON array of CLI args
 *   RELAY_CWD         — working directory for Claude
 *   RELAY_APIKEY      — (optional) ANTHROPIC_API_KEY override
 *   RELAY_INIT_FILE   — (optional) file with initial stdin message; consumed + deleted
 *   RELAY_CLOSE_STDIN — "1" to close Claude stdin after init (bypassPermissions mode)
 */

const net = require("net");
const { spawn } = require("child_process");
const readline = require("readline");
const fs = require("fs");

const {
  RELAY_SOCKET: SOCKET,
  RELAY_LOG: LOG,
  RELAY_PID: PID_FILE,
  RELAY_BIN: BIN,
  RELAY_ARGS: ARGS_JSON,
  RELAY_CWD: CWD,
  RELAY_APIKEY: API_KEY,
  RELAY_INIT_FILE: INIT_FILE,
  RELAY_CLOSE_STDIN: CLOSE_STDIN_ENV,
} = process.env;

const ARGS = JSON.parse(ARGS_JSON || "[]");
const CLOSE_STDIN = CLOSE_STDIN_ENV === "1";

if (!SOCKET || !LOG || !PID_FILE || !BIN) {
  process.stderr.write("[relay] missing required env vars\n");
  process.exit(1);
}

// Write PID so the server can check if we're alive
fs.writeFileSync(PID_FILE, String(process.pid));

// Remove stale socket from a previous run
try { fs.unlinkSync(SOCKET); } catch {}

const clients = new Set();

function broadcast(line) {
  const msg = line + "\n";
  for (const c of clients) { try { c.write(msg); } catch {} }
}

// --- Spawn Claude ---

const env = { ...process.env };
delete env.CLAUDECODE;
// Strip relay env vars so Claude doesn't inherit them
[
  "RELAY_SOCKET", "RELAY_LOG", "RELAY_PID", "RELAY_BIN", "RELAY_ARGS",
  "RELAY_CWD", "RELAY_APIKEY", "RELAY_INIT_FILE", "RELAY_CLOSE_STDIN",
].forEach(k => delete env[k]);
if (API_KEY) env.ANTHROPIC_API_KEY = API_KEY;

const proc = spawn(BIN, ARGS, { cwd: CWD, env, stdio: ["pipe", "pipe", "pipe"] });
process.stderr.write(`[relay] spawned claude pid=${proc.pid} workspace=${CWD}\n`);

// Send initial message and optionally close stdin
if (INIT_FILE) {
  try {
    const msg = fs.readFileSync(INIT_FILE, "utf-8");
    proc.stdin.write(msg);
    fs.unlinkSync(INIT_FILE);
  } catch (e) {
    process.stderr.write(`[relay] init file error: ${e.message}\n`);
  }
}
if (CLOSE_STDIN) proc.stdin.end();

// --- Event log ---

const logStream = fs.createWriteStream(LOG, { flags: "a" });

// Read Claude stdout → append to log → broadcast to socket clients
const rl = readline.createInterface({ input: proc.stdout });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  logStream.write(t + "\n");
  broadcast(t);
});

proc.stderr.on("data", (d) => {
  const t = d.toString().trim();
  if (t) process.stderr.write(`[relay] claude stderr: ${t.slice(0, 300)}\n`);
});

proc.on("close", (code) => {
  process.stderr.write(`[relay] claude exited code=${code}\n`);
  logStream.end(() => {
    broadcast(JSON.stringify({ type: "relay_exit", code }));
    setTimeout(() => {
      try { fs.unlinkSync(SOCKET); } catch {}
      try { fs.unlinkSync(PID_FILE); } catch {}
      process.exit(0);
    }, 1000);
  });
});

// --- Unix socket server ---

const server = net.createServer((socket) => {
  clients.add(socket);

  // Replay all historical events so the server can catch up
  try {
    const hist = fs.readFileSync(LOG, "utf-8");
    for (const line of hist.split("\n")) {
      const t = line.trim();
      if (t) socket.write(t + "\n");
    }
  } catch {}

  // Sentinel: the server knows replay is done and live events follow
  socket.write(JSON.stringify({ type: "relay_replay_end" }) + "\n");

  // Forward input from server → Claude stdin (interactive modes)
  if (!CLOSE_STDIN) {
    const rl2 = readline.createInterface({ input: socket });
    rl2.on("line", (line) => {
      const t = line.trim();
      if (t) { try { proc.stdin.write(t + "\n"); } catch {} }
    });
  }

  socket.on("close", () => clients.delete(socket));
  socket.on("error", () => clients.delete(socket));
});

server.listen(SOCKET, () => {
  process.stderr.write(`[relay] listening on ${SOCKET}\n`);
});

server.on("error", (e) => {
  process.stderr.write(`[relay] socket error: ${e.message}\n`);
  process.exit(1);
});

// Clean exit on signal
process.on("SIGTERM", () => { try { proc.kill("SIGTERM"); } catch {} process.exit(0); });
process.on("SIGINT",  () => { try { proc.kill("SIGTERM"); } catch {} process.exit(0); });
