const API = "";
let refreshTimer = null;
let currentTerminalSession = null;
let lastHealthData = null;
let sortMode = localStorage.getItem("klaudii-sort") || "activity";
let sortDir = localStorage.getItem("klaudii-sort-dir") || "desc";
let openPanelProject = null;
let panelAutoCloseTimer = null;
let showWorkerWorkspaces = localStorage.getItem("klaudii-show-workers") === "true";
let workerDisplayMode = localStorage.getItem("klaudii-worker-mode") || "hide"; // "hide" | "show" | "auto-clean"

// --- SVG icon constants (matching extension) ---
const STAT_CPU_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>`;
const STAT_MEM_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><line x1="6" y1="12" x2="6" y2="12.01"/><line x1="10" y1="12" x2="10" y2="12.01"/><line x1="14" y1="12" x2="14" y2="12.01"/><line x1="18" y1="12" x2="18" y2="12.01"/></svg>`;
const STAT_CLOCK_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
const PENCIL_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>`;

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

const PERM_BADGE_LABELS = { yolo: "bypass", ask: "ask", strict: "plan" };
const PERM_MODE_LABELS = { yolo: "Bypass Permissions", ask: "Ask Permissions", strict: "Plan Mode" };

const CHAT_MODES = ["gemini", "claude-local", "claude-remote"];
const CHAT_MODE_LABELS = { "gemini": "Gemini", "claude-local": "Claude", "claude-remote": "Claude RC" };

function relativeTime(ts) {
  if (!ts) return null;
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function absoluteTime(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (sameDay) return time;
  const date = d.toLocaleDateString([], { month: "short", day: "numeric", ...(!sameYear && { year: "numeric" }) });
  return `${date}, ${time}`;
}

async function cycleChatMode(event, project) {
  event.stopPropagation();
  const card = document.getElementById(`card-${project}`);
  if (!card) return;
  const current = card.dataset.chatMode || "claude-local";
  const idx = CHAT_MODES.indexOf(current);
  const next = CHAT_MODES[(idx + 1) % CHAT_MODES.length];
  card.dataset.chatMode = next;
  const pill = card.querySelector(".chat-mode-pill");
  if (pill) {
    pill.dataset.mode = next;
    pill.className = `chat-mode-pill mode-${next}`;
    pill.innerHTML = `<span class="mode-dot"></span>${CHAT_MODE_LABELS[next]}`;
  }
  await fetch(`/api/workspace-state/${encodeURIComponent(project)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: next }),
  });
}

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return res.json();
}

// --- Sorting ---

function setSort(mode) {
  sortMode = mode;
  localStorage.setItem("klaudii-sort", mode);
  updateSortButtons();
  refresh();
}

function toggleSortDir() {
  sortDir = sortDir === "desc" ? "asc" : "desc";
  localStorage.setItem("klaudii-sort-dir", sortDir);
  updateSortButtons();
  refresh();
}

function updateSortButtons() {
  document.querySelectorAll(".sort-btn").forEach((b) => b.classList.remove("active"));
  const active = document.getElementById(`sort-${sortMode}`);
  if (active) active.classList.add("active");
  const dirBtn = document.getElementById("sort-dir-btn");
  if (dirBtn) {
    dirBtn.innerHTML = sortDir === "desc"
      ? `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>`
      : `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>`;
    dirBtn.title = sortDir === "desc" ? "Newest first" : "Oldest first";
  }
}

function sortSessions(sessions) {
  const dir = sortDir === "asc" ? 1 : -1;
  return [...sessions].sort((a, b) => {
    if (sortMode === "alpha") {
      return dir * a.project.localeCompare(b.project);
    }
    const ta = a.lastActivity || (a.tmux && a.tmux.created ? a.tmux.created * 1000 : 0);
    const tb = b.lastActivity || (b.tmux && b.tmux.created ? b.tmux.created * 1000 : 0);
    return dir * (ta - tb);
  });
}

// --- Rendering ---

function toggleWorkerWorkspaces() {
  showWorkerWorkspaces = !showWorkerWorkspaces;
  localStorage.setItem("klaudii-show-workers", showWorkerWorkspaces);
  updateWorkerToggle();
  refresh();
}

function updateWorkerToggle() {
  const btn = document.getElementById("worker-toggle");
  if (btn) {
    btn.classList.toggle("active", showWorkerWorkspaces);
    btn.title = showWorkerWorkspaces ? "Showing worker workspaces" : "Worker workspaces hidden";
  }
}

