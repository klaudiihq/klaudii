# Klaudii MCP Server

MCP server that exposes Klaudii workspace and task management as native tool calls for Claude Code CLI instances.

## SSE Transport (Recommended)

The MCP server runs as part of the Klaudii Express server on port 9876. No separate setup is needed — just start the Klaudii server normally:

```bash
npm install
npm start
```

### Claude Code MCP Configuration

Add to your Claude Code MCP config (`~/.claude/mcp.json` or project `.claude/mcp.json`):

```json
{
  "mcpServers": {
    "klaudii": {
      "type": "sse",
      "url": "http://localhost:9876/mcp"
    }
  }
}
```

## Stdio Transport (Fallback)

The standalone stdio server in `mcp/klaudii-mcp-server.js` is still available as a fallback. It proxies through the REST API instead of calling internal functions directly.

```bash
cd mcp
npm install
```

```json
{
  "mcpServers": {
    "klaudii": {
      "command": "node",
      "args": ["/path/to/klaudii/mcp/klaudii-mcp-server.js"]
    }
  }
}
```

### Environment Variables (stdio only)

| Variable | Default | Description |
|----------|---------|-------------|
| `KLAUDII_URL` | `http://localhost:9876` | Base URL of the Klaudii server |

## Available Tools

| Tool | Description |
|------|-------------|
| `klaudii_list_workspaces` | List all workspaces with status and git info |
| `klaudii_create_workspace` | Create a new workspace (clone + worktree + start) |
| `klaudii_send_message` | Send a chat message to a workspace Claude session |
| `klaudii_get_status` | Get workspace status including chat state |
| `klaudii_read_tasks` | Read tasks with optional status/priority filters |
| `klaudii_create_task` | Create a new task (task/issue) |
| `klaudii_update_task` | Update task status, assignee, or add comments |

## Requirements

- Klaudii server must be running on the configured URL
- Node.js 18+ (for native `fetch`)
