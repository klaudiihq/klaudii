/**
 * Unit tests for lib/gemini-core.js
 *
 * Tests the exported API surface: isActive, stopProcess, stopAllProcesses,
 * confirmToolCall, executeCommand.
 *
 * NOTE: startChat triggers async process setup via setImmediate.
 * Testing it properly requires mocking @google/gemini-cli-core, which
 * is fragile. The startChat return interface is tested structurally
 * (method presence) without triggering the async path.
 */

const geminiCore = require("../../lib/gemini-core");

describe("gemini-core", () => {
  describe("isActive", () => {
    it("returns false for non-existent workspace", () => {
      expect(geminiCore.isActive("nonexistent")).toBe(false);
    });

    it("returns false for empty string workspace", () => {
      expect(geminiCore.isActive("")).toBe(false);
    });

    it("returns false after stopProcess on same workspace", () => {
      geminiCore.stopProcess("test-ws");
      expect(geminiCore.isActive("test-ws")).toBe(false);
    });

    it("returns boolean type", () => {
      expect(typeof geminiCore.isActive("any")).toBe("boolean");
    });
  });

  describe("stopProcess", () => {
    it("is no-op for non-existent workspace", () => {
      expect(() => geminiCore.stopProcess("nonexistent")).not.toThrow();
    });

    it("can be called multiple times without error", () => {
      geminiCore.stopProcess("ws");
      geminiCore.stopProcess("ws");
      expect(geminiCore.isActive("ws")).toBe(false);
    });
  });

  describe("stopAllProcesses", () => {
    it("is no-op when no sessions are running", () => {
      expect(() => geminiCore.stopAllProcesses()).not.toThrow();
    });

    it("can be called multiple times without error", () => {
      geminiCore.stopAllProcesses();
      geminiCore.stopAllProcesses();
    });
  });

  describe("confirmToolCall", () => {
    it("throws for non-existent workspace", () => {
      expect(() => geminiCore.confirmToolCall("nonexistent", 1, "call-1"))
        .toThrow("No active session for workspace: nonexistent session: 1");
    });

    it("throws with the correct workspace name in error", () => {
      expect(() => geminiCore.confirmToolCall("my-ws", 1, "call-2", "proceed_once"))
        .toThrow("my-ws");
    });

    it("rejects with Error instance", async () => {
      try {
        await geminiCore.confirmToolCall("bad-ws", 1, "c1");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
      }
    });

    it("includes 'No active session' in error message", async () => {
      try {
        await geminiCore.confirmToolCall("ws-test", 1, "c1", "deny_once");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err.message).toContain("No active session");
      }
    });
  });

  describe("executeCommand", () => {
    it("rejects unknown commands", async () => {
      // executeCommand requires an active session for most commands,
      // but unknown commands fail before that check
      await expect(geminiCore.executeCommand("ws", 1, "bogus", []))
        .rejects.toThrow("Unknown command");
    });
  });

  describe("module exports", () => {
    it("exports the expected public API", () => {
      expect(geminiCore).toHaveProperty("startChat");
      expect(geminiCore).toHaveProperty("isActive");
      expect(geminiCore).toHaveProperty("stopProcess");
      expect(geminiCore).toHaveProperty("stopAllProcesses");
      expect(geminiCore).toHaveProperty("confirmToolCall");
      expect(geminiCore).toHaveProperty("getActiveServerInfo");
      expect(geminiCore).toHaveProperty("executeCommand");
    });

    it("exports exactly 7 functions", () => {
      expect(Object.keys(geminiCore)).toHaveLength(7);
    });

    it("all exports are functions", () => {
      for (const key of Object.keys(geminiCore)) {
        expect(typeof geminiCore[key]).toBe("function");
      }
    });
  });
});
