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

// --- Logging ---
// All relay logs go to stderr (captured to daemon.stderr by the spawner).
// Always verbose so customer issues are diagnosable without code changes.
function rlog(...args) { process.stderr.write(`[relay] ${args.join(" ")}\n`); }

if (!SOCKET || !LOG || !PID_FILE || !BIN) {
  rlog("FATAL: missing required env vars", JSON.stringify({ SOCKET, LOG, PID_FILE, BIN }));
  process.exit(1);
}

// Write PID so the server can check if we're alive
fs.writeFileSync(PID_FILE, String(process.pid));

// Remove stale socket from a previous run
try { fs.unlinkSync(SOCKET); } catch {}

const clients = new Set();
let claudeAlive = true;
const stderrLines = []; // Accumulate non-JSON stderr for relay_exit

function broadcast(line) {
  const msg = line + "\n";
  for (const c of clients) {
    try { c.write(msg); } catch (e) { rlog(`broadcast write error: ${e.message}`); clients.delete(c); }
  }
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

rlog(`spawning claude bin=${BIN} cwd=${CWD} args=${ARGS.join(" ")}`);

const proc = spawn(BIN, ARGS, { cwd: CWD, env, stdio: ["pipe", "pipe", "pipe"] });
proc.stdin.on("error", (e) => rlog(`stdin error (suppressed): ${e.message}`));
rlog(`spawned claude pid=${proc.pid}`);

// Send initial message and optionally close stdin
if (INIT_FILE) {
  try {
    const msg = fs.readFileSync(INIT_FILE, "utf-8");
    rlog(`writing init message (${msg.length} bytes)`);
    proc.stdin.write(msg, (err) => {
      if (err) rlog(`init write callback error: ${err.message}`);
    });
    fs.unlinkSync(INIT_FILE);
  } catch (e) {
    rlog(`init file error: ${e.message}`);
  }
}
if (CLOSE_STDIN) { proc.stdin.end(); rlog("stdin closed (bypassPermissions)"); }

// --- Event log ---

const logStream = fs.createWriteStream(LOG, { flags: "a" });
let eventCount = 0;

// Claude CLI writes stream-json to stderr. Read both stdout and stderr,
// treating any valid JSON line as an event.
function handleLine(line, isStderr) {
  const t = line.trim();
  if (!t) return;
  // Only log+broadcast valid JSON (skip human-readable stderr noise)
  try { JSON.parse(t); } catch {
    rlog(`claude non-json: ${t.slice(0, 300)}`);
    if (isStderr) stderrLines.push(t);
    return;
  }
  eventCount++;
  if (eventCount <= 3) rlog(`event #${eventCount}: ${t.slice(0, 200)}`);
  logStream.write(t + "\n");
  broadcast(t);
}

const rlOut = readline.createInterface({ input: proc.stdout });
rlOut.on("line", (line) => handleLine(line, false));

const rlErr = readline.createInterface({ input: proc.stderr });
rlErr.on("line", (line) => handleLine(line, true));

proc.on("close", (code) => {
  claudeAlive = false;
  rlog(`claude exited code=${code} events=${eventCount}`);
  logStream.end(() => {
    broadcast(JSON.stringify({ type: "relay_exit", code, stderr: stderrLines.join("\n") }));
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
  rlog(`client connected (total=${clients.size})`);

  // Replay all historical events so the server can catch up
  try {
    const hist = fs.readFileSync(LOG, "utf-8");
    const lines = hist.split("\n").filter(l => l.trim());
    rlog(`replaying ${lines.length} events to new client`);
    for (const line of lines) {
      socket.write(line.trim() + "\n");
    }
  } catch (e) {
    rlog(`replay error: ${e.message}`);
  }

  // Sentinel: the server knows replay is done and live events follow
  socket.write(JSON.stringify({ type: "relay_replay_end" }) + "\n");

  // Forward input from server → Claude stdin (interactive modes)
  if (!CLOSE_STDIN) {
    const rl2 = readline.createInterface({ input: socket });
    rl2.on("line", (line) => {
      const t = line.trim();
      if (t) {
        if (!claudeAlive) {
          rlog(`stdin fwd REJECTED (claude dead): ${t.slice(0, 200)}`);
          try { socket.write(JSON.stringify({ type: "relay_stdin_error", error: "claude process has exited" }) + "\n"); } catch {}
          return;
        }
        rlog(`stdin fwd: ${t.slice(0, 200)}`);
        try { proc.stdin.write(t + "\n"); } catch (e) {
          rlog(`stdin write error: ${e.message}`);
          try { socket.write(JSON.stringify({ type: "relay_stdin_error", error: e.message }) + "\n"); } catch {}
        }
      }
    });
  }

  socket.on("close", () => { clients.delete(socket); rlog(`client disconnected (total=${clients.size})`); });
  socket.on("error", (e) => { clients.delete(socket); rlog(`client socket error: ${e.message}`); });
});

server.listen(SOCKET, () => {
  rlog(`listening on ${SOCKET}`);
});

// Heartbeat: broadcast a ping every 15s so clients can detect a hung relay
const heartbeatInterval = setInterval(() => {
  broadcast(JSON.stringify({ type: "relay_heartbeat" }));
}, 15000);
heartbeatInterval.unref();

// If Claude crashes, clean up and exit
proc.on("error", (err) => {
  rlog(`claude spawn error: ${err.message}`);
  try { fs.unlinkSync(SOCKET); } catch {}
  try { fs.unlinkSync(PID_FILE); } catch {}
  process.exit(1);
});

// Log unexpected errors but do NOT exit — only Claude exiting or a fatal
// server error (e.g. port in use) should kill the daemon. Random EPIPE,
// socket errors, etc. are benign and should just get logged.
process.on("uncaughtException", (err) => {
  rlog(`uncaught exception (non-fatal): ${err.message}\n${err.stack}`);
});
process.on("unhandledRejection", (err) => {
  rlog(`unhandled rejection (non-fatal): ${err}`);
});
