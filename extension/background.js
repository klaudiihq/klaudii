// Open side panel when extension icon is clicked
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Per-tab approval state populated by content.js
const tabApprovalState = new Map();
chrome.tabs.onRemoved.addListener((tabId) => { tabApprovalState.delete(tabId); });

// Handle messages from the side panel and content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Content script: approval button appeared
  if (message.action === "approvalDetected") {
    if (sender.tab?.id) tabApprovalState.set(sender.tab.id, true);
    chrome.runtime.sendMessage({ action: "approvalStateChanged" }).catch(() => {});
    return;
  }

  // Content script: approval button went away
  if (message.action === "approvalCleared") {
    if (sender.tab?.id) tabApprovalState.set(sender.tab.id, false);
    chrome.runtime.sendMessage({ action: "approvalStateChanged" }).catch(() => {});
    return;
  }

  // Side panel: fetch current approval states
  if (message.action === "getApprovalStates") {
    sendResponse(Object.fromEntries(tabApprovalState));
    return true;
  }
  // Navigate the active tab and rename the claude.ai conversation
  if (message.action === "navigateAndRename") {
    navigateAndRename(message.url, message.title, message.needsInput).then(sendResponse);
    return true;
  }

  // Switch to an existing tab for this URL, or open a new one
  if (message.action === "switchTab") {
    switchTab(message.url, message.title, message.windowId, message.needsInput).then(sendResponse);
    return true;
  }

  // Navigate the active tab in-place (no rename)
  if (message.action === "navigateTab") {
    navigateActiveTab(message.url).then(sendResponse);
    return true;
  }

  // Open a URL in a new tab (used for terminal, etc.)
  if (message.action === "openUrl") {
    chrome.tabs.create({ url: message.url }).then(sendResponse);
    return true;
  }

  // Reuse an existing tab at this URL origin, or open a new one
  if (message.action === "switchToUrl") {
    switchToUrl(message.url, message.windowId).then(sendResponse);
    return true;
  }

  if (message.action === "getActiveTabUrl") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      sendResponse({ url: tabs[0]?.url || null });
    });
    return true;
  }

  // connect-bridge.js: store E2E connection keys read from konnect.klaudii.com localStorage
  if (message.action === "storeConnectionKeys") {
    chrome.storage.local.get("konnectConnectionKeys", (existing) => {
      const merged = { ...(existing.konnectConnectionKeys || {}), ...message.keys };
      chrome.storage.local.set({ konnectConnectionKeys: merged });
    });
    return;
  }

  // Side panel: open konnect.klaudii.com briefly, use executeScript to
  // read connection keys and fetch user/server data from the page context.
  if (message.action === "fetchConnectionKeys") {
    fetchKonnectAll().then((result) => sendResponse(result.keys));
    return true;
  }

  // Side panel: fetch all Konnect data (user, servers, keys)
  if (message.action === "fetchKonnectData") {
    fetchKonnectAll().then(sendResponse);
    return true;
  }
});

// Navigate the current active tab to a URL
async function navigateActiveTab(url) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    await chrome.tabs.update(tab.id, { url });
    return { tabId: tab.id };
  }
  const newTab = await chrome.tabs.create({ url });
  return { tabId: newTab.id };
}

// Navigate the active tab to a claude.ai URL, then rename the conversation
async function navigateAndRename(url, title, needsInput) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // If tab is already at this URL (same path, ignore query params), skip navigation
  const alreadyThere = tab?.url && tab.url.split("?")[0] === url.split("?")[0];
  let targetTab;

  if (alreadyThere) {
    targetTab = tab;
  } else {
    targetTab = tab
      ? await chrome.tabs.update(tab.id, { url })
      : await chrome.tabs.create({ url });

    await waitForTabLoad(targetTab.id);
    // Extra pause for React to fully initialize
    await new Promise((r) => setTimeout(r, 3000));
  }

  if (!title) return { tabId: targetTab.id };

  const sessionId = new URL(url).pathname.split("/").filter(Boolean).pop();
  if (!sessionId) return { tabId: targetTab.id };

  if (!needsInput) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: targetTab.id },
        func: renameConversationInPage,
        args: [sessionId, title],
        world: "MAIN",
      });
    } catch (err) {
      console.warn("Klaudii: rename script injection failed", err);
    }
  }

  return { tabId: targetTab.id };
}

