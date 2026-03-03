const request = require("supertest");
const { createTestApp } = require("../helpers/server");
const { assertArrayOf, schemas } = require("../schemas/v1");

describe("v1 contract: GET /api/history", () => {
  it("returns an array of HistoryEntry objects matching the iOS contract", async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .get("/api/history?project=nova-frontend")
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    assertArrayOf(res.body, schemas.HistoryEntry, "history");
  });

  it("includes the v1 API version header", async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .get("/api/history?project=nova-frontend")
      .expect(200);

    expect(res.headers["x-klaudii-api-version"]).toBe("1");
  });

  it("each entry has required string and number fields", async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .get("/api/history?project=nova-frontend")
      .expect(200);

    for (const entry of res.body) {
      expect(typeof entry.sessionId).toBe("string");
      expect(typeof entry.timestamp).toBe("number");
      expect(typeof entry.display).toBe("string");
    }
  });

  it("returns 400 when project param is missing", async () => {
    const { app } = createTestApp();
    await request(app).get("/api/history").expect(400);
  });

  it("returns 404 for unknown project", async () => {
    const { app } = createTestApp();
    await request(app)
      .get("/api/history?project=nonexistent")
      .expect(404);
  });
});
