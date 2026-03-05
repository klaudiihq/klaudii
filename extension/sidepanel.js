const DEFAULT_KLAUDII_URL = "http://localhost:9876";
const KONNECT_ORIGIN = "https://konnect.klaudii.com";

const THEME_ICONS = {
  auto: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,
  light: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`,
  dark:  `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`,
};
let themeMode = "auto"; // "auto" | "light" | "dark"

const CLOUD_SVG = `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>`;

// Stat icons (small inline SVGs matching iOS Label systemImage style)
const STAT_CPU_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>`;
const STAT_MEM_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><line x1="6" y1="12" x2="6" y2="12.01"/><line x1="10" y1="12" x2="10" y2="12.01"/><line x1="14" y1="12" x2="14" y2="12.01"/><line x1="18" y1="12" x2="18" y2="12.01"/></svg>`;
const STAT_CLOCK_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
const PENCIL_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>`;

// Clean phrases (matches iOS SessionCardView.cleanPhrases)
const CLEAN_PHRASES = [
  "squeaky clean", "pristine", "untouched", "clean as a whistle",
  "spotless", "mint condition", "not a scratch", "fresh",
  "zero diff", "nothing to see here", "all clear", "clean slate",
  "immaculate", "tidy", "ship-shape",
];

function cleanPhrase(project) {
  let hash = 0;
  for (let i = 0; i < project.length; i++) hash += project.charCodeAt(i);
  return CLEAN_PHRASES[Math.abs(hash) % CLEAN_PHRASES.length];
}

const GIT_PATH = "M23.546 10.93L13.067.452c-.604-.603-1.582-.603-2.188 0L8.708 2.627l2.76 2.76c.645-.215 1.379-.07 1.889.441.516.515.658 1.258.438 1.9l2.658 2.66c.645-.223 1.387-.078 1.9.435.721.72.721 1.884 0 2.604-.719.719-1.881.719-2.6 0-.539-.541-.674-1.337-.404-1.996L12.86 8.955v6.525c.176.086.342.203.488.348.713.721.713 1.883 0 2.6-.719.721-1.889.721-2.609 0-.719-.719-.719-1.879 0-2.598.182-.18.387-.316.605-.406V8.835c-.217-.091-.424-.222-.6-.401-.545-.545-.676-1.342-.396-2.009L7.636 3.7.45 10.881c-.6.605-.6 1.584 0 2.189l10.48 10.477c.604.604 1.582.604 2.186 0l10.43-10.43c.605-.603.605-1.582 0-2.187";
const gitSvg = (size) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${GIT_PATH}"/></svg>`;

// Legacy single-URL compat (kept for backward compat; klaudiiUrls[0] is the primary)
let klaudiiUrl = DEFAULT_KLAUDII_URL;
// All configured local server URLs
let klaudiiUrls = [DEFAULT_KLAUDII_URL];

// Konnect / multi-server state
let konnectUser = null;         // { id, email, name } if logged into konnect.klaudii.com
let konnectServers = [];        // [{ id, name, online, lastSeen }] from Konnect API
let konnectTunnels = new Map(); // serverId → KonnectTunnel
let konnectErrors = [];         // [{ name, error }] — servers that failed verification
let selectedServer = "all";     // "all" | { type:"local", url } | { type:"konnect", id, name }
let sessionsByProject = {};     // project → session (with _serverUrl or _konnectId)

// Server polling stats: key -> { failures: 0, status: "unknown"|"online"|"offline" }
let serverStats = {};

let pollTimer = null;
let approvalFastPollTimer = null;
let lastSessions = [];
let lastProcs = [];
let firstLoadDone = false; // Tracks if the initial poll attempt has finished
let activeTabUrl = null;
let sortMode = localStorage.getItem("sortMode") || "activity";
let branchFirst = false;
let openMode = "inplace";
let reuseLocalTab = false;
let attentionFlash = false;
let autoApprove = false;
let openTabs = new Map();       // urlPath (no query string) → tabId, for open claude.ai tabs in this window
let sessionNeedsInput = {};     // project → bool: session has a pending approval button
let sessionAutoApproved = {};   // project → bool: auto-approve just fired, show green flash
let sessionAutoApproveConfig = {}; // project → bool: per-session auto-approve
try { sessionAutoApproveConfig = JSON.parse(localStorage.getItem("sessionAutoApprove") || "{}"); } catch { sessionAutoApproveConfig = {}; }
function saveSessionAutoApprove() { localStorage.setItem("sessionAutoApprove", JSON.stringify(sessionAutoApproveConfig)); }

const PERM_MODE_LABELS = { yolo: "Bypass Permissions", ask: "Ask Permissions", strict: "Plan Mode" };
const PERM_BADGE_LABELS = { yolo: "bypass", ask: "ask", strict: "plan" };

const CHAT_MODES = ["gemini", "claude-local", "claude-remote"];
const CHAT_MODE_LABELS = { "gemini": "Gemini", "claude-local": "Claude Local", "claude-remote": "Claude Remote" };

let addSelectedRepo = null; // repo name chosen in the add-workspace flow
let addRepos = [];          // cached list from /api/github/repos

// --- Init ---

async function init() {
  const config = await chrome.storage.sync.get(["klaudiiUrl", "klaudiiUrls", "openMode", "reuseLocalTab", "attentionFlash", "autoApprove", "themeMode", "branchFirst"]);

  // Migrate from single klaudiiUrl to klaudiiUrls list
  if (config.klaudiiUrls && config.klaudiiUrls.length) {
    klaudiiUrls = config.klaudiiUrls;
  } else {
    klaudiiUrls = [(config.klaudiiUrl || DEFAULT_KLAUDII_URL).replace(/\/+$/, "")];
  }
  klaudiiUrl = klaudiiUrls[0];

  openMode = config.openMode || "inplace";
  reuseLocalTab = config.reuseLocalTab === true;
  attentionFlash = config.attentionFlash === true;
  autoApprove = config.autoApprove === true;
  branchFirst = config.branchFirst === true;
  themeMode = config.themeMode || "auto";
  applyTheme();

  // Restore selected server from last session
  try {
    const stored = localStorage.getItem("selectedServer");
    selectedServer = stored ? JSON.parse(stored) : "all";
  } catch {
    selectedServer = "all";
  }

  document.getElementById("btn-add").addEventListener("click", toggleAddForm);
  document.getElementById("btn-add-cancel").addEventListener("click", closeAddForm);
  document.getElementById("btn-add-newrepo").addEventListener("click", () => showAddStep("newrepo"));
  document.getElementById("btn-add-backfromnewrepo").addEventListener("click", () => showAddStep("repo"));
  document.getElementById("btn-add-createrepo").addEventListener("click", submitCreateRepo);
  document.getElementById("btn-add-backtorepo").addEventListener("click", () => showAddStep("repo"));
  document.getElementById("btn-add-start").addEventListener("click", submitStartSession);
  document.getElementById("add-repo-q").addEventListener("input", filterAddRepos);
  document.getElementById("add-repo-q").addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAddForm();
    if (e.key === "Enter") document.querySelector(".add-repo-item")?.click();
  });
  document.getElementById("add-branch-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitStartSession();
    if (e.key === "Escape") closeAddForm();
  });
  document.getElementById("add-newrepo-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("add-newrepo-remote").focus();
    if (e.key === "Escape") closeAddForm();
  });
  document.getElementById("add-newrepo-remote").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitCreateRepo();
    if (e.key === "Escape") closeAddForm();
  });
  document.getElementById("btn-dashboard").addEventListener("click", openDashboard);
  document.getElementById("btn-refresh").addEventListener("click", refresh);
  document.getElementById("btn-settings").addEventListener("click", openSettings);
  document.getElementById("btn-configure").addEventListener("click", () => {
    if (!settingsOpen) openSettings();
  });
  initSettingsListeners();

  const btnAutoApprove = document.getElementById("btn-auto-approve");
  const chkAutoApproveAll = document.getElementById("chk-auto-approve-all");
  chkAutoApproveAll.checked = autoApprove;
  btnAutoApprove.classList.toggle("active", autoApprove);
  chkAutoApproveAll.addEventListener("change", () => {
    autoApprove = chkAutoApproveAll.checked;
    btnAutoApprove.classList.toggle("active", autoApprove);
    chrome.storage.sync.set({ autoApprove });
    updateUI();
  });
  // Allow clicking anywhere on the footer row to toggle
  btnAutoApprove.addEventListener("click", (e) => {
    if (e.target.closest(".toggle-switch")) return; // checkbox handles itself
    chkAutoApproveAll.checked = !chkAutoApproveAll.checked;
    chkAutoApproveAll.dispatchEvent(new Event("change"));
  });

  document.getElementById("btn-theme").addEventListener("click", () => {
    themeMode = themeMode === "auto" ? "dark" : themeMode === "dark" ? "light" : "auto";
    chrome.storage.sync.set({ themeMode });
    applyTheme();
  });

  // Sort toggle
  document.querySelectorAll(".sort-btn[data-sort]").forEach((btn) => {
    btn.addEventListener("click", () => {
      sortMode = btn.dataset.sort;
      localStorage.setItem("sortMode", sortMode);
      document.querySelectorAll(".sort-btn[data-sort]").forEach((b) =>
        b.classList.toggle("active", b.dataset.sort === sortMode)
      );
      updateUI();
    });
  });
  document.querySelectorAll(".sort-btn[data-sort]").forEach((b) =>
    b.classList.toggle("active", b.dataset.sort === sortMode)
  );

  // React to settings changes from options page
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (changes.klaudiiUrls || changes.klaudiiUrl) {
      if (changes.klaudiiUrls) klaudiiUrls = changes.klaudiiUrls.newValue;
      if (changes.klaudiiUrl) klaudiiUrl = changes.klaudiiUrl.newValue;
      updateUI();
      refresh();
    }
    if (changes.branchFirst) {
      branchFirst = changes.branchFirst.newValue === true;
      updateUI();
    }
    if (changes.attentionFlash) {
      attentionFlash = changes.attentionFlash.newValue === true;
    }
    if (changes.openMode) {
      openMode = changes.openMode.newValue || "inplace";
    }
  });

  // Server picker toggle
  document.getElementById("btn-server-picker").addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = document.getElementById("server-picker-menu");
    const isOpen = !menu.classList.contains("hidden");
    menu.classList.toggle("hidden", isOpen);
    e.currentTarget.classList.toggle("open", !isOpen);
  });

  // Server picker menu item clicks
  document.getElementById("server-picker-menu").addEventListener("click", (e) => {
    const item = e.target.closest("[data-server-key]");
    if (!item || item.disabled) return;
    const key = item.dataset.serverKey;
    if (key === "all") {
      selectedServer = "all";
    } else if (key.startsWith("local:")) {
      const url = klaudiiUrls[parseInt(key.slice(6))];
      selectedServer = { type: "local", url };
    } else if (key.startsWith("konnect:")) {
      const id = key.slice(8);
      const srv = konnectServers.find((s) => s.id === id);
      if (srv) selectedServer = { type: "konnect", id: srv.id, name: srv.name };
    }
    localStorage.setItem("selectedServer", JSON.stringify(selectedServer));
    document.getElementById("server-picker-menu").classList.add("hidden");
    document.getElementById("btn-server-picker").classList.remove("open");
    updateUI();
  });

  updateUI();
  trackActiveTab();
  await refresh();
  pollTimer = setInterval(refresh, 5000);

  // Non-blocking: discover Konnect servers after initial load
  fetchKonnectData();
}

