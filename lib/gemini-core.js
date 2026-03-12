/**
 * Gemini Core Driver — direct integration with @google/gemini-cli-core.
 *
 * Replaces gemini-a2a.js. Instead of spawning a separate A2A HTTP server
 * process, this module imports gemini-cli-core directly and runs the
 * GeminiClient + CoreToolScheduler in-process. This gives us full access
 * to Config, ToolRegistry, slash command functions, settings, etc.
 *
 * Exports match gemini-a2a.js interface: startChat, isActive, stopProcess,
 * stopAllProcesses, confirmToolCall, getActiveServerInfo, executeCommand.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { CHATS_DIR } = require("./paths");

const os = require("os");

const LOG_PREFIX = "[gemini-core]";
const DEBUG = !!process.env.GEMINI_CORE_DEBUG;
function log(...args) { console.log(LOG_PREFIX, new Date().toISOString(), ...args); }
function logErr(...args) { console.error(LOG_PREFIX, new Date().toISOString(), ...args); }
function dbg(...args) { if (DEBUG) console.log(LOG_PREFIX, "[DBG]", ...args); }

const GEMINI_DIR = path.join(os.homedir(), ".gemini");

/** Check if OAuth creds exist from `gemini login`. */
function hasOAuthCreds() {
  try {
    const credsPath = path.join(GEMINI_DIR, "oauth_creds.json");
    if (!fs.existsSync(credsPath)) return false;
    const creds = JSON.parse(fs.readFileSync(credsPath, "utf-8"));
    return !!(creds.refresh_token || creds.access_token);
  } catch {
    return false;
  }
}

// --- ESM dynamic import cache ---
let _core = null;
let _a2aConfig = null;
let _uiTelemetry = null;

async function getCore() {
  if (!_core) {
    _core = await import("@google/gemini-cli-core");
  }
  return _core;
}

async function getUiTelemetry() {
  if (!_uiTelemetry) {
    _uiTelemetry = await import("@google/gemini-cli-core/dist/src/telemetry/uiTelemetry.js");
  }
  return _uiTelemetry;
}

async function getA2AConfig() {
  if (!_a2aConfig) {
    _a2aConfig = await import("@google/gemini-cli-a2a-server/dist/src/config/config.js");
  }
  return _a2aConfig;
}

async function getA2ASettings() {
  return import("@google/gemini-cli-a2a-server/dist/src/config/settings.js");
}

// --- Raw event log ---
function rawLogPath(workspace, sessionNum) {
  const suffix = sessionNum != null ? `-${sessionNum}` : "";
  return path.join(CHATS_DIR, `stream-gemini-core-${workspace}${suffix}.jsonl`);
}

function appendRawLog(workspace, sessionNum, event) {
  try {
    fs.mkdirSync(CHATS_DIR, { recursive: true });
    fs.appendFileSync(rawLogPath(workspace, sessionNum), JSON.stringify(event) + "\n");
  } catch (e) {
    dbg("appendRawLog error:", e.message);
  }
}

// --- Two-level session Map ---
// workspace → Map<sessionNum, SessionEntry>
const sessions = new Map();

/**
 * @typedef {Object} SessionEntry
 * @property {object} config - Config instance from gemini-cli-core
 * @property {object} client - GeminiClient from config.getGeminiClient()
 * @property {object} scheduler - CoreToolScheduler
 * @property {AbortController|null} abortController - for current turn
 * @property {Map} pendingConfirms - Map<callId, confirmationDetails>
 * @property {boolean} killed
 * @property {number} promptCount
 * @property {boolean} autoExecute
 * @property {Function|null} activeEventCallback - callback for events from the running turn
 * @property {string} workspace
 * @property {number} sessionNum
 */

function getSession(workspace, sessionNum) {
  const wsMap = sessions.get(workspace);
  if (!wsMap) return null;
  return wsMap.get(sessionNum) || null;
}

