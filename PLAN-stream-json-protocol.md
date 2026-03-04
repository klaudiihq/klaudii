# Plan: Bidirectional Stream-JSON Protocol for Claude CLI

## Problem

The current `claude-chat.js` spawns Claude CLI in pipe mode (`-p`) with `--output-format stream-json`.
It writes the user prompt as plain text to stdin and calls `stdin.end()` (EOF) to signal "go".
This works for `bypassPermissions` mode, but makes interactive permission handling impossible —
once stdin is closed, we can't send approval/denial responses back to the CLI.

A recent attempt to fix this by removing `stdin.end()` broke everything — the CLI waits for EOF
before it starts processing, so messages never got a response.

## Solution

The Claude CLI supports a **bidirectional JSONL control protocol** via two flags:
- `--input-format stream-json` — stdin reads line-by-line JSONL (no EOF needed)
- `--permission-prompt-tool stdio` — permission requests route through stdin/stdout control messages

This is the same protocol the official Agent SDK (`@anthropic-ai/claude-agent-sdk`) uses internally.

## Protocol Overview

### Spawn Command
```
claude --output-format stream-json --input-format stream-json --verbose --permission-prompt-tool stdio --permission-mode <mode>
```

No `-p` flag — the prompt is sent as a JSON message on stdin instead.

### Message Types (stdin → CLI)

**1. User message:**
```json
{"type": "user", "session_id": "", "message": {"role": "user", "content": "Fix the bug in auth.js"}}
```

**2. Control response (permission approval/denial):**
```json
{"type": "control_response", "response": {"subtype": "success", "request_id": "<id from request>", "response": {"behavior": "allow", "updatedInput": {...}}}}
```

```json
{"type": "control_response", "response": {"subtype": "success", "request_id": "<id>", "response": {"behavior": "deny", "message": "User rejected"}}}
```

### Message Types (CLI → stdout)

**1. Regular stream events** (same as today — `assistant`, `tool_use`, `result`, etc.)

**2. Control requests:**
```json
{"type": "control_request", "request_id": "req_abc", "request": {"subtype": "can_use_tool", "tool_name": "Bash", "input": {"command": "rm -rf /tmp"}, "permission_suggestions": []}}
```

### Initialize Handshake

After spawning, the SDK sends an initialize control request. We need to determine if this is
required or optional by testing. If required:

```json
{"type": "control_request", "request_id": "req_1_init", "request": {"subtype": "initialize", "hooks": {}, "agents": {}}}
```

## Implementation Steps

### Phase 1: Update `lib/claude-chat.js` — `sendMessage()`

1. **Change spawn args** when permission mode is NOT `bypassPermissions`:
   - Remove `-p` flag
   - Add `--input-format stream-json`
   - Add `--permission-prompt-tool stdio`
   - Keep `--output-format stream-json --verbose`

2. **For `bypassPermissions` mode**: keep current behavior (`-p`, plain text stdin, `stdin.end()`)
   as a fast path — no protocol overhead needed.

3. **Send user message as JSONL** instead of plain text:
   ```js
   const userMsg = JSON.stringify({
     type: "user",
     session_id: sessionId || "",
     message: { role: "user", content: fullMessage }
   });
   proc.stdin.write(userMsg + "\n");
   // DO NOT call stdin.end() — keep open for control responses
   ```

4. **Parse control requests from stdout**: The stdout line parser (`handleLine`) already parses
   JSON lines. Add detection for `type: "control_request"` with `subtype: "can_use_tool"`.
   When detected, emit a new event type to the WebSocket client:
   ```js
   {
     type: "permission_request",
     request_id: parsed.request_id,
     tool_name: parsed.request.tool_name,
     tool_input: parsed.request.input,
     question: buildQuestionFromToolInput(parsed.request)
   }
   ```

5. **Add `sendControlResponse(workspace, requestId, behavior, updatedInput)`**:
   ```js
   function sendControlResponse(workspace, requestId, behavior, updatedInput) {
     const entry = activeProcesses.get(workspace);
     if (!entry?.proc || entry.killed) return;
     const msg = JSON.stringify({
       type: "control_response",
       response: {
         subtype: "success",
         request_id: requestId,
         response: behavior === "allow"
           ? { behavior: "allow", updatedInput }
           : { behavior: "deny", message: "User denied" }
       }
     });
     entry.proc.stdin.write(msg + "\n");
   }
   ```

### Phase 2: Update `server.js` — WebSocket handler

1. **Replace the `input` message handler** with a `permission_response` handler:
   ```js
   } else if (type === "permission_response") {
     const { request_id, behavior, updatedInput } = msg;
     claudeChat.sendControlResponse(workspace, request_id, behavior, updatedInput);
   }
   ```

2. **Forward `permission_request` events** from the claude-chat event stream to WebSocket
   clients (already partially done — just needs the `request_id` field added).

### Phase 3: Update `public/gemini.js` — UI

1. **Update `geminiShowPermissionRequest()`** to:
   - Display the tool name and input details (e.g., "Bash: `rm -rf /tmp`")
   - Show Allow / Deny buttons
   - On click, send a `permission_response` WebSocket message with the `request_id`

2. **Update the WS send** to use the new message format:
   ```js
   geminiWs.send(JSON.stringify({
     type: "permission_response",
     workspace: geminiWorkspace,
     request_id: requestId,
     behavior: "allow",  // or "deny"
     updatedInput: originalToolInput
   }));
   ```

3. **Show rich tool details** in the permission card — not just a question string, but the
   actual tool name, command/file path, and a formatted preview of what Claude wants to do.

### Phase 4: Handle Initialize Handshake (if required)

1. After spawning, send the initialize control request
2. Wait for the initialize response before sending the user message
3. May need a small state machine: `initializing → ready → processing`

## Testing Plan

1. **Regression**: `bypassPermissions` mode still works (fast path, unchanged)
2. **Plan mode**: Send a message with `permissionMode: "plan"`, verify permission request
   appears in UI, approve it, verify Claude continues
3. **Deny flow**: Deny a permission request, verify Claude handles it gracefully
4. **Multiple permissions**: A single response may trigger multiple tool uses — verify each
   gets its own permission request and can be approved independently
5. **Session continuity**: Verify `--session-id` / `--resume` still work with the new protocol

## Open Questions

- Is the initialize handshake mandatory or optional? Need to test.
- Does `--session-id` / `--resume` work without `-p`? Need to verify the CLI accepts
  session flags in stream-json input mode.
- What happens if we send the user message with images? Need to check if the JSONL message
  format supports content blocks with base64 images (the Agent SDK supports this).
- Should we implement the initialize handshake even for `bypassPermissions` to get a uniform
  code path, or keep the two-path approach?
