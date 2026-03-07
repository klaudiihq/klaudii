// MCP SSE integration — exposes Klaudii tools via SSE transport on the Express server.
// Tools call internal functions directly instead of making HTTP round-trips.

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { SSEServerTransport } = require("@modelcontextprotocol/sdk/server/sse.js");
const { z } = require("zod");
const { execSync } = require("child_process");

function createMcpServer(deps) {
  const {
    projects, // { getProjects, getProject, addProject, removeProject, setPermissionMode }
    tmux,
    ttyd,
    git,
    github,
    sessionTracker,
    claudeChat,
    workspaceState,
    config,
  } = deps;

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
      const allProjects = projects.getProjects();
      const claudeSessions = tmux.getClaudeSessions();
      const ttydInstances = ttyd.getRunning();

      const sessions = allProjects.map((project) => {
        const tmuxName = tmux.sessionName(project.name);
        const tmuxSession = claudeSessions.find((s) => s.name === tmuxName);

        let status = "stopped";
        if (tmuxSession) {
          status = tmux.isClaudeAlive(tmuxName) ? "running" : "exited";
        }

        const gitStatus = git.getStatus(project.path);
        const wsState = workspaceState ? workspaceState.getWorkspace(project.name) : {};

        return {
          workspace: project.name,
          path: project.path,
          status,
          branch: gitStatus?.branch || null,
          permissionMode: project.permissionMode || "yolo",
          chatMode: wsState.mode || "claude-local",
          relayActive: claudeChat ? claudeChat.isActive(project.name) : false,
          lastActivity: workspaceState ? workspaceState.getLastChatActivity(project.name) : 0,
        };
      });

      return { content: [{ type: "text", text: JSON.stringify(sessions, null, 2) }] };
    }
  );

  // --- klaudii_create_workspace ---

  server.tool(
    "klaudii_create_workspace",
    "Create a new workspace (clone repo + create git worktree + start Claude session)",
    {
      repo: z.string().describe("Repository name (e.g. 'klaudii')"),
      branch: z.string().describe("Branch name for the worktree"),
      bead_id: z.string().optional().describe("Bead ID to assign to this workspace"),
    },
    async ({ repo, branch, bead_id }) => {
      if (!config.reposDir) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "reposDir not configured" }) }], isError: true };
      }

      const repoDir = require("path").join(config.reposDir, repo);
      const branchName = branch || `claude-${Date.now()}`;
      const worktreeDir = require("path").join(config.reposDir, `${repo}--${branchName}`);
      const projectName = `${repo}--${branchName}`;

      // Clone if needed
      if (!git.isGitRepo(repoDir)) {
        const repos = github.listRepos();
        const ghRepo = repos.find((r) => r.name === repo);
        if (!ghRepo) {
          return { content: [{ type: "text", text: JSON.stringify({ error: `repo "${repo}" not found on GitHub` }) }], isError: true };
        }
        git.cloneRepo(ghRepo.sshUrl, repoDir);
      }

      if (require("fs").existsSync(worktreeDir)) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `Worktree already exists: ${worktreeDir}` }) }], isError: true };
      }

      git.addWorktree(repoDir, worktreeDir, branchName);

      try { projects.addProject(projectName, worktreeDir); } catch {}

      const tmuxName = tmux.sessionName(projectName);
      if (tmux.sessionExists(tmuxName)) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `tmux session "${tmuxName}" already exists` }) }], isError: true };
      }

      tmux.createSession(tmuxName, worktreeDir, "remote-control --permission-mode bypassPermissions");

      const port = ttyd.allocatePort(config.ttydBasePort);
      try { ttyd.start(projectName, tmuxName, port); } catch {}

      sessionTracker.detectAndTrack(projectName, Date.now()).catch(() => {});
      sessionTracker.captureClaudeUrl(projectName, tmuxName).catch(() => {});

      // Assign bead if provided
      if (bead_id) {
        try {
          const cwd = config.reposDir || process.cwd();
          execSync(`bd update ${bead_id} --status in_progress --json`, { encoding: "utf-8", cwd });
          execSync(`bd comment ${bead_id} ${JSON.stringify(`Assigned to workspace ${projectName}`)}`, { encoding: "utf-8", cwd });
        } catch {}
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            workspace: projectName,
            worktree: worktreeDir,
            branch: branchName,
            tmuxSession: tmuxName,
            ttydPort: port,
            beadAssigned: bead_id || null,
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
      if (!claudeChat) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "claude-chat not available" }) }], isError: true };
      }

      const proj = projects.getProject(workspace);
      if (!proj) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `workspace "${workspace}" not found` }) }], isError: true };
      }

      const senderField = sender || "user";

      if (claudeChat.isActive(workspace)) {
        claudeChat.pushHistory(workspace, "user", message, { sender: senderField });
        claudeChat.appendMessage(workspace, message);
      } else {
        claudeChat.pushHistory(workspace, "user", message, { sender: senderField });
        await claudeChat.sendMessage(workspace, proj.path, message, config);
      }

      return { content: [{ type: "text", text: JSON.stringify({ ok: true, workspace }) }] };
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
      const proj = projects.getProject(workspace);
      if (!proj) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `workspace "${workspace}" not found` }) }], isError: true };
      }

      const wsState = workspaceState ? workspaceState.getWorkspace(workspace) : {};
      const pending = workspaceState ? workspaceState.getPendingPermission(workspace) : null;

      const result = {
        workspace,
        relayActive: claudeChat ? claudeChat.isActive(workspace) : false,
        streaming: workspaceState ? workspaceState.isStreaming(workspace) : false,
        chatMode: wsState.mode || "claude-local",
        lastActivity: workspaceState ? workspaceState.getLastChatActivity(workspace) : 0,
        pendingPermission: pending || null,
      };

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // --- klaudii_read_beads ---

  server.tool(
    "klaudii_read_beads",
    "Read all beads (task issues) with optional filtering by status or priority",
    {
      status: z.enum(["open", "in_progress", "blocked", "closed"]).optional().describe("Filter by status"),
      priority: z.number().min(0).max(4).optional().describe("Filter by priority (0=critical, 4=backlog)"),
    },
    async ({ status, priority }) => {
      try {
        const cwd = config.reposDir || process.cwd();
        const out = execSync("bd list --json", { encoding: "utf-8", cwd });
        let beads = JSON.parse(out);
        if (!Array.isArray(beads)) beads = [];
        if (status) beads = beads.filter((b) => b.status === status);
        if (priority !== undefined) beads = beads.filter((b) => b.priority === priority);
        return { content: [{ type: "text", text: JSON.stringify(beads, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `bd list failed: ${err.message}` }) }], isError: true };
      }
    }
  );

  // --- klaudii_create_bead ---

  server.tool(
    "klaudii_create_bead",
    "Create a new bead (task/issue) for tracking work",
    {
      title: z.string().describe("Bead title"),
      description: z.string().describe("Full description with Goal, Specs, Verification, Safety"),
      priority: z.number().min(0).max(4).optional().describe("Priority 0-4 (default: 2)"),
      type: z.enum(["task", "bug", "feature", "epic", "chore"]).optional().describe("Issue type (default: task)"),
      deps: z.string().optional().describe("Dependencies (e.g. 'klaudii-abc,klaudii-def')"),
    },
    async ({ title, description, priority, type, deps }) => {
      try {
        const cwd = config.reposDir || process.cwd();
        let cmd = `bd create ${JSON.stringify(title)}`;
        if (description) cmd += ` --description=${JSON.stringify(description)}`;
        if (priority !== undefined) cmd += ` -p ${Number(priority)}`;
        if (type) cmd += ` -t ${type}`;
        if (deps) cmd += ` --deps ${deps}`;
        cmd += " --json";
        const out = execSync(cmd, { encoding: "utf-8", cwd });
        return { content: [{ type: "text", text: out.trim() }] };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `bd create failed: ${err.message}` }) }], isError: true };
      }
    }
  );

  // --- klaudii_update_bead ---

  server.tool(
    "klaudii_update_bead",
    "Update an existing bead's status, assignee, or add a comment",
    {
      id: z.string().describe("Bead ID (e.g. 'klaudii-abc')"),
      status: z.enum(["open", "in_progress", "blocked", "closed"]).optional().describe("New status"),
      comment: z.string().optional().describe("Comment to add"),
      assignee: z.string().optional().describe("Assign to someone"),
    },
    async ({ id, status, comment, assignee }) => {
      if (!/^[a-zA-Z0-9-]+$/.test(id)) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "invalid bead ID" }) }], isError: true };
      }

      try {
        const cwd = config.reposDir || process.cwd();

        if (status || assignee !== undefined) {
          let cmd = `bd update ${id}`;
          if (status) cmd += ` --status ${status}`;
          if (assignee !== undefined) cmd += ` --assignee ${JSON.stringify(assignee)}`;
          cmd += " --json";
          execSync(cmd, { encoding: "utf-8", cwd });
        }

        if (comment) {
          execSync(`bd comment ${id} ${JSON.stringify(comment)}`, { encoding: "utf-8", cwd });
        }

        const out = execSync(`bd show ${id} --json`, { encoding: "utf-8", cwd });
        return { content: [{ type: "text", text: out.trim() }] };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `bd update failed: ${err.message}` }) }], isError: true };
      }
    }
  );

  // --- klaudii_complete_bead ---

  server.tool(
    "klaudii_complete_bead",
    "Run the completion pipeline for a bead: tests → verification → code review → close. Call this when work on a bead is done.",
    {
      bead_id: z.string().describe("Bead ID (e.g. 'klaudii-abc')"),
      workspace: z.string().describe("Workspace name where the work was done"),
    },
    async ({ bead_id, workspace }) => {
      if (!/^[a-zA-Z0-9-]+$/.test(bead_id)) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "invalid bead ID" }) }], isError: true };
      }

      const completion = require("./completion");
      const ctx = {
        claudeChat,
        tmux,
        projects,
        config,
        workspaceState,
      };

      try {
        const result = await completion.runPipeline(bead_id, workspace, ctx);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `Pipeline failed: ${err.message}` }) }], isError: true };
      }
    }
  );

  return server;
}

// Mount MCP SSE endpoints on an Express app.
// GET  /mcp — establishes the SSE stream
// POST /mcp — receives JSON-RPC messages from the client
function mountMcp(app, deps) {
  const transports = new Map(); // sessionId -> SSEServerTransport

  app.get("/mcp", async (req, res) => {
    console.log("[mcp] SSE connection established");
    const mcpServer = createMcpServer(deps);
    const transport = new SSEServerTransport("/mcp", res);
    transports.set(transport.sessionId, transport);

    res.on("close", () => {
      console.log(`[mcp] SSE connection closed session=${transport.sessionId}`);
      transports.delete(transport.sessionId);
    });

    await mcpServer.connect(transport);
  });

  app.post("/mcp", async (req, res) => {
    const sessionId = req.query.sessionId;
    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(400).json({ error: "Unknown session" });
      return;
    }
    await transport.handlePostMessage(req, res, req.body);
  });

  console.log("[mcp] SSE endpoint mounted at /mcp");
}

module.exports = { mountMcp };
