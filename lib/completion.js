// Completion pipeline — 4-stage quality gate for bead completion.
//
// Called when a worker announces it's done. Runs:
//   1. Tests — npm test (or bead spec verification commands)
//   2. Verification agent — ephemeral Claude reviews work vs bead spec
//   3. Code review agent — ephemeral Claude reviews the diff
//   4. Close bead — only if all gates pass
//
// Safety: never auto-closes if ANY gate fails. Ephemeral agents have 2-min timeouts.

const { execSync, spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const BD_CWD = path.resolve(__dirname, "..");
const LOG_PREFIX = "[completion]";

function log(...args) { console.log(LOG_PREFIX, ...args); }
function logErr(...args) { console.error(LOG_PREFIX, ...args); }

// --- bd helpers ---

function bd(cmd) {
  try {
    return JSON.parse(execSync(`bd ${cmd} --json --allow-stale`, { encoding: "utf-8", cwd: BD_CWD, timeout: 10000 }));
  } catch (err) {
    logErr(`bd ${cmd} failed:`, err.message);
    return null;
  }
}

function bdRaw(cmd) {
  try {
    execSync(`bd ${cmd} --allow-stale`, { encoding: "utf-8", cwd: BD_CWD, timeout: 10000 });
  } catch (err) {
    logErr(`bd ${cmd} failed:`, err.message);
  }
}

// --- Ephemeral Claude agent ---

function runEphemeralAgent(claudeBin, prompt, cwd, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const args = ["-p", prompt, "--output-format", "text"];
    const env = { ...process.env, CLAUDECODE: "" };

    const proc = spawn(claudeBin, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let resolved = false;

    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });

    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      proc.kill("SIGTERM");
      resolve({ ok: false, error: "Agent timed out (2 min)" });
    }, timeoutMs);

    proc.on("close", (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true, output: stdout.trim() });
      } else {
        resolve({ ok: false, error: `Exit code ${code}: ${stderr.slice(0, 1000)}` });
      }
    });

    proc.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
  });
}

function parseAgentJson(output) {
  // Strip markdown code fences if present
  const cleaned = output.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

// --- Git helpers ---

function getDiff(workspacePath) {
  const cmds = [
    "git diff origin/main...HEAD",
    "git diff main...HEAD",
    "git diff origin/main HEAD",
    "git diff HEAD~10 HEAD",
  ];
  for (const cmd of cmds) {
    try {
      return execSync(cmd, { cwd: workspacePath, encoding: "utf-8", timeout: 30000 });
    } catch { /* try next */ }
  }
  return "";
}

// --- Stage 1: Run Tests ---

function runTests(workspacePath) {
  const pkgPath = path.join(workspacePath, "package.json");
  if (!fs.existsSync(pkgPath)) {
    return { pass: true, output: "No package.json — tests skipped", skipped: true };
  }

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    if (!pkg.scripts || !pkg.scripts.test || pkg.scripts.test.includes("no test specified")) {
      return { pass: true, output: "No test script configured — tests skipped", skipped: true };
    }
  } catch {
    return { pass: true, output: "Could not read package.json — tests skipped", skipped: true };
  }

  try {
    const output = execSync("npm test 2>&1", {
      cwd: workspacePath,
      encoding: "utf-8",
      timeout: 120000,
    });
    return { pass: true, output };
  } catch (err) {
    const output = (err.stdout || "") + (err.stderr || "") || err.message;
    return { pass: false, output };
  }
}

// --- Send message back to worker ---

function sendToWorker(workspace, message, ctx) {
  const { claudeChat, tmux } = ctx;

  // Try relay-based chat first
  if (claudeChat && claudeChat.isActive(workspace)) {
    claudeChat.appendMessage(workspace, message);
    return true;
  }

  // Fall back to tmux sendKeys for interactive workers
  if (tmux) {
    const tmuxName = tmux.sessionName(workspace);
    if (tmux.sessionExists(tmuxName)) {
      try {
        tmux.sendKeys(tmuxName, message);
        return true;
      } catch (err) {
        logErr(`sendKeys failed for ${workspace}: ${err.message}`);
      }
    }
  }

  return false;
}

// --- Main Pipeline ---

