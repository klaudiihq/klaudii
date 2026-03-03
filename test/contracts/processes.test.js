const request = require("supertest");
const { createTestApp } = require("../helpers/server");
const { assertArrayOf, schemas } = require("../schemas/v1");

describe("v1 contract: GET /api/processes", () => {
  it("returns an array of ProcessInfo objects matching the iOS contract", async () => {
    const { app } = createTestApp();
    const res = await request(app).get("/api/processes").expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    assertArrayOf(res.body, schemas.ProcessInfo, "processes");
  });

  it("includes the v1 API version header", async () => {
    const { app } = createTestApp();
    const res = await request(app).get("/api/processes").expect(200);

    expect(res.headers["x-klaudii-api-version"]).toBe("1");
  });

  it("pid is always an integer", async () => {
    const { app } = createTestApp();
    const res = await request(app).get("/api/processes").expect(200);

    for (const proc of res.body) {
      expect(Number.isInteger(proc.pid)).toBe(true);
    }
  });

  it("managed is always a boolean", async () => {
    const { app } = createTestApp();
    const res = await request(app).get("/api/processes").expect(200);

    for (const proc of res.body) {
      expect(typeof proc.managed).toBe("boolean");
    }
  });

  it("numeric fields are numbers when present", async () => {
    const { app } = createTestApp();
    const res = await request(app).get("/api/processes").expect(200);

    for (const proc of res.body) {
      if (proc.cpu !== null && proc.cpu !== undefined) {
        expect(typeof proc.cpu).toBe("number");
      }
      if (proc.memMB !== null && proc.memMB !== undefined) {
        expect(typeof proc.memMB).toBe("number");
      }
    }
  });
});

describe("v1 contract: POST /api/processes/kill", () => {
  it("returns { ok } on success", async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .post("/api/processes/kill")
      .send({ pid: 42187 })
      .expect(200);

    expect(res.body).toHaveProperty("ok");
    expect(typeof res.body.ok).toBe("boolean");
  });

  it("returns 400 when pid is missing", async () => {
    const { app } = createTestApp();
    await request(app)
      .post("/api/processes/kill")
      .send({})
      .expect(400);
  });
});
