# Klaudii

A web dashboard for managing multiple [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions across your projects.

Klaudii lets you run several Claude Code instances in parallel — each in its own tmux session with web terminal access — and monitor them from a single browser tab. Start, stop, restart, and switch between workspaces. Create new sessions from GitHub repos with automatic git worktree isolation. See CPU, memory, and uptime for every Claude process on your machine.

## Requirements

- macOS
- Node.js
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`npm install -g @anthropic-ai/claude-code`)
- [GitHub CLI](https://cli.github.com/) (`gh`) — for the new session / repo browser feature
- Xcode Command Line Tools — for the menu bar icon (optional, use `--skip-menu-bar-icon` to skip)

## Install

```bash
git clone <repo-url> && cd klaudii
./mac/install.sh
```

The install script checks dependencies (installs `tmux` and `ttyd` via Homebrew if missing), creates a default `config.json`, compiles the menu bar app, and registers a launchd agent so the server starts automatically at login.

Open **http://localhost:9876** to use the dashboard.

## Usage

- **Start/Continue/New** — Each workspace card has buttons to continue the last session, start a fresh one, or browse session history to resume a specific past session.
- **Terminal** — Opens a full-screen web terminal connected to the Claude session's tmux pane.
- **Open** — Links directly to the session on claude.ai/code (when available).
- **+ New Session** — Search your GitHub repos, pick a branch name, and Klaudii clones the repo (if needed), creates a git worktree, and starts Claude in it.
- **Free range claudes** — Any Claude processes running outside of Klaudii's managed sessions are listed with their PID, working directory, resource usage, and which app launched them.

## Configuration

Edit `config.json` (created by the installer) to add workspaces manually:

```json
{
  "port": 9876,
  "ttydBasePort": 9877,
  "reposDir": "/path/to/your/repos",
  "projects": [
    { "name": "my-project", "path": "/path/to/your/repos/my-project" }
  ]
}
```

## Menu bar

The optional menu bar app puts a **Kii** icon in your macOS menu bar with a quick link to open the dashboard. To have it launch at login, add `mac/menubar/KlaudiiMenu` to System Settings > General > Login Items.
