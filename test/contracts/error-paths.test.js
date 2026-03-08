/**
 * Error path and edge case tests for API endpoints.
 *
 * Tests malformed requests, missing fields, invalid values,
 * and error response codes/shapes.
 */

const request = require("supertest");
const { createTestApp } = require("../helpers/server");

describe("error paths: sessions", () => {
  it("POST /sessions/start returns 400 when project is missing", async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .post("/api/sessions/start")
      .send({})
      .expect(400);
    expect(res.body.error).toContain("project");
  });

  it("POST /sessions/start returns 404 for unknown project", async () => {
    const { app } = createTestApp();
    await request(app)
      .post("/api/sessions/start")
      .send({ project: "nonexistent-project" })
      .expect(404);
  });

  it("POST /sessions/stop returns 400 when project is missing", async () => {
    const { app } = createTestApp();
    await request(app)
      .post("/api/sessions/stop")
      .send({})
      .expect(400);
  });

  it("POST /sessions/restart returns 400 when project is missing", async () => {
    const { app } = createTestApp();
    await request(app)
      .post("/api/sessions/restart")
      .send({})
      .expect(400);
  });

  it("POST /sessions/restart returns 404 for unknown project", async () => {
    const { app } = createTestApp();
    await request(app)
      .post("/api/sessions/restart")
      .send({ project: "nonexistent" })
      .expect(404);
  });
});

describe("error paths: projects", () => {
  it("POST /projects returns 400 when name is missing", async () => {
    const { app } = createTestApp();
    await request(app)
      .post("/api/projects")
      .send({ path: "/some/path" })
      .expect(400);
  });

  it("POST /projects returns 400 when path is missing", async () => {
    const { app } = createTestApp();
    await request(app)
      .post("/api/projects")
      .send({ name: "test" })
      .expect(400);
  });

  it("POST /projects/remove returns 400 when project is missing", async () => {
    const { app } = createTestApp();
    await request(app)
      .post("/api/projects/remove")
      .send({})
      .expect(400);
  });

  it("POST /projects/remove returns 404 for unknown project", async () => {
    const { app } = createTestApp();
    await request(app)
      .post("/api/projects/remove")
      .send({ project: "nonexistent" })
      .expect(404);
  });

  it("POST /projects/permission returns 400 when project is missing", async () => {
    const { app } = createTestApp();
    await request(app)
      .post("/api/projects/permission")
      .send({ mode: "yolo" })
      .expect(400);
  });

  it("POST /projects/permission returns 400 when mode is missing", async () => {
    const { app } = createTestApp();
    await request(app)
      .post("/api/projects/permission")
      .send({ project: "nova-frontend" })
      .expect(400);
  });
});

describe("error paths: history", () => {
  it("GET /history returns 400 when project query param is missing", async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .get("/api/history")
      .expect(400);
    expect(res.body.error).toContain("project");
  });

  it("GET /history returns 404 for unknown project", async () => {
    const { app } = createTestApp();
    await request(app)
      .get("/api/history?project=nonexistent")
      .expect(404);
  });
});

describe("error paths: processes", () => {
  it("POST /processes/kill returns 400 when pid is missing", async () => {
    const { app } = createTestApp();
    await request(app)
      .post("/api/processes/kill")
      .send({})
      .expect(400);
  });
});

describe("error paths: repos", () => {
  it("POST /repos/create returns 400 for invalid repo name", async () => {
    const { app } = createTestApp();
    await request(app)
      .post("/api/repos/create")
      .send({ name: "has spaces!" })
      .expect(400);
  });

  it("POST /repos/create returns 400 with path traversal attempt", async () => {
    const { app } = createTestApp();
    await request(app)
      .post("/api/repos/create")
      .send({ name: "../../../etc" })
      .expect(400);
  });

  it("POST /sessions/new returns 400 when repo is missing", async () => {
    const { app } = createTestApp();
    await request(app)
      .post("/api/sessions/new")
      .send({})
      .expect(400);
  });
});

describe("error paths: tasks", () => {
  it("GET /tasks/:id returns 400 for SQL injection attempt", async () => {
    const { app } = createTestApp();
    await request(app)
      .get("/api/tasks/'; DROP TABLE tasks;--")
      .expect(400);
  });

  it("POST /tasks returns 400 when title is missing", async () => {
    const { app } = createTestApp();
    await request(app)
      .post("/api/tasks")
      .send({ description: "no title" })
      .expect(400);
  });

  it("PATCH /tasks/:id returns 400 for invalid ID characters", async () => {
    const { app } = createTestApp();
    await request(app)
      .patch("/api/tasks/bad<>id")
      .send({ status: "closed" })
      .expect(400);
  });
});

describe("error paths: workspace state", () => {
  it("PATCH /workspace-state/:workspace returns 501 when workspaceState is not available", async () => {
    // Create app without workspaceState
    const { app } = createTestApp();
    await request(app)
      .patch("/api/workspace-state/test-ws")
      .send({ mode: "gemini" })
      .expect(501);
  });
});

describe("error paths: chat", () => {
  it("POST /chat/:workspace/send returns 501 when claudeChat is not available", async () => {
    const { app } = createTestApp();
    await request(app)
      .post("/api/chat/test-ws/send")
      .send({ message: "hello" })
      .expect(501);
  });

  it("POST /chat/:workspace/stop returns 501 when claudeChat is not available", async () => {
    const { app } = createTestApp();
    await request(app)
      .post("/api/chat/test-ws/stop")
      .send({})
      .expect(501);
  });

  it("GET /chat/:workspace/status returns 404 for unknown workspace", async () => {
    const { app } = createTestApp();
    await request(app)
      .get("/api/chat/nonexistent-workspace/status")
      .expect(404);
  });
});

describe("error paths: memory", () => {
  it("GET /memory/:agent returns 501 when memory is not available", async () => {
    const { app } = createTestApp();
    await request(app)
      .get("/api/memory/architect")
      .expect(501);
  });

  it("GET /memory/:agent returns 501 for invalid agent when memory unavailable", async () => {
    const { app } = createTestApp();
    // Without memory module, all /memory routes return 501 regardless of agent name
    await request(app)
      .get("/api/memory/hacker")
      .expect(501);
  });

  it("POST /memory/:agent returns 501 when memory is not available", async () => {
    const { app } = createTestApp();
    await request(app)
      .post("/api/memory/shepherd")
      .send({ content: "test" })
      .expect(501);
  });
});

describe("error paths: JSON body parsing", () => {
  it("POST with invalid JSON returns 400", async () => {
    const { app } = createTestApp();
    await request(app)
      .post("/api/projects")
      .set("Content-Type", "application/json")
      .send("not valid json{{{")
      .expect(400);
  });
});
