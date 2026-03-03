const request = require("supertest");
const { createTestApp } = require("../helpers/server");
const { assertShape, schemas } = require("../schemas/v1");

describe("v1 contract: POST /api/sessions/start", () => {
  it("returns SessionStartResponse on success", async () => {
    const { app } = createTestApp();
    // orbit-docs is a stopped session, so it can be started
    const res = await request(app)
      .post("/api/sessions/start")
      .send({ project: "orbit-docs" })
      .expect(200);

    assertShape(res.body, schemas.SessionStartResponse, "start");
  });

  it("returns 400 when project is missing", async () => {
    const { app } = createTestApp();
    await request(app)
      .post("/api/sessions/start")
      .send({})
      .expect(400);
  });

  it("returns 404 for unknown project", async () => {
    const { app } = createTestApp();
    await request(app)
      .post("/api/sessions/start")
      .send({ project: "nonexistent" })
      .expect(404);
  });

  it("returns 409 when session is already running", async () => {
    const { app } = createTestApp();
    // nova-frontend is a running session in our mocks
    await request(app)
      .post("/api/sessions/start")
      .send({ project: "nova-frontend" })
      .expect(409);
  });
});

describe("v1 contract: POST /api/sessions/stop", () => {
  it("returns { ok } on success", async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .post("/api/sessions/stop")
      .send({ project: "nova-frontend" })
      .expect(200);

    assertShape(res.body, schemas.OkResponse, "stop");
    expect(res.body.ok).toBe(true);
  });

  it("returns 400 when project is missing", async () => {
    const { app } = createTestApp();
    await request(app)
      .post("/api/sessions/stop")
      .send({})
      .expect(400);
  });
});

describe("v1 contract: POST /api/sessions/restart", () => {
  it("returns SessionStartResponse on success", async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .post("/api/sessions/restart")
      .send({ project: "nova-frontend" })
      .expect(200);

    assertShape(res.body, schemas.SessionStartResponse, "restart");
  });

  it("returns 400 when project is missing", async () => {
    const { app } = createTestApp();
    await request(app)
      .post("/api/sessions/restart")
      .send({})
      .expect(400);
  });

  it("returns 404 for unknown project", async () => {
    const { app } = createTestApp();
    await request(app)
      .post("/api/sessions/restart")
      .send({ project: "nonexistent" })
      .expect(404);
  });
});
