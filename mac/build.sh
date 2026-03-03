#!/bin/bash
# mac/build.sh — build Klaudii.app
#
# Dev build (default — fast, no signing):
#   ./mac/build.sh
#
# Release build (signed, notarized .dmg):
#   ./mac/build.sh --release
#
# Release build env vars (or will prompt):
#   APPLE_ID            your Apple ID email
#   APPLE_APP_PASSWORD  app-specific password from appleid.apple.com
#   APPLE_TEAM_ID       10-char team ID from developer.apple.com
#
set -euo pipefail

# ── Args ──────────────────────────────────────────────────────────────────────
RELEASE=false
for arg in "$@"; do
  [[ "$arg" == "--release" ]] && RELEASE=true
done

NODE_VERSION="22.14.0"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$REPO/dist"
APP="$OUT/Klaudii.app"
DMG="$OUT/Klaudii.dmg"
MACOS="$APP/Contents/MacOS"
RESOURCES="$APP/Contents/Resources"
SERVER="$RESOURCES/server"

# ── Header ────────────────────────────────────────────────────────────────────
echo ""
echo "=== Klaudii build ($($RELEASE && echo release || echo dev)) ==="
echo "  repo:   $REPO"
echo "  output: $APP"
$RELEASE && echo "  dmg:    $DMG"
echo ""

# ── Clean ─────────────────────────────────────────────────────────────────────
rm -rf "$APP" "$DMG"
mkdir -p "$MACOS" "$RESOURCES" "$SERVER"

# ── Info.plist ────────────────────────────────────────────────────────────────
cp "$REPO/mac/Info.plist" "$APP/Contents/Info.plist"

# ── Swift binary ──────────────────────────────────────────────────────────────
if $RELEASE; then
  echo "Compiling Swift (universal arm64 + x86_64)..."
  for ARCH in arm64 x86_64; do
    swiftc \
      -target "${ARCH}-apple-macosx11.0" \
      -o "$OUT/KlaudiiMenu-${ARCH}" \
      "$REPO/mac/menubar/KlaudiiMenu.swift" \
      -framework Cocoa
  done
  lipo -create "$OUT/KlaudiiMenu-arm64" "$OUT/KlaudiiMenu-x86_64" \
       -output "$MACOS/Klaudii"
  rm "$OUT/KlaudiiMenu-arm64" "$OUT/KlaudiiMenu-x86_64"
else
  echo "Compiling Swift (native arch)..."
  swiftc \
    -o "$MACOS/Klaudii" \
    "$REPO/mac/menubar/KlaudiiMenu.swift" \
    -framework Cocoa
fi
chmod +x "$MACOS/Klaudii"
echo "  OK: $MACOS/Klaudii"

# ── Node.js binary ────────────────────────────────────────────────────────────
if $RELEASE; then
  echo "Downloading Node.js ${NODE_VERSION} (universal)..."
  TMPDIR_NODE="$(mktemp -d)"
  for ARCH in arm64 x64; do
    curl -fsSL \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-${ARCH}.tar.gz" \
      | tar xz -C "$TMPDIR_NODE" \
          "node-v${NODE_VERSION}-darwin-${ARCH}/bin/node" \
          --strip-components=2
    mv "$TMPDIR_NODE/node" "$TMPDIR_NODE/node-${ARCH}"
  done
  lipo -create "$TMPDIR_NODE/node-arm64" "$TMPDIR_NODE/node-x64" \
       -output "$RESOURCES/node"
  chmod +x "$RESOURCES/node"
  rm -rf "$TMPDIR_NODE"
  echo "  OK: $RESOURCES/node (universal)"
else
  NODE_BIN="$(which node 2>/dev/null || true)"
  if [[ -z "$NODE_BIN" ]]; then
    echo "ERROR: node not found on PATH"; exit 1
  fi
  # Symlink for dev — avoids copying 50MB
  ln -sf "$NODE_BIN" "$RESOURCES/node"
  echo "  node -> $NODE_BIN (symlink)"