function renderSessions(sessions, procs) {
  const container = document.getElementById("sessions-list");
  updateSortButtons();
  updateWorkerToggle();

  // Filter out worker workspaces unless toggle is on
  const workerCount = sessions.filter(s => s.workspaceType === "worker").length;
  if (!showWorkerWorkspaces) {
    sessions = sessions.filter(s => s.workspaceType !== "worker");
  }
  // Show/hide worker toggle based on whether any exist
  const workerToggle = document.getElementById("worker-toggle");
  if (workerToggle) workerToggle.classList.toggle("hidden", workerCount === 0);

  if (!sessions.length) {
    container.innerHTML = '<p style="color:#666">No workspaces configured.</p>';
    return;
  }

  sessions = sortSessions(sessions);

  // Build a lookup of managed process stats by project name
  const procByProject = {};
  if (procs) {
    for (const p of procs) {
      if (p.managed && p.project) procByProject[p.project] = p;
    }
  }

  container.innerHTML = sessions.map((s) => {
    const parts = s.project.split("--");
    const repo = parts[0];
    const branch = parts.length > 1 ? parts.slice(1).join("--") : null;
    const sessionData = esc(JSON.stringify(s).replace(/'/g, "&#39;"));
    const proc = procByProject[s.project];
    const mode = s.permissionMode || "yolo";
    const g = s.git;
    const gitBranch = g ? g.branch : branch;
    const ghUrl = s.remoteUrl || null;
    const status = s.status || (s.running ? "running" : "stopped");
    const isRunning = status === "running" || status === "exited";
    const displayStatus = (status === "stopped" && s.relayActive) ? "running" : status;

    // Git links
    const repoLink = ghUrl
      ? `<a href="${esc(ghUrl)}" target="_blank" class="card-repo-link">${esc(repo)}</a>`
      : `<span class="card-repo-link">${esc(repo)}</span>`;
    const branchLink = gitBranch
      ? (ghUrl ? `<a href="${esc(ghUrl + "/tree/" + gitBranch)}" target="_blank" class="card-branch-link">${esc(gitBranch)}</a>` : `<span class="card-branch-link">${esc(gitBranch)}</span>`)
      : "";

    // Git status row
    let gitBar = "";
    if (g) {
      const items = [];
      if (g.dirtyFiles) {
        items.push(`<span class="git-dirty" onclick="openGitStatus('${esc(s.project)}')">${g.dirtyFiles} file${g.dirtyFiles === 1 ? "" : "s"} touched</span>`);
      } else {
        items.push(`<span class="git-clean">${esc(cleanPhrase(s.project))}</span>`);
      }
      if (g.unpushed) items.push(`<span class="git-unpushed">${g.unpushed} unpushed</span>`);
      gitBar = `<div class="git-bar">${items.join("")}</div>`;
    }

    // Permission badge (shown when running)
    const permBadge = isRunning ? `<span class="perm-badge perm-${mode}">${PERM_BADGE_LABELS[mode] || mode}</span>` : "";

    // Process stats with SVG icons + pencil edit button
    const editBtn = `<button class="card-edit-btn" onclick="toggleActionPanel('${esc(s.project)}')" title="Options">${PENCIL_SVG}</button>`;
    let statsRow = "";
    if (proc) {
      const statParts = [];
      statParts.push(`<span class="proc-stat">${STAT_CPU_SVG} ${proc.cpu}%</span>`);
      statParts.push(`<span class="proc-stat">${STAT_MEM_SVG} ${proc.memMB} MB</span>`);
      if (proc.uptime) statParts.push(`<span class="proc-stat">${STAT_CLOCK_SVG} ${esc(proc.uptime)}</span>`);
      if (s.sessionCount) statParts.push(`<span class="proc-stat">${s.sessionCount} session${s.sessionCount === 1 ? "" : "s"}</span>`);
      statsRow = `<div class="proc-stats">${statParts.join("")}${editBtn}</div>`;
    } else {
      const extraStats = [];
      if (s.sessionCount) extraStats.push(`<span class="proc-stat">${s.sessionCount} session${s.sessionCount === 1 ? "" : "s"}</span>`);
      statsRow = `<div class="proc-stats">${extraStats.join("")}${editBtn}</div>`;
    }

    // Inline action panel
    let panelItems = "";
    if (status === "running") {
      panelItems = `
        ${s.claudeUrl ? `<a class="btn btn-sm success" href="${esc(s.claudeUrl)}" target="_blank">Open</a>` : ""}
        <button class="btn btn-sm danger" onclick="stopSession('${esc(s.project)}')">Stop</button>
        <button class="btn btn-sm" onclick="restartSession('${esc(s.project)}')">Restart</button>
        ${s.ttyd ? `<button class="btn btn-sm" onclick='openTerminal(${s.ttyd.port}, ${sessionData})'>Terminal</button>` : ""}
        <button class="btn btn-sm" onclick="toggleHistory('${esc(s.project)}')">History</button>`;
    } else if (status === "exited") {
      panelItems = `
        <button class="btn btn-sm primary" onclick="restartSession('${esc(s.project)}')">Restart</button>
        <button class="btn btn-sm danger" onclick="stopSession('${esc(s.project)}')">Clean up</button>
        ${s.ttyd ? `<button class="btn btn-sm" onclick='openTerminal(${s.ttyd.port}, ${sessionData})'>Terminal</button>` : ""}
        <button class="btn btn-sm" onclick="toggleHistory('${esc(s.project)}')">History</button>`;
    } else {
      const modeOptions = Object.entries(PERM_MODE_LABELS).map(([val, label]) =>
        `<option value="${val}"${val === mode ? " selected" : ""}>${label}</option>`
      ).join("");
      panelItems = `
        <div class="panel-mode-row">
          <span class="panel-mode-label">Startup Mode</span>
          <select class="mode-select" onchange="setPermission('${esc(s.project)}', this.value)">
            ${modeOptions}
          </select>
        </div>
        <button class="btn btn-sm primary" onclick="startSession('${esc(s.project)}', {continueSession:true})">Continue</button>
        <button class="btn btn-sm" onclick="startSession('${esc(s.project)}')">New Session</button>
        <button class="btn btn-sm" onclick="toggleHistory('${esc(s.project)}')">History</button>
        <button class="btn btn-sm danger" onclick="removeWorkspace(this, '${esc(s.project)}', ${!!(g && (g.dirtyFiles || g.unpushed))})">Remove</button>`;
    }

    const isPanelOpen = openPanelProject === s.project;

    // Chat mode pill
    const chatMode = s.chatMode || "claude-local";
    const chatActive = !!s.chatActive;
    const modePill = `<button class="chat-mode-pill mode-${esc(chatMode)}${chatActive ? " streaming" : ""}" data-mode="${esc(chatMode)}" onclick="cycleChatMode(event, '${esc(s.project)}')" title="Chat mode — click to change">${chatActive ? '<span class="mode-pulse"></span>' : '<span class="mode-dot"></span>'}${esc(CHAT_MODE_LABELS[chatMode] || chatMode)}</button>`;

    // Activity timestamp row
    const lastAct = s.lastActivity ? absoluteTime(s.lastActivity) : null;
    const activityRow = lastAct ? `<div class="remote-timing">${lastAct}</div>` : "";

    const isWorker = s.workspaceType === "worker";

    return `
    <div class="card${isWorker ? " worker-card" : ""}" id="card-${esc(s.project)}" data-project="${esc(s.project)}" data-chat-mode="${esc(chatMode)}" data-project-path="${esc(s.projectPath || "")}" data-claude-url="${esc(s.claudeUrl || "")}">
      <div class="card-accent ${status}"></div>
      <div class="card-body">
        <div class="card-header">
          <div class="card-names">
            <span class="card-title">${repoLink}</span>
            ${branchLink ? `<span class="card-subtitle">${branchLink}</span>` : ""}
          </div>
          <div class="card-badges">
            ${isWorker ? '<span class="worker-badge">worker</span>' : ""}
            ${modePill}
            ${permBadge}
            <span class="card-status ${displayStatus}">${displayStatus}</span>
          </div>
        </div>
        ${activityRow}
        ${gitBar}
        ${statsRow}
        <div class="card-actions-panel${isPanelOpen ? "" : " hidden"}" id="panel-${esc(s.project)}">
          ${panelItems}
        </div>
        <div class="history-list hidden" id="history-${esc(s.project)}"></div>
      </div>
    </div>`;
  }).join("");
}

function toggleActionPanel(project) {
  // Close previously open panel if different
  if (openPanelProject && openPanelProject !== project) {
    const prev = document.getElementById(`panel-${openPanelProject}`);
    if (prev) prev.classList.add("hidden");
  }
  clearTimeout(panelAutoCloseTimer);

  const panel = document.getElementById(`panel-${project}`);
  if (!panel) return;

  const isHidden = panel.classList.toggle("hidden");
  openPanelProject = isHidden ? null : project;

  // Auto-close after 15 seconds
  if (!isHidden) {
    panelAutoCloseTimer = setTimeout(() => {
      panel.classList.add("hidden");
      if (openPanelProject === project) openPanelProject = null;
    }, 15000);
  }
}

// --- Actions ---

async function startSession(project, opts = {}) {
  const card = document.getElementById(`card-${project}`);
  if (card) card.querySelectorAll(".btn").forEach(b => { b.disabled = true; });

  try {
    const body = { project };
    if (opts.resumeSessionId) body.resumeSessionId = opts.resumeSessionId;
    else if (opts.continueSession) body.continueSession = true;
    const result = await api("/api/sessions/start", { method: "POST", body });
    if (result.error) alert("Error: " + result.error);
  } catch (err) {
    alert("Failed to start: " + err.message);
  }
  setTimeout(refresh, 1000);
}

async function stopSession(project) {
  await api("/api/sessions/stop", { method: "POST", body: { project } });
  closeTerminal();
  refresh();
}

async function setPermission(project, mode) {
  await api("/api/projects/permission", { method: "POST", body: { project, mode } });
  refresh();
}

async function restartSession(project) {
  closeTerminal();
  await api("/api/sessions/restart", { method: "POST", body: { project } });
  setTimeout(refresh, 1000);
}

function resumeSession(sessionId, project) {
  if (project) startSession(project, { resumeSessionId: sessionId });
}

// --- Git status modal ---

function openGitStatus(project) {
  const modal = document.getElementById("git-status-modal");
  const title = document.getElementById("git-status-title");
  const body = document.getElementById("git-status-body");

  title.textContent = project;
  body.innerHTML = '<p style="color:#666">Loading...</p>';
  modal.classList.remove("hidden");

  // Find the session data from last refresh
  api("/api/sessions").then((sessions) => {
    const s = sessions.find((x) => x.project === project);
    if (!s || !s.git) {
      body.innerHTML = '<p style="color:#666">No git info available.</p>';
      return;
    }
    const g = s.git;
    const parts = project.split("--");
    const repo = parts[0];

    let html = `<div class="git-detail-header">`;
    html += `<span class="git-detail-branch">${esc(g.branch || "unknown")}</span>`;
    if (g.unpushed) {
      html += ` <span class="git-unpushed">${g.unpushed} unpushed commit${g.unpushed > 1 ? "s" : ""}</span>`;
    }
    html += `</div>`;

    if (!g.files || !g.files.length) {
      html += '<p style="color:#4ade80;font-size:0.85rem;margin-top:0.75rem">Working tree clean</p>';
    } else {
      html += `<div class="git-file-list">`;
      for (const f of g.files) {
        const statusClass = f.status === "?" ? "untracked" : f.status === "M" ? "modified" : f.status === "A" ? "added" : f.status === "D" ? "deleted" : "other";
        html += `<div class="git-file ${statusClass}"><span class="git-file-status">${esc(f.status)}</span><span class="git-file-path">${esc(f.path)}</span></div>`;
      }
      html += `</div>`;
    }

    body.innerHTML = html;
  });
}

function closeGitStatus() {
  document.getElementById("git-status-modal").classList.add("hidden");
}

function closeGitStatusBackdrop(event) {
  if (event.target === event.currentTarget) closeGitStatus();
}

// --- Setup overlay ---

function openSetupOverlay() {
  const overlay = document.getElementById("setup-overlay");
  const frame   = document.getElementById("setup-frame");
  frame.src = "/setup.html";
  overlay.classList.remove("hidden");
}

function closeSetupOverlay(e) {
  // Close on backdrop click (not on the iframe itself)
  if (e && e.target !== document.getElementById("setup-overlay")) return;
  _dismissSetupOverlay();
}

function _dismissSetupOverlay() {
  const overlay = document.getElementById("setup-overlay");
  const frame   = document.getElementById("setup-frame");
  overlay.classList.add("hidden");
  frame.src = "";
  refresh(); // re-check health after install
}

// Listen for setup-complete message from the iframe
window.addEventListener("message", (e) => {
  if (e.data && e.data.type === "setup-complete") _dismissSetupOverlay();
});

// --- Terminal overlay ---

function openTerminal(port, session) {
  currentTerminalSession = session;
  const host = window.location.hostname;
  const url = `http://${host}:${port}`;

  const parts = session.project.split("--");
  const repo = parts[0];
  const branch = parts.length > 1 ? parts.slice(1).join("--") : null;

  document.getElementById("terminal-title").innerHTML =
    esc(repo) + (branch ? ` <span class="branch">(${esc(branch)})</span>` : "");

  const actions = document.getElementById("terminal-bar-actions");
  actions.innerHTML = `
    ${session.claudeUrl ? `<a class="btn success btn-sm" href="${esc(session.claudeUrl)}" target="_blank">Open</a>` : ""}
    <button class="btn danger btn-sm" onclick="stopSession('${esc(session.project)}')">Stop</button>
    <button class="btn primary btn-sm" onclick="restartSession('${esc(session.project)}')">Restart</button>
    <button class="btn btn-sm" onclick="closeTerminal()">Close</button>
  `;

  // Replace iframe to avoid beforeunload dialog from previous ttyd session
  const overlay = document.getElementById("terminal-overlay");
  const oldFrame = document.getElementById("terminal-frame");
  if (oldFrame) oldFrame.remove();
  const frame = document.createElement("iframe");
  frame.id = "terminal-frame";
  frame.src = url;
  overlay.appendChild(frame);
  overlay.classList.remove("hidden");
}

function closeTerminal() {
  currentTerminalSession = null;
  // Remove iframe entirely to avoid beforeunload dialog
  const frame = document.getElementById("terminal-frame");
  if (frame) frame.remove();
  document.getElementById("terminal-overlay").classList.add("hidden");
}

// --- Workspace removal ---

async function removeWorkspace(btn, project, isDirty) {
  // Dirty workspace: force them to see git status first
  if (isDirty) {
    openGitStatusForRemoval(project);
    return;
  }

  // Clean workspace: two-step inline confirm
  if (btn.dataset.armed) {
    btn.textContent = "Removing...";
    btn.disabled = true;
    try {
      const result = await api("/api/projects/remove", { method: "POST", body: { project } });
      if (result.error) {
        alert("Error: " + result.error);
      } else {
        refresh();
        return;
      }
    } catch (err) {
      alert("Failed: " + err.message);
    }
    btn.textContent = "Remove";
    btn.disabled = false;
    delete btn.dataset.armed;
    return;
  }

  btn.dataset.armed = "1";
  btn.textContent = "Confirm?";
  btn.classList.replace("danger", "warning");
  setTimeout(() => {
    if (btn.isConnected) {
      delete btn.dataset.armed;
      btn.textContent = "Remove";
      btn.classList.replace("warning", "danger");
    }
  }, 3000);
}

function openGitStatusForRemoval(project) {
  const modal = document.getElementById("git-status-modal");
  const title = document.getElementById("git-status-title");
  const body = document.getElementById("git-status-body");

  title.textContent = project;
  body.innerHTML = '<p style="color:#666">Loading...</p>';
  modal.classList.remove("hidden");

  api("/api/sessions").then((sessions) => {
    const s = sessions.find((x) => x.project === project);
    if (!s || !s.git) {
      body.innerHTML = '<p style="color:#666">No git info available.</p>';
      return;
    }
    const g = s.git;

    let html = `<div class="git-detail-header">`;
    html += `<span class="git-detail-branch">${esc(g.branch || "unknown")}</span>`;
    if (g.unpushed) {
      html += ` <span class="git-unpushed">${g.unpushed} unpushed commit${g.unpushed > 1 ? "s" : ""}</span>`;
    }
    html += `</div>`;

    if (g.files && g.files.length) {
      html += `<div class="git-file-list">`;
      for (const f of g.files) {
        const statusClass = f.status === "?" ? "untracked" : f.status === "M" ? "modified" : f.status === "A" ? "added" : f.status === "D" ? "deleted" : "other";
        html += `<div class="git-file ${statusClass}"><span class="git-file-status">${esc(f.status)}</span><span class="git-file-path">${esc(f.path)}</span></div>`;
      }
      html += `</div>`;
    }

    html += `<div style="margin-top:1rem;padding-top:0.75rem;border-top:1px solid #3a1a1a">`;
    html += `<p style="color:#f87171;font-size:0.85rem;margin-bottom:0.75rem">`;
    html += `This workspace has `;
    const warnings = [];
    if (g.dirtyFiles) warnings.push(`${g.dirtyFiles} uncommitted change${g.dirtyFiles > 1 ? "s" : ""}`);
    if (g.unpushed) warnings.push(`${g.unpushed} unpushed commit${g.unpushed > 1 ? "s" : ""}`);
    html += warnings.join(" and ");
    html += ` that will be lost.</p>`;
    html += `<button class="btn danger" onclick="confirmForceRemove(this, '${esc(project)}')">Remove anyway</button>`;
    html += `</div>`;

    body.innerHTML = html;
  });
}

async function confirmForceRemove(btn, project) {
  if (btn.dataset.armed) {
    btn.textContent = "Removing...";
    btn.disabled = true;
    try {
      const result = await api("/api/projects/remove", { method: "POST", body: { project, force: true } });
      if (result.error) {
        alert("Error: " + result.error);
      } else {
        closeGitStatus();
        refresh();
      }
    } catch (err) {
      alert("Failed: " + err.message);
    }
    return;
  }
  btn.dataset.armed = "1";
  btn.textContent = "Confirm removal?";
  btn.classList.replace("danger", "warning");
  setTimeout(() => {
    if (btn.isConnected) {
      delete btn.dataset.armed;
      btn.textContent = "Remove anyway";
      btn.classList.replace("warning", "danger");
    }
  }, 4000);
}

// --- Per-workspace history ---

async function toggleHistory(project) {
  const container = document.getElementById(`history-${project}`);
  if (!container) return;

  if (!container.classList.contains("hidden")) {
    container.classList.add("hidden");
    return;
  }

  container.innerHTML = '<p style="color:#666;font-size:0.8rem;padding:0.5rem 0">Loading...</p>';
  container.classList.remove("hidden");

  try {
    const sessions = await api(`/api/history?project=${encodeURIComponent(project)}`);
    if (!sessions.length) {
      container.innerHTML = '<p style="color:#666;font-size:0.8rem;padding:0.5rem 0">No recent sessions.</p>';
      return;
    }
    container.innerHTML = sessions
      .map(
        (s) => `
      <div class="history-item">
        <span class="history-display">${esc(s.display || "(no message)")}</span>
        <div class="history-meta">
          <span class="history-time">${formatTime(s.timestamp)}</span>
          <span class="history-id">${s.sessionId.slice(0, 8)}</span>
          <button class="btn btn-sm" onclick="resumeSession('${esc(s.sessionId)}', '${esc(project)}')">Resume</button>
        </div>
      </div>
    `
      )
      .join("");
  } catch {
    container.innerHTML = '<p style="color:#f87171;font-size:0.8rem;padding:0.5rem 0">Failed to load history.</p>';
  }
}

// --- Unmanaged Processes ---

function renderProcesses(procs) {
  const section = document.getElementById("unmanaged-section");
  const container = document.getElementById("unmanaged-list");
  const unmanaged = procs.filter((p) => !p.managed);

  if (!unmanaged.length) {
    section.classList.add("hidden");
    return;
  }

  section.classList.remove("hidden");
  container.innerHTML = unmanaged
    .map(
      (p) => `
    <div class="card freerange-card">
      <div class="freerange-top">
        <span class="freerange-pid">pid ${p.pid}${p.launchedBy ? ` <span class="freerange-from">via ${esc(p.launchedBy)}</span>` : ""}</span>
        <span class="freerange-stats">${p.cpu}% cpu &middot; ${p.memMB} MB${p.uptime ? ` &middot; ${esc(p.uptime)}` : ""}</span>
      </div>
      ${p.cwd ? `<div class="freerange-cwd">${esc(p.cwd)}</div>` : ""}
      <div class="freerange-bottom">
        <button class="btn danger btn-sm" onclick="confirmKill(this, ${p.pid})">Kill</button>
      </div>
    </div>
  `
    )
    .join("");
}

function confirmKill(btn, pid) {
  if (btn.dataset.armed) {
    api("/api/processes/kill", { method: "POST", body: { pid } }).then(refresh);
    btn.textContent = "Killing...";
    btn.disabled = true;
    return;
  }
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

// --- Data loading ---

async function refresh() {
  try {
    const [health, sessions, procs] = await Promise.all([
      api("/api/health"),
      api("/api/sessions"),
      api("/api/processes"),
    ]);

    lastHealthData = health;
    const badge = document.getElementById("status-badge");

    if (health.ok && health.tmux && health.ttyd) {
      badge.textContent = "connected";
      badge.className = "badge ok";
    } else {
      const missing = [];
      if (!health.tmux) missing.push("tmux");
      if (!health.ttyd) missing.push("ttyd");
      badge.className = "badge missing";
      badge.innerHTML = `<span class="missing-label">missing:</span>` +
        missing.map(d => `<span class="dep-missing-pill" onclick="openSetupOverlay()">${esc(d)}</span>`).join("");
    }

    // Auth status box
    const authEl = document.getElementById("auth-status");
    const authRows = [];
    if (health.ghAuth) {
      if (health.ghAuth.loggedIn) {
        authRows.push(`<span class="auth-row ok" title="${esc(health.ghAuth.account)}"><span class="auth-dot ok"></span>GitHub</span>`);
      } else {
        authRows.push('<span class="auth-row error" title="Run: gh auth login"><span class="auth-dot error"></span>GitHub</span>');
      }
    }
    if (health.claudeAuth) {
      if (health.claudeAuth.loggedIn) {
        const label = health.claudeAuth.email ? esc(health.claudeAuth.email) : (health.claudeAuth.authMethod === "api_key" ? "API key" : "authenticated");
        authRows.push(`<span class="auth-row ok" title="${label}"><span class="auth-dot ok"></span>Claude</span>`);
      } else {
        authRows.push('<span class="auth-row error" title="Run: claude auth login"><span class="auth-dot error"></span>Claude</span>');
      }
    } else if (health.claudeAuth === null) {
      authRows.push('<span class="auth-row error" title="Claude CLI not installed"><span class="auth-dot error"></span>Claude</span>');
    }
    if (health.geminiAuth) {
      if (!health.geminiAuth.installed) {
        authRows.push('<span class="auth-row error" title="Run: brew install gemini-cli"><span class="auth-dot error"></span>Gemini</span>');
      } else if (health.geminiAuth.loggedIn) {
        const geminiTitle = health.geminiAuth.email ? esc(health.geminiAuth.email) : (health.geminiAuth.method === "api_key" ? "API key" : "OAuth");
        authRows.push(`<span class="auth-row ok" title="${geminiTitle}"><span class="auth-dot ok"></span>Gemini</span>`);
      } else {
        authRows.push('<span class="auth-row error clickable" title="Click to authenticate" onclick="openGeminiChat(null, null)"><span class="auth-dot error"></span>Gemini</span>');
      }
    }
    authEl.innerHTML = (authRows.length ? '<span class="auth-title">auth</span>' : '') + authRows.join("");

    renderSessions(sessions, procs);
    renderProcesses(procs);
  } catch (err) {
    const badge = document.getElementById("status-badge");
    badge.textContent = "offline";
    badge.className = "badge error";
  }
}

// --- New Session Modal ---

let allRepos = [];
let selectedRepo = null;
let selectedRepoOwner = null;

async function openNewSessionModal() {
  selectedRepo = null;
  selectedRepoOwner = null;
  document.getElementById("branch-form").classList.add("hidden");
  document.getElementById("repo-search").value = "";
  document.getElementById("branch-input").value = "";
  showRepoSearchView();
  document.getElementById("new-session-modal").classList.remove("hidden");

  document.getElementById("repo-list").innerHTML = '<div style="padding:1rem;color:#666">Loading repos...</div>';
  try {
    allRepos = await api("/api/github/repos");
    renderRepoList(allRepos);
  } catch (err) {
    document.getElementById("repo-list").innerHTML = `<div style="padding:1rem;color:#f87171">Failed to load repos: ${esc(err.message)}</div>`;
  }
}

function showCreateRepoForm() {
  document.getElementById("repo-search-view").classList.add("hidden");
  document.getElementById("create-repo-view").classList.remove("hidden");
  document.getElementById("new-repo-name").value = "";
  document.getElementById("new-repo-remote").value = "";
  document.getElementById("new-repo-name").focus();
}

function showRepoSearchView() {
  document.getElementById("create-repo-view").classList.add("hidden");
  document.getElementById("repo-search-view").classList.remove("hidden");
}

function closeNewSessionModal() {
  document.getElementById("new-session-modal").classList.add("hidden");
}

function closeModal(event) {
  if (event.target === event.currentTarget) closeNewSessionModal();
}

function filterRepos() {
  const q = document.getElementById("repo-search").value.toLowerCase();
  const filtered = allRepos.filter((r) =>
    r.name.toLowerCase().includes(q) || (r.owner || "").toLowerCase().includes(q) || (r.description || "").toLowerCase().includes(q)
  );
  renderRepoList(filtered);
}

function renderRepoList(repos) {
  const container = document.getElementById("repo-list");
  if (!repos.length) {
    container.innerHTML = '<div style="padding:0.75rem;color:#666;font-size:0.85rem">No matching repos.</div>';
    return;
  }

  container.innerHTML = repos
    .map(
      (r) => `
    <div class="repo-item ${selectedRepo === r.name && selectedRepoOwner === r.owner ? "selected" : ""}" onclick="selectRepo('${esc(r.name)}', '${esc(r.owner || "")}')">
      <div>
        <div class="repo-name">${r.owner ? `<span class="repo-owner">${esc(r.owner)}/</span>` : ""}${esc(r.name)}</div>
        ${r.description ? `<div class="repo-desc">${esc(r.description)}</div>` : ""}
      </div>
      <div class="repo-badges">
        ${r.cloned ? '<span class="repo-badge cloned">cloned</span>' : ""}
        ${r.isPrivate ? '<span class="repo-badge private">private</span>' : ""}
      </div>
    </div>
  `
    )
    .join("");
}

function selectRepo(name, owner) {
  selectedRepo = name;
  selectedRepoOwner = owner || null;
  renderRepoList(allRepos.filter((r) => {
    const q = document.getElementById("repo-search").value.toLowerCase();
    return r.name.toLowerCase().includes(q) || (r.description || "").toLowerCase().includes(q);
  }));
  document.getElementById("branch-form").classList.remove("hidden");
  document.getElementById("branch-input").focus();
}

async function createNewSession() {
  if (!selectedRepo) return;

  const branch = document.getElementById("branch-input").value.trim();
  if (!branch) {
    alert("Please enter a branch name");
    return;
  }

  const btn = document.getElementById("create-session-btn");
  btn.disabled = true;
  btn.textContent = "Creating...";

  try {
    const result = await api("/api/sessions/new", {
      method: "POST",
      body: { repo: selectedRepo, owner: selectedRepoOwner, branch },
    });

    if (result.error) {
      alert("Error: " + result.error);
    } else {
      closeNewSessionModal();
      refresh();
    }
  } catch (err) {
    alert("Failed: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Start Session";
  }
}

async function createNewRepo() {
  const name = document.getElementById("new-repo-name").value.trim();
  if (!name) {
    alert("Please enter a repo name");
    return;
  }

  const remoteUrl = document.getElementById("new-repo-remote").value.trim();

  const btn = document.getElementById("create-repo-btn");
  btn.disabled = true;
  btn.textContent = "Creating...";

  try {
    const result = await api("/api/repos/create", {
      method: "POST",
      body: { name, remoteUrl: remoteUrl || undefined },
    });

    if (result.error) {
      alert("Error: " + result.error);
    } else {
      closeNewSessionModal();
      refresh();
    }
  } catch (err) {
    alert("Failed: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Create Repo";
  }
}

// --- Token usage chart ---

async function refreshUsage() {
  try {
    const data = await api("/api/usage");
    renderUsageChart(data);
  } catch {
    // Non-critical — silently ignore
  }
}

function renderUsageChart(data) {
  const section = document.getElementById("usage-section");
  if (!section || !data) return;

  // Handle both old format (array) and new format ({ buckets, rateLimits })
  const buckets = Array.isArray(data) ? data : (data.buckets || []);
  const rateLimits = Array.isArray(data) ? [] : (data.rateLimits || []);

  const now = Date.now();
  const totalTokens = buckets.reduce((sum, b) => sum + b.outputTokens, 0);
  const tokens4h = buckets.slice(-4).reduce((sum, b) => sum + b.outputTokens, 0);

  // Most recent rate limit event (any window)
  const recentLimit = rateLimits[0] || null;
  // Is there an active (not yet reset) rate limit?
  const activeLimitResetAt = recentLimit && recentLimit.resetAt && recentLimit.resetAt > now
    ? recentLimit.resetAt : null;

  if (totalTokens === 0 && !recentLimit) {
    section.classList.add("hidden");
    return;
  }
  section.classList.remove("hidden");

  // Total label
  document.getElementById("usage-total").textContent =
    formatTokens(totalTokens) + " tokens";

  // Rate limit status
  const statusEl = document.getElementById("usage-status");
  if (statusEl) {
    if (activeLimitResetAt) {
      const minsLeft = Math.max(1, Math.round((activeLimitResetAt - now) / 60000));
      statusEl.className = "usage-status limited";
      statusEl.textContent = `rate limited · resets in ${minsLeft}m`;
    } else if (recentLimit && recentLimit.resetAt && now - recentLimit.resetAt < 30 * 60000) {
      // Reset happened within the last 30 min
      statusEl.className = "usage-status ok";
      statusEl.textContent = `quota reset ${Math.round((now - recentLimit.resetAt) / 60000)}m ago`;
    } else if (recentLimit && now - recentLimit.timestamp < 4 * 3600000) {
      // Hit a limit within the last 4h but reset time unknown or already passed
      statusEl.className = "usage-status ok";
      statusEl.textContent = `4h: ${formatTokens(tokens4h)} tokens`;
    } else {
      statusEl.className = "usage-status ok";
      statusEl.textContent = `4h: ${formatTokens(tokens4h)} tokens`;
    }
  }

  if (!buckets.length) return;
  const maxTokens = Math.max(...buckets.map((b) => b.outputTokens));
  const W = 1000;
  const H = 48;
  const n = buckets.length;
  const barW = W / n;
  const gap = 2;
  const nowHour = Math.floor(now / 3600000) * 3600000;

  // Mark the hours covered by the most recent rate limit event
  const limitHour = recentLimit ? Math.floor(recentLimit.timestamp / 3600000) * 3600000 : null;

  const bars = buckets
    .map((b, i) => {
      const h = maxTokens > 0 ? Math.max(2, Math.round((b.outputTokens / maxTokens) * H)) : 0;
      const x = (i * barW + gap).toFixed(1);
      const w = Math.max(1, barW - gap * 2).toFixed(1);
      const y = (H - h).toFixed(1);
      const isCurrent = b.hour === nowHour;
      const wasLimited = b.hour === limitHour;
      const fill = wasLimited ? "#f87171" : isCurrent ? "#60a5fa" : "#2563eb";
      const time = new Date(b.hour).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const label = wasLimited
        ? `${time}: ${b.outputTokens.toLocaleString()} tokens (rate limited)`
        : `${time}: ${b.outputTokens.toLocaleString()} tokens`;
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" rx="1"><title>${label}</title></rect>`;
    })
    .join("");

  document.getElementById("usage-chart").innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:48px;display:block">${bars}</svg>`;
}

function formatTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return Math.round(n / 1000) + "K";
  return String(n);
}

// --- Helpers ---

function esc(str) {
  const el = document.createElement("span");
  el.textContent = str;
  return el.innerHTML;
}

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

// --- Kloud Konnect ---

// Format a dashed hex key into 4 groups per line for readability
function formatKeyForDisplay(key) {
  // Strip existing dashes, then re-group into chunks of 4, 4 per line
  const clean = key.replace(/-/g, "");
  const groups = clean.match(/.{1,4}/g) || [];
  const lines = [];
  for (let i = 0; i < groups.length; i += 4) {
    lines.push(groups.slice(i, i + 4).join("-"));
  }
  return lines.join("\n");
}

// The raw key (no line-breaks) for clipboard
function getRawKey() {
  const el = document.getElementById("konnection-key-display");
  return el ? el.textContent.replace(/\s/g, "").replace(/-/g, "-") : "";
}

async function copyKonnectionKey() {
  const key = getRawKey();
  try {
    await navigator.clipboard.writeText(key);
    const btn = document.getElementById("copy-key-btn");
    if (btn) { btn.textContent = "Copied!"; setTimeout(() => { btn.textContent = "Copy"; }, 2000); }
  } catch {
    // clipboard not available; key is already visible to select manually
  }
}

let cloudStatus = null;

async function refreshCloudStatus() {
  try {
    cloudStatus = await api("/api/cloud/status");
    const btn = document.getElementById("cloud-btn");
    if (!btn) return;
    if (cloudStatus.paired && cloudStatus.connected) {
      btn.textContent = "Kloud Konnect \u2022";
      btn.classList.add("cloud-connected");
    } else if (cloudStatus.paired) {
      btn.textContent = "Kloud Konnect \u25CB";
      btn.classList.remove("cloud-connected");
    } else {
      btn.textContent = "Kloud Konnect";
      btn.classList.remove("cloud-connected");
    }
  } catch {
    // Kloud endpoint not available
  }
}

function openCloudModal() {
  document.getElementById("cloud-modal").classList.remove("hidden");
  renderCloudModal();
}

function closeCloudModal() {
  document.getElementById("cloud-modal").classList.add("hidden");
}

function closeCloudBackdrop(e) {
  if (e.target.id === "cloud-modal") closeCloudModal();
}

async function renderCloudModal() {
  const body = document.getElementById("cloud-modal-body");

  if (!cloudStatus) {
    await refreshCloudStatus();
  }

  if (cloudStatus && cloudStatus.paired) {
    // Already paired — show status, QR code, and connection key
    const keyResp = await api("/api/cloud/connection-key").catch(() => null);
    body.innerHTML = `
      <div class="cloud-status">
        <div class="cloud-status-row">
          <span class="label">Status</span>
          <span class="badge ${cloudStatus.connected ? "running" : "stopped"}">${cloudStatus.connected ? "Konnected" : "Disconnected"}</span>
        </div>
        <div class="cloud-status-row">
          <span class="label">Server name</span>
          <span>${esc(cloudStatus.serverName || "—")}</span>
        </div>
        ${keyResp && keyResp.qrSvg ? `
        <div class="cloud-qr-section">
          <label>Scan to pair a browser</label>
          <div class="cloud-qr-code">${keyResp.qrSvg}</div>
          <div class="form-hint">Open konnect.klaudii.com on your phone or laptop and scan this QR code. It contains your Konnection Key — the relay never sees it.</div>
        </div>
        ` : ""}
        ${keyResp && keyResp.connectionKey ? `
        <details class="cloud-key-details">
          <summary>Konnection Key (copy &amp; paste)</summary>
          <div class="cloud-key-section">
            <div class="cloud-key-display mono" id="konnection-key-display" style="white-space:pre-wrap; line-height:1.6">${esc(formatKeyForDisplay(keyResp.connectionKey))}</div>
            <div style="display:flex; gap:0.5rem; margin-top:0.5rem; align-items:center">
              <button class="btn btn-sm" onclick="copyKonnectionKey()" id="copy-key-btn">Copy</button>
              <span class="form-hint" style="margin:0">Paste on konnect.klaudii.com if you can't scan the QR</span>
            </div>
          </div>
        </details>
        ` : ""}
        <div style="margin-top: 16px">
          <button class="btn danger" onclick="showUnpairConfirm()">Unpair</button>
          <div id="unpair-confirm" style="display:none" class="confirm-danger">
            <p>Disconnect from Kloud Konnect? You'll need to re-pair to restore remote access.</p>
            <div class="confirm-actions">
              <button class="btn danger btn-sm" onclick="confirmUnpair()">Yes, Unpair</button>
              <button class="btn btn-sm" onclick="document.getElementById('unpair-confirm').style.display='none'">Cancel</button>
            </div>
          </div>
        </div>
      </div>
    `;
  } else {
    // Not paired — show pairing form
    body.innerHTML = `
      <div class="cloud-pair-form">
        <p>Konnect this Klaudii server to the kloud so you can access it from anywhere.</p>
        <ol>
          <li>Go to <strong>konnect.klaudii.com</strong> and sign in</li>
          <li>Click <strong>Add Server</strong> to get a pairing code</li>
          <li>Enter the code below</li>
        </ol>
        <div class="form-group">
          <label>Pairing code</label>
          <input id="pairing-code-input" type="text" placeholder="XXX-XXX" maxlength="7" style="text-transform: uppercase; letter-spacing: 2px; font-size: 1.2em; text-align: center" />
        </div>
        <div class="form-group">
          <label>Server name <span class="form-hint-inline">(optional)</span></label>
          <input id="server-name-input" type="text" placeholder="e.g. My MacBook Pro" />
        </div>
        <div class="form-group">
          <label>Relay URL</label>
          <input id="relay-url-input" type="text" value="https://konnect.klaudii.com" />
        </div>
        <button class="btn primary" onclick="pairCloud()" id="pair-btn">Pair</button>
        <div id="pair-result" style="margin-top: 12px; display:none"></div>
      </div>
    `;
    document.getElementById("pairing-code-input").focus();
  }
}

function showPairError(msg) {
  const d = document.getElementById("pair-result");
  d.style.display = "block";
  d.innerHTML = `<div class="error-msg">${esc(msg)}</div>`;
}

async function pairCloud() {
  const code = document.getElementById("pairing-code-input").value.trim();
  const serverName = document.getElementById("server-name-input").value.trim() || undefined;
  const relayUrl = document.getElementById("relay-url-input").value.trim();

  if (!code) {
    showPairError("Enter the pairing code from konnect.klaudii.com");
    document.getElementById("pairing-code-input").focus();
    return;
  }

  const btn = document.getElementById("pair-btn");
  btn.disabled = true;
  btn.textContent = "Pairing...";
  document.getElementById("pair-result").style.display = "none";

  try {
    const result = await api("/api/cloud/pair", {
      method: "POST",
      body: { code, relayUrl, serverName },
    });

    if (result.error) {
      showPairError("Pairing failed: " + result.error);
      return;
    }

    // Fetch the QR code from the server (now that pairing is done)
    const keyResp = await api("/api/cloud/connection-key").catch(() => null);

    const resultDiv = document.getElementById("pair-result");
    resultDiv.style.display = "block";
    resultDiv.innerHTML = `
      <div class="cloud-key-section success">
        <h3>Konnected!</h3>
        ${keyResp && keyResp.qrSvg ? `
          <label>Scan this QR code on konnect.klaudii.com</label>
          <div class="cloud-qr-code">${keyResp.qrSvg}</div>
        ` : ""}
        <details open>
          <summary>Konnection Key (copy &amp; paste)</summary>
          <div class="cloud-key-display mono" id="konnection-key-display" style="white-space:pre-wrap; line-height:1.6; margin-top:0.5rem">${esc(formatKeyForDisplay(result.connectionKey))}</div>
          <button class="btn btn-sm" onclick="copyKonnectionKey()" id="copy-key-btn" style="margin-top:0.5rem">Copy Key</button>
        </details>
        <div class="form-hint" style="margin-top:0.5rem">Paste on konnect.klaudii.com → pair.html</div>
      </div>
    `;

    await refreshCloudStatus();
  } catch (err) {
    showPairError("Pairing failed: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Pair";
  }
}

function showUnpairConfirm() {
  document.getElementById("unpair-confirm").style.display = "block";
}

async function confirmUnpair() {
  await api("/api/cloud/unpair", { method: "POST" });
  cloudStatus = null;
  await refreshCloudStatus();
  renderCloudModal();
}

// --- Scheduler ---

let schedulerCollapsed = localStorage.getItem("klaudii-scheduler-collapsed") === "1";

function formatInterval(ms) {
  if (ms >= 3600000) {
    const h = ms / 3600000;
    return h === 1 ? "every 1 hour" : `every ${h} hours`;
  }
  if (ms >= 60000) {
    const m = ms / 60000;
    return m === 1 ? "every 1 min" : `every ${m} min`;
  }
  return `every ${ms / 1000}s`;
}

async function refreshScheduler() {
  try {
    const tasks = await api("/api/scheduler");
    renderScheduler(tasks);
  } catch {
    // Scheduler endpoint not available
  }
}

function renderScheduler(tasks) {
  const section = document.getElementById("scheduler-section");
  const container = document.getElementById("scheduler-list");
  if (!section || !container) return;

  if (!tasks || !tasks.length) {
    section.classList.add("hidden");
    return;
  }

  section.classList.remove("hidden");
  const toggle = document.getElementById("scheduler-toggle");
  if (toggle) toggle.textContent = schedulerCollapsed ? "Show" : "Hide";
  container.style.display = schedulerCollapsed ? "none" : "";

  container.innerHTML = tasks.map(t => {
    const statusBadge = t.running
      ? '<span class="scheduler-badge task-running">running</span>'
      : t.enabled
        ? '<span class="scheduler-badge enabled">enabled</span>'
        : '<span class="scheduler-badge disabled">disabled</span>';

    const lastRun = t.lastRunAt ? relativeTime(new Date(t.lastRunAt).getTime()) : "never";
    const lastResult = t.lastResult || "—";

    const errorRow = t.lastError
      ? `<div class="scheduler-card-error">Error: ${esc(t.lastError)}</div>`
      : "";

    const toggleBtn = t.enabled
      ? `<button class="btn btn-sm warning" onclick="schedulerPause('${esc(t.name)}')">Pause</button>`
      : `<button class="btn btn-sm success" onclick="schedulerResume('${esc(t.name)}')">Resume</button>`;

    return `
    <div class="card scheduler-card">
      <div class="scheduler-card-top">
        <span class="scheduler-card-name">${esc(t.name)}</span>
        <div class="scheduler-card-badges">${statusBadge}</div>
      </div>
      <div class="scheduler-card-info">
        <span>${esc(formatInterval(t.intervalMs))}</span>
        <span>last run: ${esc(lastRun)}</span>
        <span>result: ${esc(lastResult)}</span>
      </div>
      ${errorRow}
      <div class="scheduler-card-actions">
        ${toggleBtn}
        <button class="btn btn-sm primary" onclick="schedulerTrigger('${esc(t.name)}')"${t.running ? " disabled" : ""}>Trigger Now</button>
      </div>
    </div>`;
  }).join("");
}

function toggleSchedulerSection() {
  schedulerCollapsed = !schedulerCollapsed;
  localStorage.setItem("klaudii-scheduler-collapsed", schedulerCollapsed ? "1" : "0");
  const container = document.getElementById("scheduler-list");
  const toggle = document.getElementById("scheduler-toggle");
  if (container) container.style.display = schedulerCollapsed ? "none" : "";
  if (toggle) toggle.textContent = schedulerCollapsed ? "Show" : "Hide";
}

async function schedulerPause(name) {
  await api(`/api/scheduler/${encodeURIComponent(name)}/pause`, { method: "POST" });
  refreshScheduler();
}

async function schedulerResume(name) {
  await api(`/api/scheduler/${encodeURIComponent(name)}/resume`, { method: "POST" });
  refreshScheduler();
}

async function schedulerTrigger(name) {
  await api(`/api/scheduler/${encodeURIComponent(name)}/trigger`, { method: "POST" });
  setTimeout(refreshScheduler, 1000);
}

// --- Beads ---

let beadsCollapsed = localStorage.getItem("klaudii-beads-collapsed") === "1";
let beadFilter = "all";
let beadsData = [];
let expandedBeadId = null;

const PRIORITY_LABELS = ["P0", "P1", "P2", "P3", "P4"];

async function refreshBeads() {
  try {
    beadsData = await api("/api/beads");
    if (!Array.isArray(beadsData)) beadsData = [];
    renderBeads();
  } catch {
    // Beads endpoint not available
  }
}

function renderBeads() {
  const section = document.getElementById("beads-section");
  const container = document.getElementById("beads-list");
  if (!section || !container) return;

  if (!beadsData.length) {
    section.classList.add("hidden");
    return;
  }

  section.classList.remove("hidden");
  const toggle = document.getElementById("beads-toggle");
  if (toggle) toggle.textContent = beadsCollapsed ? "Show" : "Hide";
  document.getElementById("beads-toolbar").style.display = beadsCollapsed ? "none" : "";
  document.getElementById("beads-list").style.display = beadsCollapsed ? "none" : "";
  const form = document.getElementById("bead-form");
  if (beadsCollapsed && form) form.classList.add("hidden");

  const filtered = beadFilter === "all"
    ? beadsData
    : beadsData.filter(b => b.status === beadFilter);

  if (!filtered.length) {
    container.innerHTML = `<div style="padding:12px;color:var(--text-faint);font-size:12px;text-align:center">No beads matching "${beadFilter}"</div>`;
    return;
  }

  container.innerHTML = filtered.map(b => {
    const statusLabel = (b.status || "open").replace(/_/g, " ");
    const updated = b.updated_at ? relativeTime(new Date(b.updated_at).getTime()) : "";
    const assignee = b.assignee || "";
    const priority = PRIORITY_LABELS[b.priority] || `P${b.priority}`;
    const isExpanded = expandedBeadId === b.id;
    const descHtml = isExpanded && b.description
      ? `<div class="bead-desc-expanded">${esc(b.description)}</div>`
      : "";

    const closedOrBlocked = b.status === "closed" || b.status === "blocked";
    const actionBtns = closedOrBlocked ? "" : `
      <div class="bead-actions">
        <button class="btn btn-sm" onclick="beadSetStatus('${esc(b.id)}','blocked')" title="Block">Block</button>
        <button class="btn btn-sm success" onclick="beadSetStatus('${esc(b.id)}','closed')" title="Close">Close</button>
      </div>`;

    return `<div class="bead-row">
      <div class="bead-row-top">
        <span class="bead-id">${esc(b.id)}</span>
        <span class="bead-title" onclick="toggleBeadDesc('${esc(b.id)}')">${esc(b.title)}</span>
        <span class="bead-status ${esc(b.status || "open")}">${esc(statusLabel)}</span>
        <span class="bead-priority">${esc(priority)}</span>
        <span class="bead-assignee" title="${esc(assignee)}">${esc(assignee)}</span>
        <span class="bead-updated">${esc(updated)}</span>
        ${actionBtns}
      </div>
      ${descHtml}
    </div>`;
  }).join("");
}

function setBeadFilter(f) {
  beadFilter = f;
  document.querySelectorAll(".beads-filter").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.filter === f);
  });
  renderBeads();
}

function toggleBeadsSection() {
  beadsCollapsed = !beadsCollapsed;
  localStorage.setItem("klaudii-beads-collapsed", beadsCollapsed ? "1" : "0");
  renderBeads();
}

function toggleBeadDesc(id) {
  expandedBeadId = expandedBeadId === id ? null : id;
  renderBeads();
}

function openBeadForm() {
  document.getElementById("bead-form").classList.remove("hidden");
  document.getElementById("bead-title").focus();
}

function closeBeadForm() {
  document.getElementById("bead-form").classList.add("hidden");
  document.getElementById("bead-title").value = "";
  document.getElementById("bead-desc").value = "";
  document.getElementById("bead-priority").value = "2";
  document.getElementById("bead-type").value = "task";
}

async function submitBead() {
  const title = document.getElementById("bead-title").value.trim();
  if (!title) { document.getElementById("bead-title").focus(); return; }
  const description = document.getElementById("bead-desc").value.trim();
  const priority = Number(document.getElementById("bead-priority").value);
  const type = document.getElementById("bead-type").value;
  try {
    await api("/api/beads", { method: "POST", body: { title, description, priority, type } });
    closeBeadForm();
    refreshBeads();
  } catch (err) {
    alert("Failed to create bead: " + err.message);
  }
}

async function beadSetStatus(id, status) {
  try {
    await api(`/api/beads/${encodeURIComponent(id)}`, { method: "PATCH", body: { status } });
    refreshBeads();
  } catch (err) {
    alert("Failed to update bead: " + err.message);
  }
}

// --- Theme ---

function toggleTheme() {
  const isLight = document.documentElement.classList.toggle("light");
  localStorage.setItem("klaudii-theme", isLight ? "light" : "dark");
  document.getElementById("theme-toggle").textContent = isLight ? "🌙" : "☀";
}

// --- Card click: open chat in workspace's stored mode ---

document.getElementById("sessions-list").addEventListener("click", (e) => {
  // Ignore clicks on buttons, links, selects, inputs, and the action panel
  if (e.target.closest("button, a, select, input, .card-actions-panel")) return;

  const card = e.target.closest(".card");
  if (!card) return;

  const project = card.dataset.project;
  if (!project) return;

  const chatMode = card.dataset.chatMode || "claude-local";
  const projectPath = card.dataset.projectPath || "";
  const claudeUrl = card.dataset.claudeUrl || "";

  // Highlight the active workspace card
  document.querySelectorAll(".card.active-workspace").forEach(c => c.classList.remove("active-workspace"));
  card.classList.add("active-workspace");

  if (chatMode === "claude-remote") {
    // Open claude.ai in a new tab
    if (claudeUrl) window.open(claudeUrl, "_blank");
    return;
  }

  // Map stored mode to cli param expected by openGeminiChat
  const cli = chatMode === "gemini" ? "gemini" : "claude";
  openGeminiChat(project, projectPath, cli);
});

// --- Settings ---

let currentSettings = null;

function openSettingsModal() {
  document.getElementById("settings-modal").classList.remove("hidden");
  renderSettingsModal();
}

function closeSettingsModal() {
  document.getElementById("settings-modal").classList.add("hidden");
}

function closeSettingsBackdrop(e) {
  if (e.target.id === "settings-modal") closeSettingsModal();
}

async function renderSettingsModal() {
  const body = document.getElementById("settings-modal-body");
  try {
    currentSettings = await api("/api/settings");
  } catch {
    currentSettings = { workerVisibility: "hide", theme: "dark" };
  }

  body.innerHTML = `
    <div class="form-group">
      <label>Worker workspace visibility</label>
      <select id="setting-worker-visibility" class="settings-select" onchange="saveSettings()">
        <option value="hide"${currentSettings.workerVisibility === "hide" ? " selected" : ""}>Hide</option>
        <option value="show"${currentSettings.workerVisibility === "show" ? " selected" : ""}>Show</option>
        <option value="auto-clean"${currentSettings.workerVisibility === "auto-clean" ? " selected" : ""}>Auto-clean</option>
      </select>
      <div class="form-hint">Controls visibility of worker-created workspaces on the dashboard.</div>
    </div>
    <div class="form-group">
      <label>Theme preference</label>
      <select id="setting-theme" class="settings-select" onchange="saveSettings()">
        <option value="dark"${currentSettings.theme === "dark" ? " selected" : ""}>Dark</option>
        <option value="light"${currentSettings.theme === "light" ? " selected" : ""}>Light</option>
        <option value="auto"${currentSettings.theme === "auto" ? " selected" : ""}>Auto</option>
      </select>
      <div class="form-hint">Theme is also toggled via the quick-toggle in the header.</div>
    </div>
    <div id="settings-status" class="form-hint" style="margin-top:0.5rem"></div>
  `;
}

async function saveSettings() {
  const workerVisibility = document.getElementById("setting-worker-visibility").value;
  const theme = document.getElementById("setting-theme").value;
  const statusEl = document.getElementById("settings-status");

  try {
    currentSettings = await api("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workerVisibility, theme }),
    });
    if (statusEl) statusEl.textContent = "Saved.";
    applyThemeFromSettings(theme);
  } catch (err) {
    if (statusEl) statusEl.textContent = "Failed to save: " + err.message;
  }
}

function applyThemeFromSettings(theme) {
  let isLight;
  if (theme === "auto") {
    isLight = window.matchMedia("(prefers-color-scheme: light)").matches;
  } else {
    isLight = theme === "light";
  }
  document.documentElement.classList.toggle("light", isLight);
  localStorage.setItem("klaudii-theme", isLight ? "light" : "dark");
  document.getElementById("theme-toggle").textContent = isLight ? "\uD83C\uDF19" : "\u2600";
}

// --- Init ---

if (localStorage.getItem("klaudii-theme") === "light") {
  document.documentElement.classList.add("light");
  document.getElementById("theme-toggle").textContent = "🌙";
}

// Skip all dashboard polling in chatonly mode — only chat overlay is visible
if (new URLSearchParams(window.location.search).get("mode") === "chatonly") {
  // Fetch health once (for auth status used by gemini.js)
  api("/api/health").then(h => { lastHealthData = h; }).catch(() => {});
} else {
  refresh();
  refreshCloudStatus();
  refreshScheduler();
  refreshBeads();
  refreshTimer = setInterval(() => {
    refresh();
    refreshCloudStatus();
  }, 10000);
  refreshUsage();
  setInterval(refreshUsage, 60000);
  setInterval(() => { refreshScheduler(); refreshBeads(); }, 30000);
}
