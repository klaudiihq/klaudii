# Bug Fix Plan — From Test Results (2026-03-05)

Based on test-results.md from the iosapp testing session.

## Critical Bugs (affecting multiple tests)

### Bug A: Tool pills never finalize in originating window
**Tests affected:** 3, 7 (and indirectly 4)
**Symptom:** Tool calls show as "running" with spinner forever in the window that sent the message. Other windows see them finalize correctly.
**Root cause hypothesis:** The originating window processes `tool_use` events and creates pills, but when `tool_result` arrives, `geminiUpdateToolResult` can't find the pill. This could be because:
1. The `tool_id` on the `tool_result` event doesn't match what was set on the pill
2. The `tool_result` is being skipped by some filtering logic
3. The `tool_result` event never reaches the originating window

**Debug approach:**
- Add console logging in `handleGeminiEvent` for `tool_result` events to see if they arrive
- Log what `tool_id` is on the event vs what's on the pill's `data-tool-id`
- Check if the AskUserQuestion filter (`isAskTool` check) is too broad and catching non-ask tools

**LIKELY FIX:** In the `tool_result` handler, the `isAskTool` check uses:
```js
const isAskTool = /ask.*question/i.test(toolName) ||
  document.querySelector(`.gemini-question-card`) !== null;
```
The second condition (`document.querySelector('.gemini-question-card')`) is TRUE whenever ANY question card exists in the DOM — even from a previous turn. This means ALL subsequent tool_results get skipped. Fix: remove the DOM query fallback, only check tool_name.

### Bug B: Model switching doesn't take effect
**Test affected:** 2
**Symptom:** User switched dropdown to Opus, but Claude still reported running as Sonnet.
**Root cause hypothesis:** The `set_model` WS message is sent, but the `sendControlRequest` may not be formatting the message correctly for the Claude CLI. The CLI expects the model to be in `request.model`, but we might be putting it elsewhere.
**Debug approach:**
- Check server logs for `set_model` message receipt
- Check `sendControlRequest` output format
- Verify the Claude CLI actually processes `set_model` control_requests in stream-json mode

### Bug C: Cost/token footer not showing
**Test affected:** 4
**Symptom:** No footer visible after messages.
**Root cause hypothesis:** The `result` event handler calls `geminiShowResultFooter(event.stats, ...)` but the stats may be empty `{}` (from the synthetic result event emitted by the `user` case in normalizeEvent). The real `result` event with stats comes separately but may be handled differently.
**Debug approach:**
- Check what stats the `result` event actually contains when it arrives
- The synthetic `{ type: "result", stats: {} }` from `user` events will produce empty stats
- The real `result` event from `case "result"` should have cost/tokens/duration
- May need to only show footer for real results (non-empty stats)

## Medium Bugs

### Bug D: First option stays blue after selection (AskUserQuestion)
**Test affected:** 1
**Symptom:** First unselected option appears blue instead of grey.
**Root cause:** The first option button gets `class="btn primary"` (line ~1011 in geminiShowToolQuestions). When another option is selected, `greyed` class is added but `.primary` overrides the opacity. Fix: remove `primary` class when greying out.

### Bug E: Stop button stuck visible when idle
**Test affected:** 10
**Symptom:** Stop button remains visible even when no generation is in flight.
**Root cause:** `geminiSetStreaming(false)` should hide the stop button but may not be toggling correctly.

## Feature Requests (from test results, implement after bug fixes)

### FR1: Cumulative cost counter in input area
Instead of per-message footers, show cumulative session cost between model selector and send button.

### FR2: Send + Stop button layout
- Send button always visible
- Stop button appears NEXT TO send (not replacing it) during generation
- Stop icon: small red square-in-circle

### FR3: Extended thinking toggle
User wants explicit control over extended thinking, not auto-enable.

## Implementation Order

1. Fix Bug A (tool pills never finalize) — CRITICAL, blocks most testing
2. Fix Bug D (first option stays blue) — quick CSS fix
3. Fix Bug C (cost footer) — check stats content
4. Fix Bug B (model switching) — verify control_request format
5. Fix Bug E (stop button) — check streaming state management
6. Implement FR2 (send/stop layout) — UX improvement
7. Implement FR1 (cumulative cost) — nice to have
