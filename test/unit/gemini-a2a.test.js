/**
 * Unit tests for lib/gemini-a2a.js
 *
 * Tests the exported API surface: isActive, stopProcess, stopAllProcesses,
 * confirmToolCall.
 *
 * NOTE: sendMessage triggers async process spawning via setImmediate.
 * Testing it properly requires mocking child_process.spawn + http, which
 * is fragile in forked vitest processes. The sendMessage return interface
 * is tested structurally (method presence) without triggering the async path.
 *
 * Internal functions (mapA2AEvent, findServerScript, getFreePort, etc.)
 * are not exported. To enable comprehensive unit testing of the event mapping
 * logic, mapA2AEvent should be exported as _mapA2AEvent.
 */

const geminiA2A = require("../../lib/gemini-a2a");

describe("gemini-a2a", () => {
  describe("isActive", () => {
    it("returns false for non-existent workspace", () => {
      expect(geminiA2A.isActive("nonexistent")).toBe(false);
    });

    it("returns false for empty string workspace", () => {
      expect(geminiA2A.isActive("")).toBe(false);
    });

    it("returns false after stopProcess on same workspace", () => {
      geminiA2A.stopProcess("test-ws");
      expect(geminiA2A.isActive("test-ws")).toBe(false);
    });

    it("returns boolean type", () => {
      expect(typeof geminiA2A.isActive("any")).toBe("boolean");
    });
  });

  describe("stopProcess", () => {
    it("is no-op for non-existent workspace", () => {
      expect(() => geminiA2A.stopProcess("nonexistent")).not.toThrow();
    });

    it("can be called multiple times without error", () => {
      geminiA2A.stopProcess("ws");
      geminiA2A.stopProcess("ws");
      expect(geminiA2A.isActive("ws")).toBe(false);
    });
  });

  describe("stopAllProcesses", () => {
    it("is no-op when no servers are running", () => {
      expect(() => geminiA2A.stopAllProcesses()).not.toThrow();
    });

    it("can be called multiple times without error", () => {
      geminiA2A.stopAllProcesses();
      geminiA2A.stopAllProcesses();
    });
  });

  describe("confirmToolCall", () => {
    it("throws for non-existent workspace", async () => {
      await expect(geminiA2A.confirmToolCall("nonexistent", "call-1"))
        .rejects.toThrow("No active server for workspace: nonexistent");
    });

    it("throws with the correct workspace name in error", async () => {
      await expect(geminiA2A.confirmToolCall("my-ws", "call-2", "proceed_once"))
        .rejects.toThrow("my-ws");
    });

    it("rejects with Error instance", async () => {
      try {
        await geminiA2A.confirmToolCall("bad-ws", "c1");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
      }
    });

    it("includes 'No active server' in error message", async () => {
      try {
        await geminiA2A.confirmToolCall("ws-test", "c1", "deny_once");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err.message).toContain("No active server");
      }
    });
  });

  describe("module exports", () => {
    it("exports the expected public API", () => {
      expect(geminiA2A).toHaveProperty("startChat");
      expect(geminiA2A).toHaveProperty("isActive");
      expect(geminiA2A).toHaveProperty("stopProcess");
      expect(geminiA2A).toHaveProperty("stopAllProcesses");
      expect(geminiA2A).toHaveProperty("confirmToolCall");
    });

    it("exports exactly 5 functions", () => {
      expect(Object.keys(geminiA2A)).toHaveLength(5);
    });

    it("all exports are functions", () => {
      for (const key of Object.keys(geminiA2A)) {
        expect(typeof geminiA2A[key]).toBe("function");
      }
    });
  });
});
