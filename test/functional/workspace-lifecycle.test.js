// Scenario 1: Workspace lifecycle
// create workspace -> verify state -> start session -> stop -> remove

const request = require("supertest");
const { createFunctionalApp } = require("./helpers");

describe("workspace lifecycle", () => {
  let app, deps, cleanup;

  beforeEach(() => {
    ({ app, deps, cleanup } = createFunctionalApp());
  });

  afterEach(() => {
    cleanup();
  });

  it("full lifecycle: add project -> list -> start -> verify running -> stop -> remove", async () => {
    // 1. Add a project
    const addRes = await request(app)
      .post("/api/projects")
      .send({ name: "lifecycle-test", path: "/tmp/lifecycle-test" })
      .expect(200);
    expect(Array.isArray(addRes.body)).toBe(true);
    expect(addRes.body.some(p => p.name === "lifecycle-test")).toBe(true);

    // 2. Verify it appears in sessions list
    const sessionsRes = await request(app).get("/api/sessions").expect(200);
    const session = sessionsRes.body.find(s => s.project === "lifecycle-test");
    expect(session).toBeDefined();
    expect(session.running).toBe(false);
    expect(session.status).toBe("stopped");

    // 3. Start a session
    const startRes = await request(app)
      .post("/api/sessions/start")
      .send({ project: "lifecycle-test" })
      .expect(200);
    expect(startRes.body.ok).toBe(true);
    expect(startRes.body.tmuxSession).toBe("klaudii-lifecycle-test");

    // 4. Verify it's now running
    const runningRes = await request(app).get("/api/sessions").expect(200);
    const runningSession = runningRes.body.find(s => s.project === "lifecycle-test");
    expect(runningSession.running).toBe(true);
    expect(runningSession.status).toBe("running");

    // 5. Starting again should fail (already running)
    await request(app)
      .post("/api/sessions/start")
      .send({ project: "lifecycle-test" })
      .expect(409);

    // 6. Stop the session
    const stopRes = await request(app)
      .post("/api/sessions/stop")
      .send({ project: "lifecycle-test" })
      .expect(200);
    expect(stopRes.body.ok).toBe(true);

    // 7. Verify it's stopped
    const stoppedRes = await request(app).get("/api/sessions").expect(200);
    const stoppedSession = stoppedRes.body.find(s => s.project === "lifecycle-test");
    expect(stoppedSession.running).toBe(false);

    // 8. Remove the project
    const removeRes = await request(app)
      .post("/api/projects/remove")
      .send({ project: "lifecycle-test" })
      .expect(200);
    expect(removeRes.body.ok).toBe(true);

    // 9. Verify it's gone
    const finalRes = await request(app).get("/api/sessions").expect(200);
    expect(finalRes.body.find(s => s.project === "lifecycle-test")).toBeUndefined();
  });

  it("cannot remove a running workspace", async () => {
    await request(app)
      .post("/api/projects")
      .send({ name: "busy-ws", path: "/tmp/busy-ws" });

    await request(app)
      .post("/api/sessions/start")
      .send({ project: "busy-ws" });

    await request(app)
      .post("/api/projects/remove")
      .send({ project: "busy-ws" })
      .expect(409);
  });

  it("cannot start a session for unknown project", async () => {
    await request(app)
      .post("/api/sessions/start")
      .send({ project: "nonexistent" })
      .expect(404);
  });

  it("permission mode persists across session listing", async () => {
    await request(app)
      .post("/api/projects")
      .send({ name: "perm-test", path: "/tmp/perm-test" });

    // Default mode is yolo
    let sessions = await request(app).get("/api/sessions").expect(200);
    expect(sessions.body.find(s => s.project === "perm-test").permissionMode).toBe("yolo");

    // Change to strict
    await request(app)
      .post("/api/projects/permission")
      .send({ project: "perm-test", mode: "strict" })
      .expect(200);

    // Verify it stuck
    sessions = await request(app).get("/api/sessions").expect(200);
    expect(sessions.body.find(s => s.project === "perm-test").permissionMode).toBe("strict");
  });

  it("restart session: stop + start with --continue", async () => {
    await request(app)
      .post("/api/projects")
      .send({ name: "restart-test", path: "/tmp/restart-test" });

    await request(app)
      .post("/api/sessions/start")
      .send({ project: "restart-test" })
      .expect(200);

    // Restart
    const res = await request(app)
      .post("/api/sessions/restart")
      .send({ project: "restart-test" })
      .expect(200);
    expect(res.body.ok).toBe(true);

    // Should still be running after restart
    const sessions = await request(app).get("/api/sessions").expect(200);
    expect(sessions.body.find(s => s.project === "restart-test").running).toBe(true);
  });
});
