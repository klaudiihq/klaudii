# Gemini CLI Approval Hook Patch

Minimal patch to add external tool-confirmation support to
`@google/gemini-cli-a2a-server`. Adds one HTTP endpoint and one method.
**~15 lines across 2 files.** Reapply every time you rebuild the package.

---

## Background

When `autoExecute: true` the A2A server auto-approves every tool call.
When `autoExecute: false`, the task stores pending confirmations in
`pendingToolConfirmationDetails` (keyed by `callId`) and waits for
`details.onConfirm(outcome)` to be called. The SSE stream already emits
`coderKind: "tool-call-confirmation"` events with the `callId` when a tool
is awaiting approval — we just need an HTTP endpoint to receive the response.

---

## Upstream repo

```
https://github.com/google-gemini/gemini-cli
```

Pin to the commit that matches the installed package version before patching.

```bash
# Check installed version
cat node_modules/@google/gemini-cli-a2a-server/package.json | grep '"version"'

# Clone and checkout matching tag
git clone https://github.com/google-gemini/gemini-cli
cd gemini-cli
git checkout v0.32.1   # replace with installed version
```

---

## File 1 — `packages/a2a-server/src/agent/task.ts`

**Add a public `confirmToolCall` method.**

Search for the `pendingToolConfirmationDetails` map declaration, which looks like:

```typescript
private pendingToolConfirmationDetails: Map<string, ToolCallConfirmationDetails> = new Map();
```

Directly below the class's existing private methods that deal with
`pendingToolConfirmationDetails`, add:

```typescript
/**
 * Respond to a pending tool confirmation from an external HTTP caller.
 * Returns true if the callId was found and handled, false otherwise.
 */
confirmToolCall(callId: string, outcomeStr: string): boolean {
  const details = this.pendingToolConfirmationDetails.get(callId);
  if (!details) return false;
  const outcome =
    outcomeStr === 'cancel' || outcomeStr === 'deny'
      ? ToolConfirmationOutcome.Cancel
      : outcomeStr === 'proceed_always'
      ? ToolConfirmationOutcome.ProceedAlways
      : ToolConfirmationOutcome.ProceedOnce;
  details.onConfirm(outcome);
  this.pendingToolConfirmationDetails.delete(callId);
  return true;
}
```

**Search anchor** (to find the right spot robustly):
```
pendingToolConfirmationDetails.delete(tc.request.callId)
```
Add the new method in the same class, just below the existing `handleToolConfirmation`
private method (or wherever that delete call lives).

---

## File 2 — `packages/a2a-server/src/http/app.ts`

**Add `POST /tasks/:taskId/confirm` route.**

Find the existing task routes block — search for:
```typescript
app.post('/tasks', async (req, res) => {
```

Add this new route immediately after the `POST /tasks` handler:

```typescript
// Respond to a pending tool confirmation (for non-autoExecute tasks).
// Body: { callId: string, outcome?: "proceed_once"|"proceed_always"|"cancel" }
app.post('/tasks/:taskId/confirm', async (req, res) => {
  const task = taskManager.getTask(req.params.taskId);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  const { callId, outcome = 'proceed_once' } = req.body as {
    callId: string;
    outcome?: string;
  };
  if (!callId) {
    return res.status(400).json({ error: 'callId required' });
  }
  const handled = task.confirmToolCall(callId, outcome);
  if (!handled) {
    return res.status(404).json({ error: `No pending confirmation for callId: ${callId}` });
  }
  res.status(200).json({ ok: true, callId, outcome });
});
```

**Note on `taskManager.getTask`**: the exact method name may vary. Search for
where existing route handlers access the task object — e.g.:
```typescript
const task = taskManager.get(taskId)
// or
const task = tasks.get(taskId)
// or
const task = await this.taskManager.getTask(taskId)
```
Use whatever pattern the existing `/tasks/:taskId` GET route uses.

---

## Build

```bash
cd gemini-cli
npm install
npm run build -w packages/core -w packages/a2a-server
```

Then copy the built output into the klaudii project:
```bash
cp packages/a2a-server/dist/a2a-server.mjs \
   /path/to/klaudii/node_modules/@google/gemini-cli-a2a-server/dist/a2a-server.mjs
```

Or publish a fork to a private npm registry and reference it in package.json.

---

## Klaudii changes to use non-YOLO mode

### `lib/gemini-a2a.js` — `createTask()`

Change `autoExecute: true` → `false` (or make it configurable):