// Switch to an existing tab already at the URL, or open a new one.
// Scoped to windowId so we stay in the same window as the side panel.
async function switchTab(url, title, windowId, needsInput) {
  const urlPath = url.split("?")[0];

  // Look for a tab in this window already at this URL — use startsWith because
  // claude.ai often appends /chat/... segments to the base project URL
  const queryOpts = { url: "https://claude.ai/*" };
  if (windowId) queryOpts.windowId = windowId;
  const candidates = await chrome.tabs.query(queryOpts);
  const existing = candidates.find((t) => t.url && t.url.startsWith(urlPath));

  let targetTab;
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    targetTab = existing;
  } else {
    const createOpts = { url };
    if (windowId) createOpts.windowId = windowId;
    targetTab = await chrome.tabs.create(createOpts);
    await waitForTabLoad(targetTab.id);
    await new Promise((r) => setTimeout(r, 3000));
  }

  if (!title) return { tabId: targetTab.id };

  const sessionId = new URL(url).pathname.split("/").filter(Boolean).pop();
  if (!sessionId) return { tabId: targetTab.id };

  if (!needsInput) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: targetTab.id },
        func: renameConversationInPage,
        args: [sessionId, title],
        world: "MAIN",
      });
    } catch (err) {
      console.warn("Klaudii: rename script injection failed", err);
    }
  }

  return { tabId: targetTab.id };
}

// Switch to an existing tab whose URL starts with the given URL, or open a new one.
async function switchToUrl(url, windowId) {
  const origin = new URL(url).origin;
  const queryOpts = { url: `${origin}/*` };
  if (windowId) queryOpts.windowId = windowId;
  const candidates = await chrome.tabs.query(queryOpts);
  if (candidates.length) {
    await chrome.tabs.update(candidates[0].id, { active: true });
    return { tabId: candidates[0].id };
  }
  const createOpts = { url };
  if (windowId) createOpts.windowId = windowId;
  const tab = await chrome.tabs.create(createOpts);
  return { tabId: tab.id };
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    let seenLoading = false;

    function listener(id, changeInfo) {
      if (id !== tabId) return;
      if (changeInfo.status === "loading") seenLoading = true;
      if (changeInfo.status === "complete" && seenLoading) {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);

    // Don't wait forever
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 15000);
  });
}

// Open konnect.klaudii.com in a background tab, then use executeScript in
// the page's MAIN world to read connection keys from localStorage and fetch
// user/server data (page-context fetch includes session cookies).
// Returns { keys, user, servers }.
// Deduplicates concurrent calls so only one tab is opened at a time.
let _fetchKonnectPromise = null;

function fetchKonnectAll() {
  if (_fetchKonnectPromise) return _fetchKonnectPromise;
  _fetchKonnectPromise = _doFetchKonnectAll().finally(() => { _fetchKonnectPromise = null; });
  return _fetchKonnectPromise;
}

async function _doFetchKonnectAll() {
  let tab;
  try {
    tab = await chrome.tabs.create({ url: "https://konnect.klaudii.com/", active: false });
    await waitForTabLoad(tab.id);
  } catch (err) {
    console.warn("[Klaudii] Failed to open Konnect tab:", err);
    return { keys: {}, user: null, servers: [] };
  }

  let keys = {};
  let user = null;
  let servers = [];

  try {
    // Read connection keys from the page's localStorage (MAIN world)
    const [keysResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: () => {
        try {
          const raw = localStorage.getItem("klaudii-connection-keys");
          return raw ? JSON.parse(raw) : {};
        } catch { return {}; }
      },
    });
    if (keysResult?.result && typeof keysResult.result === "object") {
      keys = keysResult.result;
    }
  } catch (err) {
    console.warn("[Klaudii] Failed to read connection keys:", err);
  }

  try {
    // Fetch user info and server list from the page context (cookies included)
    const [dataResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: async () => {
        try {
          const meRes = await fetch("/auth/me");
          if (!meRes.ok) return { user: null, servers: [] };
          const user = await meRes.json();
          const serversRes = await fetch("/api/servers");
          const servers = serversRes.ok ? await serversRes.json() : [];
          return { user, servers };
        } catch { return { user: null, servers: [] }; }
      },
    });
    if (dataResult?.result) {
      user = dataResult.result.user;
      servers = dataResult.result.servers || [];
    }
  } catch (err) {
    console.warn("[Klaudii] Failed to fetch Konnect data:", err);
  }

  chrome.tabs.remove(tab.id).catch(() => {});

  // Persist to storage so the side panel can read cached data on next open
  if (Object.keys(keys).length > 0) {
    const existing = await chrome.storage.local.get("konnectConnectionKeys");
    const merged = { ...(existing.konnectConnectionKeys || {}), ...keys };
    chrome.storage.local.set({ konnectConnectionKeys: merged });
  }
  // Only cache user/server data if we got a valid user — avoids caching
  // "not logged in" state which would prevent fresh fetches on next open
  if (user) {
    chrome.storage.local.set({ konnectUser: user, konnectServers: servers });
  } else {
    chrome.storage.local.remove(["konnectUser", "konnectServers"]);
  }

  return { keys, user, servers };
}