function setSession(workspace, sessionNum, entry) {
  if (!sessions.has(workspace)) sessions.set(workspace, new Map());
  sessions.get(workspace).set(sessionNum, entry);
}

function deleteSession(workspace, sessionNum) {
  const wsMap = sessions.get(workspace);
  if (!wsMap) return;
  wsMap.delete(sessionNum);
  if (wsMap.size === 0) sessions.delete(workspace);
}

function findSession(workspace, sessionNum) {
  const exact = getSession(workspace, sessionNum);
  if (exact && !exact.killed) return exact;
  const wsMap = sessions.get(workspace);
  if (!wsMap) return null;
  for (const entry of wsMap.values()) {
    if (!entry.killed) return entry;
  }
  return null;
}

// --- Session lifecycle ---

async function ensureSession(workspace, sessionNum, workspacePath, opts = {}) {
  const existing = getSession(workspace, sessionNum);
  if (existing && !existing.killed) {
    // If autoExecute changed, tear down and recreate
    if (opts.autoExecute !== undefined && existing.autoExecute !== opts.autoExecute) {
      log(`autoExecute changed for ${workspace}/${sessionNum}, recreating session`);
      await stopSessionEntry(existing);
    } else {
      return existing;
    }
  }

  log(`ensureSession workspace=${workspace} session=${sessionNum} path=${workspacePath}`);
  const core = await getCore();
  const a2aCfg = await getA2AConfig();
  const a2aSettings = await getA2ASettings();

  // Save and restore cwd — loadConfig may chdir
  const originalCwd = process.cwd();

  try {
    // Load settings (user + workspace)
    const settings = a2aSettings.loadSettings(workspacePath);

    // Build extensions loader
    const extensionLoader = new core.SimpleExtensionLoader([]);

    // Generate a unique session ID
    const sessionId = `klaudii-${workspace}-${sessionNum}-${Date.now()}`;

    // Build config params (mirrors A2A server's loadConfig)
    const autoExecute = opts.autoExecute !== undefined ? opts.autoExecute : true;
    const approvalMode = autoExecute ? core.ApprovalMode.YOLO : core.ApprovalMode.DEFAULT;

    const configParams = {
      sessionId,
      model: opts.model || core.PREVIEW_GEMINI_MODEL,
      embeddingModel: core.DEFAULT_GEMINI_EMBEDDING_MODEL,
      sandbox: undefined,
      targetDir: workspacePath,
      debugMode: DEBUG,
      question: "",
      coreTools: settings.coreTools || settings.tools?.core || undefined,
      excludeTools: settings.excludeTools || settings.tools?.exclude || undefined,
      allowedTools: settings.allowedTools || settings.tools?.allowed || undefined,
      showMemoryUsage: false,
      approvalMode,
      mcpServers: settings.mcpServers,
      cwd: workspacePath,
      telemetry: { enabled: false },
      fileFiltering: {
        respectGitIgnore: settings.fileFiltering?.respectGitIgnore,
        respectGeminiIgnore: settings.fileFiltering?.respectGeminiIgnore,
        enableRecursiveFileSearch: settings.fileFiltering?.enableRecursiveFileSearch,
        customIgnoreFilePaths: settings.fileFiltering?.customIgnoreFilePaths || [],
      },
      ideMode: false,
      folderTrust: true,
      trustedFolder: true,
      extensionLoader,
      checkpointing: false,
      interactive: true,
      enableInteractiveShell: true,
      ptyInfo: "auto",
    };

    // Load memory
    const fileService = new core.FileDiscoveryService(workspacePath, {
      respectGitIgnore: configParams.fileFiltering?.respectGitIgnore,
      respectGeminiIgnore: configParams.fileFiltering?.respectGeminiIgnore,
      customIgnoreFilePaths: configParams.fileFiltering?.customIgnoreFilePaths,
    });

    const { memoryContent, fileCount, filePaths } = await core.loadServerHierarchicalMemory(
      workspacePath, [workspacePath], false, fileService, extensionLoader, true
    );
    configParams.userMemory = memoryContent;
    configParams.geminiMdFileCount = fileCount;
    configParams.geminiMdFilePaths = filePaths;

    // Create and initialize Config
    const config = new core.Config(configParams);
    await config.initialize();

    // Auth — detect method: env vars first, then OAuth creds from `gemini login`,
    // then Keychain API key. Mirrors the TUI's startup behavior.
    const authType = core.getAuthTypeFromEnv?.();
    if (authType) {
      log(`Auth from env: ${authType}`);
      await config.refreshAuth(authType);
    } else if (hasOAuthCreds()) {
      log("Auth via OAuth creds (gemini login)");
      await config.refreshAuth(core.AuthType.LOGIN_WITH_GOOGLE);
    } else {
      // Last resort — loadApiKey checks Keychain, createContentGeneratorConfig
      // will pick it up automatically via USE_GEMINI
      log("Auth via API key (Keychain fallback)");
      await config.refreshAuth(core.AuthType.USE_GEMINI);
    }

    const client = config.getGeminiClient();

    // Pending tool tracking (same pattern as A2A Task)
    const pendingConfirms = new Map();
    const pendingToolCalls = new Map();
    let toolCompletionResolve = null;
    let toolCompletionReject = null;
    let toolCompletionPromise = Promise.resolve();

    function resetToolPromise() {
      toolCompletionPromise = new Promise((resolve, reject) => {
        toolCompletionResolve = resolve;
        toolCompletionReject = reject;
      });
      if (pendingToolCalls.size === 0 && toolCompletionResolve) {
        toolCompletionResolve();
      }
    }

    function registerToolCall(callId, status) {
      const wasEmpty = pendingToolCalls.size === 0;
      pendingToolCalls.set(callId, status);
      if (wasEmpty) resetToolPromise();
    }

    function resolveToolCall(callId) {
      if (pendingToolCalls.has(callId)) {
        pendingToolCalls.delete(callId);
        if (pendingToolCalls.size === 0 && toolCompletionResolve) {
          toolCompletionResolve();
        }
      }
    }

    // Completed tool calls accumulator
    const completedToolCalls = [];

    // Create scheduler
    const scheduler = new core.CoreToolScheduler({
      config,
      outputUpdateHandler: (callId, output) => {
        dbg(`tool output update callId=${callId}`);
        // Live tool output — could emit as status
        if (entry.activeEventCallback) {
          entry.activeEventCallback({
            type: "status",
            message: typeof output === "string" ? output : JSON.stringify(output),
          });
        }
      },
      onAllToolCallsComplete: async (completed) => {
        log(`all tools complete: ${completed.map(tc => tc.request?.callId).join(", ")}`);
        completedToolCalls.push(...completed);
        completed.forEach(tc => resolveToolCall(tc.request?.callId));
      },
      onToolCallsUpdate: (toolCalls) => {
        for (const tc of toolCalls) {
          // Track pending tool calls
          if (["success", "error", "cancelled"].includes(tc.status)) {
            resolveToolCall(tc.request.callId);
          } else {
            registerToolCall(tc.request.callId, tc.status);
          }

          if (tc.status === "awaiting_approval" && tc.confirmationDetails) {
            const details = tc.confirmationDetails;
            if (details && typeof details.onConfirm === "function") {
              pendingConfirms.set(tc.request.callId, details);

              // Log tool details for debugging
              log(`awaiting_approval: tc.tool?.name=${tc.tool?.name} tc.request.name=${tc.request.name} details.type=${details.type} callId=${tc.request.callId} tc.tool?.constructor?.name=${tc.tool?.constructor?.name}`);

              // Auto-approve in yolo mode (except ask_user)
              if (autoExecute && details.type !== "ask_user") {
                details.onConfirm(core.ToolConfirmationOutcome.ProceedOnce);
                pendingConfirms.delete(tc.request.callId);
              } else {
                // Emit tool_use event for frontend approval UI
                if (entry.activeEventCallback) {
                  const toolName = tc.tool?.name || tc.request.name || "unknown";
                  let params = {};
                  try {
                    params = tc.request.args || tc.request.functionCall?.args || {};
                  } catch (_) { /* ignore */ }

                  entry.activeEventCallback({
                    type: "tool_use",
                    tool_name: toolName,
                    tool_id: tc.request.callId,
                    call_id: tc.request.callId,
                    parameters: params,
                    awaiting_approval: true,
                    confirmation_type: details.type,
                  });
                }
              }
            }
          }

          // Emit tool_use for non-approval tool calls too (so frontend sees them)
          if (tc.status === "scheduled" || tc.status === "executing") {
            if (entry.activeEventCallback) {
              const toolName = tc.tool?.name || tc.request.name || "unknown";
              let params = {};
              try {
                params = tc.request.args || tc.request.functionCall?.args || {};
              } catch (_) { /* ignore */ }
              entry.activeEventCallback({
                type: "tool_use",
                tool_name: toolName,
                tool_id: tc.request.callId,
                call_id: tc.request.callId,
                parameters: params,
                awaiting_approval: false,
              });
            }
          }

          // Emit tool_result for completed tools
          if (tc.status === "success" || tc.status === "error") {
            if (entry.activeEventCallback) {
              let output = "";
              try {
                const resp = tc.response;
                if (resp?.resultDisplay) output = resp.resultDisplay;
                else if (resp?.responseParts?.[0]?.functionResponse?.response?.output) {
                  output = resp.responseParts[0].functionResponse.response.output;
                } else if (resp?.error) {
                  output = resp.error.message || String(resp.error);
                }
              } catch (_) { /* ignore */ }
              entry.activeEventCallback({
                type: "tool_result",
                tool_id: tc.request.callId,
                status: tc.status === "success" ? "success" : "error",
                output: typeof output === "string" ? output : JSON.stringify(output),
              });
            }
          }
        }
      },
      getPreferredEditor: () => "code",
    });

    const entry = {
      config,
      client,
      scheduler,
      abortController: null,
      pendingConfirms,
      pendingToolCalls,
      completedToolCalls,
      toolCompletionPromise,
      resetToolPromise,
      killed: false,
      promptCount: 0,
      autoExecute,
      activeEventCallback: null,
      workspace,
      sessionNum,
      // Expose waitForPendingTools
      waitForPendingTools: () => pendingToolCalls.size === 0 ? Promise.resolve() : toolCompletionPromise,
      getAndClearCompletedTools: () => {
        const result = [...completedToolCalls];
        completedToolCalls.length = 0;
        return result;
      },
    };

    setSession(workspace, sessionNum, entry);
    log(`session created workspace=${workspace} session=${sessionNum} model=${config.getModel()}`);
    return entry;
  } finally {
    // Restore original cwd
    try { process.chdir(originalCwd); } catch (_) { /* ignore */ }
  }
}

