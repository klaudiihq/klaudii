const { createAuthenticatedAgent } = require("../helpers/relay");
const { assertArrayOf, assertShape, schemas } = require("../../../../test/schemas/v1");

describe("v1 relay contract: GET /api/servers", () => {
  it("returns 401 when not authenticated", async () => {
    const supertest = require("supertest");
    const { app } = require("../helpers/relay").createTestApp();
    await supertest(app).get("/api/servers").expect(401);
  });

  it("returns an array of Server objects matching the iOS contract", async () => {
    const supertest = require("supertest");
    const auth = createAuthenticatedAgent(supertest);
    const agent = await auth.authenticate();

    const res = await agent.get("/api/servers").expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    assertArrayOf(res.body, schemas.Server, "servers");
  });

  it("includes the v1 API version header", async () => {
    const supertest = require("supertest");
    const auth = createAuthenticatedAgent(supertest);
    const agent = await auth.authenticate();

    const res = await agent.get("/api/servers").expect(200);

    expect(res.headers["x-klaudii-api-version"]).toBe("1");
  });

  it("online is a boolean and platform is string or null", async () => {
    const supertest = require("supertest");
    const auth = createAuthenticatedAgent(supertest);
    const agent = await auth.authenticate();

    const res = await agent.get("/api/servers").expect(200);

    for (const server of res.body) {
      expect(typeof server.online).toBe("boolean");
      if (server.platform !== null) {
        expect(typeof server.platform).toBe("string");
      }
    }
  });
});

describe("v1 relay contract: DELETE /api/servers/:id", () => {
  it("returns 401 when not authenticated", async () => {
    const supertest = require("supertest");
    const { app } = require("../helpers/relay").createTestApp();
    await supertest(app).delete("/api/servers/srv-001").expect(401);
  });

  it("returns { ok: true } for valid server", async () => {
    const supertest = require("supertest");
    const auth = createAuthenticatedAgent(supertest);
    const agent = await auth.authenticate();

    const res = await agent.delete("/api/servers/srv-001").expect(200);
    expect(res.body.ok).toBe(true);
  });

  it("returns 404 for unknown server", async () => {
    const supertest = require("supertest");
    const auth = createAuthenticatedAgent(supertest);
    const agent = await auth.authenticate();

    await agent.delete("/api/servers/nonexistent").expect(404);
  });
});
