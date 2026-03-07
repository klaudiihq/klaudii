import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    include: ["test/**/*.test.js"],
    globals: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary"],
      thresholds: {
        statements: 60,
        branches: 50,
      },
    },
  },
});
