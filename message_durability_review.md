# Message Durability Assessment — Review

> Feedback on `message_durability_assessment.md` from an engineer who debugged and fixed the persistence bugs described.
> Branch: `geminisupport` — 2026-03-05.

---

## Overall

The assessment correctly identifies the three-layer architecture, the load-bearing role of synthetic `result` events, and most of the recovery paths. The invariants table and event flow diagrams are accurate and useful. Below are corrections, missing risks, and notes on the risk severity assessments.

---

## Corrections

### Layer 1 is NOT write-through

The doc describes the relay daemon's event log as "write-through appended":

> Every line from Claude's stdout is **write-through appended** to `events.log` before being broadcast to socket clients.

This is incorrect. The relay daemon uses `fs.createWriteStream()` with `logStream.write()` (`relay-daemon.js:95-103`). Node.js writable streams are **buffered** — data is queued in userspace and flushed to the kernel asynchronously. If the relay daemon is killed with SIGKILL (or crashes from an unhandled exception), buffered events may be lost from Layer 1 even though they were already broadcast to connected socket clients.

Compare to Layer 2, which uses `fs.appendFileSync()` (`claude-chat.js:265`) — that IS synchronous and write-through.

This means Layer 1's durability guarantee is weaker than described. In practice, the server's Layer 2 stream log (appendFileSync) is the actual crash-recovery source for server restarts. Layer 1 matters mainly for relay daemon restarts (which don't happen — the relay is designed to live until Claude exits). But the doc should not overstate the guarantee.

**Suggested fix**: Replace "write-through appended" with "buffered append" and note that Layer 2 is the true synchronous write-ahead log.

### Risk 2 — FD Inheritance: CRITICAL — Recommendation Would Re-Break Everything

The doc correctly identifies the FD inheritance issue but its first recommended fix is **catastrophically wrong** and must be removed or corrected before anyone acts on this document:

> **Recommended fix**: Either restore the FD cleanup loop, or document that the restart command must target the server PID directly...

**NEVER restore the FD cleanup loop.** This is not a matter of opinion or tradeoff. The loop (`for (let fd = 3; fd < 256; fd++) { fs.closeSync(fd); }`) was the direct cause of the production-breaking "relay socket never appeared" bug (commit `5e4078d`, reverted in `34a01b8`). It closes Node.js internal file descriptors — libuv's event loop fd, V8 platform fds, internal pipe fds — which **silently and immediately kills the relay daemon process**. The relay starts, spawns Claude, then dies because its own event loop is destroyed. No error message. No log output. Just a dead process and a socket that never appears.

This bug took hours of systematic debugging to isolate. The failure mode is completely silent — the relay process exits with no stderr output, no crash log, nothing. The only symptom is "relay socket never appeared" after a 5-second timeout.

The doc frames this as a tradeoff ("restore the loop OR change the restart command"). **It is not a tradeoff.** One option works. The other totally breaks the system. Presenting them as equivalent alternatives is dangerous — the next engineer who reads this will pick the "cleaner" option (the loop) and silently break all chat persistence.

The assessment doc MUST either:
- Remove the "restore the FD cleanup loop" recommendation entirely, or
- Replace it with an explicit **"NEVER DO THIS"** warning explaining why

Correct alternatives for the FD inheritance concern:
1. Set `FD_CLOEXEC` on the server's listening socket before spawning the relay (Node.js doesn't expose this directly, but `server._handle.fd` + a native addon or `fcntl` call could work).
2. Use the `lsof` approach but filter by PID: `kill $(cat /tmp/klaudii-relay/server.pid)` or via launchctl.
3. Accept the inheritance and document that `lsof -ti :PORT | xargs kill` must not be used as a restart method (the launchctl plist already handles restarts correctly).

Option 3 is the pragmatic choice since the server already runs as a launchctl agent with `KeepAlive: true`.

---

## Missing Risks

### Missing Risk — No fsync in atomic history write

`writeSessionHistory()` (`claude-chat.js:52-58`) performs a temp-file-then-rename pattern:

```js
fs.writeFileSync(tmp, JSON.stringify(messages, null, 2));
fs.renameSync(tmp, dest);
```

This is atomic with respect to readers (they see the old file or the new file, never a partial write). But without `fsync` on the temp file before renaming, a power loss or kernel panic can leave the renamed file with zero bytes or partial content — the data may be in the page cache but not on disk. On macOS with APFS this is less likely than on Linux/ext4, but the guarantee is missing.

For a system whose entire point is "no message loss", this is worth noting. Either call `fs.fdatasyncSync(fd)` before renaming, or accept the (small) risk and document it.

### Missing Risk — `createWriteStream` buffering in relay daemon