// --- API ---

function recordServerResult(key, ok) {
  if (!serverStats[key]) serverStats[key] = { failures: 0, status: "unknown" };
  const s = serverStats[key];
  if (ok) {
    s.failures = 0;
    s.status = "online";
  } else {
    s.failures++;
    if (s.failures >= 3) s.status = "offline";
  }
}

async function api(path, opts = {}, serverUrl) {
  const base = (serverUrl || klaudiiUrls[0] || DEFAULT_KLAUDII_URL).replace(/\/+$/, "");
  const res = await fetch(base + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return res.json();
}

// Route an API call to the server that owns the given project
async function sessionApiCall(project, path, opts = {}) {
  const s = sessionsByProject[project];
  if (s?._konnectId) return konnectApi(s._konnectId, path, opts);
  return api(path, opts, s?._serverUrl);
}

// --- Konnect tunnel API ---

async function konnectApi(serverId, path, opts = {}) {
  let tunnel = konnectTunnels.get(serverId);
  if (!tunnel || !tunnel.isConnected) {
    // Try stored connection keys first
    let { konnectConnectionKeys = {} } = await chrome.storage.local.get("konnectConnectionKeys");

    if (!konnectConnectionKeys[serverId]) {
      // Auto-open konnect.klaudii.com briefly to let the bridge script read localStorage
      konnectConnectionKeys = await chrome.runtime.sendMessage({ action: "fetchConnectionKeys" }) || {};
    }

    const key = konnectConnectionKeys[serverId];
    if (!key) throw new Error("no_connection_key");
    if (!konnectUser) throw new Error("not_logged_in");

    tunnel = new KonnectTunnel(serverId, key, konnectUser.id);
    konnectTunnels.set(serverId, tunnel);
    await tunnel.connect();
  }
  return tunnel.request(path, opts);
}

// --- E2E WebSocket tunnel (mirrors connect/server/public/cloud.js) ---

class KonnectTunnel {
  constructor(serverId, connectionKeyHex, userId) {
    this.serverId = serverId;
    this.connectionKeyHex = connectionKeyHex;
    this.userId = userId;
    this.ws = null;
    this.pending = new Map(); // requestId → { resolve, reject }
    this.isConnected = false;
    this._connectPromise = null;
  }

  connect() {
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = new Promise((resolve, reject) => {
      const url = `${KONNECT_ORIGIN.replace(/^http/, "ws")}/ws?role=browser&serverId=${this.serverId}&userId=${this.userId}`;
      this.ws = new WebSocket(url);
      const timeout = setTimeout(() => {
        this.ws.close();
        reject(new Error("tunnel_timeout"));
      }, 10000);

      this.ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.type === "server_status") {
            clearTimeout(timeout);
            if (!msg.online) { this.ws.close(); reject(new Error("server_offline")); return; }
            this.isConnected = true;
            resolve();
          } else if (msg.type === "api_response") {
            this._handleResponse(msg);
          }
        } catch {}
      };

      this.ws.onerror = () => { clearTimeout(timeout); reject(new Error("tunnel_error")); };
      this.ws.onclose = () => {
        this.isConnected = false;
        this._connectPromise = null;
        for (const [, { reject: rej }] of this.pending) rej(new Error("tunnel_closed"));
        this.pending.clear();
      };
    });
    return this._connectPromise;
  }

  async _handleResponse(msg) {
    const p = this.pending.get(msg.requestId);
    if (!p) return;
    this.pending.delete(msg.requestId);

    // Handle relay-level errors (server_offline, wrong_key, etc.)
    if (msg.error) {
      if (msg.error === "wrong_key") {
        // Connection key is stale — clear it so we re-pair next time
        const { konnectConnectionKeys = {} } = await chrome.storage.local.get("konnectConnectionKeys");
        delete konnectConnectionKeys[this.serverId];
        chrome.storage.local.set({ konnectConnectionKeys });
        this.ws?.close();
      }
      p.reject(new Error(msg.error));
      return;
    }

    try {
      const plain = await this._decrypt(msg.encrypted);
      p.resolve(JSON.parse(new TextDecoder().decode(plain)));
    } catch (e) { p.reject(e); }
  }

  async request(path, opts = {}) {
    if (!this.isConnected) await this.connect();
    const requestId = crypto.randomUUID();
    const payload = JSON.stringify({ method: opts.method || "GET", path, body: opts.body || null });
    const encrypted = await this._encrypt(new TextEncoder().encode(payload));
    this.ws.send(JSON.stringify({ type: "api_request", requestId, encrypted }));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(requestId); reject(new Error("request_timeout")); }, 15000);
      this.pending.set(requestId, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
    });
  }

  disconnect() { this.ws?.close(); this.isConnected = false; }

  async _encrypt(data) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await this._deriveKey(salt);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
    const combined = new Uint8Array(12 + cipher.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(cipher), 12);
    return { salt: _b64(salt), data: _b64(combined) };
  }

  async _decrypt({ salt, data }) {
    const saltBytes = _unb64(salt);
    const combined = _unb64(data);
    const key = await this._deriveKey(saltBytes);
    return crypto.subtle.decrypt({ name: "AES-GCM", iv: combined.slice(0, 12) }, key, combined.slice(12));
  }

  async _deriveKey(salt) {
    const keyMaterial = await crypto.subtle.importKey("raw", _hexToBytes(this.connectionKeyHex), "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("klaudii-e2e") },
      keyMaterial, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
    );
  }
}

