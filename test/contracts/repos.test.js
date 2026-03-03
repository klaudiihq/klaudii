const request = require("supertest");
const { createTestApp } = require("../helpers/server");
const { assertArrayOf, assertShape, schemas } = require("../schemas/v1");

describe("v1 contract: GET /api/github/repos", () => {
  it("returns an array of GitHubRepo objects matching the iOS contract", async () => {
    const { app } = createTestApp();
    const res = await request(app).get("/api/github/repos").expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    assertArrayOf(res.body, schemas.GitHubRepo, "github/repos");
  });

  it("includes the v1 API version header", async () => {
    const { app } = createTestApp();
    const res = await request(app).get("/api/github/repos").expect(200);

    expect(res.headers["x-klaudii-api-version"]).toBe("1");
  });

  it("each repo has name, owner, sshUrl as strings and cloned as boolean", async () => {
    const { app } = createTestApp();
    const res = await request(app).get("/api/github/repos").expect(200);

    for (const repo of res.body) {
      expect(typeof repo.name).toBe("string");
      expect(typeof repo.owner).toBe("string");
      expect(typeof repo.sshUrl).toBe("string");
      expect(typeof repo.cloned).toBe("boolean");
    }
  });
});

describe("v1 contract: GET /api/repos", () => {
  it("returns an array of repo objects", async () => {
    const { app } = createTestApp();
    const res = await request(app).get("/api/repos").expect(200);

    expect(Array.isArray(res.body)).toBe(true);
  });

  it("includes the v1 API version header", async () => {
    const { app } = createTestApp();
    const res = await request(app).get("/api/repos").expect(200);

    expect(res.headers["x-klaudii-api-version"]).toBe("1");
  });
});

describe("v1 contract: POST /api/repos/create", () => {
  it("returns RepoCreateResponse on success", async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .post("/api/repos/create")
      .send({ name: "test-repo" })
      .expect(200);

    assertShape(res.body, schemas.RepoCreateResponse, "repos/create");
  });

  it("returns 400 when name is missing", async () => {
    const { app } = createTestApp();
    await request(app)
      .post("/api/repos/create")
      .send({})
      .expect(400);
  });

  it("returns 400 for invalid repo names", async () => {
    const { app } = createTestApp();
    await request(app)
      .post("/api/repos/create")
      .send({ name: "invalid name with spaces" })
      .expect(400);
  });
});

describe("v1 contract: GET /api/repos/:name/worktrees", () => {
  it("returns an array", async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .get("/api/repos/nova-frontend/worktrees")
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
  });
});
