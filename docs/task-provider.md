# Task Provider

Klaudii uses a pluggable task store for managing work items (bugs, features, tasks). The default implementation uses SQLite via `better-sqlite3`. When `better-sqlite3` is not installed, task features degrade gracefully — the server boots normally and task endpoints return 501.

## Quick Start

The task module is required in `server.js` and injected into `routes/v1.js` via dependency injection. No registration step is needed — the module self-initializes on first use.

```js
// server.js
const tasks = require("./lib/tasks");

app.use("/api", createV1Router({
  // ...other deps...
  tasks,
}));
```

## Provider Interface

### CRUD

#### `create({ title, description, priority, difficulty, type, project })`

Create a new task. Returns the created task object.

- `title` (string, required) — task title
- `description` (string) — detailed description
- `priority` (int, default 2) — 0=critical, 1=high, 2=medium, 3=low, 4=backlog
- `difficulty` (string, default "hard") — "hard" or "easy" (used for model selection)
- `type` (string, default "task") — "bug", "feature", "task", "epic", "chore"
- `project` (string) — project scope

#### `get(id)`

Fetch a task by ID, including its comments. Returns the task object or `null`.

#### `list(filters)`

List tasks with optional filters. Returns an array sorted by priority then creation date.

- `filters.status` — "open", "in_progress", "blocked", "closed"
- `filters.project` — filter by project name
- `filters.priority` — filter by priority level
- `filters.assignee` — filter by assignee
- `filters.type` — filter by task type

#### `update(id, fields)`

Update task fields. Validates state transitions via `lib/lifecycle.js`. Returns the updated task or `null` if not found.

Allowed fields: `title`, `description`, `status`, `priority`, `difficulty`, `type`, `assignee`, `project`, `close_reason`.

#### `close(id, reason)`

Shorthand for `update(id, { status: "closed", close_reason: reason })`.

#### `remove(id)`

Delete a task and its comments/dependencies.

### Comments

#### `addComment(taskId, { author, body })`

Add a comment to a task. Returns the created comment.

#### `getComments(taskId)`

Get all comments for a task, ordered by creation date. Returns an array.

### Dependencies

#### `addDep(taskId, dependsOnId)`

Declare that `taskId` is blocked by `dependsOnId`.

#### `removeDep(taskId, dependsOnId)`

Remove a dependency.

#### `getDeps(taskId)`

Get all tasks that block the given task. Returns an array of task objects.

### Queries

#### `ready(filters)`

Find tasks that are open, unassigned, and have no unmet dependencies. Accepts `{ project }` filter. Returns an array.

### Import/Export

#### `importFromJSONL(filePath)`

Import tasks from a JSONL file. Returns the count of imported tasks.

#### `exportToJSONL(filePath)`

Export all tasks to a JSONL file. Returns the count of exported tasks.

### Lifecycle

#### `closeDb()`

Close the database connection. Called during graceful shutdown.

#### `getDb()`

Returns the active database connection, or `null` if unavailable. Used internally and by route guards to check availability.

#### `initDb(dbPath)`

Initialize with a custom database path (for tests). Closes any existing connection first.

## Graceful Degradation

When `better-sqlite3` is not installed:

- `require("./lib/tasks")` succeeds — the native module is lazy-loaded on first DB access
- `getDb()` returns `null` and logs a single warning
- Read functions (`get`, `list`, `getComments`, `getDeps`, `ready`) return `null` or `[]`
- Write functions (`create`, `update`, `remove`, etc.) throw `"Task database unavailable"`
- Route handlers check `tasksAvailable` at router creation and return 501 before calling any task function

## State Machine

Task status transitions are validated by `lib/lifecycle.js`:

```
open → in_progress, blocked, closed
in_progress → open, blocked, closed
blocked → open, in_progress, closed
closed → open (reopen)
```

Invalid transitions log a warning but are not blocked.

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/tasks` | List all tasks |
| GET | `/api/tasks/:id` | Get task with comments |
| GET | `/api/tasks/:id/sessions` | Get worker sessions for a task |
| POST | `/api/tasks` | Create a task |
| PATCH | `/api/tasks/:id` | Update task / add comment |
| POST | `/api/tasks/:id/complete` | Trigger completion pipeline |

All task endpoints return `501 { error: "tasks not available" }` when SQLite is unavailable.

## Database

- **Location**: `~/.klaudii/data/klaudii.db`
- **Engine**: SQLite with WAL mode
- **Tables**: `tasks`, `task_comments`, `task_deps`

## File Layout

```
lib/
  tasks.js              # SQLite task store (lazy-loads better-sqlite3)
  lifecycle.js          # State machine for task status transitions
```

## Consumers

| File | Usage |
|------|-------|
| `server.js` | Requires module, injects into router, closes DB on shutdown |
| `routes/v1.js` | 6 task endpoints (guarded with `tasksAvailable` check) |
| `test/functional/shepherd-sim.test.js` | Uses `initDb()` for in-memory test DB |
| `test/helpers/server.js` | Mock tasks object for contract tests |
