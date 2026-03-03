#!/bin/bash
# mac/make-icns.sh — generate AppIcon.icns from brand/icon-glass.svg
# Requires: rsvg-convert (brew install librsvg) and iconutil (Xcode)
set -euo pipefail

SVG="${1:-$(cd "$(dirname "$0")/.." && pwd)/brand/icon-glass.svg}"
OUT="${2:-AppIcon.icns}"
ICONSET="$(mktemp -d)/AppIcon.iconset"

if ! command -v rsvg-convert &>/dev/null; then
  echo "rsvg-convert not found — install with: brew install librsvg"
  exit 1
fi

mkdir -p "$ICONSET"

# Render each size needed by iconutil
for SIZE in 16 32 64 128 256 512 1024; do
  rsvg-convert -w "$SIZE" -h "$SIZE" "$SVG" \
    -o "$ICONSET/icon_${SIZE}x${SIZE}.png"
done

# Create @2x aliases (iconutil expects these named files)
cp "$ICONSET/icon_32x32.png"    "$ICONSET/icon_16x16@2x.png"
cp "$ICONSET/icon_64x64.png"    "$ICONSET/icon_32x32@2x.png"
cp "$ICONSET/icon_256x256.png"  "$ICONSET/icon_128x128@2x.png"
cp "$ICONSET/icon_512x512.png"  "$ICONSET/icon_256x256@2x.png"
cp "$ICONSET/icon_1024x1024.png" "$ICONSET/icon_512x512@2x.png"

iconutil -c icns "$ICONSET" -o "$OUT"
echo "  icon: $OUT"
