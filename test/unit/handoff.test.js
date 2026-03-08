/**
 * Tests for the context handoff system — generateBriefing, and the
 * persistence-invariant patterns that make auto-handoff work.
 */

const fs = require("fs");
const path = require("path");

const claudeChat = require("../../lib/claude-chat");

const LIB = path.join(__dirname, "..", "..", "lib");
const ROOT = path.join(__dirname, "..", "..");
const claudeChatSrc = fs.readFileSync(path.join(LIB, "claude-chat.js"), "utf-8");
const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf-8");

// =========================================================================
// generateBriefing unit tests
// =========================================================================

describe("generateBriefing", () => {
  const workspace = "__test-handoff__";

  afterEach(() => {
    claudeChat.clearHistory(workspace);
  });

  it("returns null when there is no history", () => {
    expect(claudeChat.generateBriefing(workspace)).toBeNull();
  });

  it("includes continuation preamble", () => {
    claudeChat.pushHistory(workspace, "user", "Hello");
    claudeChat.pushHistory(workspace, "assistant", "Hi there!");

    const briefing = claudeChat.generateBriefing(workspace);
    expect(briefing).toContain("continued from a previous conversation");
    expect(briefing).toContain("continue the conversation from where we left off");
  });

  it("includes user and assistant messages from history", () => {
    claudeChat.pushHistory(workspace, "user", "What is 2+2?");
    claudeChat.pushHistory(workspace, "assistant", "2+2 equals 4.");

    const briefing = claudeChat.generateBriefing(workspace);
    expect(briefing).toContain("User: What is 2+2?");
    expect(briefing).toContain("Assistant: 2+2 equals 4.");
  });

  it("filters out tool_use and tool_result entries", () => {
    claudeChat.pushHistory(workspace, "user", "Read the file");
    claudeChat.pushHistory(workspace, "tool_use", '{"tool_name":"Read"}');
    claudeChat.pushHistory(workspace, "tool_result", '{"output":"contents"}');
    claudeChat.pushHistory(workspace, "assistant", "Here are the contents.");

    const briefing = claudeChat.generateBriefing(workspace);
    expect(briefing).toContain("User: Read the file");
    expect(briefing).toContain("Assistant: Here are the contents.");
    expect(briefing).not.toContain("tool_name");
    expect(briefing).not.toContain("tool_result");
  });

  it("truncates very long messages", () => {
    const longMessage = "x".repeat(5000);
    claudeChat.pushHistory(workspace, "user", longMessage);
    claudeChat.pushHistory(workspace, "assistant", "OK");

    const briefing = claudeChat.generateBriefing(workspace);
    // Message should be truncated to 2000 chars
    expect(briefing.indexOf("x".repeat(2001))).toBe(-1);
    expect(briefing).toContain("x".repeat(100)); // but still has some
  });

  it("takes only the tail of long conversations", () => {
    // Push 50 user/assistant pairs — should only keep last 20 pairs (40 messages)
    for (let i = 0; i < 50; i++) {
      claudeChat.pushHistory(workspace, "user", `Question ${i}`);
      claudeChat.pushHistory(workspace, "assistant", `Answer ${i}`);
    }

    const briefing = claudeChat.generateBriefing(workspace);
    // First messages should be trimmed
    expect(briefing).not.toContain("Question 0");
    expect(briefing).not.toContain("Question 29");
    // Last messages should be present
    expect(briefing).toContain("Question 49");
    expect(briefing).toContain("Answer 49");
    expect(briefing).toContain("Question 30");
  });

  it("handles messages with empty content gracefully", () => {
    claudeChat.pushHistory(workspace, "user", "");
    claudeChat.pushHistory(workspace, "assistant", "");

    const briefing = claudeChat.generateBriefing(workspace);
    expect(briefing).not.toBeNull();
    expect(briefing).toContain("User: ");
    expect(briefing).toContain("Assistant: ");
  });

  it("works with a single user message (no assistant reply yet)", () => {
    claudeChat.pushHistory(workspace, "user", "Hello");

    const briefing = claudeChat.generateBriefing(workspace);
    expect(briefing).not.toBeNull();
    expect(briefing).toContain("User: Hello");
    expect(briefing).not.toContain("Assistant:");
  });

  it("handles null content in history entries", () => {
    claudeChat.pushHistory(workspace, "user", null);
    claudeChat.pushHistory(workspace, "assistant", "Response");

    const briefing = claudeChat.generateBriefing(workspace);
    expect(briefing).not.toBeNull();
    expect(briefing).toContain("Assistant: Response");
  });
});

// =========================================================================
// Source-level invariants for handoff system
// =========================================================================

describe("handoff invariants", () => {
  it("startChat injects briefing when no session to resume", () => {
    // startChat must call generateBriefing when there is no sessionId to --resume.
    // This ensures manual stop+start and server restarts get context continuity.
    const startChatFn = claudeChatSrc.match(/async function startChat\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
    expect(startChatFn, "startChat function must exist").toBeTruthy();

    const body = startChatFn[1];
    const callsBriefing = /generateBriefing/.test(body);
    expect(callsBriefing, [
      "startChat must call generateBriefing when no session to resume.",
      "Without this, manual stop+start loses all conversation context.",
    ].join("\n")).toBe(true);
  });

  it("performHandoff creates a new session and starts fresh", () => {
    // performHandoff must call newSession() and NOT pass a sessionId to --resume,
    // ensuring the new Claude instance gets a clean context window.
    const handoffFn = claudeChatSrc.match(/async function performHandoff\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
    expect(handoffFn, "performHandoff function must exist").toBeTruthy();

    const body = handoffFn[1];
    expect(/newSession/.test(body), "performHandoff must call newSession").toBe(true);
    expect(/generateBriefing/.test(body), "performHandoff must call generateBriefing").toBe(true);
    expect(/session_id:\s*""/.test(body), "performHandoff must use empty session_id (no --resume)").toBe(true);
  });

  it("server auto-handoff triggers at 75% context usage", () => {
    // The server must check context_used_pct after turn completion and trigger
    // a handoff when it reaches the threshold.
    const hasThresholdCheck = /context_used_pct.*>=\s*75|>=\s*75.*context_used_pct/.test(serverSrc) ||
      /usedPct\s*>=\s*75/.test(serverSrc);
    expect(hasThresholdCheck, [
      "server.js must trigger auto-handoff at 75% context usage.",
      "Without this, sessions run until Claude's context window is full",
      "and the conversation degrades or errors out.",
    ].join("\n")).toBe(true);
  });

  it("server broadcasts context_reload event on handoff", () => {
    const hasContextReload = /type:\s*["']context_reload["']/.test(serverSrc);
    expect(hasContextReload, [
      "server.js must broadcast a context_reload event during handoff.",
      "This tells the frontend to render a visual marker in the chat.",
    ].join("\n")).toBe(true);
  });

  it("server calls wireRelayEvents on the new handle after handoff", () => {
    const hasWireAfterHandoff = /performHandoff[\s\S]*?wireRelayEvents/.test(serverSrc);
    expect(hasWireAfterHandoff, [
      "server.js must call wireRelayEvents on the new relay handle after handoff.",
      "Without this, events from the new Claude instance are never routed to clients.",
    ].join("\n")).toBe(true);
  });
});
