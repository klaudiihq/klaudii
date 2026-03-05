# Bug Fix Plan — From Test Results (2026-03-05)

Based on test-results.md from the iosapp testing session.

## All Bugs Resolved

### Bug A: Tool pills never finalize in originating window — ✅ FIXED (8292d64)
**Root cause:** `isAskTool` check used `document.querySelector('.gemini-question-card')` which matched ANY existing question card, blocking ALL tool_results.
**Fix:** Removed DOM query fallback, only check toolName regex.

### Bug B: Model switching doesn't take effect — ✅ NOT A BUG (confirmed via WS test)
**Verification:** Automated WS test confirmed `set_model` control_request works. The `init` event shows the new model (`claude-sonnet-4-6`), and cost data confirms the switch (Haiku: $0.08, Sonnet: $0.42 for same message). Original test failure was stale JS.

### Bug C: Cost/token footer not showing — ✅ FIXED (8292d64 + 28172df)
**Root cause:** Server consumed `result` event and only broadcast `done`. Fix: broadcast curated result with stats before done.
**Follow-up fix (28172df):** Prevented duplicate result events — generic handler was broadcasting raw result before the curated version.

### Bug D: First option stays blue after selection — ✅ FIXED (8292d64)
**Root cause:** `.primary` class on first button overrides `.greyed` opacity.
**Fix:** Remove `.primary` from all buttons when greying, add only to selected.

### Bug E: Stop button stuck visible when idle — ✅ FIXED (92e14c4)
**Fix:** Separate Send and Stop buttons. Stop button visibility tied directly to `geminiStreaming` flag.

## Feature Requests

### FR1: Cumulative cost counter in input area — TODO
### FR2: Send + Stop button layout — ✅ DONE (92e14c4)
### FR3: Extended thinking toggle — TODO

## Summary: 5/5 bugs resolved, 1/3 feature requests done