function _b64(bytes) { return btoa(String.fromCharCode(...bytes)); }
function _unb64(str) { return new Uint8Array(atob(str).split("").map((c) => c.charCodeAt(0))); }
function _hexToBytes(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return arr;
}

// --- Konnect discovery ---
// Opens konnect.klaudii.com in a hidden tab and uses chrome.scripting.executeScript
// in the page's MAIN world to fetch user/server data (page-context fetch includes
// session cookies that cross-origin extension fetches can't access).

async function fetchKonnectData() {
  try {
    // Use cached data only if we have a valid logged-in user
    const cached = await chrome.storage.local.get(["konnectUser", "konnectServers"]);
    if (cached.konnectUser) {
      konnectUser = cached.konnectUser;
      konnectServers = cached.konnectServers || [];
    } else {
      // No valid cached user — fetch fresh data via background (opens hidden tab)
      const result = await chrome.runtime.sendMessage({ action: "fetchKonnectData" });
      if (result && result.user) {
        konnectUser = result.user;
        konnectServers = result.servers || [];
      } else {
        konnectUser = null;
        konnectServers = [];
      }
    }
  } catch {
    konnectUser = null;
  }

  // Verify each online server with a test API call before showing it
  await verifyKonnectServers();
  updateUI();
}

async function verifyKonnectServers() {
  const online = konnectServers.filter((s) => s.online);
  if (!online.length) { konnectErrors = []; return; }

  const results = await Promise.allSettled(
    online.map(async (srv) => {
      await konnectApi(srv.id, "/api/sessions");
      return srv;
    })
  );

  const verified = [];
  const errors = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === "fulfilled") {
      verified.push(online[i]);
    } else {
      errors.push({ name: online[i].name, error: results[i].reason?.message || "unknown" });
    }
  }

  // Keep offline servers in the list, replace online ones with only verified
  konnectServers = [
    ...konnectServers.filter((s) => !s.online),
    ...verified.map((s) => ({ ...s, verified: true })),
  ];
  konnectErrors = errors;

  // If the selected server failed verification, fall back to "all"
  if (selectedServer?.type === "konnect" && !verified.some((s) => s.id === selectedServer.id)) {
    selectedServer = "all";
    localStorage.setItem("selectedServer", JSON.stringify(selectedServer));
  }
}

// React to bridge updates (e.g. user logs in/out on konnect.klaudii.com)
chrome.storage.local.onChanged.addListener(async (changes) => {
  if (changes.konnectUser || changes.konnectServers) {
    if (changes.konnectUser) konnectUser = changes.konnectUser.newValue || null;
    if (changes.konnectServers) konnectServers = changes.konnectServers.newValue || [];
    await verifyKonnectServers();
    renderServerPicker();
    renderKonnectWarning();
  }
});

// --- Server picker ---

function renderServerPicker() {
  const menu = document.getElementById("server-picker-menu");
  const label = document.getElementById("server-picker-label");

  // Update button label
  if (selectedServer === "all") {
    label.textContent = "All";
  } else if (selectedServer.type === "local") {
    label.textContent = selectedServer.url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  } else if (selectedServer.type === "konnect") {
    label.textContent = selectedServer.name;
  }

  const isSelAll = selectedServer === "all";
  let html = `
    <div class="server-picker-section">
      <button class="server-picker-item${isSelAll ? " selected" : ""}" data-server-key="all">
        <span class="sp-name">All Servers</span>
      </button>
    </div>`;

  if (klaudiiUrls.length) {
    const items = klaudiiUrls.map((url, i) => {
      const short = url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
      const isSel = selectedServer.type === "local" && selectedServer.url === url;
      const stats = serverStats[`local:${url}`] || { status: "unknown" };
      const dotClass = stats.status === "online" ? "online" : (stats.status === "offline" ? "offline" : "");

      return `<button class="server-picker-item${isSel ? " selected" : ""}" data-server-key="local:${i}">
        <span class="sp-name">${esc(short)}</span>
        <span class="sp-dot ${dotClass}"></span>
      </button>`;
    }).join("");
    html += `<div class="server-picker-section"><div class="server-picker-heading">Local</div>${items}</div>`;
  }

  // Show ALL Konnect servers with green/red status dots
  if (konnectServers.length) {
    const items = konnectServers.map((srv) => {
      const isSel = selectedServer.type === "konnect" && selectedServer.id === srv.id;
      const stats = serverStats[`konnect:${srv.id}`] || { status: srv.verified ? "online" : "unknown" };
      const dotClass = stats.status === "online" ? "online" : (stats.status === "offline" ? "offline" : "");

      return `<button class="server-picker-item${isSel ? " selected" : ""}"
        data-server-key="konnect:${esc(srv.id)}">
        ${CLOUD_SVG}
        <span class="sp-name">${esc(srv.name)}</span>
        <span class="sp-dot ${dotClass}"></span>
      </button>`;
    }).join("");
    html += `<div class="server-picker-section"><div class="server-picker-heading">Kloud Konnect</div>${items}</div>`;
  } else if (konnectUser) {
    html += `<div class="server-picker-section"><div class="server-picker-heading">Kloud Konnect</div>
      <div class="server-picker-item" style="cursor:default;color:var(--text-dimmer)">No servers paired</div>
    </div>`;
  }

  menu.innerHTML = html;
}

function renderKonnectWarning() {
  const el = document.getElementById("konnect-dot");
  if (!el) return;

  // Only relevant when user has Konnect servers
  const totalKonnect = konnectServers.filter((s) => s.online).length;
  if (!konnectUser || totalKonnect === 0) {
    el.classList.add("hidden");
    el.className = "konnect-dot hidden";
    el.title = "";
    return;
  }

  const verifiedCount = konnectServers.filter((s) => s.verified).length;
  const errorCount = konnectErrors.length;

  let dotClass, tooltip;
  if (errorCount === 0 && verifiedCount > 0) {
    // All servers reachable
    dotClass = "konnect-ok";
    tooltip = `All ${verifiedCount} Konnect server${verifiedCount > 1 ? "s" : ""} connected`;
  } else if (verifiedCount > 0 && errorCount > 0) {
    // Some reachable, some not
    dotClass = "konnect-partial";
    const names = konnectErrors.map((e) => e.name).join(", ");
    tooltip = `${verifiedCount} connected, ${errorCount} unreachable: ${names}`;
  } else {
    // All down
    dotClass = "konnect-down";
    const names = konnectErrors.map((e) => `${e.name}: ${e.error}`).join("\n");
    tooltip = `All Konnect servers unreachable\n${names}`;
  }

  el.className = `konnect-dot ${dotClass}`;
  el.title = tooltip;
}

// --- Data loading ---

