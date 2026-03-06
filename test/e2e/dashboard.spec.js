const { test, expect } = require("@playwright/test");

test.describe("Dashboard", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Wait for workspace cards to render
    await page.waitForSelector(".card", { timeout: 5000 });
  });

  test("page loads with title and status badge", async ({ page }) => {
    await expect(page).toHaveTitle(/Klaudii/);
    const badge = page.locator("#status-badge");
    await expect(badge).toHaveText("connected");
    await expect(badge).toHaveClass(/ok/);
  });

  test("workspace cards appear for all sessions", async ({ page }) => {
    const cards = page.locator("#sessions-list .card");
    await expect(cards).toHaveCount(3);
    await expect(page.locator("#card-nova-frontend")).toBeVisible();
    await expect(page.locator("#card-aurora-api")).toBeVisible();
    await expect(page.locator("#card-stellar-ml")).toBeVisible();
  });

  test("workspace cards show project name and branch", async ({ page }) => {
    const novaCard = page.locator("#card-nova-frontend");
    await expect(novaCard.locator(".card-title")).toContainText("nova-frontend");
    await expect(novaCard.locator(".card-branch-link")).toContainText("feature/dark-mode");
  });

  test("running workspace shows running status", async ({ page }) => {
    const novaStatus = page.locator("#card-nova-frontend .card-status");
    await expect(novaStatus).toHaveText("running");
    await expect(novaStatus).toHaveClass(/running/);
  });

  test("stopped workspace shows stopped status", async ({ page }) => {
    const stellarStatus = page.locator("#card-stellar-ml .card-status");
    await expect(stellarStatus).toHaveText("stopped");
    await expect(stellarStatus).toHaveClass(/stopped/);
  });

  test("theme toggle switches between light and dark mode", async ({ page }) => {
    const html = page.locator("html");
    // Start in dark mode (default)
    await expect(html).not.toHaveClass(/light/);

    // Click theme toggle
    await page.click("#theme-toggle");
    await expect(html).toHaveClass(/light/);

    // Click again to go back to dark
    await page.click("#theme-toggle");
    await expect(html).not.toHaveClass(/light/);
  });

  test("sort buttons work", async ({ page }) => {
    const alphaBtn = page.locator("#sort-alpha");
    const activityBtn = page.locator("#sort-activity");

    // Activity is default
    await expect(activityBtn).toHaveClass(/active/);

    // Switch to alpha sort
    await alphaBtn.click();
    await expect(alphaBtn).toHaveClass(/active/);
    await expect(activityBtn).not.toHaveClass(/active/);
  });

  test("running card shows process stats", async ({ page }) => {
    const novaCard = page.locator("#card-nova-frontend");
    await expect(novaCard.locator(".proc-stats")).toBeVisible();
    await expect(novaCard.locator(".proc-stat")).toHaveCount(3); // cpu, mem, uptime
  });

  test("card edit button opens action panel", async ({ page }) => {
    const novaCard = page.locator("#card-nova-frontend");
    const panel = novaCard.locator(".card-actions-panel");

    // Panel starts hidden
    await expect(panel).toHaveClass(/hidden/);

    // Click edit button to open
    await novaCard.locator(".card-edit-btn").click();
    await expect(panel).not.toHaveClass(/hidden/);
  });

  test("chat mode pill is visible on cards", async ({ page }) => {
    const novaPill = page.locator("#card-nova-frontend .chat-mode-pill");
    await expect(novaPill).toBeVisible();
  });
});
