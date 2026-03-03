const request = require("supertest");
const { createTestApp } = require("../helpers/server");

describe("v1 contract: GET /api/usage", () => {
  it("returns an object with buckets and rateLimits arrays", async () => {
    const { app } = createTestApp();
    const res = await request(app).get("/api/usage").expect(200);

    expect(res.body).toHaveProperty("buckets");
    expect(res.body).toHaveProperty("rateLimits");
    expect(Array.isArray(res.body.buckets)).toBe(true);
    expect(Array.isArray(res.body.rateLimits)).toBe(true);
  });

  it("includes the v1 API version header", async () => {
    const { app } = createTestApp();
    const res = await request(app).get("/api/usage").expect(200);

    expect(res.headers["x-klaudii-api-version"]).toBe("1");
  });

  it("accepts hours query parameter", async () => {
    const { app } = createTestApp();
    const res = await request(app).get("/api/usage?hours=48").expect(200);

    expect(res.body).toHaveProperty("buckets");
    expect(res.body).toHaveProperty("rateLimits");
  });
});
