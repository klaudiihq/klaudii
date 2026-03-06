/**
 * Gemini Chat UI — WebSocket client, message rendering, markdown.
 *
 * Loaded after app.js and marked.min.js.
 */

// --- Logging ---
const G = "[gemini-ui]";
function glog(...args) { console.log(G, new Date().toISOString(), ...args); }

// --- Helpers ---
function chatMsgTime(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return time;
  const date = d.toLocaleDateString([], { month: "short", day: "numeric", ...(d.getFullYear() !== now.getFullYear() && { year: "numeric" }) });
  return `${date}, ${time}`;
}

// --- State ---

let geminiWs = null;
let geminiWorkspace = null;
let geminiWorkspacePath = null;
let geminiStreaming = false;
let geminiOpenedWhileStreaming = false; // true when chat opened mid-stream
let geminiStreamPollTimer = null;       // setInterval handle for polling in-flight reply
let geminiActiveCli = "gemini"; // "gemini" or "claude"
let geminiSessionNum = null; // current session number (1, 2, 3...)
let geminiLocalDraftActive = false; // true when user is actively typing — blocks incoming draft events
let geminiLocalDraftTimeout = null;
const geminiPageSessionDrafts = new Set(); // workspaces whose drafts were saved this page session
let geminiWasStreamingAtDisconnect = false; // set in onclose, cleared in onopen after recovery check
let geminiHistoryFetchFailed = false;        // set when history fetch fails (server not ready); triggers re-fetch on reconnect
let geminiAgentRole = null;          // "architect" | "shepherd" | null — set when in agent chat mode

// Per-workspace message history (in-memory cache, server is source of truth)
// workspace → [ { role, content } ]  (for current session)
const geminiHistory = {};

// --- URL query parameter support ---

function getChatParams() {
  const p = new URLSearchParams(window.location.search);
  return {
    mode: p.get("mode"),
    workspace: p.get("workspace"),
    tool: p.get("tool"),
    session: p.get("session"),
  };
}

function setChatParams({ mode, workspace, tool, session }) {
  const p = new URLSearchParams();
  if (mode) p.set("mode", mode);
  if (workspace) p.set("workspace", workspace);
  if (tool) p.set("tool", tool);
  if (session) p.set("session", session);
  const qs = p.toString();
  window.history.replaceState(null, "", qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
}

function clearChatParams() {
  window.history.replaceState(null, "", window.location.pathname);
}

async function resolveWorkspacePath(name) {
  try {
    const projects = await (await fetch("/api/projects")).json();
    const proj = projects.find(p => p.name === name);
    return proj ? proj.path : null;
  } catch { return null; }
}

/**
 * Fetch history for a workspace from the server and cache it locally.
 * @param {string} workspace
 * @param {number} [sessionNum] — session number (default: current)
 */
async function geminiFetchHistory(workspace, sessionNum) {
  try {
    const base = geminiActiveCli === "claude" ? "/api/claude-chat" : "/api/gemini";
    const qs = sessionNum ? `?session=${sessionNum}` : "";
    const res = await fetch(`${base}/history/${encodeURIComponent(workspace)}${qs}`);
    const data = await res.json();
    geminiHistory[workspace] = Array.isArray(data) ? data : [];
  } catch {
    geminiHistoryFetchFailed = true;
    geminiHistory[workspace] = geminiHistory[workspace] || [];
  }
  return geminiHistory[workspace];
}

/**
 * Fetch session list for a workspace and populate the session selector.
 * Returns { current, sessions: [1,2,3], active }.
 */
async function geminiFetchSessions(workspace) {
  const select = document.getElementById("gemini-session");
  if (!select) return null;

  try {
    const base = geminiActiveCli === "claude" ? "/api/claude-chat" : "/api/gemini";
    const res = await fetch(`${base}/sessions/${encodeURIComponent(workspace)}`);
    const data = await res.json();

    geminiSessionNum = data.current;
    const sessions = data.sessions || [];

    // Populate dropdown
    select.innerHTML = "";
    for (const num of sessions) {
      const opt = document.createElement("option");
      opt.value = num;
      opt.textContent = `Chat ${num}`;
      if (num === data.current) opt.selected = true;
      select.appendChild(opt);
    }

    // Show selector only when there are 2+ sessions (nothing to switch with just 1)
    select.classList.toggle("hidden", sessions.length < 2);

    return data;
  } catch {
    select.classList.add("hidden");
    return null;
  }
}

/**
 * Switch to a different session number.
 */
async function geminiSwitchSession(num) {
  if (!geminiWorkspace || num === geminiSessionNum) return;
  glog(`switchSession: workspace=${geminiWorkspace} from=${geminiSessionNum} to=${num}`);

  // Flush current input draft for the old session before switching
  const input = document.getElementById("gemini-input");
  if (input) geminiSaveDraft(input.value);

  // Stop any running process
  if (geminiStreaming) geminiStopStreaming();

  // Tell server to switch
  const base = geminiActiveCli === "claude" ? "/api/claude-chat" : "/api/gemini";
  try {
    const res = await fetch(`${base}/sessions/${encodeURIComponent(geminiWorkspace)}/switch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: num }),
    });
    if (!res.ok) throw new Error("switch failed");
  } catch (err) {
    glog("switchSession: error", err.message);
    return;
  }

  geminiSessionNum = num;

  // Persist session number server-side
  if (geminiWorkspace) {
    fetch(`/api/workspace-state/${encodeURIComponent(geminiWorkspace)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionNum: num,
        draftMode: geminiActiveCli === "claude" ? "claude-local" : "gemini",
      }),
    }).catch(() => {});
  }

  // Update URL
  const cur = getChatParams();
  setChatParams({ ...cur, session: num });

  // Reload history for the new session (geminiShowChat calls geminiRestoreDraft)
  geminiShowChat();
}

// Cached model list (fetched from server)
let geminiModelsFetched = false;

/**
 * Fetch available models from the server and populate the model selector.
 * Only fetches once per page load; call geminiRefreshModels() to force refresh.
 */
async function geminiFetchModels() {
  if (geminiModelsFetched) return;
  try {
    const endpoint = geminiActiveCli === "claude" ? "/api/claude-chat/models" : "/api/gemini/models";
    const res = await fetch(endpoint);
    const models = await res.json();
    if (!Array.isArray(models) || !models.length) return;

    const select = document.getElementById("gemini-model");
    if (!select) return;

    // Preserve current selection
    const prev = select.value;

    // Clear all options
    select.innerHTML = "";

    // Gemini has a real "Auto" mode (classifier-routed); Claude does not
    if (geminiActiveCli !== "claude") {
      const autoOpt = document.createElement("option");
      autoOpt.value = "";
      autoOpt.textContent = "Auto";
      select.appendChild(autoOpt);
    }

    // Add fetched models
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name;
      select.appendChild(opt);
    }

    // Restore previous selection: prefer in-memory, then localStorage
    const savedModel = geminiWorkspace ? localStorage.getItem(`klaudii-model-${geminiWorkspace}`) : null;
    const preferred = prev || savedModel;
    if (preferred && [...select.options].some((o) => o.value === preferred)) {
      select.value = preferred;
    }

    geminiModelsFetched = true;
  } catch {
    // Keep whatever is in the select
  }
}

/**
 * Force a model list refresh (e.g. after saving an API key).
 */
function geminiRefreshModels() {
  geminiModelsFetched = false;
  geminiFetchModels();
}

/**
 * Fetch and display quota info in the top bar.
 * Shows remaining fraction as a compact badge (e.g. "87% quota").
 */
async function geminiFetchQuota() {
  const el = document.getElementById("gemini-quota");
  if (!el) return;

  try {
    const res = await fetch("/api/gemini/quota");
    const data = await res.json();
    if (!data.buckets || !data.buckets.length) {
      el.textContent = "";
      el.title = "";
      return;
    }

    // Find the most constrained bucket (lowest remaining fraction)
    const withFraction = data.buckets.filter((b) => b.remainingFraction !== null);
    if (!withFraction.length) {
      el.textContent = "";
      return;
    }

    const worst = withFraction.reduce((min, b) =>
      b.remainingFraction < min.remainingFraction ? b : min
    );
    const pct = Math.round(worst.remainingFraction * 100);

    el.textContent = `${pct}% quota`;
    el.className = "gemini-bar-quota" + (pct <= 10 ? " low" : pct <= 30 ? " warn" : "");

    // Build tooltip with per-bucket detail
    const lines = data.buckets
      .filter((b) => b.remainingFraction !== null)
      .map((b) => {
        const rpct = Math.round(b.remainingFraction * 100);
        const model = b.modelId || "all";
        const type = b.tokenType || "";
        const reset = b.resetTime ? ` resets ${new Date(b.resetTime).toLocaleTimeString()}` : "";
        return `${model} ${type}: ${rpct}%${reset}`;
      });
    el.title = lines.join("\n");
  } catch {
    // Quota not available — hide
    if (el) el.textContent = "";
  }
}

// Current streaming assistant message element
let geminiCurrentMsgEl = null;
let geminiCurrentMsgText = "";
// Partial assistant bubble shown while polling mid-stream (opened while away)
let geminiPartialMsgEl = null;

// --- Image attachments ---

let geminiPendingImages = []; // [{ id, dataUrl, name }]
let geminiImageIdCounter = 0;

function geminiAddImage(dataUrl, name) {
  const id = ++geminiImageIdCounter;
  geminiPendingImages.push({ id, dataUrl, name: name || `image${id}` });
  geminiRenderImageStrip();
}

function geminiRemoveImage(id) {
  geminiPendingImages = geminiPendingImages.filter((i) => i.id !== id);
  geminiRenderImageStrip();
}

function geminiClearImages() {
  geminiPendingImages = [];
  geminiRenderImageStrip();
}

function geminiRenderImageStrip() {
  const strip = document.getElementById("gemini-image-strip");
  const attachBtn = document.getElementById("gemini-attach");
  if (!strip) return;
  if (geminiPendingImages.length === 0) {
    strip.classList.add("hidden");
    strip.innerHTML = "";
    if (attachBtn) attachBtn.classList.remove("has-images");
    return;
  }
  strip.classList.remove("hidden");
  if (attachBtn) attachBtn.classList.add("has-images");
  strip.innerHTML = geminiPendingImages.map((img) =>
    `<div class="gemini-img-thumb" title="${esc(img.name)}">
      <img src="${img.dataUrl}" alt="${esc(img.name)}">
      <button class="gemini-img-remove" onclick="geminiRemoveImage(${img.id})" title="Remove">×</button>
    </div>`
  ).join("");
}

function geminiHandleFileInput(event) {
  const files = Array.from(event.target.files || []);
  files.forEach((file) => geminiLoadImageFile(file));
  event.target.value = ""; // reset so same file can be re-added
}

function geminiLoadImageFile(file) {
  if (!file.type.startsWith("image/")) return;
  const reader = new FileReader();
  reader.onload = (e) => geminiAddImage(e.target.result, file.name);
  reader.readAsDataURL(file);
}

// Only show attach button when in claude-local mode (direct API supports images)
function geminiUpdateAttachVisibility() {
  const btn = document.getElementById("gemini-attach");
  const fileInput = document.getElementById("gemini-file-input");
  if (!btn) return;
  const show = geminiActiveCli === "claude";
  btn.style.display = show ? "" : "none";
  if (fileInput) fileInput.disabled = !show;
  if (!show) geminiClearImages();
}

// Show permission mode selector for both Claude and Gemini
function geminiUpdatePermissionVisibility() {
  const el = document.getElementById("gemini-permission-mode");
  if (!el) return;
  el.style.display = ""; // visible for all backends
}

function geminiGetPermissionMode() {
  const el = document.getElementById("gemini-permission-mode");
  return el ? (el.value || "bypassPermissions") : undefined;
}

function geminiSavePermissionMode(value) {
  if (geminiWorkspace) localStorage.setItem(`klaudii-perm-${geminiWorkspace}`, value);
}

function geminiRestorePermissionMode() {
  const el = document.getElementById("gemini-permission-mode");
  if (!el || !geminiWorkspace) return;
  const saved = localStorage.getItem(`klaudii-perm-${geminiWorkspace}`);
  el.value = saved || "bypassPermissions";
}

// Draft sync — relay over WS for instant multi-window sync, HTTP PATCH fallback
let geminiDraftTimer = null;

