// Task lifecycle — valid state transitions for tasks.
//
// Used by tasks.update() to warn on unexpected transitions.
// Does NOT hard-reject — just logs — so existing flows aren't broken.

const VALID_TRANSITIONS = {
  open:        ["in_progress", "blocked", "closed"],
  in_progress: ["open", "blocked", "closed"],
  blocked:     ["open", "in_progress", "closed"],
  closed:      ["open"], // reopen only
};

/**
 * Check if a task state transition is valid.
 * @param {string} from - current status
 * @param {string} to - desired status
 * @returns {{ valid: boolean, reason?: string }}
 */
function checkTransition(from, to) {
  if (from === to) return { valid: true };
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed) return { valid: false, reason: `unknown state "${from}"` };
  if (!allowed.includes(to)) {
    return { valid: false, reason: `${from} → ${to} is not a valid transition (allowed: ${allowed.join(", ")})` };
  }
  return { valid: true };
}

/**
 * Validate and warn on an unexpected transition. Returns true if valid.
 */
function warnIfInvalid(taskId, from, to) {
  const result = checkTransition(from, to);
  if (!result.valid) {
    console.warn(`[lifecycle] task ${taskId}: ${result.reason}`);
  }
  return result.valid;
}

module.exports = { VALID_TRANSITIONS, checkTransition, warnIfInvalid };
