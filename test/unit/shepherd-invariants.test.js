/**
 * Shepherd & completion pipeline invariant tests — source-level assertions.
 *
 * Same pattern as persistence-invariants.test.js: grep source files for
 * critical patterns that must never be removed by refactoring.
 *
 * Each test documents a production bug and guards against regression.
 */

const fs = require("fs");
const path = require("path");

const LIB = path.join(__dirname, "..", "..", "lib");

const shepherdJs = fs.readFileSync(path.join(LIB, "shepherd.js"), "utf-8");
const completionJs = fs.readFileSync(path.join(LIB, "completion.js"), "utf-8");
const workspaceStateJs = fs.readFileSync(path.join(LIB, "workspace-state.js"), "utf-8");
const claudeChatJs = fs.readFileSync(path.join(LIB, "claude-chat.js"), "utf-8");

// =========================================================================
// SHEPHERD INVARIANTS
// =========================================================================

describe("shepherd.js invariants", () => {
  it("must handle both 'exited' AND 'stopped' workspaces", () => {
    // HISTORY: The original Step 6 only iterated `exited` workspaces.
    // Dead tmux sessions report status "stopped" (not "exited"), so the
    // shepherd never noticed dead workers. Tasks stayed in_progress forever.
    //
    // The fix combines: const deadWorkspaces = [...exited, ...stopped]
    const hasStoppedHandling = /stopped/.test(shepherdJs) &&
      /exited/.test(shepherdJs) &&
      /deadWorkspaces/.test(shepherdJs);

    expect(hasStoppedHandling, [
      "FATAL: shepherd.js must handle both 'exited' AND 'stopped' workspaces.",
      "Dead tmux sessions report 'stopped', not 'exited'. Without handling both,",
      "the shepherd never notices dead workers and tasks stay in_progress forever.",
    ].join("\n")).toBe(true);
  });

  it("extractTaskId must coerce strings to integers", () => {
    // HISTORY: Branch regex returns string "45", but taskMap uses integer
    // keys (45 from SQLite). Map.get("45") !== Map.get(45), so lookups
    // silently returned undefined and the shepherd never matched tasks
    // to workspaces.
    const hasParseInt = /extractTaskId/.test(shepherdJs) &&
      /parseInt/.test(shepherdJs);

    expect(hasParseInt, [
      "FATAL: extractTaskId must coerce string task IDs to integers.",
      "Branch names yield strings ('45'), SQLite yields integers (45).",
      "Map.get('45') !== Map.get(45) — without parseInt, task lookups silently fail.",
    ].join("\n")).toBe(true);
  });

  it("must use -p flag for worker prompt delivery, not sendKeys", () => {
    // HISTORY: Workers were started with setTimeout(sendKeys, 5000) which
    // was a race condition — the tmux session might not be ready, or Claude
    // might not have started yet. Workers would sit idle with empty panes.
    //
    // Fix: write prompt to temp file and pass via -p flag.
    const usesPFlag = /\-p\s/.test(shepherdJs) || /-p\s+["']/.test(shepherdJs);
    const usesSendKeysForPrompt = /sendKeys.*workerPrompt|sendKeys.*prompt/i.test(shepherdJs);

    expect(usesPFlag, [
      "shepherd.js must use -p flag for worker prompt delivery.",
      "sendKeys is a race condition — the tmux session may not be ready.",
      "Use -p with a temp file for reliable prompt delivery.",
    ].join("\n")).toBe(true);

    expect(usesSendKeysForPrompt, [
      "shepherd.js must NOT use sendKeys for worker prompts.",
      "sendKeys is unreliable for initial prompt delivery — use -p flag instead.",
    ].join("\n")).toBe(false);
  });

  it("must enforce invariants before dispatching", () => {
    // The enforceInvariants step catches orphaned in_progress tasks,
    // duplicate assignees, and stale workspace tags before the shepherd
    // takes any action. Without it, bad state accumulates silently.
    const hasInv1 = /INV-1/.test(shepherdJs);
    const hasInv2 = /INV-2/.test(shepherdJs);
    const hasInv3 = /INV-3/.test(shepherdJs);

    expect(hasInv1, "shepherd must check INV-1: orphaned in_progress tasks").toBe(true);
    expect(hasInv2, "shepherd must check INV-2: duplicate assignees").toBe(true);
    expect(hasInv3, "shepherd must check INV-3: stale closed-task tags").toBe(true);
  });
});

// =========================================================================
// COMPLETION PIPELINE INVARIANTS
// =========================================================================

describe("completion.js invariants", () => {
  it("parseAgentJson fallback must default to 'fail', not 'pass'", () => {
    // HISTORY: When the verification or review agent returns garbage (not valid JSON),
    // parseAgentJson returns null. The fallback logic checked for '"fail"' in the text
    // and defaulted to "pass" if not found. This means garbage output → pass → task
    // auto-closed without real verification.
    //
    // Fix: check for '"pass"' instead, defaulting to "fail" on garbage.
    //
    // Look for the fallback patterns after parseAgentJson calls.
    // The fallback must include '"pass"' check (not '"fail"' check) to default to fail.
    const verifyFallback = completionJs.match(/parseAgentJson\(verifyResult[\s\S]*?\|\|\s*\{([\s\S]*?)\}/);
    const reviewFallback = completionJs.match(/parseAgentJson\(reviewResult[\s\S]*?\|\|\s*\{([\s\S]*?)\}/);

    expect(verifyFallback, "verification fallback must exist after parseAgentJson").toBeTruthy();
    expect(reviewFallback, "review fallback must exist after parseAgentJson").toBeTruthy();

    // The fallback should check for "pass" (safe default: fail if not explicitly pass)
    // NOT check for "fail" (unsafe default: pass if not explicitly fail)
    const verifyBody = verifyFallback[1];
    const reviewBody = reviewFallback[1];

    const verifyDefaultsToFail = /includes\s*\(\s*['"]\\"pass\\?["']\s*\)/.test(verifyBody) ||
      /includes\s*\(\s*['"]"pass"['"]/.test(verifyBody);
    const reviewDefaultsToFail = /includes\s*\(\s*['"]\\"pass\\?["']\s*\)/.test(reviewBody) ||
      /includes\s*\(\s*['"]"pass"['"]/.test(reviewBody);

    expect(verifyDefaultsToFail, [
      "FATAL: verification fallback must check for '\"pass\"' (defaulting to fail).",
      "Checking for '\"fail\"' defaults garbage output to pass — auto-closing unverified tasks.",
    ].join("\n")).toBe(true);

    expect(reviewDefaultsToFail, [
      "FATAL: review fallback must check for '\"pass\"' (defaulting to fail).",
      "Checking for '\"fail\"' defaults garbage output to pass — auto-closing unreviewed tasks.",
    ].join("\n")).toBe(true);
  });
});

// =========================================================================
// WORKSPACE-STATE INVARIANTS
// =========================================================================

describe("workspace-state.js invariants", () => {
  it("save() must use atomic writes (write tmp then rename)", () => {
    // HISTORY: writeFileSync directly to the state file risks corruption
    // if the process crashes mid-write (e.g. SIGKILL from launchctl timeout).
    // Atomic write: write to .tmp, then rename (which is atomic on POSIX).
    const hasAtomicWrite = /\.tmp/.test(workspaceStateJs) &&
      /renameSync/.test(workspaceStateJs);

    expect(hasAtomicWrite, [
      "workspace-state.js save() must use atomic writes.",
      "Write to a .tmp file first, then renameSync to the final path.",
      "Direct writeFileSync risks corruption on crash (truncated JSON).",
    ].join("\n")).toBe(true);
  });
});

// =========================================================================
// CLAUDE-CHAT RELAY INVARIANTS
// =========================================================================

describe("claude-chat.js relay invariants", () => {
  it("socket close handler must fire doneCallback if relay_exit was not received", () => {
    // HISTORY: When the relay daemon crashes without sending relay_exit,
    // the socket close handler only called deleteRelay() — it never fired
    // doneCallback(). This left streaming state stuck forever and the UI
    // never received a "done" event. Users saw permanent loading spinners.
    //
    // Fix: fire doneCallback in the close handler, guarded by doneFired flag
    // to prevent double-fire when relay_exit + close both fire normally.
    const hasDoneFireGuard = /doneFired/.test(claudeChatJs);
    const closeHandlerFiresDone = /socket\.on\s*\(\s*["']close["'][\s\S]*?doneCallback/.test(claudeChatJs);

    expect(hasDoneFireGuard, [
      "claude-chat.js must have a doneFired guard to prevent double-firing doneCallback.",
      "relay_exit fires doneCallback, then socket close fires — without a guard,",
      "doneCallback runs twice, causing duplicate 'done' broadcasts.",
    ].join("\n")).toBe(true);

    expect(closeHandlerFiresDone, [
      "FATAL: socket 'close' handler must call doneCallback when relay_exit was not received.",
      "Without this, relay crashes leave streaming stuck forever — permanent loading spinners.",
    ].join("\n")).toBe(true);
  });
});
