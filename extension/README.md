# Klaudii Chrome Extension

Manage your [Klaudii](https://github.com/klaudiihq/klaudii) Claude Code sessions from Chrome's side panel — switch between sessions in the adjacent tab with one click, and let it automatically rename the claude.ai conversation to match your repo and branch.

## Installation

> **Requires:** Chrome 114+ · A running [Klaudii](https://github.com/klaudiihq/klaudii) instance

**1. Download the extension**

👉 **[Download klaudii-extension.zip](https://github.com/klaudiihq/klaudii/releases/latest/download/klaudii-extension.zip)**

This link always points to the latest build.

**2. Unzip it** somewhere permanent (e.g. `~/klaudii-extension/`). Don't delete the folder after installing.

**3. Load in Chrome**

1. Go to `chrome://extensions`
2. Enable **Developer mode** (toggle, top-right)
3. Click **Load unpacked**
4. Select the unzipped folder

**4. Open the side panel**

Click the **Klaudii** toolbar icon (or open the side panel from Chrome's View menu). The extension defaults to `http://localhost:9876` — change it in **Settings** if your Klaudii instance runs elsewhere.

## What it does

- **Session cards** — shows all configured workspaces with running/stopped status, git branch, dirty file count, unpushed commits, and process CPU/memory
- **One-click switching** — "Open" navigates the current tab to that session's claude.ai URL (no new tab)
- **Auto-rename** — renames the claude.ai conversation to `repo (branch)` format after opening, so your browser tabs stay readable. Skips rename if you've already given the session a custom name.
- **Session history** — browse and resume past sessions per workspace
- **Terminal** — open ttyd terminal sessions in a new tab when available
- **Start / Stop / Restart** — control sessions directly from the panel

## Updating

When a new version is released, download the zip again and replace the contents of your install folder, then click the reload button on `chrome://extensions`.
