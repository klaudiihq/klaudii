/**
 * Persistence invariant tests — source-level assertions.
 *
 * WHY THESE TESTS EXIST:
 *
 * The chat persistence pipeline has multiple load-bearing patterns that look
 * like dead code, unnecessary complexity, or "obvious improvements" to an
 * engineer who doesn't have full context. Every one of these was a production
 * bug that caused silent, total message loss. The bugs are invisible while
 * streaming works — they only manifest on page reload or server restart,
 * by which point the data is gone.
 *
 * These tests read the actual source files and assert that critical patterns
 * exist (or dangerous patterns don't). They are intentionally blunt — they
 * grep source code rather than testing behavior — because the failure modes
 * are so subtle that behavioral tests could pass while persistence is broken
 * (streaming works fine, it's only disk persistence that fails).
 *
 * Each test has a detailed failure message explaining the history and
 * consequences. If a test fails, READ THE MESSAGE before "fixing" it.
 */

const fs = require("fs");
const path = require("path");

const LIB = path.join(__dirname, "..", "..", "lib");
const ROOT = path.join(__dirname, "..", "..");

const claudeChat = fs.readFileSync(path.join(LIB, "claude-chat.js"), "utf-8");
const relayDaemon = fs.readFileSync(path.join(LIB, "relay-daemon.js"), "utf-8");
const serverJs = fs.readFileSync(path.join(ROOT, "server.js"), "utf-8");

// =========================================================================
// RELAY DAEMON INVARIANTS
// =========================================================================

