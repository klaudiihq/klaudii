/**
 * Gemini Chat UI — WebSocket client, message rendering, markdown.
 *
 * Loaded after app.js and marked.min.js.
 */

// --- Logging ---
const G = "[chat-ui]";
function glog(...args) { console.log(G, new Date().toISOString(), ...args); }

// --- Auth error detection ---
function isAuthError(stderr) {
  if (!stderr) return false;
  const s = stderr.toLowerCase();
  return s.includes("not logged in") || s.includes("/login") || s.includes("not authenticated") || s.includes("auth");
}

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

let chatWs = null;
let chatWorkspace = null;
let chatWorkspacePath = null;
let chatStreaming = false;
let chatOpenedWhileStreaming = false; // true when chat opened mid-stream
let chatStreamPollTimer = null;       // setInterval handle for polling in-flight reply
let chatActiveCli = "gemini"; // "gemini" or "claude"
let chatSessionNum = null; // current session number (1, 2, 3...)
let chatLocalDraftActive = false; // true when user is actively typing — blocks incoming draft events
let chatLocalDraftTimeout = null;
const chatPageSessionDrafts = new Set(); // workspaces whose drafts were saved this page session
let chatWasStreamingAtDisconnect = false; // set in onclose, cleared in onopen after recovery check
let chatHistoryFetchFailed = false;        // set when history fetch fails (server not ready); triggers re-fetch on reconnect
let chatAgentRole = null;
let chatThinkingEnabled = false;           // extended thinking toggle state
let chatToolDisplayMode = "collapsed";      // "collapsed" | "expanded" | "hidden"
let chatThinkingGapTimer = null;             // shows thinking orbital after idle gap during streaming

// Per-workspace message history (in-memory cache, server is source of truth)
// workspace → [ { role, content } ]  (for current session)
const chatHistory = {};
let chatTotalHistoryCount = 0;    // total messages on server for current workspace/session
let chatLoadedHistoryCount = 0;   // how many we've loaded so far
let chatHistoryFullyLoaded = false; // true when all messages are loaded
let chatScrollObserver = null;    // IntersectionObserver for scroll-up loading
const CHAT_INITIAL_LOAD = 100;    // messages to load on first render
const CHAT_PAGE_SIZE = 500;       // messages to load per scroll-up page
const chatAskToolIds = new Set(); // tool_ids for AskUserQuestion — suppress their tool_result pills
const pendingToolUses = new Map(); // tool_id → {tool_name, tool_id, parameters} for ExitPlanMode tracking

// --- Chat switch overlay (synchronized workspace transition) ---

function chatShowSwitchOverlay() {
  // Remove any existing overlay
  const existing = document.querySelector(".chat-switch-overlay");
  if (existing) existing.remove();
  const panel = document.getElementById("chat-overlay");
  if (!panel) return;
  const overlay = document.createElement("div");
  overlay.className = "chat-switch-overlay";
  overlay.innerHTML = '<div class="chat-switch-dots"><div></div><div></div><div></div><div></div><div></div></div>';
  panel.appendChild(overlay);
}

function chatDismissSwitchOverlay() {
  const overlay = document.querySelector(".chat-switch-overlay");
  if (!overlay) return;
  overlay.classList.add("fade-out");
  overlay.addEventListener("transitionend", () => overlay.remove(), { once: true });
  // Safety fallback in case transitionend doesn't fire
  setTimeout(() => overlay.remove(), 200);
}

// --- Tool display mode helpers ---

const READONLY_TOOLS = new Set([
  "read", "readfile", "glob", "listfiles", "grep", "search", "searchfiles",
  "webfetch", "websearch", "toolsearch", "lsp", "agent",
]);

const READONLY_BASH_PATTERNS = /^\s*(ls|pwd|echo|cat|head|tail|wc|find|grep|rg|git\s+(status|log|diff|show|branch|remote|tag)|which|whoami|date|env|printenv|uname|file|stat|du|df|tree|type|readlink|bd\s+(show|ready|list|export))\b/;

function isReadOnlyTool(toolName, params) {
  const n = (toolName || "").toLowerCase().replace(/_/g, "");
  if (READONLY_TOOLS.has(n)) return true;
  if (n === "bash" || n === "shell" || n === "runcommand") {
    const cmd = (params && (params.command || params.cmd)) || "";
    return READONLY_BASH_PATTERNS.test(cmd);
  }
  return false;
}

function chatGetToolDisplayMode() {
  const stored = localStorage.getItem("klaudii-tool-display");
  if (stored === "minimal" || stored === "normal") return "collapsed";
  if (stored === "full") return "expanded";
  return stored || "collapsed";
}

function chatSetToolDisplayMode(mode) {
  if (!["collapsed", "expanded", "hidden"].includes(mode)) return;
  chatToolDisplayMode = mode;
  localStorage.setItem("klaudii-tool-display", mode);
  chatApplyToolDisplayMode();
}

function chatRestoreToolDisplayMode() {
  chatToolDisplayMode = chatGetToolDisplayMode();
}

function chatIsDebugMode() {
  return localStorage.getItem("klaudii-debug") === "true";
}

function chatApplyDebugMode() {
  const debug = chatIsDebugMode();
  // Context stats
  const stats = document.getElementById("chat-cumulative-stats");
  if (stats) stats.style.display = debug ? "" : "none";
  // Handoff button
  const handoff = document.querySelector('[onclick="chatShowHandoffPreview()"]');
  if (handoff) handoff.style.display = debug ? "" : "none";
}

function chatApplyToolDisplayMode() {
  const container = document.getElementById("chat-messages");
  if (!container) return;
  container.dataset.toolDisplay = chatToolDisplayMode;

  // Retroactively apply to all existing tool pills
  const pills = container.querySelectorAll(".chat-tool");
  for (const pill of pills) {
    if (chatToolDisplayMode === "hidden") {
      pill.style.display = "none";
    } else {
      pill.style.display = "";
    }

    if (pill.tagName === "DETAILS") {
      if (chatToolDisplayMode === "expanded") {
        pill.open = true;
      } else if (chatToolDisplayMode === "collapsed") {
        pill.open = false;
      }
    }
  }

  // Also handle sub-items in groups
  const subs = container.querySelectorAll(".chat-tool-sub");
  for (const sub of subs) {
    if (sub.tagName === "DETAILS") {
      sub.open = chatToolDisplayMode === "expanded";
    }
  }
}

function chatShouldShowTool(toolName, params) {
  return chatToolDisplayMode !== "hidden";
}

function chatInitialPillOpen() {
  return chatToolDisplayMode === "expanded";
}

// --- URL query parameter support ---

function getChatParams() {
  const p = new URLSearchParams(window.location.search);
  return {
    mode: p.get("mode"),
    workspace: p.get("workspace"),
    tool: p.get("tool"),
    chat: p.get("chat"),
  };
}

function setChatParams({ mode, workspace, tool, chat }) {
  const p = new URLSearchParams();
  if (mode) p.set("mode", mode);
  if (workspace) p.set("workspace", workspace);
  if (tool) p.set("tool", tool);
  if (chat) p.set("chat", chat);
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
async function chatFetchHistory(workspace, sessionNum, limit, offset) {
  try {
    const base = chatActiveCli === "claude" ? "/api/claude-chat" : "/api/gemini";
    const params = new URLSearchParams();
    if (sessionNum) params.set("session", sessionNum);
    if (limit) params.set("limit", limit);
    if (offset) params.set("offset", offset);
    const qs = params.toString() ? `?${params}` : "";
    const res = await fetch(`${base}/history/${encodeURIComponent(workspace)}${qs}`);
    const data = await res.json();
    // New format: { messages, total } — fall back to bare array for compat
    const messages = data.messages || (Array.isArray(data) ? data : []);
    const total = data.total != null ? data.total : messages.length;
    if (!offset) {
      chatHistory[workspace] = messages;
      chatTotalHistoryCount = total;
      chatLoadedHistoryCount = messages.length;
      chatHistoryFullyLoaded = messages.length >= total;
    }
    return { messages, total };
  } catch {
    chatHistoryFetchFailed = true;
    chatHistory[workspace] = chatHistory[workspace] || [];
    return { messages: chatHistory[workspace], total: chatHistory[workspace].length };
  }
}

/**
 * Render a batch of history messages into a DocumentFragment.
 * Returns the fragment — caller decides whether to append or prepend.
 */
function chatRenderHistoryBatch(messages, wsState, deferMarkdown) {
  const frag = document.createDocumentFragment();
  const pendingToolUses = new Map();
  const deferredMdEls = []; // elements needing markdown upgrade
  for (const msg of messages) {
    if (msg.role === "tool_use") {
      try { const d = JSON.parse(msg.content); pendingToolUses.set(d.tool_id, d); } catch {}
    } else if (msg.role === "tool_result") {
      try {
        const d = JSON.parse(msg.content);
        const tu = d.tool_id ? pendingToolUses.get(d.tool_id) : null;
        if (tu) pendingToolUses.delete(d.tool_id);
        const name = tu ? tu.tool_name : (d.tool_name || "tool");
        if (name === "ExitPlanMode") {
          chatShowPlanApproval(d.tool_id, (tu ? tu.parameters : {}).plan || d.output || "", false, frag);
          const card = frag.querySelector(".chat-plan-approval:last-child");
          if (card) {
            card.classList.add("approved");
            card.querySelector(".chat-plan-header").textContent = "Plan";
            card.querySelectorAll("button").forEach(b => { b.disabled = true; b.style.display = "none"; });
          }
        } else if (/ask.*question/i.test(name)) {
          chatRenderCompletedQuestion(tu ? tu.parameters : {}, d.output || "", d.status, frag);
        } else {
          chatRenderCompletedTool(name, d.tool_id, tu ? tu.parameters : {}, d.status, d.output, frag);
        }
      } catch {}
    } else if (deferMarkdown && msg.role === "assistant" && msg.content) {
      // Fast path: render plain text now, upgrade to markdown in idle time
      const div = document.createElement("div");
      div.className = "chat-msg assistant";
      const md = document.createElement("div");
      md.className = "md-content";
      md.textContent = msg.content;
      md._rawContent = msg.content;
      deferredMdEls.push(md);
      div.appendChild(md);
      const timeStr = chatMsgTime(msg.ts);
      if (timeStr) {
        const tsEl = document.createElement("div");
        tsEl.className = "chat-msg-ts";
        tsEl.textContent = timeStr;
        div.appendChild(tsEl);
      }
      frag.appendChild(div);
    } else {
      chatAppendMessage(msg.role, msg.content, false, null, msg.ts, msg.sender, msg.role === "user" ? "processing" : undefined, frag);
    }
  }
  // Flush orphaned tool_uses
  const isStreaming = wsState?.streaming || chatStreaming;
  for (const tu of pendingToolUses.values()) {
    if (tu.tool_name === "ExitPlanMode") {
      chatShowPlanApproval(tu.tool_id, tu.parameters.plan || "", false, frag);
    } else if (isStreaming) {
      chatAppendToolUse(tu.tool_name, tu.tool_id, tu.parameters, frag);
    } else {
      chatRenderCompletedTool(tu.tool_name, tu.tool_id, tu.parameters, "interrupted", "", frag);
    }
  }
  // Schedule deferred markdown rendering in idle time
  if (deferredMdEls.length) {
    let idx = 0;
    function upgradeChunk(deadline) {
      while (idx < deferredMdEls.length && (deadline.timeRemaining() > 2 || deadline.didTimeout)) {
        const el = deferredMdEls[idx++];
        if (el._rawContent && el.isConnected) {
          el.innerHTML = chatRenderMarkdown(el._rawContent);
          delete el._rawContent;
        }
      }
      if (idx < deferredMdEls.length) requestIdleCallback(upgradeChunk, { timeout: 100 });
    }
    requestIdleCallback(upgradeChunk, { timeout: 200 });
  }
  return frag;
}

/**
 * Load older messages when user scrolls to top.
 */
async function chatLoadOlderMessages() {
  if (chatHistoryFullyLoaded || !chatWorkspace) return;
  const container = document.getElementById("chat-messages");
  if (!container) return;

  // Show loading indicator
  let spinner = container.querySelector(".chat-history-spinner");
  if (!spinner) {
    spinner = document.createElement("div");
    spinner.className = "chat-history-spinner";
    spinner.textContent = "Loading older messages...";
    container.prepend(spinner);
  }

  const workspace = chatWorkspace;
  const offset = chatLoadedHistoryCount;
  const { messages } = await chatFetchHistory(workspace, chatSessionNum, CHAT_PAGE_SIZE, offset);
  if (workspace !== chatWorkspace) return; // workspace changed

  // Remove spinner
  spinner = container.querySelector(".chat-history-spinner");
  if (spinner) spinner.remove();

  if (messages.length === 0) {
    chatHistoryFullyLoaded = true;
    return;
  }

  // Remember scroll position to restore after prepend
  const scrollBottom = container.scrollHeight - container.scrollTop;

  // Render and prepend
  const sentinel = container.querySelector(".chat-scroll-sentinel");
  const frag = chatRenderHistoryBatch(messages);
  if (sentinel) {
    sentinel.after(frag);
  } else {
    container.prepend(frag);
  }

  // Update counts
  chatLoadedHistoryCount += messages.length;
  chatHistoryFullyLoaded = chatLoadedHistoryCount >= chatTotalHistoryCount;
  // Prepend to in-memory cache
  chatHistory[workspace] = [...messages, ...(chatHistory[workspace] || [])];

  // Restore scroll position so the view doesn't jump
  container.scrollTop = container.scrollHeight - scrollBottom;
}

/**
 * Set up IntersectionObserver for scroll-up loading.
 */
function chatSetupScrollObserver() {
  if (chatScrollObserver) chatScrollObserver.disconnect();
  const container = document.getElementById("chat-messages");
  if (!container) return;

  // Add sentinel at top
  let sentinel = container.querySelector(".chat-scroll-sentinel");
  if (!sentinel) {
    sentinel = document.createElement("div");
    sentinel.className = "chat-scroll-sentinel";
    sentinel.style.height = "1px";
    container.prepend(sentinel);
  }

  chatScrollObserver = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && !chatHistoryFullyLoaded) {
      chatLoadOlderMessages();
    }
  }, { root: container, threshold: 0 });
  chatScrollObserver.observe(sentinel);
}

/**
 * Fetch cumulative cost/token stats for a workspace and update the display.
 */
async function chatFetchCumulativeStats(workspace) {
  try {
    const base = chatActiveCli === "claude" ? "/api/claude-chat" : "/api/gemini";
    const res = await fetch(`${base}/stats/${encodeURIComponent(workspace)}`);
    const data = await res.json();
    chatUpdateCumulativeStats(data);
  } catch {
    chatUpdateCumulativeStats({});
  }
}

/**
 * Terse relative time: "just now", "3s ago", "2m ago", "2h ago",
 * "yesterday", day-of-week, "Jan 3", or "Jan 3, 2025".
 */
function chatTerseTime(ts) {
  if (!ts) return "";
  const now = Date.now();
  const diff = Math.floor((now - ts) / 1000);
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;

  const d = new Date(ts);
  const today = new Date(now);
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);

  if (d.toDateString() === yesterday.toDateString()) return "yesterday";

  // Within this week (< 7 days): show day name
  if (diff < 604800) return d.toLocaleDateString([], { weekday: "long" });

  // Same year: "Jan 3"
  if (d.getFullYear() === today.getFullYear()) {
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  // Different year: "Jan 3, 2025"
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Fetch session list for a workspace and populate the custom session dropdown.
 * Sessions now include { num, lastActivity, active } and arrive sorted by activity desc.
 */
async function chatFetchSessions(workspace) {
  const dropdown = document.getElementById("chat-session-dropdown");
  if (!dropdown) return null;

  try {
    const base = chatActiveCli === "claude" ? "/api/claude-chat" : "/api/gemini";
    const res = await fetch(`${base}/sessions/${encodeURIComponent(workspace)}`);
    const data = await res.json();

    const sessions = data.sessions || [];
    // Don't override chatSessionNum — it was already set by openChat (URL param, workspace-state, or MRU)
    if (chatSessionNum == null) {
      chatSessionNum = sessions.length ? sessions[0].num : (data.current || 1);
    }
    const currentNum = chatSessionNum;

    // Update the button label for the current session
    const label = document.getElementById("chat-session-label");
    if (label) label.textContent = `Chat ${currentNum}`;

    // Build menu items (already sorted by activity desc from server)
    const menu = document.getElementById("chat-session-menu");
    if (menu) {
      menu.innerHTML = "";
      for (const s of sessions) {
        const item = document.createElement("div");
        item.className = "chat-session-item" + (s.num === currentNum ? " selected" : "");
        item.onclick = () => { chatCloseSessionMenu(); chatSwitchSession(s.num); };
        const dotEl = document.createElement("span");
        dotEl.className = "session-dot" + (s.active ? " active" : "");
        const nameEl = document.createElement("span");
        nameEl.textContent = `Chat ${s.num}`;
        const timeEl = document.createElement("span");
        timeEl.className = "session-time";
        timeEl.textContent = chatTerseTime(s.lastActivity);
        item.appendChild(dotEl);
        item.appendChild(nameEl);
        item.appendChild(timeEl);
        menu.appendChild(item);
      }
      // "+ New Chat" at the bottom of the dropdown
      const newItem = document.createElement("div");
      newItem.className = "chat-session-item new-chat";
      newItem.onclick = () => { chatCloseSessionMenu(); clearGeminiSession(); };
      newItem.textContent = "+ New Chat";
      menu.appendChild(newItem);
    }

    // Update stop/start process buttons based on current session's active status
    const currentSession = sessions.find(s => s.num === currentNum);
    if (typeof chatUpdateProcessButtons === "function") {
      chatUpdateProcessButtons(currentSession ? currentSession.active : false);
    }

    return data;
  } catch {
    return null;
  }
}

function chatToggleSessionMenu() {
  const menu = document.getElementById("chat-session-menu");
  if (menu) menu.classList.toggle("hidden");
}

function chatCloseSessionMenu() {
  const menu = document.getElementById("chat-session-menu");
  if (menu) menu.classList.add("hidden");
}

// Close session menu on outside click
document.addEventListener("click", (e) => {
  const dropdown = document.getElementById("chat-session-dropdown");
  if (dropdown && !dropdown.contains(e.target)) chatCloseSessionMenu();
});

/**
 * Switch to a different session number.
 */
async function chatSwitchSession(num) {
  if (!chatWorkspace || num === chatSessionNum) return;
  glog(`switchSession: workspace=${chatWorkspace} from=${chatSessionNum} to=${num}`);

  // Flush current input draft for the old session before switching
  const input = document.getElementById("chat-input");
  if (input) chatSaveDraft(input.value);

  // Stop any running process
  if (chatStreaming) chatStopStreaming();

  // Tell server to switch
  const base = chatActiveCli === "claude" ? "/api/claude-chat" : "/api/gemini";
  try {
    const res = await fetch(`${base}/sessions/${encodeURIComponent(chatWorkspace)}/switch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: num }),
    });
    if (!res.ok) throw new Error("switch failed");
  } catch (err) {
    glog("switchSession: error", err.message);
    return;
  }

  chatSessionNum = num;

  // Persist session number server-side (must complete before showChat fetches the draft)
  if (chatWorkspace) {
    await fetch(`/api/workspace-state/${encodeURIComponent(chatWorkspace)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionNum: num,
        draftMode: chatActiveCli === "claude" ? "claude-local" : "gemini",
      }),
    }).catch(() => {});
  }

  // Update URL
  const cur = getChatParams();
  setChatParams({ ...cur, chat: num });

  // Reload history for the new session (chatShowChat calls chatRestoreDraft)
  chatShowChat();
}