// Persistent cache to prevent flashing on temporary poll failures
let sessionsCache = new Map(); // serverKey -> sessions[]
let procsCache = new Map();    // serverKey -> procs[]

function getFilteredData() {
  const sessions = lastSessions;
  const procs = lastProcs;
  if (selectedServer !== "all") {
    if (selectedServer.type === "local") {
      return {
        sessions: lastSessions.filter((s) => s._serverUrl === selectedServer.url),
        procs: lastProcs.filter((p) => p._serverUrl === selectedServer.url)
      };
    } else if (selectedServer.type === "konnect") {
      return {
        sessions: lastSessions.filter((s) => s._konnectId === selectedServer.id),
        procs: lastProcs.filter((p) => p._konnectId === selectedServer.id)
      };
    }
  }
  return { sessions, procs };
}

function updateUI() {
  const { sessions, procs } = getFilteredData();
  const showServerBadge = lastSessions.some((s) => s._konnectId) || klaudiiUrls.length > 1;

  if (firstLoadDone) {
    document.getElementById("loading-overlay").classList.add("hidden");
  }

  renderSessions(sessions, procs, showServerBadge);
  renderUnmanaged(procs);
  renderServerPicker();
  renderKonnectWarning();
}

async function refresh() {
  let anyOk = false;
  const seenSessions = new Set();

  const fetchLocal = async (url) => {
    const key = `local:${url}`;
    try {
      const [sessions, procs] = await Promise.all([
        api("/api/sessions", {}, url),
        api("/api/processes", {}, url),
      ]);
      recordServerResult(key, true);
      sessionsCache.set(key, sessions.map(s => ({ ...s, _serverUrl: url })));
      procsCache.set(key, procs.map(p => ({ ...p, _serverUrl: url })));
      anyOk = true;
      return true;
    } catch {
      recordServerResult(key, false);
      // If server is officially "offline" (3+ failures), clear its cache
      if (serverStats[key]?.status === "offline") {
        sessionsCache.delete(key);
        procsCache.delete(key);
      }
      return false;
    }
  };

  const fetchKonnect = async (kSrv) => {
    const key = `konnect:${kSrv.id}`;
    try {
      const [sessions, procs] = await Promise.all([
        konnectApi(kSrv.id, "/api/sessions"),
        konnectApi(kSrv.id, "/api/processes"),
      ]);
      recordServerResult(key, true);
      sessionsCache.set(key, sessions.map(s => ({ ...s, _konnectId: kSrv.id, _konnectName: kSrv.name })));
      procsCache.set(key, procs.map(p => ({ ...p, _konnectId: kSrv.id, _konnectName: kSrv.name })));
      anyOk = true;
      return true;
    } catch {
      recordServerResult(key, false);
      if (serverStats[key]?.status === "offline") {
        sessionsCache.delete(key);
        procsCache.delete(key);
      }
      return false;
    }
  };

  const tasks = [];
  for (const url of klaudiiUrls) tasks.push(fetchLocal(url));
  for (const kSrv of konnectServers.filter((s) => s.online)) tasks.push(fetchKonnect(kSrv));

  if (tasks.length === 0) {
    setConnected(true);
    sessionsCache.clear();
    procsCache.clear();
    lastSessions = [];
    lastProcs = [];
    updateUI();
    return;
  }

  await Promise.allSettled(tasks);

  // Clean up cache for servers no longer in config
  const currentKeys = new Set([
    ...klaudiiUrls.map(url => `local:${url}`),
    ...konnectServers.filter(s => s.online).map(s => `konnect:${s.id}`)
  ]);
  for (const key of sessionsCache.keys()) {
    if (!currentKeys.has(key)) {
      sessionsCache.delete(key);
      procsCache.delete(key);
    }
  }

  // Reconstruct lastSessions and lastProcs from cache
  const allSessions = [];
  for (const sessions of sessionsCache.values()) {
    for (const s of sessions) {
      const id = s.id || s.project;
      if (!seenSessions.has(id)) {
        seenSessions.add(id);
        allSessions.push(s);
      }
    }
  }
  
  const allProcs = Array.from(procsCache.values()).flat();

  // Update project → session lookup for action routing
  sessionsByProject = {};
  for (const s of allSessions) sessionsByProject[s.project] = s;

  lastSessions = allSessions;
  lastProcs = allProcs;
  
  firstLoadDone = true;
  setConnected(anyOk);
  updateUI();
  checkApprovalStates(allSessions);
}

function applyTheme() {
  document.documentElement.classList.remove("theme-light", "theme-dark");
  if (themeMode !== "auto") document.documentElement.classList.add(`theme-${themeMode}`);
  const TITLES = { auto: "Theme: auto — click for dark", dark: "Theme: dark — click for light", light: "Theme: light — click for auto" };
  const btn = document.getElementById("btn-theme");
  btn.innerHTML = THEME_ICONS[themeMode];
  btn.title = TITLES[themeMode];
}

function setConnected(ok) {
  const badge = document.getElementById("status-badge");
  const errorBanner = document.getElementById("connection-error");

  if (ok) {
    badge.textContent = "connected";
    badge.className = "badge ok";
    errorBanner.classList.add("hidden");
  } else {
    badge.textContent = "offline";
    badge.className = "badge error";
    errorBanner.classList.remove("hidden");
  }
}

// --- Approval detection ---

async function checkApprovalStates(sessions) {
  const newStates = {};
  for (const s of sessions) {
    if (s.status !== "running" || !s.claudeUrl) continue;
    const sessionUrlPath = s.claudeUrl.split("?")[0];
    const entry = [...openTabs.entries()].find(([u]) => u.startsWith(sessionUrlPath));
    if (!entry) continue;
    const tabId = entry[1];
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (shouldAutoApprove) => {
          const btn = Array.from(document.querySelectorAll("button")).find((b) => {
            const text = b.textContent.trim();
            return text.includes("Allow") || text.includes("Approve") || text === "Skip";
          });
          if (!btn) return { found: false, clicked: false };
          const isApprovable = btn.textContent.trim().includes("Allow") || btn.textContent.trim().includes("Approve");
          if (shouldAutoApprove && isApprovable) { btn.click(); return { found: true, clicked: true }; }
          return { found: true, clicked: false };
        },
        args: [autoApprove || sessionAutoApproveConfig[s.project] === true],
      });
      const result = results?.[0]?.result;
      if (result?.clicked) {
        if (!sessionAutoApproved[s.project]) {
          sessionAutoApproved[s.project] = true;
          updateUI();
          setTimeout(() => { delete sessionAutoApproved[s.project]; }, 5000);
        }
      } else if (result?.found) {
        newStates[s.project] = true;
      }
    } catch {
      // Tab not injectable (loading, navigating, wrong origin, etc.)
    }
  }
  const changed = sessions.some((s) => !!newStates[s.project] !== !!sessionNeedsInput[s.project]);
  sessionNeedsInput = newStates;
  if (changed) updateUI();

  const anyNeedsInput = Object.values(sessionNeedsInput).some(Boolean) || Object.values(sessionAutoApproved).some(Boolean);
  if (anyNeedsInput && !approvalFastPollTimer) {
    approvalFastPollTimer = setInterval(() => checkApprovalStates(lastSessions), 750);
  } else if (!anyNeedsInput && approvalFastPollTimer) {
    clearInterval(approvalFastPollTimer);
    approvalFastPollTimer = null;
  }
}

// --- Track which claude.ai tab is active ---

function trackActiveTab() {
  updateActiveTabUrl();
  updateOpenTabs();
  chrome.tabs.onActivated.addListener(() => updateActiveTabUrl());
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    if (changeInfo.url || changeInfo.status === "complete") {
      updateActiveTabUrl();
      updateOpenTabs();
    }
  });
  chrome.tabs.onRemoved.addListener(() => updateOpenTabs());
}

