// Scenario 6: Settings CRUD
// save -> load -> verify persistence

const request = require("supertest");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { createFunctionalApp } = require("./helpers");

describe("settings CRUD", () => {
  let app, deps, cleanup, tmpDir;
  let origSettingsDir;

  beforeEach(() => {
    ({ app, deps, cleanup, tmpDir } = createFunctionalApp());
    // The settings routes in v1.js use a hardcoded SETTINGS_DIR based on os.homedir().
    // We can't easily redirect that, so we test via the API and verify behavior.
    // The real SETTINGS_DIR is ~/Library/Application Support/com.klaudii.server/
    origSettingsDir = path.join(os.homedir(), "Library", "Application Support", "com.klaudii.server");
  });

  afterEach(() => {
    cleanup();
  });

  it("GET /settings returns defaults when no settings file exists", async () => {
    const res = await request(app).get("/api/settings").expect(200);
    expect(res.body.workerVisibility).toBeDefined();
    expect(res.body.theme).toBeDefined();
  });

  it("PATCH /settings updates and returns new settings", async () => {
    const res = await request(app)
      .patch("/api/settings")
      .send({ theme: "light" })
      .expect(200);
    expect(res.body.theme).toBe("light");

    // Verify it persists
    const verify = await request(app).get("/api/settings").expect(200);
    expect(verify.body.theme).toBe("light");
  });

  it("PATCH /settings only allows known fields", async () => {
    const before = await request(app).get("/api/settings").expect(200);

    await request(app)
      .patch("/api/settings")
      .send({ unknownField: "hacked", theme: "auto" })
      .expect(200);

    const after = await request(app).get("/api/settings").expect(200);
    expect(after.body.unknownField).toBeUndefined();
    expect(after.body.theme).toBe("auto");
  });

  it("settings round-trip: set all -> get -> verify", async () => {
    await request(app)
      .patch("/api/settings")
      .send({ workerVisibility: "show", theme: "dark" })
      .expect(200);

    const res = await request(app).get("/api/settings").expect(200);
    expect(res.body.workerVisibility).toBe("show");
    expect(res.body.theme).toBe("dark");
  });

  it("settings survive multiple patches", async () => {
    await request(app)
      .patch("/api/settings")
      .send({ theme: "light" })
      .expect(200);

    await request(app)
      .patch("/api/settings")
      .send({ workerVisibility: "auto-clean" })
      .expect(200);

    const res = await request(app).get("/api/settings").expect(200);
    expect(res.body.theme).toBe("light");
    expect(res.body.workerVisibility).toBe("auto-clean");
  });

  it("workerVisibility accepts all valid values", async () => {
    for (const value of ["hide", "show", "auto-clean"]) {
      const res = await request(app)
        .patch("/api/settings")
        .send({ workerVisibility: value })
        .expect(200);
      expect(res.body.workerVisibility).toBe(value);
    }
  });

  it("theme accepts all valid values", async () => {
    for (const value of ["dark", "light", "auto"]) {
      const res = await request(app)
        .patch("/api/settings")
        .send({ theme: value })
        .expect(200);
      expect(res.body.theme).toBe(value);
    }
  });
});
