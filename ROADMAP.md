# Klaudii Roadmap

Everything we can imagine building, ordered roughly by dependencies and impact. Some of this is a weekend, some of it is years out. The point is to capture the full vision and then prioritize from it.

---

## Phase 1 — Solid Foundation

The stuff that should have been there from day one. Pay off tech debt, fix the rough edges, make the core reliable before building on top of it.

### Session reliability
- [x] New sessions should start in `remote-control` mode by default (currently starts with no args)
- [x] Detect when a Claude session crashes or exits — process tree health check on every poll
- [x] ~~Graceful shutdown~~ — not feasible; can't reliably inject keystrokes when TUI state is unknown (mid-approval, etc). `kill-session` sends SIGTERM which Claude handles gracefully already
- [x] Session health heartbeat — `isClaudeAlive()` checks process tree under tmux pane on each 10s poll
- [x] Handle the case where tmux session exists but Claude inside it has died — shows as "exited" (yellow badge) with Restart/Clean up actions

### Permissions model
- [x] Per-workspace permission mode: `--dangerously-skip-permissions` (current default), normal interactive, or custom allowlist — three modes: Yolo (auto-approve), Ask (terminal approval), Strict (read-only tools)
- [x] UI toggle on each workspace card to switch between permission modes — segmented control with color-coded active state
- [x] Support for `--allowedTools` flag — Strict mode uses `--allowedTools Read,Glob,Grep,WebSearch,WebFetch`
- [ ] "Supervised" mode — Claude runs but pauses for approval on destructive actions, approvals come through the dashboard

### Configuration
- [ ] Edit workspace settings from the dashboard (rename, change path, set permission mode, set Claude model)
- [x] Delete/archive workspaces from the dashboard (currently can only add) — removal with git cleanliness gating, force-confirm for dirty workspaces
- [ ] Per-workspace environment variables (some projects need specific env vars)
- [ ] Per-workspace Claude flags (model, system prompt, max turns)
- [ ] Import/export config for backup or sharing setups across machines

### UI polish
- [ ] Toast notifications instead of `alert()` for errors
- [ ] Loading skeletons instead of blank states during refresh
- [x] Workspace sorting — by recent activity and alphabetical, persisted in localStorage
- [ ] Drag-and-drop workspace card reordering
- [ ] Collapse/expand workspace cards
- [ ] Dark/light theme toggle (currently dark only)
- [ ] Keyboard shortcuts (S to stop, R to restart, T for terminal, Esc to close overlays)
- [ ] Responsive mobile layout improvements (the dashboard is usable on a phone but not great)
- [ ] Favicon

---

## Phase 2 — Visibility

You can't manage what you can't see. Make it easy to understand what every Claude is doing, has done, and is about to do.

### Live session output
- [ ] Stream tmux pane output to the dashboard in real-time (WebSocket) — see what Claude is doing without opening the terminal
- [ ] Compact "last activity" preview on each workspace card (last few lines of output)
- [ ] Activity indicator — show when Claude is actively generating vs. idle/waiting

### Session timeline
- [ ] Visual timeline of a session's activity: messages sent, tools used, files changed, commits made
- [ ] Link to specific conversation turns in claude.ai/code from the timeline
- [ ] Diff view — show what files Claude changed during a session

### Resource monitoring
- [ ] Historical CPU/memory graphs per workspace (not just current snapshot)
- [ ] Total resource usage across all sessions (system-wide impact)
- [ ] Alerts when a session is consuming too much memory or has been idle for too long
- [ ] Disk usage per workspace (worktrees can get big)

### Logs & audit
- [ ] Centralized log viewer in the dashboard — stream `/tmp/klaudii.log` and per-session logs
- [ ] Audit trail: who started/stopped what and when
- [ ] Export session history and activity logs

### Git awareness
- [x] Show current branch, last commit, dirty/clean status on each workspace card
- [x] Show uncommitted changes count — with clickable detail modal showing file-level status
- [ ] Diff viewer for pending changes in each workspace
- [ ] Commit history for the workspace's branch

---

## Phase 3 — Workflow Automation

Move from "manage sessions manually" to "define workflows and let Klaudii run them."