As noted above, the relay daemon's `logStream.write()` is buffered. If the relay process is SIGKILL'd (e.g., OOM killer, user `kill -9`), the events.log on disk may be behind what was broadcast to the server. On the next server restart, `reconnectActiveRelays` will find the relay dead and fall through to `recoverStreams()`, which reads the stream log (Layer 2). But if the server was also down, Layer 2 doesn't exist — the only recovery source is Layer 1's events.log, which may be incomplete.

This scenario (relay SIGKILL'd while server is also down) is unlikely but violates the "zero message loss" goal.

**Fix**: Replace `createWriteStream` + `.write()` with `fs.appendFileSync()` in the relay daemon's stdout handler. The throughput cost is negligible — Claude CLI output is at most a few KB/s of text.

### Missing Risk — `CLAUDECODE` env var must be stripped

Claude CLI refuses to start if the `CLAUDECODE` environment variable is set (it detects it's inside another Claude Code session). The relay daemon strips it (`relay-daemon.js:70`), and `startRelay` also sets `CLAUDECODE: ""` in the relay env (`claude-chat.js:109`).

If either of these safeguards is removed, relay daemons silently fail to spawn Claude — the process starts, writes no output, and exits. This should be listed as an invariant.

### Missing Risk — Multi-turn accumulator reset timing

The `replayCallback` in `reconnectActiveRelays` accumulates `replayAssistantText` and `replayToolEvents` across ALL replayed events. When a `result` event fires, it persists and resets the accumulators. But `replayDoneCallback` fires AFTER the last replay event — if the last replayed turn had tool use AND text, both the `result` handler (from the synthetic result in `normalizeEvent`) and `replayDoneCallback` could attempt to persist. Currently this doesn't double-persist because the `result` handler resets `replayAssistantText` to `""`, so `replayDoneCallback` sees empty text and skips. But this ordering dependency is fragile and not documented.

---

## Risk Severity Adjustments

### Risk 1 (synthetic `result` looks like dead code) — Agree: High

Correct assessment. The comment recommendation is good but I'd go further: add an integration test that sends two user messages and asserts the first assistant turn is persisted to the history file.

### Risk 3 (`getHistory` vs `readSessionHistory`) — Should be High, not Medium

If someone changes the `readSessionHistory` call to `getHistory` in `reconnectActiveRelays`, turns silently stop being persisted on restart. The failure mode is identical to Risk 1 — invisible until reload. Same severity.

### Risk 4 (`partialStreams` not cleared on `kill()`) — Agree: Low

Confirmed in code: `handle.kill()` at `claude-chat.js:160-168` does not call `partialStreams.delete(workspace)`. The stale `_replay_seed` scenario is real but low impact — the seeded text would be from the killed session and would be overwritten on the next real assistant response. Still worth fixing as a one-line change.

### Risk 6 (double `result` handler paths) — Agree: Medium

The extraction into a shared function is a good idea. Currently the pattern is duplicated at `server.js:583` and `server.js:702`.

---

## Invariants Table — Additions

| # | Invariant | Where enforced |
|---|-----------|----------------|
| 9 | `CLAUDECODE` env var must be empty or absent when spawning Claude CLI | `relay-daemon.js:70`, `claude-chat.js:109` |
| 10 | `writeSessionHistory` uses temp+rename for atomic writes | `claude-chat.js:56-58` |
| 11 | `replayCallback` resets accumulators on `result` before `replayDoneCallback` fires | `reconnectActiveRelays` ordering in `connectRelay` |
| 12 | Relay daemon must NOT close FDs 3+ on startup (destroys Node.js internals) | `relay-daemon.js` — removed loop must not be re-added |

---

## Event Flow Corrections

The "Normal turn" flow diagram is accurate. Two minor notes:

1. The diagram says "relay appends to events.log" — should clarify this is a buffered write, not synchronous. The actual durable write happens at Layer 2 (`appendFileSync` in `connectRelay`).

2. The "Both server and relay crash" flow is correct but should note that if the relay was SIGKILL'd, `events.log` may be incomplete due to buffered writes. `recoverStreams()` reads the stream log (Layer 2), not the relay event log (Layer 1), so this is handled — but only if the server wrote the stream log before it also crashed.

---

## Summary

The assessment is thorough and mostly accurate. The three issues worth addressing immediately:

1. **Don't recommend restoring the FD close loop** — it's the root cause of the bug we just fixed.
2. **Layer 1 is buffered, not write-through** — consider switching the relay daemon to `appendFileSync` for true durability.
3. **Add `CLAUDECODE` stripping as a documented invariant** — it's a silent, total failure mode with no error message.

The remaining items (fsync, accumulator ordering, `partialStreams` cleanup) are worth tracking but lower priority.