async function stopSessionEntry(entry) {
  if (!entry || entry.killed) return;
  entry.killed = true;
  if (entry.abortController) {
    try { entry.abortController.abort(); } catch (_) { /* ignore */ }
  }
  entry.activeEventCallback = null;
  deleteSession(entry.workspace, entry.sessionNum);
  log(`session stopped workspace=${entry.workspace} session=${entry.sessionNum}`);
}

// --- Public API ---

/**
 * Start a chat turn. Returns { onEvent, onDone, onError, kill }.
 * Same interface as gemini-a2a.js.
 */
function startChat(workspace, sessionNum, workspacePath, userMessage, config, opts = {}) {
  let eventCallback = null;
  let doneCallback = null;
  let errorCallback = null;

  const handle = {
    onEvent(cb) { eventCallback = cb; return handle; },
    onDone(cb) { doneCallback = cb; return handle; },
    onError(cb) { errorCallback = cb; return handle; },
    kill() {
      const session = getSession(workspace, sessionNum);
      if (session?.abortController) {
        session.abortController.abort();
      }
    },
  };

  // Run the agentic loop asynchronously so caller can register callbacks
  setImmediate(async () => {
    let session;
    try {
      session = await ensureSession(workspace, sessionNum, workspacePath, {
        autoExecute: opts.autoExecute,
        model: opts.model,
      });
    } catch (err) {
      logErr("ensureSession failed:", err.message);
      if (errorCallback) errorCallback(err);
      return;
    }

    // Wire up event forwarding
    session.activeEventCallback = (event) => {
      appendRawLog(workspace, sessionNum, event);
      if (eventCallback) eventCallback(event);
    };

    session.abortController = new AbortController();
    const signal = session.abortController.signal;
    const promptId = `${session.config.getSessionId()}########${session.promptCount++}`;

    const core = await getCore();

    try {
      let agentTurnActive = true;
      let agentEvents = session.client.sendMessageStream(
        [{ text: userMessage }], signal, promptId
      );

      while (agentTurnActive) {
        if (signal.aborted) break;

        const toolCallRequests = [];
        for await (const event of agentEvents) {
          if (signal.aborted) break;

          switch (event.type) {
            case core.GeminiEventType.Content:
              if (eventCallback) {
                eventCallback({
                  type: "message",
                  role: "assistant",
                  content: event.value,
                  delta: true,
                });
              }
              break;

            case core.GeminiEventType.Thought:
              if (eventCallback) {
                const text = typeof event.value === "string"
                  ? event.value
                  : event.value?.text || event.value?.description || JSON.stringify(event.value);
                eventCallback({ type: "status", message: text });
              }
              break;

            case core.GeminiEventType.ToolCallRequest:
              toolCallRequests.push(event.value);
              break;

            case core.GeminiEventType.ModelInfo:
              dbg("model info:", event.value);
              break;

            case core.GeminiEventType.Error: {
              const errMsg = event.value?.error?.message || event.value?.message || "LLM error";
              logErr("LLM error:", errMsg);
              if (eventCallback) eventCallback({ type: "error", message: errMsg });
              break;
            }

            case core.GeminiEventType.Finished:
              dbg("turn finished, reason:", event.value);
              break;

            case core.GeminiEventType.ChatCompressed:
              dbg("chat compressed");
              break;

            default:
              dbg("unhandled event type:", event.type);
              break;
          }
        }

        if (signal.aborted) break;

        // Schedule tool calls if any
        if (toolCallRequests.length > 0) {
          log(`scheduling ${toolCallRequests.length} tool calls`);
          session.resetToolPromise();
          await session.scheduler.schedule(toolCallRequests, signal);
          await session.waitForPendingTools();

          if (signal.aborted) break;

          const completed = session.getAndClearCompletedTools();
          if (completed.length > 0) {
            if (completed.every(tc => tc.status === "cancelled")) {
              agentTurnActive = false;
            } else {
              // Feed tool results back to LLM
              const llmParts = [];
              for (const tc of completed) {
                const toolName = tc.tool?.name || tc.request?.name || "unknown";
                log(`completed tool=${toolName} status=${tc.status} llmContent=${tc.response?.llmContent} returnDisplay=${tc.response?.returnDisplay} responseParts=${JSON.stringify(tc.response?.responseParts)?.slice(0, 500)}`);
                const parts = tc.response?.responseParts;
                if (Array.isArray(parts)) llmParts.push(...parts);
                else if (parts) llmParts.push(parts);
              }
              agentEvents = session.client.sendMessageStream(
                llmParts, signal,
                completed[0]?.request?.prompt_id || promptId
              );
            }
          } else {
            agentTurnActive = false;
          }
        } else {
          agentTurnActive = false;
        }
      }

      // Turn complete
      if (eventCallback) {
        eventCallback({ type: "result", exitCode: 0 });
      }
      if (doneCallback) doneCallback(0);

    } catch (err) {
      if (signal.aborted) {
        log("turn aborted");
        if (eventCallback) eventCallback({ type: "result", exitCode: 0, stopped: true });
        if (doneCallback) doneCallback(0);
      } else {
        logErr("agentic loop error:", err.message);
        if (eventCallback) eventCallback({ type: "error", message: err.message });
        if (errorCallback) errorCallback(err);
      }
    } finally {
      session.abortController = null;
    }
  });

  return handle;
}

