// lib/paths.js — Path resolver for Klaudii data directories.
//
// Config file location is the single source of truth:
//   1. KLAUDII_CONFIG env var (set by launchd/systemd unit — must be absolute)
//   2. ~/.klaudii/config.json (default for interactive use)
//
// Directory layout under ~/.klaudii/:
//   config.json   — configuration
//   app/          — server runtime artifacts
//     logs/       — server logs (overridable via logsDir)
//     relay/      — relay daemon sockets + logs (overridable via relayDir)
//   data/         — persistent user data (overridable via dataDir in config)
//     chats/      — chat history (overridable via chatsDir)
//     tasks.db    — task tracker
//     memory.db   — semantic memory
//   repos/        — git repos (overridable via reposDir in config)
//
// Executable paths can also be set in config.json for non-standard installs:
//   claudePath, geminiPath, tmuxPath, ttydPath
// If not set, each binary is resolved via PATH at runtime.
//
// setup.sh writes all of these explicitly at install time so the user
// can see and change them without digging through source code.

const fs = require("fs");
const path = require("path");
const os = require("os");

const CONFIG_PATH =
  process.env.KLAUDII_CONFIG ||
  path.join(os.homedir(), ".klaudii", "config.json");

// Read config (fail silently — file may not exist yet during first-run setup)
let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
} catch {}

const KLAUDII_DIR = path.dirname(CONFIG_PATH); // ~/.klaudii/
const APP_DIR = path.join(KLAUDII_DIR, "app");
const DATA_DIR = cfg.dataDir || path.join(KLAUDII_DIR, "data");
const REPOS_DIR = cfg.reposDir || path.join(KLAUDII_DIR, "repos");
const LOGS_DIR = cfg.logsDir || path.join(APP_DIR, "logs");
const RELAY_DIR = cfg.relayDir || path.join(APP_DIR, "relay");
const CHATS_DIR = cfg.chatsDir || path.join(DATA_DIR, "chats");

// CONFIG_DIR is an alias for KLAUDII_DIR (backwards compat)
const CONFIG_DIR = KLAUDII_DIR;

module.exports = { CONFIG_PATH, KLAUDII_DIR, CONFIG_DIR, APP_DIR, DATA_DIR, REPOS_DIR, LOGS_DIR, RELAY_DIR, CHATS_DIR };
