const { checkTransition, VALID_TRANSITIONS } = require("../../lib/lifecycle");

describe("lifecycle state machine", () => {
  it("allows all valid transitions", () => {
    for (const [from, targets] of Object.entries(VALID_TRANSITIONS)) {
      for (const to of targets) {
        const result = checkTransition(from, to);
        expect(result.valid, `${from} → ${to} should be valid`).toBe(true);
      }
    }
  });

  it("rejects invalid transitions", () => {
    // closed can only go to open (reopen)
    expect(checkTransition("closed", "in_progress").valid).toBe(false);
    expect(checkTransition("closed", "blocked").valid).toBe(false);
  });

  it("allows self-transitions (no-ops)", () => {
    for (const state of Object.keys(VALID_TRANSITIONS)) {
      expect(checkTransition(state, state).valid).toBe(true);
    }
  });

  it("rejects unknown source states", () => {
    expect(checkTransition("nonexistent", "open").valid).toBe(false);
  });

  it("open can go to in_progress, blocked, closed", () => {
    expect(checkTransition("open", "in_progress").valid).toBe(true);
    expect(checkTransition("open", "blocked").valid).toBe(true);
    expect(checkTransition("open", "closed").valid).toBe(true);
  });

  it("in_progress can go to open (reset), blocked, closed", () => {
    expect(checkTransition("in_progress", "open").valid).toBe(true);
    expect(checkTransition("in_progress", "blocked").valid).toBe(true);
    expect(checkTransition("in_progress", "closed").valid).toBe(true);
  });

  it("blocked can go to open, in_progress, closed", () => {
    expect(checkTransition("blocked", "open").valid).toBe(true);
    expect(checkTransition("blocked", "in_progress").valid).toBe(true);
    expect(checkTransition("blocked", "closed").valid).toBe(true);
  });

  it("closed can only be reopened (→ open)", () => {
    expect(checkTransition("closed", "open").valid).toBe(true);
    expect(checkTransition("closed", "in_progress").valid).toBe(false);
    expect(checkTransition("closed", "blocked").valid).toBe(false);
  });
});
