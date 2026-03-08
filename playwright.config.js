const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./test/e2e",
  testMatch: "*.spec.js",
  timeout: 30000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: "http://localhost:9899",
    headless: true,
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node test/e2e/test-server.js",
    port: 9899,
    reuseExistingServer: false,
    timeout: 10000,
  },
});
