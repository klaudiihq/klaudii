/**
 * Gemini A2A backend — manages one @google/gemini-cli-a2a-server process per
 * workspace and communicates via the standard A2A JSON-RPC 2.0 / SSE protocol.
 *
 * Drop-in replacement for the sendMessage / isActive / stopProcess surface of
 * lib/gemini.js.  All history/session/auth/model management stays in gemini.js.
 */

"use strict";

const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const path = require("path");
const crypto = require("crypto");

const LOG_PREFIX = "[gemini-a2a]";
function log(...args) { console.log(LOG_PREFIX, new Date().toISOString(), ...args); }
function logErr(...args) { console.error(LOG_PREFIX, new Date().toISOString(), ...args); }

// ─── Server state per workspace ──────────────────────────────────────────────
// workspace → { proc, port, taskId, contextId, killed, reqId }
const servers = new Map();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function uuid() {
  return crypto.randomUUID();
}

function findServerScript() {
  try {
    const pkgDir = path.dirname(require.resolve("@google/gemini-cli-a2a-server/package.json"));
    const script = path.join(pkgDir, "dist", "a2a-server.mjs");
    require("fs").accessSync(script);
    return script;
  } catch {
    return null;
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "localhost", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

// Poll /.well-known/agent-card.json until the server is accepting requests.
function waitForServer(port, maxMs = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    function attempt() {
      const req = http.get(
        { hostname: "localhost", port, path: "/.well-known/agent-card.json", timeout: 1000 },
        (res) => {
          res.resume();
          if (res.statusCode === 200) return resolve();
          retry();
        }
      );
      req.on("error", retry);
      req.on("timeout", () => { req.destroy(); retry(); });
    }
    function retry() {
      if (Date.now() - start >= maxMs) return reject(new Error(`A2A server on port ${port} did not start within ${maxMs}ms`));
      setTimeout(attempt, 250);
    }
    attempt();
  });
}