function geminiSaveDraft(text) {
  if (!geminiWorkspace) return;
  clearTimeout(geminiDraftTimer);
  const workspace = geminiWorkspace;
  geminiPageSessionDrafts.add(workspace);
  const draftMode = geminiActiveCli === "claude" ? "claude-local" : "gemini";
  const draftSession = geminiSessionNum;
  geminiDraftTimer = setTimeout(() => {
    if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
      geminiWs.send(JSON.stringify({ type: "draft", workspace, text, draftMode, draftSession }));
    } else {
      // Fallback to HTTP if WS is disconnected
      fetch(`/api/workspace-state/${encodeURIComponent(workspace)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draft: text, draftMode, draftSession }),
      }).catch(() => {});
    }
  }, 100);
}

async function geminiRestoreDraft(prefetchedState = null) {
  if (!geminiWorkspace) return;
  const workspaceAtCall = geminiWorkspace;
  const input = document.getElementById("gemini-input");
  if (!input) return;
  // Only restore drafts saved during this page session to avoid stale state on load
  if (!geminiPageSessionDrafts.has(geminiWorkspace)) {
    input.value = "";
    return;
  }
  try {
    const state = prefetchedState || await fetch(`/api/workspace-state/${encodeURIComponent(geminiWorkspace)}`).then(r => r.json());
    // Don't apply if workspace changed during async fetch
    if (geminiWorkspace !== workspaceAtCall) return;
    input.value = state.draft || "";
  } catch { /* non-fatal */ }
}

// --- WebSocket ---

function geminiConnect() {
  if (geminiWs && geminiWs.readyState === WebSocket.OPEN) return;

  const wsUrl = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/gemini`;
  console.log("[gemini-ws] connecting to", wsUrl);
  geminiWs = new WebSocket(wsUrl);

  geminiWs.onopen = () => {
    glog("ws-open");
    geminiUpdateStatus(true);
    // If history fetch failed while server was restarting, re-render now that it's up
    if (geminiHistoryFetchFailed && geminiWorkspace) {
      geminiHistoryFetchFailed = false;
      geminiWasStreamingAtDisconnect = false; // clear here too — showChat re-renders everything
      glog("ws-open: retrying history fetch after server restart");
      geminiShowChat();
    } else if (geminiWasStreamingAtDisconnect && geminiWorkspace) {
      // Disconnected mid-stream — check whether it's still running or completed
      geminiWasStreamingAtDisconnect = false;
      fetch(`/api/workspace-state/${encodeURIComponent(geminiWorkspace)}`)
        .then(r => r.json())
        .then(wsState => {
          if (wsState.streaming) {
            // Stream survived the reconnect (transient blip) — re-enter poll mode
            // with partial content so the user catches up immediately
            geminiOpenedWhileStreaming = true;
            geminiShowChat();
          } else {
            // Stream completed while disconnected — render recovered content
            geminiRenderRecoveredContent();
          }
        })
        .catch(() => geminiRenderRecoveredContent());
    }
  };

  geminiWs.onclose = (evt) => {
    glog("ws-close code=" + evt.code, "reason=" + (evt.reason || ""));
    geminiUpdateStatus(false);
    // If a stream was in progress, clear it so the UI doesn't hang
    if (geminiStreaming) {
      geminiWasStreamingAtDisconnect = true;
      geminiRemoveThinking();
      geminiSetStreaming(false);
      geminiCurrentMsgEl = null;
      geminiCurrentMsgText = "";
      geminiAppendError("Connection lost — response may be incomplete.");
    }
    geminiStopStreamPoll();
    // Reconnect after 2s
    setTimeout(geminiConnect, 2000);
  };

  geminiWs.onerror = (evt) => {
    glog("ws-error", evt);
  };

  let wsEventCount = 0;
  geminiWs.onmessage = (evt) => {
    let event;
    try {
      event = JSON.parse(evt.data);
    } catch {
      glog("ws-msg: invalid JSON", evt.data.slice(0, 100));
      return;
    }

    wsEventCount++;
    glog(`ws-msg #${wsEventCount} type=${event.type} workspace=${event.workspace}${event.role ? " role=" + event.role : ""}${event.content ? " contentLen=" + event.content.length : ""}${event.exitCode !== undefined ? " exitCode=" + event.exitCode : ""}${event.name ? " tool=" + event.name : ""}`);

    // Only render events for the currently open workspace
    if (event.workspace !== geminiWorkspace) {
      glog(`ws-msg: ignoring (current workspace=${geminiWorkspace})`);
      return;
    }

    handleGeminiEvent(event);
  };
}

function geminiUpdateStatus(connected) {
  const el = document.getElementById("gemini-status");
  if (!el) return;
  if (connected) {
    el.textContent = "connected";
    el.className = "gemini-bar-status connected";
  } else {
    el.textContent = "disconnected";
    el.className = "gemini-bar-status";
  }
}

// --- Event handling ---

function handleGeminiEvent(event) {
  const history = geminiHistory[event.workspace] || [];

  switch (event.type) {
    case "init": {
      const sessionId = event.session_id || event.sessionId || null;
      glog("handle: init sessionId=" + (sessionId || "?") + " session#" + geminiSessionNum);
      // Update URL with session number (not CLI session ID)
      if (geminiSessionNum) {
        const cur = getChatParams();
        setChatParams({ ...cur, session: geminiSessionNum });
      }
      break;
    }

    case "message":
      if (event.role === "assistant" || !event.role) {
        // First assistant content — remove thinking indicator
        geminiRemoveThinking();

        const text = event.content || "";
        geminiCurrentMsgText += text;
        glog(`handle: message delta=${event.delta || false} contentLen=${text.length} totalLen=${geminiCurrentMsgText.length}`);

        if (!geminiCurrentMsgEl && geminiCurrentMsgText) {
          glog("handle: creating assistant message element");
          geminiCurrentMsgEl = geminiAppendMessage("assistant", "", true);
        }

        if (geminiCurrentMsgEl) {
          const mdEl = geminiCurrentMsgEl.querySelector(".md-content");
          if (mdEl) {
            mdEl.innerHTML = geminiRenderMarkdown(geminiCurrentMsgText);
          }
          geminiScrollToBottom();
        }
      } else {
        glog(`handle: message role=${event.role} (skipping — user echo)`);
      }
      break;

    case "tool_use": {
      geminiRemoveThinking();
      const toolName = event.tool_name || event.name || "tool";
      const toolId = event.tool_id || "";
      const params = event.parameters || event.args || event.input || {};
      glog(`handle: tool_use name=${toolName} id=${toolId} awaiting=${!!event.awaiting_approval}`);
      // Remove or discard the current message element before the tool pill
      if (geminiCurrentMsgEl) {
        if (!geminiCurrentMsgText) {
          geminiCurrentMsgEl.remove();
        } else {
          geminiCurrentMsgEl.classList.remove("gemini-streaming");
        }
      }
      geminiCurrentMsgEl = null;
      geminiCurrentMsgText = "";
      if (toolName === "ExitPlanMode") {
        // Plan approval: render the plan as markdown with approve/reject buttons
        geminiShowPlanApproval(toolId, params.plan || "");
      } else if (toolName === "EnterPlanMode") {
        // Planning mode entry — just show a small indicator, no action needed
        geminiAppendToolUse(toolName, toolId, params);
      } else if (event.awaiting_approval) {
        // Interactive approval prompt — show Approve/Deny buttons
        geminiShowApprovalPrompt(event);
      } else if (/ask.*question|askfollowup|ask_followup/i.test(toolName)) {
        // AskUserQuestion always triggers permission_request (requiresUserInteraction=true).
        // Don't render anything here — the permission_request handler renders the
        // interactive question card. Rendering a pill would leave an orphan.
        glog(`handle: ask-tool (skipped, waiting for permission_request) toolId=${toolId}`);
      } else {
        geminiAppendToolUse(toolName, toolId, params);
      }
      break;
    }

    case "tool_result": {
      const toolId = event.tool_id || "";
      const toolName = event.tool_name || "";
      const output = event.output || event.content || "";
      const status = event.status || "success";
      const error = event.error;
      glog(`handle: tool_result id=${toolId} tool=${toolName} status=${status} outputLen=${output.length}`);
      // AskUserQuestion results are already shown in the question card — skip rendering.
      if (!/ask.*question/i.test(toolName)) {
        geminiUpdateToolResult(toolId, status, output, error);
      }
      // Model continues processing after the tool — show thinking indicator so the
      // UI doesn't appear frozen between tool completion and the next text chunk.
      if (geminiStreaming) geminiShowThinking("Thinking\u2026");
      break;
    }

    case "error":
      geminiRemoveThinking();
      glog("handle: error message=" + (event.message || "?"));
      geminiAppendError(event.message || "Unknown error");
      geminiSetStreaming(false);
      break;

    case "done":
      geminiRemoveThinking();
      geminiStopStreamPoll(); // cancel any open-while-streaming poll — live WS beat it
      glog(`handle: done exitCode=${event.exitCode} stopped=${event.stopped || false} assistantTextLen=${geminiCurrentMsgText.length} stderr=${(event.stderr || "").slice(0, 200)}`);
      if (geminiCurrentMsgText) {
        history.push({ role: "assistant", content: geminiCurrentMsgText });
        geminiHistory[event.workspace] = history;
      }
      // Stamp the assistant bubble with completion time
      geminiStampMessageTime(geminiCurrentMsgEl, Date.now());
      geminiSetStreaming(false);
      geminiCurrentMsgEl = null;
      geminiCurrentMsgText = "";

      // If a partial bubble was showing (opened mid-stream), replace it with the full response
      if (geminiPartialMsgEl) {
        const partialEl = geminiPartialMsgEl;
        geminiPartialMsgEl = null;
        const doneWs = event.workspace;
        const doneSn = geminiSessionNum;
        geminiFetchHistory(doneWs, doneSn)
          .then(hist => {
            const lastMsg = hist && [...hist].reverse().find(m => m.role === "assistant");
            if (lastMsg) {
              const mdEl = partialEl.querySelector(".md-content");
              if (mdEl) mdEl.innerHTML = geminiRenderMarkdown(lastMsg.content);
              geminiStampMessageTime(partialEl, lastMsg.ts || Date.now());
              geminiHistory[doneWs] = hist;
            }
            partialEl.classList.remove("gemini-streaming");
            geminiScrollToBottom();
          })
          .catch(() => { partialEl.classList.remove("gemini-streaming"); });
      }

      // Exit code 41 = auth failure (Gemini), 1 with auth error (Claude) — show auth panel
      if (event.exitCode === 41) {
        glog("handle: auth failure, showing auth panel");
        geminiShowAuthPanel();
      } else if (event.exitCode && event.exitCode !== 0 && event.stderr && event.stderr.includes("auth")) {
        glog("handle: possible auth failure, showing auth panel");
        geminiShowAuthPanel();
      } else if (event.exitCode && event.exitCode !== 0 && event.stderr) {
        geminiAppendError(`Process exited with code ${event.exitCode}: ${event.stderr.slice(0, 500)}`);
      }
      break;

    case "status": {
      // Server-forwarded stderr status (e.g. quota retries)
      const msg = event.message || "";
      glog("handle: status " + msg);
      const thinkLabel = document.querySelector("#gemini-thinking .gemini-thinking-label");
      if (thinkLabel) {
        thinkLabel.textContent = msg.length > 80 ? msg.slice(0, 77) + "..." : msg;
      }
      break;
    }

    case "result":
      glog("handle: result stats=" + JSON.stringify(event.stats || {}).slice(0, 200));
      break;

    case "draft": {
      // Another window updated the draft — apply unless user is actively typing here
      if (!geminiLocalDraftActive) {
        const input = document.getElementById("gemini-input");
        if (input) {
          input.value = event.text || "";
          // Auto-resize
          input.style.height = "auto";
          input.style.height = Math.min(input.scrollHeight, 256) + "px";
        }
      }
      break;
    }

    case "user_message": {
      // Another window sent a message — render the user bubble
      glog("handle: user_message from another window");
      if (!geminiHistory[event.workspace]) geminiHistory[event.workspace] = [];
      geminiHistory[event.workspace].push({ role: "user", content: event.content, sender: event.sender });
      geminiAppendMessage("user", event.content, false, null, event.ts, event.sender);
      // Clear input since the message was sent
      const input = document.getElementById("gemini-input");
      if (input) {
        input.value = "";
        input.style.height = "auto";
      }
      break;
    }

    case "streaming_start":
      // Another window started a send — show thinking indicator
      glog("handle: streaming_start from another window");
      geminiSetStreaming(true);
      geminiShowThinking();
      break;

    case "permission_request":
      geminiRemoveThinking();
      glog("handle: permission_request request_id=" + event.request_id + " tool=" + event.tool_name);
      // AskUserQuestion: show interactive question card. The user's answers are
      // sent back as `updatedInput.answers` in the permission_response — NOT as a
      // separate tool_result. The tool's call() reads answers from its input.
      if (event.tool_name === "AskUserQuestion" || event.tool_name === "ask_followup_question") {
        // Remove the pending tool pill that tool_use created for this tool
        const pendingPill = document.querySelector(`.gemini-tool.running[data-tool-name="AskUserQuestion"], .gemini-tool.running[data-tool-name="ask_followup_question"]`);
        if (pendingPill) pendingPill.remove();
        const toolInput = event.tool_input || {};
        const questions = toolInput.questions?.length
          ? toolInput.questions
          : [{ question: toolInput.question || toolInput.prompt || "", options: toolInput.options || toolInput.choices || [] }];
        geminiShowToolQuestions(event.request_id, questions, toolInput, true);
        break;
      }
      // Auto-approve EnterPlanMode — it just switches Claude into planning mode
      if (event.tool_name === "EnterPlanMode") {
        if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
          geminiWs.send(JSON.stringify({ type: "permission_response", workspace: geminiWorkspace, request_id: event.request_id, behavior: "allow", updatedInput: event.tool_input || {} }));
        }
        break;
      }
      // ExitPlanMode: show plan approval card with the plan content from tool_input
      if (event.tool_name === "ExitPlanMode") {
        geminiShowPlanApproval(event.request_id, (event.tool_input || {}).plan || "", true);
        break;
      }
      geminiShowPermissionRequest(event.request_id, event.tool_name, event.tool_input, event.description, event.decision_reason);
      break;

    case "permission_resolved":
      // Another client already responded to this permission_request.
      // Update the UI to show the resolved state with answers.
      glog("handle: permission_resolved request_id=" + event.request_id + " behavior=" + event.behavior + " tool=" + event.tool_name);
      geminiResolvePermissionUI(event.request_id, event.behavior, event.tool_name, event.updatedInput);
      break;

    case "thinking":
      geminiRemoveThinking();
      glog("handle: thinking contentLen=" + (event.content || "").length);
      geminiAppendThinkingBlock(event.content || "");
      break;

    case "tool_progress": {
      const tpId = event.tool_use_id || "";
      const elapsed = event.elapsed_time_seconds;
      glog(`handle: tool_progress id=${tpId} elapsed=${elapsed}s`);
      if (tpId && elapsed != null) {
        const pill = document.querySelector(`.gemini-tool.running[data-tool-id="${CSS.escape(tpId)}"]`);
        if (pill) {
          let timerEl = pill.querySelector(".gemini-tool-timer");
          if (!timerEl) {
            timerEl = document.createElement("span");
            timerEl.className = "gemini-tool-timer";
            const summary = pill.querySelector(".gemini-tool-summary");
            if (summary) summary.appendChild(timerEl);
          }
          timerEl.textContent = ` ${Math.round(elapsed)}s`;
        }
      }
      break;
    }

    case "result":
      glog("handle: result stats=" + JSON.stringify(event.stats || {}).slice(0, 200) + " subtype=" + (event.subtype || "success"));
      geminiShowResultFooter(event.stats, event.subtype, event.errors);
      break;

    case "system_status":
      glog("handle: system_status status=" + event.status + " permMode=" + event.permissionMode);
      if (event.permissionMode) {
        geminiAppendSystemNote("Permission mode changed to " + event.permissionMode);
      }
      break;

    case "compact_boundary":
      glog("handle: compact_boundary pre=" + event.pre_tokens + " post=" + event.post_tokens);
      geminiAppendSystemNote(
        "Context compacted" + (event.pre_tokens ? ` (was ~${Math.round(event.pre_tokens / 1000)}k tokens)` : "")
      );
      break;

    case "task_started":
      glog("handle: task_started id=" + event.task_id + " desc=" + event.description);
      geminiAppendTaskCard(event.task_id, event.description, "running");
      break;

    case "task_progress": {
      glog("handle: task_progress id=" + event.task_id);
      const taskCard = document.querySelector(`.gemini-task-card[data-task-id="${CSS.escape(event.task_id)}"]`);
      if (taskCard) {
        const detail = taskCard.querySelector(".gemini-task-detail");
        if (detail && event.tool_name) detail.textContent = `Last tool: ${event.tool_name}`;
      }
      break;
    }

    case "task_notification": {
      glog("handle: task_notification id=" + event.task_id + " status=" + event.status);
      const taskEl = document.querySelector(`.gemini-task-card[data-task-id="${CSS.escape(event.task_id)}"]`);
      if (taskEl) {
        taskEl.classList.remove("running");
        taskEl.classList.add(event.status === "completed" ? "success" : "error");
        const statusEl = taskEl.querySelector(".gemini-task-status");
        if (statusEl) statusEl.textContent = event.status === "completed" ? "✓ Completed" : "✗ " + event.status;
        if (event.summary) {
          const sumEl = document.createElement("div");
          sumEl.className = "gemini-task-summary";
          sumEl.textContent = event.summary;
          taskEl.appendChild(sumEl);
        }
      }
      break;
    }

    default:
      glog("handle: unknown event type=" + event.type + " keys=" + Object.keys(event).join(","));
      break;
  }
}

/**
 * Update permission/question UI for a request_id that was resolved by another client.
 * For AskUserQuestion, highlights the selected answers. For other tools, disables buttons.
 */
function geminiResolvePermissionUI(requestId, behavior, toolName, updatedInput) {
  const container = document.getElementById("gemini-messages");
  if (!container) return;
  const sel = CSS.escape(requestId);
  const cards = container.querySelectorAll(
    `.gemini-permission-request[data-request-id="${sel}"], .gemini-plan-approval[data-request-id="${sel}"], .gemini-question-card[data-request-id="${sel}"]`
  );

  for (const card of cards) {
    // For AskUserQuestion, highlight the selected answers on the option buttons
    if (/ask.*question/i.test(toolName) && updatedInput?.answers) {
      const selectedValues = new Set(Object.values(updatedInput.answers));
      card.querySelectorAll("button").forEach(b => {
        b.disabled = true;
        if (selectedValues.has(b.textContent.trim())) {
          b.classList.add("selected");
          b.textContent += " \u2713";
        } else {
          b.classList.add("greyed");
        }
      });
    } else {
      card.querySelectorAll("button").forEach(b => { b.disabled = true; });
    }

    const note = document.createElement("div");
    note.style.fontSize = "0.75rem";
    note.style.opacity = "0.7";
    note.style.marginTop = "0.25rem";
    note.textContent = behavior === "allow" ? "Answered in another window" : "Denied in another window";
    card.appendChild(note);
  }
}

function geminiShowPermissionRequest(requestId, toolName, toolInput, description, decisionReason) {
  const container = document.getElementById("gemini-messages");
  const div = document.createElement("div");
  div.className = "gemini-permission-request";
  div.dataset.requestId = requestId;

  const header = document.createElement("div");
  header.className = "gemini-permission-header";
  header.textContent = toolName ? `Claude wants to use: ${toolName}` : "Claude is asking for permission";
  div.appendChild(header);

  // Show human-readable description if available
  if (description) {
    const descEl = document.createElement("div");
    descEl.className = "gemini-permission-desc";
    descEl.textContent = description;
    div.appendChild(descEl);
  }

  // Show decision reason if available
  if (decisionReason) {
    const reasonEl = document.createElement("div");
    reasonEl.className = "gemini-permission-reason";
    reasonEl.textContent = decisionReason;
    div.appendChild(reasonEl);
  }

  // Show key input fields for context (command, file_path, etc.)
  if (toolInput && Object.keys(toolInput).length) {
    const detail = document.createElement("div");
    detail.className = "gemini-permission-question";
    const preview = Object.entries(toolInput)
      .filter(([, v]) => typeof v === "string" || typeof v === "number")
      .map(([k, v]) => {
        const val = String(v);
        return `${k}: ${val.length > 120 ? val.slice(0, 117) + "…" : val}`;
      })
      .join("\n");
    detail.textContent = preview || JSON.stringify(toolInput).slice(0, 200);
    detail.style.fontFamily = "monospace";
    detail.style.fontSize = "0.8rem";
    detail.style.whiteSpace = "pre-wrap";
    div.appendChild(detail);
  }

  const btns = document.createElement("div");
  btns.className = "gemini-permission-buttons";

  const respond = (behavior) => {
    btns.querySelectorAll("button").forEach(b => { b.disabled = true; });
    const chosen = btns.querySelector(`[data-behavior="${behavior}"]`);
    if (chosen) chosen.textContent += " ✓";
    if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
      geminiWs.send(JSON.stringify({
        type: "permission_response",
        workspace: geminiWorkspace,
        request_id: requestId,
        behavior,
        updatedInput: behavior === "allow" ? (toolInput || {}) : undefined,
      }));
    }
    glog("permission_request: sent behavior=" + behavior + " request_id=" + requestId);
  };

  const allowBtn = document.createElement("button");
  allowBtn.className = "btn primary";
  allowBtn.textContent = "Allow";
  allowBtn.dataset.behavior = "allow";
  allowBtn.onclick = () => respond("allow");
  btns.appendChild(allowBtn);

  const denyBtn = document.createElement("button");
  denyBtn.className = "btn";
  denyBtn.textContent = "Deny";
  denyBtn.dataset.behavior = "deny";
  denyBtn.onclick = () => respond("deny");
  btns.appendChild(denyBtn);

  div.appendChild(btns);
  container.appendChild(div);
  geminiScrollToBottom();
}

/**
 * Show a plan approval card. Renders the plan as markdown with Approve/Reject buttons.
 * @param {string} id - Either a tool_id (bypass mode) or request_id (permission mode)
 * @param {string} planText - The markdown plan content
 * @param {boolean} isPermissionRequest - true if this is a permission_request (non-bypass mode)
 */
function geminiShowPlanApproval(id, planText, isPermissionRequest) {
  const container = document.getElementById("gemini-messages");

  // Remove any existing running tool pill for this id (the generic one from tool_use)
  const existingPill = container.querySelector(`.gemini-tool.running[data-tool-id="${CSS.escape(id)}"]`);
  if (existingPill) existingPill.remove();

  const div = document.createElement("div");
  div.className = "gemini-plan-approval";
  if (isPermissionRequest) div.dataset.requestId = id;

  const header = document.createElement("div");
  header.className = "gemini-plan-header";
  header.textContent = "Claude has proposed a plan";
  div.appendChild(header);

  if (planText) {
    const content = document.createElement("div");
    content.className = "gemini-plan-content md-content";
    content.innerHTML = geminiRenderMarkdown(planText);
    div.appendChild(content);
  }

  const btns = document.createElement("div");
  btns.className = "gemini-permission-buttons";

  const respond = (approved) => {
    btns.querySelectorAll("button").forEach(b => { b.disabled = true; });
    div.classList.add(approved ? "approved" : "rejected");
    header.textContent = approved ? "Plan approved" : "Plan rejected";

    if (isPermissionRequest) {
      // Non-bypass mode: send permission_response.
      // updatedInput is REQUIRED by Claude CLI's Zod schema for "allow" responses.
      if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
        const payload = {
          type: "permission_response",
          workspace: geminiWorkspace,
          request_id: id,
          behavior: approved ? "allow" : "deny",
        };
        if (approved) payload.updatedInput = { plan: planText };
        geminiWs.send(JSON.stringify(payload));
      }
    } else {
      // Bypass mode: plan already executed. Send follow-up message to instruct Claude.
      if (!approved && geminiWs && geminiWs.readyState === WebSocket.OPEN) {
        geminiWs.send(JSON.stringify({
          type: "send",
          workspace: geminiWorkspace,
          message: "I reject this plan. Please revise it.",
          backend: "claude",
        }));
      }
    }
    glog("plan_approval: " + (approved ? "approved" : "rejected") + " id=" + id);
  };

  const approveBtn = document.createElement("button");
  approveBtn.className = "btn primary";
  approveBtn.textContent = "Approve Plan";
  approveBtn.onclick = () => respond(true);
  btns.appendChild(approveBtn);

  const rejectBtn = document.createElement("button");
  rejectBtn.className = "btn";
  rejectBtn.textContent = "Reject Plan";
  rejectBtn.onclick = () => respond(false);
  btns.appendChild(rejectBtn);

  div.appendChild(btns);
  container.appendChild(div);
  geminiScrollToBottom();
}

