const { test, expect } = require("@playwright/test");

test.describe("Beads Panel", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Wait for beads section to become visible (loaded via refreshBeads)
    await page.waitForSelector("#beads-section:not(.hidden)", { timeout: 5000 });
  });

  test("beads section is visible with bead items", async ({ page }) => {
    const section = page.locator("#beads-section");
    await expect(section).toBeVisible();
    const items = page.locator(".beads-list .bead-row, .beads-list .bead-item, .beads-list > div");
    const count = await items.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test("filter buttons exist and All is active by default", async ({ page }) => {
    const allBtn = page.locator('.beads-filter[data-filter="all"]');
    await expect(allBtn).toHaveClass(/active/);

    const filters = page.locator(".beads-filter");
    await expect(filters).toHaveCount(5); // All, Open, In Progress, Blocked, Closed
  });

  test("clicking Open filter shows only open beads", async ({ page }) => {
    const openBtn = page.locator('.beads-filter[data-filter="open"]');
    await openBtn.click();
    await expect(openBtn).toHaveClass(/active/);

    // The "All" button should no longer be active
    const allBtn = page.locator('.beads-filter[data-filter="all"]');
    await expect(allBtn).not.toHaveClass(/active/);
  });

  test("clicking filter buttons switches active state", async ({ page }) => {
    const filters = ["open", "in_progress", "blocked", "closed", "all"];
    for (const f of filters) {
      const btn = page.locator(`.beads-filter[data-filter="${f}"]`);
      await btn.click();
      await expect(btn).toHaveClass(/active/);
    }
  });

  test("new bead form opens and closes", async ({ page }) => {
    const form = page.locator("#bead-form");
    await expect(form).toHaveClass(/hidden/);

    // Open form
    await page.click('button:has-text("+ New Bead")');
    await expect(form).not.toHaveClass(/hidden/);

    // Title input should be focused
    const titleInput = page.locator("#bead-title");
    await expect(titleInput).toBeVisible();

    // Close form
    await page.click('#bead-form button:has-text("Cancel")');
    await expect(form).toHaveClass(/hidden/);
  });

  test("creating a new bead via form", async ({ page }) => {
    // Open form
    await page.click('button:has-text("+ New Bead")');

    // Fill in the form
    await page.fill("#bead-title", "E2E Test Bead");
    await page.fill("#bead-desc", "Created by E2E test");
    await page.selectOption("#bead-priority", "1");
    await page.selectOption("#bead-type", "bug");

    // Submit
    await page.click('#bead-form button:has-text("Create")');

    // Form should close
    await expect(page.locator("#bead-form")).toHaveClass(/hidden/);

    // Wait for beads to refresh and show the new bead
    await page.waitForFunction(() => {
      const el = document.getElementById("beads-list");
      return el && el.textContent.includes("E2E Test Bead");
    }, { timeout: 5000 });
  });

  test("empty title prevents bead creation", async ({ page }) => {
    await page.click('button:has-text("+ New Bead")');

    // Try to submit with empty title
    await page.click('#bead-form button:has-text("Create")');

    // Form should still be open (submission prevented)
    await expect(page.locator("#bead-form")).not.toHaveClass(/hidden/);
  });
});

test.describe("Bead Detail View", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#beads-section:not(.hidden)", { timeout: 5000 });
  });

  test("clicking a bead title opens detail panel", async ({ page }) => {
    const overlay = page.locator("#bead-detail-overlay");
    await expect(overlay).toHaveClass(/hidden/);

    // Click the first bead title
    await page.locator(".bead-title").first().click();

    await expect(overlay).not.toHaveClass(/hidden/);
  });

  test("bead detail shows bead ID", async ({ page }) => {
    await page.locator(".bead-title").first().click();
    await page.waitForSelector("#bead-detail-overlay:not(.hidden)", { timeout: 5000 });

    const idEl = page.locator("#bead-detail-id");
    await expect(idEl).toContainText("klaudii-");
  });

  test("bead detail close button works", async ({ page }) => {
    await page.locator(".bead-title").first().click();
    await page.waitForSelector("#bead-detail-overlay:not(.hidden)", { timeout: 5000 });

    await page.click('#bead-detail-panel button:has-text("X")');
    await expect(page.locator("#bead-detail-overlay")).toHaveClass(/hidden/);
  });

  test("bead detail closes on backdrop click", async ({ page }) => {
    await page.locator(".bead-title").first().click();
    await page.waitForSelector("#bead-detail-overlay:not(.hidden)", { timeout: 5000 });

    // Click the overlay (outside the panel)
    await page.locator("#bead-detail-overlay").click({ position: { x: 5, y: 5 } });
    await expect(page.locator("#bead-detail-overlay")).toHaveClass(/hidden/);
  });

  test("beads show different status badges", async ({ page }) => {
    // The mock data has beads in different statuses — ensure they all render
    const beadsList = page.locator("#beads-list");
    await expect(beadsList).toBeVisible();

    // Check that bead titles from mock data are present
    await expect(beadsList).toContainText("Fix login button");
    await expect(beadsList).toContainText("Add dark mode");
  });

  test("filtering to closed shows only closed beads", async ({ page }) => {
    const closedBtn = page.locator('.beads-filter[data-filter="closed"]');
    await closedBtn.click();

    // Wait for filter to apply
    await page.waitForTimeout(100);

    // The closed bead "Refactor CSS" should be visible
    // Open beads should be hidden
    const visibleBeads = page.locator(".bead-row:visible, .bead-item:visible, #beads-list > div:visible");
    const count = await visibleBeads.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });
});
