const { createTestApp, createAuthenticatedAgent } = require("../helpers/relay");
const { assertShape, schemas } = require("../../../../test/schemas/v1");

describe("v1 relay contract: POST /api/pairing/create", () => {
  it("returns 401 when not authenticated", async () => {
    const supertest = require("supertest");
    const { app } = createTestApp();
    await supertest(app).post("/api/pairing/create").expect(401);
  });

  it("returns PairingCreateResponse when authenticated", async () => {
    const supertest = require("supertest");
    const auth = createAuthenticatedAgent(supertest);
    const agent = await auth.authenticate();

    const res = await agent.post("/api/pairing/create").expect(200);

    assertShape(res.body, schemas.PairingCreateResponse, "pairing/create");
    expect(typeof res.body.code).toBe("string");
    expect(typeof res.body.expiresIn).toBe("number");
  });

  it("includes the v1 API version header", async () => {
    const supertest = require("supertest");
    const auth = createAuthenticatedAgent(supertest);
    const agent = await auth.authenticate();

    const res = await agent.post("/api/pairing/create").expect(200);

    expect(res.headers["x-klaudii-api-version"]).toBe("1");
  });
});

describe("v1 relay contract: POST /api/pairing/redeem", () => {
  it("returns PairingRedeemResponse with valid code", async () => {
    const supertest = require("supertest");
    const { app } = createTestApp();

    const res = await supertest(app)
      .post("/api/pairing/redeem")
      .send({ code: "TESTCODE", name: "My Mac", publicKey: "ed25519-key" })
      .expect(200);

    assertShape(res.body, schemas.PairingRedeemResponse, "pairing/redeem");
    expect(typeof res.body.serverId).toBe("string");
    expect(typeof res.body.relayUrl).toBe("string");
  });

  it("returns 400 when required fields are missing", async () => {
    const supertest = require("supertest");
    const { app } = createTestApp();

    await supertest(app)
      .post("/api/pairing/redeem")
      .send({ code: "TESTCODE" })
      .expect(400);
  });

  it("returns 404 for invalid code", async () => {
    const supertest = require("supertest");
    const { app } = createTestApp();

    await supertest(app)
      .post("/api/pairing/redeem")
      .send({ code: "BADCODE", name: "My Mac", publicKey: "key" })
      .expect(404);
  });
});
