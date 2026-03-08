# Klaudii Codemap

Web-based manager for orchestrating multiple concurrent Claude/Gemini CLI sessions.
Node.js Express + Vanilla JS SPA + Chrome MV3 extension + E2E encrypted cloud relay.

## Architecture Overview

```
Browser/Extension ←→ Express server (port 9876) ←→ tmux sessions ←→ Claude/Gemini CLIs
                          ↕                              ↕
                    WebSocket (chat)              ttyd (web terminal)
                          ↕
                  Kloud Konnect relay (E2E encrypted remote access)
```

## Directory Structure

```
klaudii/
├── server.js              # Main entry point (~900 lines)
├── routes/v1.js           # REST API (~620 lines)
├── lib/                   # Backend modules (14 files)
├── public/                # Frontend SPA (vanilla JS)
├── extension/             # Chrome MV3 side panel
├── konnect/               # E2E encrypted cloud relay
├── iOS/                   # iOS Swift app (Xcode)
├── mac/                   # macOS menubar app (Swift)
├── test/                  # Vitest + Supertest tests
├── patches/               # npm patches (gemini-cli)
├── www/                   # Landing page
└── brand/                 # Logos, assets
```

---

## server.js (~900 lines)

Main Express server. Startup sequence:
1. Load config via `lib/projects`
2. Express app + JSON middleware + CORS (chrome-extension://, moz-extension://)
3. Setup mode (limp mode during dependency install) vs normal mode
4. Mount v1 API router at `/api`
5. Gemini-specific routes (install, models, quota, auth, history, sessions)
6. Claude chat history routes
7. WebSocket upgrade for live chat streaming

Key Gemini routes:
- `GET /api/gemini/status` — installation status
- `POST /api/gemini/install` — install gemini-cli
- `GET /api/gemini/models` — list models
- `POST /api/gemini/auth/login` — OAuth flow
- `GET /api/gemini/history/:project` — session messages
- `GET /api/gemini/sessions/:project` — session list
- `POST /api/gemini/clear/:project` — new session

---

## routes/v1.js (~620 lines)

v1 API contract (iOS app depends on this). All responses include `X-Klaudii-API-Version: 1`.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Server status (tmux, ttyd, auth) |
| GET | `/projects` | List registered projects |
| POST | `/projects` | Add project |
| GET | `/sessions` | All workspaces with status, URLs, git, mode |
| POST | `/sessions/start` | Start workspace (fresh, --continue, --resume) |
| POST | `/sessions/stop` | Kill workspace |
| POST | `/sessions/restart` | Stop + restart with --continue |
| POST | `/sessions/new` | Clone repo + worktree + start + register |
| GET | `/processes` | All Claude/Gemini processes with CPU/RAM |
| POST | `/processes/kill` | SIGTERM a process |
| GET | `/history` | Session history for project |
| GET | `/workspace-state/:ws` | Current mode, session, draft |
| PATCH | `/workspace-state/:ws` | Update mode, session, draft |

Permission mode builder (`buildClaudeArgs`):
- "yolo" → `--dangerously-skip-permissions remote-control`
- "ask" → `remote-control`
- "strict" → `--dangerously-skip-permissions --allowedTools "Read,Glob,Grep,..." remote-control`

---

## lib/ — Backend Modules

### claude-chat.js (~1300 lines) — **Largest backend file**
Claude CLI subprocess relay manager. Spawns `relay-daemon.js` per workspace.

Key functions:
- `startRelay(workspace, opts)` — spawn relay daemon (detached, survives server restart)
- `sendMessage(workspace, text, sessionNum, opts)` — send via Unix socket
- `stopProcess(workspace)` — kill relay
- `getHistory(workspace, sessionNum)` — load persisted messages
- `_normalizeEvent(raw)` — **CRITICAL**: converts Claude JSONL → Gemini-compatible format

Event normalization map:
- Claude `{type:"system", subtype:"init"}` → `{type:"init", session_id}`
- Claude `{type:"assistant"}` text → `{type:"message", role:"assistant", content, delta:true}`
- Claude `{type:"assistant"}` tool_use → `{type:"tool_use", tool_name, parameters}`
- Emits synthetic `{type:"result"}` on user event

Persistence: `~/Library/Application Support/com.klaudii.server/conversations/{workspace}/claude-local/{sessionNum}.json`

### relay-daemon.js (~200 lines) — Standalone executable
Per-workspace Claude relay subprocess. Survives server restarts.

- Spawns one Claude subprocess
- Buffers all raw JSONL events to append-only log
- Serves over Unix socket at `/tmp/klaudii-relay/{workspace}/relay.sock`
- Replay protocol: raw events → `{type:"relay_replay_end"}` → live events → `{type:"relay_exit"}`

### gemini.js (~900 lines)
Gemini CLI subprocess manager (print-mode or A2A backend).

Key functions:
- `startProcess(workspace, sessionNum, opts)` — spawn gemini subprocess
- `sendMessage(workspace, text, opts)` — send user message
- `fetchModels(config)`, `fetchQuota()` — model list & token quota
- `getHistory(workspace, sessionNum)` — session messages
- `newSession(workspace)`, `getSessions(workspace)` — session management
- `getStreamPartial(workspace)` — crash recovery

### gemini-a2a.js (~460 lines)
A2A (Agent-to-Agent) JSON-RPC 2.0 backend for Gemini CLI.

- HTTP POST via `@google/gemini-cli-a2a-server`
- One HTTP server per workspace on dynamic port
- Polls `/.well-known/agent-card.json` for startup detection

### tmux.js (~260 lines)
tmux session lifecycle.

Key functions:
- `createSession(name, projectDir, claudeArgs)`, `killSession(name)`
- `listSessions()`, `getClaudeSessions()`, `sessionExists(name)`
- `ensureWorkspaceTrust(projectDir)` — pre-accept workspace in ~/.claude.json
- `sendKeys(sessionName, text)` — stdin injection for worker dispatch
- `capturePane(sessionName)`, `getPaneProcessTree(sessionName)`
- `TMUX_SOCKET` — from config.json (must be absolute, identical in launchd vs interactive)

### processes.js (~260 lines)
Process discovery for Claude/Gemini instances.

- `findClaudeProcesses(managedPids)` — parses `ps`, identifies Claude/Gemini, aggregates CPU/RAM across process trees, determines launching app
- Returns: `[{pid, cwd, project, type, managed, uptime, cpu, memMB, launchedBy}, ...]`

### tasks.js (~457 lines)
SQLite task backend (replaces Dolt/beads).

- DB location: `~/Library/Application Support/com.klaudii/tasks.db`
- Schema: `tasks` table + `task_comments` table
- Functions: `create()`, `get()`, `list()`, `update()`, `addComment()`, `closeDb()`

### lifecycle.js (~40 lines)
Task state machine with valid transitions + warning on invalid ones.

### projects.js (~62 lines)
Config file management.

- Config path: `~/Library/Application Support/com.klaudii/config.json` (preferred), fallback to repo-local
- `loadConfig()`, `saveConfig()`, `getProjects()`, `addProject()`, `removeProject()`

### claude.js (~310 lines)
Session history reader from Claude CLI's `~/.claude/history.jsonl`.

- `getHistory(limit)`, `getHistoryForProject(projectPath, limit)`
- `getTokenUsage(hours)`, `getRateLimitEvents(hours)`

### session-tracker.js (~95 lines)
Workspace-to-session mapping (works around git worktree path issues).

- Persists to `sessions.json` in repo root
- `addSession(workspace, sessionId, mode)`, `getSessions(workspace)`

### workspace-state.js (~140 lines)
Per-workspace chat state (mode, session number, drafts).

- `getWorkspace(workspace)` → `{ mode, sessionNum, draft }`
- `isStreaming(workspace)`, `setStreaming(workspace, bool)` — in-memory
- Atomic writes (write .tmp then rename) to prevent corruption

### git.js (~140 lines)
Git operations for worktree-based development.

- `listWorktrees(repoDir)`, `addWorktree()`, `removeWorktree()`
- `getStatus(dir)` → `{ branch, dirtyFiles, unpushed, files }`

### github.js (~25 lines)
GitHub CLI (`gh`) integration — `listRepos()`, `getGitHubUser()`.

### ttyd.js (~96 lines)
Web terminal access — spawns ttyd processes on allocated ports (9877+).

### setup.js (~430 lines)
Dependency checker/installer (tmux, ttyd, gh, Claude CLI). SSE progress stream.

---

## public/ — Frontend SPA

### app.js (~1286 lines)
Main dashboard SPA. Session management, process monitoring, health polling.

Key functions:
- `refreshSessions()` — render workspace card grid
- `startSession()`, `stopSession()`, `restartSession()`
- `openTerminal()` — navigate to ttyd web terminal
- `cycleChatMode()` — switch between gemini / claude-local / claude-remote
- `openGeminiChat()` — open right-side chat panel
- `pollHealth()` — 3-second interval

### gemini.js (~2721 lines) — **Largest frontend file**
Gemini/Claude chat UI and WebSocket streaming.

Key functions:
- `openGeminiChat(project)` — init chat panel
- `geminiConnect(project, mode)` — WebSocket to backend
- `geminiSendMessage(text)` — send user input
- `renderGeminiMessage(event)` — render streamed chunks, tool calls
- `geminiHandleToolApproval(callId, approved)` — tool approval UI

WebSocket message types:
- `{type:"message", role, content, delta:true}` — streamed text
- `{type:"tool_use", tool_name, parameters, tool_id}` — needs approval
- `{type:"tool_result", tool_id, status, output}` — result
- `{type:"status", message}`, `{type:"error", message}`

### index.html (~240 lines)
Dashboard layout: header, sessions grid, gemini chat panel, modals.

### style.css (~1211 lines) + gemini.css (~725 lines)
Styling with CSS variables, light/dark theme, responsive layout.

---

## extension/ — Chrome MV3 Side Panel

### sidepanel.js (~1722 lines)
Side panel UI — workspace list, session browser, chat integration, Konnect pairing.

### background.js (~505 lines)
Service worker — message routing, tab management, approval state, Konnect key storage.

### manifest.json
Permissions: sidePanel, runtime, tabs, storage.local.

### options.html / options.js
Extension settings: server URL, Konnect pairing, API key, theme.

---

## konnect/ — Kloud Konnect (E2E Encrypted Cloud Relay)

### server/ (~1200 lines total)
Express server (port 3000) deployed on Fly.io.

- `lib/db.js` — SQLite (users, servers, pairing tokens)
- `lib/auth.js` — session management, Apple IAP verification
- `lib/pairing.js` — E2E key exchange via QR codes
- `lib/ws-hub.js` — WebSocket hub (browser ↔ local server relay)
- `lib/proxy.js` — encrypted request/response forwarding

### client/ (~150 lines)
Local integration — decrypts browser requests, makes local HTTP calls, encrypts responses.

---

## test/ — Test Suite

**Framework**: Vitest + Supertest

### contracts/ (8 files)
API response shape validation (iOS app compatibility):
health, sessions, processes, history, repos, projects, session-actions, usage

### unit/ (3 files)
- `normalize-event.test.js` — Claude → Gemini event normalization
- `persistence-invariants.test.js` — message persistence across restarts
- `lifecycle.test.js` — task state machine
- `shepherd-invariants.test.js` — source-grep guards

### functional/ (1 file)
- `shepherd-sim.test.js` — shepherd logic with real SQLite + mock workspaces

### helpers/server.js
Mock app factory for contract tests (matches iOS demo data).

### schemas/v1.js
Response shape validators for all v1 endpoints.

---

## Config & Data Paths

| What | Path |
|------|------|
| Config | `~/Library/Application Support/com.klaudii/config.json` |
| Tasks DB | `~/Library/Application Support/com.klaudii/tasks.db` |
| Chat history | `~/Library/Application Support/com.klaudii.server/conversations/` |
| Server logs | `~/Library/Application Support/com.klaudii/logs/server.log` |
| Relay sockets | `/tmp/klaudii-relay/{workspace}/relay.sock` |
| Launchd plist | `~/Library/LaunchAgents/com.klaudii.server.plist` |
| Workspace state | `{repo}/workspace-state.json` |
| Session tracking | `{repo}/sessions.json` |

---

## Service Management

```bash
# Restart server
launchctl kickstart -k gui/$(id -u)/com.klaudii.server

# View logs (filter cloud relay spam)
tail -f ~/Library/Application\ Support/com.klaudii/logs/server.log | grep -v "cloud\]"

# Run tests
npx vitest run
```

**CRITICAL**: Launchd plist MUST set `HOME=/Volumes/Fast/bryantinsley` — without it, `os.homedir()` resolves wrong, causing event loop spin on fs.stat.
