const API = "";
let refreshTimer = null;
let currentTerminalSession = null;
let sortMode = localStorage.getItem("klaudii-sort") || "activity";
let sortDir = localStorage.getItem("klaudii-sort-dir") || "desc";

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
  const dirBtn = document.getElementById("sort-dir");
  if (dirBtn) dirBtn.textContent = sortDir === "desc" ? "↓" : "↑";
}

function sortSessions(sessions) {
  const statusOrder = { running: 0, exited: 1, stopped: 2 };
  const dir = sortDir === "asc" ? 1 : -1;
  return [...sessions].sort((a, b) => {
    // Running/exited always float to top regardless of direction
    const sa = statusOrder[a.status] ?? 2;
    const sb = statusOrder[b.status] ?? 2;
    if (sa !== sb) return sa - sb;

    if (sortMode === "alpha") {
      return dir * a.project.localeCompare(b.project);
    }
    // activity: use lastActivity, fall back to tmux session creation time
    const ta = a.lastActivity || (a.tmux && a.tmux.created) || 0;
    const tb = b.lastActivity || (b.tmux && b.tmux.created) || 0;
    return dir * (ta - tb);
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

// --- Theme ---

function toggleTheme() {
  const isLight = document.documentElement.classList.toggle("light");
  localStorage.setItem("klaudii-theme", isLight ? "light" : "dark");
  document.getElementById("theme-toggle").textContent = isLight ? "🌙" : "☀";
}

// --- Init ---

if (localStorage.getItem("klaudii-theme") === "light") {
  document.documentElement.classList.add("light");
  document.getElementById("theme-toggle").textContent = "🌙";
}

refresh();
refreshCloudStatus();
refreshTimer = setInterval(() => {
  refresh();
  refreshCloudStatus();
}, 10000);
refreshUsage();
setInterval(refreshUsage, 60000);