```js
async function createTask(port, workspacePath, autoExecute = false) {
  const contextId = uuid();
  const taskId = await httpPost(port, "/tasks", {
    contextId,
    agentSettings: {
      kind: "agent-settings",
      workspacePath,
      autoExecute,   // false = ask for approval; true = YOLO
    },
  });
  // ...
}
```

Pass through from `ensureServer`:
```js
const { taskId, contextId } = await createTask(port, workspacePath, opts.autoExecute ?? false);
```

### `lib/gemini-a2a.js` — `mapA2AEvent()`

The `tool-call-confirmation` case already maps to `{ type: "tool_use", ... }`.
Add `callId` to the emitted event so the UI can reference it when confirming:

```js
case "tool-call-confirmation":
  return {
    type: "tool_use",
    tool_name: coderMeta.name || "tool",
    tool_id: coderMeta.callId || uuid(),
    call_id: coderMeta.callId,      // ← add this
    parameters: coderMeta.input || {},
    awaiting_approval: true,        // ← add this flag
  };
```

### New `lib/gemini-a2a.js` export — `confirmToolCall()`

```js
async function confirmToolCall(workspace, callId, outcome = "proceed_once") {
  const entry = servers.get(workspace);
  if (!entry) throw new Error(`No active server for workspace: ${workspace}`);
  return httpPost(entry.port, `/tasks/${entry.taskId}/confirm`, { callId, outcome });
}

// Add to module.exports
module.exports = { sendMessage, isActive, stopProcess, stopAllProcesses, confirmToolCall };
```

### `server.js` — New REST endpoint

```js
// POST /api/gemini/:workspace/confirm
app.post("/api/gemini/:workspace/confirm", express.json(), async (req, res) => {
  const { workspace } = req.params;
  const { callId, outcome } = req.body;
  try {
    const result = await gemini.confirmToolCall(workspace, callId, outcome);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

Expose `confirmToolCall` from `lib/gemini.js` too (passthrough to a2a).

### `public/gemini.js` — Show approval prompts

The `tool_use` handler can check `event.awaiting_approval`:

```js
case "tool_use": {
  if (event.awaiting_approval) {
    geminiShowApprovalPrompt(event);
  } else {
    // existing tool_use display
  }
  break;
}
```

```js
function geminiShowApprovalPrompt(event) {
  const div = document.createElement("div");
  div.className = "gemini-approval-prompt";
  div.innerHTML = `
    <div class="approval-tool">${escHtml(event.tool_name)}</div>
    <pre class="approval-params">${escHtml(JSON.stringify(event.parameters, null, 2))}</pre>
    <div class="approval-buttons">
      <button class="btn-approve">Approve</button>
      <button class="btn-deny">Deny</button>
    </div>`;
  div.querySelector(".btn-approve").onclick = () => {
    div.querySelectorAll("button").forEach(b => b.disabled = true);
    confirmGeminiTool(event.call_id, "proceed_once");
  };
  div.querySelector(".btn-deny").onclick = () => {
    div.querySelectorAll("button").forEach(b => b.disabled = true);
    confirmGeminiTool(event.call_id, "cancel");
  };
  geminiMessages.appendChild(div);
  geminiMessages.scrollTop = geminiMessages.scrollHeight;
}

function confirmGeminiTool(callId, outcome) {
  fetch(`/api/gemini/${currentWorkspace}/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callId, outcome }),
  }).catch(console.error);
}
```

---

## Reapplication guide

1. Check the new installed version: `cat node_modules/@google/gemini-cli-a2a-server/package.json | grep version`
2. Checkout that tag in your gemini-cli clone
3. Search for the same anchors (they're stable method names unlikely to change)
4. Re-apply the 2 file changes (~15 lines total)
5. Rebuild + copy `.mjs` bundle
6. The klaudii-side changes (`gemini-a2a.js`, `server.js`, `gemini.js`, `gemini.js` frontend) are in our codebase and don't need reapplying

---

## Key identifiers (stable across refactors)

| Symbol | Where |
|--------|-------|
| `pendingToolConfirmationDetails` | `Task` class — Map keyed by `callId` |
| `ToolConfirmationOutcome` | enum: `ProceedOnce`, `ProceedAlways`, `Cancel` |
| `details.onConfirm(outcome)` | callback stored in the map |
| `tc.request.callId` | the key used to store/delete pending entries |
| `coderKind: "tool-call-confirmation"` | SSE event type for awaiting-approval tool calls |
| `autoExecute` | Task constructor param + agentSettings field |
