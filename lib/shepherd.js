#!/usr/bin/env node

// Shepherd — periodic monitoring script for Klaudii.
//
// Reads system state (beads + workspaces), takes corrective action, and exits.
// Designed to run every ~5 minutes via cron or Klaudii scheduler.
//
// Usage:
//   node lib/shepherd.js                     # direct invocation
//   bin/shepherd.sh                           # Claude-based invocation (uses shepherd-prompt.md)

const { execSync } = require("child_process");
const path = require("path");

const KLAUDII_URL = process.env.KLAUDII_URL || "http://localhost:9876";
const MAX_CONCURRENT = parseInt(process.env.SHEPHERD_MAX_CONCURRENT || "3", 10);
const STUCK_THRESHOLD_MS = parseInt(process.env.SHEPHERD_STUCK_THRESHOLD || "900000", 10); // 15 min
const REPO_NAME = process.env.SHEPHERD_REPO || "klaudii";
const BD_CWD = path.resolve(__dirname, "..");

function api(method, endpoint, body) {
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

function bd(cmd) {
  try {
    return JSON.parse(execSync(`bd ${cmd} --json`, { encoding: "utf-8", cwd: BD_CWD, timeout: 10000 }));
  } catch (err) {
    console.error(`[shepherd] bd ${cmd} failed:`, err.message);
    return null;
  }
}

function bdRaw(cmd) {
  try {
    execSync(`bd ${cmd}`, { encoding: "utf-8", cwd: BD_CWD, timeout: 10000 });
  } catch (err) {
    console.error(`[shepherd] bd ${cmd} failed:`, err.message);
  }
}

function gitStatus(projectPath) {
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

function run() {
  const actions = [];
  const now = Date.now();
  const ts = new Date().toISOString();

  // Step 1: Read all beads
  const allBeads = bd("list") || [];
  const beadsByStatus = { open: [], in_progress: [], blocked: [], closed: [] };
  for (const b of allBeads) {
    const s = b.status || "open";
    if (beadsByStatus[s]) beadsByStatus[s].push(b);
  }

  // Step 2: Check workspace status
  const sessions = api("GET", "/api/sessions") || [];
  const running = sessions.filter((s) => s.status === "running");
  const exited = sessions.filter((s) => s.status === "exited");
  const stopped = sessions.filter((s) => s.status === "stopped");

  // Build a map of bead ID to bead for quick lookup
  const beadMap = new Map();
  for (const b of allBeads) beadMap.set(b.id, b);

  // Step 3: Monitor in-progress workspaces — check for stuck workers
  for (const ws of running) {
    const idleMs = now - (ws.lastActivity || 0);
    if (ws.lastActivity && idleMs > STUCK_THRESHOLD_MS) {
      const dirty = gitStatus(ws.projectPath);
      // Find the bead assigned to this workspace (by branch name convention bead-<id>)
      const branchMatch = ws.git && ws.git.branch ? ws.git.branch.match(/^bead-(.+)$/) : null;
      const beadId = branchMatch ? branchMatch[1] : null;

      if (dirty) {
        gitAutoSave(ws.projectPath);
        if (beadId) {
          bd(`update ${beadId} --status blocked`);
          bdRaw(`comment ${beadId} "Shepherd: worker stuck for >${Math.round(idleMs / 60000)}min, auto-saved WIP and marked blocked"`);
        }
        actions.push(`Auto-saved WIP in ${ws.project} (idle ${Math.round(idleMs / 60000)}min)${beadId ? `, blocked bead ${beadId}` : ""}`);
      } else {
        // No progress — stop the session
        api("POST", "/api/sessions/stop", { project: ws.project });
        if (beadId) {
          bdRaw(`comment ${beadId} "Shepherd: worker stuck with no progress for >${Math.round(idleMs / 60000)}min, stopped session for retry"`);
        }
        actions.push(`Stopped stuck workspace ${ws.project} (idle ${Math.round(idleMs / 60000)}min, no changes)`);
      }
    }
  }

  // Step 4: Dispatch ready beads
  // Re-check running count after potential stops
  const currentRunning = (api("GET", "/api/sessions") || []).filter((s) => s.status === "running").length;
  let slotsAvailable = MAX_CONCURRENT - currentRunning;

  const readyBeads = beadsByStatus.open
    .filter((b) => !b.assignee)
    .sort((a, b) => (a.priority || 2) - (b.priority || 2));

  for (const bead of readyBeads) {
    if (slotsAvailable <= 0) break;

    const branchName = `bead-${bead.id}`;
    const result = api("POST", "/api/sessions/new", { repo: REPO_NAME, branch: branchName });
    if (!result || !result.ok) {
      actions.push(`Failed to create workspace for bead ${bead.id}`);
      continue;
    }

    bd(`update ${bead.id} --claim`);

    const workspace = result.project;
    const workerPrompt = [
      `Read AGENTS.md for project conventions.`,
      `Then work on bead ${bead.id}.`,
      `Run: bd show ${bead.id} to get the full spec.`,
      `Claim it: bd update ${bead.id} --claim.`,
      `Do the work per the spec. Verify per the spec.`,
      `Close it: bd close ${bead.id} --reason Done.`,
      `When done, commit and push. Use bd export -o .beads/issues.jsonl before committing.`,
    ].join(" ");

    api("POST", `/api/chat/${encodeURIComponent(workspace)}/send`, {
      message: workerPrompt,
      sender: "shepherd",
    });

    slotsAvailable--;
    actions.push(`Dispatched bead ${bead.id} ("${bead.title}") to workspace ${workspace}`);
  }

  // Step 5: Handle blocked beads — simple triage
  for (const bead of beadsByStatus.blocked) {
    if (bead.comment_count > 0) {
      // We can't easily read comments via bd list --json (only count).
      // Show the bead to read comments.
      const detail = bd(`show ${bead.id}`);
      if (detail && detail.comments && detail.comments.length > 0) {
        const lastComment = detail.comments[detail.comments.length - 1];
        // If the last comment is from the shepherd, skip (already handled)
        if (lastComment.body && lastComment.body.startsWith("Shepherd:")) continue;
        // Escalate design questions to architect
        bdRaw(`comment ${bead.id} "Shepherd: seen blocked bead — escalating to Architect"`);
        actions.push(`Escalated blocked bead ${bead.id} ("${bead.title}") to Architect`);
      }
    }
  }

  // Step 6: Handle exited workspaces
  for (const ws of exited) {
    const branchMatch = ws.git && ws.git.branch ? ws.git.branch.match(/^bead-(.+)$/) : null;
    const beadId = branchMatch ? branchMatch[1] : null;

    if (beadId) {
      const bead = beadMap.get(beadId);
      if (bead && bead.status === "closed") continue; // Worker finished successfully

      // Worker may have crashed — check for uncommitted work
      const dirty = gitStatus(ws.projectPath);
      if (dirty) {
        gitAutoSave(ws.projectPath);
        if (bead) {
          bd(`update ${beadId} --status blocked`);
          bdRaw(`comment ${beadId} "Shepherd: worker exited unexpectedly, auto-saved WIP and marked blocked"`);
        }
        actions.push(`Auto-saved WIP in exited workspace ${ws.project}, blocked bead ${beadId}`);
      } else if (bead && (bead.status === "open" || bead.status === "in_progress")) {
        bdRaw(`comment ${beadId} "Shepherd: worker exited with no uncommitted changes, may need retry"`);
        actions.push(`Noted exited workspace ${ws.project} for bead ${beadId} (no dirty files)`);
      }
    }
  }

  // Step 7: Print summary
  console.log(`\n=== Shepherd Run: ${ts} ===`);
  console.log(`Beads: ${beadsByStatus.open.length} open, ${beadsByStatus.in_progress.length} in progress, ${beadsByStatus.blocked.length} blocked, ${beadsByStatus.closed.length} closed`);
  console.log(`Workspaces: ${running.length} running, ${exited.length} exited, ${stopped.length} stopped`);
  if (actions.length > 0) {
    console.log("Actions taken:");
    for (const a of actions) console.log(`  - ${a}`);
  } else {
    console.log("No actions needed.");
  }
  console.log("===\n");
}

run();
