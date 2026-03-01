const DEFAULT_KLAUDII_URL = "http://localhost:9876";
const KONNECT_ORIGIN = "https://konnect.klaudii.com";

const THEME_ICONS = {
  auto: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,
  light: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`,
  dark:  `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`,
};
let themeMode = "auto"; // "auto" | "light" | "dark"

const CLOUD_SVG = `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>`;

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

let pollTimer = null;
let approvalFastPollTimer = null;
let lastSessions = [];
let lastProcs = [];
let activeTabUrl = null;
let sortMode = localStorage.getItem("sortMode") || "activity";
let openMode = "inplace";
let attentionFlash = false;
let autoApprove = false;
let openTabs = new Map();       // urlPath (no query string) → tabId, for open claude.ai tabs in this window
let sessionNeedsInput = {};     // project → bool: session has a pending approval button
let sessionAutoApproved = {};   // project → bool: auto-approve just fired, show green flash
let addSelectedRepo = null; // repo name chosen in the add-workspace flow
let addRepos = [];          // cached list from /api/github/repos

// --- Init ---

async function init() {
  const config = await chrome.storage.sync.get(["klaudiiUrl", "klaudiiUrls", "openMode", "attentionFlash", "autoApprove", "themeMode"]);

  // Migrate from single klaudiiUrl to klaudiiUrls list
  if (config.klaudiiUrls && config.klaudiiUrls.length) {
    klaudiiUrls = config.klaudiiUrls;
  } else {
    klaudiiUrls = [(config.klaudiiUrl || DEFAULT_KLAUDII_URL).replace(/\/+$/, "")];
  }
  klaudiiUrl = klaudiiUrls[0];

  openMode = config.openMode || "inplace";
  attentionFlash = config.attentionFlash === true;
  autoApprove = config.autoApprove === true;
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
  document.getElementById("btn-configure").addEventListener("click", openSettings);

  const btnAutoApprove = document.getElementById("btn-auto-approve");
  btnAutoApprove.classList.toggle("active", autoApprove);
  btnAutoApprove.addEventListener("click", () => {
    autoApprove = !autoApprove;
    btnAutoApprove.classList.toggle("active", autoApprove);
    chrome.storage.sync.set({ autoApprove });
  });

  document.getElementById("btn-theme").addEventListener("click", () => {
    themeMode = themeMode === "auto" ? "dark" : themeMode === "dark" ? "light" : "auto";
    chrome.storage.sync.set({ themeMode });
    applyTheme();
  });

  // Sort toggle
  document.querySelectorAll(".sort-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      sortMode = btn.dataset.sort;
      localStorage.setItem("sortMode", sortMode);
      document.querySelectorAll(".sort-btn").forEach((b) =>
        b.classList.toggle("active", b.dataset.sort === sortMode)
      );
      renderSessions(lastSessions, lastProcs);
    });
  });
  document.querySelectorAll(".sort-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.sort === sortMode)
  );

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
    renderServerPicker();
    refresh();
  });

  renderServerPicker();
  trackActiveTab();
  await refresh();
  pollTimer = setInterval(refresh, 5000);

  // Non-blocking: discover Konnect servers after initial load
  fetchKonnectData();
}

// --- API ---

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
  renderServerPicker();
  renderKonnectWarning();
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
      return `<button class="server-picker-item${isSel ? " selected" : ""}" data-server-key="local:${i}">
        <span class="sp-name">${esc(short)}</span>
      </button>`;
    }).join("");
    html += `<div class="server-picker-section"><div class="server-picker-heading">Local</div>${items}</div>`;
  }

  // Only show Konnect servers that passed tunnel verification
  const verifiedKonnect = konnectServers.filter((s) => s.verified);
  if (verifiedKonnect.length) {
    const items = verifiedKonnect.map((srv) => {
      const isSel = selectedServer.type === "konnect" && selectedServer.id === srv.id;
      return `<button class="server-picker-item${isSel ? " selected" : ""}"
        data-server-key="konnect:${esc(srv.id)}">
        ${CLOUD_SVG}
        <span class="sp-name">${esc(srv.name)}</span>
        <span class="sp-dot online"></span>
      </button>`;
    }).join("");
    html += `<div class="server-picker-section"><div class="server-picker-heading">Kloud Konnect</div>${items}</div>`;
  } else if (konnectUser) {
    const msg = konnectErrors.length ? "No reachable servers" : "No servers paired";
    html += `<div class="server-picker-section"><div class="server-picker-heading">Kloud Konnect</div>
      <div class="server-picker-item" style="cursor:default;color:var(--text-dimmer)">${msg}</div>
    </div>`;
  }

  menu.innerHTML = html;
}

function renderKonnectWarning() {
  const el = document.getElementById("konnect-warning");
  if (!el) return;
  if (!konnectErrors.length) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  const names = konnectErrors.map((e) => e.name).join(", ");
  el.textContent = konnectErrors.length === 1
    ? `${names} unreachable`
    : `${konnectErrors.length} Konnect servers unreachable`;
  el.title = konnectErrors.map((e) => `${e.name}: ${e.error}`).join("\n");
  el.classList.remove("hidden");
}

// --- Data loading ---

async function refresh() {
  const allSessions = [];
  const allProcs = [];
  const seen = new Set(); // session IDs to deduplicate (same session reachable via local + Konnect)
  let anyOk = false;

  const fetchLocal = async (url) => {
    const [sessions, procs] = await Promise.all([
      api("/api/sessions", {}, url),
      api("/api/processes", {}, url),
    ]);
    for (const s of sessions) {
      const key = s.id || s.project;
      if (!seen.has(key)) {
        seen.add(key);
        allSessions.push({ ...s, _serverUrl: url });
      }
    }
    allProcs.push(...procs.map((p) => ({ ...p, _serverUrl: url })));
    anyOk = true;
  };

  const fetchKonnect = async (kSrv) => {
    const [sessions, procs] = await Promise.all([
      konnectApi(kSrv.id, "/api/sessions"),
      konnectApi(kSrv.id, "/api/processes"),
    ]);
    for (const s of sessions) {
      const key = s.id || s.project;
      if (!seen.has(key)) {
        seen.add(key);
        allSessions.push({ ...s, _konnectId: kSrv.id, _konnectName: kSrv.name });
      }
    }
    allProcs.push(...procs.map((p) => ({ ...p, _konnectId: kSrv.id, _konnectName: kSrv.name })));
    anyOk = true;
  };

  const tasks = [];
  if (selectedServer === "all") {
    for (const url of klaudiiUrls) tasks.push(fetchLocal(url));
    for (const kSrv of konnectServers.filter((s) => s.online)) tasks.push(fetchKonnect(kSrv));
  } else if (selectedServer.type === "local") {
    tasks.push(fetchLocal(selectedServer.url));
  } else if (selectedServer.type === "konnect") {
    const kSrv = konnectServers.find((s) => s.id === selectedServer.id);
    if (kSrv) tasks.push(fetchKonnect(kSrv));
  }

  if (tasks.length === 0) {
    // No servers configured yet
    setConnected(true);
    lastSessions = [];
    lastProcs = [];
    renderSessions([], [], false);
    renderUnmanaged([]);
    return;
  }

  await Promise.allSettled(tasks);

  if (!anyOk) {
    setConnected(false);
    return;
  }

  // Update project → session lookup for action routing
  sessionsByProject = {};
  for (const s of allSessions) sessionsByProject[s.project] = s;

  lastSessions = allSessions;
  lastProcs = allProcs;
  setConnected(true);
  const showServerBadge = allSessions.some((s) => s._konnectId) || klaudiiUrls.length > 1;
  renderSessions(allSessions, allProcs, showServerBadge);
  renderUnmanaged(allProcs);
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
        args: [autoApprove],
      });
      const result = results?.[0]?.result;
      if (result?.clicked) {
        if (!sessionAutoApproved[s.project]) {
          sessionAutoApproved[s.project] = true;
          renderSessions(lastSessions, lastProcs);
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
  if (changed) renderSessions(lastSessions, lastProcs);

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
      if (lastSessions.length) renderSessions(lastSessions, lastProcs);
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

  let gitBar = "";
  if (g) {
    const items = [];
    if (gitBranch) items.push(`${branchGitLink}<span class="git-branch">${esc(gitBranch)}</span>`);
    if (g.dirtyFiles) items.push(`<span class="git-dirty">${g.dirtyFiles} changed</span>`);
    else items.push(`<span class="git-clean">clean</span>`);
    if (g.unpushed) items.push(`<span class="git-unpushed">${g.unpushed} unpushed</span>`);
    gitBar = `<div class="git-bar">${items.join("")}</div>`;
  } else if (branch) {
    gitBar = `<div class="git-bar">${branchGitLink}<span class="git-branch">${esc(branch)}</span></div>`;
  }

  let stats = "";
  if (proc) {
    const statParts = [`${proc.cpu}% cpu`, `${proc.memMB} MB`];
    if (proc.uptime) statParts.push(esc(proc.uptime));
    stats = `<div class="proc-stats">${statParts.join(" · ")}</div>`;
  }

  const permBadge = `<span class="perm-badge perm-${mode}">${mode}</span>`;
  const permToggle = !isRunning ? `
    <div class="perm-toggle">
      <button class="perm-btn${mode === "yolo" ? " active perm-yolo" : ""}" data-action="set-perm" data-project="${esc(s.project)}" data-mode="yolo">Yolo</button>
      <button class="perm-btn${mode === "ask" ? " active perm-ask" : ""}" data-action="set-perm" data-project="${esc(s.project)}" data-mode="ask">Ask</button>
      <button class="perm-btn${mode === "strict" ? " active perm-strict" : ""}" data-action="set-perm" data-project="${esc(s.project)}" data-mode="strict">Strict</button>
    </div>` : "";

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

  let menuItems = "";
  if (isRunning) {
    menuItems = `
      <button class="menu-item danger" data-action="stop" data-project="${esc(s.project)}">Stop</button>
      <button class="menu-item" data-action="restart" data-project="${esc(s.project)}">Restart</button>
      ${s.ttyd ? `<button class="menu-item" data-action="terminal" data-port="${s.ttyd.port}">Terminal</button>` : ""}
      <button class="menu-item" data-action="history" data-project="${esc(s.project)}">History</button>`;
  } else {
    menuItems = `
      <button class="menu-item" data-action="start" data-project="${esc(s.project)}">New Session</button>
      <button class="menu-item" data-action="history" data-project="${esc(s.project)}">History</button>
      <button class="menu-item danger" data-action="remove" data-project="${esc(s.project)}">Remove</button>`;
  }

  return `
    <div class="card${attentionClass}" data-project="${esc(s.project)}" data-claude-url="${esc(s.claudeUrl || "")}" data-status="${status}" data-open-title="${esc(displayTitle)}">
      <div class="card-header">
        ${repoGitLink}<span class="card-title">${esc(repo)}</span>${serverBadge}
        ${inputDot}
        <div class="card-badges">
          ${permBadge}
          <span class="card-status ${status}">${status}</span>
        </div>
        <button class="card-menu-btn icon-btn" data-action="toggle-menu" data-project="${esc(s.project)}" title="Actions">···</button>
      </div>
      ${gitBar}
      ${stats}
      ${permToggle}
      <div class="card-menu hidden">
        ${menuItems}
      </div>
      <div class="history-list hidden" id="history-${esc(s.project)}"></div>
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

  // Close open card menus when clicking outside them
  if (!e.target.closest(".card-menu") && !e.target.closest("[data-action='toggle-menu']")) {
    document.querySelectorAll(".card-menu:not(.hidden)").forEach((m) => m.classList.add("hidden"));
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

    case "set-perm": {
      const mode = btn.dataset.mode;
      btn.closest(".perm-toggle").querySelectorAll(".perm-btn").forEach((b) => {
        b.classList.remove("active", "perm-yolo", "perm-ask", "perm-strict");
        if (b.dataset.mode === mode) b.classList.add("active", `perm-${mode}`);
      });
      btn.closest(".card").querySelector(".perm-badge").className = `perm-badge perm-${mode}`;
      btn.closest(".card").querySelector(".perm-badge").textContent = mode;
      try {
        await sessionApiCall(project, "/api/projects/permission", { method: "POST", body: { project, mode } });
      } catch (err) {
        showToast("Error: " + err.message);
        refresh();
      }
      break;
    }

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

    case "toggle-menu": {
      const card = btn.closest(".card");
      const menu = card?.querySelector(".card-menu");
      if (menu) menu.classList.toggle("hidden");
      break;
    }
  }
});

// --- Card body click → primary action ---

document.addEventListener("click", async (e) => {
  if (e.target.closest("button, a, input")) return;
  const card = e.target.closest(".card");
  if (!card) return;

  const status = card.dataset.status;
  const url = card.dataset.claudeUrl;
  const project = card.dataset.project;
  const title = card.dataset.openTitle;

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

function openSettings() {
  chrome.runtime.openOptionsPage();
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
