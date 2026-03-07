/**
 * Unit tests for lib/mcp.js
 *
 * Tests the MCP module exports and POST /mcp routing behavior.
 *
 * NOTE: GET /mcp opens an SSE (Server-Sent Events) connection that stays
 * open indefinitely. Supertest cannot handle streaming responses, so we
 * only test the POST routing and module structure.
 */

const request = require("supertest");
const express = require("express");

// Minimal mock deps matching what createMcpServer expects
function createMockDeps() {
  return {
    projects: {
      getProjects: () => [
        { name: "test-proj", path: "/tmp/test-proj", permissionMode: "yolo" },
      ],
      getProject: (name) =>
        name === "test-proj"
          ? { name: "test-proj", path: "/tmp/test-proj", permissionMode: "yolo" }
          : null,
      addProject: () => {},
    },
    tmux: {
      getClaudeSessions: () => [],
      sessionName: (name) => `klaudii-${name}`,
      sessionExists: () => false,
      isClaudeAlive: () => false,
      createSession: () => {},
    },
    ttyd: {
      getRunning: () => [],
      allocatePort: () => 9900,
      start: () => {},
    },
    git: {
      getStatus: () => ({ branch: "main", dirtyFiles: 0 }),
      isGitRepo: () => true,
      cloneRepo: () => {},
      addWorktree: () => {},
    },
    github: {
      listRepos: () => [],
    },
    sessionTracker: {
      detectAndTrack: async () => {},
      captureClaudeUrl: async () => {},
    },
    claudeChat: null,
    workspaceState: {
      getWorkspace: () => ({ mode: "claude-local" }),
      getLastChatActivity: () => 0,
    },
    config: {
      reposDir: "/tmp/repos",
      ttydBasePort: 9900,
    },
  };
}

describe("MCP module", () => {
  let mountMcp;

  beforeEach(() => {
    const modPath = require.resolve("../../lib/mcp");
    delete require.cache[modPath];
    ({ mountMcp } = require("../../lib/mcp"));
  });

  describe("mountMcp", () => {
    it("exports mountMcp as a function", () => {
      expect(typeof mountMcp).toBe("function");
    });

    it("can be called without error", () => {
      const app = express();
      app.use(express.json());
      const deps = createMockDeps();
      expect(() => mountMcp(app, deps)).not.toThrow();
    });

    it("POST /mcp returns 400 for missing sessionId", async () => {
      const app = express();
      app.use(express.json());
      mountMcp(app, createMockDeps());

      const res = await request(app)
        .post("/mcp")
        .send({ jsonrpc: "2.0", method: "test", id: 1 });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Unknown session");
    });

    it("POST /mcp returns 400 for unknown sessionId", async () => {
      const app = express();
      app.use(express.json());
      mountMcp(app, createMockDeps());

      const res = await request(app)
        .post("/mcp?sessionId=nonexistent")
        .send({ jsonrpc: "2.0", method: "test", id: 1 });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Unknown session");
    });

    it("POST /mcp returns 400 for empty sessionId", async () => {
      const app = express();
      app.use(express.json());
      mountMcp(app, createMockDeps());

      const res = await request(app)
        .post("/mcp?sessionId=")
        .send({});
      expect(res.status).toBe(400);
    });

    it("POST /mcp handles JSON body gracefully", async () => {
      const app = express();
      app.use(express.json());
      mountMcp(app, createMockDeps());

      const res = await request(app)
        .post("/mcp?sessionId=abc123")
        .send({ jsonrpc: "2.0", method: "tools/list", id: 1 });
      // Unknown session → 400
      expect(res.status).toBe(400);
    });
  });

  describe("module exports", () => {
    it("exports only mountMcp", () => {
      const mcp = require("../../lib/mcp");
      expect(Object.keys(mcp)).toEqual(["mountMcp"]);
    });

    it("mountMcp is the sole export", () => {
      const mcp = require("../../lib/mcp");
      expect(typeof mcp.mountMcp).toBe("function");
      expect(Object.keys(mcp)).toHaveLength(1);
    });
  });

  describe("dependency validation", () => {
    it("does not throw with null claudeChat", () => {
      const app = express();
      app.use(express.json());
      const deps = createMockDeps();
      deps.claudeChat = null;
      expect(() => mountMcp(app, deps)).not.toThrow();
    });

    it("does not throw with null workspaceState", () => {
      const app = express();
      app.use(express.json());
      const deps = createMockDeps();
      deps.workspaceState = null;
      expect(() => mountMcp(app, deps)).not.toThrow();
    });

    it("does not throw when deps have minimal shape", () => {
      const app = express();
      app.use(express.json());
      const deps = createMockDeps();
      expect(() => mountMcp(app, deps)).not.toThrow();
    });
  });
});
