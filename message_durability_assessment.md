# Message Durability Assessment

> Assessment of the Claude chat relay and persistence architecture.
> Branch: `geminisupport` — as of 2026-03-05.

---

## Overview

The Claude chat pipeline uses a **three-layer durability architecture** to ensure no assistant responses are lost across server restarts, crashes, or mid-stream workspace switches. The layers are: the relay daemon's raw event log, a normalized stream log, and the final session history files.

This document describes how each layer works, identifies load-bearing mechanisms that are easy to accidentally break, and recommends safeguards.

---

## Architecture: The Three Layers

### Layer 1 — Relay Daemon Event Log

**File**: `/tmp/klaudii-relay/{workspace}/events.log`

The relay daemon (`lib/relay-daemon.js`) is a detached Node.js process that outlives server restarts. It manages one Claude subprocess per workspace and owns a Unix socket (`relay.sock`) that the server connects to.

Every line from Claude's stdout is **write-through appended** to `events.log` before being broadcast to socket clients. This means even if the relay itself crashes mid-event, the log contains everything Claude emitted up to that point.

When the server reconnects after a restart, the relay replays the entire `events.log` first, followed by a `relay_replay_end` sentinel, then resumes live events. This ensures the server can reconstruct any in-progress turn from scratch.

### Layer 2 — Normalized Stream Log

**File**: `{CONVERSATIONS_DIR}/stream-claude-chat-{workspace}.jsonl`

Inside `connectRelay()` in `lib/claude-chat.js`, every incoming live event is written to this file **before** the `eventCallback` is invoked into `server.js`. The ordering matters: if the server crashes after logging but before its in-memory accumulator is updated, the stream log is the recovery source.

The log contains normalized events (message, tool_use, tool_result). It is deleted once `pushHistoryBatch()` completes on turn-end. If the server crashes before deletion, `recoverStreams()` on the next startup finds the orphaned file and persists its content.

### Layer 3 — Session History Files

**File**: `{CONVERSATIONS_DIR}/{workspace}/claude-local/{session}.json`

`pushHistoryBatch()` is the **only** write path to history files. It performs an atomic write (temp file + rename) to avoid partial reads. It is only ever called when a `result` event fires — real or synthetic.

---

## The Load-Bearing Mechanism: Synthetic `result` Events

Claude's `--input-format stream-json` mode **never emits native `result` events**. This is the most important fact in the whole system.

`normalizeEvent()` in `lib/claude-chat.js` works around this by emitting a **synthetic `result`** whenever a `user` event arrives — a user message means the previous assistant turn is complete. This synthetic event is the **sole trigger** for `pushHistoryBatch()` and everything downstream: turn-end persistence, streaming state reset, `done` broadcast to clients.

Without it, assistant responses accumulate in memory and are never written to disk.

There is a second synthetic `result` path: `flushTurn()`, called by `appendMessage()` before writing a new user message. Its purpose is the same — persist any text-only assistant turn that completed between two user messages, since no user event will arrive to trigger the first path.

---

## Server Restart Recovery: `reconnectActiveRelays`

On startup, `claudeChat.reconnectActiveRelays()` scans `/tmp/klaudii-relay/` for workspace directories with live PID files. For each surviving relay, it calls `connectRelay()` with two callbacks:

**`replayCallback`**: Processes each replayed event. Accumulates assistant text and tool events. When a `result` event is replayed, checks whether the last entry in the session history file is a user message — if yes, the server crashed before persisting that turn, so it persists now. If the last entry is already an assistant message, the turn was already persisted and the check skips.

**`replayDoneCallback`**: Fires once after all replayed events are processed. Handles the case where a **text-only turn completed before the server restarted** but no user follow-up had arrived yet — meaning no native `result` event fired and the replay has no `result` to trigger persistence. If `replayAssistantText` is non-empty and the last history entry is a user message, it persists the content and clears the stream log.

After replay, the `_replay_seed` synthetic event carries accumulated text to the server's `onEvent` handler so the in-memory `assistantText` accumulator starts with pre-restart content rather than empty string.

---

## The `_flush` Flag

`flushTurn()` emits `{ type: "result", _flush: true }`. The server's `result` handler checks `!event._flush` before calling `setStreaming(false)`, `touchChatActivity()`, and broadcasting a `done` event to clients. Without this guard, the synthetic flush before a new message would prematurely signal turn completion to all connected browsers.

---

## Identified Risks

### Risk 1 — `normalizeEvent`'s synthetic `result` looks like dead code

**Severity: High**

The `user` event case in `normalizeEvent` emits a synthetic `result` before processing tool results. Since Claude never emits a real `result` in stream-json mode, this line looks like it could be an overly cautious no-op. An engineer unfamiliar with the context could remove it or defer it.

Result: all assistant responses stop persisting silently. The streaming UI continues working because events still flow to the client — the bug only manifests when the page reloads or the server restarts.

**Recommended fix**: Add an explicit warning comment at the `user` case:

```js
// ⚠️  LOAD-BEARING: Claude's --input-format stream-json never emits "result"
// events. This synthetic "result" is the ONLY trigger for pushHistoryBatch()
// and turn-end persistence. Removing or deferring it silently loses all
// assistant responses (streaming still works, so the bug is invisible until
// page reload or server restart).
```

### Risk 2 — FD inheritance regression

**Severity: High**

The relay daemon startup previously included a loop closing inherited file descriptors (FDs 3–255). This was added specifically to prevent relay daemons from inheriting the server's TCP listening socket (port 9876), which caused them to appear in `lsof -ti :9876` output and get killed alongside the server when using `lsof -ti :9876 | xargs kill -9` to restart.

