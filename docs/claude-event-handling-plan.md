# Execution Plan: Full Claude CLI Event Handling

**Reference:** [claude-cli-event-audit.md](./claude-cli-event-audit.md)
**Date:** 2026-03-05
**Branch:** geminisupport

---

## Priority Tiers

### Tier 1 — High Impact, Directly User-Visible
These fix broken or missing features that users encounter regularly.

### Tier 2 — Important Polish
These improve the experience meaningfully but aren't blocking.

### Tier 3 — Nice-to-Have
These add depth for power users.

---

## Tier 1: High Impact

### 1.1 Runtime Model Switching

**Problem:** The model selector dropdown exists in the UI but does nothing for active Claude sessions. Model is only set at relay launch time.

**Solution:**
- **Backend (`server.js`):** Add a new WS message type `set_model`. When received, send a `control_request` with `subtype: "set_model"` to Claude's stdin via the relay socket:
  ```json
  {"type":"control_request","request_id":"<uuid>","request":{"subtype":"set_model","model":"claude-sonnet-4-5"}}
  ```
  Claude applies the new model on the next API call. No response handling needed (success is implicit).
- **Backend (`lib/claude-chat.js`):** Add `sendControlRequest(workspace, request)` utility (generic, reusable for all host→CLI control requests). The existing `sendControlResponse` writes to the relay socket — this is the same mechanism but for proactive requests.
- **Frontend (`gemini.js`):** Add a `change` event listener on `#gemini-model`. On change, send `{type:"set_model", workspace, model}` over the WebSocket. Persist the selection to `localStorage` keyed by workspace.
- **Frontend (`gemini.js`):** In `geminiFetchModels()`, after populating options, restore from localStorage.
- **Frontend (`gemini.js`):** In `openGeminiChat()`, restore model selection from localStorage after models are fetched.

**Files:** `server.js`, `lib/claude-chat.js`, `public/gemini.js`
**Estimate complexity:** Low-medium. The control protocol already exists; we just need to send the right message.

---

### 1.2 Subagent Nesting via `parent_tool_use_id`

**Problem:** When Claude spawns a subagent (Agent tool), the subagent's messages appear flat in the main chat thread. There's no visual grouping or nesting.

**Solution:**
- **Backend (`lib/claude-chat.js` normalizeEvent):** Preserve `parent_tool_use_id` from `assistant` and `user` events on the normalized events. Currently this field is stripped during normalization.
- **Frontend (`gemini.js`):** Track active subagents in a Map: `tool_use_id → { toolName, containerEl }`. When a `tool_use` for `Agent`/`Task` is received, create a collapsible container element under the tool pill. When subsequent events arrive with a matching `parent_tool_use_id`, render them inside that container instead of the main thread.
- **Frontend:** Subagent containers should be collapsible (collapsed by default after completion, expanded while running).

**Visual design:**
```
┌─ Agent: "Research codebase structure"  [▼ collapse]
│  Assistant: Let me search for...
│  ┌─ Grep: "handleEvent"  ✓
│  └─ Read: src/handler.js  ✓
│  Assistant: I found the following...
└─ Completed (12s, 3,400 tokens)
```

**Files:** `lib/claude-chat.js`, `public/gemini.js`, `public/gemini.css`
**Estimate complexity:** Medium. Rendering is the hard part — need to intercept event routing based on parent_tool_use_id.

---

### 1.3 Background Task Tracking (`task_started` / `task_progress` / `task_notification`)

**Problem:** Background agents (run_in_background) are completely invisible. No indication they're running, no progress, no completion notification.

**Solution:**
- **Backend (`lib/claude-chat.js` normalizeEvent):** Add cases for `system`/`task_started`, `system`/`task_progress`, `system`/`task_notification`. Pass through as normalized events.
- **Frontend (`gemini.js` handleGeminiEvent):** Add handlers:
  - `task_started`: Create a task card in the chat showing description, with a "running" indicator. Store in `activeTasks` Map.
  - `task_progress`: Update the task card with usage stats and last tool name.
  - `task_notification`: Mark task as completed/failed/stopped. Show summary. If the task has a `tool_use_id`, update the corresponding tool pill.

