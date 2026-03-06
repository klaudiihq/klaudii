# Klaudii Feature Test Results

Date: 2026-03-05

---

## Test 1: AskUserQuestion Tool — PASS (with bug)

### Round 1:
- Only one card appeared: ✅
- Clicking an option highlights it and greys out others: ✅ (mostly)
- Answer received correctly: ✅
- **Bug (FIXED):** First unselected option appeared blue — now fixed, all non-selected options grey out correctly.

### Round 2:
- Only one card appeared: ✅
- Selection highlighting correct, all others greyed out: ✅
- Answer received correctly: ✅
- **Bug:** A tool result pill appeared after the card showing the raw tool ID and result text (e.g. `toolu_01UwibM2SXo176v92gitzkdp` with the result body). The AskUserQuestion result should be absorbed into the card UI, not shown as a separate tool pill.

---

## Test 2: Runtime Model Switching — PASS

### Round 1: FAIL (stale JS)
- User switched to Opus, model reported Sonnet — switch did not take effect

### Round 2: PASS
- User switched to Opus, model reported: `claude-opus-4-6` (Opus 4.6) ✅
- Previous failure was stale JS cache

---

## Test 3: Edit Tool — Color Diff — PASS

### Round 1: FAIL (stale JS)
- No color diff rendered; tool pills stuck as pending

### Round 2: PASS
- Color diffs confirmed working by user ✅
- (Previous failures were stale JS cache)

---

## Test 4: Cost and Token Footer — FAIL

### Round 1 & 2: FAIL
- No cost/token footer visible on any messages across entire conversation ✗
- Not a stale JS issue — still absent after refresh
- **Feature Request:** Rather than per-message footers, user would prefer a **cumulative conversation cost/token counter** displayed persistently in the chat input area — between the model selector and the send button.

---

## Test 5: Thinking Blocks — BLOCKED (extended thinking not implemented)

### Round 1: BLOCKED (model switching broken)
### Round 2: BLOCKED (extended thinking not available even on Opus)
- No thinking toggle or extended thinking model variant in the dropdown
- **Feature Request:** User should explicitly control extended thinking — do NOT auto-enable it. Two options to consider:
  1. A toggle in the input area to enable/disable extended thinking for the current model
  2. List thinking-capable models twice in the model dropdown (e.g. "Opus" and "Opus (Extended Thinking)")

---

## Test 6: Permission Request — SKIPPED

- User is running in bypass/yolo mode; permission prompts are not triggered

---

## Test 7: Long-Running Tool — Elapsed Time — PARTIAL PASS

### Round 1: FAIL (stale JS)
- Tool pill stuck spinning forever

### Round 2: PASS (partial)
- Tool pill showed spinner for ~5 seconds, then finalized ✅
- No elapsed time counter observed ✗ (CLI throttles `tool_progress` events to 30s intervals, so short commands won't trigger one)
- Spinner + finalization working correctly
- **Feature Request:** Show a client-side elapsed time counter on tool pills while running — don't rely solely on `tool_progress` events from the CLI. Start a local timer when the tool starts, display it on the pill, and stop it when the result arrives.

---

## Test 8: Result Error — Max Turns — INFORMATIONAL (not tested)

- User informed: max turns → red banner "Claude reached the maximum number of turns"; budget exceeded → "Claude exceeded the budget limit"

---

## Test 9: System Note — Context Compaction — INFORMATIONAL (not tested)

- User informed: context compaction appears as a thin centered note, e.g. "Context compacted (was ~120k tokens)"

---

## Test 10: Stop / Interrupt — PARTIAL PASS (multiple bugs)

- First attempt (stale JS): mid-stream message acted as hard interrupt — killed response immediately
- Second attempt (fresh JS): mid-stream message acted as **steer** — message received, agent redirected without stopping ✅
- **Steering is implemented and working!** First attempt was stale JS behavior.
- **Feature Request — Message delivery status (WhatsApp-style double checkmarks):**
  Apply to ALL user messages (not just steering), using a progressive checkmark system:
  1. **Single grey check (✓)** — message sent to server / received by backend
  2. **Double grey checks (✓✓)** — message delivered to the CLI / piped into the relay
  3. **Double green checks (✓✓)** — message "seen" / actively being processed by the agent
  This is especially useful for:
  - **Steering messages** where there may be a delay before the agent picks up the new input
  - **Startup** where the CLI process may still be initializing
  - **General UX** — intuitive pattern familiar to WhatsApp users, gives confidence the system is responsive
- **Bug 1 — Message ordering:** After interrupting (first attempt), the assistant's response rendered *before* the user's preceding question. Conversation messages are out of order. (May be stale JS only — needs re-test.)
- **Bug 2 — Stop button stuck:** Stop button remains visible even when no generation is in flight. Should disappear when idle.
- **Feature Request — Send/Stop button UX:**
  - **Send button** should ALWAYS be visible (for starting turns and steering) — never swap it out
  - **Stop button** should appear **next to** the send button (not replacing it) only while a generation is running
  - Stop icon: small and unobtrusive — e.g. a red square-in-circle (⏹) icon
  - When idle: just the send button. During generation: send + stop side by side.

---

## Test 11: Multi-Window Sync — PASS (partial)

### Verified:
1. ✅ Both tabs show the same conversation
2. ✅ **AskUserQuestion sync:** Answering in one tab showed "answered in another window" in the other tab — card was locked out correctly

### Still to verify:
3. Sending a message from either tab appears in both
4. Permission request sync (skipped — bypass mode)
5. Tool state sync (tool pills consistent across tabs)
6. Stop button sync (stopping in one tab reflects in the other)

---

## General Notes

- **Stale JS cache:** User opened a second browser window and the Edit color diff rendered correctly there. Several earlier test failures (especially Test 3 Bug 1, and possibly Tests 2, 4, 7) may have been caused by stale cached JavaScript in the original tab rather than actual bugs. Recommend hard refresh (Cmd+Shift+R) and re-testing failures.
- **Bug — No workspace isolation for draft sync:** The input/draft area synchronization is leaking across different workspaces. Draft state should be scoped per-workspace, not global.
- **Timing bugs:** Possible race conditions observed around message ordering and state sync — likely related to the workspace isolation issue.
- **Bug — Tool pills don't finalize in originating window:** Tool calls complete and show as finalized in *other* windows, but the window that initiated the turn never transitions tool pills from "running" to "done." This suggests the originating window processes tool events differently — possibly the local/optimistic state is not being updated by the incoming tool_result events, or the originating window is skipping its own events (e.g. deduplication logic filtering out results it thinks it already has).
- **Bug — Mystery blue blinking dot:** A blue blinking dot appears in the UI with no clear indication of what it represents. It's also unreliable/intermittent. **Action: Remove it entirely.**
- **Bug — Stale draft state on load:** When loading the dashboard, old/stale state is being synced into the chat draft input area. The draft area should either be empty on load or only show a draft from the current session.
