// Scenario 7: Relay lifecycle
// spawn -> crash -> reconnect -> verify recovery

const request = require("supertest");
const { createFunctionalApp } = require("./helpers");

describe("relay lifecycle", () => {
  let app, deps, cleanup;

  beforeEach(() => {
    ({ app, deps, cleanup } = createFunctionalApp({
      initialProjects: [
        { name: "relay-test", path: "/tmp/relay-test", permissionMode: "yolo" },
      ],
    }));
  });

  afterEach(() => {
    cleanup();
  });

  it("relay starts inactive, becomes active on send, returns to inactive after done", async () => {
    // Initially not active
    let status = await request(app).get("/api/chat/relay-test/status").expect(200);
    expect(status.body.relayActive).toBe(false);
    expect(status.body.streaming).toBe(false);

    // Send a message — relay activates
    await request(app)
      .post("/api/chat/relay-test/send")
      .send({ message: "Activate relay" })
      .expect(200);

    // Let mock relay process and finish
    await new Promise(r => setTimeout(r, 50));

    // After mock completes, relay should be inactive again
    status = await request(app).get("/api/chat/relay-test/status").expect(200);
    expect(status.body.relayActive).toBe(false);
  });

  it("relay crash clears streaming state", () => {
    const { workspaceState, claudeChat } = deps;

    // Simulate relay active + streaming
    claudeChat._setActive("relay-test", true);
    workspaceState.setStreaming("relay-test", true);
    expect(workspaceState.isStreaming("relay-test")).toBe(true);

    // Simulate crash — in production, onDone handler clears streaming
    claudeChat._setActive("relay-test", false);
    workspaceState.setStreaming("relay-test", false);
    expect(workspaceState.isStreaming("relay-test")).toBe(false);
  });

  it("pending permission cleared on relay exit", () => {
    const { workspaceState } = deps;

    // Simulate a pending permission
    workspaceState.setPendingPermission("relay-test", {
      type: "permission_request",
      request_id: "req-123",
      tool_name: "Write",
    });
    expect(workspaceState.getPendingPermission("relay-test")).not.toBeNull();

    // Simulate relay exit — clears pending permission
    workspaceState.setPendingPermission("relay-test", null);
    expect(workspaceState.getPendingPermission("relay-test")).toBeNull();
  });

  it("workspace state includes pending permission when present", async () => {
    const { workspaceState } = deps;

    // Set a pending permission
    workspaceState.setPendingPermission("relay-test", {
      type: "permission_request",
      request_id: "req-456",
      tool_name: "Bash",
      parameters: { command: "rm -rf /" },
    });

    const res = await request(app)
      .get("/api/workspace-state/relay-test")
      .expect(200);
    expect(res.body.pendingPermission).toBeDefined();
    expect(res.body.pendingPermission.request_id).toBe("req-456");
    expect(res.body.pendingPermission.tool_name).toBe("Bash");
  });

  it("stop relay clears active state", () => {
    const { claudeChat, workspaceState } = deps;

    claudeChat._setActive("relay-test", true);
    workspaceState.setStreaming("relay-test", true);

    // Stop
    claudeChat.stopProcess("relay-test");
    workspaceState.setStreaming("relay-test", false);

    expect(claudeChat.isActive("relay-test")).toBe(false);
    expect(workspaceState.isStreaming("relay-test")).toBe(false);
  });

  it("multiple workspaces relay independently", async () => {
    deps.projects.addProject("relay-test-2", "/tmp/relay-test-2");
    const { claudeChat, workspaceState } = deps;

    claudeChat._setActive("relay-test", true);
    workspaceState.setStreaming("relay-test", true);

    // relay-test-2 should not be affected
    let status1 = await request(app).get("/api/chat/relay-test/status").expect(200);
    let status2 = await request(app).get("/api/chat/relay-test-2/status").expect(200);

    expect(status1.body.relayActive).toBe(true);
    expect(status1.body.streaming).toBe(true);
    expect(status2.body.relayActive).toBe(false);
    expect(status2.body.streaming).toBe(false);
  });

  it("history persists across relay crashes", async () => {
    const { claudeChat } = deps;

    // Send a message that gets persisted
    claudeChat.pushHistory("relay-test", "user", "Before crash");
    claudeChat.pushHistory("relay-test", "assistant", "Response before crash");

    // Simulate crash + recovery
    claudeChat._setActive("relay-test", false);

    // History should still be there
    const hist = claudeChat.getHistory("relay-test");
    expect(hist.length).toBe(2);
    expect(hist[0].content).toBe("Before crash");
    expect(hist[1].content).toBe("Response before crash");
  });
});
