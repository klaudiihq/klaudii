# Slash Command Worker Instructions

You are implementing slash commands for Klaudii, a web-based manager for Gemini CLI sessions. Your job is to pick ONE open slash command issue from GitHub, implement it, test it, and push.

## Startup Checklist

```bash
# 1. Clean worktree — if dirty, stash it
git status
# If there are uncommitted changes:
git stash push -m "WIP from previous session"

# 2. Pull latest
git pull --rebase origin main

# 3. Verify remote
git remote get-url origin  # MUST be klaudiihq/klaudii-dev.git

# 4. Run tests — establish baseline
npx vitest run
# Note: test/functional/relay-lifecycle.test.js has 1 known failure. Ignore it.
# All other tests must pass.
```

## Pick an Issue

```bash
# List open slash command issues
gh issue list --repo klaudiihq/klaudii-dev --search "slash command" --label enhancement --state open --json number,title --limit 50

# Check if any are already in-progress
gh issue list --repo klaudiihq/klaudii-dev --label in-progress --json number,title
```

**Rules for picking:**
- If there is an `in-progress` issue with no recent activity, take it over (remove the label first, re-add after you claim it).
- Otherwise, pick any open issue. Prefer lower-numbered issues (they tend to be simpler).
- Skip issue #36 (`/corgi`) — it's already implemented.
- Skip issue #34 (`/quit, /vim, /setup-github, /terminal-setup`) — these are TUI-only and explicitly out of scope for the web UI.
- Skip issue #35 (`Custom slash commands`) — this is a meta-issue about the command loader infrastructure, not a single command.

**Claim it:**
```bash
gh issue edit <NUMBER> --repo klaudiihq/klaudii-dev --add-label in-progress
gh issue comment <NUMBER> --repo klaudiihq/klaudii-dev --body "Claiming this issue. Plan: <your 2-3 sentence plan>"
```

## Read the Issue

```bash
gh issue view <NUMBER> --repo klaudiihq/klaudii-dev
```

Read the full issue body. It describes:
- **Current behavior** — what exists now
- **TUI behavior** — what the terminal Gemini CLI does (your reference)
- **Desired behavior** — what the web UI should do
- **Implementation hints** — where to add code
- **Complexity** — rough difficulty estimate

## Architecture — How Slash Commands Work

### The End-to-End Flow

```
User types "/" in chat input
        ↓
chat.js: SLASH_COMMANDS array → autocomplete menu appears
        ↓
User selects command (Tab/Enter/click)
        ↓
chat.js: chatSelectSlashCommand() → sends WebSocket message:
    { type: "command", workspace, sessionNum, command: "stats", args: [] }
        ↓
server.js (line ~1011): WebSocket handler receives it
    → validates workspace + command
    → rejects if backend !== "gemini"
    → calls gemini.executeCommand(workspace, sessionNum, cmdName, args)
        ↓
lib/gemini.js (line ~737): delegates to a2a.executeCommand()
        ↓
lib/gemini-a2a.js (line ~838): HTTP POST to local A2A server
    → POST http://localhost:{port}/executeCommand { command, args }
        ↓
@google/gemini-cli-a2a-server CommandRegistry
    → looks up command → executes → returns JSON result
        ↓
Back up through: a2a → gemini.js → server.js WebSocket:
    { type: "command_result", workspace, command, data: {...} }
        ↓
chat.js (line ~1505): renders data as <pre> inside a system note
```

### Two Categories of Commands

**Category A: Backend commands** — need the Gemini A2A server to execute them.
These call real Gemini CLI functionality (stats, model info, tools list, settings, memory, etc.).
The A2A server has a CommandRegistry at:
```
node_modules/@google/gemini-cli-a2a-server/dist/src/commands/command-registry.js
```
Currently registered: `extensions`, `restore`, `init`, `memory` (with subcommands).

To see how a backend command is implemented, read:
```
node_modules/@google/gemini-cli-a2a-server/dist/src/commands/memory.js   # good example
node_modules/@google/gemini-cli-a2a-server/dist/src/commands/extensions.js
node_modules/@google/gemini-cli-a2a-server/dist/src/commands/restore.js
```

The A2A server also exposes `GET /listCommands` to enumerate registered commands.

**Category B: Frontend-only commands** — handled entirely in chat.js, no server round-trip.
Examples: `/help` (show keybindings), `/docs` (open URL), `/copy` (clipboard), `/clear` (clear chat),
`/shortcuts` (toggle UI panel), `/theme` (CSS toggle), `/bug` (open GitHub issue URL), `/about` (show version).

For these, intercept in `chatSelectSlashCommand()` BEFORE the WebSocket send — like `/corgi` does now.

### Where Things Live

| What | File | Lines |
|------|------|-------|
| Command list (client) | `public/chat.js` | ~3644-3655 |
| Slash menu open/close/filter | `public/chat.js` | ~3662-3718 |
| Command execution | `public/chat.js` | ~3720-3748 (`chatSelectSlashCommand`) |
| Keyboard handling (arrows, tab, enter, esc) | `public/chat.js` | ~3752-3801 (`chatInputKeydown`) |
| Hidden command intercept | `public/chat.js` | ~3816-3826 (in `sendGeminiMessage`) |
| WebSocket command handler | `server.js` | ~1011-1027 |
| Gemini command proxy | `lib/gemini.js` | ~737-739 |
| A2A HTTP bridge | `lib/gemini-a2a.js` | ~838-848 |
| A2A command registry | `node_modules/@google/gemini-cli-a2a-server/dist/src/commands/command-registry.js` |
| A2A HTTP endpoint | `node_modules/@google/gemini-cli-a2a-server/dist/src/http/app.js` | ~90-141 |
| Command result rendering | `public/chat.js` | ~1505-1516 (case "command_result") |
| Command error rendering | `public/chat.js` | ~1518-1522 (case "command_error") |
| Slash menu CSS | `public/chat.css` | search for `.chat-slash-` |
| Corgi CSS | `public/chat.css` | search for `.chat-corgi-` |