function updateOpenTabs() {
  chrome.windows.getCurrent((win) => {
    const query = { url: "https://claude.ai/*" };
    if (win?.id) query.windowId = win.id;
    chrome.tabs.query(query, (tabs) => {
      openTabs = new Map((tabs || []).filter((t) => t.url).map((t) => [t.url.split("?")[0], t.id]));
      if (lastSessions.length) updateUI();
    });
  });
}

function updateActiveTabUrl() {
  chrome.runtime.sendMessage({ action: "getActiveTabUrl" }, (response) => {
    if (chrome.runtime.lastError) return;
    const newUrl = response?.url || null;
    if (newUrl !== activeTabUrl) {
      activeTabUrl = newUrl;
      highlightActiveSession();
    }
  });
}

function highlightActiveSession() {
  document.querySelectorAll(".card").forEach((card) => {
    const url = card.dataset.claudeUrl;
    if (url && activeTabUrl && activeTabUrl.startsWith(url)) {
      card.classList.add("active-in-tab");
    } else {
      card.classList.remove("active-in-tab");
    }
  });
}

// --- Sort ---

function sortSessions(sessions) {
  const statusOrder = { running: 0, exited: 1, stopped: 2 };
  return [...sessions].sort((a, b) => {
    const sa = statusOrder[a.status] ?? 2;
    const sb = statusOrder[b.status] ?? 2;
    if (sa !== sb) return sa - sb;
    if (sortMode === "alpha") return a.project.localeCompare(b.project);
    return (b.lastActivity || 0) - (a.lastActivity || 0);
  });
}

// --- Render sessions ---

function renderSessions(sessions, procs, showServerBadge) {
  // Determine badge visibility: use last known value if not explicitly passed
  if (showServerBadge === undefined) {
    showServerBadge = sessions.some((s) => s._konnectId) || klaudiiUrls.length > 1;
  }
  const container = document.getElementById("sessions-container");

  if (!sessions.length) {
    container.innerHTML = `
      <div class="empty-state">
        <p>No workspaces configured.</p>
        <button class="btn primary btn-sm" onclick="openDashboard()">Open Dashboard</button>
      </div>`;
    return;
  }

  const procByProject = {};
  if (procs) {
    for (const p of procs) {
      if (p.managed && p.project) procByProject[p.project] = p;
    }
  }

  container.innerHTML = sortSessions(sessions)
    .map((s) => renderCard(s, procByProject[s.project], showServerBadge))
    .join("");
  highlightActiveSession();
}

function renderCard(s, proc, showServerBadge = false) {
  const parts = s.project.split("--");
  const repo = parts[0];
  const branch = parts.length > 1 ? parts.slice(1).join("--") : null;
  const g = s.git;
  const gitBranch = g ? g.branch : branch;
  const status = s.status || (s.running ? "running" : "stopped");
  const isRunning = status === "running" || status === "exited";
  const mode = s.permissionMode || "yolo";

  const repoGitLink = s.remoteUrl
    ? `<a class="git-link" href="${esc(s.remoteUrl)}" target="_blank" rel="noreferrer" title="Open on GitHub">${gitSvg(12)}</a>`
    : "";
  const branchGitLink = s.remoteUrl && gitBranch
    ? `<a class="git-link" href="${esc(s.remoteUrl + "/tree/" + gitBranch)}" target="_blank" rel="noreferrer" title="View branch on GitHub">${gitSvg(10)}</a>`
    : "";

  // Pencil edit button
  const editBtn = `<button class="card-edit-btn" data-action="toggle-panel" data-project="${esc(s.project)}" title="Options">${PENCIL_SVG}</button>`;

  // Git status row (clean phrases + dirty/unpushed)
  // When not running, pencil sits inline in the git bar to save vertical space
  let gitStatusRow = "";
  if (g) {
    const items = [];
    if (g.dirtyFiles) {
      items.push(`<span class="git-dirty">${g.dirtyFiles} file${g.dirtyFiles === 1 ? "" : "s"} touched</span>`);
    } else {
      items.push(`<span class="git-clean">${esc(cleanPhrase(s.project))}</span>`);
    }
    if (g.unpushed) items.push(`<span class="git-unpushed">${g.unpushed} unpushed</span>`);
    gitStatusRow = `<div class="git-bar">${items.join("")}${!proc ? editBtn : ""}</div>`;
  }

  // Subtitle line (branch)
  const subtitle = gitBranch || branch;

  // Process stats with icons + pencil edit button on the right
  let statsRow = "";
  if (proc) {
    const statParts = [];
    statParts.push(`<span class="proc-stat">${STAT_CPU_SVG} ${proc.cpu}%</span>`);
    statParts.push(`<span class="proc-stat">${STAT_MEM_SVG} ${proc.memMB} MB</span>`);
    if (proc.uptime) statParts.push(`<span class="proc-stat">${STAT_CLOCK_SVG} ${esc(proc.uptime)}</span>`);
    statsRow = `<div class="proc-stats">${statParts.join("")}${editBtn}</div>`;
  } else if (!g) {
    // No git info and no process — pencil still needs a home
    statsRow = `<div class="proc-stats">${editBtn}</div>`;
  }

  const permBadge = isRunning ? `<span class="perm-badge perm-${mode}">${PERM_BADGE_LABELS[mode] || mode}</span>` : "";

  // Per-session auto-approve toggle (hidden when global Auto Approve All is on)
  let autoApproveRow = "";
  if (!autoApprove) {
    const isSessionApprove = sessionAutoApproveConfig[s.project] === true;
    autoApproveRow = `
      <div class="auto-approve-row">
        <span class="auto-approve-row-label">Auto Approve</span>
        <label class="toggle-switch" title="Auto approve this session">
          <input type="checkbox" data-action="toggle-session-approve" data-project="${esc(s.project)}"${isSessionApprove ? " checked" : ""}>
          <span class="toggle-slider"></span>
        </label>
      </div>`;
  }

  const displayTitle = gitBranch ? `${repo} (${gitBranch})` : repo;
  const needsInput = sessionNeedsInput[s.project] === true;
  const wasAutoApproved = sessionAutoApproved[s.project] === true;
  const showDot = needsInput && !attentionFlash;
  const inputDot = showDot ? `<span class="needs-input-dot" title="Waiting for your approval"></span>` : "";
  const attentionClass = wasAutoApproved ? " auto-approved"
    : (needsInput && attentionFlash ? " needs-attention" : "");

  // Server badge when viewing "All" or multiple sources
  let serverBadge = "";
  if (showServerBadge) {
    if (s._konnectName) {
      serverBadge = `<span class="server-badge">${CLOUD_SVG}${esc(s._konnectName)}</span>`;
    } else if (s._serverUrl) {
      const short = s._serverUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
      serverBadge = `<span class="server-badge">${esc(short)}</span>`;
    }
  }

  // Inline action panel items (startup mode dropdown lives here for stopped cards)
  let panelItems = "";
  if (isRunning) {
    panelItems = `
      <button class="btn btn-sm danger" data-action="stop" data-project="${esc(s.project)}">Stop</button>
      <button class="btn btn-sm" data-action="restart" data-project="${esc(s.project)}">Restart</button>
      ${s.ttyd ? `<button class="btn btn-sm" data-action="terminal" data-port="${s.ttyd.port}">Terminal</button>` : ""}
      <button class="btn btn-sm" data-action="history" data-project="${esc(s.project)}">History</button>`;
  } else {
    const modeOptions = Object.entries(PERM_MODE_LABELS).map(([val, label]) =>
      `<option value="${val}"${val === mode ? " selected" : ""}>${label}</option>`
    ).join("");
    panelItems = `
      <div class="panel-mode-row">
        <span class="panel-mode-label">Startup Mode</span>
        <select class="mode-select" data-project="${esc(s.project)}">
          ${modeOptions}
        </select>
      </div>
      <button class="btn btn-sm primary" data-action="start" data-project="${esc(s.project)}">New Session</button>
      <button class="btn btn-sm" data-action="history" data-project="${esc(s.project)}">History</button>
      <button class="btn btn-sm danger" data-action="remove" data-project="${esc(s.project)}">Remove</button>`;
  }

  // Branch-first name swapping (matches iOS branchFirst toggle)
  const primaryName = branchFirst && subtitle ? subtitle : repo;
  const primaryLink = branchFirst && subtitle ? branchGitLink : repoGitLink;
  const secondaryName = branchFirst && subtitle ? repo : subtitle;
  const secondaryLink = branchFirst && subtitle ? repoGitLink : branchGitLink;

  // Chat mode pill
  const chatMode = s.chatMode || "claude-local";
  const chatActive = !!s.chatActive;
  const modePill = `<button class="chat-mode-pill mode-${esc(chatMode)}${chatActive ? " streaming" : ""}" data-action="cycle-chat-mode" data-project="${esc(s.project)}" title="Chat mode — click to change">${chatActive ? '<span class="mode-pulse"></span>' : '<span class="mode-dot"></span>'}${esc(CHAT_MODE_LABELS[chatMode] || chatMode)}</button>`;

  // Remote timing row (started / last activity)
  let remoteTimingRow = "";
  if (chatMode === "claude-remote") {
    const startedAt = s.tmux && s.tmux.created ? formatTime(s.tmux.created * 1000) : null;
    const lastAct = s.lastActivity ? formatTime(s.lastActivity) : null;
    if (startedAt || lastAct) {
      const parts = [];
      if (startedAt) parts.push(`started ${startedAt}`);
      if (lastAct) parts.push(`last activity ${lastAct}`);
      remoteTimingRow = `<div class="remote-timing">${parts.join(" · ")}</div>`;
    }
  }

  return `
    <div class="card${attentionClass}" data-project="${esc(s.project)}" data-claude-url="${esc(s.claudeUrl || "")}" data-chat-mode="${esc(chatMode)}" data-status="${status}" data-open-title="${esc(displayTitle)}" data-server-url="${esc(s._serverUrl || "")}" data-konnect-id="${esc(s._konnectId || "")}">
      <div class="card-accent ${status}"></div>
      <div class="card-body">
        <div class="card-header">
          <div class="card-names">
            <span class="card-title">${primaryLink}${esc(primaryName)}</span>
            ${secondaryName ? `<span class="card-subtitle">${secondaryLink}${esc(secondaryName)}</span>` : ""}
          </div>
          ${inputDot}
          <div class="card-badges">
            ${modePill}
            ${permBadge}
            <span class="card-status ${status}">${status}</span>
          </div>
        </div>
        ${remoteTimingRow}
        ${gitStatusRow}
        ${statsRow}
        ${autoApproveRow}
        ${serverBadge}
        <div class="card-actions-panel hidden">
          ${panelItems}
        </div>
        <div class="history-list hidden" id="history-${esc(s.project)}"></div>
      </div>
    </div>`;
}

