const DEFAULT_URL = "http://localhost:9876";
const input = document.getElementById("url-input");
const statusEl = document.getElementById("status");

// Load saved URL
chrome.storage.sync.get(["klaudiiUrl"], (config) => {
  input.value = config.klaudiiUrl || DEFAULT_URL;
});

// Save
document.getElementById("btn-save").addEventListener("click", () => {
  const url = input.value.trim().replace(/\/+$/, "") || DEFAULT_URL;
  input.value = url;
  chrome.storage.sync.set({ klaudiiUrl: url }, () => {
    statusEl.textContent = "Saved.";
    statusEl.className = "status-ok";
    setTimeout(() => { statusEl.textContent = ""; }, 2000);
  });
});

// Test connection
document.getElementById("btn-test").addEventListener("click", async () => {
  const url = input.value.trim().replace(/\/+$/, "") || DEFAULT_URL;
  statusEl.textContent = "Testing...";
  statusEl.className = "";

  try {
    const res = await fetch(url + "/api/health");
    const data = await res.json();

    if (data.ok) {
      const parts = [];
      if (data.tmux) parts.push("tmux");
      if (data.ttyd) parts.push("ttyd");
      statusEl.textContent = `Connected. Available: ${parts.join(", ") || "none"}`;
      statusEl.className = "status-ok";
    } else {
      statusEl.textContent = "Server responded but health check failed.";
      statusEl.className = "status-err";
    }
  } catch {
    statusEl.textContent = "Cannot reach Klaudii at that URL.";
    statusEl.className = "status-err";
  }
});

// Save on Enter
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("btn-save").click();
});
