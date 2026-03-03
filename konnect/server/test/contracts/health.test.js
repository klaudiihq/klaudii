const request = require("supertest");
const { createTestApp } = require("../helpers/relay");
const { assertShape, schemas } = require("../../../../test/schemas/v1");

describe("v1 relay contract: GET /api/relay/health", () => {
  it("returns RelayHealth object matching the contract", async () => {
    const { app } = createTestApp();
    const res = await request(app).get("/api/relay/health").expect(200);

    assertShape(res.body, schemas.RelayHealth, "relay/health");
  });

  it("includes the v1 API version header", async () => {
    const { app } = createTestApp();
    const res = await request(app).get("/api/relay/health").expect(200);

    expect(res.headers["x-klaudii-api-version"]).toBe("1");
  });

  it("ok is always true and onlineServers is a number", async () => {
    const { app } = createTestApp();
    const res = await request(app).get("/api/relay/health").expect(200);

    expect(res.body.ok).toBe(true);
    expect(typeof res.body.onlineServers).toBe("number");
  });
});