// --- Render unmanaged processes ---

function renderUnmanaged(procs) {
  const section = document.getElementById("unmanaged-section");
  const container = document.getElementById("unmanaged-container");
  const unmanaged = procs.filter((p) => !p.managed);

  if (!unmanaged.length) {
    section.classList.add("hidden");
    return;
  }

  section.classList.remove("hidden");
  container.innerHTML = unmanaged.map((p) => `
    <div class="card freerange-card"
      data-server-url="${esc(p._serverUrl || "")}"
      data-konnect-id="${esc(p._konnectId || "")}">
      <div class="freerange-top">
        <span class="freerange-pid">pid ${p.pid}${p.launchedBy ? ` <span class="freerange-from">via ${esc(p.launchedBy)}</span>` : ""}</span>
        <span class="freerange-stats">${p.cpu}% · ${p.memMB} MB${p.uptime ? ` · ${esc(p.uptime)}` : ""}</span>
      </div>
      ${p.cwd ? `<div class="freerange-cwd">${esc(p.cwd)}</div>` : ""}
      <div style="display:flex">
        <button class="btn danger btn-sm" data-action="kill" data-pid="${p.pid}">Kill</button>
      </div>
    </div>`).join("");
}

// --- Actions (event delegation) ---

document.addEventListener("click", async (e) => {
  // Repo list item click in add-workspace flow
  const repoItem = e.target.closest("[data-add-repo]");
  if (repoItem) { selectAddRepo(repoItem.dataset.addRepo); return; }

  // Close server picker menu on outside click
  if (!e.target.closest("#server-picker")) {
    document.getElementById("server-picker-menu").classList.add("hidden");
    document.getElementById("btn-server-picker").classList.remove("open");
  }

  // Close open action panels when clicking outside them
  if (!e.target.closest(".card-actions-panel") && !e.target.closest("[data-action='toggle-panel']")) {
    closeAllPanels();
  }

  const btn = e.target.closest("[data-action]");
  if (!btn) return;

  const action = btn.dataset.action;
  const project = btn.dataset.project;

  switch (action) {
    case "open":
      chrome.windows.getCurrent((win) => {
        chrome.runtime.sendMessage({
          action: openMode === "tabs" ? "switchTab" : "navigateAndRename",
          url: btn.dataset.url,
          title: btn.dataset.title,
          windowId: win?.id,
          needsInput: !!sessionNeedsInput[project],
        });
      });
      break;

    case "start":
      btn.disabled = true;
      try {
        await sessionApiCall(project, "/api/sessions/start", { method: "POST", body: { project } });
      } catch (err) {
        showToast("Error: " + err.message);
      }
      setTimeout(refresh, 1000);
      break;

    case "continue":
      btn.disabled = true;
      try {
        await sessionApiCall(project, "/api/sessions/start", { method: "POST", body: { project, continueSession: true } });
      } catch (err) {
        showToast("Error: " + err.message);
      }
      setTimeout(refresh, 1000);
      break;

    case "stop":
      btn.disabled = true;
      try {
        await sessionApiCall(project, "/api/sessions/stop", { method: "POST", body: { project } });
      } catch (err) {
        showToast("Error: " + err.message);
      }
      refresh();
      break;

    case "restart":
      btn.disabled = true;
      try {
        await sessionApiCall(project, "/api/sessions/restart", { method: "POST", body: { project } });
      } catch (err) {
        showToast("Error: " + err.message);
      }
      setTimeout(refresh, 1500);
      break;

    case "terminal":
      chrome.runtime.sendMessage({
        action: "openUrl",
        url: `http://localhost:${btn.dataset.port}`,
      });
      break;

    case "history":
      toggleHistory(project);
      break;

    case "resume":
      btn.disabled = true;
      try {
        await sessionApiCall(project, "/api/sessions/start", {
          method: "POST",
          body: { project, resumeSessionId: btn.dataset.sessionId },
        });
      } catch (err) {
        showToast("Error: " + err.message);
      }
      setTimeout(refresh, 1000);
      break;

    // set-perm now handled by change event on .mode-select (see below)

    case "remove":
      if (btn.dataset.armed === "force") {
        btn.disabled = true;
        try {
          await sessionApiCall(project, "/api/projects/remove", { method: "POST", body: { project, force: true } });
          refresh();
        } catch (err) {
          showToast("Error: " + err.message);
          refresh();
        }
      } else if (btn.dataset.armed) {
        btn.disabled = true;
        try {
          await sessionApiCall(project, "/api/projects/remove", { method: "POST", body: { project } });
          refresh();
        } catch (err) {
          if (err.status === 409) {
            const g = err.data?.git;
            const detail = g
              ? `${g.dirtyFiles || 0} changed, ${g.unpushed || 0} unpushed`
              : "uncommitted changes";
            showToast(`Dirty repo (${detail}) — click Remove again to force`);
            btn.disabled = false;
            btn.dataset.armed = "force";
            btn.textContent = "Force?";
            btn.classList.add("warning");
            btn.classList.remove("danger");
            setTimeout(() => {
              if (btn.isConnected) {
                delete btn.dataset.armed;
                btn.textContent = "Remove";
                btn.classList.add("danger");
                btn.classList.remove("warning");
              }
            }, 5000);
          } else {
            showToast("Error: " + err.message);
            refresh();
          }
        }
      } else {
        btn.dataset.armed = "1";
        btn.textContent = "Confirm?";
        btn.classList.replace("danger", "warning");
        setTimeout(() => {
          if (btn.isConnected && btn.dataset.armed === "1") {
            delete btn.dataset.armed;
            btn.textContent = "Remove";
            btn.classList.replace("warning", "danger");
          }
        }, 3000);
      }
      break;

    case "kill": {
      const card = btn.closest(".freerange-card");
      const konnectId = card?.dataset.konnectId;
      const serverUrl = card?.dataset.serverUrl;
      const killApi = (path, opts) => konnectId
        ? konnectApi(konnectId, path, opts)
        : api(path, opts, serverUrl || undefined);

      if (btn.dataset.armed) {
        try {
          await killApi("/api/processes/kill", { method: "POST", body: { pid: parseInt(btn.dataset.pid) } });
        } catch {}
        refresh();
      } else {
        btn.dataset.armed = "1";
        btn.textContent = "Confirm?";
        btn.classList.replace("danger", "warning");
        setTimeout(() => {
          if (btn.isConnected) {
            delete btn.dataset.armed;
            btn.textContent = "Kill";
            btn.classList.replace("warning", "danger");
          }
        }, 3000);
      }
      break;
    }

    case "toggle-panel": {
      const card = btn.closest(".card");
      const panel = card?.querySelector(".card-actions-panel");
      if (!panel) break;
      const isOpen = !panel.classList.contains("hidden");
      closeAllPanels(); // close any other open panels
      if (!isOpen) {
        panel.classList.remove("hidden");
      }
      break;
    }

    case "cycle-chat-mode": {
      const card = btn.closest(".card");
      if (!card) break;
      const current = card.dataset.chatMode || "claude-local";
      const idx = CHAT_MODES.indexOf(current);
      const next = CHAT_MODES[(idx + 1) % CHAT_MODES.length];
      card.dataset.chatMode = next;
      btn.dataset.mode = next;
      btn.className = `chat-mode-pill mode-${next}`;
      btn.innerHTML = `<span class="mode-dot"></span>${esc(CHAT_MODE_LABELS[next] || next)}`;
      // Persist to server
      sessionApiCall(project, `/api/workspace-state/${encodeURIComponent(project)}`, {
        method: "PATCH",
        body: { mode: next },
      }).catch(() => {});
      break;
    }
  }
});

