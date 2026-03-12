# Workspace Providers

Klaudii uses a pluggable workspace provider to create, remove, and manage isolated workspaces. The default provider uses git worktrees. You can replace it with any module that implements the provider interface.

## Quick Start

Providers are factory functions. The active provider is initialized in `server.js` and injected into `routes/v1.js` and `lib/mcp.js` via dependency injection.

```js
// server.js
const { registerProvider, initProvider } = require("./lib/workspace-provider");
registerProvider("my-provider", require("./lib/providers/my-provider"));
initProvider("my-provider", { git, github, config });
```

A provider factory receives `{ git, github, config }` and returns a provider object.

## Provider Interface

### Capabilities & Sources

#### `capabilities()`

Declares what the provider supports. The UI adapts based on these flags.

Returns `{ projects: bool, branches: bool }`.

- `projects: true` — workspaces are grouped under projects (repos). Shows project switcher and repo selection in the create flow.
- `projects: false` — single-project mode. No project switcher, no repo selection.
- `branches: true` — workspace creation takes a branch/variant name.
- `branches: false` — no branch step in the create flow.

#### `getSources()`

Returns what's available to create workspaces from.

Returns `[{ name, description?, cloned?, isPrivate?, owner?, ... }]`.

The git-worktree provider returns GitHub repos annotated with clone status. A single-directory provider would return `[]`.

#### `getStatus(workspacePath)`

Returns workspace edit state / metadata.

- `workspacePath` — absolute path to the workspace

Returns `{ branch?, dirtyFiles?, unpushed?, files?, remoteUrl? }` or `null`.

The git-worktree provider wraps `git.getStatus()` + `git.getRemoteUrl()`. A non-git provider might return `null`.

#### `provision({ reposDir, repo, owner, branch })`

Create a new workspace end-to-end, including cloning the source if needed.

- `reposDir` — parent directory where workspaces live
- `repo` — source project name
- `owner` — optional, used to disambiguate repos (e.g., GitHub org)
- `branch` — optional, branch/variant name

Returns `{ projectName, workspacePath, branch? }`.

The git-worktree provider clones from GitHub if needed, creates a worktree, and verifies clean state. A directory provider might just `mkdir`.

### Workspace Lifecycle

#### `create(repoDir, workspacePath, identifier)`

Create a new isolated workspace.

- `repoDir` — absolute path to the source/parent project
- `workspacePath` — absolute path where the workspace should be created
- `identifier` — workspace-specific name (branch name in git, arbitrary string otherwise)

#### `remove(repoDir, workspacePath)`

Destroy a workspace and reclaim its resources.

#### `list(repoDir)`

List all workspaces associated with a source project. Returns an array of objects with at minimum `path` and `branch` or `identifier`.

#### `clean(workspacePath, baseBranch?)`

Reset a workspace to a clean state, as if freshly created.

#### `isWorkspace(dirPath)`

Returns `true` if the given directory is a managed workspace (not the source/parent project). Used to guard destructive operations.

### Naming

#### `parseName(projectName)`

Extract the source project name and workspace identifier from a composite project name string.

Returns `{ repo, identifier }`.

#### `buildPath(reposDir, repo, identifier)`

Construct the project name and filesystem path for a new workspace.

Returns `{ projectName, workspacePath }`.

## What the Provider is NOT Responsible For

- **tmux sessions** — Klaudii creates/kills tmux sessions in the workspace path
- **ttyd** — web terminal access is managed separately
- **project registration** — `projects.addProject()` / `removeProject()` are called by the route handlers
- **session tracking** — Claude/Gemini session detection happens after workspace creation

## API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /api/workspace/capabilities` | Returns provider name and capabilities |
| `GET /api/workspace/sources` | Returns available sources from provider |
| `GET /api/github/repos` | Backward-compat alias for sources |

Session responses include both `git` (backward compat) and `workspace` fields with status data, plus a `group` field with the project group name from `parseName()`.

## File Layout

```
lib/
  workspace-provider.js         # Registry: getProvider(), initProvider(), registerProvider()
  providers/
    git-worktree.js             # Default provider factory (delegates to lib/git.js)
```

## Consumers

| File | Call Sites |
|------|-----------|
| `routes/v1.js` | POST /sessions/new, POST /sessions/start, POST /projects/remove, GET /repos/:name/worktrees, GET /workspace/capabilities, GET /workspace/sources |
| `lib/mcp.js` | klaudii_create_workspace tool |
| `public/app.js` | Fetches capabilities on load, adapts modal and cards |
