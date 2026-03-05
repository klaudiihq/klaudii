# Claude CLI Streaming Event Audit

**Date:** 2026-03-05
**Claude Code version audited:** 2.1.69
**Claude Code repo commit:** `9582ad480f687bbeaf0025852ac4f020b07f20bb` (2026-03-05T00:25:31Z)
**Klaudii commit at audit time:** `0245aeb` (geminisupport branch)
**Audit method:** Subagent research against the `anthropics/claude-code` GitHub repo source, the `anthropics/claude-agent-sdk-python` SDK types, the installed CLI binary at `/Volumes/Fast/bryantinsley/.local/share/claude/versions/2.1.69`, and local `@anthropic-ai/claude-code/sdk-tools.d.ts` type definitions. Cross-referenced with a full manual audit of Klaudii's `lib/claude-chat.js`, `lib/relay-daemon.js`, `server.js`, `routes/v1.js`, and `public/gemini.js`.

---

## Table of Contents

1. [CLI Launch Flags](#1-cli-launch-flags)
2. [Complete Event Type Taxonomy](#2-complete-event-type-taxonomy)
3. [Event Schemas (Full)](#3-event-schemas-full)
4. [Control Protocol (stdin/stdout bidirectional)](#4-control-protocol)
5. [Klaudii Handling Status](#5-klaudii-handling-status)
6. [Gaps, Bugs, and Missing Features](#6-gaps-bugs-and-missing-features)

---

## 1. CLI Launch Flags

### Current Klaudii flags (`lib/claude-chat.js:827-828`)

```
claude --output-format stream-json
       --input-format stream-json
       --verbose
       --permission-prompt-tool stdio
       --permission-mode <permMode>       # default: "bypassPermissions"
       [--model <model>]                  # if provided
       [--resume <sessionId>]             # if existing session
       [-p <initialMessage>]              # first message only
```

### Flags we should consider adding

| Flag | Effect | Reason |
|------|--------|--------|
| `--include-partial-messages` | Emits `stream_event` events with raw Anthropic API streaming deltas | Would give us real-time text streaming instead of batched `assistant` messages. Currently text arrives in chunks only when Claude CLI flushes. |

### Flags NOT to add

| Flag | Why not |
|------|---------|
| `--enableAuthStatus` | Internal CLI option, emits `auth_status` events. Auth is handled separately via Klaudii's own API. |

---

## 2. Complete Event Type Taxonomy

### Events emitted by Claude CLI on stdout (stream-json mode)

| Type | Subtype | Emitted by default | Needs flag | Description |
|------|---------|:-------------------:|:----------:|-------------|
| `system` | `init` | Yes | | First event. Session ID, model, tools, CWD, permission mode. |
| `system` | `status` | Yes | | Permission mode changes, compaction start/end. |
| `system` | `compact_boundary` | Yes | | Context compaction completed. Carries pre-compaction token count. |
| `system` | `hook_started` | Yes | | A user-configured hook began executing. |
| `system` | `hook_progress` | Yes | | Hook stdout/stderr output. |
| `system` | `hook_response` | Yes | | Hook completed (success/error/cancelled). |
| `system` | `task_started` | Yes | | Background agent/task spawned. |
| `system` | `task_progress` | Yes | | Background agent progress update (usage, last tool). |
| `system` | `task_notification` | Yes | | Background agent completed/failed/stopped. |
| `system` | `files_persisted` | Yes | | Files saved (for cloud/remote mode). |
| `system` | `local_command_output` | Yes | | Output from slash commands (/voice, /cost). |
| `system` | `elicitation_complete` | Yes | | MCP elicitation URL flow completed. |
| `assistant` | — | Yes | | Full assistant turn. Contains `message.content` array of text, tool_use, thinking blocks. Has `parent_tool_use_id` (null for main thread, set for subagents). |
| `user` | — | Yes | | User turn (tool results fed back). Contains `message.content` array with tool_result blocks. Has `parent_tool_use_id`. |
| `result` | `success` | Yes | | Turn completed successfully. Cost, usage, duration, final text. |
| `result` | `error_during_execution` | Yes | | Turn failed. Error messages. |
| `result` | `error_max_turns` | Yes | | Max turns reached. |
| `result` | `error_max_budget_usd` | Yes | | Budget exceeded. |
| `result` | `error_max_structured_output_retries` | Yes | | Structured output validation failed. |
| `rate_limit_event` | — | Yes | | Rate limit hit (or allowed — we filter for non-allowed). |
| `tool_progress` | — | Yes* | | Periodic heartbeat while Bash/PowerShell runs. *Only emitted when `CLAUDE_CODE_REMOTE` or `CLAUDE_CODE_CONTAINER_ID` is set. Throttled to every 30s per tool. |
| `tool_use_summary` | — | No** | | LLM-generated summary of preceding tool uses. **Filtered from output stream internally.** |
| `stream_event` | — | No | `--include-partial-messages` | Raw Anthropic API streaming deltas (message_start, content_block_delta, etc.). |
| `auth_status` | — | No | `enableAuthStatus` | Auth flow progress. Internal only. |
| `prompt_suggestion` | — | No | `promptSuggestions` | Suggested next user prompt. Feature-flagged. |
| `control_request` | `can_use_tool` | Yes (interactive modes) | | Permission prompt — Claude wants to use a tool. |
| `control_request` | other subtypes | Yes | | See §4 for full list. |
| `control_response` | — | No** | | Filtered from output. Internal protocol. |
| `control_cancel_request` | — | No** | | Filtered from output. Internal protocol. |

*"Filtered from output" means Claude Code's output adapter explicitly removes these from the stdout stream before emission. They exist internally but are not part of the consumer-facing contract.*

### Events synthesized by Klaudii (not from Claude CLI)

| Type | Origin | Description |
|------|--------|-------------|
| `_replay_seed` | `claude-chat.js` connectRelay | Seeds accumulators with pre-restart content after relay replay. Internal, never reaches frontend. |
| `permission_request` | `claude-chat.js` connectRelay | Converted from `control_request`/`can_use_tool`. Forwarded to frontend. |
| `done` | `server.js` | Synthesized after `result` event. Signals turn completion to frontend. |
| `error` | `server.js` | Synthesized on relay error, validation failures, etc. |
| `streaming_start` | `server.js` | Sent to other WS clients when a message is submitted. |
| `user_message` | `server.js` | Echoes user message to other WS clients. |
| `draft` | `server.js` | Draft text sync between windows. |

---

## 3. Event Schemas (Full)

### `assistant`

```typescript
{
  type: "assistant";
  uuid: string;
  session_id: string;
  parent_tool_use_id: string | null;  // null = main thread, set = subagent
  message: {
    id: string;
    type: "message";
    role: "assistant";
    model: string;
    content: (
      | { type: "text"; text: string }
      | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
      | { type: "thinking"; thinking: string; signature: string }
      | { type: "server_tool_use"; ... }     // web search
      | { type: "web_search_tool_result"; ... }
    )[];
    stop_reason: "end_turn" | "tool_use" | "max_tokens" | null;
    usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
  };
  error?: "authentication_failed" | "billing_error" | "rate_limit" | "invalid_request" | "server_error" | "unknown" | "max_output_tokens";
}
```

### `user`

```typescript
{
  type: "user";
  uuid?: string;
  session_id: string;
  parent_tool_use_id: string | null;
  message: {
    role: "user";
    content: (
      | { type: "text"; text: string }
      | { type: "tool_result"; tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean }
    )[];
  };
  isSynthetic?: boolean;
  tool_use_result?: unknown;  // shortcut for single tool result content
}
```

### `result`

```typescript
// Success:
{
  type: "result";
  subtype: "success";
  uuid: string;
  session_id: string;
  duration_ms: number;
  duration_api_ms: number;
  is_error: boolean;
  num_turns: number;
  result: string;                    // final text answer
  stop_reason: string | null;
  total_cost_usd: number;
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number };
  modelUsage: Record<string, { inputTokens: number; outputTokens: number; cacheCreation: number; cacheRead: number; total: number }>;
  permission_denials: { tool_name: string; message: string; request_id: string }[];
  structured_output?: unknown;
}

// Error variants: subtype is "error_during_execution" | "error_max_turns" | "error_max_budget_usd" | "error_max_structured_output_retries"
// Same fields but `errors: string[]` instead of `result`.
```

### `system` / `init`

```typescript
{
  type: "system";
  subtype: "init";
  uuid: string;
  session_id: string;
  agents?: string[];
  apiKeySource: string;
  betas?: string[];
  claude_code_version: string;
  cwd: string;
  tools: string[];
  mcp_servers: { name: string; status: string }[];
  model: string;
  permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk";
  slash_commands: string[];
  output_style: string;
  skills: string[];
  plugins: { name: string; path: string }[];
  fast_mode_state?: object;
}
```

### `system` / `status`

```typescript
{
  type: "system";
  subtype: "status";
  status: "compacting" | null;
  permissionMode?: string;
  uuid: string;
  session_id: string;
}
```

### `system` / `compact_boundary`

```typescript
{
  type: "system";
  subtype: "compact_boundary";
  compact_metadata: { trigger: "manual" | "auto"; pre_tokens: number };
  uuid: string;
  session_id: string;
}
```

### `system` / `hook_started`

```typescript
{
  type: "system";
  subtype: "hook_started";
  hook_id: string;
  hook_name: string;
  hook_event: string;   // "PreToolUse", "PostToolUse", etc.
  uuid: string;
  session_id: string;
}
```

### `system` / `hook_progress`

```typescript
{
  type: "system";
  subtype: "hook_progress";
  hook_id: string;
  hook_name: string;
  hook_event: string;
  stdout: string;
  stderr: string;
  output: string;
  uuid: string;
  session_id: string;
}
```

### `system` / `hook_response`

```typescript
{
  type: "system";
  subtype: "hook_response";
  hook_id: string;
  hook_name: string;
  hook_event: string;
  output: string;
  stdout: string;
  stderr: string;
  exit_code?: number;
  outcome: "success" | "error" | "cancelled";
  uuid: string;
  session_id: string;
}
```

### `system` / `task_started`

```typescript
{
  type: "system";
  subtype: "task_started";
  task_id: string;
  tool_use_id?: string;
  description: string;
  task_type?: string;   // e.g. "remote_agent"
  uuid: string;
  session_id: string;
}
```

### `system` / `task_progress`

```typescript
{
  type: "system";
  subtype: "task_progress";
  task_id: string;
  tool_use_id?: string;
  description: string;
  usage: { total_tokens: number; tool_uses: number; duration_ms: number };
  last_tool_name?: string;
  uuid: string;
  session_id: string;
}
```

### `system` / `task_notification`

```typescript
{
  type: "system";
  subtype: "task_notification";
  task_id: string;
  tool_use_id?: string;
  status: "completed" | "failed" | "stopped";
  output_file: string;
  summary: string;
  usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
  uuid: string;
  session_id: string;
}
```

### `system` / `files_persisted`

```typescript
{
  type: "system";
  subtype: "files_persisted";
  files: { filename: string; file_id: string }[];
  failed: { filename: string; error: string }[];
  processed_at: string;   // ISO timestamp
  uuid: string;
  session_id: string;
}
```

### `system` / `local_command_output`

```typescript
{
  type: "system";
  subtype: "local_command_output";
  content: string;
  uuid: string;
  session_id: string;
}
```

### `system` / `elicitation_complete`

```typescript
{
  type: "system";
  subtype: "elicitation_complete";
  mcp_server_name: string;
  elicitation_id: string;
  uuid: string;
  session_id: string;
}
```

### `tool_progress`

```typescript
{
  type: "tool_progress";
  tool_use_id: string;
  tool_name: string;          // "Bash" or "PowerShell"
  parent_tool_use_id: string | null;
  elapsed_time_seconds: number;
  task_id?: string;
  uuid: string;
  session_id: string;
}
```

**Emission rules:**
- Only emitted when `CLAUDE_CODE_REMOTE` or `CLAUDE_CODE_CONTAINER_ID` env var is set.
- Throttled: one per `parent_tool_use_id` per 30 seconds.
- Max 100 tracked tool IDs (LRU eviction).

### `rate_limit_event`

```typescript
{
  type: "rate_limit_event";
  status: "allowed" | "rate_limited" | "overloaded" | "budget_exceeded";
  reset_time?: string;         // ISO timestamp
  retry_after_seconds?: number;
  model?: string;
  uuid: string;
  session_id: string;
}
```

### `stream_event` (requires `--include-partial-messages`)

```typescript
{
  type: "stream_event";
  event: BetaRawMessageStreamEvent;  // Raw Anthropic API delta
  parent_tool_use_id: string | null;
  uuid: string;
  session_id: string;
}
```

Inner `event` types include:
- `message_start` — `{ type: "message_start", message: { usage } }`
- `content_block_start` — `{ type: "content_block_start", index: number, content_block: { type: "text" | "tool_use" | "thinking", ... } }`
- `content_block_delta` — `{ type: "content_block_delta", index: number, delta: { type: "text_delta", text: string } | ... }`
- `content_block_stop` — `{ type: "content_block_stop", index: number }`
- `message_delta` — `{ type: "message_delta", usage, delta: { stop_reason } }`
- `message_stop`

### `prompt_suggestion` (feature-flagged)

```typescript
{
  type: "prompt_suggestion";
  suggestion: string;
  uuid: string;
  session_id: string;
}
```

---

## 4. Control Protocol

The control protocol is bidirectional JSON over stdin/stdout, enabled by `--permission-prompt-tool stdio`.

### 4a. `control_request` (CLI → Host)

```typescript
{
  type: "control_request";
  request_id: string;   // UUID, must be echoed in response
  request: ControlRequestPayload;
}
```

#### `can_use_tool` — Permission prompt

```typescript
{
  subtype: "can_use_tool";
  tool_name: string;
  input: Record<string, unknown>;           // tool parameters
  tool_use_id: string;
  agent_id?: string;                        // present if from a subagent
  description?: string;                     // human-readable description of what the tool will do
  permission_suggestions?: PermissionUpdate[];  // suggested "always allow" rules
  blocked_path?: string;                    // file path that triggered the request
  decision_reason?: string;                 // why this needs approval
}
```

#### Other subtypes (for reference)

| Subtype | Direction | Purpose |
|---------|-----------|---------|
| `initialize` | CLI→Host | Session initialization (hooks, MCP servers, agent config) |
| `interrupt` | CLI→Host | Interrupt current turn |
| `set_permission_mode` | Host→CLI | Change permission mode mid-session |
| `set_model` | Host→CLI | Change model mid-session |
| `set_max_thinking_tokens` | Host→CLI | Change thinking budget |
| `mcp_status` | Host→CLI | Request MCP server status |
| `rewind_files` | Host→CLI | Rewind file changes |
| `hook_callback` | CLI→Host | Hook callback data |
| `mcp_message` | Host→CLI | Forward JSON-RPC to MCP server |
| `mcp_set_servers` | Host→CLI | Replace dynamic MCP servers |
| `mcp_reconnect` | Host→CLI | Reconnect failed MCP server |
| `mcp_toggle` | Host→CLI | Enable/disable MCP server |
| `stop_task` | Host→CLI | Stop a background task |
| `get_settings` | Host→CLI | Retrieve effective settings |
| `elicitation` | CLI→Host | MCP server requests user input (form or URL) |

### 4b. `control_response` (Host → CLI)

```typescript
// Success:
{
  type: "control_response";
  response: {
    subtype: "success";
    request_id: string;
    response?: Record<string, unknown>;
  }
}

// Error:
{
  type: "control_response";
  response: {
    subtype: "error";
    request_id: string;
    error: string;
    pending_permission_requests?: string[];
  }
}
```

#### `can_use_tool` response payload (`response` field)

```typescript
// Allow:
{ behavior: "allow"; updatedInput: Record<string, unknown>; updatedPermissions?: PermissionUpdate[]; toolUseID?: string }

// Deny:
{ behavior: "deny"; message: string; interrupt?: boolean; toolUseID?: string }
```

### 4c. `control_cancel_request` (Host → CLI)

Cancels a pending control_request (e.g., when aborting a turn):
```typescript
{ type: "control_cancel_request"; request_id: string }
```

### 4d. Host-initiated control requests

The host can proactively send these at any time:
- `set_model` — change model for subsequent turns
- `set_permission_mode` — change permission mode
- `set_max_thinking_tokens` — change thinking budget
- `stop_task` — stop a background agent
- `mcp_*` — MCP server management
- `interrupt` — interrupt current turn
- `rewind_files` — revert file changes

---

## 5. Klaudii Handling Status

### Event handling matrix

| Event Type | relay-daemon | normalizeEvent | connectRelay | server.js | gemini.js | Status |
|------------|:------------:|:--------------:|:------------:|:---------:|:---------:|--------|
| `system`/`init` | Pass-through | → `{type:"init"}` | Captures session ID | Broadcast | Logs session ID | **Full** |
| `system`/`status` | Pass-through | **Dropped** | — | — | — | **Missing** |
| `system`/`compact_boundary` | Pass-through | **Dropped** | — | — | — | **Missing** |
| `system`/`hook_*` | Pass-through | **Dropped** | — | — | — | **Missing** |
| `system`/`task_started` | Pass-through | **Dropped** | — | — | — | **Missing** |
| `system`/`task_progress` | Pass-through | **Dropped** | — | — | — | **Missing** |
| `system`/`task_notification` | Pass-through | **Dropped** | — | — | — | **Missing** |
| `system`/`files_persisted` | Pass-through | **Dropped** | — | — | — | **Missing** (N/A for local) |
| `system`/`local_command_output` | Pass-through | **Dropped** | — | — | — | **Missing** |
| `system`/`elicitation_complete` | Pass-through | **Dropped** | — | — | — | **Missing** |
| `assistant` (text) | Pass-through | → `{type:"message"}` | Accumulates partials | Accumulates text | Renders markdown | **Full** |
| `assistant` (tool_use) | Pass-through | → `{type:"tool_use"}` | — | Accumulates batch | Renders tool pill | **Full** |
| `assistant` (thinking) | Pass-through | **Dropped** | — | — | — | **Missing** |
| `assistant` (parent_tool_use_id) | Pass-through | **Ignored** | — | — | — | **Missing** |
| `user` (tool_result) | Pass-through | → synthetic `result` + `tool_result` | — | Accumulates batch | Renders tool result | **Full** |
| `result` (success) | Pass-through | → `{type:"result", stats}` | Clears partials | Persists + broadcasts `done` | Logs stats | **Full** |
| `result` (error variants) | Pass-through | → `{type:"result", stats}` | Same | Same | Same | **Partial** (error info lost) |
| `rate_limit_event` | Pass-through | → `{type:"status"}` | — | Broadcast | Shows status | **Full** |
| `tool_progress` | Pass-through | **Dropped** | — | — | — | **Missing** (needs env var) |
| `tool_use_summary` | Pass-through | **Dropped** | — | — | — | **Missing** (filtered by CLI) |
| `stream_event` | Pass-through | **Dropped** | — | — | — | **Missing** (needs flag) |
| `control_request`/`can_use_tool` | Pass-through | N/A (intercepted) | → `permission_request` | Stores pending + broadcast | Shows approval UI | **Full** |
| `control_request`/other | Pass-through | N/A (intercepted) | **Dropped** | — | — | **Missing** |
| `prompt_suggestion` | Pass-through | **Dropped** | — | — | — | **Missing** (feature-flagged) |

### Frontend → Server message handling

| Frontend message | server.js handler | Klaudii → Claude stdin | Status |
|------------------|-------------------|------------------------|--------|
| `send` | Spawns relay / appends message | `{type:"user", message:{role:"user", content:...}}` | **Full** |
| `stop` | Kills process | N/A (SIGTERM) | **Full** |
| `draft` | Broadcasts + persists | N/A | **Full** |
| `permission_response` | `sendControlResponse` | `{type:"control_response", response:{...}}` | **Full** |
| `tool_result_response` | `sendToolResult` | `{type:"tool_result", tool_use_id, content}` | **Full** |
| Model change | — | — | **Missing** (no `set_model` control request) |
| Permission mode change | — | — | **Missing** (no `set_permission_mode` control request) |
| Stop background task | — | — | **Missing** (no `stop_task` control request) |
| Interrupt turn | — | — | **Missing** (no `interrupt` control request) |

---

## 6. Gaps, Bugs, and Missing Features

### Critical gaps

1. **No model switching at runtime** — The model selector in the UI does nothing for active sessions. There's no code to send a `set_model` control request to the relay. Model is only set at relay launch.

2. **No `parent_tool_use_id` tracking** — Subagent output is mixed into the main thread with no nesting. All `assistant`/`user` events from subagents appear as top-level messages.

3. **No background task tracking** — `task_started`, `task_progress`, `task_notification` are all dropped. Background agents are invisible.

4. **Permission response is incomplete** — We send `behavior: "allow"` with the original `tool_input` as `updatedInput`, but never send `updatedPermissions` (for "always allow this" rules). We also never send `interrupt: true` on deny.

### Important gaps

5. **No `tool_progress` support** — Long-running Bash commands show no progress. Need to set `CLAUDE_CODE_REMOTE=1` env var on the relay daemon and handle `tool_progress` events. Could show elapsed time on tool pills.

6. **No thinking block rendering** — Extended thinking content is dropped in `normalizeEvent`. Could show in a collapsible section.

7. **No compaction awareness** — `compact_boundary` is dropped. Could show a "Context compacted" indicator.

8. **No MCP elicitation support** — If an MCP server requests user input, the `elicitation` control_request is dropped and Claude blocks.

9. **No `result` error variant handling** — All result subtypes are treated identically. Error results (`error_during_execution`, `error_max_turns`, `error_max_budget_usd`) lose their error messages and `errors[]` array.

10. **`tool_use_summary` not used** — The CLI filters this from output, but if we could access it (via SDK mode or source modification), it would provide nice summaries.

### Minor gaps

11. **No `status` event handling** — Permission mode changes and compaction status are invisible.

12. **No hook event handling** — Hook execution is invisible (though hooks may not be common in Klaudii's use case).

13. **`description` and `decision_reason` not surfaced** — `control_request`/`can_use_tool` includes human-readable `description` and `decision_reason` fields that we strip when converting to `permission_request`.

14. **No `control_cancel_request` support** — Can't cancel pending permission prompts from the UI.

15. **Plan rejection in bypass mode is broken** — `gemini.js` sends `{type:"message"}` which the server doesn't handle (expects `{type:"send"}`).

### Bugs found during audit

16. **`recoverStreams()` discards tool events** — During crash recovery of orphaned stream logs (when relay daemon is also dead), only assistant text is extracted. `tool_use` and `tool_result` events are lost.

17. **`awaiting_approval` check is dead code for Claude** — The `event.awaiting_approval` branch in `handleGeminiEvent` only fires for Gemini A2A, never for Claude CLI events.

18. **Double `result` possible** — If Claude CLI emits a real `result` followed by a `user` event in the same turn, `normalizeEvent` synthesizes a second `result`. Server handles this gracefully (empty batch), but it's wasteful.