function closeAllPanels() {
  document.querySelectorAll(".card-actions-panel:not(.hidden)").forEach((p) => p.classList.add("hidden"));
}

// --- Mode select + per-session auto-approve (change events) ---

document.addEventListener("change", async (e) => {
  // Mode dropdown changed
  const select = e.target.closest(".mode-select");
  if (select) {
    const project = select.dataset.project;
    const mode = select.value;
    try {
      await sessionApiCall(project, "/api/projects/permission", { method: "POST", body: { project, mode } });
    } catch (err) {
      showToast("Error: " + err.message);
      refresh();
    }
    return;
  }

  // Per-session auto-approve toggle
  const toggle = e.target.closest("[data-action='toggle-session-approve']");
  if (toggle) {
    const project = toggle.dataset.project;
    sessionAutoApproveConfig[project] = toggle.checked;
    saveSessionAutoApprove();
    return;
  }
});

// --- Card body click → primary action ---

document.addEventListener("click", async (e) => {
  if (e.target.closest("button, a, input, select, label.toggle-switch")) return;
  const card = e.target.closest(".card");
  if (!card) return;

  const status = card.dataset.status;
  const url = card.dataset.claudeUrl;
  const project = card.dataset.project;
  const title = card.dataset.openTitle;
  const chatMode = card.dataset.chatMode || "claude-remote";

  if (chatMode === "claude-remote") {
    // Navigate to claude.ai (existing behavior)
    if (url && (status === "running" || status === "exited")) {
      chrome.windows.getCurrent((win) => {
        chrome.runtime.sendMessage({
          action: openMode === "tabs" ? "switchTab" : "navigateAndRename",
          url, title, windowId: win?.id,
          needsInput: !!sessionNeedsInput[project],
        });
      });
    } else if (status === "stopped") {
      try {
        await sessionApiCall(project, "/api/sessions/start", { method: "POST", body: { project, continueSession: true } });
      } catch (err) {
        showToast("Error: " + err.message);
      }
      setTimeout(refresh, 1000);
    }
  } else {
    // CLI mode — open Klaudii dashboard with chat pre-opened
    const serverUrl = card.dataset.serverUrl || klaudiiUrl;
    const tool = chatMode === "gemini" ? "gemini" : "claude";
    const dashUrl = `${serverUrl.replace(/\/+$/, "")}/?mode=chatonly&workspace=${encodeURIComponent(project)}&tool=${tool}`;
    if (reuseLocalTab) {
      chrome.windows.getCurrent((win) => {
        chrome.runtime.sendMessage({ action: "switchToUrl", url: dashUrl, windowId: win?.id });
      });
    } else if (openMode === "tabs") {
      chrome.runtime.sendMessage({ action: "openUrl", url: dashUrl });
    } else {
      chrome.runtime.sendMessage({ action: "navigateTab", url: dashUrl });
    }
  }
});

// --- History ---

async function toggleHistory(project) {
  const container = document.getElementById(`history-${project}`);
  if (!container) return;

  if (!container.classList.contains("hidden")) {
    container.classList.add("hidden");
    return;
  }

  container.innerHTML = '<div class="loading">Loading...</div>';
  container.classList.remove("hidden");

  try {
    const sessions = await sessionApiCall(project, `/api/history?project=${encodeURIComponent(project)}`);
    if (!sessions.length) {
      container.innerHTML = '<div style="padding:4px 0;color:#555;font-size:11px">No sessions found.</div>';
      return;
    }
    container.innerHTML = sessions.map((s) => `
      <div class="history-item">
        <span class="history-display">${esc(s.display || "(no message)")}</span>
        <div class="history-meta">
          <span class="history-time">${formatTime(s.timestamp)}</span>
          <span class="history-id">${s.sessionId.slice(0, 8)}</span>
          <button class="btn btn-sm" data-action="resume" data-project="${esc(project)}" data-session-id="${esc(s.sessionId)}">Resume</button>
        </div>
      </div>`).join("");
  } catch {
    container.innerHTML = '<div style="padding:4px 0;color:#f87171;font-size:11px">Failed to load.</div>';
  }
}

// --- Add workspace ---

function toggleAddForm() {
  const form = document.getElementById("add-workspace-form");
  const isHidden = form.classList.contains("hidden");
  form.classList.toggle("hidden");
  if (isHidden) {
    addSelectedRepo = null;
    addRepos = [];
    showAddStep("repo");
    document.getElementById("add-repo-q").value = "";
    document.getElementById("add-repo-q").focus();
    loadAddRepos();
  }
}

function showAddStep(step) {
  document.getElementById("add-step-repo").classList.toggle("hidden", step !== "repo");
  document.getElementById("add-step-branch").classList.toggle("hidden", step !== "branch");
  document.getElementById("add-step-newrepo").classList.toggle("hidden", step !== "newrepo");
}

function closeAddForm() {
  document.getElementById("add-workspace-form").classList.add("hidden");
  document.getElementById("add-repo-q").value = "";
  document.getElementById("add-branch-input").value = "";
  document.getElementById("add-newrepo-name").value = "";
  document.getElementById("add-newrepo-remote").value = "";
  addSelectedRepo = null;
  addRepos = [];
}

