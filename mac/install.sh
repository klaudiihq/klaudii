#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PLIST_NAME="com.klaudii.plist"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
SKIP_MENUBAR=false

for arg in "$@"; do
  case "$arg" in
    --skip-menu-bar-icon) SKIP_MENUBAR=true ;;
  esac
done

echo "=== Klaudii Session Manager — Install (macOS) ==="
echo ""

# --- Prerequisites ---

echo "Checking prerequisites..."
MISSING=()

# Node.js
if command -v node &>/dev/null; then
  echo "  node: $(node --version)"
else
  MISSING+=("node")
  echo "  node: NOT FOUND"
fi

# Homebrew (needed to install tmux/ttyd)
if command -v brew &>/dev/null; then
  echo "  brew: OK"
else
  echo "  brew: NOT FOUND"
  echo ""
  echo "Homebrew is required to install dependencies."
  echo "Install it from https://brew.sh"
  exit 1
fi

# tmux
if command -v tmux &>/dev/null; then
  echo "  tmux: OK"
else
  echo "  tmux: not found, installing..."
  brew install tmux
fi

# ttyd
if command -v ttyd &>/dev/null; then
  echo "  ttyd: OK"
else
  echo "  ttyd: not found, installing..."
  brew install ttyd
fi

# Xcode Command Line Tools (needed for swiftc / menu bar app)
if ! $SKIP_MENUBAR; then
  if xcode-select -p &>/dev/null; then
    echo "  xcode CLI tools: OK"
  else
    echo ""
    echo "  Xcode Command Line Tools are not installed."
    echo "  These are needed to compile the menu bar icon."
    echo ""
    echo "  Options:"
    echo "    1) Install them:  xcode-select --install"
    echo "    2) Skip the icon: ./mac/install.sh --skip-menu-bar-icon"
    echo ""
    exit 1
  fi
fi

# Claude CLI
if command -v claude &>/dev/null; then
  echo "  claude: OK"
else
  echo "  claude: NOT FOUND"
  MISSING+=("claude")
fi

if [ ${#MISSING[@]} -gt 0 ]; then
  echo ""
  echo "Missing required tools: ${MISSING[*]}"
  [ " ${MISSING[*]} " =~ " node " ] && echo "  Install Node.js: https://nodejs.org or brew install node"
  [ " ${MISSING[*]} " =~ " claude " ] && echo "  Install Claude Code: npm install -g @anthropic-ai/claude-code"
  exit 1
fi

# --- npm install ---

echo ""
echo "Installing npm dependencies..."
cd "$PROJECT_DIR"
npm install

# --- config.json ---

if [ ! -f "$PROJECT_DIR/config.json" ]; then
  echo ""
  echo "Creating config.json..."

  # Try to find a reasonable repos directory
  REPOS_DIR=""
  for candidate in "$HOME/repos" "$HOME/Projects" "$HOME/src" "$HOME/code"; do
    if [ -d "$candidate" ]; then
      REPOS_DIR="$candidate"
      break
    fi
  done

  if [ -z "$REPOS_DIR" ]; then
    REPOS_DIR="$HOME/repos"
    echo "  No repos directory found, defaulting to $REPOS_DIR"
    echo "  Edit config.json to set your reposDir."
  else
    echo "  Detected repos directory: $REPOS_DIR"
  fi

  # Socket path must be an absolute path that works identically under launchd
  # and interactive shells. We resolve it at install time using $HOME.
  TMUX_SOCKET="$HOME/.claude/klaudii-tmux.sock"
  mkdir -p "$(dirname "$TMUX_SOCKET")"

  cat > "$PROJECT_DIR/config.json" <<CONF
{
  "port": 9876,
  "ttydBasePort": 9877,
  "reposDir": "$REPOS_DIR",
  "tmuxSocket": "$TMUX_SOCKET",
  "projects": []
}
CONF
  echo "  Created: config.json"
else
  echo ""
  echo "config.json already exists, keeping it."
fi

# --- Menu bar app ---

if ! $SKIP_MENUBAR; then
  echo ""
  echo "Compiling menu bar app..."
  if swiftc -o "$SCRIPT_DIR/menubar/KlaudiiMenu" "$SCRIPT_DIR/menubar/KlaudiiMenu.swift" \
    -framework Cocoa 2>/dev/null; then
    echo "  Built: mac/menubar/KlaudiiMenu"
  else
    echo "  WARN: Swift compilation failed (menu bar icon won't work)"
  fi
else
  echo ""
  echo "Skipping menu bar app (--skip-menu-bar-icon)"
fi

# --- launchd agent ---

echo ""
echo "Setting up launchd agent..."
mkdir -p "$LAUNCH_AGENTS_DIR"

NODE_PATH="$(which node)"

# Unload existing if present (check both old and new names)
for old_plist in "com.bryantinsley.klaudii.plist" "$PLIST_NAME"; do
  if [ -f "$LAUNCH_AGENTS_DIR/$old_plist" ]; then
    echo "  Unloading $old_plist..."
    launchctl unload "$LAUNCH_AGENTS_DIR/$old_plist" 2>/dev/null || true
    rm -f "$LAUNCH_AGENTS_DIR/$old_plist"
  fi
done

cat > "$LAUNCH_AGENTS_DIR/$PLIST_NAME" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.klaudii</string>

  <key>ProgramArguments</key>
  <array>
    <string>$NODE_PATH</string>
    <string>$PROJECT_DIR/server.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/tmp/klaudii.log</string>

  <key>StandardErrorPath</key>
  <string>/tmp/klaudii-error.log</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
PLIST

launchctl load "$LAUNCH_AGENTS_DIR/$PLIST_NAME"
echo "  Installed and loaded: $LAUNCH_AGENTS_DIR/$PLIST_NAME"

# --- Done ---

echo ""
echo "=== Install complete ==="
echo ""
echo "  Dashboard:  http://localhost:9876"
echo "  Logs:       /tmp/klaudii.log"
echo "  Config:     $PROJECT_DIR/config.json"
if ! $SKIP_MENUBAR; then
  echo "  Menu bar:   Run ./mac/menubar/KlaudiiMenu to start"
fi
echo ""
echo "The server will auto-start at login."
if ! $SKIP_MENUBAR; then
  echo "To add the menu bar icon to Login Items, drag mac/menubar/KlaudiiMenu"
  echo "into System Settings > General > Login Items."
fi
echo ""
echo "Add workspaces via the dashboard or edit config.json directly."
