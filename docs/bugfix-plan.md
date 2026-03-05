# Bug Fix Plan — From Test Results (2026-03-05)

Based on test-results.md from the iosapp testing session.

## Critical Bugs (affecting multiple tests)

### Bug A: Tool pills never finalize in originating window — ✅ FIXED (8292d64)
**Root cause:** `isAskTool` check in `tool_result` handler used `document.querySelector('.gemini-question-card')` which matched ANY existing question card, blocking ALL tool_results.
**Fix:** Removed DOM query fallback, only check toolName regex.

### Bug B: Model switching doesn't take effect — LIKELY STALE JS
**Test affected:** 2
**Implementation verified correct:** `sendControlRequest` sends `{"type":"control_request","request_id":"...","request":{"subtype":"set_model","model":"opus"}}` to relay → Claude stdin. Relay forwards verbatim. Test notes mention stale JS as likely cause for several failures. Needs re-test with fresh JS (cache busted to v=28).

### Bug C: Cost/token footer not showing — ✅ FIXED (8292d64)
**Root cause:** Server consumed `result` event for history persistence and only broadcast `done`. The `result` event with stats never reached the frontend.
**Fix:** Server now broadcasts `result` event (with stats) before `done` in both onEvent and reconnect paths.

## Medium Bugs

### Bug D: First option stays blue after selection (AskUserQuestion) — ✅ FIXED (8292d64)
**Root cause:** `.primary` class on first button overrides `.greyed` opacity.
**Fix:** Remove `.primary` from all buttons when greying, add only to selected.

### Bug E: Stop button stuck visible when idle — ✅ FIXED (92e14c4)
**Root cause:** Single button swapping between Send/Stop states — if streaming flag gets stuck, button stays as Stop.
**Fix:** Separate Send and Stop buttons. Stop button visibility is directly tied to `geminiStreaming` via `display:none` toggle. Send always stays visible (enables steering).

## Feature Requests

### FR1: Cumulative cost counter in input area — TODO
Instead of per-message footers, show cumulative session cost between model selector and send button.

### FR2: Send + Stop button layout — ✅ DONE (92e14c4)
- Send button always visible (for steering mid-stream)
- Stop button: separate small red square icon, appears next to Send during generation
- Hides automatically via `geminiSetStreaming(false)`

### FR3: Extended thinking toggle — TODO
User wants explicit control over extended thinking, not auto-enable.

## Summary
- 4/5 bugs fixed
- 1/3 feature requests implemented
- Bug B needs re-test (implementation looks correct, likely stale JS)
- FR1 and FR3 remaining