// questions: [{question, header, options:[string|{label,description}], multiSelect?}]
// id: either a tool_id (bypass mode / Gemini) or request_id (permission mode)
// toolInput: original tool input for AskUserQuestion (used to build updatedInput)
// isPermissionRequest: true → send answers via permission_response updatedInput.answers
//                      false → send answers via tool_result_response content string
function geminiShowToolQuestions(id, questions, toolInput, isPermissionRequest) {
  const container = document.getElementById("gemini-messages");
  const div = document.createElement("div");
  div.className = isPermissionRequest ? "gemini-permission-request gemini-question-card" : "gemini-permission-request";
  if (isPermissionRequest) div.dataset.requestId = id;

  const headerEl = document.createElement("div");
  headerEl.className = "gemini-permission-header";
  headerEl.textContent = "Claude is asking";
  div.appendChild(headerEl);

  const answers = new Array(questions.length).fill(null);

  const sendResult = () => {
    if (isPermissionRequest) {
      // Claude CLI AskUserQuestion: answers go in updatedInput.answers as {question: answer}
      const answersMap = {};
      questions.forEach((q, i) => {
        const key = q.question || q.header || `Q${i + 1}`;
        answersMap[key] = answers[i];
      });
      const updatedInput = { ...(toolInput || {}), answers: answersMap };
      glog(`tool_questions: sending permission_response request_id=${id} answers=${JSON.stringify(answersMap)}`);
      if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
        geminiWs.send(JSON.stringify({
          type: "permission_response",
          workspace: geminiWorkspace,
          request_id: id,
          behavior: "allow",
          updatedInput,
        }));
      }
    } else {
      // Gemini / bypass mode: answers as a formatted string via tool_result_response
      const content = questions.map((q, i) => {
        const prefix = q.header || q.question || `Q${i + 1}`;
        return `${prefix}: ${answers[i]}`;
      }).join("\n");
      glog(`tool_questions: sending tool_result_response tool_id=${id}`);
      if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
        geminiWs.send(JSON.stringify({
          type: "tool_result_response",
          workspace: geminiWorkspace,
          tool_id: id,
          content,
        }));
      }
    }
  };

  questions.forEach((q, qi) => {
    const section = document.createElement("div");
    section.className = "gemini-question-section" + (qi > 0 ? " gemini-question-section--subsequent" : "");

    if (q.question) {
      const qEl = document.createElement("div");
      qEl.className = "gemini-permission-question";
      qEl.textContent = q.question;
      section.appendChild(qEl);
    }

    const btns = document.createElement("div");
    btns.className = "gemini-permission-buttons";
    const rawOptions = q.options || q.choices || [];
    const renderOptions = rawOptions.length ? rawOptions : ["Yes", "No"];

    renderOptions.forEach((opt, i) => {
      const btn = document.createElement("button");
      btn.className = "btn" + (i === 0 ? " primary" : "");
      const label = typeof opt === "object" ? (opt.label || String(opt)) : String(opt);
      btn.textContent = label;
      btn.dataset.label = label;
      if (typeof opt === "object" && opt.description) btn.title = opt.description;
      btn.onclick = () => {
        if (answers[qi] !== null) return;
        btns.querySelectorAll("button").forEach(b => {
          b.disabled = true;
          b.classList.remove("primary");
          b.classList.add("greyed");
        });
        const chosen = btns.querySelector(`[data-label="${CSS.escape(label)}"]`);
        if (chosen) {
          chosen.textContent += " \u2713";
          chosen.classList.remove("greyed");
          chosen.classList.add("selected", "primary");
        }
        answers[qi] = label;
        glog(`tool_question[${qi}]: selected=${label}`);
        if (answers.every(a => a !== null)) sendResult();
      };
      btns.appendChild(btn);
    });

    section.appendChild(btns);
    div.appendChild(section);
  });

  container.appendChild(div);
  geminiScrollToBottom();
}

// --- DOM rendering ---