**Visual design:**
```
┌─ Background Task: "Run test suite"  ⟳ Running
│  Tokens: 8,200 · Tools: 12 · Last: Bash
└─
```
On completion:
```
┌─ Background Task: "Run test suite"  ✓ Completed
│  Summary: All 47 tests passed.
│  Tokens: 14,300 · Tools: 23 · Duration: 45s
└─
```

**Files:** `lib/claude-chat.js`, `server.js` (pass-through), `public/gemini.js`, `public/gemini.css`
**Estimate complexity:** Medium.

---

### 1.4 File Modification Diffs (Color Diff for Edit/Write Tools)

**Problem:** When Claude edits a file, the tool result shows raw text output. There's no visual diff showing what changed.

**Solution:**
- **Frontend (`gemini.js`):** In the tool result rendering path (`geminiRenderCompletedTool`), detect when `tool_name` is `Edit` or `Write`. Parse the tool parameters (`old_string`, `new_string` for Edit; full content for Write) and render a side-by-side or unified color diff.
- **Use a lightweight diff library** — either bundle a minimal diff engine or compute the diff server-side. For `Edit` tool, `old_string` and `new_string` are already available in the `tool_use` parameters, so no diffing needed — just render them as removal/addition.
- **For `Write` tool:** The tool parameters contain the full file content. Show it as an "added file" diff (all green).
- **For `Edit` tool:** Show `old_string` in red, `new_string` in green, with the `file_path` as the header.

**Visual design:**
```
Edit: src/handler.js
─────────────────────
- function handleEvent(event) {
-   console.log(event);
+ function handleEvent(event) {
+   logger.info("event received", { type: event.type });
    process(event);
  }
```

