// Persistent content script running on claude.ai pages.
// Watches for approval buttons ("Allow …" or "Skip") using a MutationObserver
// and reports state changes to the background service worker immediately.

function needsApproval() {
  return Array.from(document.querySelectorAll("button")).some((b) => {
    const text = b.textContent.trim();
    return text.includes("Allow") || text === "Skip";
  });
}

let lastState = false;

function update() {
  const current = needsApproval();
  if (current !== lastState) {
    lastState = current;
    chrome.runtime.sendMessage({
      action: current ? "approvalDetected" : "approvalCleared",
    }).catch(() => {});
  }
}

// Run once on load in case the page is already showing an approval dialog
update();

// Watch for DOM mutations and re-check with a short debounce
let debounce;
const observer = new MutationObserver(() => {
  clearTimeout(debounce);
  debounce = setTimeout(update, 150);
});

observer.observe(document.body, { childList: true, subtree: true });
