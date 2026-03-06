# Klaudii Architect System

A three-tier autonomous build system where Claude instances design, monitor, and build Klaudii.

## Overview

```mermaid
graph TB
    subgraph User["User (Human)"]
        U[Multiple conversation threads]
    end

    subgraph Architect["Architect Claude"]
        A[Long-running session on main]
        A -->|creates| BEADS[(Beads JSONL)]
        A -->|reads| BEADS
        A -->|manages via| MCP[Klaudii MCP Server]
    end

    subgraph Shepherd["Shepherd Claude"]
        S[Ephemeral - boots every 5 min]
        S -->|reads/writes| BEADS
        S -->|checks| WT1[Worktree health]
        S -->|dispatches| W1
        S -->|dispatches| W2
        S -->|escalates to| A
    end

    subgraph Workers["Worker Claudes"]
        W1[Worker on feat-branch-1]
        W2[Worker on feat-branch-2]
        W1 -->|updates| BEADS
        W2 -->|updates| BEADS
    end

    U -->|steers| A
    A -->|reviews| Workers
    S -->|monitors| Workers

    MCP -->|REST| SERVER[Klaudii Server :9876]
    SERVER -->|manages| Workers
```

## Roles

### Architect Claude

The strategic brain. Lives on `main` in a long-running Klaudii session.

**Does:**
- Discusses product direction with the user
- Designs features, writes specs
- Creates Beads with SCRUM_MASTER rigor (Goal, Specs, Verification, Safety)
- Reviews completed work at a high level
- Makes judgment calls about scope, priority, approach

**Does NOT:**
- Read source files directly
- Run tests or builds
- Edit code
- Hold operational state (delegates to Shepherd)

### Shepherd Claude

The operations manager. Boots every ~5 minutes, reads state, acts, exits.

**Does:**
- Reads all Beads to build a picture of system state
- Checks worktree health (git status, test results, stuck processes)
- Dispatches ready Beads to available workspaces
- Files fix Beads when tests break
- Rolls back bad commits
- Answers simple worker questions via Bead comments
- Escalates design questions to the Architect

**Key property:** Fresh context every run. Compaction is impossible.

### Worker Claude

The builder. Lives on a feature branch in a git worktree.

**Does:**
- Receives a Bead, does the work
- Updates Bead status via `bd`
- Leaves comments if blocked
- May decompose its task into sub-Beads
- Follows Landing the Plane protocol (push before exit)

**Does NOT:**
- Initiate conversations
- Talk to other Workers
- Make architectural decisions

## Communication Flow

```mermaid
sequenceDiagram
    participant U as User
    participant A as Architect
    participant B as Beads
    participant S as Shepherd
    participant W as Worker

    U->>A: "We need feature X"
    A->>A: Designs spec
    A->>B: Creates Bead with Goal/Specs/Verification/Safety

    Note over S: Boots (every 5 min)
    S->>B: Reads all Beads
    S->>S: Finds ready Bead
    S->>W: Creates workspace + assigns Bead

    W->>W: Reads Bead, does work
    W->>B: Updates status: in_progress

    alt Worker blocked
        W->>B: Adds comment with question
        Note over S: Next boot
        S->>B: Sees question
        S->>B: Answers or escalates to Architect
    end

    W->>B: Updates status: closed
    W->>W: git push (Landing the Plane)

    Note over S: Next boot
    S->>B: Sees completed Bead
    S->>S: Validates tests pass

    Note over A: Periodic check-in
    A->>B: Reads completion
    A->>U: "Feature X is done, here's the summary"
```

## Shared Knowledge Hierarchy

All participants share the same understanding, layered by abstraction:

```mermaid
graph TB
    P[Principles<br/>Why we build] --> M[Modes of Operation<br/>How the system runs]
    M --> F[Features & Surfaces<br/>What we're building]
    F --> I[Implementations<br/>How it's built]

    A[Architect] -.->|works at| P
    A -.->|works at| M
    S[Shepherd] -.->|works at| M
    S -.->|works at| F
    W[Workers] -.->|works at| F
    W -.->|works at| I

    style P fill:#2d5016,color:#fff
    style M fill:#1a4a1a,color:#fff
    style F fill:#0d3d0d,color:#fff
    style I fill:#003300,color:#fff
```

This hierarchy lives in project docs: `AGENTS.md`, `CLAUDE.md`, `planning/`.

## Data Model

### Bead (Task)

```mermaid
erDiagram
    BEAD {
        string id PK "klaudii-xxx"
        string title
        string description "Goal + Specs + Verification + Safety"
        string status "open | in_progress | blocked | closed"
        int priority "0=critical ... 4=backlog"
        string issue_type "task | bug | feature | epic"
        string assignee "optional"
        datetime created_at
        datetime updated_at
        datetime closed_at
        string close_reason
    }

    BEAD ||--o{ BEAD : "depends on"
    BEAD ||--o{ COMMENT : "has"

    COMMENT {
        string author
        string body
        datetime created_at
    }
```

