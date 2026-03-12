# Workspace Providers

Klaudii uses a pluggable workspace provider to create, remove, and manage isolated workspaces. The default provider uses git worktrees. You can replace it with any module that implements 7 methods.

## Quick Start

The active provider is set in `server.js` and injected into `routes/v1.js` and `lib/mcp.js` via dependency injection. To swap providers:

```js
// server.js
const { setProvider, registerProvider } = require("./lib/workspace-provider");
registerProvider("my-provider", require("./lib/providers/my-provider"));
setProvider("my-provider");
```

## Provider Interface

A workspace provider is a plain object with these methods:

### `create(repoDir, workspacePath, identifier)`

Create a new isolated workspace.

- `repoDir` — absolute path to the source/parent project (e.g., `/repos/klaudii`)
- `workspacePath` — absolute path where the workspace should be created (e.g., `/repos/klaudii--feat-x`)
- `identifier` — workspace-specific name (branch name in git, arbitrary string otherwise)

The git-worktree provider runs `git worktree add`. A directory-based provider might `cp -r` the source. A container provider might build an image.

### `remove(repoDir, workspacePath)`

Destroy a workspace and reclaim its resources.

- `repoDir` — absolute path to the source/parent project
- `workspacePath` — absolute path to the workspace being removed

The git-worktree provider runs `git worktree remove --force`.

### `list(repoDir)`

List all workspaces associated with a source project.

Returns an array of objects. The shape is provider-specific, but should include at minimum:
- `path` — absolute filesystem path
- `branch` or `identifier` — what this workspace represents

The git-worktree provider returns `[{ path, head, branch, bare?, detached? }]`.

### `clean(workspacePath, baseBranch?)`

Reset a workspace to a clean state, as if freshly created. Called before starting a new session in an existing workspace.

- `workspacePath` — absolute path to the workspace
- `baseBranch` — optional, the reference to reset to (defaults to `"main"` in git)

The git-worktree provider runs `git reset --hard && git clean -fd && git fetch origin && git checkout -B <branch> origin/<base>`. A directory provider might delete and re-copy.

Safety: the provider should refuse to clean the source/parent project itself.

### `isWorkspace(dirPath)`

Returns `true` if the given directory is a managed workspace (not the source/parent project).

- `dirPath` — absolute path to check

The git-worktree provider checks whether `.git` is a file (worktree) rather than a directory (main repo). A directory provider might check for a `.klaudii-workspace` marker file.

This is used to guard destructive operations — Klaudii will never clean or remove a path that `isWorkspace()` returns `false` for.

### `parseName(projectName)`

Extract the source project name and workspace identifier from a composite project name string.

- `projectName` — the string used to identify this workspace in Klaudii (e.g., `"klaudii--feat-x"`)

Returns `{ repo, identifier }`.

The git-worktree provider splits on `"--"` — `"klaudii--feat-x"` becomes `{ repo: "klaudii", identifier: "feat-x" }`. Your provider can use any delimiter or naming scheme, as long as `parseName` and `buildPath` are inverses.

### `buildPath(reposDir, repo, identifier)`

Construct the project name and filesystem path for a new workspace.

- `reposDir` — parent directory where workspaces live (e.g., `/repos`)
- `repo` — source project name
- `identifier` — workspace-specific name

Returns `{ projectName, workspacePath }`.

The git-worktree provider returns `{ projectName: "klaudii--feat-x", workspacePath: "/repos/klaudii--feat-x" }`.

## What the Provider is NOT Responsible For

These remain outside the provider, handled by Klaudii core:

- **tmux sessions** — Klaudii creates/kills tmux sessions in the workspace path
- **ttyd** — web terminal access is managed separately
- **project registration** — `projects.addProject()` / `removeProject()` are called by the route handlers
- **session tracking** — Claude/Gemini session detection happens after workspace creation
- **git status** — `git.getStatus()` is still called directly for status display (dirty files, unpushed commits). A non-git provider's workspaces will simply show no git status.
- **cloning** — `git.cloneRepo()` is called before the provider's `create()` if the source repo doesn't exist locally. Non-git providers that don't need cloning should ensure the source directory exists before `create()` is called.

## File Layout

```
lib/
  workspace-provider.js         # Factory: getProvider(), setProvider(), registerProvider()
  providers/
    git-worktree.js             # Default provider (delegates to lib/git.js)
```

## Consumers

The provider is injected as `workspace` (server.js) or destructured as `wsProvider` (routes/v1.js, mcp.js):

| File | Call Sites |
|------|-----------|
| `routes/v1.js` | POST /sessions/new, POST /sessions/start, POST /projects/remove, GET /repos/:name/worktrees |
| `lib/mcp.js` | klaudii_create_workspace tool |

`lib/shepherd.js` still uses `ctx.git` directly and has not been migrated yet.
