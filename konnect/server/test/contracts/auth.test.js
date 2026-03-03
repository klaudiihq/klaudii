const request = require("supertest");
const { createTestApp, createAuthenticatedAgent } = require("../helpers/relay");
const { assertShape, schemas } = require("../../../../test/schemas/v1");

describe("v1 relay contract: GET /auth/me", () => {
  it("returns 401 when not authenticated", async () => {
    const { app } = createTestApp();
    await request(app).get("/auth/me").expect(401);
  });

  it("returns AuthUser object when authenticated", async () => {
    const supertest = require("supertest");
    const auth = createAuthenticatedAgent(supertest);
    const agent = await auth.authenticate();

    const res = await agent.get("/auth/me").expect(200);

    assertShape(res.body, schemas.AuthUser, "auth/me");
  });

  it("includes the v1 API version header", async () => {
    const supertest = require("supertest");
    const auth = createAuthenticatedAgent(supertest);
    const agent = await auth.authenticate();

    const res = await agent.get("/auth/me").expect(200);

    expect(res.headers["x-klaudii-api-version"]).toBe("1");
  });

  it("AuthUser has correct field types", async () => {
    const supertest = require("supertest");
    const auth = createAuthenticatedAgent(supertest);
    const agent = await auth.authenticate();

    const res = await agent.get("/auth/me").expect(200);

    expect(typeof res.body.id).toBe("string");
    expect(typeof res.body.email).toBe("string");
    // name can be string or null
    if (res.body.name !== null) {
      expect(typeof res.body.name).toBe("string");
    }
  });
});

describe("v1 relay contract: POST /auth/token-exchange", () => {
  it("returns { ok: true } with valid token", async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .post("/auth/token-exchange")
      .send({ token: "valid-token" })
      .expect(200);

    expect(res.body.ok).toBe(true);
  });

  it("returns 401 with invalid token", async () => {
    const { app } = createTestApp();
    await request(app)
      .post("/auth/token-exchange")
      .send({ token: "bad-token" })
      .expect(401);
  });
});

describe("v1 relay contract: POST /auth/logout", () => {
  it("returns { ok: true }", async () => {
    const { app } = createTestApp();
    const res = await request(app).post("/auth/logout").expect(200);

    expect(res.body.ok).toBe(true);
  });
});
