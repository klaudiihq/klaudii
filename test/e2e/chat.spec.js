const { test, expect } = require("@playwright/test");

// Helper: click inside a card on a non-interactive element to trigger workspace open.
// The click handler ignores clicks on buttons, links, selects, inputs, and action panels.
async function clickCard(page, cardId) {
  await page.locator(`#${cardId} .card-status`).click();
}

test.describe("Chat Overlay", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".card", { timeout: 5000 });
  });

  test("clicking a workspace card opens the chat overlay", async ({ page }) => {
    const overlay = page.locator("#gemini-overlay");
    await expect(overlay).toHaveClass(/hidden/);

    await clickCard(page, "card-nova-frontend");

    await expect(overlay).not.toHaveClass(/hidden/);
  });

  test("chat overlay shows workspace name in title bar", async ({ page }) => {
    await clickCard(page, "card-nova-frontend");
    await page.waitForSelector("#gemini-overlay:not(.hidden)", { timeout: 5000 });

    const title = page.locator("#gemini-title");
    await expect(title).toContainText("nova-frontend");
  });

  test("chat input textarea is visible and focusable", async ({ page }) => {
    await clickCard(page, "card-nova-frontend");
    await page.waitForSelector("#gemini-overlay:not(.hidden)", { timeout: 5000 });

    const input = page.locator("#gemini-input");
    await expect(input).toBeVisible();
    await input.fill("Hello test message");
    await expect(input).toHaveValue("Hello test message");
  });

  test("send button is visible in chat overlay", async ({ page }) => {
    await clickCard(page, "card-nova-frontend");
    await page.waitForSelector("#gemini-overlay:not(.hidden)", { timeout: 5000 });

    const sendBtn = page.locator("#gemini-send");
    await expect(sendBtn).toBeVisible();
  });

  test("sending a message renders user bubble and gets response", async ({ page }) => {
    await clickCard(page, "card-nova-frontend");
    await page.waitForSelector("#gemini-overlay:not(.hidden)", { timeout: 5000 });

    // Wait for WebSocket to connect
    await page.waitForFunction(() => {
      return typeof geminiWs !== "undefined" && geminiWs && geminiWs.readyState === WebSocket.OPEN;
    }, { timeout: 5000 });

    // Type and send a message
    await page.fill("#gemini-input", "Test message from E2E");
    await page.click("#gemini-send");

    // User bubble should appear
    await page.waitForFunction(() => {
      const msgs = document.getElementById("gemini-messages");
      return msgs && msgs.textContent.includes("Test message from E2E");
    }, { timeout: 5000 });

    // Wait for mock assistant response
    await page.waitForFunction(() => {
      const msgs = document.getElementById("gemini-messages");
      return msgs && msgs.textContent.includes("Mock response to: Test message from E2E");
    }, { timeout: 5000 });
  });

  test("sending a message renders tool use indicator", async ({ page }) => {
    await clickCard(page, "card-nova-frontend");
    await page.waitForSelector("#gemini-overlay:not(.hidden)", { timeout: 5000 });

    await page.waitForFunction(() => {
      return typeof geminiWs !== "undefined" && geminiWs && geminiWs.readyState === WebSocket.OPEN;
    }, { timeout: 5000 });

    await page.fill("#gemini-input", "Show me a file");
    await page.click("#gemini-send");

    // Tool use event should render something in the messages area (pill or tool indicator)
    await page.waitForFunction(() => {
      const msgs = document.getElementById("gemini-messages");
      return msgs && msgs.querySelectorAll("[class*='tool']").length > 0;
    }, { timeout: 5000 });
  });

  test("close button hides the chat overlay", async ({ page }) => {
    await clickCard(page, "card-nova-frontend");
    await page.waitForSelector("#gemini-overlay:not(.hidden)", { timeout: 5000 });

    await page.click('#gemini-overlay button:has-text("Close")');
    await expect(page.locator("#gemini-overlay")).toHaveClass(/hidden/);
  });

  test("new chat button is visible", async ({ page }) => {
    await clickCard(page, "card-nova-frontend");
    await page.waitForSelector("#gemini-overlay:not(.hidden)", { timeout: 5000 });

    const newChatBtn = page.locator('#gemini-overlay button:has-text("New Chat")');
    await expect(newChatBtn).toBeVisible();
  });
});
