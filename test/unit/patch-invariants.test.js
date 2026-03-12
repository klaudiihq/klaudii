/**
 * Patch invariant tests — verify node_modules patches are applied.
 *
 * These tests grep patched files to ensure critical fixes are present.
 * Each test documents the bug, the fix, and where to find the porting guide.
 *
 * If a test fails, see patches/PORTING_GUIDE.md for step-by-step instructions.
 */

const fs = require("fs");
const path = require("path");

const CORE_SCHEDULER = path.join(
  __dirname, "..", "..",
  "node_modules/@google/gemini-cli-core/dist/src/core/coreToolScheduler.js"
);

// Also verify our own code passes the answer correctly
const GEMINI_CORE = path.join(__dirname, "..", "..", "lib/gemini-core.js");

// Skip if gemini-cli-core is not installed (optional dep)
const coreInstalled = fs.existsSync(CORE_SCHEDULER);

describe.skipIf(!coreInstalled)("gemini-cli-core patches", () => {
  let schedulerSource;

  beforeAll(() => {
    schedulerSource = fs.readFileSync(CORE_SCHEDULER, "utf-8");
  });

  it("handleConfirmationResponse must pass payload to originalOnConfirm", () => {
    // HISTORY (2026-03-12): handleConfirmationResponse receives `payload` as its
    // 5th parameter but the upstream code calls `originalOnConfirm(outcome)` without
    // forwarding payload. This means AskUserInvocation.onConfirm never receives user
    // answers — this.userAnswers stays {}, and the tool returns "User submitted without
    // answering questions" to the LLM. Users see their chosen answer ignored.
    //
    // FIX: originalOnConfirm(outcome) → originalOnConfirm(outcome, payload)
    // PATCH: patches/@google+gemini-cli-core+*.patch
    // GUIDE: patches/PORTING_GUIDE.md

    // Simple whole-file grep — no fragile method-body extraction
    const hasFixedCall = schedulerSource.includes("originalOnConfirm(outcome, payload)");
    const hasBuggyCall = /await originalOnConfirm\(outcome\)\s*;/.test(schedulerSource);

    expect(hasFixedCall, [
      "PATCH NOT APPLIED: handleConfirmationResponse must call originalOnConfirm(outcome, payload).",
      "Without payload, ask_user answers are silently dropped — users see their selection ignored.",
      "",
      "To fix: see patches/PORTING_GUIDE.md",
      "Quick fix: change `originalOnConfirm(outcome)` to `originalOnConfirm(outcome, payload)`",
      `File: ${CORE_SCHEDULER}`,
    ].join("\n")).toBe(true);

    expect(hasBuggyCall, [
      "PATCH REGRESSION: found originalOnConfirm(outcome) without payload.",
      "This drops ask_user answers. Must be originalOnConfirm(outcome, payload).",
      "",
      "To fix: see patches/PORTING_GUIDE.md",
    ].join("\n")).toBe(false);
  });
});

describe("gemini-core.js confirm flow", () => {
  let geminiCoreSource;

  beforeAll(() => {
    geminiCoreSource = fs.readFileSync(GEMINI_CORE, "utf-8");
  });

  it("confirmToolCall must build payload with answers for ask_user", () => {
    // Our confirmToolCall must construct { answers: ... } and pass it to onConfirm.
    // Without this, even if the upstream patch is applied, answers don't reach the tool.
    const hasAnswerPayload = /payload\s*=\s*\{\s*answers\s*:/.test(geminiCoreSource);

    expect(hasAnswerPayload, [
      "gemini-core.js confirmToolCall must build a payload with { answers: ... }",
      "for ask_user tool confirmations. Without this, the user's answer never",
      "reaches AskUserInvocation even if the upstream patch is applied.",
    ].join("\n")).toBe(true);
  });

  it("confirmToolCall must pass payload to details.onConfirm", () => {
    // onConfirm must receive the payload, not just the outcome
    const hasOnConfirmWithPayload = /details\.onConfirm\s*\(\s*confirmOutcome\s*,\s*payload\s*\)/.test(geminiCoreSource);

    expect(hasOnConfirmWithPayload, [
      "gemini-core.js must call details.onConfirm(confirmOutcome, payload).",
      "Without passing payload, ask_user answers are dropped at our layer.",
    ].join("\n")).toBe(true);
  });

  it("confirmToolCall must check details.type === 'ask_user' for payload", () => {
    // Only build the answers payload for ask_user, not for other tool types
    const checksAskUser = /details\.type\s*===?\s*["']ask_user["']/.test(geminiCoreSource);

    expect(checksAskUser, [
      "gemini-core.js must check details.type === 'ask_user' before building",
      "the answers payload. Other tool types don't expect this payload shape.",
    ].join("\n")).toBe(true);
  });
});

describe("patch registry", () => {
  it("registry.json exists and is valid JSON", () => {
    const registryPath = path.join(__dirname, "..", "..", "patches/registry.json");
    expect(fs.existsSync(registryPath), "patches/registry.json must exist").toBe(true);

    const content = fs.readFileSync(registryPath, "utf-8");
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it.skipIf(!coreInstalled)("installed gemini-cli-core version is in vetted list", () => {
    const registryPath = path.join(__dirname, "..", "..", "patches/registry.json");
    const registry = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
    const corePkg = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "..", "..", "node_modules/@google/gemini-cli-core/package.json"),
        "utf-8"
      )
    );

    const vetted = registry.patches?.["@google/gemini-cli-core"]?.vetted || [];
    const installed = corePkg.version;

    expect(vetted.includes(installed), [
      `UNVETTED VERSION: @google/gemini-cli-core@${installed}`,
      `Vetted versions: ${vetted.join(", ")}`,
      "",
      "The patch may not work correctly on this version.",
      "See patches/PORTING_GUIDE.md to vet and create a patch for this version.",
    ].join("\n")).toBe(true);
  });
});
