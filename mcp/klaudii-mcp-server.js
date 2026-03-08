#!/usr/bin/env node
// Klaudii MCP Server — wraps the Klaudii REST API for Claude Code tool calls.
// Transport: stdio (standard MCP transport)
// Base URL: KLAUDII_URL env var or http://localhost:9876

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");

const BASE_URL = (process.env.KLAUDII_URL || "http://localhost:9876").replace(/\/+$/, "");

async function api(path, options = {}) {
  const url = `${BASE_URL}/api${path}`;
  const fetchOpts = { headers: { "Content-Type": "application/json" }, ...options };
  if (fetchOpts.body && typeof fetchOpts.body === "object") {
    fetchOpts.body = JSON.stringify(fetchOpts.body);
  }
  const res = await fetch(url, fetchOpts);
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return body;
}

const server = new McpServer({
  name: "klaudii",
  version: "1.0.0",
});

// --- klaudii_list_workspaces ---

server.tool(
  "klaudii_list_workspaces",
  "List all Klaudii workspaces with their status, git info, and chat state",
  {},
  async () => {
    const sessions = await api("/sessions");
    const simplified = sessions.map((s) => ({
      workspace: s.project,
      path: s.projectPath,
      status: s.status,
      branch: s.git?.branch || null,
      permissionMode: s.permissionMode,
      chatMode: s.chatMode,
      relayActive: s.relayActive,
      lastActivity: s.lastActivity,
    }));
    return { content: [{ type: "text", text: JSON.stringify(simplified, null, 2) }] };
  }
);

// --- klaudii_create_workspace ---

server.tool(
  "klaudii_create_workspace",
  "Create a new workspace (clone repo + create git worktree + start Claude session)",
  {
    repo: z.string().describe("Repository name (e.g. 'klaudii')"),
    branch: z.string().describe("Branch name for the worktree"),
    task_id: z.string().optional().describe("Task ID to assign to this workspace"),
  },
  async ({ repo, branch, task_id }) => {
    const result = await api("/sessions/new", {
      method: "POST",
      body: { repo, branch },
    });

    // If a task_id was provided, claim it and add a comment noting the workspace
    if (task_id) {
      try {
        await api(`/tasks/${encodeURIComponent(task_id)}`, {
          method: "PATCH",
          body: { status: "in_progress", comment: `Assigned to workspace ${result.project}` },
        });
      } catch {
        // Best-effort — workspace was still created
      }
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          workspace: result.project,
          worktree: result.worktree,
          branch: result.branch,
          tmuxSession: result.tmuxSession,
          ttydPort: result.ttydPort,
          taskAssigned: task_id || null,
        }, null, 2),
      }],
    };
  }
);

// --- klaudii_send_message ---

server.tool(
  "klaudii_send_message",
  "Send a chat message to a workspace's Claude session",
  {
    workspace: z.string().describe("Workspace name (e.g. 'klaudii--feat-branch')"),
    message: z.string().describe("Message text to send"),
    sender: z.enum(["user", "architect", "shepherd"]).optional().describe("Message sender role (default: user)"),
  },
  async ({ workspace, message, sender }) => {
    const result = await api(`/chat/${encodeURIComponent(workspace)}/send`, {
      method: "POST",
      body: { message, sender: sender || "user" },
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// --- klaudii_get_status ---

server.tool(
  "klaudii_get_status",
  "Get detailed status of a workspace including chat state and pending permissions",
  {
    workspace: z.string().describe("Workspace name"),
  },
  async ({ workspace }) => {
    const status = await api(`/chat/${encodeURIComponent(workspace)}/status`);
    return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
  }
);

// --- klaudii_read_tasks ---

server.tool(
  "klaudii_read_tasks",
  "Read all tasks (task issues) with optional filtering by status or priority",
  {
    status: z.enum(["open", "in_progress", "blocked", "closed"]).optional().describe("Filter by status"),
    priority: z.number().min(0).max(4).optional().describe("Filter by priority (0=critical, 4=backlog)"),
  },
  async ({ status, priority }) => {
    const tasks = await api("/tasks");
    let filtered = Array.isArray(tasks) ? tasks : [];
    if (status) filtered = filtered.filter((b) => b.status === status);
    if (priority !== undefined) filtered = filtered.filter((b) => b.priority === priority);
    return { content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }] };
  }
);

// --- klaudii_create_task ---

server.tool(
  "klaudii_create_task",
  "Create a new task (task/issue) for tracking work",
  {
    title: z.string().describe("Task title"),
    description: z.string().describe("Full description with Goal, Specs, Verification, Safety"),
    priority: z.number().min(0).max(4).optional().describe("Priority 0-4 (default: 2)"),
    type: z.enum(["task", "bug", "feature", "epic", "chore"]).optional().describe("Issue type (default: task)"),
    deps: z.string().optional().describe("Dependencies (e.g. 'klaudii-abc,klaudii-def')"),
  },
  async ({ title, description, priority, type, deps }) => {
    const body = { title, description };
    if (priority !== undefined) body.priority = priority;
    if (type) body.type = type;
    if (deps) body.deps = deps;
    const result = await api("/tasks", { method: "POST", body });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// --- klaudii_update_task ---

server.tool(
  "klaudii_update_task",
  "Update an existing task's status, assignee, or add a comment",
  {
    id: z.string().describe("Task ID (e.g. 'klaudii-abc')"),
    status: z.enum(["open", "in_progress", "blocked", "closed"]).optional().describe("New status"),
    comment: z.string().optional().describe("Comment to add"),
    assignee: z.string().optional().describe("Assign to someone"),
  },
  async ({ id, status, comment, assignee }) => {
    const body = {};
    if (status) body.status = status;
    if (comment) body.comment = comment;
    if (assignee) body.assignee = assignee;
    const result = await api(`/tasks/${encodeURIComponent(id)}`, { method: "PATCH", body });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// --- Start server ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Klaudii MCP server error:", err);
  process.exit(1);
});
