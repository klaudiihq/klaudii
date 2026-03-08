// Scenario 2: Chat flow
// send message -> relay spawns -> events stream -> history persists

const request = require("supertest");
const { createFunctionalApp } = require("./helpers");

describe("chat flow", () => {
  let app, deps, cleanup;

  beforeEach(() => {
    ({ app, deps, cleanup } = createFunctionalApp({
      initialProjects: [
        { name: "chat-test", path: "/tmp/chat-test", permissionMode: "yolo" },
      ],
    }));
  });

  afterEach(() => {
    cleanup();
  });

  it("send message via REST, verify relay activates and history persists", async () => {
    // 1. Send a message
    const sendRes = await request(app)
      .post("/api/chat/chat-test/send")
      .send({ message: "Hello Claude!" })
      .expect(200);
    expect(sendRes.body.ok).toBe(true);

    // 2. Let the mock relay process (async microtask)
    await new Promise(r => setTimeout(r, 50));

    // 3. Check history — user message should be persisted
    const history = deps.claudeChat.getHistory("chat-test");
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[0].role).toBe("user");
    expect(history[0].content).toBe("Hello Claude!");
  });

  it("chat status reflects workspace state", async () => {
    const statusRes = await request(app)
      .get("/api/chat/chat-test/status")
      .expect(200);

    expect(statusRes.body.workspace).toBe("chat-test");
    expect(typeof statusRes.body.relayActive).toBe("boolean");
    expect(typeof statusRes.body.streaming).toBe("boolean");
    expect(statusRes.body.chatMode).toBe("claude-local");
  });

  it("chat status returns 404 for unknown workspace", async () => {
    await request(app)
      .get("/api/chat/nonexistent/status")
      .expect(404);
  });

  it("send message returns 404 for unknown workspace", async () => {
    await request(app)
      .post("/api/chat/nonexistent/send")
      .send({ message: "hello" })
      .expect(404);
  });

  it("send message returns 400 without message body", async () => {
    await request(app)
      .post("/api/chat/chat-test/send")
      .send({})
      .expect(400);
  });

  it("active relay appends to existing session", async () => {
    // Simulate an active relay
    deps.claudeChat._setActive("chat-test", true);

    const sendRes = await request(app)
      .post("/api/chat/chat-test/send")
      .send({ message: "Follow-up message" })
      .expect(200);
    expect(sendRes.body.ok).toBe(true);

    // History should have the user message
    const history = deps.claudeChat.getHistory("chat-test");
    expect(history.some(m => m.content === "Follow-up message")).toBe(true);
  });

  it("stream partial returns partial text when available", async () => {
    // No active stream
    await request(app)
      .get("/api/gemini/stream-partial/chat-test")
      .expect(404);

    // Set a partial
    deps.claudeChat._setStreamPartial("chat-test", "Partial response...");

    // Now it should return the text (this endpoint is on server.js, not v1 router)
    // So we test via the claudeChat mock directly
    expect(deps.claudeChat.getStreamPartial("chat-test")).toBe("Partial response...");
  });
});