async function runPipeline(beadId, workspace, ctx) {
  const { claudeChat, projects, config } = ctx;

  log(`starting pipeline bead=${beadId} workspace=${workspace}`);

  // Get bead spec
  const bead = bd(`show ${beadId}`);
  if (!bead) {
    return { ok: false, stage: "init", error: `Bead ${beadId} not found` };
  }

  // Get workspace path
  const proj = projects.getProject(workspace);
  if (!proj) {
    return { ok: false, stage: "init", error: `Workspace ${workspace} not found` };
  }
  const workspacePath = proj.path;

  // Find Claude binary
  const claudeBin = claudeChat.getBinPath(config);
  if (!claudeBin) {
    return { ok: false, stage: "init", error: "Claude CLI not found" };
  }

  // ===== Stage 1: Run Tests =====
  log(`stage 1: tests bead=${beadId}`);
  const testResult = runTests(workspacePath);

  if (!testResult.pass) {
    log(`stage 1 FAILED bead=${beadId}`);
    const truncOutput = testResult.output.slice(0, 3000);
    sendToWorker(workspace,
      `Completion pipeline: tests failed. Fix the issues and call completion again.\n\nTest output:\n${truncOutput}`,
      ctx);
    return { ok: false, stage: "tests", error: "Tests failed", output: truncOutput };
  }
  log(`stage 1 PASSED bead=${beadId} (${testResult.skipped ? "skipped" : "passed"})`);

  // ===== Stage 2: Verification Agent =====
  log(`stage 2: verification bead=${beadId}`);
  const diff = getDiff(workspacePath);
  const truncDiff = diff.length > 50000 ? diff.slice(0, 50000) + "\n...(truncated)" : diff;

  const verifyPrompt = [
    "You are a verification agent. Review whether the code changes fulfill the bead specification.",
    "",
    "BEAD SPECIFICATION:",
    bead.description || "(no description)",
    "",
    "GIT DIFF (changes made):",
    truncDiff || "(no changes found)",
    "",
    "Check: Is the Goal met? Are the Specs followed? Does the implementation look complete?",
    "",
    'Respond with ONLY a JSON object — no markdown fences, no explanation:',
    '{"verdict":"pass" or "fail","gaps":["list of specific gaps if any"],"summary":"one sentence"}',
  ].join("\n");

  const verifyResult = await runEphemeralAgent(claudeBin, verifyPrompt, workspacePath);

  if (!verifyResult.ok) {
    logErr(`stage 2 ERROR bead=${beadId}: ${verifyResult.error}`);
    bdRaw(`comment ${beadId} "Completion pipeline: verification agent failed to start — ${verifyResult.error}. Escalating to Shepherd."`);
    return { ok: false, stage: "verify", error: `Verification agent failed: ${verifyResult.error}` };
  }

  const verifyParsed = parseAgentJson(verifyResult.output) || {
    verdict: verifyResult.output.toLowerCase().includes('"fail"') ? "fail" : "pass",
    gaps: [],
    summary: verifyResult.output.slice(0, 500),
  };

  if (verifyParsed.verdict === "fail") {
    log(`stage 2 FAILED bead=${beadId}`);
    // Mark as finished-incomplete (using blocked status + comment)
    bd(`update ${beadId} --status blocked`);
    const gapList = (verifyParsed.gaps || []).map(g => `- ${g}`).join("\n");
    bdRaw(`comment ${beadId} "Completion pipeline: finished-incomplete. Gaps found:\n${gapList}\nSummary: ${verifyParsed.summary}"`);
    return { ok: false, stage: "verify", error: "Verification gaps found", gaps: verifyParsed.gaps, summary: verifyParsed.summary };
  }
  log(`stage 2 PASSED bead=${beadId}`);

  // ===== Stage 3: Code Review Agent =====
  log(`stage 3: code review bead=${beadId}`);

  const reviewPrompt = [
    "You are a code review agent. Review this diff for dangerous patterns, security vulnerabilities,",
    "poor UX, buggy or hard-to-debug flows, and obvious errors.",
    "",
    "GIT DIFF:",
    truncDiff || "(no changes found)",
    "",
    'Classify each issue as "egregious" (must fix before merge) or "minor" (note but don\'t block).',
    "",
    'Respond with ONLY a JSON object — no markdown fences, no explanation:',
    '{"verdict":"pass" or "fail","issues":[{"severity":"egregious" or "minor","description":"..."}],"summary":"one sentence"}',
    'If there are no issues: {"verdict":"pass","issues":[],"summary":"No issues found."}',
  ].join("\n");

  const reviewResult = await runEphemeralAgent(claudeBin, reviewPrompt, workspacePath);

  if (!reviewResult.ok) {
    logErr(`stage 3 ERROR bead=${beadId}: ${reviewResult.error}`);
    bdRaw(`comment ${beadId} "Completion pipeline: code review agent failed — ${reviewResult.error}. Escalating to Shepherd."`);
    return { ok: false, stage: "review", error: `Code review agent failed: ${reviewResult.error}` };
  }

  const reviewParsed = parseAgentJson(reviewResult.output) || {
    verdict: reviewResult.output.toLowerCase().includes('"fail"') ? "fail" : "pass",
    issues: [],
    summary: reviewResult.output.slice(0, 500),
  };

  // Log minor issues as bead comments (non-blocking)
  const minorIssues = (reviewParsed.issues || []).filter(i => i.severity === "minor");
  if (minorIssues.length > 0) {
    const minorList = minorIssues.map(i => `- ${i.description}`).join("\n");
    bdRaw(`comment ${beadId} "Code review — minor issues (non-blocking):\n${minorList}"`);
  }

  // Check for egregious issues
  const egregiousIssues = (reviewParsed.issues || []).filter(i => i.severity === "egregious");
  if (egregiousIssues.length > 0) {
    log(`stage 3 FAILED bead=${beadId} (${egregiousIssues.length} egregious issues)`);
    const issueList = egregiousIssues.map(i => `- ${i.description}`).join("\n");
    sendToWorker(workspace,
      `Completion pipeline: code review found issues that must be fixed. Fix them and call completion again.\n\nIssues:\n${issueList}`,
      ctx);
    return { ok: false, stage: "review", error: "Egregious issues found", issues: egregiousIssues };
  }
  log(`stage 3 PASSED bead=${beadId}`);

  // ===== Stage 4: Close Bead =====
  log(`stage 4: closing bead=${beadId}`);
  bdRaw(`close ${beadId} --reason "Completed — all quality gates passed"`);

  const summary = [
    `Bead ${beadId} completed. All quality gates passed.`,
    `Verification: ${verifyParsed.summary}`,
    `Code review: ${reviewParsed.summary}`,
  ].join("\n");

  sendToWorker(workspace, `Completion pipeline: ${summary}`, ctx);

  log(`pipeline complete bead=${beadId}`);
  return { ok: true, stage: "done", summary };
}

module.exports = { runPipeline };
