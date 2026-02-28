# Klaudii — System Documentation

## Architecture

Klaudii is a Node.js Express server that orchestrates Claude Code CLI sessions using tmux for process isolation and ttyd for web terminal access. A browser-based dashboard provides the UI. An optional macOS menu bar app provides quick access.

```
Browser (localhost:9876)
  |
  |  REST API
  v
Express server (server.js)
  |
  |-- lib/tmux.js -----> tmux (session management)
  |-- lib/ttyd.js -----> ttyd (web terminal per session)
  |-- lib/processes.js -> ps (process discovery)
  |-- lib/claude.js ----> ~/.claude/ (session history)
  |-- lib/git.js -------> git (clone, worktrees)
  |-- lib/github.js ----> gh CLI (repo listing)
  |-- lib/projects.js --> config.json (project registry)
  |
  v
Claude Code CLI (one per workspace, in tmux)
```

## Components

### Express server (`server.js`)

The main process. Runs on port 9876 (configurable). Serves the static frontend from `public/` and exposes the REST API. On startup it calls `ttyd.recoverInstances()` to re-register any ttyd processes that survived a server restart.

**API endpoints:**

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Check tmux/ttyd availability |
| GET | `/api/sessions` | List all workspaces with status, claude.ai URL, ttyd port |
| POST | `/api/sessions/start` | Start a workspace (fresh, continue, or resume specific session) |
| POST | `/api/sessions/stop` | Stop a workspace (kills tmux + ttyd) |
| POST | `/api/sessions/restart` | Stop then restart with `--continue remote-control` |
| POST | `/api/sessions/new` | Clone repo + create worktree + register + start |
| GET | `/api/history` | Session history for a workspace (from Claude CLI's history) |
| GET | `/api/processes` | All Claude processes on the machine with resource stats |
| POST | `/api/processes/kill` | Send SIGTERM to a process |
| GET | `/api/github/repos` | List GitHub repos (via `gh` CLI) with local clone status |
| GET | `/api/projects` | List registered projects from config |
| POST | `/api/projects` | Add a project to config |

### tmux layer (`lib/tmux.js`)

All Claude sessions run inside tmux, using a dedicated socket (default `~/.claude/klaudii-tmux.sock`). This keeps Klaudii's sessions separate from any personal tmux usage.

> **CRITICAL — tmux socket path:** The socket MUST be an absolute path that resolves identically under both launchd (background service) and interactive shells. If they see different socket paths, they connect to different tmux servers and the dashboard can't see or control sessions. The path is read from `config.json` (`tmuxSocket` key), which is written at install time using `$HOME`. This avoids runtime dependence on `os.homedir()` (may return wrong value under launchd), `/tmp/` (private per-process on macOS), or `process.env.HOME` (not set under launchd). If `config.json` doesn't specify a socket, the fallback is project-relative (`.klaudii-tmux.sock` in the repo root). This was an extremely difficult bug to diagnose.

**Session lifecycle:**

1. `createSession(name, projectDir, claudeArgs)` — Creates a tmux session, `cd`s to the project directory, and runs `claude <args>` (flags depend on permission mode).
2. Before starting, `ensureWorkspaceTrust(projectDir)` writes `hasTrustDialogAccepted: true` into `~/.claude.json` for the project path. This prevents the interactive trust dialog from blocking headless startup.
3. `getClaudeUrlFromProcess(sessionName)` extracts the session ID from the Claude process's command-line args (`--session-id`), constructing a `https://claude.ai/code/` URL. This is more reliable than pane scraping since Claude's TUI uses an alternate screen buffer.
4. `isClaudeAlive(sessionName)` walks the process tree under the tmux pane to detect if Claude is still running (vs. the tmux session existing with a dead Claude inside).
5. `getManagedPids()` returns all tmux pane PIDs — used by process discovery to distinguish managed vs. unmanaged Claude instances.

**Session naming:** Project name `my-project` becomes tmux session `claude-my-project`.

### ttyd layer (`lib/ttyd.js`)

Each running workspace gets a ttyd instance that provides web terminal access to its tmux session. ttyd is spawned with `tmux -S <socket> attach -t <session>` as its command.

- Ports are allocated sequentially starting from `ttydBasePort` (default 9877).
- `recoverInstances()` scans `ps` output on server startup to re-register ttyd processes that are still running from before a restart.
- `stop()` kills the ttyd process by PID (handles both spawned processes and recovered ones where the process object is null).

### Process discovery (`lib/processes.js`)

`findClaudeProcesses(managedPids)` runs `ps -eo pid,ppid,pcpu,rss,etime,command` and:

1. Builds a parent-child process tree.
2. Finds all processes whose command includes "claude" (filtering out node, tmux, ttyd, grep, etc. and child `--sdk-url` subprocesses).
3. For each Claude process, determines if it's **managed** by walking up to 10 ancestor PIDs checking against the managed PID set from tmux.
4. **Aggregates CPU and memory** across the entire descendant tree — so if a Claude session spawns a dev server, database, build watcher, etc., those resources are included in the totals.
5. Uses `lsof -a -d cwd -p <pid>` to determine each process's working directory and derive the project name.
6. Walks the parent chain to find the **launching app** (e.g., "Terminal", "iTerm2", "VSCode") by matching `.app` bundle paths in ancestor commands.

### Session history (`lib/claude.js`)

Reads Claude CLI's own history file (`~/.claude/history.jsonl`) to provide per-workspace session history. Each entry contains a session ID, project path, timestamp, and display text. Also provides helpers to look up sessions by ID and to detect newly-created sessions by timestamp.

### Session tracking (`lib/session-tracker.js`)

Maintains Klaudii's own workspace-to-session mapping in `sessions.json`. This is necessary because Claude CLI's `history.jsonl` maps sessions by project path, which breaks for git worktree-based workspaces (Claude may resolve worktree paths to the main repo, causing all worktree sessions to appear under a single workspace).

**How it works:**

- When a session is started with `--resume`, the session ID is recorded immediately.
- For fresh and `--continue` sessions, `detectAndTrack()` polls `history.jsonl` in the background for up to 30 seconds to find the new session ID.
- The history endpoint uses tracked IDs as the primary source, with path-based lookup as a fallback for pre-tracking sessions.
- Session counts are exposed in the `/api/sessions` response for UI display.

### Git operations (`lib/git.js`)

Handles cloning repos and managing git worktrees for the "New Session" flow:

- `cloneRepo(sshUrl, targetDir)` — Clones via SSH.
- `addWorktree(repoDir, worktreePath, branch)` — Creates a new worktree on a new branch.
- `scanRepos(reposDir)` — Enumerates local repos in the configured repos directory.

### GitHub integration (`lib/github.js`)

Uses the `gh` CLI to list the authenticated user's repositories. The dashboard annotates each repo with whether it's already cloned locally.

### Project registry (`lib/projects.js`)

Manages `config.json`, which stores the list of registered workspaces (name + filesystem path). Projects are added either manually via the config file or automatically when creating a new session through the dashboard.

### Frontend (`public/`)

A single-page app with vanilla HTML/CSS/JS (no build step, no framework).

- **Dashboard** refreshes every 10 seconds, polling `/api/sessions` and `/api/processes`.
- **Workspace cards** show status (running/stopped), resource stats (CPU, memory, uptime), and action buttons.
- **Stopped workspaces** offer three options: Continue (last session), New (fresh), or History (pick a specific past session).
- **Terminal overlay** is a full-viewport iframe pointing at the ttyd port, with a top bar showing the workspace name and control buttons. The iframe is destroyed and recreated (rather than having its src changed) to avoid cross-origin `beforeunload` dialogs.
- **Free range claudes** section shows unmanaged Claude processes with PID, working directory, resource stats, launching app, and a two-step inline kill confirmation (no `window.confirm`).
- **New Session modal** searches GitHub repos, lets you select one and enter a branch name, then triggers the clone/worktree/start flow.

### Menu bar app (`menubar/KlaudiiMenu.swift`)

A minimal Cocoa app that puts a **Kii** icon in the macOS menu bar. The only action is "Open Dashboard" which opens `http://localhost:9876` in the default browser. Compiled with `swiftc` — requires Xcode Command Line Tools. Runs as an accessory app (no Dock icon).

### launchd agent

The install script generates a launchd plist (`com.klaudii`) that:

- Starts the Node.js server at login (`RunAtLoad`)
- Keeps it alive if it crashes (`KeepAlive`)
- Logs stdout/stderr to `/tmp/klaudii.log` and `/tmp/klaudii-error.log`

## Session modes

Claude Code sessions are started with `--dangerously-skip-permissions` (headless, no permission prompts) and one of:

| Mode | CLI args | When used |
|------|----------|-----------|
| Fresh | _(none)_ | "New" button — brand new session |
| Continue | `--continue remote-control` | "Continue" button or "Restart" — picks up the most recent session |
| Resume | `--resume <id> remote-control` | "Resume" from history — resumes a specific past session |

The `remote-control` flag makes the session accessible via claude.ai/code, and the dashboard extracts and links to that URL.

## File structure

```
klaudii/
├── server.js              # Express server + API routes
├── install.sh             # Installation script
├── package.json           # Node.js manifest (express dependency)
├── config.json            # User config (gitignored, generated by install)
├── sessions.json          # Session-to-workspace tracking (gitignored, auto-generated)
├── lib/
│   ├── tmux.js            # tmux session management
│   ├── ttyd.js            # ttyd web terminal management
│   ├── processes.js       # Process discovery + resource monitoring
│   ├── projects.js        # Project registry (config.json)
│   ├── claude.js          # Claude CLI session history
│   ├── session-tracker.js # Workspace-to-session mapping
│   ├── git.js             # Git clone + worktree operations
│   └── github.js          # GitHub repo listing (gh CLI)
├── public/
│   ├── index.html         # Dashboard HTML
│   ├── app.js             # Dashboard logic
│   └── style.css          # Dark theme styles
└── menubar/
    └── KlaudiiMenu.swift  # macOS menu bar app source
```