async function loadAddRepos() {
  const list = document.getElementById("add-repo-list");
  list.innerHTML = '<div class="add-loading">Loading...</div>';
  try {
    addRepos = await api("/api/github/repos");
    renderAddRepos(addRepos);
  } catch {
    addRepos = [];
    list.innerHTML = '<div class="add-loading">Type a repo name and press Enter.</div>';
  }
}

function filterAddRepos() {
  const q = document.getElementById("add-repo-q").value.toLowerCase();
  const filtered = q ? addRepos.filter((r) => r.name.toLowerCase().includes(q)) : addRepos;
  renderAddRepos(filtered, q);
}

function renderAddRepos(repos, q = "") {
  const list = document.getElementById("add-repo-list");
  if (!repos.length) {
    if (q) {
      list.innerHTML = `<div class="add-repo-item" data-add-repo="${esc(q)}"><span class="add-repo-name">${esc(q)}</span><span class="add-repo-badge new">use</span></div>`;
    } else {
      list.innerHTML = '<div class="add-loading">No repos found.</div>';
    }
    return;
  }
  list.innerHTML = repos.map((r) =>
    `<div class="add-repo-item" data-add-repo="${esc(r.name)}">
      <span class="add-repo-name">${esc(r.name)}</span>
      ${r.cloned ? '<span class="add-repo-badge">cloned</span>' : ""}
    </div>`
  ).join("");
}

function selectAddRepo(name) {
  addSelectedRepo = name;
  document.getElementById("add-repo-label").textContent = name + "  /";
  document.getElementById("add-branch-input").value = "";
  showAddStep("branch");
  document.getElementById("add-branch-input").focus();
}

async function submitStartSession() {
  const branch = document.getElementById("add-branch-input").value.trim();
  if (!branch) { showToast("Branch name required."); return; }
  const btn = document.getElementById("btn-add-start");
  btn.disabled = true;
  try {
    await api("/api/sessions/new", { method: "POST", body: { repo: addSelectedRepo, branch } });
    closeAddForm();
    await refresh();
  } catch (err) {
    showToast("Error: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

async function submitCreateRepo() {
  const name = document.getElementById("add-newrepo-name").value.trim();
  if (!name) { showToast("Repo name required."); return; }
  const remoteUrl = document.getElementById("add-newrepo-remote").value.trim();
  const btn = document.getElementById("btn-add-createrepo");
  btn.disabled = true;
  try {
    await api("/api/repos/create", { method: "POST", body: { name, remoteUrl: remoteUrl || undefined } });
    closeAddForm();
    await refresh();
  } catch (err) {
    showToast("Error: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

// --- Navigation ---

function openDashboard() {
  chrome.windows.getCurrent((win) => {
    chrome.runtime.sendMessage({
      action: "switchToUrl",
      url: klaudiiUrls[0] || DEFAULT_KLAUDII_URL,
      windowId: win?.id,
    });
  });
}

// --- Inline settings panel ---

let settingsOpen = false;

function openSettings() {
  const panel = document.getElementById("settings-panel");
  const main = document.getElementById("main-content");
  const sortBar = document.querySelector(".sort-bar");
  const addForm = document.getElementById("add-workspace-form");

  settingsOpen = !settingsOpen;

  if (settingsOpen) {
    // Populate current values
    chrome.storage.sync.get(["klaudiiUrl", "klaudiiUrls", "openMode", "attentionFlash", "branchFirst"], (config) => {
      let urls = config.klaudiiUrls;
      if (!urls || !urls.length) urls = [config.klaudiiUrl || DEFAULT_KLAUDII_URL];
      document.getElementById("settings-urls").value = urls.join("\n");

      const mode = config.openMode || "inplace";
      const radio = document.querySelector(`input[name="settings-openMode"][value="${mode}"]`);
      if (radio) radio.checked = true;

      document.getElementById("settings-reuse-local-tab").checked = config.reuseLocalTab === true;
      document.getElementById("settings-branch-first").checked = config.branchFirst === true;
      document.getElementById("settings-attention-flash").checked = config.attentionFlash === true;
    });

    panel.classList.remove("hidden");
    main.classList.add("hidden");
    sortBar.classList.add("hidden");
    addForm.classList.add("hidden");
  } else {
    panel.classList.add("hidden");
    main.classList.remove("hidden");
    sortBar.classList.remove("hidden");
  }
}

function saveSettings() {
  const raw = document.getElementById("settings-urls").value;
  let urls = raw.split("\n").map((u) => u.trim().replace(/\/+$/, "")).filter(Boolean);
  if (!urls.length) urls.push(DEFAULT_KLAUDII_URL);

  const openModeVal = document.querySelector('input[name="settings-openMode"]:checked')?.value || "inplace";
  const reuseLocalTabVal = document.getElementById("settings-reuse-local-tab").checked;
  const branchFirstVal = document.getElementById("settings-branch-first").checked;
  const attentionFlashVal = document.getElementById("settings-attention-flash").checked;

  chrome.storage.sync.set({
    klaudiiUrls: urls,
    klaudiiUrl: urls[0],
    openMode: openModeVal,
    reuseLocalTab: reuseLocalTabVal,
    branchFirst: branchFirstVal,
    attentionFlash: attentionFlashVal,
  });

  // Apply locally immediately
  klaudiiUrls = urls;
  klaudiiUrl = urls[0];
  openMode = openModeVal;
  reuseLocalTab = reuseLocalTabVal;
  branchFirst = branchFirstVal;
  attentionFlash = attentionFlashVal;

  updateUI();
  refresh();
}

function initSettingsListeners() {
  // Auto-save on every change
  document.getElementById("settings-urls").addEventListener("change", saveSettings);
  document.querySelectorAll('input[name="settings-openMode"]').forEach((r) =>
    r.addEventListener("change", saveSettings)
  );
  document.getElementById("settings-reuse-local-tab").addEventListener("change", saveSettings);
  document.getElementById("settings-branch-first").addEventListener("change", saveSettings);
  document.getElementById("settings-attention-flash").addEventListener("change", saveSettings);

  // Test connection
  document.getElementById("btn-settings-test").addEventListener("click", async () => {
    const raw = document.getElementById("settings-urls").value;
    let urls = raw.split("\n").map((u) => u.trim().replace(/\/+$/, "")).filter(Boolean);
    if (!urls.length) urls.push(DEFAULT_KLAUDII_URL);

    const statusEl = document.getElementById("settings-status");
    statusEl.textContent = `Testing ${urls.length} server(s)...`;
    statusEl.className = "settings-status";

    const results = await Promise.allSettled(
      urls.map(async (url) => {
        const res = await fetch(url + "/api/health");
        const data = await res.json();
        if (!data.ok) throw new Error("health check failed");
        return { url, data };
      })
    );

    const ok = results.filter((r) => r.status === "fulfilled").map((r) => r.value);

    if (ok.length === urls.length) {
      const details = ok.map(({ url, data }) => {
        const parts = [data.tmux && "tmux", data.ttyd && "ttyd"].filter(Boolean).join(", ");
        return `${url} ok${parts ? ` (${parts})` : ""}`;
      }).join("; ");
      statusEl.textContent = details;
      statusEl.className = "settings-status ok";
    } else if (ok.length > 0) {
      statusEl.textContent = `${ok.length}/${urls.length} reachable.`;
      statusEl.className = "settings-status err";
    } else {
      statusEl.textContent = "Cannot reach any Klaudii server.";
      statusEl.className = "settings-status err";
    }
  });
}

// --- Toast notifications ---

function showToast(msg) {
  let toast = document.getElementById("toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";
    toast.style.cssText =
      "position:fixed;bottom:12px;left:12px;right:12px;padding:8px 12px;background:#3a1a1a;color:#f87171;border:1px solid #5a2a2a;border-radius:6px;font-size:11px;z-index:100;transition:opacity 0.3s";
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = "1";
  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// --- Helpers ---

function esc(str) {
  if (!str) return "";
  const el = document.createElement("span");
  el.textContent = str;
  return el.innerHTML;
}

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

// --- Start ---

init();