fi

# ── App icon ──────────────────────────────────────────────────────────────────
if command -v rsvg-convert &>/dev/null; then
  echo "Generating AppIcon.icns..."
  bash "$REPO/mac/make-icns.sh" \
    "$REPO/brand/icon-glass.svg" \
    "$RESOURCES/AppIcon.icns"
else
  echo "  skipping icon (brew install librsvg to enable)"
fi

# ── Server files ──────────────────────────────────────────────────────────────
echo "Copying server files..."
rsync -a \
  --exclude=node_modules \
  --exclude=.git \
  --exclude=config.json \
  --exclude=sessions.json \
  --exclude=gemini-sessions.json \
  --exclude=claude-chat-sessions.json \
  --exclude="*.log" \
  --exclude=dist \
  --exclude=brand \
  --exclude=screenshots \
  --exclude=mac \
  --exclude=iOS \
  --exclude=extension \
  --exclude=.github \
  "$REPO/" "$SERVER/"

echo "Installing npm dependencies (production)..."
cd "$SERVER" && npm ci --omit=dev --silent && cd "$REPO"

# ── Dev build done ────────────────────────────────────────────────────────────
if ! $RELEASE; then
  echo ""
  echo "=== Dev build complete ==="
  echo "  open $APP"
  echo ""
  exit 0
fi

# ══════════════════════════════════════════════════════════════════════════════
# Release-only: sign → DMG → sign → notarize → staple
# ══════════════════════════════════════════════════════════════════════════════

# ── Signing identity ──────────────────────────────────────────────────────────
IDENTITY=$(security find-identity -v -p codesigning \
  | grep "Developer ID Application" \
  | head -1 \
  | sed 's/.*"\(.*\)"/\1/')

if [[ -z "$IDENTITY" ]]; then
  echo "ERROR: no Developer ID Application cert found in keychain."
  echo "       Open Keychain Access and import your certificate."
  exit 1
fi
echo "Signing identity: $IDENTITY"

# ── Notarization credentials ──────────────────────────────────────────────────
if [[ -z "${APPLE_ID:-}" ]]; then
  read -r -p "Apple ID email: " APPLE_ID
fi
if [[ -z "${APPLE_APP_PASSWORD:-}" ]]; then
  read -r -s -p "App-specific password (from appleid.apple.com): " APPLE_APP_PASSWORD
  echo ""
fi
if [[ -z "${APPLE_TEAM_ID:-}" ]]; then
  read -r -p "Team ID (10 chars, from developer.apple.com): " APPLE_TEAM_ID
fi

# ── Sign .app ─────────────────────────────────────────────────────────────────
echo "Signing Klaudii.app..."
codesign --deep --force --options runtime \
  --sign "$IDENTITY" \
  --entitlements "$REPO/mac/entitlements.plist" \
  "$APP"
echo "  OK"

# ── Create DMG ────────────────────────────────────────────────────────────────
echo "Creating Klaudii.dmg..."
hdiutil create \
  -volname "Klaudii" \
  -srcfolder "$APP" \
  -ov -format UDZO \
  "$DMG"

# ── Sign DMG ─────────────────────────────────────────────────────────────────
codesign --sign "$IDENTITY" "$DMG"
echo "  OK: $DMG"

# ── Notarize ─────────────────────────────────────────────────────────────────
echo "Notarizing (this takes ~1 min)..."
xcrun notarytool submit "$DMG" \
  --apple-id     "$APPLE_ID" \
  --password     "$APPLE_APP_PASSWORD" \
  --team-id      "$APPLE_TEAM_ID" \
  --wait

# ── Staple ───────────────────────────────────────────────────────────────────
echo "Stapling..."
xcrun stapler staple "$DMG"

echo ""
echo "=== Release build complete ==="
echo "  $DMG"
echo "  Ready to distribute."
echo ""
