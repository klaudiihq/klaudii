const request = require("supertest");
const { createTestApp } = require("../helpers/server");
const { assertShape, assertArrayOf, schemas } = require("../schemas/v1");

describe("v1 contract: GET /api/sessions", () => {
  it("returns an array of Session objects matching the iOS contract", async () => {
    const { app } = createTestApp();
    const res = await request(app).get("/api/sessions").expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    assertArrayOf(res.body, schemas.Session, "sessions");
  });

  it("includes the v1 API version header", async () => {
    const { app } = createTestApp();
    const res = await request(app).get("/api/sessions").expect(200);

    expect(res.headers["x-klaudii-api-version"]).toBe("1");
  });

  it("each session has correct types for required fields", async () => {
    const { app } = createTestApp();
    const res = await request(app).get("/api/sessions").expect(200);

    for (const session of res.body) {
      expect(typeof session.project).toBe("string");
      expect(typeof session.projectPath).toBe("string");
      expect(typeof session.permissionMode).toBe("string");
      expect(typeof session.running).toBe("boolean");
      expect(typeof session.status).toBe("string");
      expect(typeof session.sessionCount).toBe("number");
    }
  });

  it("git field when present conforms to GitStatus schema", async () => {
    const { app } = createTestApp();
    const res = await request(app).get("/api/sessions").expect(200);

    const withGit = res.body.filter((s) => s.git !== null);
    expect(withGit.length).toBeGreaterThan(0);

    for (const session of withGit) {
      assertShape(session.git, schemas.GitStatus, "git");
    }
  });

  it("git files when present conform to GitFile schema", async () => {
    const { app } = createTestApp();
    const res = await request(app).get("/api/sessions").expect(200);

    const withFiles = res.body.filter((s) => s.git && s.git.files);
    expect(withFiles.length).toBeGreaterThan(0);

    for (const session of withFiles) {
      assertArrayOf(session.git.files, schemas.GitFile, "git.files");
    }
  });

  it("ttyd field when present conforms to TtydInfo schema", async () => {
    const { app } = createTestApp();
    const res = await request(app).get("/api/sessions").expect(200);

    const withTtyd = res.body.filter((s) => s.ttyd !== null);
    expect(withTtyd.length).toBeGreaterThan(0);

    for (const session of withTtyd) {
      assertShape(session.ttyd, schemas.TtydInfo, "ttyd");
    }
  });

  it("status is one of the expected values", async () => {
    const { app } = createTestApp();
    const res = await request(app).get("/api/sessions").expect(200);

    const validStatuses = ["running", "exited", "stopped"];
    for (const session of res.body) {
      expect(validStatuses).toContain(session.status);
    }
  });

  it("running boolean is consistent with status field", async () => {
    const { app } = createTestApp();
    const res = await request(app).get("/api/sessions").expect(200);

    for (const session of res.body) {
      expect(session.running).toBe(session.status === "running");
    }
  });
});