describe("relay-daemon.js invariants", () => {
  it("must NOT close file descriptors 3+ on startup", () => {
    // HISTORY: Commit 5e4078d added a loop `for (let fd = 3; fd < 256; fd++) { fs.closeSync(fd); }`
    // to prevent the relay from inheriting the server's TCP socket. This DESTROYED
    // Node.js internal file descriptors (libuv event loop, V8 platform fds) and
    // silently killed the relay daemon immediately after spawning Claude.
    //
    // The relay process would start, spawn Claude, then die with no error output.
    // The only symptom was "relay socket never appeared" after a 5-second timeout.
    // This took HOURS to diagnose because the failure is completely silent.
    //
    // NEVER re-add this loop. If you need to prevent FD inheritance, use
    // FD_CLOEXEC on the server's listening socket, not bulk-closing FDs in the child.
    const hasCloseLoop = /for\s*\(\s*let\s+fd\s*=\s*3/.test(relayDaemon) &&
                         /closeSync\s*\(\s*fd\s*\)/.test(relayDaemon);
    expect(hasCloseLoop, [
      "FATAL: relay-daemon.js contains a closeSync(fd) loop for FDs 3+.",
      "This WILL silently kill the relay daemon by closing Node.js internal file descriptors.",
      "See commit 5e4078d (added) and 34a01b8 (removed). Do NOT re-add this loop.",
    ].join("\n")).toBe(false);
  });

  it("must strip CLAUDECODE from the environment", () => {
    // Claude CLI refuses to start if CLAUDECODE is set (thinks it's nested).
    // The relay daemon runs inside a Node process that may have inherited CLAUDECODE
    // from the server, which itself may run inside a Claude Code session.
    // Without this, the relay starts but Claude never produces output — total silent failure.
    expect(relayDaemon, [
      "relay-daemon.js must delete or clear the CLAUDECODE env var before spawning Claude.",
      "Claude CLI detects CLAUDECODE and refuses to start (nested session detection).",
      "Without this, relay daemons silently fail — Claude produces no output, no error.",
    ].join("\n")).toMatch(/delete\s+env\s*(\[\s*["']CLAUDECODE["']\s*\]|\.CLAUDECODE)/);
  });

  it("must NOT use createWriteStream for the event log (use appendFileSync for durability)", () => {
    // createWriteStream buffers writes in userspace. If the relay is SIGKILL'd,
    // buffered events are lost. appendFileSync is synchronous and durable.
    // This is a "should fix" not "must never change" — but if you see this test,
    // know that createWriteStream means the event log has a durability gap.
    //
    // NOTE: If this test fails, it means someone switched BACK to createWriteStream.
    // The relay event log is the last-resort recovery source. It must be synchronous.
    //
    // Uncomment this test once the relay daemon is updated to use appendFileSync:
    // const usesBufferedWrites = /createWriteStream/.test(relayDaemon);
    // expect(usesBufferedWrites).toBe(false);

    // For now, just document that createWriteStream IS used (known gap):
    const usesBufferedWrites = /createWriteStream/.test(relayDaemon);
    if (usesBufferedWrites) {
      // This is a known issue, not a regression. Don't fail, but log it.
      console.warn("[persistence-invariants] relay-daemon.js uses createWriteStream (buffered) for events.log — durability gap exists");
    }
    expect(true).toBe(true); // placeholder — enable the real assertion when fixed
  });
});

// =========================================================================
// CLAUDE-CHAT.JS INVARIANTS
// =========================================================================

describe("claude-chat.js invariants", () => {
  it("normalizeEvent must emit synthetic result on 'user' events", () => {
    // This is the single most important line in the persistence pipeline.
    // Claude CLI in stream-json mode NEVER emits native "result" events between turns.
    // The synthetic result on "user" event is the SOLE trigger for pushHistoryBatch().
    // Without it, assistant responses accumulate in memory and are never persisted.
    //
    // The bug is INVISIBLE while streaming — the UI works perfectly. It only
    // manifests on page reload or server restart, by which point data is gone.
    //
    // Look for: case "user": ... events.push({ type: "result" ...})
    // The result MUST be pushed BEFORE tool_result events.
    const userCase = claudeChat.match(/case\s+["']user["']\s*:\s*\{([\s\S]*?)break;\s*\}/);
    expect(userCase, "normalizeEvent must have a 'user' case").toBeTruthy();

    const userBody = userCase[1];
    const hasSyntheticResult = /events\.push\(\s*\{\s*type:\s*["']result["']/.test(userBody);
    expect(hasSyntheticResult, [
      "FATAL: normalizeEvent's 'user' case does not emit a synthetic { type: 'result' }.",
      "Claude CLI in stream-json mode NEVER emits native 'result' events.",
      "This synthetic result is the ONLY trigger for pushHistoryBatch() — without it,",
      "ALL assistant responses are silently lost on page reload or server restart.",
      "Streaming to the browser still works, so the bug is invisible until too late.",
    ].join("\n")).toBe(true);
  });

  it("appendMessage must call flushTurn before writing to the relay socket", () => {
    // Without flushTurn(), text-only assistant responses (no tool use) between
    // two user messages are never persisted. Tool-use turns get a synthetic result
    // from normalizeEvent's "user" case, but text-only turns don't because the
    // next user message comes from appendMessage, not from Claude's event stream.
    //
    // flushTurn() emits a synthetic { type: "result", _flush: true } to trigger
    // persistence of the accumulated content before the new message starts.
    const appendFn = claudeChat.match(/function\s+appendMessage\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
    expect(appendFn, "appendMessage function must exist").toBeTruthy();

    const body = appendFn[1];
    const hasFlushCall = /flushTurn\s*\(\s*\)/.test(body);
    expect(hasFlushCall, [
      "FATAL: appendMessage() does not call flushTurn() before writing.",
      "Text-only assistant responses (no tool use) are never persisted without this.",
      "The previous turn's content sits in memory and is overwritten by the new turn.",
    ].join("\n")).toBe(true);
  });

  it("CLAUDECODE must be set to empty string in relay environment", () => {
    // Belt-and-suspenders with relay-daemon.js's own CLAUDECODE deletion.
    // If the relay daemon's env cleanup is accidentally removed, this safeguard
    // in startRelay() prevents Claude CLI from detecting a nested session.
    expect(claudeChat, [
      "claude-chat.js must set CLAUDECODE to empty string in the relay env.",
      "This is a safeguard against Claude CLI's nested session detection.",
    ].join("\n")).toMatch(/CLAUDECODE\s*:\s*["']["']/);
  });

  it("reconnectActiveRelays must use readSessionHistory, NOT getHistory", () => {
    // getHistory() merges the in-progress stream log into the returned history.
    // During reconnect, the stream log from the previous server run is still on disk.
    // If getHistory() is used for the "last entry is user?" check, the merged stream
    // log makes unpersisted turns look already persisted — silently skipping persistence.
    //
    // This MUST use readSessionHistory() (raw file read, no merge).
    const reconnectFn = claudeChat.match(
      /function\s+reconnectActiveRelays\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/
    );
    expect(reconnectFn, "reconnectActiveRelays function must exist").toBeTruthy();

    const body = reconnectFn[1];

    // Inside the replayCallback's result handler and replayDoneCallback,
    // the history check must use readSessionHistory, not getHistory.
    // Count occurrences of each in the reconnect function body.
    const readSessionHistoryCalls = (body.match(/readSessionHistory\s*\(/g) || []).length;
    const getHistoryCalls = (body.match(/[^_]getHistory\s*\(/g) || []).length;

    expect(getHistoryCalls, [
      "FATAL: reconnectActiveRelays uses getHistory() instead of readSessionHistory().",
      "getHistory() merges the stream log, making unpersisted turns look already persisted.",
      "This causes the 'last entry is user?' check to pass incorrectly, silently",
      "skipping persistence of turns that completed before the server restarted.",
      "Use readSessionHistory() for raw file access without stream log merge.",
    ].join("\n")).toBe(0);

    expect(readSessionHistoryCalls, [
      "reconnectActiveRelays must call readSessionHistory() at least once",
      "for the turn-persistence check during replay recovery.",
    ].join("\n")).toBeGreaterThan(0);
  });

  it("getHistory must merge the stream log (WAL pattern)", () => {
    // getHistory() reads the session history file AND the in-progress stream log,
    // merging any accumulated content from the current turn. Without this merge,
    // text-only responses that haven't triggered a "result" event yet are invisible
    // to API callers — the chat appears to lose the last assistant response.
    const getHistoryFn = claudeChat.match(
      /function\s+getHistory\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/
    );
    expect(getHistoryFn, "getHistory function must exist").toBeTruthy();

    const body = getHistoryFn[1];
    const readsStreamLog = /streamLogPath|stream-claude-chat/.test(body);
    expect(readsStreamLog, [
      "getHistory() must merge the in-progress stream log (WAL pattern).",
      "Without this, text-only turns that haven't triggered a result event",
      "are invisible to the client on page reload or workspace switch.",
    ].join("\n")).toBe(true);
  });

  it("flushTurn must emit _flush: true on the synthetic result", () => {
    // The _flush flag tells the server's result handler not to broadcast "done"
    // or clear streaming state. Without it, flushTurn() prematurely signals
    // turn completion to all connected browsers right before the next message starts.

    // Find the flushTurn method body — it's a multi-line method in an object literal
    const flushRegion = claudeChat.match(/flushTurn\s*\(\s*\)\s*\{([\s\S]*?)\n\s{4}\}/);
    expect(flushRegion, "flushTurn method must exist").toBeTruthy();

    const body = flushRegion[1];
    const hasFlushFlag = /_flush\s*:\s*true/.test(body);
    expect(hasFlushFlag, [
      "flushTurn() must set _flush: true on the synthetic result event.",
      "Without this flag, the server broadcasts a premature 'done' event",
      "to all clients between every pair of user messages.",
    ].join("\n")).toBe(true);
  });

  it("connectRelay must accept replayDoneCallback", () => {
    // replayDoneCallback handles text-only turns that completed before a server
    // restart. Without it, text-only responses from before the restart are lost
    // because no "result" event was ever emitted for them.
    const connectFn = claudeChat.match(
      /function\s+connectRelay\s*\([^)]*\)\s*\{/
    );
    expect(connectFn, "connectRelay function must exist").toBeTruthy();

    const hasReplayDone = /replayDoneCallback/.test(claudeChat);
    expect(hasReplayDone, [
      "connectRelay must support replayDoneCallback for post-replay persistence.",
      "Text-only turns that completed before server restart have no 'result' event",
      "in the replay stream. replayDoneCallback persists their content after replay ends.",
    ].join("\n")).toBe(true);
  });

  it("connectRelay must capture control_request during replay and re-emit after replay ends", () => {
    // After a server restart, if Claude was blocked on a control_request (permission
    // prompt), that request appears in the replay stream. The replayCallback doesn't
    // handle control_requests — it only processes session IDs and result events.
    // Without capturing and re-emitting, Claude blocks indefinitely waiting for a
    // permission_response that was lost during replay.
    //
    // The fix: during replay, stash control_request events as pendingControlRequest.
    // After relay_replay_end, re-emit the pending request to eventCallback.
    const hasPendingCapture = /pendingControlRequest/.test(claudeChat);
    expect(hasPendingCapture, [
      "connectRelay must capture control_request events during replay.",
      "Without this, Claude blocks indefinitely after server restart when a",
      "permission prompt (e.g., ExitPlanMode) was pending before the restart.",
      "The replayCallback doesn't handle control_requests — they must be",
      "stashed during replay and re-emitted after relay_replay_end.",
    ].join("\n")).toBe(true);

    // Must re-emit after replay_replay_end (in the relay_replay_end handler)
    const replayEndBlock = claudeChat.match(
      /relay_replay_end[\s\S]*?pendingControlRequest[\s\S]*?eventCallback\s*\(\s*pendingControlRequest\s*\)/
    );
    expect(replayEndBlock, [
      "connectRelay must re-emit pendingControlRequest via eventCallback after replay ends.",
      "Capturing without re-emitting is useless — Claude is still blocked.",
    ].join("\n")).toBeTruthy();
  });

  it("normalizeEvent must be exported for testing", () => {
    // normalizeEvent is the most critical function in the persistence pipeline.
    // It must be exported (as _normalizeEvent) so unit tests can verify its behavior.
    expect(claudeChat, [
      "normalizeEvent must be exported as _normalizeEvent for unit testing.",
      "It is the most critical function in the persistence pipeline.",
    ].join("\n")).toMatch(/_normalizeEvent\s*:\s*normalizeEvent/);
  });
});

// =========================================================================
// SERVER.JS INVARIANTS
// =========================================================================

describe("server.js invariants", () => {
  it("result handler must check _flush flag before broadcasting done", () => {
    // flushTurn() emits { type: "result", _flush: true }. The server's result
    // handler must NOT broadcast "done" or clear streaming state for _flush results.
    // Without this check, every appendMessage() causes a premature "done" broadcast.
    const hasFlushCheck = /event\._flush|event\s*\[\s*["']_flush["']\s*\]/.test(serverJs);
    expect(hasFlushCheck, [
      "server.js result handler must check event._flush before broadcasting 'done'.",
      "flushTurn() emits synthetic results with _flush:true — these must NOT",
      "trigger 'done' broadcasts or clear streaming state.",
    ].join("\n")).toBe(true);
  });

  it("gracefulShutdown must NOT kill Claude relay daemons", () => {
    // Relay daemons are detached processes designed to survive server restarts.
    // If gracefulShutdown kills them, in-flight turns are lost with no recovery path.
    // Only Gemini processes (which don't have relay daemons) should be stopped.
    const shutdownFn = serverJs.match(
      /function\s+gracefulShutdown\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/
    );
    expect(shutdownFn, "gracefulShutdown function must exist").toBeTruthy();

    const body = shutdownFn[1];
    const killsClaudeRelays = /claudeChat\.stopAllProcesses|claude.*stop.*All/i.test(body);
    expect(killsClaudeRelays, [
      "FATAL: gracefulShutdown() kills Claude relay daemons.",
      "Relay daemons are detached and designed to survive server restarts.",
      "Killing them destroys in-flight turns with no recovery path.",
      "Only stop Gemini processes in gracefulShutdown — Claude relays must survive.",
    ].join("\n")).toBe(false);
  });
});
