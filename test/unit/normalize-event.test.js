/**
 * Unit tests for normalizeEvent — the event normalization layer in claude-chat.js.
 *
 * WHY THESE TESTS EXIST:
 *
 * normalizeEvent contains the single most important line in the entire persistence
 * pipeline: the synthetic `{ type: "result" }` emitted when a `user` event arrives.
 * Claude CLI in --input-format stream-json mode NEVER emits native "result" events
 * between turns. That synthetic result is the ONLY trigger for pushHistoryBatch()
 * and turn-end persistence. Without it, assistant responses accumulate in memory
 * and are silently lost on page reload or server restart. Streaming to the client
 * still works, so the bug is invisible until the data is needed from disk.
 *
 * If any of these tests fail, the persistence pipeline is broken. Do not "fix"
 * the tests by changing expected values — fix the code to match the expectations.
 */

const { _normalizeEvent: normalizeEvent } = require("../../lib/claude-chat");

describe("normalizeEvent", () => {
  // =========================================================================
  // CRITICAL INVARIANT: user events emit a synthetic result FIRST
  // =========================================================================

  describe("user event → synthetic result (CRITICAL)", () => {
    it("emits tool_result events BEFORE the synthetic { type: 'result' }", () => {
      // The synthetic result triggers "done" on the client, which resets
      // streaming state. Tool_results must be emitted first so clients
      // finalize tool pills before the done signal. The synthetic result
      // is still the SOLE trigger for persisting assistant turns — it just
      // comes AFTER tool_results now.
      const raw = {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_abc",
              content: "file contents here",
            },
          ],
        },
        tool_use_result: { file: { content: "file contents here" } },
      };

      const events = normalizeEvent(raw);

      // tool_result comes first
      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events[0].type).toBe("tool_result");
      expect(events[0].tool_id).toBe("tool_abc");

      // Synthetic result comes LAST
      expect(events[events.length - 1]).toEqual({ type: "result", stats: {} });
    });

    it("emits synthetic result even for user events with no tool_result blocks", () => {
      // A plain user message with no tool results should still trigger turn-end
      const raw = {
        type: "user",
        message: {
          role: "user",
          content: [],
        },
      };

      const events = normalizeEvent(raw);
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0]).toEqual({ type: "result", stats: {} });
    });

    it("emits synthetic result even when message content is missing", () => {
      const raw = { type: "user" };
      const events = normalizeEvent(raw);
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0]).toEqual({ type: "result", stats: {} });
    });
  });

  // =========================================================================
  // assistant events
  // =========================================================================

  describe("assistant events", () => {
    it("extracts text blocks as message events", () => {
      const raw = {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Hello, I'll help you with that." },
          ],
        },
      };

      const events = normalizeEvent(raw);
      expect(events).toEqual([
        {
          type: "message",
          role: "assistant",
          content: "Hello, I'll help you with that.",
          delta: true,
        },
      ]);
    });

    it("extracts tool_use blocks", () => {
      const raw = {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Read",
              id: "tool_123",
              input: { file_path: "/tmp/test.js" },
            },
          ],
        },
      };

      const events = normalizeEvent(raw);
      expect(events).toEqual([
        {
          type: "tool_use",
          tool_name: "Read",
          tool_id: "tool_123",
          parameters: { file_path: "/tmp/test.js" },
        },
      ]);
    });

    it("handles mixed text and tool_use blocks in order", () => {
      const raw = {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Let me read that file." },
            { type: "tool_use", name: "Read", id: "t1", input: { file_path: "/a.js" } },
          ],
        },
      };

      const events = normalizeEvent(raw);
      expect(events.length).toBe(2);
      expect(events[0].type).toBe("message");
      expect(events[1].type).toBe("tool_use");
    });

    it("returns empty array for assistant event with no content", () => {
      const events = normalizeEvent({ type: "assistant", message: {} });
      expect(events).toEqual([]);
    });
  });

  // =========================================================================
  // system/init events
  // =========================================================================

  describe("system events", () => {
    it("extracts session_id and model from init", () => {
      const raw = {
        type: "system",
        subtype: "init",
        session_id: "sess-abc-123",
        model: "claude-sonnet-4-20250514",
      };

      const events = normalizeEvent(raw);
      expect(events).toEqual([
        { type: "init", session_id: "sess-abc-123", model: "claude-sonnet-4-20250514" },
      ]);
    });
  });

  // =========================================================================
  // result events (native — rare but must pass through)
  // =========================================================================

  describe("result events", () => {
    it("passes through native result events with stats", () => {
      const raw = {
        type: "result",
        total_cost_usd: 0.05,
        duration_ms: 3200,
        num_turns: 2,
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 0,
        },
      };

      const events = normalizeEvent(raw);
      expect(events.length).toBe(1);
      expect(events[0].type).toBe("result");
      expect(events[0].stats.cost).toBe(0.05);
      expect(events[0].stats.duration_ms).toBe(3200);
      expect(events[0].stats.turns).toBe(2);
      expect(events[0].stats.total_tokens).toBe(1700);
    });
  });

  // =========================================================================
  // Synthetic vs real result detection (isSyntheticFlush contract)
  // =========================================================================

  describe("synthetic flush detection (CRITICAL)", () => {
    // The server distinguishes synthetic results (from user events / flushTurn)
    // from real results (from Claude finishing) by checking whether stats is
    // empty. This contract is load-bearing: if broken, either every tool-call
    // turn broadcasts a premature "done", or real turn-ends are silently ignored.

    it("synthetic result from user event has empty stats (server detects as flush)", () => {
      const raw = { type: "user", message: { role: "user", content: [] } };
      const events = normalizeEvent(raw);
      const result = events.find(e => e.type === "result");
      expect(result, "user event must produce a result").toBeTruthy();
      expect(Object.keys(result.stats).length).toBe(0);
    });

    it("real result from Claude has non-empty stats (server broadcasts done)", () => {
      const raw = {
        type: "result",
        total_cost_usd: 0.01,
        duration_ms: 500,
        num_turns: 1,
        usage: { input_tokens: 100, output_tokens: 50 },
      };
      const events = normalizeEvent(raw);
      const result = events.find(e => e.type === "result");
      expect(result, "result event must be passed through").toBeTruthy();
      expect(Object.keys(result.stats).length).toBeGreaterThan(0);
    });

    it("synthetic result must NOT carry _flush or any extra properties", () => {
      const raw = { type: "user", message: { role: "user", content: [] } };
      const events = normalizeEvent(raw);
      const result = events.find(e => e.type === "result");
      expect(result).toEqual({ type: "result", stats: {} });
    });

    it("user event with tool_results: synthetic result still has empty stats", () => {
      const raw = {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "ok" },
            { type: "tool_result", tool_use_id: "t2", content: "ok" },
          ],
        },
      };
      const events = normalizeEvent(raw);
      const result = events[events.length - 1];
      expect(result.type).toBe("result");
      expect(Object.keys(result.stats).length).toBe(0);
    });
  });

  // =========================================================================
  // tool_result extraction from user events
  // =========================================================================

  describe("tool_result extraction", () => {
    it("extracts file content from tool_use_result", () => {
      const raw = {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1" }],
        },
        tool_use_result: { file: { content: "const x = 1;" } },
      };

      const events = normalizeEvent(raw);
      const tr = events.find(e => e.type === "tool_result");
      expect(tr.output).toBe("const x = 1;");
    });

    it("extracts stdout/stderr from bash tool results", () => {
      const raw = {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1" }],
        },
        tool_use_result: { stdout: "hello", stderr: "warn" },
      };

      const events = normalizeEvent(raw);
      const tr = events.find(e => e.type === "tool_result");
      expect(tr.output).toBe("hello\nwarn");
    });

    it("marks error tool results", () => {
      const raw = {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "ENOENT" }],
        },
        tool_use_result: null,
      };

      const events = normalizeEvent(raw);
      const tr = events.find(e => e.type === "tool_result");
      expect(tr.status).toBe("error");
    });
  });
});
