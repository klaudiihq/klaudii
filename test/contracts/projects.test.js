const request = require("supertest");
const { createTestApp } = require("../helpers/server");
const { assertShape, schemas } = require("../schemas/v1");

describe("v1 contract: GET /api/projects", () => {
  it("returns an array of project objects", async () => {
    const { app } = createTestApp();
    const res = await request(app).get("/api/projects").expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);

    for (const project of res.body) {
      expect(typeof project.name).toBe("string");
      expect(typeof project.path).toBe("string");
    }
  });

  it("includes the v1 API version header", async () => {
    const { app } = createTestApp();
    const res = await request(app).get("/api/projects").expect(200);

    expect(res.headers["x-klaudii-api-version"]).toBe("1");
  });
});

describe("v1 contract: POST /api/projects", () => {
  it("returns the updated project list", async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .post("/api/projects")
      .send({ name: "new-project", path: "/Users/demo/repos/new-project" })
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
  });

  it("returns 400 when name or path is missing", async () => {
    const { app } = createTestApp();
    await request(app).post("/api/projects").send({ name: "test" }).expect(400);
    await request(app).post("/api/projects").send({ path: "/test" }).expect(400);
    await request(app).post("/api/projects").send({}).expect(400);
  });
});

describe("v1 contract: POST /api/projects/permission", () => {
  it("returns { ok, mode } matching PermissionResponse schema", async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .post("/api/projects/permission")
      .send({ project: "nova-frontend", mode: "strict" })
      .expect(200);

    assertShape(res.body, schemas.PermissionResponse, "permission");
    expect(res.body.ok).toBe(true);
    expect(res.body.mode).toBe("strict");
  });

  it("returns 400 when project or mode is missing", async () => {
    const { app } = createTestApp();
    await request(app)
      .post("/api/projects/permission")
      .send({ project: "test" })
      .expect(400);
    await request(app)
      .post("/api/projects/permission")
      .send({ mode: "yolo" })
      .expect(400);
  });
});

describe("v1 contract: POST /api/projects/remove", () => {
  it("returns { ok } on success", async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .post("/api/projects/remove")
      .send({ project: "orbit-docs" })  // stopped session, no dirty files
      .expect(200);

    assertShape(res.body, schemas.OkResponse, "remove");
    expect(res.body.ok).toBe(true);
  });

  it("returns 400 when project is missing", async () => {
    const { app } = createTestApp();
    await request(app)
      .post("/api/projects/remove")
      .send({})
      .expect(400);
  });

  it("returns 404 for unknown project", async () => {
    const { app } = createTestApp();
    await request(app)
      .post("/api/projects/remove")
      .send({ project: "nonexistent" })
      .expect(404);
  });
});