function isActive(workspace, sessionNum) {
  if (sessionNum != null) {
    const s = getSession(workspace, sessionNum);
    return !!(s && !s.killed);
  }
  const wsMap = sessions.get(workspace);
  if (!wsMap) return false;
  for (const entry of wsMap.values()) {
    if (!entry.killed) return true;
  }
  return false;
}

function stopProcess(workspace, sessionNum) {
  if (sessionNum != null) {
    const s = getSession(workspace, sessionNum);
    if (s) stopSessionEntry(s);
    return;
  }
  const wsMap = sessions.get(workspace);
  if (!wsMap) return;
  for (const entry of [...wsMap.values()]) {
    stopSessionEntry(entry);
  }
}

function stopAllProcesses() {
  for (const wsMap of sessions.values()) {
    for (const entry of wsMap.values()) {
      stopSessionEntry(entry);
    }
  }
  sessions.clear();
}

/**
 * Confirm a pending tool call. Unlike A2A, this doesn't return a new event
 * stream — events continue flowing through the startChat handle.
 */
function confirmToolCall(workspace, sessionNum, callId, outcome, answer) {
  const session = findSession(workspace, sessionNum);
  if (!session) {
    throw new Error(`No active session for workspace: ${workspace} session: ${sessionNum}`);
  }

  const details = session.pendingConfirms.get(callId);
  if (!details) {
    throw new Error(`No pending confirmation for callId: ${callId}`);
  }

  // Map outcome string to enum
  getCore().then((core) => {
    let confirmOutcome;
    switch (outcome) {
      case "proceed_once": confirmOutcome = core.ToolConfirmationOutcome.ProceedOnce; break;
      case "proceed_always_tool": confirmOutcome = core.ToolConfirmationOutcome.ProceedAlwaysTool; break;
      case "proceed_always": confirmOutcome = core.ToolConfirmationOutcome.ProceedAlways; break;
      case "cancel": confirmOutcome = core.ToolConfirmationOutcome.Cancel; break;
      default: confirmOutcome = core.ToolConfirmationOutcome.ProceedOnce;
    }

    // For ask_user, pass the answer payload
    let payload = undefined;
    if (details.type === "ask_user" && answer) {
      payload = { answers: typeof answer === "object" ? answer : { answer } };
    }

    log(`confirmToolCall workspace=${workspace} session=${sessionNum} callId=${callId} outcome=${outcome}`);
    details.onConfirm(confirmOutcome, payload);
    session.pendingConfirms.delete(callId);
  });
}