function geminiAppendMessage(role, content, streaming, images, ts, sender) {
  const container = document.getElementById("gemini-messages");
  const div = document.createElement("div");
  div.className = `gemini-msg ${role}${streaming ? " gemini-streaming" : ""}`;

  if (role === "user") {
    const bubble = document.createElement("div");
    const senderClass = sender === "architect" ? " bubble-architect" : sender === "shepherd" ? " bubble-shepherd" : "";
    bubble.className = "user-bubble" + senderClass;
    // Render any attached images above the message text
    if (images && images.length) {
      const imgRow = document.createElement("div");
      imgRow.className = "gemini-msg-images";
      images.forEach((img) => {
        const im = document.createElement("img");
        im.src = img.dataUrl;
        im.className = "gemini-msg-img";
        im.alt = img.name || "attached image";
        imgRow.appendChild(im);
      });
      bubble.appendChild(imgRow);
    }
    if (sender === "architect" || sender === "shepherd") {
      const label = document.createElement("div");
      label.className = "bubble-sender-label";
      label.textContent = sender.charAt(0).toUpperCase() + sender.slice(1);
      bubble.appendChild(label);
    }
    const textNode = document.createElement("span");
    textNode.textContent = content;
    bubble.appendChild(textNode);
    div.appendChild(bubble);
  } else {
    const md = document.createElement("div");
    md.className = "md-content";
    md.innerHTML = content ? geminiRenderMarkdown(content) : "";
    div.appendChild(md);
  }

  const timeStr = chatMsgTime(ts);
  if (timeStr) {
    const tsEl = document.createElement("div");
    tsEl.className = "gemini-msg-ts";
    tsEl.textContent = timeStr;
    div.appendChild(tsEl);
  }

  container.appendChild(div);
  geminiScrollToBottom();
  return div;
}

/** Stamp a timestamp onto an already-rendered message element (used when assistant stream completes). */
function geminiStampMessageTime(el, ts) {
  if (!el || !ts) return;
  const timeStr = chatMsgTime(ts);
  if (!timeStr) return;
  let tsEl = el.querySelector(".gemini-msg-ts");
  if (!tsEl) {
    tsEl = document.createElement("div");
    tsEl.className = "gemini-msg-ts";
    el.appendChild(tsEl);
  }
  tsEl.textContent = timeStr;
}

/**
 * Build a short human-readable description from tool name + params object.
 */
function geminiToolDescription(name, params) {
  if (!params || typeof params !== "object") return "";
  const p = params;
  // Normalize tool name to lowercase for matching (handles PascalCase and snake_case)
  const n = (name || "").toLowerCase().replace(/_/g, "");
  switch (n) {
    case "read":
    case "readfile":
      return p.file_path || p.path || "";
    case "write":
    case "writefile":
      return p.file_path || p.path || "";
    case "edit":
    case "editfile":
      return p.file_path || p.path || "";
    case "glob":
    case "listfiles":
      return p.pattern || "";
    case "grep":
    case "search":
    case "searchfiles":
      return p.pattern || p.query || "";
    case "bash":
    case "shell":
    case "runcommand": {
      const cmd = p.command || p.cmd || "";
      return cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd;
    }
    case "websearch":
      return p.query || "";
    case "webfetch":
      return p.url || "";
    case "enterplanmode":
      return "Entering planning mode";
    case "exitplanmode":
      return "Plan ready for review";
    default: {
      // Try to find a single short string value to display
      const vals = Object.values(p).filter((v) => typeof v === "string" && v.length < 100);
      return vals.length === 1 ? vals[0] : "";
    }
  }
}

// --- Tool grouping helpers ---

function geminiGroupItemLabel(toolName, count) {
  const n = (toolName || "").toLowerCase().replace(/_/g, "");
  switch (n) {
    case "read": case "readfile": return count + " file" + (count !== 1 ? "s" : "");
    case "write": case "writefile": return count + " file" + (count !== 1 ? "s" : "");
    case "edit": case "editfile": return count + " edit" + (count !== 1 ? "s" : "");
    case "bash": case "shell": case "runcommand": return count + " command" + (count !== 1 ? "s" : "");
    case "grep": case "search": case "searchfiles": return count + " search" + (count !== 1 ? "es" : "");
    case "glob": case "listfiles": return count + " pattern" + (count !== 1 ? "s" : "");
    default: return count + " call" + (count !== 1 ? "s" : "");
  }
}

function geminiIsGroupableTool(toolName) {
  if (!toolName) return false;
  if (/^(ExitPlanMode|EnterPlanMode)$/i.test(toolName)) return false;
  if (/ask.*question|askfollowup|ask_followup/i.test(toolName)) return false;
  return true;
}

function geminiCreateToolGroup(toolName, isRunning) {
  const group = document.createElement("details");
  group.open = true;
  group.className = `gemini-tool gemini-tool-group${isRunning ? " running" : ""}`;
  group.dataset.toolName = toolName;
  group.addEventListener("toggle", () => { if (!group.open) group.open = true; });

  const summary = document.createElement("summary");
  summary.className = "gemini-tool-summary";
  summary.innerHTML =
    (isRunning ? `<span class="gemini-tool-spinner"></span>` : "") +
    `<span class="gemini-tool-name">${geminiEscHtml(toolName)}</span>` +
    `<span class="gemini-tool-group-count"></span>`;
  group.appendChild(summary);

  const itemsDiv = document.createElement("div");
  itemsDiv.className = "gemini-tool-group-items";
  group.appendChild(itemsDiv);

  return group;
}

function geminiMakeSubItem(toolName, toolId, params, isRunning, status, output) {
  const isError = status === "error";
  const sub = document.createElement("details");
  sub.className = `gemini-tool-sub${isRunning ? " running" : (isError ? " error" : " success")}`;
  sub.dataset.toolId = toolId || "";
  sub.dataset.toolName = toolName || "";

  const desc = geminiToolDescription(toolName, params);
  const summary = document.createElement("summary");
  summary.className = "gemini-tool-sub-summary";
  if (isRunning) {
    summary.innerHTML = `<span class="gemini-tool-spinner"></span>`;
  } else {
    const iconChar = isError ? "\u2717" : "\u2713";
    summary.innerHTML = `<span class="gemini-tool-icon ${isError ? "error" : "success"}">${iconChar}</span>`;
  }
  summary.innerHTML += `<span class="gemini-tool-sub-desc">${geminiEscHtml(desc || toolName || "")}</span>`;
  sub.appendChild(summary);

  if (!isRunning && !isError && /^edit$/i.test(toolName) && params && params.old_string != null) {
    geminiRenderEditDiffFromParams(sub, params);
  } else {
    const paramsStr = typeof params === "object" ? JSON.stringify(params, null, 2) : String(params || "");
    if (paramsStr && paramsStr !== "{}") {
      const sec = document.createElement("div");
      sec.className = "gemini-tool-section";
      sec.innerHTML = `<div class="gemini-tool-section-label">Parameters</div>`;
      const pre = document.createElement("pre");
      pre.textContent = paramsStr;
      sec.appendChild(pre);
      sub.appendChild(sec);
    }
  }

  if (!isRunning) {
    const trimmed = (output || "").trim();
    if (trimmed && !(!isError && /^edit$/i.test(toolName) && params?.old_string != null)) {
      const sec = document.createElement("div");
      sec.className = "gemini-tool-section";
      sec.innerHTML = `<div class="gemini-tool-section-label">${isError ? "Error" : "Output"}</div>`;
      const pre = document.createElement("pre");
      pre.textContent = trimmed.length > 5000 ? trimmed.slice(0, 5000) + "\n...(truncated)" : trimmed;
      sec.appendChild(pre);
      sub.appendChild(sec);
    }
  }

  return sub;
}

function geminiUpdateGroupSummary(groupEl) {
  const items = groupEl.querySelectorAll(":scope > .gemini-tool-group-items > .gemini-tool-sub");
  const total = items.length;
  let errors = 0, running = 0;
  items.forEach(item => {
    if (item.classList.contains("running")) running++;
    else if (item.classList.contains("error")) errors++;
  });

  const toolName = groupEl.dataset.toolName;
  const countEl = groupEl.querySelector(":scope > .gemini-tool-summary .gemini-tool-group-count");
  if (countEl) {
    let text = geminiGroupItemLabel(toolName, total);
    if (errors > 0 && running === 0) text += ` (${errors} error${errors > 1 ? "s" : ""})`;
    countEl.textContent = text;
  }

  const summary = groupEl.querySelector(":scope > .gemini-tool-summary");
  if (running === 0) {
    groupEl.classList.remove("running");
    const isAllError = errors > 0 && errors === total;
    groupEl.classList.add(isAllError ? "error" : "success");
    const spinner = summary?.querySelector(".gemini-tool-spinner");
    if (spinner) {
      const icon = document.createElement("span");
      icon.className = `gemini-tool-icon ${isAllError ? "error" : "success"}`;
      icon.textContent = isAllError ? "\u2717" : "\u2713";
      spinner.replaceWith(icon);
    } else if (summary && !summary.querySelector(".gemini-tool-icon")) {
      const icon = document.createElement("span");
      icon.className = `gemini-tool-icon ${isAllError ? "error" : "success"}`;
      icon.textContent = isAllError ? "\u2717" : "\u2713";
      const nameEl = summary.querySelector(".gemini-tool-name");
      if (nameEl) summary.insertBefore(icon, nameEl);
      else summary.prepend(icon);
    }
  }
}

function geminiUpdateSubItemResult(subItem, status, output, error) {
  const isError = status === "error" || !!error;
  subItem.classList.remove("running");
  subItem.classList.add(isError ? "error" : "success");

  const summary = subItem.querySelector(".gemini-tool-sub-summary");
  const spinner = summary?.querySelector(".gemini-tool-spinner");
  if (spinner) {
    const icon = document.createElement("span");
    icon.className = `gemini-tool-icon ${isError ? "error" : "success"}`;
    icon.textContent = isError ? "\u2717" : "\u2713";
    spinner.replaceWith(icon);
  }

  const toolName = subItem.dataset.toolName || "";

  if (!isError && /^edit$/i.test(toolName)) {
    geminiRenderEditDiff(subItem);
  }

  const trimmed = (error || output || "").trim();
  if (trimmed && !(!isError && /^edit$/i.test(toolName))) {
    const sec = document.createElement("div");
    sec.className = "gemini-tool-section";
    sec.innerHTML = `<div class="gemini-tool-section-label">${isError ? "Error" : "Output"}</div>`;
    const pre = document.createElement("pre");
    pre.textContent = trimmed.length > 5000 ? trimmed.slice(0, 5000) + "\n...(truncated)" : trimmed;
    sec.appendChild(pre);
    subItem.appendChild(sec);
  }

  const groupEl = subItem.closest(".gemini-tool-group");
  if (groupEl) geminiUpdateGroupSummary(groupEl);
}