### TUI Reference Code (Gemini CLI internals)

The Gemini CLI's own command implementations live in:
```
node_modules/@google/gemini-cli-core/dist/src/commands/     # core command logic
node_modules/@google/gemini-cli-a2a-server/dist/src/commands/  # A2A wrappers
```

Additional reference for data these commands surface:
```
node_modules/@google/gemini-cli-core/dist/src/config/config.js     # settings, model config
node_modules/@google/gemini-cli-core/dist/src/tools/tools.js       # tool registry
node_modules/@google/gemini-cli-core/dist/src/agents/registry.js   # agent list
node_modules/@google/gemini-cli-core/dist/src/core/client.js       # stats, model info
```

**Not every command has a TUI equivalent you need to study.** Commands like `/help`, `/docs`, `/copy`, `/clear`, `/shortcuts`, `/theme`, `/bug`, `/about`, and `/privacy` are simple frontend features that don't need Gemini CLI internals. Just implement them directly.

## Implementation Guide

### Adding a Frontend-Only Command

1. **Add to SLASH_COMMANDS array** in `public/chat.js` (~line 3644):
   ```js
   { name: "yourcommand", description: "What it does" },
   ```

2. **Handle in chatSelectSlashCommand()** (~line 3720) — add a case BEFORE the WebSocket send:
   ```js
   if (cmd.name === "yourcommand") {
     // Do your thing (DOM manipulation, window.open, clipboard, etc.)
     chatAppendSystemNote("Your output here");
     return;  // Don't fall through to WS send
   }
   ```

3. **If it needs UI** (like a panel or card), add HTML to `public/index.html` and CSS to `public/chat.css`.

### Adding a Backend Command

1. **Add to SLASH_COMMANDS array** in `public/chat.js` (same as above).

2. **Let it fall through to the WebSocket send** — no special case needed in `chatSelectSlashCommand()`.

3. **If the A2A server already handles it** (check `GET /listCommands`), you're done on the backend. Just improve the client-side rendering of the result.

4. **If the A2A server does NOT handle it**, you may need to add a route in `server.js` or `lib/gemini.js` to fetch the data another way, or the command might need to query the Gemini A2A server's existing endpoints.

5. **Improve rendering** — the default renderer is a raw `<pre>` JSON dump (line ~1507). For a good UX, add a custom renderer in the `case "command_result"` block that checks `event.command` and renders appropriately (cards, tables, badges, etc.).

### Rendering Patterns

Look at existing chat rendering code for patterns:
- `chatAppendSystemNote(text)` — simple text note
- `chatAppendError(text)` — red error message
- `chatAppendMessage(role, content, ...)` — full message bubble

For richer rendering, create DOM elements directly and append to `document.getElementById("chat-messages")`.

## Testing

### Before you start coding:
```bash
npx vitest run
```
Note the pass count. All tests except the known relay-lifecycle failure must pass.

### After your changes:
```bash
npx vitest run
```
The same tests must still pass. Do not break existing functionality.

### Manual testing:
If you have access to a running Klaudii server, test your command by:
1. Opening the chat panel in a browser
2. Typing `/` to see the autocomplete menu
3. Selecting your command
4. Verifying the output renders correctly

If you can't test manually (no running server), that's OK — just make sure automated tests pass and your code is consistent with existing patterns.

### If you add new testable logic:
Consider adding a test in `test/unit/` or `test/contracts/`. This is optional for simple commands but encouraged for anything with logic.

## Committing and Pushing

```bash
# Stage your changes
git add public/chat.js public/chat.css public/index.html  # and any other files you changed
# Do NOT stage: config.json, workspace-state.json, sessions.json

# Commit — link the issue
git commit -m "Implement /commandname slash command

Resolves klaudiihq/klaudii-dev#<NUMBER>

- <brief description of what was implemented>
- <any notable design decisions>"

# Push
git push origin main
```

## Closing the Issue

```bash
gh issue edit <NUMBER> --repo klaudiihq/klaudii-dev --remove-label in-progress
# The "Resolves #N" in the commit message will auto-close the issue when pushed.
# If it doesn't auto-close:
gh issue close <NUMBER> --repo klaudiihq/klaudii-dev --comment "Implemented in <commit-hash>. <brief summary of what was built>."
```

## Final Output

When you're done, explain:
1. **Which issue** you implemented (number and title)
2. **What you built** — the user-facing behavior
3. **Key files changed** — with brief description of each change
4. **Design decisions** — anything non-obvious
5. **Test results** — before and after pass counts

## Important Notes

- **Do not refactor unrelated code.** Stay focused on your one issue.
- **Do not modify node_modules.** If you need different behavior from Gemini CLI internals, work around it in our code.
- **Do not break the existing slash commands** (compress, extensions, init, memory, model, restore, settings, stats, tools, corgi). They must continue to work.
- **Prefer simple implementations.** A working `/help` that shows a text list is better than a half-finished interactive panel.
- **chat.js is large (~2700 lines).** Navigate by searching for function names, not scrolling.
- **If you get stuck**, leave a comment on the issue explaining where you got stuck, remove the `in-progress` label, and move on to a simpler issue.