function getActiveServerInfo(workspace) {
  const wsMap = sessions.get(workspace);
  if (!wsMap) return [];
  const result = [];
  for (const [num, entry] of wsMap) {
    if (!entry.killed) {
      result.push({ sessionNum: num, model: entry.config?.getModel?.() || "unknown", pid: process.pid });
    }
  }
  return result;
}

/**
 * Execute a slash command directly via gemini-cli-core functions.
 */
const KNOWN_COMMANDS = new Set([
  "memory", "memory show", "memory list", "memory refresh",
  "extensions", "extensions list",
  "model", "tools", "settings", "stats", "compress", "init",
  "restore", "restore list",
  "about",
]);

async function executeCommand(workspace, sessionNum, command, args) {
  if (!KNOWN_COMMANDS.has(command)) {
    throw new Error(`Unknown command: ${command}`);
  }

  const session = findSession(workspace, sessionNum);
  const core = await getCore();

  // Some commands work without a session (they just need a Config or are standalone)
  const config = session?.config;

  switch (command) {
    case "memory":
    case "memory show": {
      if (!config) throw new Error("No active session — start a chat first");
      const result = core.showMemory(config);
      return { name: "memory show", data: result.content || result };
    }
    case "memory list": {
      if (!config) throw new Error("No active session — start a chat first");
      const result = core.listMemoryFiles(config);
      return { name: "memory list", data: result.content || result };
    }
    case "memory refresh": {
      if (!config) throw new Error("No active session — start a chat first");
      const result = await core.refreshMemory(config);
      return { name: "memory refresh", data: result.content || result };
    }
    case "extensions":
    case "extensions list": {
      if (!config) throw new Error("No active session — start a chat first");
      const exts = core.listExtensions(config);
      return { name: "extensions", data: exts };
    }
    case "model": {
      if (!config) throw new Error("No active session — start a chat first");
      return {
        name: "model",
        data: {
          current: config.getModel(),
          active: config.getActiveModel?.() || config.getModel(),
        },
      };
    }
    case "tools": {
      if (!config) throw new Error("No active session — start a chat first");
      const registry = config.getToolRegistry();
      const tools = registry.getAllTools?.() || [];
      return {
        name: "tools",
        data: tools.map(t => ({
          name: t.name,
          description: t.description,
        })),
      };
    }
    case "settings": {
      // Read settings files directly
      const a2aSettings = await getA2ASettings();
      const workspacePath = config?.targetDir || session?.config?.targetDir;
      const settingsData = workspacePath
        ? a2aSettings.loadSettings(workspacePath)
        : {};
      return { name: "settings", data: settingsData };
    }
    case "stats": {
      if (!config) throw new Error("No active session — start a chat first");
      const telemetry = await getUiTelemetry();
      const metrics = telemetry.uiTelemetryService.getMetrics();
      const lastPromptTokens = telemetry.uiTelemetryService.getLastPromptTokenCount();
      const quota = config.getRemainingQuotaForModel?.(config.getModel());
      return {
        name: "stats",
        data: {
          model: config.getModel(),
          activeModel: config.getActiveModel?.() || config.getModel(),
          sessionId: config.getSessionId(),
          quota: quota || "unavailable",
          lastPromptTokenCount: lastPromptTokens,
          models: metrics.models,
          tools: metrics.tools,
          files: metrics.files,
        },
      };
    }
    case "compress": {
      if (!session) throw new Error("No active session — start a chat first");
      try {
        await session.client.tryCompressChat?.();
        return { name: "compress", data: "Chat context compressed successfully" };
      } catch (e) {
        return { name: "compress", data: `Compression failed: ${e.message}` };
      }
    }
    case "init": {
      if (!config) throw new Error("No active session — start a chat first");
      const result = core.performInit?.(false);
      return { name: "init", data: result?.content || "Init not available" };
    }
    case "restore":
    case "restore list": {
      return { name: "restore", data: "Restore requires git checkpointing (not enabled)" };
    }
    case "about": {
      const core = await getCore();
      const version = await core.getVersion().catch(() => "unknown");
      const model = config?.getModel() || "unknown";
      const activeModel = config?.getActiveModel?.() || model;
      const tierName = config?.getUserTierName?.() || "unknown";
      const authType = config?.getContentGeneratorConfig?.()?.authType || "unknown";
      const sandbox = config?.getSandbox?.();
      const sessionId = config?.getSessionId?.() || "—";
      return {
        name: "about",
        data: {
          version,
          model,
          activeModel,
          tierName,
          authType,
          sandbox: sandbox ? `${sandbox.type || "enabled"}` : "none",
          platform: `${os.platform()} ${os.arch()} (${os.release()})`,
          sessionId,
        },
      };
    }
  }
}

module.exports = {
  startChat,
  isActive,
  stopProcess,
  stopAllProcesses,
  confirmToolCall,
  getActiveServerInfo,
  executeCommand,
};
