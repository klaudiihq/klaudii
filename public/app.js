const API = "";
let refreshTimer = null;
let currentTerminalSession = null;
let sortMode = localStorage.getItem("klaudii-sort") || "activity";

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

function updateSortButtons() {
  document.querySelectorAll(".sort-btn").forEach((b) => b.classList.remove("active"));
  const active = document.getElementById(`sort-${sortMode}`);
  if (active) active.classList.add("active");
}

function sortSessions(sessions) {
  const statusOrder = { running: 0, exited: 1, stopped: 2 };
  return [...sessions].sort((a, b) => {
    // Running/exited float to top, stopped at bottom
    const sa = statusOrder[a.status] ?? 2;
    const sb = statusOrder[b.status] ?? 2;
    if (sa !== sb) return sa - sb;

    if (sortMode === "alpha") {
      return a.project.localeCompare(b.project);
    }
    // activity: most recent first
    return (b.lastActivity || 0) - (a.lastActivity || 0);
  });
}

// --- Rendering ---

function renderSessions(sessions, procs) {
  const container = document.getElementById("sessions-list");
  updateSortButtons();
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

  container.innerHTML = sessions
    .map(
      (s) => {
        const parts = s.project.split("--");
        const repo = parts[0];
        const branch = parts.length > 1 ? parts.slice(1).join("--") : null;
        const sessionData = esc(JSON.stringify(s).replace(/'/g, "&#39;"));
        const proc = procByProject[s.project];
        const pm = s.permissionMode || "yolo";
        const g = s.git;
        const gitBranch = g ? g.branch : branch;
        const ghUrl = s.remoteUrl || null;
        const ghBranchUrl = ghUrl && gitBranch ? `${ghUrl}/tree/${esc(gitBranch)}` : ghUrl;
        return `
    <div class="card" id="card-${esc(s.project)}">
      <div class="card-header">
        <span class="card-title">
          ${ghUrl ? `<a href="${esc(ghUrl)}" target="_blank" class="card-repo-link">${esc(repo)}</a>` : `<span class="card-repo-link">${esc(repo)}</span>`}${gitBranch ? (ghBranchUrl ? ` <a href="${esc(ghBranchUrl)}" target="_blank" class="card-branch-link">${esc(gitBranch)}</a>` : ` <span class="card-branch-link">${esc(gitBranch)}</span>`) : ""}
        </span>
        <span class="card-status ${s.status || (s.running ? "running" : "stopped")}">
          ${s.status || (s.running ? "running" : "stopped")}
        </span>
      </div>
      ${g ? `<div class="git-status-bar">
        ${g.dirtyFiles ? `<span class="git-dirty" onclick="openGitStatus('${esc(s.project)}')">${g.dirtyFiles} changed</span>` : '<span class="git-clean">clean</span>'}
        ${g.unpushed ? `<span class="git-unpushed">${g.unpushed} unpushed</span>` : ""}
        <button class="btn btn-sm" onclick="openGitStatus('${esc(s.project)}')">git status</button>
      </div>` : ""}
      ${proc ? `<div class="proc-stats">${proc.cpu}% cpu &middot; ${proc.memMB} MB${proc.uptime ? ` &middot; ${esc(proc.uptime)}` : ""}${s.sessionCount ? ` &middot; ${s.sessionCount} session${s.sessionCount === 1 ? "" : "s"}` : ""}</div>` : (s.sessionCount ? `<div class="proc-stats">${s.sessionCount} session${s.sessionCount === 1 ? "" : "s"}</div>` : "")}
      ${s.status === "stopped" ? `<div class="permission-toggle">
        <button class="perm-btn${pm === 'yolo' ? ' active yolo' : ''}" onclick="setPermission('${esc(s.project)}', 'yolo')" title="Auto-approve all actions">Yolo</button>
        <button class="perm-btn${pm === 'ask' ? ' active ask' : ''}" onclick="setPermission('${esc(s.project)}', 'ask')" title="Approve each action in terminal">Ask</button>
        <button class="perm-btn${pm === 'strict' ? ' active strict' : ''}" onclick="setPermission('${esc(s.project)}', 'strict')" title="Read-only tools only">Strict</button>
      </div>` : `<div class="permission-toggle locked">
        <span class="perm-badge ${pm}">${pm}</span>
      </div>`}
      <div class="card-actions">
        ${
          s.status === "running"
            ? `
          ${s.claudeUrl ? `<a class="btn success" href="${esc(s.claudeUrl)}" target="_blank">Open</a>` : ""}
          <button class="btn danger" onclick="stopSession('${esc(s.project)}')">Stop</button>
          <button class="btn primary" onclick="restartSession('${esc(s.project)}')">Restart</button>
          ${s.ttyd ? `<button class="btn" onclick='openTerminal(${s.ttyd.port}, ${sessionData})'>Terminal</button>` : ""}
        `
          : s.status === "exited"
            ? `
          <button class="btn primary" onclick="restartSession('${esc(s.project)}')">Restart</button>
          <button class="btn danger" onclick="stopSession('${esc(s.project)}')">Clean up</button>
          ${s.ttyd ? `<button class="btn" onclick='openTerminal(${s.ttyd.port}, ${sessionData})'>Terminal</button>` : ""}
        `
            : `
          <button class="btn primary" onclick="startSession('${esc(s.project)}', {continueSession:true})">Continue</button>
          <button class="btn btn-sm" onclick="startSession('${esc(s.project)}')">New</button>
          <button class="btn btn-sm danger" onclick="removeWorkspace(this, '${esc(s.project)}', ${!!(g && (g.dirtyFiles || g.unpushed))})">Remove</button>
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

    const badge = document.getElementById("status-badge");

    if (health.ok && health.tmux && health.ttyd) {
      badge.textContent = "connected";
      badge.className = "badge ok";
    } else {
      const missing = [];
      if (!health.tmux) missing.push("tmux");
      if (!health.ttyd) missing.push("ttyd");
      badge.textContent = `missing: ${missing.join(", ")}`;
      badge.className = "badge error";
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
        const label = health.claudeAuth.email ? esc(health.claudeAuth.email) : "authenticated";
        authRows.push(`<span class="auth-row ok" title="${label}"><span class="auth-dot ok"></span>Claude</span>`);
      } else {
        authRows.push('<span class="auth-row error" title="Run: claude auth login"><span class="auth-dot error"></span>Claude</span>');
      }
    } else if (health.claudeAuth === null) {
      authRows.push('<span class="auth-row error" title="Claude CLI not installed"><span class="auth-dot error"></span>Claude</span>');
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

async function openNewSessionModal() {
  selectedRepo = null;
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

// --- Cloud Connect ---

let cloudStatus = null;

async function refreshCloudStatus() {
  try {
    cloudStatus = await api("/api/cloud/status");
    const btn = document.getElementById("cloud-btn");
    if (!btn) return;
    if (cloudStatus.paired && cloudStatus.connected) {
      btn.textContent = "Cloud \u2022";
      btn.classList.add("cloud-connected");
    } else if (cloudStatus.paired) {
      btn.textContent = "Cloud \u25CB";
      btn.classList.remove("cloud-connected");
    } else {
      btn.textContent = "Cloud";
      btn.classList.remove("cloud-connected");
    }
  } catch {
    // Cloud endpoint not available
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
          <span class="badge ${cloudStatus.connected ? "running" : "stopped"}">${cloudStatus.connected ? "Connected" : "Disconnected"}</span>
        </div>
        <div class="cloud-status-row">
          <span class="label">Server name</span>
          <span>${esc(cloudStatus.serverName || "—")}</span>
        </div>
        ${keyResp && keyResp.qrSvg ? `
        <div class="cloud-qr-section">
          <label>Scan to pair a browser</label>
          <div class="cloud-qr-code">${keyResp.qrSvg}</div>
          <div class="form-hint">Open klaudii-cloud-relay.fly.dev on your phone or laptop and scan this QR code. It contains your Connection Key — the relay never sees it.</div>
        </div>
        ` : ""}
        ${keyResp && keyResp.connectionKey ? `
        <details class="cloud-key-details">
          <summary>Manual entry (Connection Key)</summary>
          <div class="cloud-key-section">
            <div class="cloud-key-display mono">${esc(keyResp.connectionKey)}</div>
            <div class="form-hint">Copy and paste this on klaudii-cloud-relay.fly.dev if you can't scan the QR code.</div>
          </div>
        </details>
        ` : ""}
        <div style="margin-top: 16px">
          <button class="btn danger" onclick="unpairCloud()">Unpair</button>
        </div>
      </div>
    `;
  } else {
    // Not paired — show pairing form
    body.innerHTML = `
      <div class="cloud-pair-form">
        <p>Connect this Klaudii server to the cloud so you can access it from anywhere.</p>
        <ol>
          <li>Go to <strong>klaudii-cloud-relay.fly.dev</strong> and sign in</li>
          <li>Click <strong>Add Server</strong> to get a pairing code</li>
          <li>Enter the code below</li>
        </ol>
        <div class="form-group">
          <label>Pairing code</label>
          <input id="pairing-code-input" type="text" placeholder="XXX-XXX" maxlength="7" style="text-transform: uppercase; letter-spacing: 2px; font-size: 1.2em; text-align: center" />
        </div>
        <div class="form-group">
          <label>Server name (optional)</label>
          <input id="server-name-input" type="text" placeholder="e.g. My MacBook Pro" />
        </div>
        <div class="form-group">
          <label>Relay URL</label>
          <input id="relay-url-input" type="text" value="https://klaudii-cloud-relay.fly.dev" />
        </div>
        <button class="btn primary" onclick="pairCloud()" id="pair-btn">Pair</button>
        <div id="pair-result" class="hidden" style="margin-top: 16px"></div>
      </div>
    `;
    document.getElementById("pairing-code-input").focus();
  }
}

async function pairCloud() {
  const code = document.getElementById("pairing-code-input").value.trim();
  const serverName = document.getElementById("server-name-input").value.trim() || undefined;
  const relayUrl = document.getElementById("relay-url-input").value.trim();

  if (!code) {
    alert("Enter the pairing code from klaudii-cloud-relay.fly.dev");
    return;
  }

  const btn = document.getElementById("pair-btn");
  btn.disabled = true;
  btn.textContent = "Pairing...";

  try {
    const result = await api("/api/cloud/pair", {
      method: "POST",
      body: { code, relayUrl, serverName },
    });

    if (result.error) {
      alert("Pairing failed: " + result.error);
      return;
    }

    // Fetch the QR code from the server (now that pairing is done)
    const keyResp = await api("/api/cloud/connection-key").catch(() => null);

    // Show QR code + connection key — user scans or enters this on klaudii-cloud-relay.fly.dev
    const resultDiv = document.getElementById("pair-result");
    resultDiv.classList.remove("hidden");
    resultDiv.innerHTML = `
      <div class="cloud-key-section success">
        <h3>Paired successfully!</h3>
        ${keyResp && keyResp.qrSvg ? `
          <label>Scan this QR code on klaudii-cloud-relay.fly.dev</label>
          <div class="cloud-qr-code">${keyResp.qrSvg}</div>
        ` : ""}
        <details open>
          <summary>Manual entry</summary>
          <div class="cloud-key-display mono" style="margin-top: 0.5rem">${esc(result.connectionKey)}</div>
        </details>
        <div class="form-hint">This key enables end-to-end encryption. The relay server never sees it.</div>
      </div>
    `;

    await refreshCloudStatus();
  } catch (err) {
    alert("Pairing failed: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Pair";
  }
}

async function unpairCloud() {
  if (!confirm("Unpair from cloud? You will need to re-pair to use cloud access.")) return;

  await api("/api/cloud/unpair", { method: "POST" });
  cloudStatus = null;
  await refreshCloudStatus();
  renderCloudModal();
}

// --- Init ---

refresh();
refreshCloudStatus();
refreshTimer = setInterval(() => {
  refresh();
  refreshCloudStatus();
}, 10000);
