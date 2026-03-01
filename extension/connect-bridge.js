// Content script running on konnect.klaudii.com pages.
// Reads the E2E connection keys from localStorage and forwards them to the
// extension's background service worker so the side panel can establish
// encrypted WebSocket tunnels to paired Klaudii servers.

function sendKeys() {
  try {
    const raw = localStorage.getItem("klaudii-connection-keys");
    if (!raw) return;
    const keys = JSON.parse(raw);
    if (keys && typeof keys === "object") {
      chrome.runtime.sendMessage({ action: "storeConnectionKeys", keys }).catch(() => {});
    }
  } catch {}
}

// Send on initial page load
sendKeys();

// Re-send whenever localStorage is updated (e.g. after pairing a new server)
window.addEventListener("storage", (e) => {
  if (e.key === "klaudii-connection-keys") sendKeys();
});