### Workspace

```mermaid
erDiagram
    WORKSPACE {
        string name PK "repo--branch"
        string path "git worktree path"
        string branch
        string status "running | exited | stopped"
        string bead_id FK "assigned task"
        string role "worker | shepherd"
        datetime started_at
        datetime last_activity
    }

    WORKSPACE ||--o| BEAD : "works on"
    WORKSPACE ||--o{ MESSAGE : "chat history"

    MESSAGE {
        string sender "user | assistant | architect | shepherd"
        string content
        datetime timestamp
    }
```

### Chat Message with Sender

```mermaid
graph LR
    subgraph Chat["Workspace Chat"]
        M1["User: Build the REST API<br/><small>bubble: default</small>"]
        M2["Architect: Here's the spec...<br/><small>bubble: dark green</small>"]
        M3["Assistant: I'll start with...<br/><small>bubble: assistant default</small>"]
        M4["Shepherd: Tests failing, rolling back<br/><small>bubble: amber</small>"]
    end

    style M1 fill:#2563eb,color:#fff
    style M2 fill:#166534,color:#fff
    style M3 fill:#374151,color:#fff
    style M4 fill:#92400e,color:#fff
```

## Infrastructure

### Klaudii MCP Server

A Node.js MCP server the Architect connects to via Claude Code's MCP configuration.

```mermaid
graph LR
    subgraph Architect["Architect (Claude Code CLI)"]
        AC[Claude Code] -->|MCP protocol| MCP
    end

    subgraph MCP["Klaudii MCP Server"]
        T1[klaudii_list_workspaces]
        T2[klaudii_create_workspace]
        T3[klaudii_send_message]
        T4[klaudii_get_status]
        T5[klaudii_read_beads]
        T6[klaudii_create_bead]
        T7[klaudii_update_bead]
    end

    subgraph Server["Klaudii Server :9876"]
        API[REST API]
        WS[WebSocket]
        API --> TMUX[tmux]
        API --> TTYD[ttyd]
        API --> GIT[git worktrees]
        WS --> CHAT[Chat relay]
    end

    MCP -->|HTTP| API
```

### MCP Tool Specifications

| Tool | Parameters | Returns |
|------|-----------|---------|
| `klaudii_list_workspaces` | none | Array of workspace status objects |
| `klaudii_create_workspace` | `repo`, `branch`, `bead_id?` | Workspace name, path, tmux session |
| `klaudii_send_message` | `workspace`, `message`, `sender?` | Ack |
| `klaudii_get_status` | `workspace` | Status, git info, bead state, pending questions |
| `klaudii_read_beads` | `filter?` (status, priority) | Full Beads JSONL parsed as JSON array |
| `klaudii_create_bead` | `title`, `description`, `priority?`, `deps?`, `type?` | Created bead object |
| `klaudii_update_bead` | `id`, `status?`, `comment?`, `assignee?` | Updated bead object |

### REST API Additions

New endpoints on the Klaudii server to support the MCP tools:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/chat/:workspace/send` | POST | Send message to workspace Claude |
| `/api/chat/:workspace/status` | GET | Workspace chat status + pending questions |
| `/api/beads` | GET | Read all beads (JSONL parsed to JSON) |
| `/api/beads` | POST | Create a new bead |
| `/api/beads/:id` | PATCH | Update bead status/comment |
| `/api/beads/:id` | GET | Get single bead details |

These wrap existing WebSocket functionality (for chat) and `bd` CLI commands (for beads) behind REST endpoints.

## Shepherd Loop Detail

```mermaid
flowchart TD
    START([Boot]) --> READ[Read all Beads]
    READ --> CHECK{Any in-progress<br/>workspaces?}

    CHECK -->|Yes| HEALTH[Check worktree health]
    HEALTH --> RUNNING{Worker still<br/>running?}
    RUNNING -->|No| TRIAGE[Triage: check exit<br/>status + tests]
    RUNNING -->|Yes| STUCK{Stuck too<br/>long?}
    STUCK -->|Yes| KILL[Kill + mark blocked]
    STUCK -->|No| COMMENTS{Pending<br/>comments?}
    COMMENTS -->|Yes| ANSWER[Answer simple,<br/>escalate complex]
    COMMENTS -->|No| NEXT[Next workspace]
    ANSWER --> NEXT
    KILL --> NEXT
    TRIAGE --> NEXT

    CHECK -->|No| READY
    NEXT --> CHECK

    READY{Any ready<br/>Beads?} -->|Yes| AVAIL{Workspace<br/>available?}
    AVAIL -->|Yes| DISPATCH[Create workspace<br/>+ assign Bead]
    AVAIL -->|No| BLOCKED_CHECK
    READY -->|No| BLOCKED_CHECK

    BLOCKED_CHECK{Any blocked<br/>Beads?} -->|Yes| UNBLOCK[Evaluate:<br/>slice, remove deps,<br/>answer questions]
    BLOCKED_CHECK -->|No| EXIT
    UNBLOCK --> EXIT
    DISPATCH --> READY

    EXIT([Exit - see you in 5 min])
