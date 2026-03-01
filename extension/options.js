const DEFAULT_URL = "http://localhost:9876";
const textarea = document.getElementById("url-input");
const statusEl = document.getElementById("status");

// Parse textarea → clean array of URLs
function parseUrls(text) {
  return text.split("\n")
    .map((u) => u.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

// Load saved settings (migrate legacy single klaudiiUrl if needed)
chrome.storage.sync.get(["klaudiiUrl", "klaudiiUrls", "openMode", "attentionFlash"], (config) => {
  let urls = config.klaudiiUrls;
  if (!urls || !urls.length) {
    urls = [config.klaudiiUrl || DEFAULT_URL];
  }
  textarea.value = urls.join("\n");

  const mode = config.openMode || "inplace";
  const radio = document.querySelector(`input[name="openMode"][value="${mode}"]`);
  if (radio) radio.checked = true;
  document.getElementById("attention-flash").checked = config.attentionFlash === true;
});

// Save
document.getElementById("btn-save").addEventListener("click", () => {
  const urls = parseUrls(textarea.value);
  if (!urls.length) urls.push(DEFAULT_URL);
  textarea.value = urls.join("\n");

  const openMode = document.querySelector('input[name="openMode"]:checked')?.value || "inplace";
  const attentionFlash = document.getElementById("attention-flash").checked;

  // Save both klaudiiUrls (new) and klaudiiUrl (legacy compat for first entry)
  chrome.storage.sync.set({ klaudiiUrls: urls, klaudiiUrl: urls[0], openMode, attentionFlash }, () => {
    statusEl.textContent = "Saved.";
    statusEl.className = "status-ok";
    setTimeout(() => { statusEl.textContent = ""; }, 2000);
  });
});

// Test connection — tests all configured URLs
document.getElementById("btn-test").addEventListener("click", async () => {
  const urls = parseUrls(textarea.value);
  if (!urls.length) urls.push(DEFAULT_URL);

  statusEl.textContent = `Testing ${urls.length} server(s)...`;
  statusEl.className = "";

  const results = await Promise.allSettled(
    urls.map(async (url) => {
      const res = await fetch(url + "/api/health");
      const data = await res.json();
      if (!data.ok) throw new Error("health check failed");
      return { url, data };
    })
  );

  const ok = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  const fail = results.filter((r) => r.status === "rejected");

  if (ok.length === urls.length) {
    const details = ok.map(({ url, data }) => {
      const parts = [data.tmux && "tmux", data.ttyd && "ttyd"].filter(Boolean).join(", ");
      return `${url} ✓${parts ? ` (${parts})` : ""}`;
    }).join("; ");
    statusEl.textContent = `All connected. ${details}`;
    statusEl.className = "status-ok";
  } else if (ok.length > 0) {
    statusEl.textContent = `${ok.length}/${urls.length} reachable. ${fail.length} failed.`;
    statusEl.className = "status-err";
  } else {
    statusEl.textContent = "Cannot reach any Klaudii server.";
    statusEl.className = "status-err";
  }
});
