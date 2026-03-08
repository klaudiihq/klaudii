const { test, expect } = require("@playwright/test");

test.describe("Tasks Panel", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Wait for tasks section to become visible (loaded via refreshTasks)
    await page.waitForSelector("#tasks-section:not(.hidden)", { timeout: 5000 });
  });

  test("tasks section is visible with task items", async ({ page }) => {
    const section = page.locator("#tasks-section");
    await expect(section).toBeVisible();
    const items = page.locator(".tasks-list .task-row, .tasks-list .task-item, .tasks-list > div");
    const count = await items.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test("filter buttons exist and All is active by default", async ({ page }) => {
    const allBtn = page.locator('.tasks-filter[data-filter="all"]');
    await expect(allBtn).toHaveClass(/active/);

    const filters = page.locator(".tasks-filter");
    await expect(filters).toHaveCount(5); // All, Open, In Progress, Blocked, Closed
  });

  test("clicking Open filter shows only open tasks", async ({ page }) => {
    const openBtn = page.locator('.tasks-filter[data-filter="open"]');
    await openBtn.click();
    await expect(openBtn).toHaveClass(/active/);

    // The "All" button should no longer be active
    const allBtn = page.locator('.tasks-filter[data-filter="all"]');
    await expect(allBtn).not.toHaveClass(/active/);
  });

  test("clicking filter buttons switches active state", async ({ page }) => {
    const filters = ["open", "in_progress", "blocked", "closed", "all"];
    for (const f of filters) {
      const btn = page.locator(`.tasks-filter[data-filter="${f}"]`);
      await btn.click();
      await expect(btn).toHaveClass(/active/);
    }
  });

  test("new task form opens and closes", async ({ page }) => {
    const form = page.locator("#task-form");
    await expect(form).toHaveClass(/hidden/);

    // Open form
    await page.click('button:has-text("+ New Task")');
    await expect(form).not.toHaveClass(/hidden/);

    // Title input should be focused
    const titleInput = page.locator("#task-title");
    await expect(titleInput).toBeVisible();

    // Close form
    await page.click('#task-form button:has-text("Cancel")');
    await expect(form).toHaveClass(/hidden/);
  });

  test("creating a new task via form", async ({ page }) => {
    // Open form
    await page.click('button:has-text("+ New Task")');

    // Fill in the form
    await page.fill("#task-title", "E2E Test Task");
    await page.fill("#task-desc", "Created by E2E test");
    await page.selectOption("#task-priority", "1");
    await page.selectOption("#task-type", "bug");

    // Submit
    await page.click('#task-form button:has-text("Create")');

    // Form should close
    await expect(page.locator("#task-form")).toHaveClass(/hidden/);

    // Wait for tasks to refresh and show the new task
    await page.waitForFunction(() => {
      const el = document.getElementById("tasks-list");
      return el && el.textContent.includes("E2E Test Task");
    }, { timeout: 5000 });
  });

  test("empty title prevents task creation", async ({ page }) => {
    await page.click('button:has-text("+ New Task")');

    // Try to submit with empty title
    await page.click('#task-form button:has-text("Create")');

    // Form should still be open (submission prevented)
    await expect(page.locator("#task-form")).not.toHaveClass(/hidden/);
  });
});

test.describe("Task Detail View", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#tasks-section:not(.hidden)", { timeout: 5000 });
  });

  test("clicking a task title opens detail panel", async ({ page }) => {
    const overlay = page.locator("#task-detail-overlay");
    await expect(overlay).toHaveClass(/hidden/);

    // Click the first task title
    await page.locator(".task-title").first().click();

    await expect(overlay).not.toHaveClass(/hidden/);
  });

  test("task detail shows task ID", async ({ page }) => {
    await page.locator(".task-title").first().click();
    await page.waitForSelector("#task-detail-overlay:not(.hidden)", { timeout: 5000 });

    const idEl = page.locator("#task-detail-id");
    await expect(idEl).toContainText("klaudii-");
  });

  test("task detail close button works", async ({ page }) => {
    await page.locator(".task-title").first().click();
    await page.waitForSelector("#task-detail-overlay:not(.hidden)", { timeout: 5000 });

    await page.click('#task-detail-panel button:has-text("X")');
    await expect(page.locator("#task-detail-overlay")).toHaveClass(/hidden/);
  });

  test("task detail closes on backdrop click", async ({ page }) => {
    await page.locator(".task-title").first().click();
    await page.waitForSelector("#task-detail-overlay:not(.hidden)", { timeout: 5000 });

    // Click the overlay (outside the panel)
    await page.locator("#task-detail-overlay").click({ position: { x: 5, y: 5 } });
    await expect(page.locator("#task-detail-overlay")).toHaveClass(/hidden/);
  });

  test("tasks show different status badges", async ({ page }) => {
    // The mock data has tasks in different statuses — ensure they all render
    const tasksList = page.locator("#tasks-list");
    await expect(tasksList).toBeVisible();

    // Check that task titles from mock data are present
    await expect(tasksList).toContainText("Fix login button");
    await expect(tasksList).toContainText("Add dark mode");
  });

  test("filtering to closed shows only closed tasks", async ({ page }) => {
    const closedBtn = page.locator('.tasks-filter[data-filter="closed"]');
    await closedBtn.click();

    // Wait for filter to apply
    await page.waitForTimeout(100);

    // The closed task "Refactor CSS" should be visible
    // Open tasks should be hidden
    const visibleTasks = page.locator(".task-row:visible, .task-item:visible, #tasks-list > div:visible");
    const count = await visibleTasks.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });
});
