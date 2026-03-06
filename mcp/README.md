# Klaudii MCP Server

MCP server that wraps the Klaudii REST API, allowing Claude Code CLI instances to manage workspaces and beads via native tool calls.

## Setup

```bash
cd mcp
npm install
```

## Claude Code MCP Configuration

Add to your Claude Code MCP config (`~/.claude/mcp.json` or project `.claude/mcp.json`):

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

## Environment Variables

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
| `klaudii_read_beads` | Read beads with optional status/priority filters |
| `klaudii_create_bead` | Create a new bead (task/issue) |
| `klaudii_update_bead` | Update bead status, assignee, or add comments |

## Requirements

- Klaudii server must be running on the configured URL
- Node.js 18+ (for native `fetch`)
