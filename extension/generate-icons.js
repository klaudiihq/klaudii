#!/usr/bin/env node
// Generate minimal PNG icons for the Klaudii Chrome extension.
// Run: node generate-icons.js
// Creates icons/icon16.png, icons/icon48.png, icons/icon128.png
//
// These are simple green "K" on dark background icons.
// Uses raw PNG encoding — no dependencies required.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

function createPNG(width, height, drawFn) {
  // RGBA pixel buffer
  const pixels = Buffer.alloc(width * height * 4, 0);

  function setPixel(x, y, r, g, b, a = 255) {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const i = (y * width + x) * 4;
    // Alpha blending
    const srcA = a / 255;
    const dstA = pixels[i + 3] / 255;
    const outA = srcA + dstA * (1 - srcA);
    if (outA > 0) {
      pixels[i] = Math.round((r * srcA + pixels[i] * dstA * (1 - srcA)) / outA);
      pixels[i + 1] = Math.round((g * srcA + pixels[i + 1] * dstA * (1 - srcA)) / outA);
      pixels[i + 2] = Math.round((b * srcA + pixels[i + 2] * dstA * (1 - srcA)) / outA);
      pixels[i + 3] = Math.round(outA * 255);
    }
  }

  function fillRect(x, y, w, h, r, g, b, a = 255) {
    for (let py = Math.floor(y); py < Math.ceil(y + h); py++) {
      for (let px = Math.floor(x); px < Math.ceil(x + w); px++) {
        setPixel(px, py, r, g, b, a);
      }
    }
  }

  function fillCircle(cx, cy, radius, r, g, b, a = 255) {
    const r2 = radius * radius;
    for (let py = Math.floor(cy - radius); py <= Math.ceil(cy + radius); py++) {
      for (let px = Math.floor(cx - radius); px <= Math.ceil(cx + radius); px++) {
        const dx = px - cx, dy = py - cy;
        if (dx * dx + dy * dy <= r2) setPixel(px, py, r, g, b, a);
      }
    }
  }

  drawFn({ setPixel, fillRect, fillCircle, width, height });

  // Build PNG
  // Filter: None (0) prepended to each row
  const rawData = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    rawData[y * (1 + width * 4)] = 0; // filter byte
    pixels.copy(rawData, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }

  const compressed = zlib.deflateSync(rawData);

  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const chunks = [
    makeChunk("IHDR", ihdr),
    makeChunk("IDAT", compressed),
    makeChunk("IEND", Buffer.alloc(0)),
  ];

  return Buffer.concat([signature, ...chunks]);
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeB = Buffer.from(type, "ascii");
  const crcInput = Buffer.concat([typeB, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput) >>> 0);
  return Buffer.concat([len, typeB, data, crc]);
}

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let j = 0; j < 8; j++) {
      c = (c >>> 1) ^ (c & 1 ? 0xEDB88320 : 0);
    }
  }
  return c ^ 0xFFFFFFFF;
}

// Draw the Klaudii "K" icon
function drawKlaudiiIcon({ fillRect, fillCircle, width, height }) {
  const s = width;

  // Background
  fillRect(0, 0, s, s, 0x1a, 0x1d, 0x25);

  // Rounded corners (cut background to make it rounded-ish for larger sizes)
  if (s >= 48) {
    const r = Math.floor(s * 0.15);
    // Clear corners
    for (let y = 0; y < r; y++) {
      for (let x = 0; x < r; x++) {
        const dx = r - x, dy = r - y;
        if (dx * dx + dy * dy > r * r) {
          // Top-left
          fillRect(x, y, 1, 1, 0, 0, 0, 0);
          // Top-right
          fillRect(s - 1 - x, y, 1, 1, 0, 0, 0, 0);
          // Bottom-left
          fillRect(x, s - 1 - y, 1, 1, 0, 0, 0, 0);
          // Bottom-right
          fillRect(s - 1 - x, s - 1 - y, 1, 1, 0, 0, 0, 0);
        }
      }
    }
  }

  // Draw "K" in green (#4ade80)
  const gr = 0x4a, gg = 0xde, gb = 0x80;
  const thick = Math.max(2, Math.round(s * 0.14));
  const left = Math.round(s * 0.22);
  const top = Math.round(s * 0.2);
  const bot = Math.round(s * 0.8);
  const mid = Math.round((top + bot) / 2);
  const right = Math.round(s * 0.7);

  // Vertical stroke of K
  fillRect(left, top, thick, bot - top, gr, gg, gb);

  // Upper diagonal of K (from middle-left to top-right)
  for (let i = 0; i <= mid - top; i++) {
    const frac = i / (mid - top || 1);
    const x = left + thick + frac * (right - left - thick);
    const y = mid - i;
    fillRect(Math.round(x), Math.round(y), thick, thick, gr, gg, gb);
  }

  // Lower diagonal of K (from middle-left to bottom-right)
  for (let i = 0; i <= bot - mid; i++) {
    const frac = i / (bot - mid || 1);
    const x = left + thick + frac * (right - left - thick);
    const y = mid + i;
    fillRect(Math.round(x), Math.round(y), thick, thick, gr, gg, gb);
  }

  // Draw "ii" dots in blue (#2563eb) — only for sizes >= 48
  if (s >= 32) {
    const br = 0x25, bg = 0x63, bb = 0xeb;
    const dotR = Math.max(1, Math.round(s * 0.04));
    const stemW = Math.max(1, Math.round(s * 0.06));
    const x1 = Math.round(s * 0.7);
    const x2 = Math.round(s * 0.82);
    const dotY = Math.round(s * 0.42);
    const stemTop = Math.round(s * 0.5);
    const stemBot = Math.round(s * 0.72);

    // First "i"
    fillCircle(x1, dotY, dotR + 1, br, bg, bb);
    fillRect(x1 - stemW / 2, stemTop, stemW, stemBot - stemTop, br, bg, bb);

    // Second "i"
    fillCircle(x2, dotY, dotR + 1, br, bg, bb);
    fillRect(x2 - stemW / 2, stemTop, stemW, stemBot - stemTop, br, bg, bb);
  }
}

// Generate icons
const iconsDir = path.join(__dirname, "icons");
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir);

for (const size of [16, 48, 128]) {
  const png = createPNG(size, size, drawKlaudiiIcon);
  const outPath = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(outPath, png);
  console.log(`  ${outPath} (${png.length} bytes)`);
}

console.log("Done.");