function geminiShowApprovalPrompt(event) {
  const container = document.getElementById("gemini-messages");
  const div = document.createElement("div");
  div.className = "gemini-approval-prompt";
  const params = event.parameters || {};
  const paramsStr = JSON.stringify(params, null, 2);
  div.innerHTML = `
    <div class="gemini-approval-header">
      <span class="gemini-approval-icon">🔧</span>
      <span class="gemini-approval-tool">${geminiEscHtml(event.tool_name || "tool")}</span>
    </div>
    <pre class="gemini-approval-params">${geminiEscHtml(paramsStr)}</pre>
    <div class="gemini-approval-buttons">
      <button class="btn primary gemini-approve-btn">Approve</button>
      <button class="btn gemini-deny-btn">Deny</button>
    </div>`;
  const callId = event.call_id;
  div.querySelector(".gemini-approve-btn").onclick = () => {
    div.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    div.querySelector(".gemini-approval-buttons").innerHTML = '<span class="gemini-approval-resolved">✓ Approved</span>';
    geminiConfirmTool(callId, "proceed_once");
  };
  div.querySelector(".gemini-deny-btn").onclick = () => {
    div.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    div.querySelector(".gemini-approval-buttons").innerHTML = '<span class="gemini-approval-resolved denied">✗ Denied</span>';
    geminiConfirmTool(callId, "cancel");
  };
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function geminiConfirmTool(callId, outcome) {
  fetch(`/api/gemini/${encodeURIComponent(geminiWorkspace)}/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callId, outcome }),
  }).catch((e) => glog("confirmTool error:", e));
}

/**
 * Render a completed tool pill directly from history data (tool_use + tool_result combined).
 * Creates the pill in its final open state without the two-step running→done dance.
 */
/**
 * Render a completed AskUserQuestion in history.
 * Shows the question text, option buttons (disabled, with selected one marked), and status.
 */
function geminiRenderCompletedQuestion(params, output, status) {
  const container = document.getElementById("gemini-messages");
  const div = document.createElement("div");
  div.className = "gemini-permission-request";
  if (status === "error") div.classList.add("gemini-question-error");

  const headerEl = document.createElement("div");
  headerEl.className = "gemini-permission-header";
  headerEl.textContent = status === "error" ? "Question (failed)" : "Question";
  div.appendChild(headerEl);

  // Parse selected answers from output: "User has answered your questions: "Q"="A", "Q2"="B". You can..."
  const selectedAnswers = {};
  const answerMatches = (output || "").matchAll(/"([^"]+)"="([^"]+)"/g);
  for (const m of answerMatches) selectedAnswers[m[1]] = m[2];

  const questions = params.questions || [{ question: params.question || "", options: params.options || [] }];

  questions.forEach((q) => {
    const section = document.createElement("div");
    section.className = "gemini-question-section";

    if (q.question) {
      const qEl = document.createElement("div");
      qEl.className = "gemini-permission-question";
      qEl.textContent = q.question;
      section.appendChild(qEl);
    }

    const btns = document.createElement("div");
    btns.className = "gemini-permission-buttons";
    const rawOptions = q.options || [];

    if (rawOptions.length) {
      rawOptions.forEach((opt) => {
        const btn = document.createElement("button");
        const label = typeof opt === "object" ? (opt.label || String(opt)) : String(opt);
        const isSelected = selectedAnswers[q.question] === label || selectedAnswers[q.header] === label;
        btn.className = "btn" + (isSelected ? " selected" : " greyed");
        btn.textContent = label + (isSelected ? " \u2713" : "");
        btn.disabled = true;
        if (typeof opt === "object" && opt.description) btn.title = opt.description;
        btns.appendChild(btn);
      });
    } else if (Object.keys(selectedAnswers).length) {
      // No options defined — show the answer as text
      const key = q.question || q.header || Object.keys(selectedAnswers)[0];
      const answer = selectedAnswers[key];
      if (answer) {
        const ansEl = document.createElement("div");
        ansEl.className = "gemini-permission-question";
        ansEl.style.fontStyle = "italic";
        ansEl.textContent = answer;
        section.appendChild(ansEl);
      }
    }

    if (btns.children.length) section.appendChild(btns);
    div.appendChild(section);
  });

  container.appendChild(div);
}

function geminiRenderCompletedTool(toolName, toolId, params, status, output) {
  const container = document.getElementById("gemini-messages");

  // Check if we can group with previous element
  if (geminiIsGroupableTool(toolName)) {
    const lastEl = container.lastElementChild;
    if (lastEl && lastEl.dataset.toolName === toolName) {
      if (lastEl.classList.contains("gemini-tool-group")) {
        const itemsDiv = lastEl.querySelector(".gemini-tool-group-items");
        itemsDiv.appendChild(geminiMakeSubItem(toolName, toolId, params, false, status, output));
        geminiUpdateGroupSummary(lastEl);
        geminiScrollToBottom();
        return;
      }
      if (lastEl.classList.contains("gemini-tool") && !lastEl.classList.contains("gemini-tool-group")) {
        const group = geminiCreateToolGroup(toolName, false);
        const itemsDiv = group.querySelector(".gemini-tool-group-items");
        itemsDiv.appendChild(geminiMakeSubItem(
          lastEl.dataset.toolName, lastEl.dataset.toolId,
          lastEl._toolParams || {}, false, lastEl._toolStatus || "success", lastEl._toolOutput || ""
        ));
        itemsDiv.appendChild(geminiMakeSubItem(toolName, toolId, params, false, status, output));
        geminiUpdateGroupSummary(group);
        container.replaceChild(group, lastEl);
        geminiScrollToBottom();
        return;
      }
    }
  }

  const isError = status === "error";
  const pill = document.createElement("details");
  pill.open = true;
  pill.className = `gemini-tool ${isError ? "error" : "success"}`;
  pill.dataset.toolId = toolId || "";
  pill.dataset.toolName = toolName || "";
  pill._toolParams = params;
  pill._toolOutput = output || "";
  pill._toolStatus = status;
  pill.addEventListener("toggle", () => { if (!pill.open) pill.open = true; });

  const desc = geminiToolDescription(toolName, params);
  const summary = document.createElement("summary");
  summary.className = "gemini-tool-summary";
  const icon = isError ? "\u2717" : "\u2713";
  summary.innerHTML =
    `<span class="gemini-tool-icon ${isError ? "error" : "success"}">${icon}</span>` +
    `<span class="gemini-tool-name">${geminiEscHtml(toolName || "tool")}</span>` +
    (desc ? `<span class="gemini-tool-desc">${geminiEscHtml(desc)}</span>` : "");
  pill.appendChild(summary);

  // Edit tool: show diff instead of raw params
  if (!isError && /^edit$/i.test(toolName) && params && params.old_string != null) {
    geminiRenderEditDiffFromParams(pill, params);
  } else {
    const paramsStr = typeof params === "object" ? JSON.stringify(params, null, 2) : String(params || "");
    if (paramsStr && paramsStr !== "{}") {
      const sec = document.createElement("div");
      sec.className = "gemini-tool-section";
      sec.innerHTML = `<div class="gemini-tool-section-label">Parameters</div>`;
      const pre = document.createElement("pre");
      pre.textContent = paramsStr;
      sec.appendChild(pre);
      pill.appendChild(sec);
    }
  }

  const trimmed = (output || "").trim();
  // Skip output for successful Edit diffs — the diff itself is the output
  if (trimmed && !(!isError && /^edit$/i.test(toolName) && params?.old_string != null)) {
    const sec = document.createElement("div");
    sec.className = "gemini-tool-section";
    sec.innerHTML = `<div class="gemini-tool-section-label">${isError ? "Error" : "Output"}</div>`;
    const pre = document.createElement("pre");
    pre.textContent = trimmed.length > 5000 ? trimmed.slice(0, 5000) + "\n...(truncated)" : trimmed;
    sec.appendChild(pre);
    pill.appendChild(sec);
  }

  container.appendChild(pill);
  geminiScrollToBottom();
}

/**
 * Append a tool-use pill. Starts in a "running" state with a spinner.
 * Shows tool name + short description inline.
 * Full params are always visible in the body.
 */
function geminiAppendToolUse(toolName, toolId, params) {
  const container = document.getElementById("gemini-messages");

  // Check if we can group with previous element
  if (geminiIsGroupableTool(toolName)) {
    const lastEl = container.lastElementChild;
    if (lastEl && lastEl.dataset.toolName === toolName) {
      if (lastEl.classList.contains("gemini-tool-group")) {
        const itemsDiv = lastEl.querySelector(".gemini-tool-group-items");
        itemsDiv.appendChild(geminiMakeSubItem(toolName, toolId, params, true, null, null));
        geminiUpdateGroupSummary(lastEl);
        geminiScrollToBottom();
        return;
      }
      if (lastEl.classList.contains("gemini-tool") && !lastEl.classList.contains("gemini-tool-group")) {
        const group = geminiCreateToolGroup(toolName, true);
        const itemsDiv = group.querySelector(".gemini-tool-group-items");
        const existingRunning = lastEl.classList.contains("running");
        const existingStatus = existingRunning ? null : (lastEl.classList.contains("error") ? "error" : "success");
        itemsDiv.appendChild(geminiMakeSubItem(
          lastEl.dataset.toolName, lastEl.dataset.toolId,
          lastEl._toolParams || {}, existingRunning, existingStatus,
          existingRunning ? null : (lastEl._toolOutput || "")
        ));
        itemsDiv.appendChild(geminiMakeSubItem(toolName, toolId, params, true, null, null));
        geminiUpdateGroupSummary(group);
        container.replaceChild(group, lastEl);
        geminiScrollToBottom();
        return;
      }
    }
  }

  const pill = document.createElement("details");
  pill.open = true;
  pill.className = "gemini-tool running";
  pill.dataset.toolId = toolId;
  pill.dataset.toolName = toolName;
  pill._toolParams = params;
  pill.addEventListener("toggle", () => { if (!pill.open) pill.open = true; });

  const desc = geminiToolDescription(toolName, params);
  const summary = document.createElement("summary");
  summary.className = "gemini-tool-summary";
  summary.innerHTML =
    `<span class="gemini-tool-spinner"></span>` +
    `<span class="gemini-tool-name">${geminiEscHtml(toolName)}</span>` +
    (desc ? `<span class="gemini-tool-desc">${geminiEscHtml(desc)}</span>` : "");
  pill.appendChild(summary);

  const paramsStr = typeof params === "object" ? JSON.stringify(params, null, 2) : String(params || "");
  if (paramsStr && paramsStr !== "{}") {
    const sec = document.createElement("div");
    sec.className = "gemini-tool-section";
    sec.innerHTML = `<div class="gemini-tool-section-label">Parameters</div>`;
    const pre = document.createElement("pre");
    pre.textContent = paramsStr;
    sec.appendChild(pre);
    pill.appendChild(sec);
  }

  container.appendChild(pill);
  geminiScrollToBottom();
}

/**
 * Update a tool pill with its result and mark it done.
 * Matches by tool_id. Output is always visible in the body.
 */
function geminiUpdateToolResult(toolId, status, output, error) {
  const container = document.getElementById("gemini-messages");

  // Check if tool is a sub-item in a group
  if (toolId) {
    const subItem = container.querySelector(`.gemini-tool-group .gemini-tool-sub[data-tool-id="${CSS.escape(toolId)}"]`);
    if (subItem) {
      geminiUpdateSubItemResult(subItem, status, output, error);
      geminiScrollToBottom();
      return;
    }
  }

  // Find by tool_id first, fall back to last running pill
  let pill = toolId
    ? container.querySelector(`.gemini-tool.running[data-tool-id="${CSS.escape(toolId)}"]`)
    : null;
  if (!pill) {
    const running = container.querySelectorAll(".gemini-tool.running");
    pill = running.length ? running[running.length - 1] : null;
  }

  const isError = status === "error" || !!error;

  if (pill) {
    pill.classList.remove("running");
    pill.classList.add(isError ? "error" : "success");
    pill._toolOutput = (error || output || "");
    pill._toolStatus = isError ? "error" : "success";

    // Replace spinner with status icon
    const summaryEl = pill.querySelector(".gemini-tool-summary");
    if (summaryEl) {
      const spinner = summaryEl.querySelector(".gemini-tool-spinner");
      if (spinner) {
        const icon = document.createElement("span");
        icon.className = isError ? "gemini-tool-icon error" : "gemini-tool-icon success";
        icon.textContent = isError ? "\u2717" : "\u2713";
        spinner.replaceWith(icon);
      }
    }

    const toolName = pill.dataset.toolName || "";

    // For Edit tool: replace raw params with a color diff
    if (!isError && /^edit$/i.test(toolName)) {
      geminiRenderEditDiff(pill);
    }

    // Append output section (skip for Edit — the diff is the output)
    const trimmed = (error || output || "").trim();
    if (trimmed && !(!isError && /^edit$/i.test(toolName))) {
      const section = document.createElement("div");
      section.className = "gemini-tool-section";
      section.innerHTML = `<div class="gemini-tool-section-label">${isError ? "Error" : "Output"}</div>`;
      const pre = document.createElement("pre");
      pre.textContent = trimmed.length > 5000 ? trimmed.slice(0, 5000) + "\n...(truncated)" : trimmed;
      section.appendChild(pre);
      pill.appendChild(section);
    }
  } else {
    // No matching pill — standalone fallback
    const pill2 = document.createElement("details");
    pill2.open = true;
    pill2.className = `gemini-tool ${isError ? "error" : "success"}`;
    pill2.addEventListener("toggle", () => { if (!pill2.open) pill2.open = true; });
    const summary = document.createElement("summary");
    summary.className = "gemini-tool-summary";
    const icon = isError ? "\u2717" : "\u2713";
    summary.innerHTML =
      `<span class="gemini-tool-icon ${isError ? "error" : "success"}">${icon}</span>` +
      `<span class="gemini-tool-name">${geminiEscHtml(toolId || "tool")}</span>` +
      `<span class="gemini-tool-desc">(result)</span>`;
    pill2.appendChild(summary);
    const pre = document.createElement("pre");
    pre.textContent = error || output || "";
    pill2.appendChild(pre);
    container.appendChild(pill2);
  }

  geminiScrollToBottom();
}

function geminiEscHtml(str) {
  const el = document.createElement("span");
  el.textContent = str;
  return el.innerHTML;
}

function geminiAppendError(message) {
  const container = document.getElementById("gemini-messages");
  const div = document.createElement("div");
  div.className = "gemini-msg error";
  div.textContent = message;
  container.appendChild(div);
  geminiScrollToBottom();
}

/**
 * Render a color diff for an Edit tool pill.
 * Extracts old_string/new_string from the pill's stored params and replaces
 * the Parameters section with a unified diff view.
 */
function geminiRenderEditDiff(pill) {
  // Parse params from the pre element in the Parameters section
  const paramSection = pill.querySelector(".gemini-tool-section");
  if (!paramSection) return;
  const paramPre = paramSection.querySelector("pre");
  if (!paramPre) return;
  let params;
  try { params = JSON.parse(paramPre.textContent); } catch { return; }

  const oldStr = params.old_string || "";
  const newStr = params.new_string || "";
  const filePath = params.file_path || "";

  // Replace the params section with a diff view
  paramSection.innerHTML = "";
  const label = document.createElement("div");
  label.className = "gemini-tool-section-label";
  label.textContent = filePath || "Diff";
  paramSection.appendChild(label);

  const diffEl = document.createElement("pre");
  diffEl.className = "gemini-diff";

  // Build simple unified diff lines
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");

  oldLines.forEach(line => {
    const span = document.createElement("span");
    span.className = "diff-removed";
    span.textContent = "- " + line + "\n";
    diffEl.appendChild(span);
  });
  newLines.forEach(line => {
    const span = document.createElement("span");
    span.className = "diff-added";
    span.textContent = "+ " + line + "\n";
    diffEl.appendChild(span);
  });

  paramSection.appendChild(diffEl);
}

/**
 * Render a diff for Edit tool in completed tool history (non-live).
 * Called from geminiRenderCompletedTool when tool_name is Edit.
 */
function geminiRenderEditDiffFromParams(pill, params) {
  const oldStr = params.old_string || "";
  const newStr = params.new_string || "";
  const filePath = params.file_path || "";

  const sec = document.createElement("div");
  sec.className = "gemini-tool-section";
  const label = document.createElement("div");
  label.className = "gemini-tool-section-label";
  label.textContent = filePath || "Diff";
  sec.appendChild(label);

  const diffEl = document.createElement("pre");
  diffEl.className = "gemini-diff";
  (oldStr.split("\n")).forEach(line => {
    const span = document.createElement("span");
    span.className = "diff-removed";
    span.textContent = "- " + line + "\n";
    diffEl.appendChild(span);
  });
  (newStr.split("\n")).forEach(line => {
    const span = document.createElement("span");
    span.className = "diff-added";
    span.textContent = "+ " + line + "\n";
    diffEl.appendChild(span);
  });
  sec.appendChild(diffEl);
  pill.appendChild(sec);
}

/** Render a collapsible thinking block (extended thinking / chain-of-thought). */
function geminiAppendThinkingBlock(content) {
  const container = document.getElementById("gemini-messages");
  // Append to existing thinking block if one is open (streaming)
  const existing = container.querySelector("details.gemini-thinking-block:last-child");
  if (existing && existing.open) {
    const body = existing.querySelector(".gemini-thinking-body");
    if (body) {
      body.textContent += content;
      geminiScrollToBottom();
      return;
    }
  }
  const details = document.createElement("details");
  details.className = "gemini-thinking-block";
  const summary = document.createElement("summary");
  summary.textContent = "Thinking\u2026";
  details.appendChild(summary);
  const body = document.createElement("div");
  body.className = "gemini-thinking-body";
  body.textContent = content;
  details.appendChild(body);
  container.appendChild(details);
  geminiScrollToBottom();
}

/** Show a thin system note (compaction, permission mode change, etc.). */
function geminiAppendSystemNote(text) {
  const container = document.getElementById("gemini-messages");
  const div = document.createElement("div");
  div.className = "gemini-system-note";
  div.textContent = text;
  container.appendChild(div);
  geminiScrollToBottom();
}

/** Show a background task card. */
function geminiAppendTaskCard(taskId, description, status) {
  const container = document.getElementById("gemini-messages");
  const div = document.createElement("div");
  div.className = "gemini-task-card running";
  div.dataset.taskId = taskId;
  div.innerHTML =
    `<span class="gemini-task-status">\u21BB Running</span>` +
    `<span class="gemini-task-desc">${geminiEscHtml(description)}</span>` +
    `<div class="gemini-task-detail"></div>`;
  container.appendChild(div);
  geminiScrollToBottom();
}

/** Show cost/token/duration footer after a turn completes. */
function geminiShowResultFooter(stats, subtype, errors) {
  if (!stats && !subtype) return;
  const container = document.getElementById("gemini-messages");

  // Show error banner for non-success results
  if (subtype && subtype !== "success") {
    const errorDiv = document.createElement("div");
    errorDiv.className = "gemini-result-error";
    if (subtype === "error_max_turns") {
      errorDiv.textContent = "Claude reached the maximum number of turns" + (stats?.turns ? ` (${stats.turns})` : "");
    } else if (subtype === "error_max_budget_usd") {
      errorDiv.textContent = "Claude exceeded the budget limit" + (stats?.cost ? ` ($${stats.cost.toFixed(2)})` : "");
    } else if (subtype === "error_during_execution") {
      errorDiv.textContent = "Error during execution";
      if (errors?.length) errorDiv.textContent += ": " + errors.map(e => e.message || e).join("; ");
    } else if (subtype === "error_insufficient_context") {
      errorDiv.textContent = "Claude ran out of context window";
    } else if (subtype === "error_permission_denied") {
      errorDiv.textContent = "Permission was denied";
    } else if (subtype === "error_model_unavailable") {
      errorDiv.textContent = "Model is currently unavailable";
    } else if (subtype === "interrupted") {
      errorDiv.textContent = "Turn was interrupted";
      errorDiv.className = "gemini-result-error interrupted";
    } else {
      errorDiv.textContent = "Turn ended: " + subtype;
    }
    container.appendChild(errorDiv);
  }

  // Show cost/token stats as a subtle footer
  if (stats && (stats.cost != null || stats.total_tokens || stats.duration_ms)) {
    const parts = [];
    if (stats.cost != null) parts.push("$" + stats.cost.toFixed(4));
    if (stats.total_tokens) parts.push(stats.total_tokens >= 1000 ? (stats.total_tokens / 1000).toFixed(1) + "k tokens" : stats.total_tokens + " tokens");
    if (stats.duration_ms) parts.push((stats.duration_ms / 1000).toFixed(1) + "s");
    if (parts.length) {
      const footer = document.createElement("div");
      footer.className = "gemini-result-footer";
      footer.textContent = parts.join(" \u00B7 ");
      container.appendChild(footer);
    }
  }
}

function geminiScrollToBottom() {
  const container = document.getElementById("gemini-messages");
  if (container) {
    container.scrollTop = container.scrollHeight;
  }
}

function geminiRenderMarkdown(text) {
  if (typeof marked !== "undefined" && marked.parse) {
    try {
      return marked.parse(text);
    } catch {
      // Fall back to plain text
    }
  }
  // Fallback: escape HTML and convert newlines
  const el = document.createElement("span");
  el.textContent = text;
  return el.innerHTML.replace(/\n/g, "<br>");
}

// --- Auth UI ---

// Active OAuth polling timer (so we can cancel it)
let geminiAuthPollTimer = null;

function geminiShowAuthPanel() {
  const container = document.getElementById("gemini-messages");
  container.innerHTML = "";

  // Hide workspace-scoped option when opened without a workspace (e.g. from auth dot)
  const showWorkspaceScope = !!geminiWorkspace;
  const isClaude = geminiActiveCli === "claude";

  const panel = document.createElement("div");
  panel.className = "gemini-auth-panel";

  if (isClaude) {
    panel.innerHTML = `
      <h3>Claude Authentication Required</h3>
      <p>Choose how to authenticate with Claude CLI:</p>
      <div class="gemini-auth-options">
        <div class="gemini-auth-option">
          <h4>Login via CLI</h4>
          <p>Run <code>claude auth login</code> in your terminal to authenticate.</p>
        </div>
        <div class="gemini-auth-option">
          <h4>Use API Key</h4>
          <p>Enter an <code>ANTHROPIC_API_KEY</code> from <a href="https://console.anthropic.com/settings/keys" target="_blank">Anthropic Console</a>.</p>
          <div class="gemini-auth-key-form">
            <input type="password" id="gemini-apikey-input" placeholder="Paste API key..." />
            ${showWorkspaceScope ? `
            <div class="gemini-auth-key-scope">
              <label><input type="radio" name="gemini-key-scope" value="global" checked /> Global (all workspaces)</label>
              <label><input type="radio" name="gemini-key-scope" value="workspace" /> This workspace only</label>
            </div>
            ` : ""}
            <button class="btn primary" onclick="geminiSaveApiKey()">Save Key</button>
          </div>
        </div>
      </div>
    `;
  } else {
    panel.innerHTML = `
      <h3>Gemini Authentication Required</h3>
      <p>Choose how to authenticate with Gemini CLI:</p>
      <div class="gemini-auth-options">
        <div class="gemini-auth-option">
          <h4>Login with Google</h4>
          <p>Opens your browser to complete the Google OAuth flow.</p>
          <button class="btn primary" id="gemini-oauth-btn" onclick="geminiStartOAuthLogin()">Login with Google</button>
          <div id="gemini-oauth-status" class="gemini-auth-status hidden"></div>
        </div>
        <div class="gemini-auth-option">
          <h4>Use API Key</h4>
          <p>Enter a <code>GEMINI_API_KEY</code> from <a href="https://aistudio.google.com/apikey" target="_blank">Google AI Studio</a>.</p>
          <div class="gemini-auth-key-form">
            <input type="password" id="gemini-apikey-input" placeholder="Paste API key..." />
            ${showWorkspaceScope ? `
            <div class="gemini-auth-key-scope">
              <label><input type="radio" name="gemini-key-scope" value="global" checked /> Global (all workspaces)</label>
              <label><input type="radio" name="gemini-key-scope" value="workspace" /> This workspace only</label>
            </div>
            ` : ""}
            <button class="btn primary" onclick="geminiSaveApiKey()">Save Key</button>
          </div>
        </div>
      </div>
    `;
  }
  container.appendChild(panel);
}

async function geminiStartOAuthLogin() {
  const btn = document.getElementById("gemini-oauth-btn");
  const status = document.getElementById("gemini-oauth-status");

  // Disable button, show waiting state
  if (btn) btn.disabled = true;
  if (status) {
    status.classList.remove("hidden");
    status.innerHTML = '<span class="gemini-auth-spinner"></span> Opening browser...';
  }

  try {
    const res = await fetch("/api/gemini/auth/login", { method: "POST" });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || "Failed to start login");

    if (data.alreadyAuthenticated) {
      // Already logged in — go straight to chat
      if (geminiWorkspace) {
        geminiShowChat();
      } else {
        closeGeminiChat();
        if (typeof refresh === "function") refresh();
      }
      return;
    }

    // Browser should be open now — poll for auth completion
    if (status) {
      status.innerHTML = '<span class="gemini-auth-spinner"></span> Waiting for authentication to complete...';
    }

    geminiPollAuthCompletion();

  } catch (err) {
    if (btn) btn.disabled = false;
    if (status) {
      status.classList.remove("hidden");
      status.innerHTML = `Failed to open login. Try running <code>gemini</code> in your terminal to authenticate manually.`;
    }
  }
}

function geminiPollAuthCompletion() {
  // Clear any existing poll
  if (geminiAuthPollTimer) clearInterval(geminiAuthPollTimer);

  let elapsed = 0;
  const interval = 2000;
  const timeout = 5 * 60 * 1000; // 5 min

  geminiAuthPollTimer = setInterval(async () => {
    elapsed += interval;

    if (elapsed >= timeout) {
      clearInterval(geminiAuthPollTimer);
      geminiAuthPollTimer = null;
      const status = document.getElementById("gemini-oauth-status");
      const btn = document.getElementById("gemini-oauth-btn");
      if (status) status.innerHTML = `Timed out. Try again, or run <code>gemini</code> in your terminal to authenticate manually.`;
      if (btn) btn.disabled = false;
      return;
    }

    try {
      const res = await fetch("/api/gemini/auth/recheck", { method: "POST" });
      const data = await res.json();

      if (data.loggedIn) {
        clearInterval(geminiAuthPollTimer);
        geminiAuthPollTimer = null;

        if (geminiWorkspace) {
          geminiShowChat();
        } else {
          // Opened from auth dot with no workspace — just close and refresh dashboard
          closeGeminiChat();
          if (typeof refresh === "function") refresh();
        }
      }
    } catch {
      // Network error — keep polling
    }
  }, interval);
}

async function geminiSaveApiKey() {
  const input = document.getElementById("gemini-apikey-input");
  const key = input ? input.value.trim() : "";
  if (!key) return;

  const scope = document.querySelector('input[name="gemini-key-scope"]:checked');
  const isWorkspace = scope && scope.value === "workspace";

  try {
    const body = { apiKey: key };
    if (isWorkspace) body.workspace = geminiWorkspace;

    const keyEndpoint = geminiActiveCli === "claude" ? "/api/claude-chat/apikey" : "/api/gemini/apikey";
    const res = await fetch(keyEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to save key");

    // Key saved — refresh models (new key may unlock different models) and switch to chat
    geminiRefreshModels();
    geminiShowChat();
  } catch (err) {
    geminiAppendError("Failed to save API key: " + err.message);
  }
}

// Stop any in-progress stream-poll and remove the waiting indicator.
function geminiStopStreamPoll() {
  if (geminiStreamPollTimer) {
    clearInterval(geminiStreamPollTimer);
    geminiStreamPollTimer = null;
  }
  geminiRemoveThinking();
}

// Show "Waiting for response…" dots and poll history every 2 s until the
// in-flight assistant reply arrives (or the server says streaming is done).
/**
 * After a server restart/crash, check if new history entries appeared while
 * we were disconnected (written by recoverStreams) and render them.
 */
async function geminiRenderRecoveredContent() {
  const ws = geminiWorkspace;
  const sn = geminiSessionNum;
  const knownLen = (geminiHistory[ws] || []).length;
  // Always remove the "Connection lost" banner — we're reconnected regardless of content
  const container = document.getElementById("gemini-messages");
  const lastEl = container?.lastElementChild;
  if (lastEl?.classList.contains("gemini-error")) lastEl.remove();
  // Give the server a moment to finish recovery before fetching
  await new Promise(r => setTimeout(r, 600));
  try {
    const history = await geminiFetchHistory(ws, sn);
    const newMsgs = history.slice(knownLen);
    if (newMsgs.length === 0) {
      glog("recovery-check: no new content");
      return;
    }
    glog(`recovery-check: rendering ${newMsgs.length} recovered message(s)`);

    const pendingToolUses = new Map();
    for (const msg of newMsgs) {
      if (msg.role === "tool_use") {
        try { const d = JSON.parse(msg.content); pendingToolUses.set(d.tool_id, d); } catch {}
      } else if (msg.role === "tool_result") {
        try {
          const d = JSON.parse(msg.content);
          const tu = pendingToolUses.get(d.tool_id);
          if (tu) pendingToolUses.delete(d.tool_id);
          const tName = tu ? tu.tool_name : (d.tool_name || "tool");
          if (/ask.*question/i.test(tName)) {
            geminiRenderCompletedQuestion(tu ? tu.parameters : {}, d.output || "", d.status);
          } else {
            geminiRenderCompletedTool(tName, d.tool_id, tu ? tu.parameters : {}, d.status, d.output);
          }
        } catch {}
      } else {
        geminiAppendMessage(msg.role, msg.content, false, null, msg.ts, msg.sender);
      }
    }
    for (const tu of pendingToolUses.values()) geminiAppendToolUse(tu.tool_name, tu.tool_id, tu.parameters);
    geminiHistory[ws] = history;
    geminiScrollToBottom();
  } catch (e) {
    glog("recovery-check: error", e.message);
  }
}

function geminiStartStreamPoll(historyLengthAtOpen) {
  geminiStopStreamPoll();
  geminiShowThinking();

  const ws = geminiWorkspace;
  const sn = geminiSessionNum;

  // Immediately show partial content so the user sees what was generated before they left
  fetch(`/api/gemini/stream-partial/${encodeURIComponent(ws)}`)
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (!data || !data.text || geminiWorkspace !== ws) return;
      geminiRemoveThinking();
      geminiPartialMsgEl = geminiAppendMessage("assistant", data.text, true, null, null);
      geminiShowThinking();
    })
    .catch(() => {});

  geminiStreamPollTimer = setInterval(async () => {
    try {
      // Fetch history and latest partial content in parallel
      const [history, partialData] = await Promise.all([
        geminiFetchHistory(ws, sn),
        fetch(`/api/gemini/stream-partial/${encodeURIComponent(ws)}`).then(r => r.ok ? r.json() : null).catch(() => null),
      ]);

      // Keep partial bubble in sync with what's been generated so far
      if (partialData && partialData.text) {
        if (geminiPartialMsgEl) {
          const mdEl = geminiPartialMsgEl.querySelector(".md-content");
          if (mdEl) {
            mdEl.innerHTML = geminiRenderMarkdown(partialData.text);
            geminiScrollToBottom();
          }
        } else if (geminiWorkspace === ws) {
          geminiRemoveThinking();
          geminiPartialMsgEl = geminiAppendMessage("assistant", partialData.text, true, null, null);
          geminiShowThinking();
        }
      }

      if (history.length > historyLengthAtOpen) {
        geminiStopStreamPoll();
        // Remove the partial bubble — render fresh from server history
        if (geminiPartialMsgEl) { geminiPartialMsgEl.remove(); geminiPartialMsgEl = null; }
        const newMsgs = history.slice(historyLengthAtOpen);
        const container = document.getElementById("gemini-messages");
        const pendingToolUses = new Map();
        for (const msg of newMsgs) {
          if (msg.role === "tool_use") {
            try {
              const d = JSON.parse(msg.content);
              pendingToolUses.set(d.tool_id, d);
            } catch { /* ignore */ }
          } else if (msg.role === "tool_result") {
            try {
              const d = JSON.parse(msg.content);
              const tu = d.tool_id ? pendingToolUses.get(d.tool_id) : null;
              if (tu) pendingToolUses.delete(d.tool_id);
              const tName = tu ? tu.tool_name : (d.tool_name || "tool");
              if (/ask.*question/i.test(tName)) {
                geminiRenderCompletedQuestion(tu ? tu.parameters : {}, d.output || "", d.status);
              } else {
                geminiRenderCompletedTool(tName, d.tool_id, tu ? tu.parameters : {}, d.status, d.output);
              }
            } catch { /* ignore */ }
          } else {
            geminiAppendMessage(msg.role, msg.content, false, null, msg.ts, msg.sender);
          }
        }
        for (const tu of pendingToolUses.values()) {
          geminiAppendToolUse(tu.tool_name, tu.tool_id, tu.parameters);
        }
        geminiSetStreaming(false);
        container.scrollTop = container.scrollHeight;
        return;
      }
      // Also bail if the server says streaming stopped (e.g. error or done)
      const wsRes = await fetch(`/api/workspace-state/${encodeURIComponent(ws)}`);
      const wsState = await wsRes.json();
      if (!wsState.streaming) {
        geminiStopStreamPoll();
        // Leave partial content visible if no new history — something ended without persisting
        if (geminiPartialMsgEl) {
          geminiPartialMsgEl.classList.remove("gemini-streaming");
          geminiPartialMsgEl = null;
        }
        geminiSetStreaming(false);
      }
    } catch { /* ignore transient poll errors */ }
  }, 2000);
}

async function geminiShowChat(wsState = null) {
  glog("showChat: workspace=" + geminiWorkspace + " session#" + geminiSessionNum);
  const workspaceAtCall = geminiWorkspace;
  const container = document.getElementById("gemini-messages");
  container.innerHTML = "";

  // Fetch sessions list and conversation history in parallel
  if (geminiWorkspace) {
    const sessionNumAtCall = geminiSessionNum;
    const [, history] = await Promise.all([
      geminiFetchSessions(geminiWorkspace),
      geminiFetchHistory(geminiWorkspace, sessionNumAtCall),
    ]);
    // Bail out if workspace changed during async fetch (user switched workspaces)
    if (geminiWorkspace !== workspaceAtCall) {
      glog("showChat: workspace changed during fetch, aborting stale render");
      return;
    }
    const pendingToolUses = new Map();
    for (const msg of history) {
      if (msg.role === "tool_use") {
        try {
          const d = JSON.parse(msg.content);
          pendingToolUses.set(d.tool_id, d);
        } catch { /* ignore */ }
      } else if (msg.role === "tool_result") {
        try {
          const d = JSON.parse(msg.content);
          const tu = d.tool_id ? pendingToolUses.get(d.tool_id) : null;
          if (tu) pendingToolUses.delete(d.tool_id);
          const name = tu ? tu.tool_name : (d.tool_name || "tool");
          // ExitPlanMode: render as plan card instead of generic tool pill
          if (name === "ExitPlanMode") {
            geminiShowPlanApproval(d.tool_id, (tu ? tu.parameters : {}).plan || d.output || "", false);
            const card = document.querySelector(".gemini-plan-approval:last-child");
            if (card) {
              card.classList.add("approved");
              card.querySelector(".gemini-plan-header").textContent = "Plan";
              card.querySelectorAll("button").forEach(b => { b.disabled = true; b.style.display = "none"; });
            }
          } else if (/ask.*question/i.test(name)) {
            // AskUserQuestion: render completed question card with selected answer
            geminiRenderCompletedQuestion(tu ? tu.parameters : {}, d.output || "", d.status);
          } else {
            geminiRenderCompletedTool(name, d.tool_id, tu ? tu.parameters : {}, d.status, d.output);
          }
        } catch { /* ignore */ }
      } else {
        // Render non-tool messages immediately but keep pendingToolUses alive —
        // tool_result may arrive after intervening assistant/user messages due to
        // batch boundaries from synthetic result events.
        geminiAppendMessage(msg.role, msg.content, false, null, msg.ts, msg.sender);
      }
    }
    // Flush any tool_uses that never got a result.
    // If we're not currently streaming, these are orphaned/stale — render as completed.
    // If we ARE streaming, they may still be in-progress — render as running.
    const isCurrentlyStreaming = wsState?.streaming || geminiStreaming;
    for (const tu of pendingToolUses.values()) {
      if (tu.tool_name === "ExitPlanMode") {
        geminiShowPlanApproval(tu.tool_id, tu.parameters.plan || "");
      } else if (isCurrentlyStreaming) {
        geminiAppendToolUse(tu.tool_name, tu.tool_id, tu.parameters);
      } else {
        // Orphaned — render as a completed tool with no output
        geminiRenderCompletedTool(tu.tool_name, tu.tool_id, tu.parameters, "interrupted", "");
      }
    }

    // If the server has a pending permission_request (e.g. from relay replay after
    // restart), show it now so Claude isn't blocked indefinitely.
    if (wsState && wsState.pendingPermission) {
      const pp = wsState.pendingPermission;
      glog("showChat: restoring pending permission_request", pp.tool_name, pp.request_id);
      handleGeminiEvent({ ...pp, workspace: geminiWorkspace });
    }

    // If a stream was in-flight when we opened, poll until the reply lands.
    // Leave streaming=true so the input stays disabled while we wait.
    if (geminiOpenedWhileStreaming) {
      geminiOpenedWhileStreaming = false;
      const lastMsg = history[history.length - 1];
      if (lastMsg && lastMsg.role === "user") {
        geminiSetStreaming(true);
        geminiStartStreamPoll(history.length);
        // Skip the geminiSetStreaming(false) below — poll completion handles it
        const input = document.getElementById("gemini-input");
        if (input) await geminiRestoreDraft(wsState);
        return;
      }
    }
  }

  // Enable input and restore draft (pass pre-fetched state to avoid a duplicate round-trip)
  geminiSetStreaming(false);
  const input = document.getElementById("gemini-input");
  if (input) {
    await geminiRestoreDraft(wsState);
    input.focus();
  }
}

// --- Overlay controls ---

async function openGeminiChat(project, projectPath, cli) {
  geminiActiveCli = cli || "gemini";
  glog(`openChat: project=${project} path=${projectPath} cli=${geminiActiveCli}`);

  // Flush draft for the previous workspace before switching (handles direct
  // workspace-to-workspace clicks that skip closeGeminiChat).
  const prevWorkspace = geminiWorkspace;
  if (prevWorkspace && prevWorkspace !== project) {
    // Cancel any pending debounced draft save for the old workspace
    clearTimeout(geminiDraftTimer);
    const input = document.getElementById("gemini-input");
    if (input && input.value) {
      // Save immediately via HTTP (bypass debounce) so the draft isn't lost
      const draftMode = geminiActiveCli === "claude" ? "claude-local" : "gemini";
      fetch(`/api/workspace-state/${encodeURIComponent(prevWorkspace)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draft: input.value, draftMode, draftSession: geminiSessionNum }),
      }).catch(() => {});
    }
    // Clear input immediately so the old draft doesn't flash in the new workspace
    if (input) input.value = "";
  }

  geminiWorkspace = project || null;
  geminiWorkspacePath = projectPath || null;

  // Clear typing guard so draft restoration isn't blocked
  geminiLocalDraftActive = false;
  clearTimeout(geminiLocalDraftTimeout);

  // Check if this is an agent chat (set by openAgentChat in app.js)
  geminiAgentRole = window._agentRole || null;

  const cliLabel = geminiActiveCli === "claude" ? "Claude" : "Gemini";

  // Set title — show agent role label when in agent chat mode
  if (geminiAgentRole) {
    const roleLabel = geminiAgentRole.charAt(0).toUpperCase() + geminiAgentRole.slice(1);
    document.getElementById("gemini-title").innerHTML =
      `<span class="agent-role-badge ${geminiAgentRole}">${roleLabel}</span>`;
  } else if (project) {
    const parts = project.split("--");
    const repo = parts[0];
    const branch = parts.length > 1 ? parts.slice(1).join("--") : null;
    document.getElementById("gemini-title").innerHTML =
      `<span>${cliLabel}</span> <span style="font-weight:400;color:var(--text-faint)">${esc(repo)}${branch ? " / " + esc(branch) : ""}</span>`;
  } else {
    document.getElementById("gemini-title").innerHTML = `<span>${cliLabel}</span>`;
  }

  // Update placeholder
  const inputEl = document.getElementById("gemini-input");
  const placeholderName = geminiAgentRole
    ? geminiAgentRole.charAt(0).toUpperCase() + geminiAgentRole.slice(1)
    : cliLabel;
  if (inputEl) inputEl.placeholder = `Message ${placeholderName}...`;

  // Reset streaming state and image attachments
  geminiCurrentMsgEl = null;
  geminiCurrentMsgText = "";
  geminiPartialMsgEl = null;
  geminiSetStreaming(false);
  geminiClearImages();
  geminiUpdateAttachVisibility();
  geminiUpdatePermissionVisibility();
  geminiRestorePermissionMode();

  // Restore last session from server state (non-blocking — geminiShowChat uses it)
  geminiSessionNum = null;
  let wsState = null;
  if (project) {
    try {
      const wsRes = await fetch(`/api/workspace-state/${encodeURIComponent(project)}`);
      wsState = await wsRes.json();
      const stateMode = geminiActiveCli === "claude" ? "claude-local" : "gemini";
      if (wsState.sessionNum != null) {
        geminiSessionNum = wsState.sessionNum;
        glog(`openChat: restoring session#${geminiSessionNum} from server state`);
      }
      geminiOpenedWhileStreaming = wsState.streaming || false;
      // Record that this workspace is in this mode
      fetch(`/api/workspace-state/${encodeURIComponent(project)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: stateMode }),
      }).catch(() => {});
    } catch { /* non-fatal */ }
  }

  // Force model list refresh for the new CLI backend
  geminiModelsFetched = false;

  // Show panel
  document.getElementById("gemini-overlay").classList.remove("hidden");

  // Activate split layout (unless chatonly)
  const currentMode = getChatParams().mode;
  if (currentMode !== "chatonly") {
    document.body.classList.add("chat-open");
  }

  // Update URL to reflect chat state
  const currentParams = getChatParams();
  setChatParams({
    mode: currentParams.mode,
    workspace: project || undefined,
    tool: cli || "gemini",
  });

  // Populate model selector and quota (async, non-blocking)
  geminiFetchModels();
  if (geminiActiveCli === "gemini") geminiFetchQuota();
  else document.getElementById("gemini-quota").textContent = "";

  // Connect WS if needed (only if we have a workspace for chat)
  if (project) geminiConnect();

  // Check auth — use cached health data for instant response, fall back to fetch
  const authField = geminiActiveCli === "claude" ? "claudeChatAuth" : "geminiAuth";
  const cachedAuth = (typeof lastHealthData !== "undefined" && lastHealthData && lastHealthData[authField]) || null;

  // No workspace — opened from auth dot, always show auth panel
  if (!project) {
    geminiShowAuthPanel();
    return;
  }

  if (cachedAuth && cachedAuth.loggedIn) {
    geminiShowChat(wsState);
  } else if (cachedAuth && !cachedAuth.loggedIn) {
    // Check if workspace has an API key (fast local fetch)
    try {
      const keyBase = geminiActiveCli === "claude" ? "/api/claude-chat" : "/api/gemini";
      const keyRes = await fetch(`${keyBase}/apikey/${encodeURIComponent(project)}`);
      const keyData = await keyRes.json();
      if (keyData.hasKey) {
        geminiShowChat(wsState);
      } else {
        geminiShowAuthPanel();
      }
    } catch {
      geminiShowAuthPanel();
    }
  } else {
    // No cached data yet — fetch and decide
    try {
      const res = await fetch("/api/health");
      const data = await res.json();
      const authData = data[authField];
      if (authData && authData.loggedIn) {
        geminiShowChat(wsState);
      } else {
        geminiShowAuthPanel();
      }
    } catch {
      geminiShowChat(wsState);
    }
  }
}

function closeGeminiChat() {
  glog("closeChat");

  // Clear agent chat state
  geminiAgentRole = null;
  delete window._agentRole;
  delete window._agentSystemPrompt;

  // Flush current input draft immediately so it persists across close/reopen
  const input = document.getElementById("gemini-input");
  if (input) geminiSaveDraft(input.value);

  geminiStopStreamPoll();
  document.getElementById("gemini-overlay").classList.add("hidden");
  document.body.classList.remove("chat-open");

  // If chatonly mode, exit back to dashboard
  const params = getChatParams();
  if (params.mode === "chatonly") {
    document.body.classList.remove("chatonly");
    // Re-enable dashboard polling
    if (typeof refresh === "function") refresh();
    if (typeof refreshCloudStatus === "function") refreshCloudStatus();
    refreshTimer = setInterval(() => {
      if (typeof refresh === "function") refresh();
      if (typeof refreshCloudStatus === "function") refreshCloudStatus();
    }, 10000);
  }

  clearChatParams();
}

async function clearGeminiSession() {
  glog("clearSession (new chat): workspace=" + geminiWorkspace + " cli=" + geminiActiveCli);
  if (!geminiWorkspace) return;

  // Stop any active process
  if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
    geminiWs.send(JSON.stringify({ type: "stop", workspace: geminiWorkspace, cli: geminiActiveCli }));
  }

  // Create a new session on the server (preserves old sessions)
  const clearBase = geminiActiveCli === "claude" ? "/api/claude-chat" : "/api/gemini";
  try {
    const res = await fetch(`${clearBase}/clear/${encodeURIComponent(geminiWorkspace)}`, { method: "POST" });
    const data = await res.json();
    geminiSessionNum = data.session;
    glog("clearSession: new session#" + geminiSessionNum);
  } catch {
    glog("clearSession: server call failed");
  }

  // Clear local cache
  delete geminiHistory[geminiWorkspace];

  // Clear UI
  document.getElementById("gemini-messages").innerHTML = "";
  geminiCurrentMsgEl = null;
  geminiCurrentMsgText = "";
  geminiSetStreaming(false);

  // Update URL with new session number
  const cur = getChatParams();
  setChatParams({ ...cur, session: geminiSessionNum || undefined });

  // Refresh session selector
  await geminiFetchSessions(geminiWorkspace);

  const input = document.getElementById("gemini-input");
  if (input) input.focus();
}

// --- Input handling ---

function geminiInputKeydown(event) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendGeminiMessage();
    return;
  }

  // Auto-resize textarea
  const ta = event.target;
  requestAnimationFrame(() => {
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 256) + "px";
  });
}

function sendGeminiMessage() {
  const input = document.getElementById("gemini-input");
  const message = input.value.trim();
  if (!message) {
    glog("send: blocked (empty message)");
    return;
  }

  // Discard any in-progress reload-poll — user is sending a new message
  geminiStopStreamPoll();

  glog(`send: workspace=${geminiWorkspace} msgLen=${message.length} wsState=${geminiWs ? geminiWs.readyState : "null"}`);

  // Add to local cache (server persists when WS receives the message)
  if (!geminiHistory[geminiWorkspace]) geminiHistory[geminiWorkspace] = [];
  geminiHistory[geminiWorkspace].push({ role: "user", content: message });

  // Render user bubble (with any pending images above the text)
  geminiAppendMessage("user", message, false, geminiPendingImages.slice(), Date.now());

  // Clear input and draft
  input.value = "";
  input.style.height = "auto";
  geminiSaveDraft("");

  // Start streaming — show thinking indicator until first content arrives (skip if already streaming)
  if (!geminiStreaming) {
    geminiSetStreaming(true);
    geminiShowThinking();
    window._geminiSendTime = Date.now();
  }
  glog("send: thinking indicator shown, waiting for events...");

  // Send over WebSocket (include model if not Auto)
  const modelSelect = document.getElementById("gemini-model");
  const model = modelSelect ? modelSelect.value : "";

  if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
    const images = geminiPendingImages.map((i) => i.dataUrl);
    const payload = {
      type: "send",
      workspace: geminiWorkspace,
      message,
      model: model || undefined,
      cli: geminiActiveCli,
      permissionMode: geminiGetPermissionMode(),
      ...(images.length ? { images } : {}),
    };

    // Agent chat: include systemPrompt on the first message only
    if (window._agentSystemPrompt) {
      payload.systemPrompt = window._agentSystemPrompt;
      delete window._agentSystemPrompt;
      glog("send: injecting agent systemPrompt (" + payload.systemPrompt.length + " chars)");
    }

    glog("send: ws.send", JSON.stringify(payload).slice(0, 200));
    geminiWs.send(JSON.stringify(payload));
    geminiClearImages();
  } else {
    glog("send: ws not open, showing error");
    geminiAppendError("Not connected to server");
    geminiSetStreaming(false);
  }
}

function geminiShowThinking() {
  if (document.getElementById("gemini-thinking")) return; // already visible
  window._geminiThinkingStart = Date.now();

  const container = document.getElementById("gemini-messages");
  const div = document.createElement("div");
  div.className = "gemini-thinking";
  div.id = "gemini-thinking";

  const SIZE = 40;
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  div.appendChild(canvas);
  container.appendChild(div);
  geminiScrollToBottom();

  const ctx = canvas.getContext("2d");
  const COUNT = 20;
  const cx = SIZE / 2, cy = SIZE / 2;

  const particles = Array.from({ length: COUNT }, (_, i) => ({
    angle: (i / COUNT) * Math.PI * 2,
    radius: 4 + Math.random() * 10,
    speed: (i % 2 === 0 ? 1 : -1) * (0.018 + Math.random() * 0.022),
    colorIdx: i % 3,
    wobble: Math.random() * Math.PI * 2,
  }));

  let speedMult = 1;
  let speedTarget = 1;
  let targetCooldown = 0;

  function frame(t) {
    // Drift toward a new speed target every 60-150 frames
    if (--targetCooldown <= 0) {
      targetCooldown = 60 + Math.random() * 90;
      const r = Math.random();
      speedTarget = r < 0.15 ? 0.15 + Math.random() * 0.35  // slow drift
                 : r < 0.65 ? 0.7  + Math.random() * 0.8    // normal
                 :             2.5  + Math.random() * 2.5;   // energetic burst
    }
    speedMult += (speedTarget - speedMult) * 0.04;

    // Re-read theme colors each frame so theme switches take effect live
    const cs = getComputedStyle(document.documentElement);
    const colors = [
      cs.getPropertyValue("--s-green").trim(),
      cs.getPropertyValue("--s-blue-text").trim(),
      cs.getPropertyValue("--text-strong").trim(),
    ];

    ctx.clearRect(0, 0, SIZE, SIZE); // transparent — no background box
    for (const p of particles) {
      p.angle += p.speed * speedMult;
      const r = p.radius + Math.sin(t * 0.003 + p.wobble) * 2.5;
      const x = cx + Math.cos(p.angle) * r;
      const y = cy + Math.sin(p.angle) * r;
      ctx.fillStyle = colors[p.colorIdx];
      ctx.beginPath();
      ctx.arc(x, y, 1, 0, Math.PI * 2);
      ctx.fill();
    }
    window._geminiOrbitalRaf = requestAnimationFrame(frame);
  }
  window._geminiOrbitalRaf = requestAnimationFrame(frame);
}

function geminiRemoveThinking() {
  const el = document.getElementById("gemini-thinking");
  if (el) {
    const elapsed = window._geminiThinkingStart ? Date.now() - window._geminiThinkingStart : "?";
    glog(`removeThinking: visible for ${elapsed}ms`);
    el.remove();
  }
  if (window._geminiOrbitalRaf) {
    cancelAnimationFrame(window._geminiOrbitalRaf);
    window._geminiOrbitalRaf = null;
  }
  if (window._geminiThinkingTimer) {
    clearInterval(window._geminiThinkingTimer);
    window._geminiThinkingTimer = null;
  }
}

function geminiStopStreaming() {
  glog("stopStreaming");
  if (!geminiWorkspace) return;
  if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
    // For Claude: send soft interrupt first. If Claude doesn't respond within
    // 5 seconds, the server will escalate to kill.
    if (geminiActiveCli === "claude") {
      geminiWs.send(JSON.stringify({ type: "interrupt", workspace: geminiWorkspace }));
    }
    geminiWs.send(JSON.stringify({ type: "stop", workspace: geminiWorkspace, cli: geminiActiveCli }));
  }
  // Immediate feedback — don't wait for server round-trip
  geminiRemoveThinking();
  geminiSetStreaming(false);
  geminiCurrentMsgEl = null;
  geminiCurrentMsgText = "";
}

function geminiSetStreaming(active) {
  glog(`setStreaming: ${active}${!active && window._geminiSendTime ? " totalRoundtrip=" + (Date.now() - window._geminiSendTime) + "ms" : ""}`);
  geminiStreaming = active;
  const input = document.getElementById("gemini-input");
  const sendBtn = document.getElementById("gemini-send");
  const stopBtn = document.getElementById("gemini-stop");

  const modelSelect = document.getElementById("gemini-model");
  if (modelSelect) modelSelect.disabled = active;

  const permSelect = document.getElementById("gemini-permission-mode");
  if (permSelect) permSelect.disabled = active;

  // Send button stays visible always (for steering mid-stream)
  // Stop button appears next to it only during generation
  if (stopBtn) stopBtn.style.display = active ? "" : "none";

  // Remove streaming class from previous message when done
  if (!active && geminiCurrentMsgEl) {
    geminiCurrentMsgEl.classList.remove("gemini-streaming");
  }

  // Clean up thinking indicator when streaming ends
  if (!active) geminiRemoveThinking();
}

// --- URL-driven initialization ---

async function initFromUrlParams() {
  const params = getChatParams();

  // Handle chatonly mode — hide dashboard
  if (params.mode === "chatonly") {
    document.body.classList.add("chatonly");
    // Reduce dashboard polling since it's invisible
    if (typeof refreshTimer !== "undefined" && refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  // If workspace specified, auto-open chat
  if (params.workspace) {
    const tool = params.tool || "gemini";
    const wsPath = await resolveWorkspacePath(params.workspace);

    if (wsPath) {
      // If session param specified, switch to that session first
      if (params.session) {
        const base = tool === "claude" ? "/api/claude-chat" : "/api/gemini";
        try {
          await fetch(`${base}/sessions/${encodeURIComponent(params.workspace)}/switch`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ session: Number(params.session) }),
          });
          geminiSessionNum = Number(params.session);
        } catch {
          // Session switch failed — will load current session
        }
      }
      openGeminiChat(params.workspace, wsPath, tool);
    } else {
      // Workspace not found — show overlay with error
      document.getElementById("gemini-overlay").classList.remove("hidden");
      const container = document.getElementById("gemini-messages");
      container.innerHTML = "";
      const div = document.createElement("div");
      div.className = "gemini-msg error";
      div.textContent = `Workspace "${params.workspace}" not found. Check the URL and try again.`;
      container.appendChild(div);
    }
  }
}

// Handle browser back/forward
window.addEventListener("popstate", () => {
  const params = getChatParams();
  if (params.workspace) {
    resolveWorkspacePath(params.workspace).then(path => {
      if (path) openGeminiChat(params.workspace, path, params.tool || "gemini");
    });
  } else {
    // No chat params — close panel if open
    const overlay = document.getElementById("gemini-overlay");
    if (overlay && !overlay.classList.contains("hidden")) {
      overlay.classList.add("hidden");
    }
    document.body.classList.remove("chatonly", "chat-open");
  }
});

// Persist permission mode + send runtime switch to active relay
document.getElementById("gemini-permission-mode")?.addEventListener("change", function() {
  geminiSavePermissionMode(this.value);
  if (this.value && geminiActiveCli === "claude" && geminiWs && geminiWs.readyState === WebSocket.OPEN) {
    geminiWs.send(JSON.stringify({ type: "set_permission_mode", workspace: geminiWorkspace, mode: this.value }));
    glog("perm-switch: sent set_permission_mode=" + this.value);
  }
});

// Persist model selection per workspace + send runtime model switch to active relay
document.getElementById("gemini-model")?.addEventListener("change", function() {
  const newModel = this.value;
  if (geminiWorkspace) localStorage.setItem(`klaudii-model-${geminiWorkspace}`, newModel);
  // Send runtime model switch to active Claude relay (takes effect on next API call)
  if (newModel && geminiActiveCli === "claude" && geminiWs && geminiWs.readyState === WebSocket.OPEN) {
    geminiWs.send(JSON.stringify({ type: "set_model", workspace: geminiWorkspace, model: newModel }));
    glog("model-switch: sent set_model=" + newModel);
  }
});

// Draft sync — save as user types + set local typing guard
document.getElementById("gemini-input")?.addEventListener("input", (e) => {
  // Mark as actively typing so incoming remote drafts don't clobber our input
  geminiLocalDraftActive = true;
  clearTimeout(geminiLocalDraftTimeout);
  geminiLocalDraftTimeout = setTimeout(() => { geminiLocalDraftActive = false; }, 1000);
  geminiSaveDraft(e.target.value);
});

// Paste images from clipboard into chat
document.getElementById("gemini-input")?.addEventListener("paste", (e) => {
  if (geminiActiveCli !== "claude") return;
  const items = Array.from(e.clipboardData?.items || []);
  const imageItems = items.filter((item) => item.type.startsWith("image/"));
  if (imageItems.length === 0) return;
  e.preventDefault();
  imageItems.forEach((item) => {
    const file = item.getAsFile();
    if (file) geminiLoadImageFile(file);
  });
});

// Drag-and-drop images onto the chat panel
const geminiPanel = document.querySelector(".gemini-panel");
if (geminiPanel) {
  geminiPanel.addEventListener("dragover", (e) => {
    if (geminiActiveCli !== "claude") return;
    const hasImage = Array.from(e.dataTransfer.items || []).some((i) => i.type.startsWith("image/"));
    if (!hasImage) return;
    e.preventDefault();
    geminiPanel.classList.add("drag-over");
  });
  geminiPanel.addEventListener("dragleave", (e) => {
    if (!geminiPanel.contains(e.relatedTarget)) geminiPanel.classList.remove("drag-over");
  });
  geminiPanel.addEventListener("drop", (e) => {
    geminiPanel.classList.remove("drag-over");
    if (geminiActiveCli !== "claude") return;
    e.preventDefault();
    Array.from(e.dataTransfer.files || []).forEach((file) => geminiLoadImageFile(file));
  });
}

// Scroll to bottom whenever the tab/window regains visibility
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) geminiScrollToBottom();
});

// Auto-open chat from URL params on page load
initFromUrlParams();
