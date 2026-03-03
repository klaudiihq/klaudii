/**
 * Gemini Chat UI — WebSocket client, message rendering, markdown.
 *
 * Loaded after app.js and marked.min.js.
 */

// --- Logging ---
const G = "[gemini-ui]";
function glog(...args) { console.log(G, new Date().toISOString(), ...args); }

// --- State ---

let geminiWs = null;
let geminiWorkspace = null;
let geminiWorkspacePath = null;
let geminiStreaming = false;
let geminiActiveCli = "gemini"; // "gemini" or "claude"
let geminiSessionNum = null; // current session number (1, 2, 3...)

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

    // Show selector once there's at least 1 session
    select.classList.toggle("hidden", sessions.length < 1);

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

  // Update URL
  const cur = getChatParams();
  setChatParams({ ...cur, session: num });

  // Reload history for the new session
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

    // Restore previous selection if it still exists
    if (prev && [...select.options].some((o) => o.value === prev)) {
      select.value = prev;
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

// --- WebSocket ---

function geminiConnect() {
  if (geminiWs && geminiWs.readyState === WebSocket.OPEN) return;

  const wsUrl = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/gemini`;
  console.log("[gemini-ws] connecting to", wsUrl);
  geminiWs = new WebSocket(wsUrl);

  geminiWs.onopen = () => {
    glog("ws-open");
    geminiUpdateStatus(true);
  };

  geminiWs.onclose = (evt) => {
    glog("ws-close code=" + evt.code, "reason=" + (evt.reason || ""));
    geminiUpdateStatus(false);
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

        if (!geminiCurrentMsgEl) {
          glog("handle: creating assistant message element");
          geminiCurrentMsgEl = geminiAppendMessage("assistant", "", true);
        }

        const mdEl = geminiCurrentMsgEl.querySelector(".md-content");
        if (mdEl) {
          mdEl.innerHTML = geminiRenderMarkdown(geminiCurrentMsgText);
        }
        geminiScrollToBottom();
      } else {
        glog(`handle: message role=${event.role} (skipping — user echo)`);
      }
      break;

    case "tool_use": {
      geminiRemoveThinking();
      const toolName = event.tool_name || event.name || "tool";
      const toolId = event.tool_id || "";
      const params = event.parameters || event.args || event.input || {};
      glog(`handle: tool_use name=${toolName} id=${toolId}`);
      // After a tool call, force a new message element for subsequent text
      geminiCurrentMsgEl = null;
      geminiCurrentMsgText = "";
      geminiAppendToolUse(toolName, toolId, params);
      break;
    }

    case "tool_result": {
      const toolId = event.tool_id || "";
      const output = event.output || event.content || "";
      const status = event.status || "success";
      const error = event.error;
      glog(`handle: tool_result id=${toolId} status=${status} outputLen=${output.length}`);
      geminiUpdateToolResult(toolId, status, output, error);
      break;
    }

    case "error":
      geminiRemoveThinking();
      glog("handle: error message=" + (event.message || "?"));
      geminiAppendError(event.message || "Unknown error");
      break;

    case "done":
      geminiRemoveThinking();
      glog(`handle: done exitCode=${event.exitCode} stopped=${event.stopped || false} assistantTextLen=${geminiCurrentMsgText.length} stderr=${(event.stderr || "").slice(0, 200)}`);
      if (geminiCurrentMsgText) {
        history.push({ role: "assistant", content: geminiCurrentMsgText });
        geminiHistory[event.workspace] = history;
      }
      // Only reset if still streaming (stop already resets immediately)
      if (geminiStreaming) geminiSetStreaming(false);
      geminiCurrentMsgEl = null;
      geminiCurrentMsgText = "";

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

    default:
      glog("handle: unknown event type=" + event.type + " keys=" + Object.keys(event).join(","));
      break;
  }
}

// --- DOM rendering ---

function geminiAppendMessage(role, content, streaming) {
  const container = document.getElementById("gemini-messages");
  const div = document.createElement("div");
  div.className = `gemini-msg ${role}${streaming ? " gemini-streaming" : ""}`;

  if (role === "user") {
    div.textContent = content;
  } else {
    const md = document.createElement("div");
    md.className = "md-content";
    md.innerHTML = content ? geminiRenderMarkdown(content) : "";
    div.appendChild(md);
  }

  container.appendChild(div);
  geminiScrollToBottom();
  return div;
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
    default: {
      // Try to find a single short string value to display
      const vals = Object.values(p).filter((v) => typeof v === "string" && v.length < 100);
      return vals.length === 1 ? vals[0] : "";
    }
  }
}

/**
 * Append a tool-use pill. Starts in a "running" state with a spinner.
 * Shows tool name + short description inline.
 * Full params are in a collapsible details body (collapsed by default).
 */
function geminiAppendToolUse(toolName, toolId, params) {
  const container = document.getElementById("gemini-messages");
  const details = document.createElement("details");
  details.className = "gemini-tool running";
  details.dataset.toolId = toolId;
  details.dataset.toolName = toolName;

  const desc = geminiToolDescription(toolName, params);
  const summary = document.createElement("summary");
  summary.innerHTML =
    `<span class="gemini-tool-spinner"></span>` +
    `<span class="gemini-tool-name">${geminiEscHtml(toolName)}</span>` +
    (desc ? `<span class="gemini-tool-desc">${geminiEscHtml(desc)}</span>` : "");
  details.appendChild(summary);

  // Collapsible body with full params
  const body = document.createElement("div");
  body.className = "gemini-tool-body";
  const paramsStr = typeof params === "object" ? JSON.stringify(params, null, 2) : String(params || "");
  if (paramsStr && paramsStr !== "{}") {
    const paramsSection = document.createElement("div");
    paramsSection.className = "gemini-tool-section";
    paramsSection.innerHTML = `<div class="gemini-tool-section-label">Parameters</div>`;
    const pre = document.createElement("pre");
    pre.textContent = paramsStr;
    paramsSection.appendChild(pre);
    body.appendChild(paramsSection);
  }
  // Output section will be added by geminiUpdateToolResult
  details.appendChild(body);

  container.appendChild(details);
  geminiScrollToBottom();
}

/**
 * Update a tool pill with its result and mark it done.
 * Matches by tool_id. Output goes into a collapsible section (collapsed by default).
 */
function geminiUpdateToolResult(toolId, status, output, error) {
  const container = document.getElementById("gemini-messages");

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

    // Replace spinner with status icon
    const summary = pill.querySelector("summary");
    if (summary) {
      const spinner = summary.querySelector(".gemini-tool-spinner");
      if (spinner) {
        const icon = document.createElement("span");
        icon.className = isError ? "gemini-tool-icon error" : "gemini-tool-icon success";
        icon.textContent = isError ? "\u2717" : "\u2713";
        spinner.replaceWith(icon);
      }
    }

    // Add output to body
    const trimmed = (error || output || "").trim();
    if (trimmed) {
      const body = pill.querySelector(".gemini-tool-body");
      if (body) {
        const section = document.createElement("div");
        section.className = "gemini-tool-section";
        section.innerHTML = `<div class="gemini-tool-section-label">${isError ? "Error" : "Output"}</div>`;
        const pre = document.createElement("pre");
        pre.textContent = trimmed.length > 5000 ? trimmed.slice(0, 5000) + "\n...(truncated)" : trimmed;
        section.appendChild(pre);
        body.appendChild(section);
      }
    }
  } else {
    // No matching pill — standalone fallback
    const details = document.createElement("details");
    details.className = `gemini-tool ${isError ? "error" : "success"}`;
    const summary = document.createElement("summary");
    const icon = isError ? "\u2717" : "\u2713";
    summary.innerHTML =
      `<span class="gemini-tool-icon ${isError ? "error" : "success"}">${icon}</span>` +
      `<span class="gemini-tool-name">${geminiEscHtml(toolId || "tool")}</span>` +
      `<span class="gemini-tool-desc">(result)</span>`;
    details.appendChild(summary);
    const body = document.createElement("div");
    body.className = "gemini-tool-body";
    const pre = document.createElement("pre");
    pre.textContent = error || output || "";
    body.appendChild(pre);
    details.appendChild(body);
    container.appendChild(details);
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

async function geminiShowChat() {
  glog("showChat: workspace=" + geminiWorkspace + " session#" + geminiSessionNum);
  const container = document.getElementById("gemini-messages");
  container.innerHTML = "";

  // Fetch sessions list and conversation history from server
  if (geminiWorkspace) {
    await geminiFetchSessions(geminiWorkspace);
    const history = await geminiFetchHistory(geminiWorkspace, geminiSessionNum);
    for (const msg of history) {
      geminiAppendMessage(msg.role, msg.content, false);
    }
  }

  // Enable input
  geminiSetStreaming(false);
  const input = document.getElementById("gemini-input");
  if (input) input.focus();
}

// --- Overlay controls ---

async function openGeminiChat(project, projectPath, cli) {
  geminiActiveCli = cli || "gemini";
  glog(`openChat: project=${project} path=${projectPath} cli=${geminiActiveCli}`);
  geminiWorkspace = project || null;
  geminiWorkspacePath = projectPath || null;

  const cliLabel = geminiActiveCli === "claude" ? "Claude" : "Gemini";

  // Set title
  if (project) {
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
  if (inputEl) inputEl.placeholder = `Message ${cliLabel}...`;

  // Reset streaming/session state
  geminiCurrentMsgEl = null;
  geminiCurrentMsgText = "";
  geminiSessionNum = null;
  geminiSetStreaming(false);

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
    geminiShowChat();
  } else if (cachedAuth && !cachedAuth.loggedIn) {
    // Check if workspace has an API key (fast local fetch)
    try {
      const keyBase = geminiActiveCli === "claude" ? "/api/claude-chat" : "/api/gemini";
      const keyRes = await fetch(`${keyBase}/apikey/${encodeURIComponent(project)}`);
      const keyData = await keyRes.json();
      if (keyData.hasKey) {
        geminiShowChat();
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
        geminiShowChat();
      } else {
        geminiShowAuthPanel();
      }
    } catch {
      geminiShowChat();
    }
  }
}

function closeGeminiChat() {
  glog("closeChat");
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
  if (!message || geminiStreaming) {
    glog(`send: blocked (empty=${!message} streaming=${geminiStreaming})`);
    return;
  }

  glog(`send: workspace=${geminiWorkspace} msgLen=${message.length} wsState=${geminiWs ? geminiWs.readyState : "null"}`);

  // Add to local cache (server persists when WS receives the message)
  if (!geminiHistory[geminiWorkspace]) geminiHistory[geminiWorkspace] = [];
  geminiHistory[geminiWorkspace].push({ role: "user", content: message });

  // Render user bubble
  geminiAppendMessage("user", message, false);

  // Clear input
  input.value = "";
  input.style.height = "auto";

  // Start streaming — show thinking indicator until first content arrives
  geminiSetStreaming(true);
  geminiShowThinking();
  window._geminiSendTime = Date.now();
  glog("send: thinking indicator shown, waiting for events...");

  // Send over WebSocket (include model if not Auto)
  const modelSelect = document.getElementById("gemini-model");
  const model = modelSelect ? modelSelect.value : "";

  if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
    const payload = { type: "send", workspace: geminiWorkspace, message, model: model || undefined, cli: geminiActiveCli };
    glog("send: ws.send", JSON.stringify(payload).slice(0, 200));
    geminiWs.send(JSON.stringify(payload));
  } else {
    glog("send: ws not open, showing error");
    geminiAppendError("Not connected to server");
    geminiSetStreaming(false);
  }
}

function geminiShowThinking() {
  window._geminiThinkingStart = Date.now();
  const container = document.getElementById("gemini-messages");
  const div = document.createElement("div");
  div.className = "gemini-thinking";
  div.id = "gemini-thinking";
  const cliLabel = geminiActiveCli === "claude" ? "Claude" : "Gemini";
  div.innerHTML = `<span class="gemini-thinking-dots"><span></span><span></span><span></span></span> <span class="gemini-thinking-label">Starting ${cliLabel}...</span>`;
  container.appendChild(div);
  geminiScrollToBottom();

  // Update label with elapsed time so user knows it's not frozen
  window._geminiThinkingTimer = setInterval(() => {
    const label = div.querySelector(".gemini-thinking-label");
    if (!label) return;
    const elapsed = Math.round((Date.now() - window._geminiThinkingStart) / 1000);
    if (elapsed >= 5) {
      const cliName = geminiActiveCli === "claude" ? "Claude" : "Gemini";
      label.textContent = `Waiting for ${cliName}... (${elapsed}s)`;
    }
  }, 1000);
}

function geminiRemoveThinking() {
  const el = document.getElementById("gemini-thinking");
  if (el) {
    const elapsed = window._geminiThinkingStart ? Date.now() - window._geminiThinkingStart : "?";
    glog(`removeThinking: visible for ${elapsed}ms`);
    el.remove();
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

  if (input) input.disabled = active;

  const modelSelect = document.getElementById("gemini-model");
  if (modelSelect) modelSelect.disabled = active;

  if (sendBtn) {
    if (active) {
      sendBtn.textContent = "Stop";
      sendBtn.onclick = geminiStopStreaming;
      sendBtn.disabled = false;
      sendBtn.classList.add("danger");
    } else {
      sendBtn.textContent = "Send";
      sendBtn.onclick = sendGeminiMessage;
      sendBtn.disabled = false;
      sendBtn.classList.remove("danger");
    }
  }

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

// Auto-open chat from URL params on page load
initFromUrlParams();
