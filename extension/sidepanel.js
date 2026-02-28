const DEFAULT_KLAUDII_URL = "http://localhost:9876";

const GIT_PATH = "M23.546 10.93L13.067.452c-.604-.603-1.582-.603-2.188 0L8.708 2.627l2.76 2.76c.645-.215 1.379-.07 1.889.441.516.515.658 1.258.438 1.9l2.658 2.66c.645-.223 1.387-.078 1.9.435.721.72.721 1.884 0 2.604-.719.719-1.881.719-2.6 0-.539-.541-.674-1.337-.404-1.996L12.86 8.955v6.525c.176.086.342.203.488.348.713.721.713 1.883 0 2.6-.719.721-1.889.721-2.609 0-.719-.719-.719-1.879 0-2.598.182-.18.387-.316.605-.406V8.835c-.217-.091-.424-.222-.6-.401-.545-.545-.676-1.342-.396-2.009L7.636 3.7.45 10.881c-.6.605-.6 1.584 0 2.189l10.48 10.477c.604.604 1.582.604 2.186 0l10.43-10.43c.605-.603.605-1.582 0-2.187";
const gitSvg = (size) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${GIT_PATH}"/></svg>`;
let klaudiiUrl = DEFAULT_KLAUDII_URL;
let pollTimer = null;
let lastSessions = [];
let lastProcs = [];
let activeTabUrl = null;
let sortMode = localStorage.getItem("sortMode") || "activity";
let openMode = "inplace";
let attentionFlash = false;
let openTabs = new Map();    // urlPath (no query string) → tabId, for open claude.ai tabs in this window
let sessionNeedsInput = {}; // project → bool: session has a pending approval button
let addSelectedRepo = null; // repo name chosen in the add-workspace flow
let addRepos = [];          // cached list from /api/github/repos

// --- Init ---

async function init() {
  const config = await chrome.storage.sync.get(["klaudiiUrl", "openMode", "attentionFlash"]);
  klaudiiUrl = (config.klaudiiUrl || DEFAULT_KLAUDII_URL).replace(/\/+$/, "");
  openMode = config.openMode || "inplace";
  attentionFlash = config.attentionFlash === true;

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
  // Set initial active state
  document.querySelectorAll(".sort-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.sort === sortMode)
  );

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
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
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
    checkApprovalStates(sessions); // async, re-renders only if state changes
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

// --- Approval detection ---

// For each running session that has an open tab, inject a tiny script to check
// whether the claude.ai page is currently showing an approval button.
// Detects "Allow …" (any variant) and "Skip" buttons.
// Re-renders cards only when the set of sessions needing input changes.
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
        func: () => Array.from(document.querySelectorAll("button")).some((b) => {
          const text = b.textContent.trim();
          return text.includes("Allow") || text.includes("Approve") || text === "Skip";
        }),
      });
      if (results?.[0]?.result === true) newStates[s.project] = true;
    } catch {
      // Tab not injectable (loading, navigating, wrong origin, etc.)
    }
  }
  const changed = sessions.some((s) => !!newStates[s.project] !== !!sessionNeedsInput[s.project]);
  sessionNeedsInput = newStates;
  if (changed) renderSessions(lastSessions, lastProcs);
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
      // Re-render cards so Switch/Open labels stay current
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

  const procByProject = {};
  if (procs) {
    for (const p of procs) {
      if (p.managed && p.project) procByProject[p.project] = p;
    }
  }

  container.innerHTML = sortSessions(sessions)
    .map((s) => renderCard(s, procByProject[s.project]))
    .join("");
  highlightActiveSession();
}

function renderCard(s, proc) {
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

  // Permission mode display
  const permBadge = `<span class="perm-badge perm-${mode}">${mode}</span>`;
  const permToggle = !isRunning ? `
    <div class="perm-toggle">
      <button class="perm-btn${mode === "yolo" ? " active perm-yolo" : ""}" data-action="set-perm" data-project="${esc(s.project)}" data-mode="yolo">Yolo</button>
      <button class="perm-btn${mode === "ask" ? " active perm-ask" : ""}" data-action="set-perm" data-project="${esc(s.project)}" data-mode="ask">Ask</button>
      <button class="perm-btn${mode === "strict" ? " active perm-strict" : ""}" data-action="set-perm" data-project="${esc(s.project)}" data-mode="strict">Strict</button>
    </div>` : "";

  const displayTitle = gitBranch ? `${repo} (${gitBranch})` : repo;
  const needsInput = sessionNeedsInput[s.project] === true;
  const showDot = needsInput && !attentionFlash;
  const inputDot = showDot ? `<span class="needs-input-dot" title="Waiting for your approval"></span>` : "";
  const attentionClass = needsInput && attentionFlash ? " needs-attention" : "";

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
        ${repoGitLink}<span class="card-title">${esc(repo)}</span>
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
  // Repo list item click in add-workspace flow
  const repoItem = e.target.closest("[data-add-repo]");
  if (repoItem) { selectAddRepo(repoItem.dataset.addRepo); return; }

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

    case "set-perm": {
      const mode = btn.dataset.mode;
      // Update UI immediately for responsiveness
      btn.closest(".perm-toggle").querySelectorAll(".perm-btn").forEach((b) => {
        b.classList.remove("active", "perm-yolo", "perm-ask", "perm-strict");
        if (b.dataset.mode === mode) b.classList.add("active", `perm-${mode}`);
      });
      btn.closest(".card").querySelector(".perm-badge").className = `perm-badge perm-${mode}`;
      btn.closest(".card").querySelector(".perm-badge").textContent = mode;
      try {
        await api("/api/projects/permission", { method: "POST", body: { project, mode } });
      } catch (err) {
        showToast("Error: " + err.message);
        refresh(); // revert on error
      }
      break;
    }

    case "remove":
      if (btn.dataset.armed === "force") {
        btn.disabled = true;
        try {
          await api("/api/projects/remove", { method: "POST", body: { project, force: true } });
          refresh();
        } catch (err) {
          showToast("Error: " + err.message);
          refresh();
        }
      } else if (btn.dataset.armed) {
        btn.disabled = true;
        try {
          await api("/api/projects/remove", { method: "POST", body: { project } });
          refresh();
        } catch (err) {
          if (err.status === 409) {
            // Dirty repo — offer force
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
      await api("/api/sessions/start", { method: "POST", body: { project, continueSession: true } });
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