// Cached model list (fetched from server)
let chatModelsFetched = false;

/**
 * Fetch available models from the server and populate the model selector.
 * Only fetches once per page load; call chatRefreshModels() to force refresh.
 */
async function chatFetchModels() {
  if (chatModelsFetched) return;
  try {
    const endpoint = chatActiveCli === "claude" ? "/api/claude-chat/models" : "/api/gemini/models";
    const res = await fetch(endpoint);
    const models = await res.json();
    if (!Array.isArray(models) || !models.length) return;

    const select = document.getElementById("chat-model");
    if (!select) return;

    // Preserve current selection
    const prev = select.value;

    // Clear all options
    select.innerHTML = "";

    // Gemini has a real "Auto" mode (classifier-routed); Claude does not
    if (chatActiveCli !== "claude") {
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
    const savedModel = chatWorkspace ? localStorage.getItem(`klaudii-model-${chatWorkspace}`) : null;
    const preferred = prev || savedModel;
    if (preferred && [...select.options].some((o) => o.value === preferred)) {
      select.value = preferred;
    }

    chatModelsFetched = true;
  } catch {
    // Keep whatever is in the select
  }
}

/**
 * Force a model list refresh (e.g. after saving an API key).
 */
function chatRefreshModels() {
  chatModelsFetched = false;
  chatFetchModels();
}

/**
 * Fetch and display quota info in the top bar.
 * Shows remaining fraction as a compact badge (e.g. "87% quota").
 */
async function chatFetchQuota() {
  const el = document.getElementById("chat-quota");
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
    el.className = "chat-bar-quota" + (pct <= 10 ? " low" : pct <= 30 ? " warn" : "");

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
let chatCurrentMsgEl = null;
let chatCurrentMsgText = "";
// Partial assistant bubble shown while polling mid-stream (opened while away)
let chatPartialMsgEl = null;

// --- Image attachments ---

let chatPendingImages = []; // [{ id, dataUrl, name }]
let chatImageIdCounter = 0;

function chatAddImage(dataUrl, name) {
  const id = ++chatImageIdCounter;
  chatPendingImages.push({ id, dataUrl, name: name || `image${id}` });
  chatRenderImageStrip();
}

function chatRemoveImage(id) {
  chatPendingImages = chatPendingImages.filter((i) => i.id !== id);
  chatRenderImageStrip();
}

function chatClearImages() {
  chatPendingImages = [];
  chatRenderImageStrip();
}

function chatRenderImageStrip() {
  const strip = document.getElementById("chat-image-strip");
  const attachBtn = document.getElementById("chat-attach");
  if (!strip) return;
  if (chatPendingImages.length === 0) {
    strip.classList.add("hidden");
    strip.innerHTML = "";
    if (attachBtn) attachBtn.classList.remove("has-images");
    return;
  }
  strip.classList.remove("hidden");
  if (attachBtn) attachBtn.classList.add("has-images");
  strip.innerHTML = chatPendingImages.map((img) =>
    `<div class="chat-img-thumb" title="${esc(img.name)}">
      <img src="${img.dataUrl}" alt="${esc(img.name)}">
      <button class="chat-img-remove" onclick="chatRemoveImage(${img.id})" title="Remove">×</button>
    </div>`
  ).join("");
}

function chatHandleFileInput(event) {
  const files = Array.from(event.target.files || []);
  files.forEach((file) => chatLoadImageFile(file));
  event.target.value = ""; // reset so same file can be re-added
}

function chatLoadImageFile(file) {
  if (!file.type.startsWith("image/")) return;
  const reader = new FileReader();
  reader.onload = (e) => chatAddImage(e.target.result, file.name);
  reader.readAsDataURL(file);
}

// Only show attach button when in claude-local mode (direct API supports images)
function chatUpdateAttachVisibility() {
  const btn = document.getElementById("chat-attach");
  const fileInput = document.getElementById("chat-file-input");
  if (!btn) return;
  const show = chatActiveCli === "claude";
  btn.style.display = show ? "" : "none";
  if (fileInput) fileInput.disabled = !show;
  if (!show) chatClearImages();
}

// Show permission mode selector for both Claude and Gemini
function chatUpdatePermissionVisibility() {
  const el = document.getElementById("chat-permission-mode");
  if (!el) return;
  el.style.display = ""; // visible for all backends
}

function chatGetPermissionMode() {
  const el = document.getElementById("chat-permission-mode");
  return el ? (el.value || "bypassPermissions") : undefined;
}

function chatSavePermissionMode(value) {
  if (chatWorkspace) localStorage.setItem(`klaudii-perm-${chatWorkspace}`, value);
}

function chatRestorePermissionMode() {
  const el = document.getElementById("chat-permission-mode");
  if (!el || !chatWorkspace) return;
  const saved = localStorage.getItem(`klaudii-perm-${chatWorkspace}`);
  el.value = saved || "bypassPermissions";
}

/**
 * Fetch global settings and apply provider defaults to the UI selectors.
 * Only applies if the user hasn't already set a per-workspace override (localStorage).
 */
async function chatApplyDefaults() {
  try {
    const res = await fetch("/api/settings");
    if (!res.ok) return;
    const settings = await res.json();
    const provider = chatActiveCli === "claude" ? "claude" : "gemini";
    const defaults = settings.defaults?.[provider];
    if (!defaults) return;

    // Permission mode: only apply default if no per-workspace override saved
    const permEl = document.getElementById("chat-permission-mode");
    if (permEl && chatWorkspace && !localStorage.getItem(`klaudii-perm-${chatWorkspace}`)) {
      if (defaults.permissionMode) permEl.value = defaults.permissionMode;
    }

    // Model: only apply default if no per-workspace override saved
    const modelEl = document.getElementById("chat-model");
    if (modelEl && chatWorkspace && !localStorage.getItem(`klaudii-model-${chatWorkspace}`)) {
      if (defaults.model) modelEl.value = defaults.model;
    }

    // Thinking (Claude only): apply default if no per-workspace override
    if (provider === "claude" && defaults.thinking !== undefined && chatWorkspace) {
      if (!localStorage.getItem(`klaudii-thinking-${chatWorkspace}`)) {
        chatThinkingEnabled = !!defaults.thinking;
        const toggle = document.getElementById("chat-thinking-toggle");
        if (toggle) toggle.classList.toggle("active", chatThinkingEnabled);
      }
    }
  } catch { /* non-fatal */ }
}

// Draft sync — relay over WS for instant multi-window sync, HTTP PATCH fallback
let chatDraftTimer = null;

function chatSaveDraft(text) {
  if (!chatWorkspace) return;
  clearTimeout(chatDraftTimer);
  const workspace = chatWorkspace;
  chatPageSessionDrafts.add(workspace);
  const draftMode = chatActiveCli === "claude" ? "claude-local" : "gemini";
  const draftSession = chatSessionNum;
  chatDraftTimer = setTimeout(() => {
    if (chatWs && chatWs.readyState === WebSocket.OPEN) {
      chatWs.send(JSON.stringify({ type: "draft", workspace, text, draftMode, draftSession }));
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

async function chatRestoreDraft(prefetchedState = null) {
  if (!chatWorkspace) return;
  const workspaceAtCall = chatWorkspace;
  const input = document.getElementById("chat-input");
  if (!input) return;
  // Only restore drafts saved during this page session to avoid stale state on load
  if (!chatPageSessionDrafts.has(chatWorkspace)) {
    input.value = "";
    return;
  }
  try {
    const state = prefetchedState || await fetch(`/api/workspace-state/${encodeURIComponent(chatWorkspace)}`).then(r => r.json());
    // Don't apply if workspace changed during async fetch
    if (chatWorkspace !== workspaceAtCall) return;
    input.value = state.draft || "";
  } catch { /* non-fatal */ }
}

// --- WebSocket ---

/** Send a message over the chat WS, auto-injecting sessionNum for the current chat. */
function chatWsSend(payload) {
  if (!chatWs || chatWs.readyState !== WebSocket.OPEN) return;
  // Always include sessionNum so the server routes to the correct relay/history
  if (payload.workspace && !payload.sessionNum && chatSessionNum) {
    payload.sessionNum = chatSessionNum;
  }
  chatWs.send(JSON.stringify(payload));
}

let chatConnectTimeout = null;

function chatConnect() {
  if (chatWs && chatWs.readyState === WebSocket.OPEN) return;

  // Close stale socket to prevent orphaned event handlers
  if (chatWs) {
    chatWs.onclose = null;
    chatWs.onerror = null;
    chatWs.onopen = null;
    chatWs.onmessage = null;
    if (chatWs.readyState !== WebSocket.CLOSED) chatWs.close();
  }

  clearTimeout(chatConnectTimeout);

  const wsUrl = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/chat`;
  console.log("[chat-ws] connecting to", wsUrl);
  chatWs = new WebSocket(wsUrl);

  // Timeout: if the socket doesn't reach OPEN within 5s, kill it and retry
  chatConnectTimeout = setTimeout(() => {
    if (chatWs && chatWs.readyState === WebSocket.CONNECTING) {
      glog("ws-connect-timeout: stuck in CONNECTING, forcing close");
      chatWs.onclose = null;
      chatWs.onerror = null;
      chatWs.onopen = null;
      chatWs.onmessage = null;
      chatWs.close();
      chatWs = null;
      setTimeout(chatConnect, 1000);
    }
  }, 5000);

  chatWs.onopen = () => {
    glog("ws-open");
    clearTimeout(chatConnectTimeout);
    chatUpdateStatus(true);
    // If history fetch failed while server was restarting, re-render now that it's up
    if (chatHistoryFetchFailed && chatWorkspace) {
      chatHistoryFetchFailed = false;
      chatWasStreamingAtDisconnect = false; // clear here too — showChat re-renders everything
      glog("ws-open: retrying history fetch after server restart");
      chatShowChat();
    } else if (chatWasStreamingAtDisconnect && chatWorkspace) {
      // Disconnected mid-stream — check whether it's still running or completed
      chatWasStreamingAtDisconnect = false;
      fetch(`/api/workspace-state/${encodeURIComponent(chatWorkspace)}`)
        .then(r => r.json())
        .then(wsState => {
          if (wsState.streaming) {
            // Stream survived the reconnect (transient blip) — re-enter poll mode
            // with partial content so the user catches up immediately
            chatOpenedWhileStreaming = true;
            chatShowChat();
          } else {
            // Stream completed while disconnected — render recovered content
            chatRenderRecoveredContent();
          }
        })
        .catch(() => chatRenderRecoveredContent());
    }
  };

  chatWs.onclose = (evt) => {
    glog("ws-close code=" + evt.code, "reason=" + (evt.reason || ""));
    chatUpdateStatus(false);
    // If a stream was in progress, clear it so the UI doesn't hang
    if (chatStreaming) {
      chatWasStreamingAtDisconnect = true;
      chatRemoveThinking();
      chatSetStreaming(false);
      chatCurrentMsgEl = null;
      chatCurrentMsgText = "";
      chatAppendError("Connection lost — response may be incomplete.");
    }
    chatStopStreamPoll();
    // Reconnect after 2s
    setTimeout(chatConnect, 2000);
  };

  chatWs.onerror = (evt) => {
    glog("ws-error", evt);
  };

  let wsEventCount = 0;
  chatWs.onmessage = (evt) => {
    let event;
    try {
      event = JSON.parse(evt.data);
    } catch {
      glog("ws-msg: invalid JSON", evt.data.slice(0, 100));
      return;
    }

    wsEventCount++;

    // Server push — global data (sessions, processes, health), not workspace-specific
    if (event.type === "server_push") {
      if (typeof handleServerPush === "function") handleServerPush(event);
      return;
    }

    // Corgi mode — global toggle
    if (event.type === "corgi") {
      chatSetCorgiMode(event.on);
      return;
    }

    glog(`ws-msg #${wsEventCount} type=${event.type} workspace=${event.workspace}${event.role ? " role=" + event.role : ""}${event.content ? " contentLen=" + event.content.length : ""}${event.exitCode !== undefined ? " exitCode=" + event.exitCode : ""}${event.name ? " tool=" + event.name : ""}`);

    // Only render events for the currently open workspace
    if (event.workspace !== chatWorkspace) {
      glog(`ws-msg: ignoring (current workspace=${chatWorkspace})`);
      return;
    }

    // Filter by session: if event has a sessionNum, only render for matching session
    if (event.sessionNum != null && chatSessionNum != null && event.sessionNum !== chatSessionNum) {
      glog(`ws-msg: ignoring (current session=${chatSessionNum}, event session=${event.sessionNum})`);
      return;
    }

    handleGeminiEvent(event);
  };
}

let chatServerConnected = true; // unified connection state

function chatUpdateStatus(connected) {
  const el = document.getElementById("chat-status");
  const wasConnected = chatServerConnected;
  chatServerConnected = connected;

  if (el) {
    if (connected) {
      el.textContent = "connected";
      el.className = "chat-bar-status connected";
    } else {
      el.textContent = "disconnected";
      el.className = "chat-bar-status";
    }
  }

  // Sync the top-level status badge with WS state — this is the authoritative
  // connection indicator. Prevents the badge from getting stuck "offline" when
  // HTTP health polls fail but the WS has already reconnected, or vice versa.
  const badge = document.getElementById("status-badge");
  if (badge) {
    if (connected) {
      badge.textContent = "connected";
      badge.className = "badge ok";
    } else {
      badge.textContent = "disconnected";
      badge.className = "badge error";
    }
  }

  const input = document.getElementById("chat-input");
  const sendBtn = document.getElementById("chat-send");

  const inputCard = input ? input.closest(".chat-input-card") : null;

  if (connected) {
    // Re-enable input
    if (input && !chatStreaming) {
      input.disabled = false;
      input.placeholder = chatActiveCli === "claude" ? "Message Claude\u2026" : "Message Gemini\u2026";
    }
    if (sendBtn && !chatStreaming) sendBtn.disabled = false;
    if (inputCard) inputCard.classList.remove("disconnected");

    // Remove disconnect banner
    const banner = document.getElementById("chat-disconnect-banner");
    if (banner) banner.remove();

    // Show "Reconnected" toast briefly (only if was previously disconnected)
    if (!wasConnected) {
      chatShowReconnectedToast();
      // Restore draft from localStorage
      chatRestoreDraftFromLocal();
    }
  } else {
    // Disable input so users don't type into a dead connection
    if (input) {
      input.disabled = true;
      input.placeholder = "Server disconnected\u2026";
    }
    if (sendBtn) sendBtn.disabled = true;
    if (inputCard) inputCard.classList.add("disconnected");

    // Save draft to localStorage so it survives page reload
    chatSaveDraftToLocal();

    // Show disconnect banner in the chat area
    chatShowDisconnectBanner();
  }
}

function chatSaveDraftToLocal() {
  const input = document.getElementById("chat-input");
  if (!input || !input.value.trim()) return;
  const key = `klaudii-draft-${chatWorkspace || "global"}`;
  localStorage.setItem(key, input.value);
}

function chatRestoreDraftFromLocal() {
  const input = document.getElementById("chat-input");
  if (!input || !chatWorkspace) return;
  const key = `klaudii-draft-${chatWorkspace}`;
  const saved = localStorage.getItem(key);
  if (saved && !input.value.trim()) {
    input.value = saved;
    // Auto-resize
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 256) + "px";
  }
  localStorage.removeItem(key);
}

function chatShowDisconnectBanner() {
  if (document.getElementById("chat-disconnect-banner")) return;
  const container = document.getElementById("chat-messages");
  if (!container) return;
  const banner = document.createElement("div");
  banner.id = "chat-disconnect-banner";
  banner.className = "chat-disconnect-banner";
  banner.textContent = "Server disconnected — reconnecting\u2026";
  container.appendChild(banner);
  chatScrollToBottom();
}

function chatShowReconnectedToast() {
  const container = document.getElementById("chat-messages");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = "chat-reconnected-toast";
  toast.textContent = "Reconnected";
  container.appendChild(toast);
  chatScrollToBottom();
  setTimeout(() => toast.remove(), 3000);
}

/** Show a brief toast notification in the chat area. */
function chatShowToast(text) {
  const container = document.getElementById("chat-messages");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = "chat-toast";
  toast.textContent = text;
  container.appendChild(toast);
  chatScrollToBottom();
  setTimeout(() => toast.remove(), 3000);
}

// --- Event handling ---

function handleGeminiEvent(event) {
  const history = chatHistory[event.workspace] || [];

  switch (event.type) {
    case "init": {
      const sessionId = event.session_id || event.sessionId || null;
      glog("handle: init sessionId=" + (sessionId || "?") + " session#" + chatSessionNum);
      // Update URL with session number (not CLI session ID)
      if (chatSessionNum) {
        const cur = getChatParams();
        setChatParams({ ...cur, chat: chatSessionNum });
      }
      break;
    }

    case "ack":
      glog("handle: ack status=" + event.status);
      chatUpdateMsgStatus(event.status);
      break;

    case "message":
      if (event.role === "assistant" || !event.role) {
        // First assistant content — remove thinking indicator
        chatRemoveThinking();
        chatResetThinkingGap();

        const text = event.content || "";
        chatCurrentMsgText += text;
        glog(`handle: message delta=${event.delta || false} contentLen=${text.length} totalLen=${chatCurrentMsgText.length}`);

        if (!chatCurrentMsgEl && chatCurrentMsgText) {
          glog("handle: creating assistant message element");
          chatCurrentMsgEl = chatAppendMessage("assistant", "", true);
        }

        if (chatCurrentMsgEl) {
          const mdEl = chatCurrentMsgEl.querySelector(".md-content");
          if (mdEl) {
            mdEl.innerHTML = chatRenderMarkdown(chatCurrentMsgText);
          }
          chatScrollToBottom();
        }
      } else {
        glog(`handle: message role=${event.role} (skipping — user echo)`);
      }
      break;

    case "tool_use": {
      chatRemoveThinking();
      chatResetThinkingGap();
      const toolName = event.tool_name || event.name || "tool";
      const toolId = event.tool_id || "";
      const params = event.parameters || event.args || event.input || {};
      glog(`handle: tool_use name=${toolName} id=${toolId} awaiting=${!!event.awaiting_approval}`);
      // Remove or discard the current message element before the tool pill
      if (chatCurrentMsgEl) {
        if (!chatCurrentMsgText) {
          chatCurrentMsgEl.remove();
        } else {
          chatCurrentMsgEl.classList.remove("chat-streaming");
        }
      }
      chatCurrentMsgEl = null;
      chatCurrentMsgText = "";
      if (toolName === "ExitPlanMode") {
        // Don't render here — the permission_request handler renders the
        // interactive plan approval card. Rendering here causes a duplicate.
        // Store as pending so tool_result can find the plan text later.
        pendingToolUses.set(toolId, { tool_name: toolName, tool_id: toolId, parameters: params });
        glog("handle: ExitPlanMode (skipped, waiting for permission_request) toolId=" + toolId);
      } else if (toolName === "EnterPlanMode") {
        // Planning mode entry — just show a small indicator, no action needed
        chatAppendToolUse(toolName, toolId, params);
      } else if (/ask.*question|ask_user|askfollowup|ask_followup/i.test(toolName)) {
        chatAskToolIds.add(toolId);
        if (event.awaiting_approval) {
          // Gemini A2A (ask_user normalized to AskUserQuestion) — render question card and send answer via confirm
          const questions = params.questions?.length
            ? params.questions
            : [{ question: params.question || params.prompt || "", options: params.options || [] }];
          const callId = event.call_id || toolId;
          chatShowToolQuestions(callId, questions, params, false,
            (answer) => chatConfirmTool(callId, "proceed_once", answer));
        }
        // else: Claude path — skip here, permission_request handler renders the card
        glog(`handle: ask-tool awaiting=${!!event.awaiting_approval} toolId=${toolId}`);
      } else if (event.awaiting_approval) {
        // Interactive approval prompt — show Approve/Deny buttons
        chatShowApprovalPrompt(event);
      } else {
        chatAppendToolUse(toolName, toolId, params);
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
      // Check both tool_name (if present) and our tracked set (CLI often omits tool_name on results).
      const isAskResult = /ask.*question|ask_user/i.test(toolName) || chatAskToolIds.has(toolId);
      // ExitPlanMode results are handled by the plan approval card — skip rendering.
      const isPlanResult = /ExitPlanMode/i.test(toolName) || (pendingToolUses.has(toolId) && pendingToolUses.get(toolId).tool_name === "ExitPlanMode");
      if (isAskResult) {
        chatAskToolIds.delete(toolId);
      } else if (isPlanResult) {
        pendingToolUses.delete(toolId);
      } else {
        chatUpdateToolResult(toolId, status, output, error);
      }
      // Model continues processing after the tool — start gap timer so the
      // thinking orbital re-appears if there's an idle gap before the next event.
      chatResetThinkingGap();
      break;
    }

    case "error":
      chatRemoveThinking();
      chatClearThinkingGap();
      glog("handle: error message=" + (event.message || "?"));
      chatAppendError(event.message || "Unknown error");
      chatSetStreaming(false);
      break;

    case "done":
      chatRemoveThinking();
      chatClearThinkingGap();
      chatStopStreamPoll(); // cancel any open-while-streaming poll — live WS beat it
      glog(`handle: done exitCode=${event.exitCode} stopped=${event.stopped || false} assistantTextLen=${chatCurrentMsgText.length} stderr=${(event.stderr || "").slice(0, 200)}`);
      if (chatCurrentMsgText) {
        history.push({ role: "assistant", content: chatCurrentMsgText });
        chatHistory[event.workspace] = history;
      }
      // Stamp the assistant bubble with completion time
      chatStampMessageTime(chatCurrentMsgEl, Date.now());

      // Finalize any orphaned running pills — tool_result events are emitted
      // before "done", so any pills still showing "running" at this point
      // never received their result (e.g. process stopped, relay crash).
      chatFinalizeOrphanedPills();

      chatSetStreaming(false);
      chatCurrentMsgEl = null;
      chatCurrentMsgText = "";

      // If a partial bubble was showing (opened mid-stream), replace it with the full response
      if (chatPartialMsgEl) {
        const partialEl = chatPartialMsgEl;
        chatPartialMsgEl = null;
        const doneWs = event.workspace;
        const doneSn = chatSessionNum;
        chatFetchHistory(doneWs, doneSn)
          .then(result => {
            const hist = result.messages || [];
            const lastMsg = hist && [...hist].reverse().find(m => m.role === "assistant");
            if (lastMsg) {
              const mdEl = partialEl.querySelector(".md-content");
              if (mdEl) mdEl.innerHTML = chatRenderMarkdown(lastMsg.content);
              chatStampMessageTime(partialEl, lastMsg.ts || Date.now());
              chatHistory[doneWs] = hist;
            }
            partialEl.classList.remove("chat-streaming");
            chatScrollToBottom();
          })
          .catch(() => { partialEl.classList.remove("chat-streaming"); });
      }

      // Exit code 41 = auth failure (Gemini), auth errors (Claude) — show auth panel
      if (event.exitCode === 41) {
        glog("handle: auth failure (exit 41), showing auth panel");
        chatShowAuthPanel();
      } else if (event.exitCode && event.exitCode !== 0 && event.stderr && isAuthError(event.stderr)) {
        glog("handle: auth failure detected in stderr, showing auth panel");
        chatShowAuthPanel();
      } else if (event.exitCode && event.exitCode !== 0 && event.stderr) {
        chatAppendError(`Process exited with code ${event.exitCode}: ${event.stderr.slice(0, 500)}`);
      }
      break;

    case "status": {
      // Server-forwarded stderr status (e.g. quota retries)
      const msg = event.message || "";
      glog("handle: status " + msg);
      const thinkLabel = document.querySelector("#chat-thinking .chat-thinking-label");
      if (thinkLabel) {
        thinkLabel.textContent = msg.length > 80 ? msg.slice(0, 77) + "..." : msg;
      }
      break;
    }

    case "draft": {
      // Another window updated the draft — apply unless user is actively typing here
      if (!chatLocalDraftActive) {
        const input = document.getElementById("chat-input");
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
      if (!chatHistory[event.workspace]) chatHistory[event.workspace] = [];
      chatHistory[event.workspace].push({ role: "user", content: event.content, sender: event.sender });
      chatAppendMessage("user", event.content, false, null, event.ts, event.sender);
      // Clear input since the message was sent
      const input = document.getElementById("chat-input");
      if (input) {
        input.value = "";
        input.style.height = "auto";
      }
      break;
    }

    case "streaming_start":
      // Another window started a send — show thinking indicator
      glog("handle: streaming_start from another window");
      chatSetStreaming(true);
      chatShowThinking();
      break;

    case "permission_request":
      chatRemoveThinking();
      chatClearThinkingGap(); // don't auto-show thinking while waiting for user approval
      glog("handle: permission_request request_id=" + event.request_id + " tool=" + event.tool_name);
      // AskUserQuestion: show interactive question card. The user's answers are
      // sent back as `updatedInput.answers` in the permission_response — NOT as a
      // separate tool_result. The tool's call() reads answers from its input.
      if (event.tool_name === "AskUserQuestion" || event.tool_name === "ask_followup_question") {
        // Remove the pending tool pill that tool_use created for this tool
        const pendingPill = document.querySelector(`.chat-tool.running[data-tool-name="AskUserQuestion"], .chat-tool.running[data-tool-name="ask_followup_question"]`);
        if (pendingPill) pendingPill.remove();
        const toolInput = event.tool_input || {};
        const questions = toolInput.questions?.length
          ? toolInput.questions
          : [{ question: toolInput.question || toolInput.prompt || "", options: toolInput.options || toolInput.choices || [] }];
        chatShowToolQuestions(event.request_id, questions, toolInput, true);
        break;
      }
      // Auto-approve EnterPlanMode — it just switches Claude into planning mode
      if (event.tool_name === "EnterPlanMode") {
        if (chatWs && chatWs.readyState === WebSocket.OPEN) {
          chatWsSend({ type: "permission_response", workspace: chatWorkspace, request_id: event.request_id, behavior: "allow", updatedInput: event.tool_input || {} });
        }
        break;
      }
      // ExitPlanMode: show plan approval card with the plan content from tool_input
      if (event.tool_name === "ExitPlanMode") {
        chatShowPlanApproval(event.request_id, (event.tool_input || {}).plan || "", true);
        break;
      }
      chatShowPermissionRequest(event.request_id, event.tool_name, event.tool_input, event.description, event.decision_reason);
      break;

    case "permission_resolved":
      // Another client already responded to this permission_request.
      // Update the UI to show the resolved state with answers.
      glog("handle: permission_resolved request_id=" + event.request_id + " behavior=" + event.behavior + " tool=" + event.tool_name);
      chatResolvePermissionUI(event.request_id, event.behavior, event.tool_name, event.updatedInput);
      break;

    case "thinking":
      chatRemoveThinking();
      chatResetThinkingGap();
      glog("handle: thinking contentLen=" + (event.content || "").length);
      chatAppendThinkingBlock(event.content || "");
      break;

    case "tool_progress": {
      const tpId = event.tool_use_id || "";
      const elapsed = event.elapsed_time_seconds;
      glog(`handle: tool_progress id=${tpId} elapsed=${elapsed}s`);
      if (tpId && elapsed != null) {
        const pill = document.querySelector(`.chat-tool.running[data-tool-id="${CSS.escape(tpId)}"]`);
        if (pill) {
          let timerEl = pill.querySelector(".chat-tool-timer");
          if (!timerEl) {
            timerEl = document.createElement("span");
            timerEl.className = "chat-tool-timer";
            const summary = pill.querySelector(".chat-tool-summary");
            if (summary) summary.appendChild(timerEl);
          }
          timerEl.textContent = ` ${Math.round(elapsed)}s`;
        }
      }
      break;
    }

    case "usage":
      // Per-turn usage update — update context remaining display
      if (event.cumulative) chatUpdateCumulativeStats(event.cumulative);
      break;

    case "result":
      glog("handle: result stats=" + JSON.stringify(event.stats || {}).slice(0, 200) + " subtype=" + (event.subtype || "success"));
      chatShowResultFooter(event.stats, event.subtype, event.errors);
      if (event.cumulative) chatUpdateCumulativeStats(event.cumulative);
      break;

    case "system_status":
      glog("handle: system_status status=" + event.status + " permMode=" + event.permissionMode);
      if (event.permissionMode) {
        chatAppendSystemNote("Permission mode changed to " + event.permissionMode);
      }
      break;

    case "compact_boundary":
      glog("handle: compact_boundary pre=" + event.pre_tokens + " post=" + event.post_tokens);
      if (chatIsDebugMode()) chatAppendSystemNote(
        "Context compacted" + (event.pre_tokens ? ` (was ~${Math.round(event.pre_tokens / 1000)}k tokens)` : "")
      );
      break;

    case "context_warning":
      glog("handle: context_warning usedPct=" + event.usedPct);
      if (chatIsDebugMode()) chatAppendSystemNote(
        `Context ${event.usedPct}% full \u2014 handoff will trigger at 75%`
      );
      break;

    case "context_reload":
      glog("handle: context_reload reason=" + event.reason + " usedPct=" + event.usedPct);
      if (chatIsDebugMode()) chatAppendSystemNote(
        "Context handoff" + (event.usedPct ? ` (was ${event.usedPct}% full)` : "") + " \u2014 swapping to fresh context, conversation continues here..."
      );
      break;

    case "handoff_complete":
      glog("handle: handoff_complete workspace=" + event.workspace);
      if (chatIsDebugMode()) chatAppendSystemNote("Handoff complete \u2014 fresh context ready.");
      break;

    case "session_handoff":
      // Legacy: kept for backward compat, but handoff no longer changes session number.
      glog("handle: session_handoff newSession=" + event.newSession);
      if (event.newSession && event.workspace === chatWorkspace) {
        chatSessionNum = event.newSession;
        fetch(`/api/workspace-state/${encodeURIComponent(chatWorkspace)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionNum: event.newSession, draftMode: chatActiveCli === "claude" ? "claude-local" : "gemini" }),
        }).catch(() => {});
        const cur = getChatParams();
        setChatParams({ ...cur, chat: event.newSession });
        chatPopulateSessionDropdown();
      }
      break;

    case "task_started":
      glog("handle: task_started id=" + event.task_id + " desc=" + event.description);
      chatAppendTaskCard(event.task_id, event.description, "running");
      break;

    case "task_progress": {
      glog("handle: task_progress id=" + event.task_id);
      const taskCard = document.querySelector(`.chat-task-card[data-task-id="${CSS.escape(event.task_id)}"]`);
      if (taskCard) {
        const detail = taskCard.querySelector(".chat-task-detail");
        if (detail && event.tool_name) detail.textContent = `Last tool: ${event.tool_name}`;
      }
      break;
    }

    case "task_notification": {
      glog("handle: task_notification id=" + event.task_id + " status=" + event.status);
      const taskEl = document.querySelector(`.chat-task-card[data-task-id="${CSS.escape(event.task_id)}"]`);
      if (taskEl) {
        taskEl.classList.remove("running");
        taskEl.classList.add(event.status === "completed" ? "success" : "error");
        const statusEl = taskEl.querySelector(".chat-task-status");
        if (statusEl) statusEl.textContent = event.status === "completed" ? "✓ Completed" : "✗ " + event.status;
        if (event.summary) {
          const sumEl = document.createElement("div");
          sumEl.className = "chat-task-summary";
          sumEl.textContent = event.summary;
          taskEl.appendChild(sumEl);
        }
      }
      break;
    }

    case "command_result": {
      glog("handle: command_result command=" + event.command);
      if (event.command === "stats" && event.data && typeof event.data === "object") {
        chatRenderStatsPanel(event.data);
      } else if (event.command === "about" && event.data && typeof event.data === "object") {
        chatRenderAboutCard(event.data);
      } else {
        const pre = document.createElement("pre");
        pre.style.cssText = "margin:0;white-space:pre-wrap;font-size:0.8rem;color:var(--text-muted)";
        pre.textContent = typeof event.data === "string" ? event.data : JSON.stringify(event.data, null, 2);
        const wrapper = document.createElement("div");
        wrapper.className = "chat-system-note";
        wrapper.appendChild(pre);
        document.getElementById("chat-messages")?.appendChild(wrapper);
      }
      chatScrollToBottom();
      break;
    }

    case "command_error": {
      glog("handle: command_error command=" + event.command + " message=" + event.message);
      chatAppendError(`/${event.command}: ${event.message}`);
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
function chatResolvePermissionUI(requestId, behavior, toolName, updatedInput) {
  const container = document.getElementById("chat-messages");
  if (!container) return;
  const sel = CSS.escape(requestId);
  const cards = container.querySelectorAll(
    `.chat-permission-request[data-request-id="${sel}"], .chat-plan-approval[data-request-id="${sel}"], .chat-question-card[data-request-id="${sel}"]`
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

function chatShowPermissionRequest(requestId, toolName, toolInput, description, decisionReason) {
  const container = document.getElementById("chat-messages");
  const div = document.createElement("div");
  div.className = "chat-permission-request";
  div.dataset.requestId = requestId;

  const header = document.createElement("div");
  header.className = "chat-permission-header";
  header.textContent = toolName ? `Claude wants to use: ${toolName}` : "Claude is asking for permission";
  div.appendChild(header);

  // Show human-readable description if available
  if (description) {
    const descEl = document.createElement("div");
    descEl.className = "chat-permission-desc";
    descEl.textContent = description;
    div.appendChild(descEl);
  }

  // Show decision reason if available
  if (decisionReason) {
    const reasonEl = document.createElement("div");
    reasonEl.className = "chat-permission-reason";
    reasonEl.textContent = decisionReason;
    div.appendChild(reasonEl);
  }

  // Show key input fields for context (command, file_path, etc.)
  if (toolInput && Object.keys(toolInput).length) {
    const detail = document.createElement("div");
    detail.className = "chat-permission-question";
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
  btns.className = "chat-permission-buttons";

  const respond = (behavior) => {
    btns.querySelectorAll("button").forEach(b => { b.disabled = true; });
    const chosen = btns.querySelector(`[data-behavior="${behavior}"]`);
    if (chosen) chosen.textContent += " ✓";
    chatWsSend({
      type: "permission_response",
      workspace: chatWorkspace,
      request_id: requestId,
      behavior,
      updatedInput: behavior === "allow" ? (toolInput || {}) : undefined,
    });
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
  chatScrollToBottom();
}

/**
 * Show a plan approval card. Renders the plan as markdown with Approve/Reject buttons.
 * @param {string} id - Either a tool_id (bypass mode) or request_id (permission mode)
 * @param {string} planText - The markdown plan content
 * @param {boolean} isPermissionRequest - true if this is a permission_request (non-bypass mode)
 */
function chatShowPlanApproval(id, planText, isPermissionRequest, target) {
  const container = target || document.getElementById("chat-messages");

  // Remove any existing running tool pill for this id (the generic one from tool_use)
  const existingPill = container.querySelector(`.chat-tool.running[data-tool-id="${CSS.escape(id)}"]`);
  if (existingPill) existingPill.remove();

  const div = document.createElement("div");
  div.className = "chat-plan-approval";
  if (isPermissionRequest) div.dataset.requestId = id;

  const header = document.createElement("div");
  header.className = "chat-plan-header";
  header.textContent = "Claude has proposed a plan";
  div.appendChild(header);

  if (planText) {
    const content = document.createElement("div");
    content.className = "chat-plan-content md-content";
    content.innerHTML = chatRenderMarkdown(planText);
    div.appendChild(content);
  }

  const btns = document.createElement("div");
  btns.className = "chat-permission-buttons";

  const respond = (approved) => {
    btns.querySelectorAll("button").forEach(b => { b.disabled = true; });
    div.classList.add(approved ? "approved" : "rejected");
    header.textContent = approved ? "Plan approved" : "Plan rejected";

    if (isPermissionRequest) {
      // Non-bypass mode: send permission_response.
      // updatedInput is REQUIRED by Claude CLI's Zod schema for "allow" responses.
      if (chatWs && chatWs.readyState === WebSocket.OPEN) {
        const payload = {
          type: "permission_response",
          workspace: chatWorkspace,
          request_id: id,
          behavior: approved ? "allow" : "deny",
        };
        if (approved) payload.updatedInput = { plan: planText };
        chatWsSend(payload);
      }
    } else {
      // Bypass mode: plan already executed. Send follow-up message to instruct Claude.
      if (!approved) {
        chatWsSend({
          type: "send",
          workspace: chatWorkspace,
          message: "I reject this plan. Please revise it.",
          backend: "claude",
        });
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
  if (!target) chatScrollToBottom();
}

// questions: [{question, header, options:[string|{label,description}], multiSelect?}]
// id: either a tool_id (bypass mode / Gemini) or request_id (permission mode)
// toolInput: original tool input for AskUserQuestion (used to build updatedInput)
// isPermissionRequest: true → send answers via permission_response updatedInput.answers
//                      false → send answers via tool_result_response content string
function chatShowToolQuestions(id, questions, toolInput, isPermissionRequest, onAnswer) {
  const container = document.getElementById("chat-messages");
  const div = document.createElement("div");
  div.className = isPermissionRequest ? "chat-permission-request chat-question-card" : "chat-permission-request";
  if (isPermissionRequest) div.dataset.requestId = id;

  const headerEl = document.createElement("div");
  headerEl.className = "chat-permission-header";
  headerEl.textContent = onAnswer ? "Gemini is asking" : "Claude is asking";
  div.appendChild(headerEl);

  const answers = new Array(questions.length).fill(null);

  const sendResult = () => {
    if (onAnswer) {
      // Gemini A2A ask_user: send answers keyed by index (matches gemini-cli-core format)
      const answersMap = {};
      answers.forEach((a, i) => { if (a != null) answersMap[String(i)] = a; });
      onAnswer(answersMap);
      return;
    }
    if (isPermissionRequest) {
      // Claude CLI AskUserQuestion: answers go in updatedInput.answers as {question: answer}
      const answersMap = {};
      questions.forEach((q, i) => {
        const key = q.question || q.header || `Q${i + 1}`;
        answersMap[key] = answers[i];
      });
      const updatedInput = { ...(toolInput || {}), answers: answersMap };
      glog(`tool_questions: sending permission_response request_id=${id} answers=${JSON.stringify(answersMap)}`);
      chatWsSend({
        type: "permission_response",
        workspace: chatWorkspace,
        request_id: id,
        behavior: "allow",
        updatedInput,
      });
    } else {
      // Gemini / bypass mode: answers as a formatted string via tool_result_response
      const content = questions.map((q, i) => {
        const prefix = q.header || q.question || `Q${i + 1}`;
        return `${prefix}: ${answers[i]}`;
      }).join("\n");
      glog(`tool_questions: sending tool_result_response tool_id=${id}`);
      chatWsSend({
        type: "tool_result_response",
        workspace: chatWorkspace,
        tool_id: id,
        content,
      });
    }
  };

  questions.forEach((q, qi) => {
    const section = document.createElement("div");
    section.className = "chat-question-section" + (qi > 0 ? " chat-question-section--subsequent" : "");

    if (q.question) {
      const qEl = document.createElement("div");
      qEl.className = "chat-permission-question";
      qEl.textContent = q.question;
      section.appendChild(qEl);
    }

    const btns = document.createElement("div");
    btns.className = "chat-permission-buttons";
    const rawOptions = q.options || q.choices || [];
    const renderOptions = rawOptions.length ? rawOptions : ["Yes", "No"];
    const isMulti = !!q.multiSelect;

    if (isMulti) {
      // Multi-select: checklist with green checkmarks + submit button
      const selected = new Set();
      const list = document.createElement("div");
      list.className = "chat-multiselect-list";
      renderOptions.forEach((opt) => {
        const row = document.createElement("label");
        row.className = "chat-multiselect-row";
        const check = document.createElement("span");
        check.className = "chat-multiselect-check";
        const labelText = typeof opt === "object" ? (opt.label || String(opt)) : String(opt);
        const text = document.createElement("span");
        text.textContent = labelText;
        if (typeof opt === "object" && opt.description) row.title = opt.description;
        row.appendChild(check);
        row.appendChild(text);
        row.onclick = () => {
          if (answers[qi] !== null) return;
          if (selected.has(labelText)) {
            selected.delete(labelText);
            row.classList.remove("checked");
          } else {
            selected.add(labelText);
            row.classList.add("checked");
          }
        };
        list.appendChild(row);
      });
      section.appendChild(list);
      const submitBtn = document.createElement("button");
      submitBtn.className = "btn primary chat-multiselect-submit";
      submitBtn.textContent = "Submit";
      submitBtn.onclick = () => {
        if (answers[qi] !== null) return;
        answers[qi] = Array.from(selected).join(", ") || "(none)";
        list.querySelectorAll(".chat-multiselect-row").forEach(r => { r.style.pointerEvents = "none"; });
        submitBtn.disabled = true;
        submitBtn.classList.add("greyed");
        glog(`tool_question[${qi}]: multi-selected=${answers[qi]}`);
        if (answers.every(a => a !== null)) sendResult();
      };
      section.appendChild(submitBtn);
    } else if (q.type === "text" || (q.type !== "yesno" && !rawOptions.length)) {
      // Free-form text input
      const wrap = document.createElement("div");
      wrap.className = "chat-text-input-wrap";
      const input = document.createElement("textarea");
      input.className = "chat-text-input";
      input.placeholder = q.placeholder || "Type your answer...";
      input.rows = 2;
      const submitBtn = document.createElement("button");
      submitBtn.className = "btn primary chat-multiselect-submit";
      submitBtn.textContent = "Submit";
      submitBtn.onclick = () => {
        if (answers[qi] !== null) return;
        answers[qi] = input.value.trim() || "(no response)";
        input.disabled = true;
        submitBtn.disabled = true;
        submitBtn.classList.add("greyed");
        glog(`tool_question[${qi}]: text=${answers[qi]}`);
        if (answers.every(a => a !== null)) sendResult();
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitBtn.click(); }
      });
      wrap.appendChild(input);
      wrap.appendChild(submitBtn);
      section.appendChild(wrap);
    } else {
      // Single-select: click to choose and auto-submit
      renderOptions.forEach((opt, i) => {
        const btn = document.createElement("button");
        btn.className = "btn";
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
    }

    section.appendChild(btns);
    div.appendChild(section);
  });

  container.appendChild(div);
  chatScrollToBottom();
}

// --- DOM rendering ---

function chatAppendMessage(role, content, streaming, images, ts, sender, msgStatus, target) {
  const container = target || document.getElementById("chat-messages");
  const div = document.createElement("div");
  div.className = `chat-msg ${role}${streaming ? " chat-streaming" : ""}`;

  if (role === "user") {
    const bubble = document.createElement("div");
    bubble.className = "user-bubble";
    // Render any attached images above the message text
    if (images && images.length) {
      const imgRow = document.createElement("div");
      imgRow.className = "chat-msg-images";
      images.forEach((img) => {
        const im = document.createElement("img");
        im.src = img.dataUrl;
        im.className = "chat-msg-img";
        im.alt = img.name || "attached image";
        imgRow.appendChild(im);
      });
      bubble.appendChild(imgRow);
    }
    const textNode = document.createElement("span");
    textNode.textContent = content;
    bubble.appendChild(textNode);
    div.appendChild(bubble);
  } else {
    const md = document.createElement("div");
    md.className = "md-content";
    md.innerHTML = content ? chatRenderMarkdown(content) : "";
    div.appendChild(md);
  }

  const timeStr = chatMsgTime(ts);
  if (timeStr || role === "user") {
    const tsEl = document.createElement("div");
    tsEl.className = "chat-msg-ts";
    if (timeStr) tsEl.textContent = timeStr;
    // Delivery checkmarks beside the timestamp for user messages
    if (role === "user") {
      const checks = document.createElement("span");
      checks.className = "msg-delivery-status";
      checks.dataset.status = msgStatus || "sending";
      checks.innerHTML = ' <span class="check check-1">\u2713</span><span class="check check-2">\u2713</span>';
      tsEl.appendChild(checks);
    }
    div.appendChild(tsEl);
  }

  container.appendChild(div);
  if (!target) chatScrollToBottom();
  return div;
}

/**
 * Update delivery status checkmarks on the last user message bubble.
 * received = first check green (server got it)
 * delivered = second check green (written to CLI stdin)
 * processing is treated as delivered (both green).
 */
function chatUpdateMsgStatus(status) {
  const container = document.getElementById("chat-messages");
  if (!container) return;
  // Find the last user message's delivery status element
  const userMsgs = container.querySelectorAll(".chat-msg.user .msg-delivery-status");
  const el = userMsgs.length ? userMsgs[userMsgs.length - 1] : null;
  if (!el) return;
  // Map processing to delivered (both checks green)
  const mapped = status === "processing" ? "delivered" : status;
  // Only allow forward progression
  const order = ["sending", "received", "delivered"];
  const cur = order.indexOf(el.dataset.status);
  const next = order.indexOf(mapped);
  if (next > cur) {
    el.dataset.status = mapped;
  }
}

// Legacy — kept for any remaining callers
function chatSetMsgStatusFloat(status) {
  chatUpdateMsgStatus(status);
}

/** Stamp a timestamp onto an already-rendered message element (used when assistant stream completes). */
function chatStampMessageTime(el, ts) {
  if (!el || !ts) return;
  const timeStr = chatMsgTime(ts);
  if (!timeStr) return;
  let tsEl = el.querySelector(".chat-msg-ts");
  if (!tsEl) {
    tsEl = document.createElement("div");
    tsEl.className = "chat-msg-ts";
    el.appendChild(tsEl);
  }
  tsEl.textContent = timeStr;
}

/** True for tools that show an old_string→new_string diff (Claude Edit, Gemini replace). */
function isEditLikeTool(name) {
  return /^(edit|replace)$/i.test(name || "");
}

/**
 * Build a short human-readable description from tool name + params object.
 */
function chatToolDescription(name, params) {
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
    case "replace":
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

function chatGroupItemLabel(toolName, count) {
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

function chatIsGroupableTool(toolName) {
  if (!toolName) return false;
  if (/^(ExitPlanMode|EnterPlanMode)$/i.test(toolName)) return false;
  if (/ask.*question|askfollowup|ask_followup/i.test(toolName)) return false;
  return true;
}

function chatCreateToolGroup(toolName, isRunning) {
  const group = document.createElement("details");
  group.open = true;
  group.className = `chat-tool chat-tool-group${isRunning ? " running" : ""}`;
  group.dataset.toolName = toolName;
  group.addEventListener("toggle", () => {
    if (!group.open && chatToolDisplayMode === "expanded") group.open = true;
  });

  const summary = document.createElement("summary");
  summary.className = "chat-tool-summary";
  summary.innerHTML =
    (isRunning ? `<span class="chat-tool-spinner"></span>` : "") +
    `<span class="chat-tool-name">${chatEscHtml(toolName)}</span>` +
    `<span class="chat-tool-group-count"></span>`;
  group.appendChild(summary);

  const itemsDiv = document.createElement("div");
  itemsDiv.className = "chat-tool-group-items";
  group.appendChild(itemsDiv);

  return group;
}

function chatMakeSubItem(toolName, toolId, params, isRunning, status, output) {
  const isError = status === "error";
  const readonly = isReadOnlyTool(toolName, params);
  const sub = document.createElement("details");
  sub.className = `chat-tool-sub${isRunning ? " running" : (isError ? " error" : " success")}`;
  sub.dataset.toolId = toolId || "";
  sub.dataset.toolName = toolName || "";
  sub.dataset.toolReadonly = readonly ? "true" : "false";
  if (!isRunning && chatToolDisplayMode === "expanded") sub.open = true;
  if (chatToolDisplayMode === "hidden" && !isRunning) {
    sub.style.display = "none";
  }

  const desc = chatToolDescription(toolName, params);
  const summary = document.createElement("summary");
  summary.className = "chat-tool-sub-summary";
  if (isRunning) {
    summary.innerHTML = `<span class="chat-tool-spinner"></span>`;
  } else {
    const iconChar = isError ? "\u2717" : "\u2713";
    summary.innerHTML = `<span class="chat-tool-icon ${isError ? "error" : "success"}">${iconChar}</span>`;
  }
  summary.innerHTML += `<span class="chat-tool-sub-desc">${chatEscHtml(desc || toolName || "")}</span>`;
  sub.appendChild(summary);
  if (isRunning) chatStartPillTimer(sub, summary);

  if (!isRunning && !isError && isEditLikeTool(toolName) && params && params.old_string != null) {
    chatRenderEditDiffFromParams(sub, params);
  } else {
    const paramsStr = typeof params === "object" ? JSON.stringify(params, null, 2) : String(params || "");
    if (paramsStr && paramsStr !== "{}") {
      const sec = document.createElement("div");
      sec.className = "chat-tool-section";
      sec.innerHTML = `<div class="chat-tool-section-label">Parameters</div>`;
      const pre = document.createElement("pre");
      pre.textContent = paramsStr;
      sec.appendChild(pre);
      sub.appendChild(sec);
    }
  }

  if (!isRunning) {
    const trimmed = (output || "").trim();
    if (trimmed && !(!isError && isEditLikeTool(toolName) && params?.old_string != null)) {
      const sec = document.createElement("div");
      sec.className = "chat-tool-section";
      sec.innerHTML = `<div class="chat-tool-section-label">${isError ? "Error" : "Output"}</div>`;
      const pre = document.createElement("pre");
      pre.textContent = trimmed.length > 5000 ? trimmed.slice(0, 5000) + "\n...(truncated)" : trimmed;
      sec.appendChild(pre);
      sub.appendChild(sec);
    }
  }

  return sub;
}

function chatUpdateGroupSummary(groupEl) {
  const items = groupEl.querySelectorAll(":scope > .chat-tool-group-items > .chat-tool-sub");
  const total = items.length;
  let errors = 0, running = 0;
  items.forEach(item => {
    if (item.classList.contains("running")) running++;
    else if (item.classList.contains("error")) errors++;
  });

  const toolName = groupEl.dataset.toolName;
  const countEl = groupEl.querySelector(":scope > .chat-tool-summary .chat-tool-group-count");
  if (countEl) {
    let text = chatGroupItemLabel(toolName, total);
    if (errors > 0 && running === 0) text += ` (${errors} error${errors > 1 ? "s" : ""})`;
    countEl.textContent = text;
  }

  const summary = groupEl.querySelector(":scope > .chat-tool-summary");
  if (running === 0) {
    groupEl.classList.remove("running");
    const isAllError = errors > 0 && errors === total;
    groupEl.classList.add(isAllError ? "error" : "success");
    const spinner = summary?.querySelector(".chat-tool-spinner");
    if (spinner) {
      const icon = document.createElement("span");
      icon.className = `chat-tool-icon ${isAllError ? "error" : "success"}`;
      icon.textContent = isAllError ? "\u2717" : "\u2713";
      spinner.replaceWith(icon);
    } else if (summary && !summary.querySelector(".chat-tool-icon")) {
      const icon = document.createElement("span");
      icon.className = `chat-tool-icon ${isAllError ? "error" : "success"}`;
      icon.textContent = isAllError ? "\u2717" : "\u2713";
      const nameEl = summary.querySelector(".chat-tool-name");
      if (nameEl) summary.insertBefore(icon, nameEl);
      else summary.prepend(icon);
    }
  }
}

function chatUpdateSubItemResult(subItem, status, output, error) {
  const isError = status === "error" || !!error;
  chatStopPillTimer(subItem);
  subItem.classList.remove("running");
  subItem.classList.add(isError ? "error" : "success");
  if (chatToolDisplayMode === "expanded") {
    subItem.open = true;
  } else {
    subItem.open = false;
  }

  const summary = subItem.querySelector(".chat-tool-sub-summary");
  const spinner = summary?.querySelector(".chat-tool-spinner");
  if (spinner) {
    const icon = document.createElement("span");
    icon.className = `chat-tool-icon ${isError ? "error" : "success"}`;
    icon.textContent = isError ? "\u2717" : "\u2713";
    spinner.replaceWith(icon);
  }

  const toolName = subItem.dataset.toolName || "";

  if (!isError && isEditLikeTool(toolName)) {
    chatRenderEditDiff(subItem);
  }

  const trimmed = (error || output || "").trim();
  if (trimmed && !(!isError && isEditLikeTool(toolName))) {
    const sec = document.createElement("div");
    sec.className = "chat-tool-section";
    sec.innerHTML = `<div class="chat-tool-section-label">${isError ? "Error" : "Output"}</div>`;
    const pre = document.createElement("pre");
    pre.textContent = trimmed.length > 5000 ? trimmed.slice(0, 5000) + "\n...(truncated)" : trimmed;
    sec.appendChild(pre);
    subItem.appendChild(sec);
  }

  const groupEl = subItem.closest(".chat-tool-group");
  if (groupEl) chatUpdateGroupSummary(groupEl);
}

function chatShowApprovalPrompt(event) {
  const container = document.getElementById("chat-messages");
  const div = document.createElement("div");
  div.className = "chat-approval-prompt";
  div.dataset.toolId = event.tool_id || "";
  const params = event.parameters || {};
  const paramsStr = JSON.stringify(params, null, 2);
  div.innerHTML = `
    <div class="chat-approval-header">
      <span class="chat-approval-icon">🔧</span>
      <span class="chat-approval-tool">${chatEscHtml(event.tool_name || "tool")}</span>
    </div>
    <pre class="chat-approval-params">${chatEscHtml(paramsStr)}</pre>
    <div class="chat-approval-buttons">
      <button class="btn primary chat-approve-once-btn">Approve Once</button>
      <button class="btn chat-approve-session-btn">Approve This Tool</button>
      <button class="btn chat-approve-always-btn">Approve All Tools</button>
      <button class="btn chat-deny-btn">Deny</button>
    </div>`;
  const callId = event.call_id;
  function resolveApproval(label, outcome) {
    div.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    div.querySelector(".chat-approval-buttons").innerHTML = `<span class="chat-approval-resolved">✓ ${chatEscHtml(label)}</span>`;
    chatConfirmTool(callId, outcome);
  }
  div.querySelector(".chat-approve-once-btn").onclick = () => resolveApproval("Approved once", "proceed_once");
  div.querySelector(".chat-approve-session-btn").onclick = () => resolveApproval("Approved for this tool", "proceed_always_tool");
  div.querySelector(".chat-approve-always-btn").onclick = () => resolveApproval("Approved all tools", "proceed_always");
  div.querySelector(".chat-deny-btn").onclick = () => {
    div.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    div.querySelector(".chat-approval-buttons").innerHTML = '<span class="chat-approval-resolved denied">✗ Denied</span>';
    chatConfirmTool(callId, "cancel");
  };
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function chatConfirmTool(callId, outcome, answer) {
  const body = answer ? { callId, outcome, answer, sessionNum: chatSessionNum } : { callId, outcome, sessionNum: chatSessionNum };
  glog("chatConfirmTool body:", JSON.stringify(body));
  fetch(`/api/gemini/${encodeURIComponent(chatWorkspace)}/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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
function chatRenderCompletedQuestion(params, output, status, target) {
  const container = target || document.getElementById("chat-messages");
  const div = document.createElement("div");
  div.className = "chat-permission-request";
  if (status === "error") div.classList.add("chat-question-error");

  const headerEl = document.createElement("div");
  headerEl.className = "chat-permission-header";
  headerEl.textContent = status === "error" ? "Question (failed)" : "Question";
  div.appendChild(headerEl);

  // Parse selected answers from output: "User has answered your questions: "Q"="A", "Q2"="B". You can..."
  const selectedAnswers = {};
  const answerMatches = (output || "").matchAll(/"([^"]+)"="([^"]+)"/g);
  for (const m of answerMatches) selectedAnswers[m[1]] = m[2];

  const questions = params.questions || [{ question: params.question || "", options: params.options || [] }];

  questions.forEach((q) => {
    const section = document.createElement("div");
    section.className = "chat-question-section";

    if (q.question) {
      const qEl = document.createElement("div");
      qEl.className = "chat-permission-question";
      qEl.textContent = q.question;
      section.appendChild(qEl);
    }

    const btns = document.createElement("div");
    btns.className = "chat-permission-buttons";
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
        ansEl.className = "chat-permission-question";
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

function chatRenderCompletedTool(toolName, toolId, params, status, output, target) {
  const container = target || document.getElementById("chat-messages");

  // Check if we can group with previous element
  if (chatIsGroupableTool(toolName)) {
    const lastEl = container.lastElementChild;
    if (lastEl && lastEl.dataset.toolName === toolName) {
      if (lastEl.classList.contains("chat-tool-group")) {
        const itemsDiv = lastEl.querySelector(".chat-tool-group-items");
        itemsDiv.appendChild(chatMakeSubItem(toolName, toolId, params, false, status, output));
        chatUpdateGroupSummary(lastEl);
        if (!target) chatScrollToBottom();
        return;
      }
      if (lastEl.classList.contains("chat-tool") && !lastEl.classList.contains("chat-tool-group")) {
        const group = chatCreateToolGroup(toolName, false);
        const itemsDiv = group.querySelector(".chat-tool-group-items");
        itemsDiv.appendChild(chatMakeSubItem(
          lastEl.dataset.toolName, lastEl.dataset.toolId,
          lastEl._toolParams || {}, false, lastEl._toolStatus || "success", lastEl._toolOutput || ""
        ));
        itemsDiv.appendChild(chatMakeSubItem(toolName, toolId, params, false, status, output));
        chatUpdateGroupSummary(group);
        container.replaceChild(group, lastEl);
        if (!target) chatScrollToBottom();
        return;
      }
    }
  }

  const isError = status === "error";
  const readonly = isReadOnlyTool(toolName, params);
  const pill = document.createElement("details");
  pill.open = chatInitialPillOpen();
  pill.className = `chat-tool ${isError ? "error" : "success"}`;
  pill.dataset.toolId = toolId || "";
  pill.dataset.toolName = toolName || "";
  pill.dataset.toolReadonly = readonly ? "true" : "false";
  pill._toolParams = params;
  pill._toolOutput = output || "";
  pill._toolStatus = status;
  pill.addEventListener("toggle", () => {
    if (!pill.open && chatToolDisplayMode === "expanded") pill.open = true;
  });

  if (!chatShouldShowTool(toolName, params)) {
    pill.style.display = "none";
  }

  const desc = chatToolDescription(toolName, params);
  const summary = document.createElement("summary");
  summary.className = "chat-tool-summary";
  const icon = isError ? "\u2717" : "\u2713";
  summary.innerHTML =
    `<span class="chat-tool-icon ${isError ? "error" : "success"}">${icon}</span>` +
    `<span class="chat-tool-name">${chatEscHtml(toolName || "tool")}</span>` +
    (desc ? `<span class="chat-tool-desc">${chatEscHtml(desc)}</span>` : "");
  pill.appendChild(summary);

  // Edit tool: show diff instead of raw params
  if (!isError && isEditLikeTool(toolName) && params && params.old_string != null) {
    chatRenderEditDiffFromParams(pill, params);
  } else {
    const paramsStr = typeof params === "object" ? JSON.stringify(params, null, 2) : String(params || "");
    if (paramsStr && paramsStr !== "{}") {
      const sec = document.createElement("div");
      sec.className = "chat-tool-section";
      sec.innerHTML = `<div class="chat-tool-section-label">Parameters</div>`;
      const pre = document.createElement("pre");
      pre.textContent = paramsStr;
      sec.appendChild(pre);
      pill.appendChild(sec);
    }
  }

  const trimmed = (output || "").trim();
  // Skip output for successful Edit diffs — the diff itself is the output
  if (trimmed && !(!isError && isEditLikeTool(toolName) && params?.old_string != null)) {
    const sec = document.createElement("div");
    sec.className = "chat-tool-section";
    sec.innerHTML = `<div class="chat-tool-section-label">${isError ? "Error" : "Output"}</div>`;
    const pre = document.createElement("pre");
    pre.textContent = trimmed.length > 5000 ? trimmed.slice(0, 5000) + "\n...(truncated)" : trimmed;
    sec.appendChild(pre);
    pill.appendChild(sec);
  }

  container.appendChild(pill);
  if (!target) chatScrollToBottom();
}

/** Start a client-side elapsed timer on a running pill/sub-item element. */
function chatStartPillTimer(el, summaryEl) {
  const timerEl = document.createElement("span");
  timerEl.className = "chat-tool-timer";
  timerEl.textContent = " 0s";
  if (summaryEl) summaryEl.appendChild(timerEl);
  el._timerStart = Date.now();
  el._timerInterval = setInterval(() => {
    const elapsed = Math.round((Date.now() - el._timerStart) / 1000);
    timerEl.textContent = ` ${elapsed}s`;
  }, 1000);
}

/** Stop the client-side elapsed timer on a pill/sub-item element. */
function chatStopPillTimer(el) {
  if (el._timerInterval) {
    clearInterval(el._timerInterval);
    el._timerInterval = null;
  }
}

/**
 * Append a tool-use pill. Starts in a "running" state with a spinner.
 * Shows tool name + short description inline.
 * Full params are always visible in the body.
 */
function chatAppendToolUse(toolName, toolId, params, target) {
  const container = target || document.getElementById("chat-messages");

  // Check if we can group with previous element
  if (chatIsGroupableTool(toolName)) {
    const lastEl = container.lastElementChild;
    if (lastEl && lastEl.dataset.toolName === toolName) {
      if (lastEl.classList.contains("chat-tool-group")) {
        const itemsDiv = lastEl.querySelector(".chat-tool-group-items");
        itemsDiv.appendChild(chatMakeSubItem(toolName, toolId, params, true, null, null));
        chatUpdateGroupSummary(lastEl);
        if (!target) chatScrollToBottom();
        return;
      }
      if (lastEl.classList.contains("chat-tool") && !lastEl.classList.contains("chat-tool-group")) {
        const group = chatCreateToolGroup(toolName, true);
        const itemsDiv = group.querySelector(".chat-tool-group-items");
        const existingRunning = lastEl.classList.contains("running");
        const existingStatus = existingRunning ? null : (lastEl.classList.contains("error") ? "error" : "success");
        itemsDiv.appendChild(chatMakeSubItem(
          lastEl.dataset.toolName, lastEl.dataset.toolId,
          lastEl._toolParams || {}, existingRunning, existingStatus,
          existingRunning ? null : (lastEl._toolOutput || "")
        ));
        itemsDiv.appendChild(chatMakeSubItem(toolName, toolId, params, true, null, null));
        chatUpdateGroupSummary(group);
        chatStopPillTimer(lastEl);
        container.replaceChild(group, lastEl);
        if (!target) chatScrollToBottom();
        return;
      }
    }
  }

  const readonly = isReadOnlyTool(toolName, params);
  const pill = document.createElement("details");
  pill.open = true; // Running tools always start open
  pill.className = "chat-tool running";
  pill.dataset.toolId = toolId;
  pill.dataset.toolName = toolName;
  pill.dataset.toolReadonly = readonly ? "true" : "false";
  pill._toolParams = params;
  pill.addEventListener("toggle", () => { if (pill.classList.contains("running") && !pill.open) pill.open = true; });

  if (!chatShouldShowTool(toolName, params)) {
    pill.style.display = "none";
  }

  const desc = chatToolDescription(toolName, params);
  const summary = document.createElement("summary");
  summary.className = "chat-tool-summary";
  summary.innerHTML =
    `<span class="chat-tool-spinner"></span>` +
    `<span class="chat-tool-name">${chatEscHtml(toolName)}</span>` +
    (desc ? `<span class="chat-tool-desc">${chatEscHtml(desc)}</span>` : "");
  pill.appendChild(summary);
  chatStartPillTimer(pill, summary);

  const paramsStr = typeof params === "object" ? JSON.stringify(params, null, 2) : String(params || "");
  if (paramsStr && paramsStr !== "{}") {
    const sec = document.createElement("div");
    sec.className = "chat-tool-section";
    sec.innerHTML = `<div class="chat-tool-section-label">Parameters</div>`;
    const pre = document.createElement("pre");
    pre.textContent = paramsStr;
    sec.appendChild(pre);
    pill.appendChild(sec);
  }

  container.appendChild(pill);
  if (!target) chatScrollToBottom();
}

/**
 * Update a tool pill with its result and mark it done.
 * Matches by tool_id. Output is always visible in the body.
 */
function chatUpdateToolResult(toolId, status, output, error) {
  const container = document.getElementById("chat-messages");

  // Check if tool is a sub-item in a group
  if (toolId) {
    const subItem = container.querySelector(`.chat-tool-group .chat-tool-sub[data-tool-id="${CSS.escape(toolId)}"]`);
    if (subItem) {
      chatUpdateSubItemResult(subItem, status, output, error);
      chatScrollToBottom();
      return;
    }
  }

  // Check approval prompt — tool result may arrive for a Gemini-approved tool
  if (toolId) {
    const approvalDiv = container.querySelector(`.chat-approval-prompt[data-tool-id="${CSS.escape(toolId)}"]`);
    if (approvalDiv) {
      const isError = status === "error" || !!error;
      const trimmed = (error || output || "").trim();
      const outputHtml = trimmed
        ? `<div class="chat-approval-output"><div class="chat-tool-section-label">${isError ? "Error" : "Output"}</div><pre>${chatEscHtml(trimmed.length > 5000 ? trimmed.slice(0, 5000) + "\n...(truncated)" : trimmed)}</pre></div>`
        : "";
      approvalDiv.insertAdjacentHTML("beforeend", outputHtml);
      chatScrollToBottom();
      return;
    }
  }

  // Find by tool_id first, fall back to last running pill
  let pill = toolId
    ? container.querySelector(`.chat-tool.running[data-tool-id="${CSS.escape(toolId)}"]`)
    : null;
  if (!pill) {
    const running = container.querySelectorAll(".chat-tool.running");
    pill = running.length ? running[running.length - 1] : null;
  }

  const isError = status === "error" || !!error;

  if (pill) {
    chatStopPillTimer(pill);
    pill.classList.remove("running");
    pill.classList.add(isError ? "error" : "success");
    pill._toolOutput = (error || output || "");
    pill._toolStatus = isError ? "error" : "success";

    // Collapse when done unless in expanded mode
    if (chatToolDisplayMode !== "expanded") {
      pill.open = false;
    }

    // Replace spinner with status icon
    const summaryEl = pill.querySelector(".chat-tool-summary");
    if (summaryEl) {
      const spinner = summaryEl.querySelector(".chat-tool-spinner");
      if (spinner) {
        const icon = document.createElement("span");
        icon.className = isError ? "chat-tool-icon error" : "chat-tool-icon success";
        icon.textContent = isError ? "\u2717" : "\u2713";
        spinner.replaceWith(icon);
      }
    }

    const toolName = pill.dataset.toolName || "";

    // For Edit tool: replace raw params with a color diff
    if (!isError && isEditLikeTool(toolName)) {
      chatRenderEditDiff(pill);
    }

    // Append output section (skip for Edit — the diff is the output)
    const trimmed = (error || output || "").trim();
    if (trimmed && !(!isError && isEditLikeTool(toolName))) {
      const section = document.createElement("div");
      section.className = "chat-tool-section";
      section.innerHTML = `<div class="chat-tool-section-label">${isError ? "Error" : "Output"}</div>`;
      const pre = document.createElement("pre");
      pre.textContent = trimmed.length > 5000 ? trimmed.slice(0, 5000) + "\n...(truncated)" : trimmed;
      section.appendChild(pre);
      pill.appendChild(section);
    }
  } else {
    // No matching pill — standalone fallback
    const pill2 = document.createElement("details");
    pill2.open = chatInitialPillOpen();
    pill2.className = `chat-tool ${isError ? "error" : "success"}`;
    pill2.addEventListener("toggle", () => {
      if (!pill2.open && chatToolDisplayMode === "expanded") pill2.open = true;
    });
    const summary = document.createElement("summary");
    summary.className = "chat-tool-summary";
    const icon = isError ? "\u2717" : "\u2713";
    summary.innerHTML =
      `<span class="chat-tool-icon ${isError ? "error" : "success"}">${icon}</span>` +
      `<span class="chat-tool-name">${chatEscHtml(toolId || "tool")}</span>` +
      `<span class="chat-tool-desc">(result)</span>`;
    pill2.appendChild(summary);
    const pre = document.createElement("pre");
    pre.textContent = error || output || "";
    pill2.appendChild(pre);
    container.appendChild(pill2);
  }

  chatScrollToBottom();
}

/**
 * Finalize any tool pills still in "running" state.
 * Called on "done" — tool_result events are emitted before "done", so any
 * pills still running at this point never received their result.
 */
function chatFinalizeOrphanedPills() {
  const container = document.getElementById("chat-messages");
  if (!container) return;
  const running = container.querySelectorAll(".chat-tool.running");
  if (!running.length) return;
  glog(`finalizeOrphanedPills: ${running.length} orphaned pill(s)`);
  for (const pill of running) {
    chatStopPillTimer(pill);
    pill.classList.remove("running");
    pill.classList.add("success");
    if (chatToolDisplayMode !== "expanded") pill.open = false;
    const spinner = pill.querySelector(".chat-tool-spinner");
    if (spinner) {
      const icon = document.createElement("span");
      icon.className = "chat-tool-icon success";
      icon.textContent = "\u2713";
      spinner.replaceWith(icon);
    }
  }
}

function chatEscHtml(str) {
  const el = document.createElement("span");
  el.textContent = str;
  return el.innerHTML;
}

function chatAppendError(message) {
  const container = document.getElementById("chat-messages");
  const div = document.createElement("div");
  div.className = "chat-msg error";
  div.textContent = message;
  container.appendChild(div);
  chatScrollToBottom();
}

/**
 * Render a color diff for an Edit tool pill.
 * Extracts old_string/new_string from the pill's stored params and replaces
 * the Parameters section with a unified diff view.
 */
function chatRenderEditDiff(pill) {
  // Parse params from the pre element in the Parameters section
  const paramSection = pill.querySelector(".chat-tool-section");
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
  label.className = "chat-tool-section-label";
  label.textContent = filePath || "Diff";
  paramSection.appendChild(label);

  const diffEl = document.createElement("pre");
  diffEl.className = "chat-diff";

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
 * Called from chatRenderCompletedTool when tool_name is Edit.
 */
function chatRenderEditDiffFromParams(pill, params) {
  const oldStr = params.old_string || "";
  const newStr = params.new_string || "";
  const filePath = params.file_path || "";

  const sec = document.createElement("div");
  sec.className = "chat-tool-section";
  const label = document.createElement("div");
  label.className = "chat-tool-section-label";
  label.textContent = filePath || "Diff";
  sec.appendChild(label);

  const diffEl = document.createElement("pre");
  diffEl.className = "chat-diff";
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
function chatAppendThinkingBlock(content) {
  const container = document.getElementById("chat-messages");
  // Append to existing thinking block if one is open (streaming)
  const existing = container.querySelector("details.chat-thinking-block:last-child");
  if (existing && existing.open) {
    const body = existing.querySelector(".chat-thinking-body");
    if (body) {
      body.textContent += content;
      chatScrollToBottom();
      return;
    }
  }
  const details = document.createElement("details");
  details.className = "chat-thinking-block";
  const summary = document.createElement("summary");
  summary.textContent = "Thinking\u2026";
  details.appendChild(summary);
  const body = document.createElement("div");
  body.className = "chat-thinking-body";
  body.textContent = content;
  details.appendChild(body);
  container.appendChild(details);
  chatScrollToBottom();
}

/** Show a thin system note (compaction, permission mode change, etc.). */
function chatAppendSystemNote(text) {
  const container = document.getElementById("chat-messages");
  const div = document.createElement("div");
  div.className = "chat-system-note";
  div.textContent = text;
  container.appendChild(div);
  chatScrollToBottom();
}

/** Render a compact info card for /about command results. */
function chatRenderAboutCard(data) {
  const container = document.getElementById("chat-messages");
  if (!container) return;

  const panel = document.createElement("div");
  panel.className = "chat-about-card";

  const rows = [
    { label: "Version",  value: data.version || "unknown" },
    { label: "Model",    value: data.activeModel && data.activeModel !== data.model
                           ? `${data.activeModel} (configured: ${data.model})`
                           : (data.model || "unknown") },
    { label: "Auth",     value: data.authType || "unknown" },
    { label: "Tier",     value: data.tierName || "unknown" },
    { label: "Sandbox",  value: data.sandbox || "none" },
    { label: "Platform", value: data.platform || "unknown" },
    { label: "Session",  value: data.sessionId ? data.sessionId.slice(-8) : "—" },
  ];

  for (const row of rows) {
    const el = document.createElement("div");
    el.className = "chat-about-row";
    el.innerHTML = `<span class="chat-about-label">${row.label}</span><span class="chat-about-value">${row.value}</span>`;
    panel.appendChild(el);
  }

  container.appendChild(panel);
}

/** Render a bug report card with system info and link to GitHub issues. */
function chatRenderBugCard() {
  const container = document.getElementById("chat-messages");
  if (!container) return;

  const ua = navigator.userAgent;
  const platform = navigator.platform || "unknown";
  const sysInfo = [
    `Platform: ${platform}`,
    `User-Agent: ${ua}`,
    `Workspace: ${chatWorkspace || "none"}`,
  ].join("\n");

  const issueBody = `## Bug Description\n\nDescribe the bug here.\n\n## Steps to Reproduce\n\n1. \n2. \n3. \n\n## Expected Behavior\n\n\n\n## System Info\n\n\`\`\`\n${sysInfo}\n\`\`\`\n`;
  const issueUrl = `https://github.com/google-gemini/gemini-cli/issues/new?title=&body=${encodeURIComponent(issueBody)}`;

  const panel = document.createElement("div");
  panel.className = "chat-bug-card";

  const title = document.createElement("div");
  title.className = "chat-bug-title";
  title.textContent = "Report a Bug";
  panel.appendChild(title);

  const info = document.createElement("pre");
  info.className = "chat-bug-info";
  info.textContent = sysInfo;
  panel.appendChild(info);

  const actions = document.createElement("div");
  actions.className = "chat-bug-actions";

  const link = document.createElement("a");
  link.href = issueUrl;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.className = "chat-bug-link";
  link.textContent = "Open issue on GitHub";
  actions.appendChild(link);

  const copyBtn = document.createElement("button");
  copyBtn.className = "chat-bug-copy";
  copyBtn.textContent = "Copy system info";
  copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(sysInfo).then(() => {
      copyBtn.textContent = "Copied!";
      setTimeout(() => { copyBtn.textContent = "Copy system info"; }, 2000);
    });
  });
  actions.appendChild(copyBtn);

  panel.appendChild(actions);
  container.appendChild(panel);
  chatScrollToBottom();
}

/** Render a privacy notice card with link to Google's privacy policy. */
function chatRenderPrivacyCard() {
  const container = document.getElementById("chat-messages");
  if (!container) return;

  const panel = document.createElement("div");
  panel.className = "chat-privacy-card";

  const title = document.createElement("div");
  title.className = "chat-privacy-title";
  title.textContent = "Privacy Notice";
  panel.appendChild(title);

  const body = document.createElement("div");
  body.className = "chat-privacy-body";
  body.innerHTML = [
    "Gemini CLI sends your prompts, code context, and file contents to Google servers for processing.",
    "",
    "Your data is used to provide responses and may be used to improve Google products and services, depending on your account settings and tier.",
    "",
    "For more details, review the linked privacy resources below.",
  ].join("<br>");
  panel.appendChild(body);

  const links = document.createElement("div");
  links.className = "chat-privacy-links";

  const policyLink = document.createElement("a");
  policyLink.href = "https://policies.google.com/privacy";
  policyLink.target = "_blank";
  policyLink.rel = "noopener noreferrer";
  policyLink.className = "chat-privacy-link";
  policyLink.textContent = "Google Privacy Policy";
  links.appendChild(policyLink);

  const tosLink = document.createElement("a");
  tosLink.href = "https://policies.google.com/terms";
  tosLink.target = "_blank";
  tosLink.rel = "noopener noreferrer";
  tosLink.className = "chat-privacy-link";
  tosLink.textContent = "Terms of Service";
  links.appendChild(tosLink);

  panel.appendChild(links);
  container.appendChild(panel);
  chatScrollToBottom();
}

/** Render a formatted stats panel for /stats command results. */
function chatRenderStatsPanel(data) {
  const container = document.getElementById("chat-messages");
  if (!container) return;

  const panel = document.createElement("div");
  panel.className = "chat-stats-panel";

  // --- Header pills ---
  const header = document.createElement("div");
  header.className = "chat-stats-header";
  const pills = [
    { label: "Model", value: data.activeModel || data.model || "unknown" },
    { label: "Session", value: data.sessionId ? data.sessionId.slice(-8) : "—" },
    { label: "Last prompt", value: data.lastPromptTokenCount != null ? data.lastPromptTokenCount.toLocaleString() + " tok" : "—" },
    { label: "Quota", value: data.quota && data.quota !== "unavailable" ? data.quota : null },
  ];
  for (const p of pills) {
    if (p.value == null) continue;
    const pill = document.createElement("span");
    pill.className = "chat-stats-pill";
    pill.innerHTML = `<span class="chat-stats-pill-label">${p.label}</span> ${chatEscHtml(String(p.value))}`;
    header.appendChild(pill);
  }
  panel.appendChild(header);

  // --- Token breakdown table ---
  const models = data.models;
  if (models && Object.keys(models).length > 0) {
    const section = document.createElement("div");
    section.className = "chat-stats-section";
    section.innerHTML = `<div class="chat-stats-section-title">Tokens</div>`;
    const table = document.createElement("table");
    table.className = "chat-stats-table";
    table.innerHTML = `<thead><tr><th>Model</th><th>Input</th><th>Cached</th><th>Output</th><th>Thoughts</th><th>Requests</th></tr></thead>`;
    const tbody = document.createElement("tbody");
    for (const [name, m] of Object.entries(models)) {
      const t = m.tokens || {};
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td class="chat-stats-model-name">${chatEscHtml(name)}</td>` +
        `<td>${(t.input || 0).toLocaleString()}</td>` +
        `<td>${(t.cached || 0).toLocaleString()}</td>` +
        `<td>${(t.candidates || 0).toLocaleString()}</td>` +
        `<td>${(t.thoughts || 0).toLocaleString()}</td>` +
        `<td>${(m.api?.totalRequests || 0).toLocaleString()}</td>`;
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    section.appendChild(table);
    panel.appendChild(section);
  }

  // --- Tool usage table ---
  const tools = data.tools;
  if (tools && tools.byName && Object.keys(tools.byName).length > 0) {
    const section = document.createElement("div");
    section.className = "chat-stats-section";
    section.innerHTML = `<div class="chat-stats-section-title">Tools <span class="chat-stats-dim">(${tools.totalCalls || 0} total calls)</span></div>`;
    const table = document.createElement("table");
    table.className = "chat-stats-table";
    table.innerHTML = `<thead><tr><th>Tool</th><th>Calls</th><th>OK</th><th>Fail</th><th>Avg ms</th></tr></thead>`;
    const tbody = document.createElement("tbody");
    const sorted = Object.entries(tools.byName).sort((a, b) => (b[1].count || 0) - (a[1].count || 0));
    for (const [name, t] of sorted) {
      const avg = t.count > 0 ? Math.round((t.durationMs || 0) / t.count) : 0;
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td class="chat-stats-model-name">${chatEscHtml(name)}</td>` +
        `<td>${(t.count || 0).toLocaleString()}</td>` +
        `<td>${(t.success || 0).toLocaleString()}</td>` +
        `<td>${t.fail ? `<span class="chat-stats-fail">${t.fail}</span>` : "0"}</td>` +
        `<td>${avg.toLocaleString()}</td>`;
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    section.appendChild(table);
    panel.appendChild(section);
  }

  // --- Files summary ---
  const files = data.files;
  if (files && (files.totalLinesAdded || files.totalLinesRemoved)) {
    const section = document.createElement("div");
    section.className = "chat-stats-section";
    section.innerHTML = `<div class="chat-stats-section-title">Files</div>`;
    const summary = document.createElement("div");
    summary.className = "chat-stats-files";
    summary.innerHTML =
      `<span class="chat-stats-added">+${(files.totalLinesAdded || 0).toLocaleString()}</span>` +
      ` / ` +
      `<span class="chat-stats-removed">-${(files.totalLinesRemoved || 0).toLocaleString()}</span>` +
      ` lines`;
    section.appendChild(summary);
    panel.appendChild(section);
  }

  container.appendChild(panel);
}

/** Show a background task card. */
function chatAppendTaskCard(taskId, description, status) {
  const container = document.getElementById("chat-messages");
  const div = document.createElement("div");
  div.className = "chat-task-card running";
  div.dataset.taskId = taskId;
  div.innerHTML =
    `<span class="chat-task-status">\u21BB Running</span>` +
    `<span class="chat-task-desc">${chatEscHtml(description)}</span>` +
    `<div class="chat-task-detail"></div>`;
  container.appendChild(div);
  chatScrollToBottom();
}

/** Show cost/token/duration footer after a turn completes. */
function chatShowResultFooter(stats, subtype, errors) {
  if (!stats && !subtype) return;
  const container = document.getElementById("chat-messages");

  // Show error banner for non-success results
  if (subtype && subtype !== "success") {
    const errorDiv = document.createElement("div");
    errorDiv.className = "chat-result-error";
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
      errorDiv.className = "chat-result-error interrupted";
    } else {
      errorDiv.textContent = "Turn ended: " + subtype;
    }
    container.appendChild(errorDiv);
  }

  // Show token/duration footer after a turn completes (no cost)
  if (stats && (stats.total_tokens || stats.duration_ms)) {
    const parts = [];
    if (stats.total_tokens) parts.push(stats.total_tokens >= 1000 ? (stats.total_tokens / 1000).toFixed(1) + "k tokens" : stats.total_tokens + " tokens");
    if (stats.duration_ms) parts.push((stats.duration_ms / 1000).toFixed(1) + "s");
    if (parts.length) {
      const footer = document.createElement("div");
      footer.className = "chat-result-footer";
      footer.textContent = parts.join(" \u00B7 ");
      container.appendChild(footer);
    }
  }
}

/** Update the context remaining % in the input footer (debug mode only). */
function chatUpdateCumulativeStats(cumulative) {
  const el = document.getElementById("chat-cumulative-stats");
  if (!el) return;
  if (!chatIsDebugMode()) { el.textContent = ""; return; }
  if (cumulative.context_remaining_pct != null && cumulative.last_input_tokens > 0) {
    el.textContent = cumulative.context_remaining_pct + "% context remaining";
  } else {
    el.textContent = "";
  }
}

function chatScrollToBottom() {
  const container = document.getElementById("chat-messages");
  if (container) {
    container.scrollTop = container.scrollHeight;
  }
}

function chatRenderMarkdown(text) {
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
let chatAuthPollTimer = null;

function chatShowAuthPanel() {
  const container = document.getElementById("chat-messages");
  container.innerHTML = "";

  // Hide workspace-scoped option when opened without a workspace (e.g. from auth dot)
  const showWorkspaceScope = !!chatWorkspace;
  const isClaude = chatActiveCli === "claude";

  const panel = document.createElement("div");
  panel.className = "chat-auth-panel";

  if (isClaude) {
    panel.innerHTML = `
      <h3>Claude Authentication Required</h3>
      <p>Choose how to authenticate with Claude CLI:</p>
      <div class="chat-auth-options">
        <div class="chat-auth-option">
          <h4>Login via CLI</h4>
          <p>Run <code>claude auth login</code> in your terminal to authenticate.</p>
        </div>
        <div class="chat-auth-option">
          <h4>Use API Key</h4>
          <p>Enter an <code>ANTHROPIC_API_KEY</code> from <a href="https://console.anthropic.com/settings/keys" target="_blank">Anthropic Console</a>.</p>
          <div class="chat-auth-key-form">
            <input type="password" id="chat-apikey-input" placeholder="Paste API key..." />
            ${showWorkspaceScope ? `
            <div class="chat-auth-key-scope">
              <label><input type="radio" name="chat-key-scope" value="global" checked /> Global (all workspaces)</label>
              <label><input type="radio" name="chat-key-scope" value="workspace" /> This workspace only</label>
            </div>
            ` : ""}
            <button class="btn primary" onclick="chatSaveApiKey()">Save Key</button>
          </div>
        </div>
      </div>
    `;
  } else {
    panel.innerHTML = `
      <h3>Gemini Authentication Required</h3>
      <p>Choose how to authenticate with Gemini CLI:</p>
      <div class="chat-auth-options">
        <div class="chat-auth-option" id="chat-oauth-section">
          <h4>Login with Google</h4>
          <p id="chat-oauth-desc">Sign in with your Google account to use Gemini.</p>
          <a href="#" id="chat-oauth-link" class="btn primary chat-oauth-link-btn" target="_blank" onclick="chatOAuthLinkClicked(event)">
            <span id="chat-oauth-link-text">Loading&hellip;</span>
          </a>
          <div id="chat-oauth-code-section" class="chat-auth-code-section hidden">
            <p class="chat-auth-code-hint">After signing in, Google will show you an authorization code. Paste it here:</p>
            <div class="chat-auth-key-form">
              <input type="text" id="chat-oauth-code-input" class="chat-oauth-code-input" placeholder="Paste authorization code…" autocomplete="off" onkeydown="if(event.key==='Enter') chatSubmitAuthCode()" />
              <button id="chat-oauth-code-btn" class="btn primary" onclick="chatSubmitAuthCode()">Submit</button>
              <button class="btn" onclick="chatCancelOAuth()">Cancel</button>
            </div>
          </div>
          <div id="chat-oauth-status" class="chat-auth-status hidden"></div>
        </div>
        <div class="chat-auth-option" id="chat-apikey-section">
          <h4>Use API Key</h4>
          <p>Enter a <code>GEMINI_API_KEY</code> from <a href="https://aistudio.google.com/apikey" target="_blank">Google AI Studio</a>.</p>
          <div class="chat-auth-key-form">
            <input type="password" id="chat-apikey-input" placeholder="Paste API key..." />
            ${showWorkspaceScope ? `
            <div class="chat-auth-key-scope">
              <label><input type="radio" name="chat-key-scope" value="global" checked /> Global (all workspaces)</label>
              <label><input type="radio" name="chat-key-scope" value="workspace" /> This workspace only</label>
            </div>
            ` : ""}
            <button class="btn primary" onclick="chatSaveApiKey()">Save Key</button>
          </div>
        </div>
      </div>
    `;
    // Pre-fetch the OAuth URL in the background so the link is ready to click
    chatStartOAuthLogin();
  }
  container.appendChild(panel);
}

// Pre-fetches the OAuth URL so the link is ready. Called when the auth panel renders.
async function chatStartOAuthLogin() {
  const link = document.getElementById("chat-oauth-link");
  const linkText = document.getElementById("chat-oauth-link-text");
  const status = document.getElementById("chat-oauth-status");

  try {
    const res = await fetch("/api/gemini/auth/login", { method: "POST" });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || "Failed to start login");

    if (data.alreadyAuthenticated) {
      if (chatWorkspace) {
        chatShowChat();
      } else {
        closeGeminiChat();
        if (typeof refresh === "function") refresh();
      }
      return;
    }

    // URL ready — show the link and the code entry form
    if (link) {
      link.href = data.url;
      link.dataset.ready = "true";
    }
    if (linkText) linkText.textContent = "Open Google Sign-In";

    // Reveal the code entry form
    const codeSection = document.getElementById("chat-oauth-code-section");
    if (codeSection) codeSection.classList.remove("hidden");

  } catch (err) {
    if (linkText) linkText.textContent = "Open Google Sign-In";
    if (status) {
      status.classList.remove("hidden");
      status.innerHTML = `Could not prepare login. Try running <code>gemini</code> in your terminal.`;
    }
  }
}

// Called when the "Open Google Sign-In" link is clicked — nothing extra needed,
// the code form is already visible; link opens naturally in new tab
function chatOAuthLinkClicked(event) {
  const link = document.getElementById("chat-oauth-link");
  if (!link || !link.dataset.ready) {
    event.preventDefault();
    const status = document.getElementById("chat-oauth-status");
    if (status) {
      status.classList.remove("hidden");
      status.textContent = "Still loading, please wait a moment…";
    }
  }
}

async function chatSubmitAuthCode() {
  const input = document.getElementById("chat-oauth-code-input");
  const btn = document.getElementById("chat-oauth-code-btn");
  const status = document.getElementById("chat-oauth-status");
  const code = input ? input.value.trim() : "";
  if (!code) return;

  if (btn) btn.disabled = true;
  if (btn) btn.textContent = "Verifying…";

  try {
    const res = await fetch("/api/gemini/auth/code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) throw new Error((await res.json()).error || "Failed");

    // Poll for auth completion
    if (status) {
      status.classList.remove("hidden");
      status.innerHTML = '<span class="chat-auth-spinner"></span> Verifying with Google…';
    }
    chatPollAuthCompletion();
  } catch (err) {
    if (status) {
      status.classList.remove("hidden");
      status.textContent = `Error: ${err.message}`;
    }
    if (btn) { btn.disabled = false; btn.textContent = "Submit"; }
  }
}

// Reset the auth panel to its initial state
function chatCancelOAuth() {
  if (chatAuthPollTimer) { clearInterval(chatAuthPollTimer); chatAuthPollTimer = null; }

  const link = document.getElementById("chat-oauth-link");
  const apikeySection = document.getElementById("chat-apikey-section");
  const codeSection = document.getElementById("chat-oauth-code-section");
  const status = document.getElementById("chat-oauth-status");

  if (link) { link.classList.remove("hidden"); link.dataset.ready = ""; }
  if (apikeySection) apikeySection.classList.remove("hidden");
  if (codeSection) codeSection.classList.add("hidden");
  if (status) { status.classList.add("hidden"); status.innerHTML = ""; }

  // Restart the login flow
  const linkText = document.getElementById("chat-oauth-link-text");
  if (linkText) linkText.textContent = "Loading\u2026";
  chatStartOAuthLogin();
}

function chatPollAuthCompletion() {
  // Clear any existing poll
  if (chatAuthPollTimer) clearInterval(chatAuthPollTimer);

  let elapsed = 0;
  const interval = 2000;
  const timeout = 5 * 60 * 1000; // 5 min

  chatAuthPollTimer = setInterval(async () => {
    elapsed += interval;

    if (elapsed >= timeout) {
      clearInterval(chatAuthPollTimer);
      chatAuthPollTimer = null;
      const status = document.getElementById("chat-oauth-status");
      const btn = document.getElementById("chat-oauth-btn");
      if (status) status.innerHTML = `Timed out. Try again, or run <code>gemini</code> in your terminal to authenticate manually.`;
      if (btn) btn.disabled = false;
      return;
    }

    try {
      const res = await fetch("/api/gemini/auth/recheck", { method: "POST" });
      const data = await res.json();

      if (data.loggedIn) {
        clearInterval(chatAuthPollTimer);
        chatAuthPollTimer = null;

        if (chatWorkspace) {
          chatShowChat();
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

async function chatSaveApiKey() {
  const input = document.getElementById("chat-apikey-input");
  const key = input ? input.value.trim() : "";
  if (!key) return;

  const scope = document.querySelector('input[name="chat-key-scope"]:checked');
  const isWorkspace = scope && scope.value === "workspace";

  try {
    const body = { apiKey: key };
    if (isWorkspace) body.workspace = chatWorkspace;

    const keyEndpoint = chatActiveCli === "claude" ? "/api/claude-chat/apikey" : "/api/gemini/apikey";
    const res = await fetch(keyEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to save key");

    // Key saved — refresh models (new key may unlock different models) and switch to chat
    chatRefreshModels();
    chatShowChat();
  } catch (err) {
    chatAppendError("Failed to save API key: " + err.message);
  }
}

// Stop any in-progress stream-poll and remove the waiting indicator.
function chatStopStreamPoll() {
  if (chatStreamPollTimer) {
    clearInterval(chatStreamPollTimer);
    chatStreamPollTimer = null;
  }
  chatRemoveThinking();
}

// Show "Waiting for response…" dots and poll history every 2 s until the
// in-flight assistant reply arrives (or the server says streaming is done).
/**
 * After a server restart/crash, check if new history entries appeared while
 * we were disconnected (written by recoverStreams) and render them.
 */
async function chatRenderRecoveredContent() {
  const ws = chatWorkspace;
  const sn = chatSessionNum;
  const knownLen = (chatHistory[ws] || []).length;
  // Always remove the "Connection lost" banner — we're reconnected regardless of content
  const container = document.getElementById("chat-messages");
  const lastEl = container?.lastElementChild;
  if (lastEl?.classList.contains("chat-error")) lastEl.remove();
  // Give the server a moment to finish recovery before fetching
  await new Promise(r => setTimeout(r, 600));
  try {
    const historyResult = await chatFetchHistory(ws, sn);
    const history = historyResult.messages || [];
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
            chatRenderCompletedQuestion(tu ? tu.parameters : {}, d.output || "", d.status);
          } else {
            chatRenderCompletedTool(tName, d.tool_id, tu ? tu.parameters : {}, d.status, d.output);
          }
        } catch {}
      } else {
        chatAppendMessage(msg.role, msg.content, false, null, msg.ts, msg.sender, msg.role === "user" ? "processing" : undefined);
      }
    }
    for (const tu of pendingToolUses.values()) chatAppendToolUse(tu.tool_name, tu.tool_id, tu.parameters);
    chatHistory[ws] = history;
    chatScrollToBottom();
  } catch (e) {
    glog("recovery-check: error", e.message);
  }
}

function chatStartStreamPoll(historyLengthAtOpen) {
  chatStopStreamPoll();
  chatShowThinking();

  const ws = chatWorkspace;
  const sn = chatSessionNum;

  // Immediately show partial content so the user sees what was generated before they left
  fetch(`/api/gemini/stream-partial/${encodeURIComponent(ws)}${sn ? `?session=${sn}` : ""}`)
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (!data || !data.text || chatWorkspace !== ws) return;
      chatRemoveThinking();
      chatPartialMsgEl = chatAppendMessage("assistant", data.text, true, null, null);
      chatShowThinking();
    })
    .catch(() => {});

  chatStreamPollTimer = setInterval(async () => {
    try {
      // Fetch history and latest partial content in parallel
      const [historyResult, partialData] = await Promise.all([
        chatFetchHistory(ws, sn),
        fetch(`/api/gemini/stream-partial/${encodeURIComponent(ws)}${sn ? `?session=${sn}` : ""}`).then(r => r.ok ? r.json() : null).catch(() => null),
      ]);
      const history = historyResult.messages || [];

      // Keep partial bubble in sync with what's been generated so far
      if (partialData && partialData.text) {
        if (chatPartialMsgEl) {
          const mdEl = chatPartialMsgEl.querySelector(".md-content");
          if (mdEl) {
            mdEl.innerHTML = chatRenderMarkdown(partialData.text);
            chatScrollToBottom();
          }
        } else if (chatWorkspace === ws) {
          chatRemoveThinking();
          chatPartialMsgEl = chatAppendMessage("assistant", partialData.text, true, null, null);
          chatShowThinking();
        }
      }

      if (history.length > historyLengthAtOpen) {
        chatStopStreamPoll();
        // Remove the partial bubble — render fresh from server history
        if (chatPartialMsgEl) { chatPartialMsgEl.remove(); chatPartialMsgEl = null; }
        const newMsgs = history.slice(historyLengthAtOpen);
        const container = document.getElementById("chat-messages");
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
                chatRenderCompletedQuestion(tu ? tu.parameters : {}, d.output || "", d.status);
              } else {
                chatRenderCompletedTool(tName, d.tool_id, tu ? tu.parameters : {}, d.status, d.output);
              }
            } catch { /* ignore */ }
          } else {
            chatAppendMessage(msg.role, msg.content, false, null, msg.ts, msg.sender);
          }
        }
        for (const tu of pendingToolUses.values()) {
          chatAppendToolUse(tu.tool_name, tu.tool_id, tu.parameters);
        }
        chatSetStreaming(false);
        container.scrollTop = container.scrollHeight;
        return;
      }
      // Also bail if the server says streaming stopped (e.g. error or done)
      const wsRes = await fetch(`/api/workspace-state/${encodeURIComponent(ws)}`);
      const wsState = await wsRes.json();
      if (!wsState.streaming) {
        chatStopStreamPoll();
        // Leave partial content visible if no new history — something ended without persisting
        if (chatPartialMsgEl) {
          chatPartialMsgEl.classList.remove("chat-streaming");
          chatPartialMsgEl = null;
        }
        chatSetStreaming(false);
      }
    } catch { /* ignore transient poll errors */ }
  }, 2000);
}

async function chatShowChat(wsState = null) {
  glog("showChat: workspace=" + chatWorkspace + " session#" + chatSessionNum);
  const workspaceAtCall = chatWorkspace;
  const container = document.getElementById("chat-messages");
  container.innerHTML = "";
  // Checkmarks are now inline on user bubbles — no global reset needed

  // Fetch history, sessions, and stats in parallel — all must complete before reveal
  if (chatWorkspace) {
    const sessionNumAtCall = chatSessionNum;
    chatFetchCumulativeStats(chatWorkspace); // stats are cosmetic, don't block
    const [historyResult] = await Promise.all([
      chatFetchHistory(chatWorkspace, sessionNumAtCall, CHAT_INITIAL_LOAD),
      chatFetchSessions(chatWorkspace),
    ]);
    // Bail out if workspace changed during async fetch (user switched workspaces)
    if (chatWorkspace !== workspaceAtCall) {
      glog("showChat: workspace changed during fetch, aborting stale render");
      return;
    }
    const history = historyResult.messages || [];
    glog(`showChat: loaded ${history.length}/${historyResult.total} messages`);

    // Batch-render into DocumentFragment — defer markdown parsing to idle time
    const frag = chatRenderHistoryBatch(history, wsState, true);
    container.appendChild(frag);
    chatApplyToolDisplayMode();
    chatScrollToBottom();

    // Set up scroll-up loading for older messages
    if (!chatHistoryFullyLoaded) {
      chatSetupScrollObserver();
      // Background-fill next page after a short delay
      const bgWorkspace = chatWorkspace;
      const bgSession = sessionNumAtCall;
      setTimeout(async () => {
        if (chatWorkspace !== bgWorkspace) return;
        const { messages: more } = await chatFetchHistory(bgWorkspace, bgSession, CHAT_PAGE_SIZE, chatLoadedHistoryCount);
        if (chatWorkspace !== bgWorkspace || more.length === 0) return;
        const scrollBottom = container.scrollHeight - container.scrollTop;
        const sentinel = container.querySelector(".chat-scroll-sentinel");
        const moreFrag = chatRenderHistoryBatch(more, null, true);
        if (sentinel) { sentinel.after(moreFrag); } else { container.prepend(moreFrag); }
        chatLoadedHistoryCount += more.length;
        chatHistoryFullyLoaded = chatLoadedHistoryCount >= chatTotalHistoryCount;
        chatHistory[bgWorkspace] = [...more, ...(chatHistory[bgWorkspace] || [])];
        container.scrollTop = container.scrollHeight - scrollBottom;
        chatApplyToolDisplayMode();
      }, 50);
    }

    // If the server has a pending permission_request (e.g. from relay replay after
    // restart), show it now so Claude isn't blocked indefinitely.
    if (wsState && wsState.pendingPermission) {
      const pp = wsState.pendingPermission;
      glog("showChat: restoring pending permission_request", pp.tool_name, pp.request_id);
      handleGeminiEvent({ ...pp, workspace: chatWorkspace });
    }

    // If a stream was in-flight when we opened, poll until the reply lands.
    // Leave streaming=true so the input stays disabled while we wait.
    if (chatOpenedWhileStreaming) {
      chatOpenedWhileStreaming = false;
      const lastMsg = history[history.length - 1];
      if (lastMsg && lastMsg.role === "user") {
        chatSetStreaming(true);
        chatStartStreamPoll(history.length);
        // Skip the chatSetStreaming(false) below — poll completion handles it
        const input = document.getElementById("chat-input");
        if (input) await chatRestoreDraft(wsState);
        chatDismissSwitchOverlay();
        return;
      }
    }
  }

  // Enable input and restore draft (pass pre-fetched state to avoid a duplicate round-trip)
  chatSetStreaming(false);
  const input = document.getElementById("chat-input");
  if (input) {
    await chatRestoreDraft(wsState);
    input.focus();
  }

  // All UI elements are ready — reveal
  chatDismissSwitchOverlay();
}

// --- Overlay controls ---

async function openChat(project, projectPath, cli, sessionNum) {
  chatActiveCli = cli || "gemini";
  glog(`openChat: project=${project} path=${projectPath} cli=${chatActiveCli}`);

  // Flush draft for the previous workspace before switching (handles direct
  // workspace-to-workspace clicks that skip closeGeminiChat).
  const prevWorkspace = chatWorkspace;
  if (prevWorkspace && prevWorkspace !== project) {
    // Cancel any pending debounced draft save for the old workspace
    clearTimeout(chatDraftTimer);
    const input = document.getElementById("chat-input");
    if (input && input.value) {
      // Save immediately via HTTP (bypass debounce) so the draft isn't lost
      const draftMode = chatActiveCli === "claude" ? "claude-local" : "gemini";
      fetch(`/api/workspace-state/${encodeURIComponent(prevWorkspace)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draft: input.value, draftMode, draftSession: chatSessionNum }),
      }).catch(() => {});
    }
    // Clear input immediately so the old draft doesn't flash in the new workspace
    if (input) input.value = "";
  }

  chatWorkspace = project || null;
  chatWorkspacePath = projectPath || null;

  // Clear typing guard so draft restoration isn't blocked
  chatLocalDraftActive = false;
  clearTimeout(chatLocalDraftTimeout);

  chatAgentRole = null;

  const cliLabel = chatActiveCli === "claude" ? "Claude" : "Gemini";

  // Set title
  if (project) {
    const parts = project.split("--");
    const repo = parts[0];
    const branch = parts.length > 1 ? parts.slice(1).join("--") : null;
    document.getElementById("chat-title").innerHTML =
      `<span>${cliLabel}</span> <span style="font-weight:400;color:var(--text-faint)">${esc(repo)}${branch ? " / " + esc(branch) : ""}</span>`;
  } else {
    document.getElementById("chat-title").innerHTML = `<span>${cliLabel}</span>`;
  }

  // Update placeholder
  const inputEl = document.getElementById("chat-input");
  if (inputEl) inputEl.placeholder = `Message ${cliLabel}...`;

  // Show loading overlay immediately so the transition is clean
  chatShowSwitchOverlay();

  // Reset streaming state and image attachments
  chatCurrentMsgEl = null;
  chatCurrentMsgText = "";
  chatPartialMsgEl = null;
  chatSetStreaming(false);
  chatClearImages();
  chatUpdateAttachVisibility();
  chatUpdatePermissionVisibility();
  chatRestorePermissionMode();
  chatRestoreThinking();
  chatRestoreToolDisplayMode();
  chatApplyDebugMode();

  // Restore session state — fetch workspace-state and sessions list in parallel
  chatSessionNum = sessionNum || null; // explicit param takes priority
  let wsState = null;
  if (project) {
    const base = chatActiveCli === "claude" ? "/api/claude-chat" : "/api/gemini";
    const [wsData, sessData] = await Promise.all([
      fetch(`/api/workspace-state/${encodeURIComponent(project)}`).then(r => r.json()).catch(() => null),
      fetch(`${base}/sessions/${encodeURIComponent(project)}`).then(r => r.json()).catch(() => null),
    ]);
    if (wsData) {
      wsState = wsData;
      if (chatSessionNum == null && wsData.sessionNum != null) {
        chatSessionNum = wsData.sessionNum;
        glog(`openChat: restoring session#${chatSessionNum} from server state`);
      }
      chatOpenedWhileStreaming = wsData.streaming || false;
      const stateMode = chatActiveCli === "claude" ? "claude-local" : "gemini";
      fetch(`/api/workspace-state/${encodeURIComponent(project)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: stateMode }),
      }).catch(() => {});
    }
    if (chatSessionNum == null && sessData) {
      const sessions = sessData.sessions || [];
      if (sessions.length) {
        chatSessionNum = sessions[0].num;
        glog(`openChat: picked MRU session#${chatSessionNum}`);
      }
    }
    // Set session label immediately so it doesn't flash the old value
    const label = document.getElementById("chat-session-label");
    if (label && chatSessionNum != null) label.textContent = `Chat ${chatSessionNum}`;
  }

  // Force model list refresh for the new CLI backend
  chatModelsFetched = false;

  // Show panel
  document.getElementById("chat-overlay").classList.remove("hidden");

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
  chatFetchModels();
  if (chatActiveCli === "gemini") chatFetchQuota();
  else document.getElementById("chat-quota").textContent = "";

  // Apply global default settings (non-blocking)
  chatApplyDefaults();

  // Connect WS if needed (only if we have a workspace for chat)
  if (project) chatConnect();

  // No workspace — opened from auth dot, always show auth panel
  if (!project) {
    chatShowAuthPanel();
    chatDismissSwitchOverlay();
    return;
  }

  // For workspaces, show chat immediately — if auth is bad the CLI will report it
  chatShowChat(wsState);
}

function closeGeminiChat() {
  glog("closeChat");

  // Clear agent chat state
  chatAgentRole = null;
  delete window._agentRole;
  delete window._agentSystemPrompt;

  // Flush current input draft immediately so it persists across close/reopen
  const input = document.getElementById("chat-input");
  if (input) chatSaveDraft(input.value);

  chatStopStreamPoll();
  document.getElementById("chat-overlay").classList.add("hidden");
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
  glog("clearSession (new chat): workspace=" + chatWorkspace + " cli=" + chatActiveCli);
  if (!chatWorkspace) return;

  // Stop any active process
  if (chatWs && chatWs.readyState === WebSocket.OPEN) {
    chatWsSend({ type: "stop", workspace: chatWorkspace, cli: chatActiveCli, sessionNum: chatSessionNum });
  }

  // Create a new session on the server (preserves old sessions)
  const clearBase = chatActiveCli === "claude" ? "/api/claude-chat" : "/api/gemini";
  try {
    const res = await fetch(`${clearBase}/clear/${encodeURIComponent(chatWorkspace)}`, { method: "POST" });
    const data = await res.json();
    chatSessionNum = data.session;
    glog("clearSession: new session#" + chatSessionNum);
  } catch {
    glog("clearSession: server call failed");
  }

  // Clear local cache
  delete chatHistory[chatWorkspace];

  // Clear UI
  document.getElementById("chat-messages").innerHTML = "";
  chatCurrentMsgEl = null;
  chatCurrentMsgText = "";
  chatSetStreaming(false);

  // Update URL with new session number
  const cur = getChatParams();
  setChatParams({ ...cur, chat: chatSessionNum || undefined });

  // Refresh session selector
  await chatFetchSessions(chatWorkspace);

  const input = document.getElementById("chat-input");
  if (input) input.focus();
}

// --- Slash command menu ---

const SLASH_COMMANDS = [
  { name: "about",      description: "Version and session info" },
  { name: "bug",        description: "Report a bug" },
  { name: "clear",      description: "Clear chat messages" },
  { name: "compress",   description: "Compress chat context" },
  { name: "copy",       description: "Copy last response to clipboard" },
  { name: "corgi",      description: "Toggles corgi mode", hidden: true },
  { name: "docs",       description: "Open Gemini CLI documentation" },
  { name: "extensions", description: "List installed extensions" },
  { name: "init",       description: "Generate GEMINI.md from project" },
  { name: "memory",     description: "Show GEMINI.md memory" },
  { name: "model",      description: "Show current model info" },
  { name: "privacy",    description: "Display privacy notice" },
  { name: "restore",    description: "Restore files to checkpoint" },
  { name: "settings",   description: "Show current settings" },
  { name: "stats",      description: "Session statistics" },
  { name: "tools",      description: "List available tools" },
];

let chatSlashMenuOpen = false;
let chatSlashMenuIndex = 0;

let chatSlashFiltered = SLASH_COMMANDS; // currently visible commands

function chatOpenSlashMenu(filter = "") {
  const menu = document.getElementById("chat-slash-menu");
  if (!menu) return;
  const query = filter.toLowerCase();
  const visible = SLASH_COMMANDS.filter(c => !c.hidden);
  const matches = query
    ? visible.filter(c => c.name.startsWith(query))
    : visible;
  if (matches.length === 0) {
    // Check if a hidden command matches before reverting
    const hiddenMatch = query && SLASH_COMMANDS.some(c => c.hidden && c.name.startsWith(query));
    if (hiddenMatch) {
      // Let the typing continue but close the visible menu
      chatCloseSlashMenu();
      return;
    }
    // No matches at all — silently revert the last char
    const input = document.getElementById("chat-input");
    if (input) input.value = input.value.slice(0, -1);
    return;
  }
  chatSlashFiltered = matches;
  menu.innerHTML = "";
  chatSlashFiltered.forEach((cmd, i) => {
    const item = document.createElement("div");
    item.className = "chat-slash-item" + (i === 0 ? " selected" : "");
    item.dataset.index = i;
    // Highlight matched prefix
    const matchLen = query.length;
    const nameHtml = matchLen
      ? `<b>${cmd.name.slice(0, matchLen)}</b>${cmd.name.slice(matchLen)}`
      : cmd.name;
    item.innerHTML = `<span class="chat-slash-name">${nameHtml}</span><span class="chat-slash-desc">${cmd.description}</span>`;
    item.addEventListener("click", () => chatSelectSlashCommand(cmd));
    item.addEventListener("mouseenter", () => chatSlashHighlight(i));
    menu.appendChild(item);
  });
  chatSlashMenuOpen = true;
  chatSlashMenuIndex = 0;
  menu.classList.remove("hidden");
}

function chatCloseSlashMenu() {
  const menu = document.getElementById("chat-slash-menu");
  if (menu) menu.classList.add("hidden");
  chatSlashMenuOpen = false;
  chatSlashMenuIndex = 0;
}

function chatSlashHighlight(index) {
  chatSlashMenuIndex = index;
  const menu = document.getElementById("chat-slash-menu");
  if (!menu) return;
  menu.querySelectorAll(".chat-slash-item").forEach((el, i) => {
    el.classList.toggle("selected", i === index);
  });
}

function chatSelectSlashCommand(cmd) {
  chatCloseSlashMenu();
  const input = document.getElementById("chat-input");
  if (input) { input.value = ""; input.style.height = "auto"; }

  // Bug report — frontend-only, opens GitHub issues with pre-filled system info
  if (cmd.name === "bug") {
    chatAppendSystemNote("/bug");
    chatRenderBugCard();
    return;
  }

  // Corgi mode — toggle via server (syncs across clients)
  if (cmd.name === "corgi") {
    if (chatWs && chatWs.readyState === WebSocket.OPEN) {
      chatWsSend({ type: "corgi" });
    }
    return;
  }

  // Docs — frontend-only, opens Gemini CLI documentation in a new tab
  if (cmd.name === "docs") {
    window.open("https://geminicli.com/docs", "_blank", "noopener");
    chatAppendSystemNote("Opened Gemini CLI documentation");
    return;
  }

  // Clear chat — frontend-only, removes all messages and shows confirmation
  if (cmd.name === "clear") {
    const container = document.getElementById("chat-messages");
    if (container) container.innerHTML = "";
    chatAppendSystemNote("Conversation cleared");
    return;
  }

  // Copy — frontend-only, copies last assistant message to clipboard
  if (cmd.name === "copy") {
    const msgs = document.querySelectorAll("#chat-messages .chat-msg.assistant");
    if (msgs.length === 0) {
      chatAppendSystemNote("Nothing to copy");
      return;
    }
    const last = msgs[msgs.length - 1];
    const text = last.innerText || last.textContent;
    navigator.clipboard.writeText(text.trim()).then(() => {
      chatShowToast("Copied to clipboard");
    }).catch(() => {
      chatAppendError("Failed to copy — clipboard access denied");
    });
    return;
  }

  // Privacy notice — frontend-only, displays privacy info with link to Google's privacy policy
  if (cmd.name === "privacy") {
    chatAppendSystemNote("/privacy");
    chatRenderPrivacyCard();
    return;
  }

  // Render command as a system note
  chatAppendSystemNote(`/${cmd.name}`);

  // Execute via WS
  if (chatWs && chatWs.readyState === WebSocket.OPEN) {
    chatWsSend({
      type: "command",
      workspace: chatWorkspace,
      sessionNum: chatSessionNum,
      command: cmd.name,
      args: [],
    });
  } else {
    chatAppendError("Not connected to server");
  }
}

// --- Input handling ---

function chatInputKeydown(event) {
  // Slash menu keyboard handling
  if (chatSlashMenuOpen) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      chatSlashHighlight((chatSlashMenuIndex + 1) % chatSlashFiltered.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      chatSlashHighlight((chatSlashMenuIndex - 1 + chatSlashFiltered.length) % chatSlashFiltered.length);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      if (chatSlashFiltered.length > 0) {
        chatSelectSlashCommand(chatSlashFiltered[chatSlashMenuIndex]);
      }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (chatSlashFiltered.length > 0) {
        chatSelectSlashCommand(chatSlashFiltered[chatSlashMenuIndex]);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      const input = document.getElementById("chat-input");
      if (input) { input.value = ""; input.style.height = "auto"; }
      chatCloseSlashMenu();
      return;
    }
    // Let all other keys through — input event will filter the menu
  }

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
  if (!chatServerConnected) {
    glog("send: blocked (server disconnected)");
    return;
  }

  const input = document.getElementById("chat-input");
  const message = input.value.trim();
  if (!message) {
    glog("send: blocked (empty message)");
    return;
  }

  // Hidden slash commands (work in any mode)
  if (message.startsWith("/")) {
    const cmdName = message.slice(1).toLowerCase();
    const hidden = SLASH_COMMANDS.find(c => c.hidden && c.name === cmdName);
    if (hidden) {
      input.value = "";
      input.style.height = "auto";
      chatSelectSlashCommand(hidden);
      return;
    }
  }

  // Discard any in-progress reload-poll — user is sending a new message
  chatStopStreamPoll();

  glog(`send: workspace=${chatWorkspace} msgLen=${message.length} wsState=${chatWs ? chatWs.readyState : "null"}`);

  // Add to local cache (server persists when WS receives the message)
  if (!chatHistory[chatWorkspace]) chatHistory[chatWorkspace] = [];
  chatHistory[chatWorkspace].push({ role: "user", content: message });

  // Render user bubble (with any pending images above the text)
  chatAppendMessage("user", message, false, chatPendingImages.slice(), Date.now());

  // Clear input and draft
  input.value = "";
  input.style.height = "auto";
  chatSaveDraft("");

  // Start streaming — show thinking indicator until first content arrives (skip if already streaming)
  if (!chatStreaming) {
    chatSetStreaming(true);
    chatShowThinking();
    window._chatSendTime = Date.now();
  }
  glog("send: thinking indicator shown, waiting for events...");

  // Send over WebSocket (include model if not Auto)
  const modelSelect = document.getElementById("chat-model");
  const model = modelSelect ? modelSelect.value : "";

  if (chatWs && chatWs.readyState === WebSocket.OPEN) {
    const images = chatPendingImages.map((i) => i.dataUrl);
    const payload = {
      type: "send",
      workspace: chatWorkspace,
      message,
      model: model || undefined,
      cli: chatActiveCli,
      sessionNum: chatSessionNum || undefined,
      permissionMode: chatGetPermissionMode(),
      ...(chatThinkingEnabled && chatActiveCli === "claude" ? { thinking: true } : {}),
      ...(images.length ? { images } : {}),
    };

    // Agent chat: include systemPrompt on the first message only
    if (window._agentSystemPrompt) {
      payload.systemPrompt = window._agentSystemPrompt;
      delete window._agentSystemPrompt;
      glog("send: injecting agent systemPrompt (" + payload.systemPrompt.length + " chars)");
    }

    glog("send: ws.send", JSON.stringify(payload).slice(0, 200));
    chatWsSend(payload);
    chatClearImages();
  } else {
    glog("send: ws not open, showing error");
    chatAppendError("Not connected to server");
    chatSetStreaming(false);
  }
}

function chatShowThinking() {
  if (document.getElementById("chat-thinking")) return; // already visible
  window._chatThinkingStart = Date.now();

  const container = document.getElementById("chat-messages");
  const div = document.createElement("div");
  div.className = "chat-thinking";
  div.id = "chat-thinking";

  const SIZE = 40;
  const DPR = window.devicePixelRatio || 1;
  const canvas = document.createElement("canvas");
  canvas.width = SIZE * DPR;
  canvas.height = SIZE * DPR;
  canvas.style.width = SIZE + "px";
  canvas.style.height = SIZE + "px";
  div.appendChild(canvas);
  container.appendChild(div);
  chatScrollToBottom();

  const ctx = canvas.getContext("2d");
  ctx.scale(DPR, DPR);
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
      speedTarget = r < 0.15 ? 0.15 + Math.random() * 0.35
                 : r < 0.65 ? 0.7  + Math.random() * 0.8
                 :             2.5  + Math.random() * 2.5;
    }
    speedMult += (speedTarget - speedMult) * 0.04;

    const cs = getComputedStyle(document.documentElement);
    const colors = [
      cs.getPropertyValue("--s-green").trim(),
      cs.getPropertyValue("--s-blue-text").trim(),
      cs.getPropertyValue("--text-strong").trim(),
    ];

    ctx.clearRect(0, 0, SIZE, SIZE);
    for (const p of particles) {
      p.angle += p.speed * speedMult;
      const r = p.radius + Math.sin(t * 0.003 + p.wobble) * 2.5;
      const x = cx + Math.cos(p.angle) * r;
      const y = cy + Math.sin(p.angle) * r;
      ctx.fillStyle = colors[p.colorIdx];
      ctx.beginPath();
      ctx.arc(x, y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
    window._chatOrbitalRaf = requestAnimationFrame(frame);
  }
  window._chatOrbitalRaf = requestAnimationFrame(frame);
}

function chatRemoveThinking() {
  const el = document.getElementById("chat-thinking");
  if (el) {
    const elapsed = window._chatThinkingStart ? Date.now() - window._chatThinkingStart : "?";
    glog(`removeThinking: visible for ${elapsed}ms`);
    el.remove();
  }
  if (window._chatOrbitalRaf) {
    cancelAnimationFrame(window._chatOrbitalRaf);
    window._chatOrbitalRaf = null;
  }
  if (window._chatThinkingTimer) {
    clearInterval(window._chatThinkingTimer);
    window._chatThinkingTimer = null;
  }
}

/** Reset the idle-gap timer. Called on every substantive event during streaming.
 *  If no event arrives within 400ms, the thinking orbital re-appears. */
function chatResetThinkingGap() {
  if (chatThinkingGapTimer) clearTimeout(chatThinkingGapTimer);
  if (!chatStreaming) return;
  chatThinkingGapTimer = setTimeout(() => {
    if (chatStreaming) chatShowThinking();
  }, 400);
}

function chatClearThinkingGap() {
  if (chatThinkingGapTimer) { clearTimeout(chatThinkingGapTimer); chatThinkingGapTimer = null; }
}

function chatStopStreaming() {
  glog("stopStreaming");
  if (!chatWorkspace) return;
  if (chatWs && chatWs.readyState === WebSocket.OPEN) {
    // For Claude: send soft interrupt first. If Claude doesn't respond within
    // 5 seconds, the server will escalate to kill.
    if (chatActiveCli === "claude") {
      chatWsSend({ type: "interrupt", workspace: chatWorkspace });
    }
    chatWsSend({ type: "stop", workspace: chatWorkspace, cli: chatActiveCli, sessionNum: chatSessionNum });
  }
  // Immediate feedback — don't wait for server round-trip
  chatRemoveThinking();
  chatSetStreaming(false);
  chatCurrentMsgEl = null;
  chatCurrentMsgText = "";
}

/** Stop the running process for the current session (kill, not just interrupt). */
function chatStopProcess() {
  if (!chatWorkspace) return;
  glog(`stopProcess workspace=${chatWorkspace} session=${chatSessionNum}`);
  fetch(`/api/sessions/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace: chatWorkspace, sessionNum: chatSessionNum }),
  }).then(() => {
    chatRemoveThinking();
    chatSetStreaming(false);
    chatUpdateProcessButtons(false);
  }).catch((e) => glog("stopProcess error:", e));
}

/** Start a new process for the current session (without sending a message). */
function chatStartProcess() {
  // Sending an empty "hello" just to bootstrap the process isn't ideal.
  // Instead, we surface a status message — the process starts on next message send.
  glog(`startProcess: process starts on next message send`);
  chatUpdateProcessButtons(false); // will update when session list refreshes
}

/** Update stop/start button visibility based on whether the session has an active process. */
function chatUpdateProcessButtons(active) {
  const stopBtn = document.getElementById("chat-process-stop");
  const startBtn = document.getElementById("chat-process-start");
  if (stopBtn) stopBtn.style.display = active ? "" : "none";
  if (startBtn) startBtn.style.display = active ? "none" : "";
}

function chatSetStreaming(active) {
  glog(`setStreaming: ${active}${!active && window._chatSendTime ? " totalRoundtrip=" + (Date.now() - window._chatSendTime) + "ms" : ""}`);
  chatStreaming = active;
  const input = document.getElementById("chat-input");
  const sendBtn = document.getElementById("chat-send");
  const stopBtn = document.getElementById("chat-stop");

  const modelSelect = document.getElementById("chat-model");
  if (modelSelect) modelSelect.disabled = active;

  const permSelect = document.getElementById("chat-permission-mode");
  if (permSelect) permSelect.disabled = active;

  const thinkingToggle = document.getElementById("chat-thinking-toggle");
  if (thinkingToggle) thinkingToggle.disabled = active;

  // Send button stays visible always (for steering mid-stream)
  // Stop button appears next to it only during generation
  if (stopBtn) stopBtn.style.display = active ? "" : "none";

  // Remove streaming class from previous message when done
  if (!active && chatCurrentMsgEl) {
    chatCurrentMsgEl.classList.remove("chat-streaming");
  }

  // Clean up thinking indicator and gap timer when streaming ends
  if (!active) { chatRemoveThinking(); chatClearThinkingGap(); }
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
      // If chat param specified, switch to that session first
      let explicitSession = null;
      if (params.chat) {
        const base = tool === "claude" ? "/api/claude-chat" : "/api/gemini";
        try {
          await fetch(`${base}/sessions/${encodeURIComponent(params.workspace)}/switch`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ session: Number(params.chat) }),
          });
          explicitSession = Number(params.chat);
        } catch {
          // Session switch failed — will load current session
        }
      }
      openChat(params.workspace, wsPath, tool, explicitSession);
    } else {
      // Workspace not found — show overlay with error
      document.getElementById("chat-overlay").classList.remove("hidden");
      const container = document.getElementById("chat-messages");
      container.innerHTML = "";
      const div = document.createElement("div");
      div.className = "chat-msg error";
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
      if (path) openChat(params.workspace, path, params.tool || "gemini");
    });
  } else {
    // No chat params — close panel if open
    const overlay = document.getElementById("chat-overlay");
    if (overlay && !overlay.classList.contains("hidden")) {
      overlay.classList.add("hidden");
    }
    document.body.classList.remove("chatonly", "chat-open");
  }
});

// Persist permission mode + send runtime switch to active relay
document.getElementById("chat-permission-mode")?.addEventListener("change", function() {
  chatSavePermissionMode(this.value);
  if (this.value && chatActiveCli === "claude" && chatWs && chatWs.readyState === WebSocket.OPEN) {
    chatWsSend({ type: "set_permission_mode", workspace: chatWorkspace, mode: this.value });
    glog("perm-switch: sent set_permission_mode=" + this.value);
  }
});

// Extended thinking toggle
function chatToggleThinking() {
  chatThinkingEnabled = !chatThinkingEnabled;
  const btn = document.getElementById("chat-thinking-toggle");
  if (btn) btn.classList.toggle("active", chatThinkingEnabled);
  if (chatWorkspace) localStorage.setItem(`klaudii-thinking-${chatWorkspace}`, chatThinkingEnabled ? "1" : "0");
  glog("thinking-toggle: enabled=" + chatThinkingEnabled);
}

function chatRestoreThinking() {
  const btn = document.getElementById("chat-thinking-toggle");
  if (!btn) return;
  // Only show for Claude backend
  btn.style.display = chatActiveCli === "claude" ? "" : "none";
  if (chatWorkspace) {
    const saved = localStorage.getItem(`klaudii-thinking-${chatWorkspace}`);
    chatThinkingEnabled = saved === "1";
  } else {
    chatThinkingEnabled = false;
  }
  btn.classList.toggle("active", chatThinkingEnabled);
}

// Persist model selection per workspace + send runtime model switch to active relay
document.getElementById("chat-model")?.addEventListener("change", function() {
  const newModel = this.value;
  if (chatWorkspace) localStorage.setItem(`klaudii-model-${chatWorkspace}`, newModel);
  // Send runtime model switch to active Claude relay (takes effect on next API call)
  if (newModel && chatActiveCli === "claude" && chatWs && chatWs.readyState === WebSocket.OPEN) {
    chatWsSend({ type: "set_model", workspace: chatWorkspace, model: newModel });
    glog("model-switch: sent set_model=" + newModel);
  }
});

// Draft sync — save as user types + set local typing guard
document.getElementById("chat-input")?.addEventListener("input", (e) => {
  const val = e.target.value;

  // Slash command menu: open/filter when input starts with "/", close otherwise
  if (val.startsWith("/") && chatActiveCli === "gemini") {
    const filter = val.slice(1); // text after "/"
    chatOpenSlashMenu(filter);
  } else if (chatSlashMenuOpen) {
    chatCloseSlashMenu();
  }

  // Mark as actively typing so incoming remote drafts don't clobber our input
  chatLocalDraftActive = true;
  clearTimeout(chatLocalDraftTimeout);
  chatLocalDraftTimeout = setTimeout(() => { chatLocalDraftActive = false; }, 1000);
  chatSaveDraft(val);
});

// Paste images from clipboard into chat
document.getElementById("chat-input")?.addEventListener("paste", (e) => {
  if (chatActiveCli !== "claude") return;
  const items = Array.from(e.clipboardData?.items || []);
  const imageItems = items.filter((item) => item.type.startsWith("image/"));
  if (imageItems.length === 0) return;
  e.preventDefault();
  imageItems.forEach((item) => {
    const file = item.getAsFile();
    if (file) chatLoadImageFile(file);
  });
});

// Drag-and-drop images onto the chat panel
const chatPanel = document.querySelector(".chat-panel");
if (chatPanel) {
  chatPanel.addEventListener("dragover", (e) => {
    if (chatActiveCli !== "claude") return;
    const hasImage = Array.from(e.dataTransfer.items || []).some((i) => i.type.startsWith("image/"));
    if (!hasImage) return;
    e.preventDefault();
    chatPanel.classList.add("drag-over");
  });
  chatPanel.addEventListener("dragleave", (e) => {
    if (!chatPanel.contains(e.relatedTarget)) chatPanel.classList.remove("drag-over");
  });
  chatPanel.addEventListener("drop", (e) => {
    chatPanel.classList.remove("drag-over");
    if (chatActiveCli !== "claude") return;
    e.preventDefault();
    Array.from(e.dataTransfer.files || []).forEach((file) => chatLoadImageFile(file));
  });
}

// Scroll to bottom whenever the tab/window regains visibility
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) chatScrollToBottom();
});

// --- Handoff Preview Modal ---

function chatShowHandoffPreview() {
  const body = document.getElementById("handoff-modal-body");
  body.textContent = "Loading briefing...";
  document.getElementById("handoff-modal").classList.remove("hidden");

  if (!chatWorkspace) {
    body.textContent = "(No workspace selected)";
    return;
  }

  fetch(`/api/claude-chat/briefing/${encodeURIComponent(chatWorkspace)}`)
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const ct = r.headers.get("content-type") || "";
      if (!ct.includes("application/json")) throw new Error("Server returned non-JSON response — try restarting the server");
      return r.json();
    })
    .then(data => {
      const text = data.briefing || "(empty)";
      // Render as markdown if marked is available, otherwise plain text
      if (typeof marked !== "undefined" && marked.parse) {
        body.style.whiteSpace = "normal";
        body.innerHTML = marked.parse(text);
      } else {
        body.style.whiteSpace = "pre-wrap";
        body.textContent = text;
      }
    })
    .catch(err => {
      body.textContent = "Failed to load briefing: " + err.message;
    });
}

function closeHandoffModal() {
  document.getElementById("handoff-modal").classList.add("hidden");
}

// --- Corgi mode (easter egg) ---

let corgiActive = false;

function chatSetCorgiMode(on) {
  corgiActive = on;
  const card = document.querySelector(".chat-input-card");
  if (!card) return;
  // Ensure card is a positioning context for the walker
  if (!card.style.position) card.style.position = "relative";
  card.style.overflow = on ? "visible" : "hidden";

  let el = document.getElementById("corgi-walker");
  if (on) {
    if (!el) {
      el = document.createElement("div");
      el.id = "corgi-walker";
      el.innerHTML = '<div class="corgi-sprite"></div>';
      card.appendChild(el);
    }
    el.classList.remove("hidden");
  } else {
    if (el) el.classList.add("hidden");
  }
}

// Auto-open chat from URL params on page load
initFromUrlParams();

// Safety net: periodically check WS health and reconnect if needed.
// This catches cases where the reconnect loop breaks (e.g., stuck CONNECTING,
// exception in handler, or timer getting GC'd).
setInterval(() => {
  if (!chatWs || (chatWs.readyState !== WebSocket.OPEN && chatWs.readyState !== WebSocket.CONNECTING)) {
    glog("ws-watchdog: not connected, triggering reconnect");
    chatConnect();
  }
}, 5000);
