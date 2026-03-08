/**
 * Tests that task routes validate task IDs to prevent injection attacks.
 * These are source-level invariant checks — the actual HTTP behavior is
 * tested in test/contracts/error-paths.test.js.
 */

const fs = require("fs");
const path = require("path");

const routesSrc = fs.readFileSync(path.join(__dirname, "..", "..", "routes", "v1.js"), "utf-8");

describe("task ID validation", () => {
  it("GET /tasks/:id validates ID format", () => {
    // Extract the route handler for GET /tasks/:id
    const getHandler = routesSrc.match(/router\.get\s*\(\s*["']\/tasks\/:id["']\s*,\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\n\s{2}\}\);/);
    expect(getHandler, "GET /tasks/:id route must exist").toBeTruthy();

    const body = getHandler[1];
    const hasValidation = /\/\^\\d\+\$\/\.test/.test(body) || /\/\^\\d\+\$\//.test(body);
    expect(hasValidation, [
      "GET /tasks/:id must validate that the ID is numeric.",
      "Without validation, malformed IDs reach the database layer.",
    ].join("\n")).toBe(true);
  });

  it("PATCH /tasks/:id validates ID format", () => {
    const patchHandler = routesSrc.match(/router\.patch\s*\(\s*["']\/tasks\/:id["']\s*,\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\n\s{2}\}\);/);
    expect(patchHandler, "PATCH /tasks/:id route must exist").toBeTruthy();

    const body = patchHandler[1];
    const hasValidation = /\/\^\\d\+\$\/\.test/.test(body) || /\/\^\\d\+\$\//.test(body);
    expect(hasValidation, [
      "PATCH /tasks/:id must validate that the ID is numeric.",
      "Without validation, malformed IDs reach the database layer.",
    ].join("\n")).toBe(true);
  });
});
