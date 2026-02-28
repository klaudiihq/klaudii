const DEFAULT_KLAUDII_URL = "http://localhost:9876";
let klaudiiUrl = DEFAULT_KLAUDII_URL;
let pollTimer = null;
let lastSessions = [];
let lastProcs = [];
let activeTabUrl = null;

// --- Init ---

async function init() {
  const config = await chrome.storage.sync.get(["klaudiiUrl"]);
  klaudiiUrl = (config.klaudiiUrl || DEFAULT_KLAUDII_URL).replace(/\/+$/, "");

  document.getElementById("btn-dashboard").addEventListener("click", openDashboard);
  document.getElementById("btn-refresh").addEventListener("click", refresh);
  document.getElementById("btn-settings").addEventListener("click", openSettings);
  document.getElementById("btn-configure").addEventListener("click", openSettings);

  trackActiveTab();
  await refresh();
  pollTimer = setInterval(refresh, 5000);
}

// --- API ---

async function api(path, opts = {}) {
  const res = await fetch(klaudiiUrl + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// --- Data loading ---

async function refresh() {
  try {
    const [sessions, procs] = await Promise.all([
      api("/api/sessions"),
      api("/api/processes"),
    ]);
    lastSessions = sessions;
    lastProcs = procs;
    setConnected(true);
    renderSessions(sessions, procs);
    renderUnmanaged(procs);
  } catch {
    setConnected(false);
  }
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

// --- Track which claude.ai tab is active ---

function trackActiveTab() {
  updateActiveTabUrl();
  chrome.tabs.onActivated.addListener(() => updateActiveTabUrl());
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    if (changeInfo.url || changeInfo.status === "complete") updateActiveTabUrl();
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

// --- Render sessions ---

function renderSessions(sessions, procs) {
  const container = document.getElementById("sessions-container");

  if (!sessions.length) {
    container.innerHTML = `
      <div class="empty-state">
        <p>No workspaces configured.</p>
        <button class="btn primary btn-sm" onclick="openDashboard()">Open Dashboard</button>
      </div>`;
    return;
  }

  // Process stats lookup
  const procByProject = {};
  if (procs) {
    for (const p of procs) {
      if (p.managed && p.project) procByProject[p.project] = p;
    }
  }

  container.innerHTML = sessions.map((s) => renderCard(s, procByProject[s.project])).join("");
  highlightActiveSession();
}

function renderCard(s, proc) {
  const parts = s.project.split("--");
  const repo = parts[0];
  const branch = parts.length > 1 ? parts.slice(1).join("--") : null;
  const g = s.git;
  const gitBranch = g ? g.branch : branch;

  let gitBar = "";
  if (g) {
    const items = [];
    if (gitBranch) items.push(`<span class="git-branch">${esc(gitBranch)}</span>`);
    if (g.dirtyFiles) items.push(`<span class="git-dirty">${g.dirtyFiles} changed</span>`);
    else items.push(`<span class="git-clean">clean</span>`);
    if (g.unpushed) items.push(`<span class="git-unpushed">${g.unpushed} unpushed</span>`);
    gitBar = `<div class="git-bar">${items.join("")}</div>`;
  } else if (branch) {
    gitBar = `<div class="git-bar"><span class="git-branch">${esc(branch)}</span></div>`;
  }

  let stats = "";
  if (proc) {
    const parts = [`${proc.cpu}% cpu`, `${proc.memMB} MB`];
    if (proc.uptime) parts.push(esc(proc.uptime));
    stats = `<div class="proc-stats">${parts.join(" · ")}</div>`;
  }

  // Title used to rename the claude.ai conversation: "repo (branch)"
  const displayTitle = gitBranch ? `${repo} (${gitBranch})` : repo;

  let actions = "";
  if (s.running) {
    const openBtn = s.claudeUrl
      ? `<button class="btn success" data-action="open" data-url="${esc(s.claudeUrl)}" data-title="${esc(displayTitle)}">Open</button>`
      : "";
    actions = `
      ${openBtn}
      <button class="btn danger btn-sm" data-action="stop" data-project="${esc(s.project)}">Stop</button>
      <button class="btn btn-sm" data-action="restart" data-project="${esc(s.project)}">Restart</button>
      ${s.ttyd ? `<button class="btn btn-sm" data-action="terminal" data-port="${s.ttyd.port}">Term</button>` : ""}
      <button class="btn btn-sm" data-action="history" data-project="${esc(s.project)}">History</button>`;
  } else {
    actions = `
      <button class="btn primary" data-action="continue" data-project="${esc(s.project)}">Continue</button>
      <button class="btn btn-sm" data-action="start" data-project="${esc(s.project)}">New</button>
      <button class="btn btn-sm" data-action="history" data-project="${esc(s.project)}">History</button>`;
  }

  return `
    <div class="card" data-project="${esc(s.project)}" data-claude-url="${esc(s.claudeUrl || "")}">
      <div class="card-header">
        <span class="card-title">${esc(repo)}</span>
        <span class="card-status ${s.running ? "running" : "stopped"}">${s.running ? "running" : "stopped"}</span>
      </div>
      ${gitBar}
      ${stats}
      <div class="card-actions">${actions}</div>
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
    <div class="card freerange-card">
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
  const btn = e.target.closest("[data-action]");
  if (!btn) return;

  const action = btn.dataset.action;
  const project = btn.dataset.project;

  switch (action) {
    case "open":
      chrome.runtime.sendMessage({
        action: "navigateAndRename",
        url: btn.dataset.url,
        title: btn.dataset.title,
      });
      break;

    case "start":
      btn.disabled = true;
      try {
        await api("/api/sessions/start", { method: "POST", body: { project } });
      } catch (err) {
        showToast("Error: " + err.message);
      }
      setTimeout(refresh, 1000);
      break;

    case "continue":
      btn.disabled = true;
      try {
        await api("/api/sessions/start", { method: "POST", body: { project, continueSession: true } });
      } catch (err) {
        showToast("Error: " + err.message);
      }
      setTimeout(refresh, 1000);
      break;

    case "stop":
      btn.disabled = true;
      try {
        await api("/api/sessions/stop", { method: "POST", body: { project } });
      } catch (err) {
        showToast("Error: " + err.message);
      }
      refresh();
      break;

    case "restart":
      btn.disabled = true;
      try {
        await api("/api/sessions/restart", { method: "POST", body: { project } });
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
        await api("/api/sessions/start", {
          method: "POST",
          body: { project, resumeSessionId: btn.dataset.sessionId },
        });
      } catch (err) {
        showToast("Error: " + err.message);
      }
      setTimeout(refresh, 1000);
      break;

    case "kill":
      if (btn.dataset.armed) {
        try {
          await api("/api/processes/kill", { method: "POST", body: { pid: parseInt(btn.dataset.pid) } });
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
    const sessions = await api(`/api/history?project=${encodeURIComponent(project)}`);
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

// --- Navigation ---

function openDashboard() {
  chrome.runtime.sendMessage({ action: "openUrl", url: klaudiiUrl });
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
