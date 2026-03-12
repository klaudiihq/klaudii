/**
 * Gemini A2A backend — manages one @google/gemini-cli-a2a-server process per
 * workspace and communicates via the standard A2A JSON-RPC 2.0 / SSE protocol.
 *
 * Drop-in replacement for the sendMessage / isActive / stopProcess surface of
 * lib/gemini.js.  All history/session/auth/model management stays in gemini.js.
 */

"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const crypto = require("crypto");
const { CHATS_DIR } = require("./paths");

const LOG_PREFIX = "[gemini-a2a]";
const DEBUG = !!process.env.A2A_DEBUG;
function log(...args) { console.log(LOG_PREFIX, new Date().toISOString(), ...args); }
function logErr(...args) { console.error(LOG_PREFIX, new Date().toISOString(), ...args); }
function dbg(...args) { if (DEBUG) console.log(LOG_PREFIX, "[DBG]", new Date().toISOString(), ...args); }

// Raw A2A event log — one JSON line per event, written alongside the chat history.
// Path: ~/.klaudii/data/chats/stream-gemini-a2a-{workspace}.jsonl
function rawLogPath(workspace) {
  return path.join(CHATS_DIR, `stream-gemini-a2a-${workspace}.jsonl`);
}
function appendRawLog(workspace, event) {
  try {
    fs.appendFileSync(rawLogPath(workspace), JSON.stringify(event) + "\n");
  } catch { /* non-fatal */ }
  dbg(`<< a2a-event workspace=${workspace}`, JSON.stringify(event));
}

// ─── Server state per workspace ──────────────────────────────────────────────
// workspace → { proc, port, taskId, contextId, killed, reqId, agent }
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

function httpPost(port, urlPath, body, agent) {
  log(`httpPost port=${port} path=${urlPath} body=${JSON.stringify(body).slice(0, 200)}`);
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: "localhost",
      port,
      path: urlPath,
      method: "POST",
      agent: agent || false,
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
/**
 * Send a message/stream JSON-RPC request with arbitrary parts array.
 * Returns the http.ClientRequest.
 */
function streamParts(port, taskId, contextId, requestId, parts, onEvent, onEnd, onError, agent) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: requestId,
    method: "message/stream",
    params: {
      message: {
        kind: "message",
        role: "user",
        parts,
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
    // keepAlive agent prevents Node.js from half-closing (TCP FIN) the socket
    // after req.end(). Without this, the A2A server fires socket 'end', which
    // triggers abortController.abort() and kills tool execution mid-stream.
    agent: agent || false,
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
      dbg(`<< SSE stream ended port=${port} taskId=${taskId} reqId=${requestId}`);
      onEnd();
    });

    res.on("error", onError);
  });

  dbg(`>> message/stream port=${port} taskId=${taskId} reqId=${requestId}`, body);
  req.on("error", onError);
  req.write(body);
  req.end();
  return req;
}

function streamMessage(port, taskId, contextId, requestId, message, onEvent, onEnd, onError, agent) {
  return streamParts(port, taskId, contextId, requestId,
    [{ kind: "text", text: message }],
    onEvent, onEnd, onError, agent);
}

/**
 * Resubscribe to an existing task's event stream without sending a new message.
 * Used after a confirmation stream ends with input-required to drain buffered events
 * (e.g. the next tool-call-confirmation that the server queued before closing the stream).
 */