// This function is injected into the claude.ai page context (MAIN world).
// IMPORTANT: it must be entirely self-contained — chrome.scripting.executeScript
// only serializes THIS function, not any helpers defined outside it.
//
// Simulates the claude.ai rename UI flow:
//   1. Find & pointer-click the dropdown trigger (Radix requires pointerdown, not just click)
//   2. Poll for [role="menuitem"] to appear, click "Rename"
//   3. Poll for the rename input, set new value, confirm with Enter
//
// If the current session title is already custom (not "Remote Control session"),
// the rename is skipped to avoid overwriting the user's own name.
function renameConversationInPage(sessionId, newTitle) {
  // Simulate a full pointer interaction — Radix UI listens to pointerdown, not click
  function pointerClick(el) {
    var opts = { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1 };
    el.dispatchEvent(new PointerEvent("pointerover", opts));
    el.dispatchEvent(new MouseEvent("mouseover", opts));
    el.dispatchEvent(new PointerEvent("pointerenter", opts));
    el.dispatchEvent(new MouseEvent("mouseenter", opts));
    el.dispatchEvent(new PointerEvent("pointermove", opts));
    el.dispatchEvent(new MouseEvent("mousemove", opts));
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new FocusEvent("focus", { bubbles: false }));
    el.dispatchEvent(new PointerEvent("pointerup", { ...opts, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("mouseup", { ...opts, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("click", { ...opts, buttons: 0 }));
  }

  // --- Step 1: Find and click the conversation dropdown trigger ---
  var triggerAttempts = 0;
  var triggerIndex = 0;
  var allTriggers = [];

  function step1_openDropdown() {
    triggerAttempts++;

    allTriggers = Array.from(document.querySelectorAll(
      'button[aria-haspopup="menu"], [data-radix-dropdown-menu-trigger]'
    ));

    if (!allTriggers.length) {
      if (triggerAttempts < 30) {
        setTimeout(step1_openDropdown, 500);
        return;
      }
      console.warn("Klaudii: dropdown trigger never found");
      return;
    }

    if (triggerIndex >= allTriggers.length) {
      console.warn("Klaudii: tried all triggers, none had a Rename menu item");
      return;
    }

    pointerClick(allTriggers[triggerIndex]);
    menuAttempts = 0;
    setTimeout(step2_clickRename, 100);
  }

  // --- Step 2: Poll for the menu to open, then click "Rename" ---
  var menuAttempts = 0;

  function step2_clickRename() {
    menuAttempts++;

    var menuItems = document.querySelectorAll('[role="menuitem"]');

    if (!menuItems.length) {
      if (menuAttempts < 20) {
        setTimeout(step2_clickRename, 100);
        return;
      }
      // This trigger didn't open a menu with items — try the next one
      triggerIndex++;
      triggerAttempts = 0;
      setTimeout(step1_openDropdown, 200);
      return;
    }

    var renameItem = null;
    for (var i = 0; i < menuItems.length; i++) {
      if (menuItems[i].textContent.trim() === "Rename") {
        renameItem = menuItems[i];
        break;
      }
    }

    if (!renameItem) {
      // Wrong menu — close it and try next trigger
      document.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape", code: "Escape", keyCode: 27, bubbles: true,
      }));
      triggerIndex++;
      triggerAttempts = 0;
      setTimeout(step1_openDropdown, 300);
      return;
    }

    pointerClick(renameItem);
    inputAttempts = 0;
    setTimeout(step3_editInput, 100);
  }

  // --- Step 3: Poll for the rename input, set value, confirm ---
  var inputAttempts = 0;

  function step3_editInput() {
    inputAttempts++;

    var input =
      document.querySelector('input[maxlength="200"][type="text"]') ||
      document.querySelector('input[type="text"]');

    if (!input) {
      if (inputAttempts < 15) {
        setTimeout(step3_editInput, 200);
        return;
      }
      console.warn("Klaudii: rename input never appeared");
      return;
    }

    var currentVal = input.value.trim();

    // Respect user's custom title — only rename if it's the default
    if (currentVal && currentVal !== "Remote Control session" && currentVal !== newTitle) {
      input.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape", code: "Escape", keyCode: 27, bubbles: true,
      }));
      return;
    }

    // Already the right name — just cancel and sync the tab title
    if (currentVal === newTitle) {
      input.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape", code: "Escape", keyCode: 27, bubbles: true,
      }));
      document.title = newTitle + " \\ Claude";
      return;
    }

    // Set the new value via React-compatible native setter
    var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, newTitle);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));

    // Confirm with Enter, then blur as backup
    setTimeout(function() {
      input.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true,
      }));
      setTimeout(function() {
        input.dispatchEvent(new Event("blur", { bubbles: true }));
        input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      }, 100);

      // Update the browser tab title and keep it persistent against React overwrites
      var fullTitle = newTitle + " \\ Claude";
      document.title = fullTitle;
      var titleTag = document.querySelector("title");
      if (titleTag) {
        var obs = new MutationObserver(function() {
          if (document.title !== fullTitle) document.title = fullTitle;
        });
        obs.observe(titleTag, { childList: true, characterData: true, subtree: true });
        setTimeout(function() { obs.disconnect(); }, 30000);
      }
    }, 100);
  }

  // Kick off the flow
  step1_openDropdown();
}
