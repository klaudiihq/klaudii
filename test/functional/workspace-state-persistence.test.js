// Scenario 5: Workspace state persistence
// set mode -> "restart" (re-read from disk) -> verify mode persisted

const request = require("supertest");
const { createFunctionalApp, createWorkspaceState } = require("./helpers");

describe("workspace state persistence", () => {
  let app, deps, cleanup, tmpDir;

  beforeEach(() => {
    ({ app, deps, cleanup, tmpDir } = createFunctionalApp({
      initialProjects: [
        { name: "persist-test", path: "/tmp/persist-test", permissionMode: "yolo" },
      ],
    }));
  });

  afterEach(() => {
    cleanup();
  });

  it("mode persists to disk and survives state reload", async () => {
    // Set mode via API
    await request(app)
      .patch("/api/workspace-state/persist-test")
      .send({ mode: "gemini" })
      .expect(200);

    // Simulate server restart by reloading state from disk
    deps.workspaceState._reload();

    // Verify mode was persisted
    const state = deps.workspaceState.getWorkspace("persist-test");
    expect(state.mode).toBe("gemini");
  });

  it("draft text persists to disk", async () => {
    await request(app)
      .patch("/api/workspace-state/persist-test")
      .send({ draft: "half-typed message" })
      .expect(200);

    deps.workspaceState._reload();
    const state = deps.workspaceState.getWorkspace("persist-test");
    expect(state.draft).toBe("half-typed message");
  });

  it("clearing draft removes it from disk", async () => {
    // Set a draft
    await request(app)
      .patch("/api/workspace-state/persist-test")
      .send({ draft: "temporary" })
      .expect(200);

    // Clear it
    await request(app)
      .patch("/api/workspace-state/persist-test")
      .send({ draft: "" })
      .expect(200);

    deps.workspaceState._reload();
    const state = deps.workspaceState.getWorkspace("persist-test");
    expect(state.draft).toBe("");
  });

  it("session number persists per mode", async () => {
    // Set session number for claude-local mode
    await request(app)
      .patch("/api/workspace-state/persist-test")
      .send({ sessionNum: 3 })
      .expect(200);

    deps.workspaceState._reload();
    const state = deps.workspaceState.getWorkspace("persist-test");
    expect(state.sessionNum).toBe(3);
  });

  it("multiple workspaces are isolated on disk", async () => {
    deps.projects.addProject("persist-test-2", "/tmp/persist-test-2");

    await request(app)
      .patch("/api/workspace-state/persist-test")
      .send({ mode: "gemini" })
      .expect(200);

    await request(app)
      .patch("/api/workspace-state/persist-test-2")
      .send({ mode: "claude-remote" })
      .expect(200);

    deps.workspaceState._reload();
    expect(deps.workspaceState.getWorkspace("persist-test").mode).toBe("gemini");
    expect(deps.workspaceState.getWorkspace("persist-test-2").mode).toBe("claude-remote");
  });

  it("chat activity timestamp persists", () => {
    deps.workspaceState.touchChatActivity("persist-test");
    const ts = deps.workspaceState.getLastChatActivity("persist-test");
    expect(ts).toBeGreaterThan(0);

    deps.workspaceState._reload();
    const reloaded = deps.workspaceState.getLastChatActivity("persist-test");
    expect(reloaded).toBe(ts);
  });

  it("streaming state is ephemeral (not persisted)", () => {
    // First, trigger a save so the state file exists
    deps.workspaceState.touchChatActivity("persist-test");

    deps.workspaceState.setStreaming("persist-test", true);
    expect(deps.workspaceState.isStreaming("persist-test")).toBe(true);

    // Verify the design intent: streaming is not written to the state file.
    const fs = require("fs");
    const stateData = JSON.parse(fs.readFileSync(deps.workspaceState._stateFile, "utf-8"));
    expect(stateData["persist-test"]).toBeDefined();
    expect(stateData["persist-test"].streaming).toBeUndefined();
  });

  it("workspace type persists", () => {
    deps.workspaceState.setWorkspaceType("persist-test", "worker");
    deps.workspaceState._reload();
    expect(deps.workspaceState.getWorkspaceType("persist-test")).toBe("worker");
  });
});
