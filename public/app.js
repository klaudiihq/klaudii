const API = "";
let refreshTimer = null;
let currentTerminalSession = null;

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return res.json();
}

// --- Rendering ---

function renderSessions(sessions, procs) {
  const container = document.getElementById("sessions-list");
  if (!sessions.length) {
    container.innerHTML = '<p style="color:#666">No workspaces configured.</p>';
    return;
  }

  // Build a lookup of managed process stats by project name
  const procByProject = {};
  if (procs) {
    for (const p of procs) {
      if (p.managed && p.project) procByProject[p.project] = p;
    }
  }

  container.innerHTML = sessions
    .map(
      (s) => {
        const parts = s.project.split("--");
        const repo = parts[0];
        const branch = parts.length > 1 ? parts.slice(1).join("--") : null;
        const sessionData = esc(JSON.stringify(s).replace(/'/g, "&#39;"));
        const proc = procByProject[s.project];
        return `
    <div class="card" id="card-${esc(s.project)}">
      <div class="card-header">
        <span class="card-title">${esc(repo)}${branch ? ` <span class="card-branch">(${esc(branch)})</span>` : ""}</span>
        <span class="card-status ${s.running ? "running" : "stopped"}">
          ${s.running ? "running" : "stopped"}
        </span>
      </div>
      ${proc ? `<div class="proc-stats">${proc.cpu}% cpu &middot; ${proc.memMB} MB${proc.uptime ? ` &middot; ${esc(proc.uptime)}` : ""}</div>` : ""}
      <div class="card-actions">
        ${
          s.running
            ? `
          ${s.claudeUrl ? `<a class="btn success" href="${esc(s.claudeUrl)}" target="_blank">Open</a>` : ""}
          <button class="btn danger" onclick="stopSession('${esc(s.project)}')">Stop</button>
          <button class="btn primary" onclick="restartSession('${esc(s.project)}')">Restart</button>
          ${s.ttyd ? `<button class="btn" onclick='openTerminal(${s.ttyd.port}, ${sessionData})'>Terminal</button>` : ""}
        `
            : `
          <button class="btn primary" onclick="startSession('${esc(s.project)}', {continueSession:true})">Continue</button>
          <button class="btn btn-sm" onclick="startSession('${esc(s.project)}')">New</button>
        `
        }
        <button class="btn btn-sm" onclick="toggleHistory('${esc(s.project)}')">History</button>
      </div>
      <div class="history-list hidden" id="history-${esc(s.project)}"></div>
    </div>
  `;
      }
    )
    .join("");
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

async function restartSession(project) {
  closeTerminal();
  await api("/api/sessions/restart", { method: "POST", body: { project } });
  setTimeout(refresh, 1000);
}

function resumeSession(sessionId, project) {
  if (project) startSession(project, { resumeSessionId: sessionId });
}

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

    const badge = document.getElementById("status-badge");

    if (health.ok && health.tmux && health.ttyd) {
      badge.textContent = "ready";
      badge.className = "badge ok";
    } else {
      const missing = [];
      if (!health.tmux) missing.push("tmux");
      if (!health.ttyd) missing.push("ttyd");
      badge.textContent = `missing: ${missing.join(", ")}`;
      badge.className = "badge error";
    }

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

async function openNewSessionModal() {
  selectedRepo = null;
  document.getElementById("branch-form").classList.add("hidden");
  document.getElementById("repo-search").value = "";
  document.getElementById("branch-input").value = "";
  document.getElementById("new-session-modal").classList.remove("hidden");

  document.getElementById("repo-list").innerHTML = '<div style="padding:1rem;color:#666">Loading repos...</div>';
  try {
    allRepos = await api("/api/github/repos");
    renderRepoList(allRepos);
  } catch (err) {
    document.getElementById("repo-list").innerHTML = `<div style="padding:1rem;color:#f87171">Failed to load repos: ${esc(err.message)}</div>`;
  }
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
    r.name.toLowerCase().includes(q) || (r.description || "").toLowerCase().includes(q)
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
    <div class="repo-item ${selectedRepo === r.name ? "selected" : ""}" onclick="selectRepo('${esc(r.name)}')">
      <div>
        <div class="repo-name">${esc(r.name)}</div>
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

function selectRepo(name) {
  selectedRepo = name;
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
      body: { repo: selectedRepo, branch },
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

// --- Init ---

refresh();
refreshTimer = setInterval(refresh, 10000);