```

## Workspace Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Created: Shepherd creates<br/>worktree + tmux
    Created --> Running: Claude starts,<br/>claims Bead
    Running --> Running: Working on task
    Running --> Blocked: Worker posts<br/>question on Bead
    Blocked --> Running: Shepherd/Architect<br/>answers question
    Running --> Completed: Worker closes Bead,<br/>pushes code
    Running --> Failed: Tests fail,<br/>timeout, crash
    Blocked --> Failed: Timeout
    Failed --> Created: Shepherd resets<br/>worktree, retries
    Completed --> [*]: Worktree cleaned up
    Failed --> [*]: After max retries
```

## Clean Worktree Guarantee

Every worker session MUST start with a clean worktree:

```bash
# When creating a new workspace for a Bead:
git worktree add --detach <worktree-path> main
cd <worktree-path>
git checkout -B <branch-name> origin/main

# When reusing an existing workspace for a new Bead:
cd <worktree-path>
git reset --hard
git clean -fd
git fetch origin main
git checkout -B <branch-name> origin/main
```

This prevents stale Bead changes or uncommitted code from a previous session from confusing the next worker.

## Bead Authoring Standard (SCRUM_MASTER Rigor)

Every task Bead created by the Architect MUST contain:

### A. Goal (The "What")
One sentence summary of the deliverable.

### B. Specs (The "How")
Strict constraints: file paths, function signatures, behavior requirements.

### C. Verification (The "Proof")
Exact commands to run and expected output. Must be falsifiable.

### D. Safety (The "Brakes")
Explicit instructions on when to STOP and escalate.

**Example:**
```
Goal: Add REST endpoint POST /api/chat/:workspace/send that sends a message
to a workspace Claude session.

Specs:
- Add route in routes/v1.js
- Accept JSON body: { message: string, sender?: "user"|"architect"|"shepherd" }
- Use existing claudeChat.appendMessage() for active relays
- Use backendModule.sendMessage() for new conversations
- Return { ok: true } on success
- Persist sender field in chat history

Verification:
- Server starts without errors: node server.js
- curl -X POST http://localhost:9876/api/chat/test-workspace/send \
    -H 'Content-Type: application/json' \
    -d '{"message":"hello","sender":"architect"}'
  returns 200 with { ok: true }

Safety:
- Do NOT modify the WebSocket handler — only add REST route
- Do NOT change existing history format — only ADD sender field
- If claudeChat module needs changes, limit to additive changes only
```

## Implementation Phases

### Phase 0: Foundation (current)
- [x] Init Beads in klaudii repo
- [ ] REST API: POST /api/chat/:workspace/send
- [ ] REST API: GET /api/chat/:workspace/status
- [ ] REST API: Beads CRUD endpoints
- [ ] Message model: add `sender` field to chat history persistence
- [ ] Frontend: colored bubbles for architect/shepherd messages
- [ ] Klaudii MCP server (Node.js, wraps REST endpoints)
- [ ] Clean worktree guarantee on workspace creation

### Phase 1: Worker Loop
- [ ] Architect creates Beads and spins up Worker workspaces via MCP
- [ ] Workers execute Beads, update status via `bd`, leave comments
- [ ] Architect reviews results via MCP

### Phase 2: Shepherd
- [ ] Shepherd script that boots every 5 min (cron or Klaudii scheduler)
- [ ] Reads Beads, checks worktree health, dispatches work
- [ ] Files fix Beads, rolls back bad commits
- [ ] Answers simple questions, escalates design issues

### Phase 3: Full Autonomy
- [ ] Bootstrap-from-doc workflow
- [ ] Architect recovers state across sessions via memory
- [ ] Shepherd runs continuously
- [ ] System self-improves

## Lessons from Machinator

Patterns we adopt from the Machinator project:

1. **Lost Agent Assumption** — every Bead must be self-contained; assume the worker has zero prior context
2. **Trust But Verify** — never assume an action worked; always check
3. **Code Exists != Working** — verification must be *run*, not assumed
4. **Landing the Plane** — work isn't done until `git push` succeeds
5. **Coordination via State** — agents coordinate through Beads, not chat
6. **Ephemeral Agents** — 2-10 min tasks are more reliable than long-running ones
7. **Scrum Master as Skill** — any Claude may create/groom Beads as part of their work
8. **Merge Conflicts are Signals** — if two agents touch the same Bead, coordination failed