The loop was subsequently removed. `spawn()` with `stdio: "ignore"` only redirects FDs 0–2; FDs 3+ including the TCP socket are still inherited. If the restart workflow ever uses that `lsof` command, relay daemons will be killed on restart, defeating the entire survive-restart design. In-flight turns at the time of restart will be lost.

**Recommended fix**: Either restore the FD cleanup loop, or document that the restart command must target the server PID directly (`kill $(cat server.pid)` or `pkill -f "node server.js"`) and must never use `lsof -ti :PORT`.

### Risk 3 — `getHistory` vs `readSessionHistory` in reconnect

**Severity: Medium**

`reconnectActiveRelays` uses `readSessionHistory(ws, num)` directly, not the public `getHistory()` function. The distinction is critical: `getHistory()` merges the stream log content into the returned history. During reconnect, the stream log from the previous server run is still on disk (not yet deleted). If `getHistory()` were used, the "last entry is user?" check would see an assistant entry from the merged stream log and conclude the turn was already persisted — silently skipping persistence.

**Recommended fix**: Add a comment at the `readSessionHistory` call:

```js
// Use readSessionHistory, NOT getHistory — getHistory merges the in-progress
// stream log, which makes a still-unpersisted turn look already persisted,
// causing the persistence check to silently skip it.
```

### Risk 4 — `partialStreams` not cleared on `handle.kill()`

**Severity: Low**

`partialStreams` is cleared on `result` event, relay exit, and socket error. If a session is stopped via `handle.kill()` before the relay sends a `relay_exit` event (e.g., process killed with SIGKILL), the Map entry persists. On the next session for the same workspace, `_replay_seed` would seed the server's accumulator with stale text from the killed session.

**Recommended fix**: Call `partialStreams.delete(workspace)` inside `handle.kill()`.

### Risk 5 — Stale relay directories in `/tmp/klaudii-relay/`

**Severity: Low**

`reconnectActiveRelays` scans for any directory with a PID file. Deleted workspaces leave behind relay directories indefinitely. On each startup, the server attempts and fails to connect to each stale socket. Currently harmless (error logged, handled gracefully), but the list grows without bound.

**Recommended fix**: After a failed connect (socket does not exist, relay is dead), delete the relay directory.

### Risk 6 — Double `result` handler paths missing `_flush`

**Severity: Medium**

The `_flush` guard exists in two places: the WebSocket `onEvent` handler and the `reconnectActiveRelays` `onEvent` handler. If a new handler path is added (e.g., a REST-based message endpoint, a background agent runner) and the author doesn't know about `_flush`, it will broadcast premature `done` events during multi-message sessions.

**Recommended fix**: Extract the `result` handling into a shared function with the `_flush` guard built in, rather than having the pattern duplicated inline.

---

## Invariants Summary

These invariants must hold for the system to be correct. Any change to the relay/persistence code should verify each one:

| # | Invariant | Where enforced |
|---|-----------|----------------|
| 1 | `pushHistoryBatch` is only called on `result` events (real or synthetic) | `server.js` onEvent handler |
| 2 | Stream log is written before `eventCallback` fires | `connectRelay()` live event path |
| 3 | Relay daemon is not killed on server shutdown | `gracefulShutdown()` in `server.js` |
| 4 | Replay uses `readSessionHistory`, not `getHistory` | `reconnectActiveRelays` replayCallback |
| 5 | `_flush: true` suppresses `done` broadcast and streaming state reset | `result` handler in both onEvent paths |
| 6 | `flushTurn()` is called before every `appendMessage()` write | `appendMessage()` in `claude-chat.js` |
| 7 | `recoverStreams()` skips workspaces where relay is still alive | `recoverStreams()` in `claude-chat.js` |
| 8 | `partialStreams` is cleared when a turn ends or relay dies | `result` handler, relay exit, socket error |

---

## Event Flow Reference

### Normal turn (first message)

```
sendMessage() → startRelay() → relay spawns Claude
Claude emits: system/init, message events
  → relay appends to events.log
  → relay broadcasts to server socket
    → server accumulates assistantText
    → stream log written (before eventCallback)
    → WebSocket clients receive streaming updates
User sends second message:
  → appendMessage() calls flushTurn()
    → synthetic result fires
    → pushHistoryBatch() persists first turn
    → stream log deleted
  → new user message written to relay socket
```

### Server crash mid-turn

```
Server crashes (Claude relay keeps running)
Stream log on disk: partial turn content
Server restarts
  → reconnectActiveRelays() finds live relay PID
  → connectRelay() with replayCallback + replayDoneCallback
  → relay streams entire events.log
  → replayCallback checks: last history entry = user? → persist
  → replayDoneCallback: text-only turn? → persist + delete stream log
  → _replay_seed emitted: seeds server assistantText accumulator
  → live events resume; clients see partial content via stream-partial endpoint
```

### Both server and relay crash

```
Server and relay both dead
Stream log on disk: partial turn content
Server restarts
  → recoverStreams() finds orphaned stream-claude-chat-{ws}.jsonl
  → Relay is dead (isRelayAlive returns false) → don't skip
  → Reads log, persists content, deletes log
```

---

## Files Referenced

| File | Role |
|------|------|
| `lib/relay-daemon.js` | Detached Claude subprocess manager, event log owner |
| `lib/claude-chat.js` | Relay lifecycle, event normalization, history persistence, recovery |
| `server.js` | WebSocket routing, onEvent handlers, startup/shutdown orchestration |
| `lib/gemini.js` | Gemini backend — same stream log pattern, parallel implementation |