function streamResubscribe(port, taskId, requestId, onEvent, onEnd, onError, agent) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: requestId,
    method: "tasks/resubscribe",
    params: { id: taskId },
  });

  const options = {
    hostname: "localhost",
    port,
    path: "/",
    method: "POST",
    agent: agent || false,
    headers: {
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
      "Content-Length": Buffer.byteLength(body),
    },
  };

  dbg(`>> tasks/resubscribe port=${port} taskId=${taskId} reqId=${requestId}`);

  const req = http.request(options, (res) => {
    if (res.statusCode >= 400) {
      let errData = "";
      res.on("data", (c) => { errData += c; });
      res.on("end", () => onError(new Error(`tasks/resubscribe HTTP ${res.statusCode}: ${errData.slice(0, 200)}`)));
      return;
    }

    let buf = "";
    res.on("data", (chunk) => {
      buf += chunk.toString();
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
          logErr("resubscribe SSE parse error:", e.message, "raw:", jsonStr.slice(0, 200));
        }
      }
    });

    res.on("end", () => {
      if (buf.startsWith("data: ")) {
        const jsonStr = buf.slice(6).trim();
        if (jsonStr) {
          try {
            const env = JSON.parse(jsonStr);
            if (env.result !== undefined) onEvent(env.result);
          } catch {}
        }
      }
      dbg(`<< tasks/resubscribe stream ended port=${port} taskId=${taskId} reqId=${requestId}`);
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
 *
 * A2A event structure:
 *   event.metadata.coderAgent.kind  — event type ("tool-call-confirmation", etc.)
 *   event.status.message.parts[]    — actual payload; tool events use kind="data"
 *   parts[0].data.request           — tool request (name, callId, args)
 *   parts[0].data.status            — tool status ("executing", "success", "failed", ...)
 *   parts[0].data.result            — tool result (callId, name, response.output)
 *   parts[0].data.resultDisplay     — plain-text result for display
 *
 * @param {object} event  Raw A2A status-update event
 * @param {object} ctx    Context: { autoExecute, emittedResults }
 *   autoExecute   — true when server auto-approves (YOLO mode); skip approval UI
 *   emittedResults — Set of callIds already emitted as tool_result (dedup guard)
 */
function mapA2AEvent(event, ctx = {}) {
  if (!event || event.kind !== "status-update") return null;

  const coderKind = event.metadata?.coderAgent?.kind;
  const status = event.status ?? {};
  const taskState = status.state;
  const parts = status.message?.parts ?? [];
  const text = parts.filter(p => p.kind === "text").map(p => p.text).join("") || "";
  // Data payload for tool/thought events (parts with kind="data")
  const partData = parts.find(p => p.kind === "data")?.data ?? {};

  log(`a2a-event kind=${coderKind || "(none)"} state=${taskState} final=${event.final} textLen=${text.length}`);

  // Turn complete
  if (event.final && (taskState === "completed" || taskState === "input-required")) {
    return { type: "result", exitCode: 0, _finalText: text, _taskState: taskState };
  }

  // Task failed
  if (event.final && taskState === "failed") {
    return { type: "error", message: text || "Gemini task failed" };
  }

  switch (coderKind) {
    case "text-content":
      if (text) return { type: "message", role: "assistant", content: text };
      return null;

    case "thought": {
      // Thought text is in partData.description (with partData.subject as title)
      const thoughtText = text || partData.description || partData.subject || "";
      if (thoughtText) return { type: "status", message: thoughtText };
      return null;
    }

    case "tool-call-confirmation": {
      // The confirmation prompt shown to the user before auto-approve or manual approval.
      // All tool info is in partData.request (not in coderMeta).
      const req = partData.request ?? {};
      const rawName = req.name || partData.tool?.name || "tool";
      // Normalize Gemini's ask_user → AskUserQuestion so history rendering regexes match.
      const toolName = rawName === "ask_user" ? "AskUserQuestion" : rawName;
      const callId = req.callId || uuid();
      const result = {
        type: "tool_use",
        tool_name: toolName,
        tool_id: callId,
        call_id: callId,
        parameters: req.args || {},
      };
      // Only request approval UI when the A2A server actually waits for a response.
      // In autoExecute mode the server approves immediately — just show a tool pill.
      if (!ctx.autoExecute) result.awaiting_approval = true;
      return result;
    }

    case "tool-call-update": {
      // partData.status drives the lifecycle: awaiting_approval → scheduled → executing → success/failed
      const toolStatus = partData.status || "";
      const toolName = partData.result?.name || partData.request?.name || partData.tool?.name || "";
      const callId = partData.result?.callId || partData.request?.callId || uuid();

      if (toolStatus === "success" || toolStatus === "failed" || toolStatus === "error") {
        // Deduplicate: the A2A server can fire success multiple times for one callId.
        if (ctx.emittedResults?.has(callId)) return null;
        ctx.emittedResults?.add(callId);

        const isErr = toolStatus === "failed" || toolStatus === "error";
        // Output can be in multiple places depending on A2A server version:
        // - partData.response.responseParts[0].functionResponse.response.output (observed in the wild)
        // - partData.result.response.output (spec)
        const rpOutput = partData.response?.responseParts?.[0]?.functionResponse?.response?.output;
        const output = rpOutput ?? partData.result?.response?.output ?? partData.resultDisplay ?? "";
        return {
          type: "tool_result",
          tool_id: callId,
          status: isErr ? "error" : "success",
          output: String(output || (isErr ? "tool failed" : "")),
        };
      }
      // Intermediate states: emit as status so the UI shows progress
      if (toolName && toolStatus && toolStatus !== "awaiting_approval") {
        return { type: "status", message: `${toolName}: ${toolStatus}` };
      }
      return null;
    }

    case "state-change":
      if (text) return { type: "status", message: text };
      return null;

    case "citation":
    case "agent-settings":
      return null;

    default:
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
  let stderrBuf = "";
  proc.stderr.on("data", (d) => {
    const s = d.toString();
    stderrBuf += s;
    logErr(`[pid=${proc.pid}] ${s.trim()}`);
  });

  // Reject early if the server process dies before becoming ready
  let earlyExitReject = null;
  const earlyExitPromise = new Promise((_, reject) => { earlyExitReject = reject; });

  proc.on("close", (code) => {
    log(`server closed workspace=${workspace} pid=${proc.pid} code=${code}`);
    const entry = servers.get(workspace);
    if (entry && entry.proc === proc) {
      entry.killed = true;
      servers.delete(workspace);
    }
    if (earlyExitReject) {
      const isAuth = stderrBuf.includes("Failed to load credentials") ||
                     stderrBuf.includes("Opening authentication page") ||
                     stderrBuf.includes("not authenticated");
      const err = new Error(isAuth
        ? "not authenticated with Gemini — please log in"
        : `A2A server exited unexpectedly (code ${code})`);
      if (isAuth) err.isAuthError = true;
      earlyExitReject(err);
    }
  });

  try {
    await Promise.race([waitForServer(port), earlyExitPromise]);
  } catch (err) {
    earlyExitReject = null;
    try { proc.kill("SIGTERM"); } catch {}
    throw err;
  }
  earlyExitReject = null; // server is ready, disable early-exit detection

  log(`server ready workspace=${workspace} port=${port}`);

  const { taskId, contextId } = await createTask(port, workspacePath, opts.autoExecute ?? false);
  log(`task created workspace=${workspace} taskId=${taskId} contextId=${contextId}`);

  // keepAlive agent: prevents Node.js from sending TCP FIN after req.end(),
  // which would trigger the A2A server's socket 'end' handler and abort execution.
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const entry = { proc, port, taskId, contextId, killed: false, reqId: 0, autoExecute, agent };
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
  // Per-turn context for mapA2AEvent
  const mapCtx = { autoExecute: opts.autoExecute ?? false, emittedResults: new Set() };

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
      mapCtx.emittedResults = new Set(); // reset per-turn dedup

      activeReq = streamMessage(
        entry.port, entry.taskId, entry.contextId, requestId, userMessage,
        (a2aEvent) => {
          if (killed) return;
          appendRawLog(workspace, a2aEvent);
          const mapped = mapA2AEvent(a2aEvent, mapCtx);
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
        },
        entry.agent
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
    if (entry.agent) { try { entry.agent.destroy(); } catch {} }
    servers.delete(workspace);
  }
}

function stopAllProcesses() {
  for (const workspace of [...servers.keys()]) {
    stopProcess(workspace);
  }
}

/**
 * Send a tool confirmation back to the A2A server.
 * Confirmations are sent as a data part in a new message/stream request —
 * there is no separate /confirm endpoint.
 *
 * Returns { onEvent, onDone, onError } — caller subscribes and broadcasts
 * events (tool execution continues after approval, firing new A2A events).
 *
 * Valid outcomes: proceed_once | proceed_always_tool | proceed_always | cancel
 */
function confirmToolCall(workspace, callId, outcome = "proceed_once", answer = null) {
  const entry = servers.get(workspace);
  if (!entry) throw new Error(`No active server for workspace: ${workspace}`);

  let eventCallback = null;
  let doneCallback = null;
  let errorCallback = null;
  const pendingEvents = [];
  let finalEmitted = false;
  const mapCtx = { autoExecute: entry.autoExecute, emittedResults: new Set() };

  function emit(ev) {
    if (!ev) return;
    if (eventCallback) eventCallback(ev);
    else pendingEvents.push(ev);
  }

  const requestId = ++entry.reqId;
  log(`confirmToolCall workspace=${workspace} callId=${callId} outcome=${outcome} reqId=${requestId}`);

  function handleEvent(a2aEvent) {
    appendRawLog(workspace, a2aEvent);
    const mapped = mapA2AEvent(a2aEvent, mapCtx);
    if (!mapped) return;
    if (mapped.type === "result") {
      if (mapped._taskState === "input-required" && !finalEmitted) {
        // Another tool needs confirmation — resubscribe to pick up its events.
        // Don't fire onDone yet; the UI will show the next tool-call-confirmation.
        log(`confirmToolCall resubscribing after input-required workspace=${workspace}`);
        streamResubscribe(entry.port, entry.taskId, ++entry.reqId, handleEvent, handleEnd, handleError, entry.agent);
      } else if (!finalEmitted) {
        finalEmitted = true;
        emit({ type: "result", exitCode: 0 });
        if (doneCallback) doneCallback({ code: 0 });
      }
    } else {
      emit(mapped);
    }
  }

  function handleEnd() {
    // Stream ended without a final result event — fire done if not already
    if (!finalEmitted) {
      finalEmitted = true;
      emit({ type: "result", exitCode: 0 });
      if (doneCallback) doneCallback({ code: 0 });
    }
  }

  function handleError(err) {
    logErr(`confirmToolCall stream error workspace=${workspace}: ${err.message}`);
    if (errorCallback) errorCallback(err);
  }

  const parts = [{ kind: "data", data: { callId, outcome } }];
  if (answer) parts.unshift({ kind: "text", text: String(answer) });
  streamParts(
    entry.port, entry.taskId, entry.contextId, requestId,
    parts,
    handleEvent, handleEnd, handleError, entry.agent
  );

  return {
    onEvent(cb) {
      eventCallback = cb;
      for (const ev of pendingEvents) cb(ev);
      pendingEvents.length = 0;
    },
    onDone(cb) { doneCallback = cb; },
    onError(cb) { errorCallback = cb; },
  };
}

module.exports = {
  startChat,
  isActive,
  stopProcess,
  stopAllProcesses,
  confirmToolCall,
};
