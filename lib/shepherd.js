#!/usr/bin/env node

// Shepherd — periodic monitoring script for Klaudii.
//
// Reads system state (tasks + workspaces), takes corrective action, and exits.
// Designed to run every ~5 minutes via the Klaudii scheduler.
//
// When run in-process (via scheduler), receives a `ctx` object with internal
// modules so it can call them directly — avoids HTTP self-deadlock since
// Node.js is single-threaded.
//
// When run standalone (node lib/shepherd.js), falls back to HTTP via curl.

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const KLAUDII_URL = process.env.KLAUDII_URL || "http://localhost:9876";
const MAX_CONCURRENT = parseInt(process.env.SHEPHERD_MAX_CONCURRENT || "0", 10);
const STUCK_THRESHOLD_MS = parseInt(process.env.SHEPHERD_STUCK_THRESHOLD || "900000", 10); // 15 min
const REPO_NAME = process.env.SHEPHERD_REPO || "klaudii";
const BD_CWD = path.resolve(__dirname, "..");

// --- HTTP fallback (standalone mode only) ---

function httpApi(method, endpoint, body) {
  const url = `${KLAUDII_URL}${endpoint}`;
  const args = ["-s", "-X", method, url, "-H", "Content-Type: application/json"];
  if (body) args.push("-d", JSON.stringify(body));
  try {
    const out = execSync(`curl ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`, {
      encoding: "utf-8",
      timeout: 10000,
    });
    return JSON.parse(out);
  } catch (err) {
    console.error(`[shepherd] API ${method} ${endpoint} failed:`, err.message);
    return null;
  }
}

// --- Internal API (in-process mode) ---

function buildSessionList(ctx) {
  const allProjects = ctx.projects.getProjects();
  const claudeSessions = ctx.tmux.getClaudeSessions();
  const ttydInstances = ctx.ttyd.getRunning();

  return allProjects.map((project) => {
    const tmuxName = ctx.tmux.sessionName(project.name);
    const tmuxSession = claudeSessions.find((s) => s.name === tmuxName);

    const gitStatus = ctx.git.getStatus(project.path);

    let status = "stopped";
    if (tmuxSession) {
      status = ctx.tmux.isClaudeAlive(tmuxName) ? "running" : "exited";
    }

    const tracked = ctx.sessionTracker ? ctx.sessionTracker.getSessions(project.name) : [];
    const lastActivity = Math.max(
      ctx.claude.getProjectLastActivity(project.path) || 0,
      tracked.length ? tracked[0].startedAt : 0,
      ctx.claudeChat ? ctx.claudeChat.getLastMessageTime(project.name) || 0 : 0,
    );

    const taskId = ctx.workspaceState ? ctx.workspaceState.getTaskId(project.name) : null;

    return {
      project: project.name,
      projectPath: project.path,
      status,
      git: gitStatus,
      lastActivity,
      tmux: tmuxSession || null,
      ttyd: ttydInstances.find((t) => t.project === project.name) || null,
      taskId,
    };
  });
}

function internalStopSession(ctx, projectName) {
  const tmuxName = ctx.tmux.sessionName(projectName);
  try { ctx.ttyd.stop(projectName); } catch { /* may not be running */ }
  if (ctx.sessionTracker) ctx.sessionTracker.clearClaudeUrl(projectName);
  try { ctx.tmux.killSession(tmuxName); } catch { /* already dead */ }
}

// --- Tasks via bd CLI ---

function bd(cmd) {
  try {
    return JSON.parse(execSync(`bd ${cmd} --json --allow-stale`, { encoding: "utf-8", cwd: BD_CWD, timeout: 10000 }));
  } catch (err) {
    console.error(`[shepherd] bd ${cmd} failed:`, err.message);
    return null;
  }
}

function bdRaw(cmd) {
  try {
    execSync(`bd ${cmd} --allow-stale`, { encoding: "utf-8", cwd: BD_CWD, timeout: 10000 });
  } catch (err) {
    console.error(`[shepherd] bd ${cmd} failed:`, err.message);
  }
}

