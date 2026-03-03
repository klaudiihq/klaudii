const request = require("supertest");
const { createTestApp } = require("../helpers/server");
const { assertShape, schemas } = require("../schemas/v1");

describe("v1 contract: GET /api/health", () => {
  it("returns Health object matching the contract", async () => {
    const { app } = createTestApp();
    const res = await request(app).get("/api/health").expect(200);

    assertShape(res.body, schemas.Health, "health");
  });

  it("includes the v1 API version header", async () => {
    const { app } = createTestApp();
    const res = await request(app).get("/api/health").expect(200);

    expect(res.headers["x-klaudii-api-version"]).toBe("1");
  });

  it("ok is always true when server is reachable", async () => {
    const { app } = createTestApp();
    const res = await request(app).get("/api/health").expect(200);

    expect(res.body.ok).toBe(true);
  });

  it("tmux and ttyd are booleans", async () => {
    const { app } = createTestApp();
    const res = await request(app).get("/api/health").expect(200);

    expect(typeof res.body.tmux).toBe("boolean");
    expect(typeof res.body.ttyd).toBe("boolean");
  });
});
