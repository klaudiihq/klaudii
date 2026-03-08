const { test, expect } = require("@playwright/test");

test.describe("New Session Modal", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".card", { timeout: 5000 });
  });

  test("modal opens on button click", async ({ page }) => {
    const modal = page.locator("#new-session-modal");
    await expect(modal).toHaveClass(/hidden/);

    await page.click('button:has-text("+ New Workspace")');
    await expect(modal).not.toHaveClass(/hidden/);
  });

  test("modal shows repo list", async ({ page }) => {
    await page.click('button:has-text("+ New Workspace")');

    // Wait for repos to load
    await page.waitForSelector("#repo-list .repo-item, #repo-list div", { timeout: 5000 });
    const repoList = page.locator("#repo-list");
    await expect(repoList).toBeVisible();
  });

  test("modal closes on X button", async ({ page }) => {
    await page.click('button:has-text("+ New Workspace")');
    const modal = page.locator("#new-session-modal");
    await expect(modal).not.toHaveClass(/hidden/);

    await page.click('#new-session-modal .modal-header button:has-text("X")');
    await expect(modal).toHaveClass(/hidden/);
  });

  test("modal closes on backdrop click", async ({ page }) => {
    await page.click('button:has-text("+ New Workspace")');
    const modal = page.locator("#new-session-modal");
    await expect(modal).not.toHaveClass(/hidden/);

    // Click the overlay (outside the modal content)
    await modal.click({ position: { x: 5, y: 5 } });
    await expect(modal).toHaveClass(/hidden/);
  });

  test("repo search filters the list", async ({ page }) => {
    await page.click('button:has-text("+ New Workspace")');

    // Wait for repo list to render
    await page.waitForFunction(() => {
      const el = document.getElementById("repo-list");
      return el && el.children.length > 0 && !el.textContent.includes("Loading");
    }, { timeout: 5000 });

    const searchInput = page.locator("#repo-search");
    await searchInput.fill("nova");

    // After filtering, should show fewer results
    await page.waitForFunction(() => {
      const el = document.getElementById("repo-list");
      return el && el.textContent.includes("nova");
    });
  });

  test("branch form appears after selecting a repo", async ({ page }) => {
    await page.click('button:has-text("+ New Workspace")');

    // Wait for repos to load
    await page.waitForFunction(() => {
      const el = document.getElementById("repo-list");
      return el && el.children.length > 0 && !el.textContent.includes("Loading");
    }, { timeout: 5000 });

    const branchForm = page.locator("#branch-form");
    await expect(branchForm).toHaveClass(/hidden/);

    // Click on the first repo item
    await page.locator("#repo-list").locator("div").first().click();

    // Branch form should appear
    await expect(branchForm).not.toHaveClass(/hidden/);
    await expect(page.locator("#branch-input")).toBeVisible();
  });

  test("create new repo form toggle", async ({ page }) => {
    await page.click('button:has-text("+ New Workspace")');

    const repoSearchView = page.locator("#repo-search-view");
    const createRepoView = page.locator("#create-repo-view");

    await expect(repoSearchView).toBeVisible();
    await expect(createRepoView).toHaveClass(/hidden/);

    // Click "Create new repo"
    await page.click('button:has-text("+ Create new repo")');
    await expect(createRepoView).not.toHaveClass(/hidden/);

    // Click "Back" to return
    await page.click('#create-repo-view button:has-text("Back")');
    await expect(createRepoView).toHaveClass(/hidden/);
  });
});

test.describe("Scheduler Section", () => {
  test("scheduler section is visible with tasks", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#scheduler-section:not(.hidden)", { timeout: 5000 });

    const section = page.locator("#scheduler-section");
    await expect(section).toBeVisible();
    await expect(section.locator(".scheduler-heading")).toContainText("Scheduler");
  });
});