### Task queue
- [ ] Define tasks (from text, GitHub issues, or a task file) and assign them to workspaces
- [ ] Queue of pending tasks that get picked up by available workspaces
- [ ] Task status tracking: pending → assigned → in progress → review → done
- [ ] Priority levels for tasks
- [ ] Task dependencies (don't start task B until task A is done)

### Templates & presets
- [ ] Workspace templates — predefined configurations for common setups (e.g., "Next.js app with tests", "Python API with linting")
- [ ] Startup scripts — run arbitrary commands before starting Claude (e.g., `npm install`, `docker-compose up`)
- [ ] System prompt templates — reusable instructions per project type
- [ ] CLAUDE.md management — edit and sync CLAUDE.md files from the dashboard

### GitHub integration
- [ ] Create workspace from GitHub issue — pull issue description as the initial prompt
- [ ] Auto-create PR when Claude's work is done
- [ ] Link workspaces to GitHub issues/PRs bidirectionally
- [ ] Show CI status for the workspace's branch
- [ ] Comment on issues/PRs with session summaries

### Notifications
- [ ] Desktop notifications when a session completes, errors, or needs attention
- [ ] Webhook support — POST to a URL on session events
- [ ] Slack/Discord integration for session status updates
- [ ] Email digest of daily session activity

---

## Phase 4 — Multi-Claude Orchestration

The big one. Klaudii becomes a conductor, not just a dashboard. Multiple Claudes work together on coordinated tasks.

### Planning Claude
- [ ] A dedicated Claude instance that takes a high-level goal and breaks it into concrete tasks
- [ ] Planning Claude reads the codebase, writes a plan, and creates tasks (as GitHub issues, Beads, or internal task queue items)
- [ ] Plan review UI — human approves/edits the plan before execution begins
- [ ] Iterative planning — Planning Claude can revise the plan based on results from execution

### Execution Claudes
- [ ] Orchestrator automatically provisions workspaces for each task (clone, worktree, start)
- [ ] Each execution Claude picks up a task, does the work, commits, and reports back
- [ ] Parallel execution — multiple Claudes working on independent tasks simultaneously
- [ ] Resource-aware scheduling — don't start more Claudes than the machine can handle
- [ ] Automatic retry on failure with escalation to human if it fails repeatedly

### Review Claudes
- [ ] After an execution Claude finishes, a review Claude checks the work
- [ ] Code review against project standards, test coverage, security
- [ ] Review Claude can request changes (sends feedback back to the execution Claude)
- [ ] Multi-round review loop with a configurable max iterations before escalating to human

### Merge & verify pipeline
- [ ] Merge Claude — handles rebasing, conflict resolution, and merging approved work
- [ ] Verify Claude — checks that merged code builds, tests pass, and the feature works end-to-end
- [ ] Rollback support — if verification fails, automatically revert the merge
- [ ] Deploy Claude — triggers deployment after verification passes (staging first, then prod with approval)

### Workflow definitions
- [ ] YAML/JSON workflow files that define the full pipeline (plan → execute → review → merge → verify)
- [ ] Conditional steps (e.g., skip review for trivial changes, require human approval for breaking changes)
- [ ] Fan-out/fan-in — one planning step produces N tasks that execute in parallel, then converge for review
- [ ] Workflow templates for common patterns (feature development, bug fix, refactoring, dependency update)

### Coordination
- [ ] Shared context between Claudes working on the same project — avoid conflicting changes
- [ ] Lock files/directories so two Claudes don't edit the same code simultaneously
- [ ] Inter-Claude messaging — one Claude can ask another for information or flag a dependency
- [ ] Central knowledge base that all Claudes in a project can read/write

---

## Phase 5 — Testing & Quality

Build confidence that the work Claudes produce is actually correct.

### Klaudii's own tests
- [ ] Unit tests for all lib modules (tmux, ttyd, processes, git, etc.)
- [ ] Integration tests — start a real session, verify it works, stop it
- [ ] E2E tests for the dashboard using Playwright
- [ ] CI pipeline for Klaudii itself

### Work verification
- [ ] Auto-run tests after each Claude session completes (configurable test command per workspace)
- [ ] Test result reporting in the dashboard — pass/fail badge on workspace cards
- [ ] Coverage tracking — flag if a Claude's changes reduced test coverage
- [ ] Lint/format checking — auto-run linters after changes
- [ ] Type checking for TypeScript projects

### Visual verification
- [ ] Screenshot comparison — take before/after screenshots for UI changes
- [ ] Visual diff in the dashboard
- [ ] Playwright test integration — run visual tests as part of the review pipeline

### Security scanning
- [ ] Run security scanners on Claude's output (dependency audit, SAST)
- [ ] Flag secrets accidentally committed
- [ ] Review Claude specifically checks for OWASP top 10 in code changes

---

## Phase 6 — Rendezvous & Remote Access

Klaudii is currently trapped on `localhost:9876`. A cloud rendezvous service breaks it free — your phone, tablet, or any browser anywhere can reach your Klaudii instance without port forwarding, VPNs, or Tailscale. This also makes native mobile apps feasible.

### Rendezvous service
- [ ] Lightweight cloud relay (Cloud Run, Fly.io, or a single VPS) that Klaudii servers register with
- [ ] Klaudii server maintains a persistent WebSocket to the relay, heartbeating once per second
- [ ] Relay assigns a stable URL per machine (e.g., `bryants-mbp.klaudii.dev`)
- [ ] Clients connect to the relay URL — relay multiplexes WebSocket connections to the right Klaudii server
- [ ] Server pushes state updates to relay every 10 seconds (only when clients are connected, relay signals demand)
- [ ] End-to-end encryption between client and Klaudii server — relay is a dumb pipe
- [ ] Graceful reconnection — server reconnects automatically after network interruptions
- [ ] Relay shows "machine offline" to clients when heartbeat stops

### Authentication
- [ ] Token-based auth — Klaudii server generates a pairing token, scan QR code from phone to connect
- [ ] OAuth option — sign in with GitHub, relay verifies identity
- [ ] Per-device session tokens with revocation from the dashboard
- [ ] Dashboard authentication required when accessed via relay (localhost remains open)

### Mobile clients
- [ ] Mobile-optimized web dashboard — works today but needs responsive polish for phone-sized screens
- [ ] iOS app (SwiftUI) — native workspace cards, push notifications for session events, start/stop/restart
- [ ] Watch complication — glanceable session count and status
- [ ] iOS Shortcuts integration — "Hey Siri, start my filmschoolapp workspace"
- [ ] Push notifications via APNs — session completed, session crashed, review needed

### Protocol
- [ ] Binary WebSocket protocol for efficiency (not JSON over WS)
- [ ] Delta updates — only send what changed since last update, not full state
- [ ] Request/response over the tunnel — client can send API calls through the relay to the server
- [ ] Chunked terminal streaming — pipe tmux output through the relay for remote terminal access without ttyd port exposure

### Multi-machine
- [ ] Register multiple Klaudii servers with the same relay account
- [ ] Unified dashboard — see all machines' workspaces in one view
- [ ] Cross-machine workspace migration — move a session from laptop to desktop
- [ ] Remote workspace provisioning — start sessions on whichever machine has capacity
- [ ] Machine health monitoring — CPU, memory, disk across all registered machines

### Platform portability

Klaudii today is macOS-specific (launchd, swiftc menu bar app, Homebrew). It needs to run everywhere Claude Code runs.

- [ ] **Linux support** — systemd unit instead of launchd, skip menu bar app, apt/dnf fallbacks for tmux/ttyd
- [ ] **VPS mode** — headless install for remote servers (no menu bar, no desktop assumptions), bind to 0.0.0.0 with auth enabled by default
- [ ] **Single-workspace mode** — stripped-down Klaudii for constrained environments: one project, no git worktree management, no GitHub integration, just session lifecycle + terminal + monitoring. Ideal for Codespaces, Gitpod, or any environment where you're already in a repo
- [ ] **GitHub Codespaces** — devcontainer.json with Klaudii pre-configured, forwarded port, single-workspace mode auto-pointed at the Codespace repo
- [ ] **Docker image** — `docker run klaudii` with Claude CLI baked in, mount your repos as volumes, expose dashboard port. Works for local Docker Desktop or cloud container services
- [ ] **Cloud Run / serverless containers** — stateless Klaudii container that connects to a persistent disk or GCS for state, registers with the rendezvous relay on startup. Spin up on demand, scale to zero when idle
- [ ] **Docker Compose stack** — Klaudii + N Claude worker containers + shared volume, for running the orchestration pipeline entirely in containers
- [ ] **Devcontainer feature** — installable as a VS Code devcontainer feature so any Codespace can add Klaudii with one line in devcontainer.json

### Cloud instances
- [ ] Spin up cloud VMs (EC2, GCE) for heavy workloads, auto-register with relay
- [ ] Auto-terminate instances when work is done
- [ ] Cost tracking — show how much cloud compute each task used

---

## Phase 7 — Intelligence Layer

Make Klaudii smarter about how it manages work.

### Learning from history
- [ ] Track which types of tasks succeed/fail and adjust approach
- [ ] Recommend session settings based on project type and past performance
- [ ] Estimate task duration based on historical data
- [ ] Identify patterns in failed sessions and suggest fixes

### Smart scheduling
- [ ] Time-based scheduling — run maintenance tasks overnight
- [ ] Dependency-aware scheduling — start tasks as soon as their dependencies complete
- [ ] Priority queue with preemption — pause low-priority work when urgent tasks arrive
- [ ] Resource-aware batching — group small tasks together, serialize large ones

### Project intelligence
- [ ] Auto-detect project type and suggest appropriate CLAUDE.md, test commands, and workflow
- [ ] Monitor project health metrics over time (test coverage, build times, dependency freshness)
- [ ] Suggest refactoring opportunities based on code complexity trends

### Conversation analysis
- [ ] Summarize what each Claude accomplished in a session (beyond the raw history)
- [ ] Detect when a Claude is stuck in a loop or making no progress
- [ ] Auto-terminate sessions that have been spinning without meaningful output
- [ ] Extract learnings from sessions and feed them back into CLAUDE.md or project memory

---

## Phase 8 — Ecosystem

### CLI
- [ ] `klaudii start my-project` — start a workspace from the terminal
- [ ] `klaudii status` — show all workspaces and their status
- [ ] `klaudii logs my-project` — tail session logs
- [ ] `klaudii run "fix the login bug" --project my-app` — one-shot task execution

### API
- [ ] Documented REST API with OpenAPI spec
- [ ] Webhook subscriptions for session events
- [ ] API client libraries (TypeScript, Python)

### Plugins
- [ ] Plugin system for custom workflow steps
- [ ] Community plugin registry
- [ ] Custom dashboard widgets

### Integrations
- [ ] Linear/Jira — pull tasks from project management tools
- [ ] Slack bot — interact with Klaudii from Slack
- [ ] VS Code extension — manage workspaces from the editor
- [ ] GitHub App — respond to issue/PR events automatically

---

## What to build first

If I had to pick the order that delivers the most value fastest:

1. **Session reliability fixes** — the core has to be solid (Phase 1, top section)
2. **Permissions model** — not everything should run with `--dangerously-skip-permissions`
3. **Live session output** — seeing what Claude is doing without opening terminal is transformative
4. **Toast notifications + UI polish** — stop using `alert()`, make it feel professional
5. ~~**Git awareness on cards** — branch, dirty status, last commit~~ DONE
6. **Rendezvous service** — unlocks mobile access and breaks out of localhost; everything after this is more useful because you can monitor from anywhere
7. **Task queue** — the first step toward orchestration
8. **GitHub issue → workspace** — most natural way to seed work
9. **Auto-run tests** — essential before trusting orchestrated work
10. **iOS app** — once the relay exists, a native app is the natural next step
11. **Planning + execution pipeline** — the multiplier
12. **Review Claude** — close the loop on quality

Everything else builds on these. The rendezvous service is a force multiplier for everything that comes after — once you can monitor and control from your phone, the orchestration pipeline becomes something you can supervise from the couch. The long-term vision is Klaudii as the operating system for AI-assisted development, but each phase makes the tool meaningfully better on its own.
