const { test, expect } = require("@playwright/test");

// Click inside a card on a non-interactive element to trigger workspace open.
async function clickCard(page, cardId) {
  await page.locator(`#${cardId} .card-status`).click();
}

test.describe("Workspace Switching", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".card", { timeout: 5000 });
  });

  test("clicking a card highlights it as active workspace", async ({ page }) => {
    const novaCard = page.locator("#card-nova-frontend");

    await clickCard(page, "card-nova-frontend");

    await expect(novaCard).toHaveClass(/active-workspace/);
  });

  test("switching workspace changes active card", async ({ page }) => {
    // Click nova-frontend
    await clickCard(page, "card-nova-frontend");
    await expect(page.locator("#card-nova-frontend")).toHaveClass(/active-workspace/);

    // Click aurora-api (chat overlay stays open, card switch happens)
    await clickCard(page, "card-aurora-api");
    await expect(page.locator("#card-aurora-api")).toHaveClass(/active-workspace/);

    // Previous card should no longer be active
    await expect(page.locator("#card-nova-frontend")).not.toHaveClass(/active-workspace/);
  });

  test("switching workspace updates chat title", async ({ page }) => {
    // Open nova-frontend
    await clickCard(page, "card-nova-frontend");
    await page.waitForSelector("#gemini-overlay:not(.hidden)", { timeout: 5000 });
    await expect(page.locator("#gemini-title")).toContainText("nova-frontend");

    // Switch to aurora-api
    await clickCard(page, "card-aurora-api");

    // Title should update
    await expect(page.locator("#gemini-title")).toContainText("aurora-api");
  });
});

test.describe("Workspace Actions", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".card", { timeout: 5000 });
  });

  test("start button works on a stopped workspace", async ({ page }) => {
    const stellarCard = page.locator("#card-stellar-ml");
    const panel = stellarCard.locator(".card-actions-panel");

    // Open action panel
    await stellarCard.locator(".card-edit-btn").click();
    await expect(panel).not.toHaveClass(/hidden/);

    // Should show action buttons for stopped session
    const actionBtns = panel.locator("button");
    await expect(actionBtns.first()).toBeVisible();
  });

  test("stop button is available on running workspace action panel", async ({ page }) => {
    const novaCard = page.locator("#card-nova-frontend");
    await novaCard.locator(".card-edit-btn").click();

    const stopBtn = novaCard.locator('.card-actions-panel button:has-text("Stop")');
    await expect(stopBtn).toBeVisible();
  });

  test("history toggle shows history section", async ({ page }) => {
    const novaCard = page.locator("#card-nova-frontend");
    await novaCard.locator(".card-edit-btn").click();

    const historyBtn = novaCard.locator('.card-actions-panel button:has-text("History")');
    await expect(historyBtn).toBeVisible();

    await historyBtn.click();
    const historyContainer = page.locator("#history-nova-frontend");
    await expect(historyContainer).not.toHaveClass(/hidden/);
  });

  test("chat mode pill is clickable and cycles modes", async ({ page }) => {
    const novaPill = page.locator("#card-nova-frontend .chat-mode-pill");
    await expect(novaPill).toBeVisible();

    const initialText = await novaPill.textContent();

    // Click to cycle
    await novaPill.click();

    // Mode should have changed
    const newText = await novaPill.textContent();
    expect(newText).not.toBe(initialText);
  });

  test("git dirty files badge is visible on card with changes", async ({ page }) => {
    const auroraCard = page.locator("#card-aurora-api");
    const dirtyBadge = auroraCard.locator(".git-dirty");
    await expect(dirtyBadge).toBeVisible();
    await expect(dirtyBadge).toContainText("3 files touched");
  });
});