function httpPost(port, urlPath, body) {
  log(`httpPost port=${port} path=${urlPath} body=${JSON.stringify(body).slice(0, 200)}`);
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: "localhost",
      port,
      path: urlPath,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
      },
    };
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${e.message}. Body: ${data.slice(0, 200)}`)); }
      });
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

async function createTask(port, workspacePath, autoExecute = false) {
  const contextId = uuid();
  // POST /tasks returns the taskId string (201 Created)
  const taskId = await httpPost(port, "/tasks", {
    contextId,
    agentSettings: {
      kind: "agent-settings",
      workspacePath,
      autoExecute,
    },
  });
  if (typeof taskId !== "string") {
    throw new Error(`Unexpected /tasks response: ${JSON.stringify(taskId)}`);
  }
  return { taskId, contextId };
}

// ─── SSE streaming request ────────────────────────────────────────────────────

/**
 * POST / with JSON-RPC 2.0 message/stream.
 * Calls onEvent(a2aEvent) for each SSE data line.
 * Calls onEnd() when the HTTP response ends.
 * Returns the http.ClientRequest so the caller can destroy it.
 */
function streamMessage(port, taskId, contextId, requestId, message, onEvent, onEnd, onError) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: requestId,
    method: "message/stream",
    params: {
      message: {
        kind: "message",
        role: "user",
        parts: [{ kind: "text", text: message }],
        messageId: uuid(),
        taskId,
        contextId,
      },
    },
  });

  const options = {
    hostname: "localhost",
    port,
    path: "/",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
      "Content-Length": Buffer.byteLength(body),
    },
  };

  const req = http.request(options, (res) => {
    if (res.statusCode >= 400) {
      let errData = "";
      res.on("data", (c) => { errData += c; });
      res.on("end", () => onError(new Error(`message/stream HTTP ${res.statusCode}: ${errData.slice(0, 200)}`)));
      return;
    }

    let buf = "";
    res.on("data", (chunk) => {
      buf += chunk.toString();
      // Split on newlines, keep last incomplete line in buffer
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr) continue;
        try {
          const envelope = JSON.parse(jsonStr);
          if (envelope.result !== undefined) onEvent(envelope.result);
        } catch (e) {
          logErr("SSE parse error:", e.message, "raw:", jsonStr.slice(0, 200));
        }
      }
    });

    res.on("end", () => {
      // Flush any remaining buffer
      if (buf.startsWith("data: ")) {
        const jsonStr = buf.slice(6).trim();
        if (jsonStr) {
          try {
            const env = JSON.parse(jsonStr);
            if (env.result !== undefined) onEvent(env.result);
          } catch {}
        }
      }
      onEnd();
    });

    res.on("error", onError);
  });

  req.on("error", onError);
  req.write(body);
  req.end();
  return req;
}

// ─── A2A event → internal event mapping ──────────────────────────────────────

/**
 * Map an A2A status-update event to our internal event format.
 * Returns one of:
 *   { type: "message", role: "assistant", content: string }
 *   { type: "tool_use", tool_name, tool_id, parameters }
 *   { type: "tool_result", tool_id, status, output }
 *   { type: "status", message: string }
 *   { type: "result", exitCode: 0 }    ← turn complete
 *   null                               ← ignore
 */
function mapA2AEvent(event) {
  if (!event || event.kind !== "status-update") return null;

  const coderKind = event.metadata?.coderAgent?.kind;
  const coderMeta = event.metadata?.coderAgent ?? {};
  const status = event.status ?? {};
  const taskState = status.state;
  const parts = status.message?.parts ?? [];
  const text = parts.filter(p => p.kind === "text").map(p => p.text).join("") || "";

  log(`a2a-event kind=${coderKind || "(none)"} state=${taskState} final=${event.final} textLen=${text.length}`);
  log(`a2a-event-raw: ${JSON.stringify(event).slice(0, 500)}`);

  // Turn complete
  if (event.final && (taskState === "completed" || taskState === "input-required")) {
    // If there's final text that wasn't already streamed, we emit it before result.
    // We return an array signal — handled by the caller.
    return { type: "result", exitCode: 0, _finalText: text };
  }

  // Task failed
  if (event.final && taskState === "failed") {
    return { type: "error", message: text || "Gemini task failed" };
  }

  switch (coderKind) {
    case "text-content":
      if (text) return { type: "message", role: "assistant", content: text };
      return null;

    case "thought":
      if (text) return { type: "status", message: text };
      return null;

    case "tool-call-confirmation":
      return {
        type: "tool_use",
        tool_name: coderMeta.name || "tool",
        tool_id: coderMeta.callId || uuid(),
        call_id: coderMeta.callId,       // needed for approval response
        parameters: coderMeta.input || {},
        awaiting_approval: true,         // tells UI to show approve/deny buttons
      };

    case "tool-call-update": {
      const toolStatus = coderMeta.status || "";
      if (toolStatus === "succeeded" || toolStatus === "done") {
        return {
          type: "tool_result",
          tool_id: coderMeta.callId || coderMeta.name || uuid(),
          status: "success",
          output: String(coderMeta.result ?? ""),
        };
      }
      if (toolStatus === "failed") {
        return {
          type: "tool_result",
          tool_id: coderMeta.callId || coderMeta.name || uuid(),
          status: "error",
          output: String(coderMeta.result ?? "error"),
        };
      }
      // executing, validating, scheduled — emit as status
      if (coderMeta.name && toolStatus) {
        return { type: "status", message: `${coderMeta.name}: ${toolStatus}` };
      }
      return null;
    }

    case "state-change":
      // State transitions other than final completed are informational
      if (text) return { type: "status", message: text };
      return null;

    case "citation":
    case "agent-settings":
      return null;

    default:
      // Non-final text from status message (e.g. working state with text)
      if (!event.final && text) {
        return { type: "message", role: "assistant", content: text };
      }
      return null;
  }
}

// ─── Server lifecycle ─────────────────────────────────────────────────────────

async function ensureServer(workspace, workspacePath, config, opts) {
  const autoExecute = opts.autoExecute ?? false;
  const existing = servers.get(workspace);
  if (existing && !existing.killed) {
    if (existing.autoExecute !== autoExecute) {
      log(`autoExecute changed (${existing.autoExecute}→${autoExecute}), restarting server workspace=${workspace}`);
      stopProcess(workspace);
    } else {
      log(`reusing server workspace=${workspace} port=${existing.port}`);
      return existing;
    }
  }

  const serverScript = findServerScript();
  if (!serverScript) {
    throw new Error("@google/gemini-cli-a2a-server not installed. Run: npm install");
  }

  const port = await getFreePort();
  log(`spawning a2a-server workspace=${workspace} port=${port} script=${serverScript}`);

  const env = { ...process.env, CODER_AGENT_PORT: String(port) };
  if (opts.apiKey) env.GEMINI_API_KEY = opts.apiKey;
  else if (config?.geminiApiKey) env.GEMINI_API_KEY = config.geminiApiKey;
  else env.USE_CCPA = "1"; // fall back to OAuth (cached credentials from `gemini auth login`)

  const proc = spawn("node", [serverScript], {
    cwd: workspacePath,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  log(`a2a-server spawned pid=${proc.pid} workspace=${workspace}`);
  proc.stdout.on("data", (d) => log(`[pid=${proc.pid}] ${d.toString().trim()}`));
  proc.stderr.on("data", (d) => logErr(`[pid=${proc.pid}] ${d.toString().trim()}`));
  proc.on("close", (code) => {
    log(`server closed workspace=${workspace} pid=${proc.pid} code=${code}`);
    const entry = servers.get(workspace);
    if (entry && entry.proc === proc) {
      entry.killed = true;
      servers.delete(workspace);
    }
  });

  await waitForServer(port);
  log(`server ready workspace=${workspace} port=${port}`);

  const { taskId, contextId } = await createTask(port, workspacePath, opts.autoExecute ?? false);
  log(`task created workspace=${workspace} taskId=${taskId} contextId=${contextId}`);

  const entry = { proc, port, taskId, contextId, killed: false, reqId: 0, autoExecute };
  servers.set(workspace, entry);
  return entry;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Send a message to Gemini for a workspace via the A2A server.
 * Returns { onEvent, onDone, onError, kill } — same interface as gemini.startChat().
 */
function startChat(workspace, workspacePath, userMessage, config, opts = {}) {
  let eventCallback = null;
  let doneCallback = null;
  let errorCallback = null;
  const pendingEvents = [];
  let killed = false;
  let activeReq = null;

  function emit(ev) {
    if (!ev) return;
    if (eventCallback) eventCallback(ev);
    else pendingEvents.push(ev);
  }

  // Use setImmediate so caller can register callbacks before streaming starts
  setImmediate(async () => {
    try {
      const entry = await ensureServer(workspace, workspacePath, config, opts);
      if (killed) return;

      const requestId = ++entry.reqId;
      let finalEmitted = false;
      // Track text that was streamed incrementally so we don't double-emit on final
      let streamedText = "";

      activeReq = streamMessage(
        entry.port, entry.taskId, entry.contextId, requestId, userMessage,
        (a2aEvent) => {
          if (killed) return;
          const mapped = mapA2AEvent(a2aEvent);
          if (!mapped) return;

          if (mapped.type === "result") {
            // Emit any final text not yet streamed
            const finalText = mapped._finalText || "";
            if (finalText && finalText !== streamedText) {
              // Only emit the delta
              const delta = finalText.startsWith(streamedText)
                ? finalText.slice(streamedText.length)
                : finalText;
              if (delta) emit({ type: "message", role: "assistant", content: delta });
            }
            if (!finalEmitted) {
              finalEmitted = true;
              emit({ type: "result", exitCode: 0 });
              if (doneCallback) doneCallback({ code: 0 });
            }
          } else {
            if (mapped.type === "message" && mapped.role === "assistant") {
              streamedText += mapped.content || "";
            }
            emit(mapped);
          }
        },
        () => {
          // SSE stream ended without a final result event
          if (!finalEmitted && !killed) {
            finalEmitted = true;
            emit({ type: "result", exitCode: 0 });
            if (doneCallback) doneCallback({ code: 0 });
          }
        },
        (err) => {
          if (killed) return;
          logErr(`stream error workspace=${workspace}: ${err.message}`);
          if (errorCallback) errorCallback(err);
        }
      );
    } catch (err) {
      if (killed) return;
      logErr(`startChat error workspace=${workspace}: ${err.message}`);
      if (errorCallback) errorCallback(err);
    }
  });

  return {
    onEvent(cb) {
      eventCallback = cb;
      for (const ev of pendingEvents) cb(ev);
      pendingEvents.length = 0;
    },
    onDone(cb) { doneCallback = cb; },
    onError(cb) { errorCallback = cb; },
    kill() {
      killed = true;
      if (activeReq) { try { activeReq.destroy(); } catch {} }
      // Don't stop the server — it stays alive for the next turn
    },
  };
}

function isActive(workspace) {
  const entry = servers.get(workspace);
  return !!(entry && !entry.killed);
}

function stopProcess(workspace) {
  const entry = servers.get(workspace);
  if (entry && !entry.killed) {
    entry.killed = true;
    log(`stopping server workspace=${workspace} pid=${entry.proc.pid}`);
    try { process.kill(-entry.proc.pid, "SIGKILL"); } catch {
      try { entry.proc.kill("SIGKILL"); } catch {}
    }
    servers.delete(workspace);
  }
}

function stopAllProcesses() {
  for (const workspace of [...servers.keys()]) {
    stopProcess(workspace);
  }
}

async function confirmToolCall(workspace, callId, outcome = "proceed_once") {
  const entry = servers.get(workspace);
  if (!entry) throw new Error(`No active server for workspace: ${workspace}`);
  return httpPost(entry.port, `/tasks/${entry.taskId}/confirm`, { callId, outcome });
}

module.exports = {
  startChat,
  isActive,
  stopProcess,
  stopAllProcesses,
  confirmToolCall,
};