function gitStatusCheck(projectPath) {
  try {
    return execSync(`git -C '${projectPath}' status --porcelain`, {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
  } catch {
    return "";
  }
}

function gitAutoSave(projectPath) {
  try {
    execSync(`git -C '${projectPath}' add -A && git -C '${projectPath}' commit -m "WIP: shepherd auto-save"`, {
      encoding: "utf-8",
      timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

// --- Main run function ---

function run(ctx) {
  const actions = [];
  const now = Date.now();
  const ts = new Date().toISOString();
  const inProcess = !!ctx;

  // Helper: get sessions list (in-process or HTTP)
  function getSessions() {
    if (inProcess) return buildSessionList(ctx);
    return httpApi("GET", "/api/sessions") || [];
  }

  // Helper: stop a session
  function stopSession(projectName) {
    if (inProcess) return internalStopSession(ctx, projectName);
    return httpApi("POST", "/api/sessions/stop", { project: projectName });
  }

  // Helper: create new workspace and start Claude with a prompt
  function dispatchWorker(repo, branch, prompt) {
    if (inProcess && ctx.config && ctx.config.reposDir) {
      try {
        const repoDir = path.join(ctx.config.reposDir, repo);
        const branchName = branch || `task-${Date.now()}`;
        const worktreeDir = path.join(ctx.config.reposDir, `${repo}--${branchName}`);
        const projectName = `${repo}--${branchName}`;

        if (!ctx.git.isGitRepo(repoDir)) {
          console.error(`[shepherd] repo dir ${repoDir} is not a git repo`);
          return null;
        }
        if (fs.existsSync(worktreeDir)) {
          // Worktree exists — reuse it, clean it
          try {
            execSync(`git -C '${worktreeDir}' reset --hard && git -C '${worktreeDir}' clean -fd && git -C '${worktreeDir}' fetch origin main && git -C '${worktreeDir}' checkout -B '${branchName}' origin/main`, {
              encoding: "utf-8", timeout: 15000,
            });
          } catch (err) {
            console.error(`[shepherd] failed to clean existing worktree ${worktreeDir}:`, err.message);
            return null;
          }
        } else {
          ctx.git.addWorktree(repoDir, worktreeDir, branchName);
        }

        // Copy config.json from main repo into worktree if it exists
        const mainConfigPath = path.join(repoDir, "config.json");
        const worktreeConfigPath = path.join(worktreeDir, "config.json");
        if (fs.existsSync(mainConfigPath) && !fs.existsSync(worktreeConfigPath)) {
          try { fs.copyFileSync(mainConfigPath, worktreeConfigPath); } catch { /* best effort */ }
        }

        try { ctx.projects.addProject(projectName, worktreeDir); } catch { /* already registered */ }

        // Tag as worker-managed workspace
        if (ctx.workspaceState) ctx.workspaceState.setWorkspaceType(projectName, "worker");

        const tmuxName = ctx.tmux.sessionName(projectName);
        if (ctx.tmux.sessionExists(tmuxName)) {
          // Session already running — skip
          return { ok: true, project: projectName, worktree: worktreeDir, branch: branchName };
        }

        // Start Claude in interactive mode (NOT remote-control)
        ctx.tmux.createSession(tmuxName, worktreeDir, "--dangerously-skip-permissions");

        // Wait for Claude to boot, then send the prompt via tmux send-keys
        setTimeout(() => {
          try {
            ctx.tmux.sendKeys(tmuxName, prompt);
          } catch (err) {
            console.error(`[shepherd] sendKeys failed for ${tmuxName}:`, err.message);
          }
        }, 5000);

        const port = ctx.ttyd.allocatePort(ctx.config.ttydBasePort);
        try { ctx.ttyd.start(projectName, tmuxName, port); } catch { /* ttyd optional */ }

        if (ctx.sessionTracker) {
          ctx.sessionTracker.detectAndTrack(projectName, Date.now()).catch(() => {});
        }

        return { ok: true, project: projectName, worktree: worktreeDir, branch: branchName };
      } catch (err) {
        console.error(`[shepherd] dispatchWorker failed:`, err.message);
        return null;
      }
    }
    // Standalone mode: create via HTTP, then send prompt separately
    const result = httpApi("POST", "/api/sessions/new", { repo, branch });
    if (result && result.ok) {
      httpApi("POST", `/api/chat/${encodeURIComponent(result.project)}/send`, { message: prompt, sender: "shepherd" });
    }
    return result;
  }

  // Step 1: Read all tasks
  const allTasks = bd("list") || [];
  const tasksByStatus = { open: [], in_progress: [], blocked: [], closed: [] };
  for (const b of allTasks) {
    const s = b.status || "open";
    if (tasksByStatus[s]) tasksByStatus[s].push(b);
  }

  // Step 2: Check workspace status
  const sessions = getSessions();
  const running = sessions.filter((s) => s.status === "running");
  const exited = sessions.filter((s) => s.status === "exited");
  const stopped = sessions.filter((s) => s.status === "stopped");

  // Build a map of task ID to task for quick lookup
  const taskMap = new Map();
  for (const b of allTasks) taskMap.set(b.id, b);

  // Step 3: Monitor in-progress workspaces — check for stuck workers
  for (const ws of running) {
    const idleMs = now - (ws.lastActivity || 0);
    if (ws.lastActivity && idleMs > STUCK_THRESHOLD_MS) {
      const dirty = gitStatusCheck(ws.projectPath);
      // Prefer explicit taskId from workspace state, fall back to branch name regex
      const taskId = (ws.taskId) ||
        (ws.git && ws.git.branch ? (ws.git.branch.match(/^task-(.+)$/) || [])[1] : null) ||
        null;

      if (dirty) {
        gitAutoSave(ws.projectPath);
        if (taskId) {
          bd(`update ${taskId} --status blocked`);
          bdRaw(`comment ${taskId} "Shepherd: worker stuck for >${Math.round(idleMs / 60000)}min, auto-saved WIP and marked blocked"`);
        }
        actions.push(`Auto-saved WIP in ${ws.project} (idle ${Math.round(idleMs / 60000)}min)${taskId ? `, blocked task ${taskId}` : ""}`);
      } else {
        stopSession(ws.project);
        if (taskId) {
          bdRaw(`comment ${taskId} "Shepherd: worker stuck with no progress for >${Math.round(idleMs / 60000)}min, stopped session for retry"`);
        }
        actions.push(`Stopped stuck workspace ${ws.project} (idle ${Math.round(idleMs / 60000)}min, no changes)`);
      }
    }
  }

  // Step 4: Dispatch ready tasks
  const currentSessions = getSessions();
  const currentRunning = currentSessions.filter((s) => s.status === "running").length;
  let slotsAvailable = MAX_CONCURRENT - currentRunning;

  const readyTasks = tasksByStatus.open
    .filter((b) => !b.assignee)
    .sort((a, b) => (a.priority || 2) - (b.priority || 2));

  for (const task of readyTasks) {
    if (slotsAvailable <= 0) break;

    const branchName = `task-${task.id}`;
    const workerPrompt = `Read AGENTS.md for project conventions. Then work on task ${task.id}. Run: bd show ${task.id} --allow-stale to get the full spec. Claim it: bd update ${task.id} --claim --allow-stale. Do the work per the spec. Verify per the spec. Close it: bd close ${task.id} --reason Done --allow-stale. When done, commit and push to origin main. Use bd export -o .tasks/issues.jsonl --allow-stale before committing.`;

    const result = dispatchWorker(REPO_NAME, branchName, workerPrompt);
    if (!result || !result.ok) {
      actions.push(`Failed to dispatch worker for task ${task.id}`);
      continue;
    }

    // Tag workspace with task ID for tracking
    if (inProcess && ctx.workspaceState) {
      ctx.workspaceState.setTaskId(result.project, task.id, "worker");
    }
    // Tag the chat session with task ID
    if (inProcess && ctx.claudeChat) {
      ctx.claudeChat.tagSessionWithTask(result.project, 1, task.id);
    }

    bd(`update ${task.id} --claim`);

    slotsAvailable--;
    actions.push(`Dispatched task ${task.id} ("${task.title}") to workspace ${result.project}`);
  }

  // Step 5: Handle blocked tasks — simple triage
  for (const task of tasksByStatus.blocked) {
    if (task.comment_count > 0) {
      const detail = bd(`show ${task.id}`);
      if (detail && detail.comments && detail.comments.length > 0) {
        const lastComment = detail.comments[detail.comments.length - 1];
        if (lastComment.body && lastComment.body.startsWith("Shepherd:")) continue;
        bdRaw(`comment ${task.id} "Shepherd: seen blocked task — escalating to Architect"`);
        actions.push(`Escalated blocked task ${task.id} ("${task.title}") to Architect`);
      }
    }
  }

  // Step 6: Handle exited workspaces
  for (const ws of exited) {
    const taskId = (ws.taskId) ||
      (ws.git && ws.git.branch ? (ws.git.branch.match(/^task-(.+)$/) || [])[1] : null) ||
      null;

    if (taskId) {
      const task = taskMap.get(taskId);
      if (task && task.status === "closed") continue;

      const dirty = gitStatusCheck(ws.projectPath);
      if (dirty) {
        gitAutoSave(ws.projectPath);
        if (task) {
          bd(`update ${taskId} --status blocked`);
          bdRaw(`comment ${taskId} "Shepherd: worker exited unexpectedly, auto-saved WIP and marked blocked"`);
        }
        actions.push(`Auto-saved WIP in exited workspace ${ws.project}, blocked task ${taskId}`);
      } else if (task && (task.status === "open" || task.status === "in_progress")) {
        bdRaw(`comment ${taskId} "Shepherd: worker exited with no uncommitted changes, may need retry"`);
        actions.push(`Noted exited workspace ${ws.project} for task ${taskId} (no dirty files)`);
      }
    }
  }

  // Step 7: Auto-cleanup completed worker workspaces
  // Only runs when workerVisibility is "auto-clean" in user settings
  const { DATA_DIR } = require("./paths");
  const settingsPath = path.join(DATA_DIR, "settings.json");
  let workerVisibility = "hide";
  try { workerVisibility = JSON.parse(fs.readFileSync(settingsPath, "utf-8")).workerVisibility || "hide"; } catch { /* default */ }

  if (workerVisibility === "auto-clean" && inProcess && ctx.workspaceState && ctx.projects.removeProject) {
    const freshSessions = getSessions();
    for (const ws of freshSessions) {
      if (ws.status !== "stopped") continue;
      if (ctx.workspaceState.getWorkspaceType(ws.project) !== "worker") continue;

      const branchMatch = ws.git && ws.git.branch ? ws.git.branch.match(/^task-(.+)$/) : null;
      const taskId = branchMatch ? branchMatch[1] : null;
      if (!taskId) continue;

      const task = taskMap.get(taskId);
      if (!task || task.status !== "closed") continue;

      // Safety: don't remove if dirty or unpushed
      if (ws.git && (ws.git.dirtyFiles || ws.git.unpushed)) continue;

      try {
        // Find main repo dir for worktree removal
        const parts = ws.project.split("--");
        const mainRepoDir = path.join(ctx.config.reposDir, parts[0]);
        if (ctx.git.isGitRepo(mainRepoDir) && ws.projectPath) {
          ctx.git.removeWorktree(mainRepoDir, ws.projectPath);
        }
        ctx.projects.removeProject(ws.project);
        actions.push(`Auto-cleaned worker workspace ${ws.project} (task ${taskId} closed, worktree clean)`);
      } catch (err) {
        actions.push(`Failed to auto-clean ${ws.project}: ${err.message}`);
      }
    }
  }

  // Step 8: Print summary
  console.log(`\n=== Shepherd Run: ${ts} ===`);
  console.log(`Tasks: ${tasksByStatus.open.length} open, ${tasksByStatus.in_progress.length} in progress, ${tasksByStatus.blocked.length} blocked, ${tasksByStatus.closed.length} closed`);
  console.log(`Workspaces: ${running.length} running, ${exited.length} exited, ${stopped.length} stopped`);
  if (actions.length > 0) {
    console.log("Actions taken:");
    for (const a of actions) console.log(`  - ${a}`);
  } else {
    console.log("No actions needed.");
  }
  console.log("===\n");
}

// Auto-run when executed directly (standalone mode — no ctx, uses HTTP)
if (require.main === module) {
  run(null);
}

module.exports = { run };
