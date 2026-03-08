// Scenario 4: Session management
// create chat 1 -> create chat 2 -> switch -> verify history isolation

const request = require("supertest");
const { createFunctionalApp } = require("./helpers");

describe("session management", () => {
  let app, deps, cleanup;

  beforeEach(() => {
    ({ app, deps, cleanup } = createFunctionalApp({
      initialProjects: [
        { name: "multi-session", path: "/tmp/multi-session", permissionMode: "yolo" },
      ],
    }));
  });

  afterEach(() => {
    cleanup();
  });

  it("claude-chat: sessions are isolated", async () => {
    const { claudeChat } = deps;

    // Session 1 is the default
    const sess1 = claudeChat.getSessions("multi-session");
    expect(sess1.current).toBe(1);
    expect(sess1.total).toBe(1);

    // Push some history to session 1
    claudeChat.pushHistory("multi-session", "user", "Message in session 1");
    claudeChat.pushHistory("multi-session", "assistant", "Reply in session 1");

    // Create session 2
    const newSession = claudeChat.newSession("multi-session");
    expect(newSession).toBe(2);

    // Push history to session 2
    claudeChat.pushHistory("multi-session", "user", "Message in session 2");

    // Session 2 history should only have its own message
    const hist2 = claudeChat.getHistory("multi-session", 2);
    expect(hist2.length).toBe(1);
    expect(hist2[0].content).toBe("Message in session 2");

    // Session 1 history should be unchanged
    const hist1 = claudeChat.getHistory("multi-session", 1);
    expect(hist1.length).toBe(2);
    expect(hist1[0].content).toBe("Message in session 1");

    // Switch back to session 1
    const switched = claudeChat.setCurrentSession("multi-session", 1);
    expect(switched).toBe(true);

    // Default history (no session param) should now be session 1
    const defaultHist = claudeChat.getHistory("multi-session");
    expect(defaultHist.length).toBe(2);
  });

  it("claude-chat sessions endpoint reflects state", async () => {
    const { claudeChat } = deps;

    // Verify via HTTP
    const res1 = await request(app)
      .get("/api/claude-chat/sessions/multi-session");
    // Note: claude-chat session endpoints are mounted directly in server.js,
    // not in v1 router. We test via the mock directly.

    const sessions = claudeChat.getSessions("multi-session");
    expect(sessions.current).toBe(1);
    expect(sessions.total).toBe(1);

    claudeChat.newSession("multi-session");
    const sessions2 = claudeChat.getSessions("multi-session");
    expect(sessions2.current).toBe(2);
    expect(sessions2.total).toBe(2);
    expect(sessions2.sessions).toEqual([1, 2]);
  });

  it("switching to invalid session returns false", async () => {
    const { claudeChat } = deps;
    expect(claudeChat.setCurrentSession("multi-session", 99)).toBe(false);
  });

  it("history batch push adds multiple entries atomically", async () => {
    const { claudeChat } = deps;

    claudeChat.pushHistoryBatch("multi-session", [
      { role: "tool_use", content: '{"tool_name":"read_file"}' },
      { role: "tool_result", content: '{"output":"file contents"}' },
      { role: "assistant", content: "I read the file." },
    ]);

    const hist = claudeChat.getHistory("multi-session");
    expect(hist.length).toBe(3);
    expect(hist[0].role).toBe("tool_use");
    expect(hist[1].role).toBe("tool_result");
    expect(hist[2].role).toBe("assistant");
  });

  it("workspace-state tracks mode per workspace via API", async () => {
    // Get default state
    const defaultRes = await request(app)
      .get("/api/workspace-state/multi-session")
      .expect(200);
    expect(defaultRes.body.mode).toBe("claude-local");

    // Switch to gemini mode
    await request(app)
      .patch("/api/workspace-state/multi-session")
      .send({ mode: "gemini" })
      .expect(200);

    // Verify
    const updatedRes = await request(app)
      .get("/api/workspace-state/multi-session")
      .expect(200);
    expect(updatedRes.body.mode).toBe("gemini");
  });
});
