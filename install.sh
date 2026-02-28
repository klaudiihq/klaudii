#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST_NAME="com.bryantinsley.klaudii.plist"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"

echo "=== Klaudii Session Manager — Install ==="
echo ""

# 1. Check/install brew dependencies
echo "Checking dependencies..."

if ! command -v tmux &>/dev/null; then
  echo "  Installing tmux..."
  brew install tmux
else
  echo "  tmux: OK"
fi

if ! command -v ttyd &>/dev/null; then
  echo "  Installing ttyd..."
  brew install ttyd
else
  echo "  ttyd: OK"
fi

if ! command -v node &>/dev/null; then
  echo "  ERROR: node not found. Install Node.js first."
  exit 1
else
  echo "  node: OK ($(node --version))"
fi

# 2. Install npm dependencies
echo ""
echo "Installing npm dependencies..."
cd "$SCRIPT_DIR"
npm install

# 3. Compile Swift menu bar app
echo ""
echo "Compiling menu bar app..."
swiftc -o "$SCRIPT_DIR/menubar/KlaudiiMenu" "$SCRIPT_DIR/menubar/KlaudiiMenu.swift" \
  -framework Cocoa 2>/dev/null && echo "  Built: menubar/KlaudiiMenu" || echo "  WARN: Swift compilation failed (menu bar app won't work)"

# 4. Set up launchd agent
echo ""
echo "Setting up launchd agent..."
mkdir -p "$LAUNCH_AGENTS_DIR"

# Unload existing if present (check both old and new names)
for old_plist in "com.bryantinsley.claudes.plist" "com.bryantinsley.klaudii.plist"; do
  if [ -f "$LAUNCH_AGENTS_DIR/$old_plist" ]; then
    echo "  Unloading $old_plist..."
    launchctl unload "$LAUNCH_AGENTS_DIR/$old_plist" 2>/dev/null || true
    rm -f "$LAUNCH_AGENTS_DIR/$old_plist"
  fi
done

cp "$SCRIPT_DIR/$PLIST_NAME" "$LAUNCH_AGENTS_DIR/"
launchctl load "$LAUNCH_AGENTS_DIR/$PLIST_NAME"
echo "  Loaded: $LAUNCH_AGENTS_DIR/$PLIST_NAME"

# 5. Done
echo ""
echo "=== Install complete ==="
echo ""
echo "  Dashboard: http://localhost:9876"
echo "  Logs:      /tmp/klaudii.log"
echo "  Menu bar:  Run ./menubar/KlaudiiMenu to start"
echo ""
echo "The server will auto-start at login."
echo "To add the menu bar app to Login Items, drag menubar/KlaudiiMenu"
echo "into System Settings > General > Login Items."