Use CSS classes:
- `.diff-removed` — red background (#fdd), red text
- `.diff-added` — green background (#dfd), green text
- `.diff-header` — file path with monospace font
- `.diff-context` — unchanged lines (if we compute them)

**Files:** `public/gemini.js`, `public/gemini.css`
**Estimate complexity:** Medium. The Edit tool gives us old/new strings directly. Write tool is simpler (all additions).

---

### 1.5 Permission Prompt Enrichment

**Problem:** Permission prompts show only tool name and raw JSON input. Claude CLI provides `description` and `decision_reason` fields that we currently strip.

**Solution:**
- **Backend (`lib/claude-chat.js` connectRelay):** Include `description`, `decision_reason`, `permission_suggestions`, and `blocked_path` in the `permission_request` event sent to the frontend:
  ```js
  const evt = {
    type: "permission_request",
    request_id: raw.request_id,
    tool_name: req.tool_name,
    tool_input: req.input || {},
    description: req.description || "",
    decision_reason: req.decision_reason || "",
    blocked_path: req.blocked_path || "",
    permission_suggestions: req.permission_suggestions || [],
  };
  ```
- **Frontend (`gemini.js` `geminiShowPermissionRequest`):** Show `description` as a human-readable summary above the tool input. Show `decision_reason` as a muted explanation. Optionally show an "Always allow" button that sends `updatedPermissions` in the response.

**Files:** `lib/claude-chat.js`, `public/gemini.js`, `public/gemini.css`
**Estimate complexity:** Low. Mostly passing through existing data and rendering it.

---

### 1.6 Fix Plan Rejection in Bypass Mode

**Problem:** When the user rejects a plan in bypass mode, `gemini.js` sends `{type:"message"}` which the server silently ignores (it expects `{type:"send"}`).

**Solution:**
- **Frontend (`gemini.js` `geminiShowPlanApproval`):** Change the reject handler to send `{type:"send", workspace, message:"I rejected the plan. Here's why: ..."}` instead of `{type:"message"}`.

**Files:** `public/gemini.js`
**Estimate complexity:** Trivial.

---

## Tier 2: Important Polish

### 2.1 `tool_progress` — Show Elapsed Time on Running Tools

**Problem:** Long-running Bash commands show no progress. The tool pill says "Running..." with no elapsed time.

**Solution:**
- **Backend (`lib/relay-daemon.js`):** Set `CLAUDE_CODE_REMOTE=1` in the relay daemon's environment so Claude emits `tool_progress` events.
- **Backend (`lib/claude-chat.js` normalizeEvent):** Add a case for `tool_progress`:
  ```js
  case "tool_progress":
    events.push({
      type: "tool_progress",
      tool_use_id: raw.tool_use_id,
      tool_name: raw.tool_name,
      elapsed_time_seconds: raw.elapsed_time_seconds,
      parent_tool_use_id: raw.parent_tool_use_id,
    });
    break;
  ```
- **Frontend (`gemini.js`):** On `tool_progress`, find the matching running tool pill by `tool_use_id` and update its label to show elapsed time: "Bash · Running 45s..."

**Note:** `tool_progress` is throttled to 30-second intervals by the CLI, so updates will be infrequent. Consider also running a client-side timer from when the tool_use event arrived to provide smoother elapsed time display, using `tool_progress` events to correct drift.

**Files:** `lib/relay-daemon.js`, `lib/claude-chat.js`, `server.js`, `public/gemini.js`
**Estimate complexity:** Low-medium.

---

### 2.2 `result` Error Variants

**Problem:** When Claude hits max turns, budget limits, or execution errors, we show a generic "done" event. The error details (`errors[]` array, error subtype) are lost.

**Solution:**
- **Backend (`lib/claude-chat.js` normalizeEvent):** Include `subtype` and `errors` in the normalized result event:
  ```js
  const out = { type: "result", subtype: raw.subtype || "success", stats: { ... } };
  if (raw.subtype && raw.subtype !== "success" && raw.errors) {
    out.errors = raw.errors;
  }
  ```
- **Frontend (`gemini.js`):** On `done` event (which the server derives from `result`), check for error subtype. Show a warning card:
  - `error_max_turns` → "Claude reached the maximum number of turns (N)."
  - `error_max_budget_usd` → "Claude exceeded the budget limit ($X.XX)."
  - `error_during_execution` → Show the error messages.

**Files:** `lib/claude-chat.js`, `server.js`, `public/gemini.js`, `public/gemini.css`
**Estimate complexity:** Low.

---

### 2.3 `system`/`status` — Compaction and Permission Mode Changes

**Problem:** When context compaction happens or permission mode changes, there's no indication in the UI.

**Solution:**
- **Backend (`lib/claude-chat.js` normalizeEvent):** Pass through `system`/`status` events:
  ```js
  case "status":
    events.push({ type: "status", status: raw.status, permissionMode: raw.permissionMode });
    break;
  ```
- **Backend:** Also pass through `system`/`compact_boundary`:
  ```js
  case "compact_boundary":
    events.push({ type: "compact_boundary", trigger: raw.compact_metadata?.trigger, pre_tokens: raw.compact_metadata?.pre_tokens });
    break;
  ```
- **Frontend:** Show a thin system message in the chat:
  - Compacting: "Context compacted (was ~120k tokens)"
  - Permission mode change: "Permission mode changed to Plan"

**Files:** `lib/claude-chat.js`, `public/gemini.js`, `public/gemini.css`
**Estimate complexity:** Low.

---

### 2.4 Runtime Permission Mode Switching

**Problem:** The permission mode selector exists in the UI but only applies when starting a new session. Can't change mode mid-session.

**Solution:**
- **Backend (`server.js`):** Add WS message type `set_permission_mode`. Send a `control_request` with `subtype: "set_permission_mode"` to the relay.
- **Frontend:** On permission mode dropdown change, send `{type:"set_permission_mode", workspace, mode}` over WebSocket.

**Files:** `server.js`, `lib/claude-chat.js`, `public/gemini.js`
**Estimate complexity:** Low (same pattern as model switching).

---

### 2.5 Extended Thinking Blocks

**Problem:** Claude's thinking content (from extended thinking / chain-of-thought) is silently dropped in normalizeEvent.

**Solution:**
- **Backend (`lib/claude-chat.js` normalizeEvent):** In the `assistant` case, when iterating content blocks, also handle `block.type === "thinking"`:
  ```js
  else if (block.type === "thinking" && block.thinking) {
    events.push({ type: "thinking", content: block.thinking, delta: true });
  }
  ```
- **Frontend:** Render thinking blocks in a collapsible `<details>` element above the assistant text:
  ```html
  <details class="gemini-thinking">
    <summary>Thinking...</summary>
    <div class="gemini-thinking-content">...</div>
  </details>
  ```

**Files:** `lib/claude-chat.js`, `public/gemini.js`, `public/gemini.css`
**Estimate complexity:** Low-medium.

---

### 2.6 `control_cancel_request` — Cancel Pending Permission Prompts

**Problem:** When the user clicks "Stop" while a permission prompt is showing, the prompt stays visible and Claude is stuck. There's no way to cancel the pending control_request.

**Solution:**
- **Backend (`server.js`):** When `stop` message is received and there's a pending permission, send a `control_cancel_request` to the relay before killing the process:
  ```json
  {"type":"control_cancel_request","request_id":"<pending_request_id>"}
  ```
- **Frontend:** When streaming stops (done/error), remove any visible permission prompt cards.

**Files:** `server.js`, `lib/claude-chat.js`, `public/gemini.js`
**Estimate complexity:** Low.

---

### 2.7 Interrupt Turn (not just Kill)

**Problem:** "Stop" currently sends SIGTERM to the relay, killing Claude entirely. There should be a softer "interrupt" that tells Claude to stop the current turn without killing the session.

**Solution:**
- **Backend:** Send a `control_request` with `subtype: "interrupt"` to the relay. This tells Claude to abort the current API call gracefully and emit a result.
- **Frontend:** "Stop" button sends interrupt first. If Claude doesn't respond within 5 seconds, escalate to SIGTERM (existing kill behavior).

**Files:** `server.js`, `lib/claude-chat.js`, `public/gemini.js`
**Estimate complexity:** Medium. Need to handle the timeout/escalation gracefully.

---

## Tier 3: Nice-to-Have

### 3.1 Hook Event Visualization

**Problem:** User-configured hooks run invisibly.

**Solution:** Show hook execution as collapsible system messages:
```
Hook: lint-check (PreToolUse) ✓ 0.3s
```

**Files:** `lib/claude-chat.js`, `public/gemini.js`, `public/gemini.css`
**Complexity:** Low.

---

### 3.2 `prompt_suggestion` — Quick Reply Buttons

**Problem:** After each turn, Claude can suggest what to ask next. We don't surface this.

**Solution:**
- Enable via `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=1` env var on the relay daemon.
- Show suggestion as a clickable chip below the assistant message: "Suggested: Run the test suite"
- Clicking it populates the input field.

**Files:** `lib/relay-daemon.js`, `lib/claude-chat.js`, `public/gemini.js`, `public/gemini.css`
**Complexity:** Low.

---

### 3.3 MCP Elicitation Support

**Problem:** If an MCP server requests user input, Claude blocks forever.

**Solution:**
- Detect `control_request`/`elicitation` in connectRelay and forward to frontend.
- Render a form based on `requested_schema` (JSON Schema → HTML form) or show a "Visit URL" link.
- Send the user's response back as a `control_response`.

**Files:** `lib/claude-chat.js`, `server.js`, `public/gemini.js`
**Complexity:** Medium-high (JSON Schema → form rendering).

---

### 3.4 `stream_event` for Real-Time Streaming

**Problem:** Text arrives in batched chunks from the `assistant` event, not character-by-character.

**Solution:**
- Add `--include-partial-messages` flag to CLI launch.
- Handle `stream_event` in normalizeEvent. Extract `content_block_delta` → `text_delta` for real-time text streaming.
- This would replace the current `assistant` message batching with true streaming.

**Tradeoff:** Significantly more events. May increase CPU and memory usage. The current batched approach is "good enough" for most users.

**Files:** `lib/claude-chat.js`, `public/gemini.js`
**Complexity:** Medium-high. Need to handle all stream event subtypes and accumulate state.

---

### 3.5 Cost and Token Usage Display

**Problem:** The `result` event includes detailed cost/usage data that we log but don't display.

**Solution:** After each turn, show a small footer under the assistant message:
```
$0.032 · 12.4k tokens · 8.2s
```
Use data from the `result` event stats that we already extract.

**Files:** `public/gemini.js`, `public/gemini.css`
**Complexity:** Low.

---

### 3.6 `files_persisted` / `local_command_output`

Both are niche events:
- `files_persisted` is only relevant in cloud/container mode (not local Klaudii).
- `local_command_output` is only from slash commands which we don't support.

**Recommendation:** Skip for now. Add passthrough logging so they're not silently dropped.

---

## Recommended Implementation Order

```
Phase 1 (immediate):
  1.1  Runtime model switching          — direct user request
  1.5  Permission prompt enrichment     — low effort, high polish
  1.6  Fix plan rejection in bypass     — bug fix (trivial)
  2.2  Result error variants            — low effort, fixes lost info
  3.5  Cost/token display               — low effort, user loves data

Phase 2 (next sprint):
  1.4  File modification diffs          — high visual impact
  2.1  tool_progress elapsed time       — important for long tools
  2.3  Status/compaction events         — low effort, good awareness
  2.4  Runtime permission mode switch   — same pattern as model switch
  2.6  Cancel pending permission        — bug fix for stop+permission

Phase 3 (polish):
  1.2  Subagent nesting                 — medium complexity, big UX win
  1.3  Background task tracking         — medium complexity, enables async workflows
  2.5  Extended thinking blocks         — medium, interesting for power users
  2.7  Interrupt (soft stop)            — medium, better than kill

Phase 4 (nice-to-have):
  3.1  Hook visualization               — low value for most users
  3.2  Prompt suggestions               — low effort, fun feature
  3.3  MCP elicitation                  — only for MCP users
  3.4  Real-time streaming              — high effort, marginal improvement
```

---

## Architecture Notes

### Generic `sendControlRequest` utility

Multiple features (model switch, permission mode switch, interrupt, cancel, stop task) need the same pattern: send a control_request to Claude's stdin via the relay socket. Build this once:

```js
// lib/claude-chat.js
function sendControlRequest(workspace, subtype, payload = {}) {
  const entry = activeRelays.get(workspace);
  if (!entry) return false;
  const requestId = crypto.randomUUID();
  const msg = {
    type: "control_request",
    request_id: requestId,
    request: { subtype, ...payload },
  };
  entry.handle.socket.write(JSON.stringify(msg) + "\n");
  return requestId;
}
```

Then `sendControlResponse` becomes a special case of this pattern.

### `parent_tool_use_id` propagation

Currently `normalizeEvent` strips all fields except what it explicitly copies. For subagent nesting, the simplest approach is to propagate `parent_tool_use_id` on every normalized event:

```js
// In each push call inside normalizeEvent:
if (raw.parent_tool_use_id) evt.parent_tool_use_id = raw.parent_tool_use_id;
```

The server passes this through in its broadcast. The frontend uses it for nesting.

### `CLAUDE_CODE_REMOTE=1` for tool_progress

The relay daemon needs this env var set for Claude to emit `tool_progress` events. Add it in `startRelay()`:

```js
env: { ...process.env, CLAUDECODE: "", CLAUDE_CODE_REMOTE: "1", ... }
```

Side effects to verify: this flag may change other CLI behavior (e.g., connection-specific features). Test thoroughly.

### CSS Custom Properties for Diffs

```css
--diff-add-bg: #e6ffec;    /* light mode */
--diff-add-fg: #1a7f37;
--diff-del-bg: #ffebe9;
--diff-del-fg: #cf222e;
--diff-header-bg: #ddf4ff;
```
Dark mode overrides via `.dark` class.
