# Memory Provider

Klaudii uses a pluggable memory store for persisting knowledge across agent sessions (Architect, Shepherd). The default implementation uses SQLite via `better-sqlite3`. When `better-sqlite3` is not installed, memory features degrade gracefully — the server boots normally and memory endpoints return 501.

## Quick Start

The memory module is required in `server.js` and injected into `routes/v1.js` via dependency injection.

```js
// server.js
const memory = require("./lib/memory");

app.use("/api", createV1Router({
  // ...other deps...
  memory,
}));
```

## Provider Interface

### Storage

#### `store(agent, { content, category, workspace, session_id })`

Store a new memory entry. Returns the created memory object.

- `agent` (string, required) — agent identifier ("architect", "shepherd")
- `content` (string, required) — memory content
- `category` (string) — optional categorization
- `workspace` (string) — optional workspace scope
- `session_id` (string) — optional session identifier

#### `list(agent, { limit, workspace })`

Get recent memories for an agent, ordered by most recent first. Returns an array.

- `agent` (string, required) — agent identifier
- `limit` (int, default 50, max 500) — maximum entries to return
- `workspace` (string) — filter by workspace (also includes unscoped memories)

#### `search(agent, query, { limit })`

Full-text search (LIKE-based) across memory content for an agent. Returns an array.

- `agent` (string, required) — agent identifier
- `query` (string, required) — search term
- `limit` (int, default 50, max 500) — maximum entries to return

#### `remove(agent, id)`

Delete a specific memory entry. Returns `true` if deleted, `false` if not found.

### Metadata

#### `getMeta(key)`

Get a metadata value by key. Returns the value string or `null`.

#### `setMeta(key, value)`

Set a metadata key-value pair (upsert).

### Lifecycle

#### `close()`

Close the database connection. Called during graceful shutdown.

## Graceful Degradation

When `better-sqlite3` is not installed:

- `require("./lib/memory")` succeeds — the native module is lazy-loaded inside `getDb()`
- `getDb()` returns `null` and logs the error once
- Read functions (`list`, `search`, `getMeta`) return `[]` or `null`
- Write functions (`store`, `remove`) throw `"Memory database unavailable"`
- `setMeta()` silently no-ops
- Route handlers check `if (!memory)` and return 501

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/memory/:agent` | List memories for an agent |
| POST | `/api/memory/:agent` | Store a new memory |
| DELETE | `/api/memory/:agent/:id` | Remove a specific memory |

Valid agent names: `architect`, `shepherd`.

All memory endpoints return `501 { error: "memory not available" }` when SQLite is unavailable.

## Database

- **Location**: `~/.klaudii/data/memory.sqlite`
- **Engine**: SQLite with WAL mode
- **Tables**: `memories`, `memory_metadata`
- **Indexes**: `idx_memories_agent`, `idx_memories_agent_workspace`

## File Layout

```
lib/
  memory.js             # SQLite memory store (lazy-loads better-sqlite3)
```

## Consumers

| File | Usage |
|------|-------|
| `server.js` | Requires module, injects into router, closes DB on shutdown |
| `routes/v1.js` | 3 memory endpoints (guarded with `if (!memory)` check) |
| `test/helpers/server.js` | Not currently mocked (memory is optional in test deps) |
