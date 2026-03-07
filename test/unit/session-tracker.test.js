/**
 * Unit tests for lib/session-tracker.js
 *
 * Tests the session tracking logic: adding sessions, URL management,
 * duplicate detection, and data retrieval.
 *
 * Strategy: Write a real sessions.json to the path the module expects,
 * and clean it up after each test. This avoids fragile fs mocking that
 * breaks require() in CommonJS.
 */

const fs = require("fs");
const path = require("path");

vi.mock("../../lib/claude", () => ({
  findLatestSessionId: () => null,
}));
vi.mock("../../lib/tmux", () => ({
  getClaudeUrlFromProcess: () => null,
  getClaudeUrl: () => null,
}));

const tracker = require("../../lib/session-tracker");

// The module writes to <project-root>/sessions.json
const SESSIONS_FILE = path.join(__dirname, "..", "..", "sessions.json");
let originalContent = null;

beforeEach(() => {
  // Backup existing file if present
  try {
    originalContent = fs.readFileSync(SESSIONS_FILE, "utf-8");
  } catch {
    originalContent = null;
  }
  // Start with empty state
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify({}) + "\n");
});

afterEach(() => {
  // Restore original or remove
  if (originalContent !== null) {
    fs.writeFileSync(SESSIONS_FILE, originalContent);
  } else {
    try { fs.unlinkSync(SESSIONS_FILE); } catch {}
  }
});

function readStore() {
  return JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf-8"));
}

function writeStore(data) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data) + "\n");
}

describe("session-tracker", () => {
  describe("addSession", () => {
    it("adds a new session and returns true", () => {
      const result = tracker.addSession("my-workspace", "sess-abc", "fresh");
      expect(result).toBe(true);
      const store = readStore();
      expect(store["my-workspace"]).toHaveLength(1);
      expect(store["my-workspace"][0].sessionId).toBe("sess-abc");
      expect(store["my-workspace"][0].mode).toBe("fresh");
    });

    it("rejects duplicate session IDs and returns false", () => {
      writeStore({
        "my-workspace": [{ sessionId: "sess-abc", startedAt: 1000, mode: "fresh" }],
      });
      const result = tracker.addSession("my-workspace", "sess-abc");
      expect(result).toBe(false);
    });

    it("returns false for empty sessionId", () => {
      expect(tracker.addSession("my-workspace", "")).toBe(false);
    });

    it("returns false for null sessionId", () => {
      expect(tracker.addSession("my-workspace", null)).toBe(false);
    });

    it("creates workspace array if it does not exist", () => {
      tracker.addSession("new-workspace", "sess-xyz");
      const store = readStore();
      expect(store["new-workspace"]).toBeDefined();
      expect(store["new-workspace"]).toHaveLength(1);
    });

    it("preserves existing workspaces when adding to new workspace", () => {
      writeStore({ existing: [{ sessionId: "s1", startedAt: 1 }] });
      tracker.addSession("new-ws", "s2");
      const store = readStore();
      expect(store.existing).toHaveLength(1);
      expect(store["new-ws"]).toHaveLength(1);
    });

    it("records startedAt timestamp", () => {
      const before = Date.now();
      tracker.addSession("ws", "sess-1");
      const after = Date.now();
      const store = readStore();
      expect(store.ws[0].startedAt).toBeGreaterThanOrEqual(before);
      expect(store.ws[0].startedAt).toBeLessThanOrEqual(after);
    });
  });

  describe("getSessions", () => {
    it("returns sessions sorted by startedAt descending", () => {
      writeStore({
        ws: [
          { sessionId: "old", startedAt: 1000 },
          { sessionId: "new", startedAt: 3000 },
          { sessionId: "mid", startedAt: 2000 },
        ],
      });
      const sessions = tracker.getSessions("ws");
      expect(sessions[0].sessionId).toBe("new");
      expect(sessions[1].sessionId).toBe("mid");
      expect(sessions[2].sessionId).toBe("old");
    });

    it("returns empty array for unknown workspace", () => {
      expect(tracker.getSessions("nonexistent")).toEqual([]);
    });
  });

  describe("getSessionIds", () => {
    it("returns just the session ID strings in startedAt order", () => {
      writeStore({
        ws: [
          { sessionId: "sess-1", startedAt: 2000 },
          { sessionId: "sess-2", startedAt: 1000 },
        ],
      });
      const ids = tracker.getSessionIds("ws");
      expect(ids).toEqual(["sess-1", "sess-2"]);
    });

    it("returns empty array for unknown workspace", () => {
      expect(tracker.getSessionIds("nope")).toEqual([]);
    });
  });

  describe("URL management", () => {
    it("getClaudeUrl returns null for unknown workspace", () => {
      expect(tracker.getClaudeUrl("unknown")).toBeNull();
    });

    it("getClaudeUrl returns null when no _urls key", () => {
      writeStore({ ws: [] });
      expect(tracker.getClaudeUrl("ws")).toBeNull();
    });

    it("getClaudeUrl returns stored URL", () => {
      writeStore({ _urls: { ws: "https://claude.ai/chat/sess-123" } });
      expect(tracker.getClaudeUrl("ws")).toBe("https://claude.ai/chat/sess-123");
    });

    it("clearClaudeUrl removes the URL", () => {
      writeStore({ _urls: { ws: "https://claude.ai/chat/sess-123", other: "keep" } });
      tracker.clearClaudeUrl("ws");
      const store = readStore();
      expect(store._urls.ws).toBeUndefined();
      expect(store._urls.other).toBe("keep");
    });

    it("clearClaudeUrl is no-op when no _urls key exists", () => {
      writeStore({});
      const before = fs.readFileSync(SESSIONS_FILE, "utf-8");
      tracker.clearClaudeUrl("ws");
      // File should not have been rewritten (no-op path)
      const after = fs.readFileSync(SESSIONS_FILE, "utf-8");
      expect(after).toBe(before);
    });
  });

  describe("detectAndTrack", () => {
    // detectAndTrack calls claude.findLatestSessionId which is mocked to return
    // null. With pool:forks, vi.mock doesn't support mockReturnValueOnce on the
    // returned reference, so we test the timeout path only.
    it("returns null when no session is detected", async () => {
      const id = await tracker.detectAndTrack("ws", Date.now(), 1, 10);
      expect(id).toBeNull();
    });
  });

  describe("addSession with multiple workspaces", () => {
    it("supports adding sessions to multiple workspaces", () => {
      tracker.addSession("ws-a", "sess-1");
      tracker.addSession("ws-b", "sess-2");
      tracker.addSession("ws-a", "sess-3");

      const wsA = tracker.getSessions("ws-a");
      const wsB = tracker.getSessions("ws-b");
      expect(wsA).toHaveLength(2);
      expect(wsB).toHaveLength(1);
    });
  });
});
