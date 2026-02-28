// Minimal QR code generator — produces SVG output, no dependencies
// Implements QR Code Model 2 with error correction level L
// Based on the QR code specification (ISO/IEC 18004)

const ECL = { L: 0, M: 1, Q: 2, H: 3 };

// Error correction codewords and block info for versions 1-10, ECL L
const EC_TABLE = [
  null,
  { totalDC: 19, ecPerBlock: 7, blocks: 1 },   // v1
  { totalDC: 34, ecPerBlock: 10, blocks: 1 },  // v2
  { totalDC: 55, ecPerBlock: 15, blocks: 1 },  // v3
  { totalDC: 80, ecPerBlock: 20, blocks: 1 },  // v4
  { totalDC: 108, ecPerBlock: 26, blocks: 1 }, // v5
  { totalDC: 136, ecPerBlock: 18, blocks: 2 }, // v6
  { totalDC: 156, ecPerBlock: 20, blocks: 2 }, // v7
  { totalDC: 194, ecPerBlock: 24, blocks: 2 }, // v8
  { totalDC: 232, ecPerBlock: 30, blocks: 2 }, // v9
  { totalDC: 274, ecPerBlock: 18, blocks: 4 }, // v10
];

function getVersion(dataLength) {
  // Byte mode: 4 bits mode + 8/16 bits count + 8*len bits data
  for (let v = 1; v <= 10; v++) {
    const countBits = v <= 9 ? 8 : 16;
    const dataBits = 4 + countBits + dataLength * 8;
    const dataBytes = Math.ceil(dataBits / 8);
    if (dataBytes <= EC_TABLE[v].totalDC) return v;
  }
  throw new Error("Data too long for QR versions 1-10");
}

function getSize(version) {
  return 17 + version * 4;
}

// GF(256) arithmetic for Reed-Solomon
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x = (x << 1) ^ (x >= 128 ? 0x11d : 0);
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsEncode(data, ecLen) {
  // Generate generator polynomial
  let gen = [1];
  for (let i = 0; i < ecLen; i++) {
    const next = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j];
      next[j + 1] ^= gfMul(gen[j], GF_EXP[i]);
    }
    gen = next;
  }

  const result = new Uint8Array(ecLen);
  const msg = new Uint8Array(data.length + ecLen);
  msg.set(data);

  for (let i = 0; i < data.length; i++) {
    const coef = msg[i] ^ result[0] || 0;
    // Shift result
    for (let j = 0; j < ecLen - 1; j++) result[j] = result[j + 1];
    result[ecLen - 1] = 0;
    if (coef !== 0) {
      for (let j = 0; j < ecLen; j++) {
        result[j] ^= gfMul(gen[j + 1], coef);
      }
    }
  }
  return result;
}

function encodeData(text, version) {
  const ec = EC_TABLE[version];
  const countBits = version <= 9 ? 8 : 16;
  const bytes = Buffer.from(text, "utf8");

  // Build bit stream
  let bits = "";
  // Mode: byte (0100)
  bits += "0100";
  // Count
  bits += bytes.length.toString(2).padStart(countBits, "0");
  // Data
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  // Terminator
  const totalDataBits = ec.totalDC * 8;
  const termLen = Math.min(4, totalDataBits - bits.length);
  bits += "0".repeat(termLen);
  // Pad to byte boundary
  while (bits.length % 8 !== 0) bits += "0";
  // Pad bytes
  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (bits.length < totalDataBits) {
    bits += padBytes[padIdx % 2].toString(2).padStart(8, "0");
    padIdx++;
  }

  // Convert to byte array
  const data = new Uint8Array(ec.totalDC);
  for (let i = 0; i < ec.totalDC; i++) {
    data[i] = parseInt(bits.substr(i * 8, 8), 2);
  }

  // Split into blocks and generate EC
  const blockSize = Math.floor(ec.totalDC / ec.blocks);
  const remainder = ec.totalDC % ec.blocks;
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;

  for (let b = 0; b < ec.blocks; b++) {
    const size = blockSize + (b >= ec.blocks - remainder ? 1 : 0);
    const block = data.slice(offset, offset + size);
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, ec.ecPerBlock));
    offset += size;
  }

  // Interleave data blocks
  const maxDataLen = Math.max(...dataBlocks.map((b) => b.length));
  const interleaved = [];
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of dataBlocks) {
      if (i < block.length) interleaved.push(block[i]);
    }
  }
  // Interleave EC blocks
  for (let i = 0; i < ec.ecPerBlock; i++) {
    for (const block of ecBlocks) {
      interleaved.push(block[i]);
    }
  }

  return interleaved;
}

function createMatrix(version) {
  const size = getSize(version);
  // 0 = white, 1 = black, -1 = unset
  const matrix = Array.from({ length: size }, () => new Int8Array(size).fill(-1));
  return matrix;
}

function addFinderPattern(matrix, row, col) {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const mr = row + r, mc = col + c;
      if (mr < 0 || mr >= matrix.length || mc < 0 || mc >= matrix.length) continue;
      const inOuter = r >= 0 && r <= 6 && c >= 0 && c <= 6;
      const inInner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      const onBorder = r === 0 || r === 6 || c === 0 || c === 6;
      matrix[mr][mc] = (inInner || (inOuter && onBorder)) ? 1 : 0;
    }
  }
}

function addAlignmentPattern(matrix, row, col) {
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      const onBorder = Math.abs(r) === 2 || Math.abs(c) === 2;
      const isCenter = r === 0 && c === 0;
      matrix[row + r][col + c] = (onBorder || isCenter) ? 1 : 0;
    }
  }
}

const ALIGNMENT_POSITIONS = [
  null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 52],
];

function addPatterns(matrix, version) {
  const size = matrix.length;

  // Finder patterns
  addFinderPattern(matrix, 0, 0);
  addFinderPattern(matrix, 0, size - 7);
  addFinderPattern(matrix, size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    matrix[6][i] = i % 2 === 0 ? 1 : 0;
    matrix[i][6] = i % 2 === 0 ? 1 : 0;
  }

  // Alignment patterns
  if (version >= 2) {
    const positions = ALIGNMENT_POSITIONS[version];
    for (const r of positions) {
      for (const c of positions) {
        if (matrix[r][c] !== -1) continue; // Skip if overlaps finder
        addAlignmentPattern(matrix, r, c);
      }
    }
  }

  // Dark module
  matrix[size - 8][8] = 1;

  // Reserve format info areas
  for (let i = 0; i < 8; i++) {
    if (matrix[8][i] === -1) matrix[8][i] = 0;
    if (matrix[i][8] === -1) matrix[i][8] = 0;
    if (matrix[8][size - 1 - i] === -1) matrix[8][size - 1 - i] = 0;
    if (matrix[size - 1 - i][8] === -1) matrix[size - 1 - i][8] = 0;
  }
  if (matrix[8][8] === -1) matrix[8][8] = 0;
}

function placeData(matrix, data) {
  const size = matrix.length;
  let bitIdx = 0;
  const bits = [];
  for (const byte of data) {
    for (let b = 7; b >= 0; b--) bits.push((byte >> b) & 1);
  }

  let x = size - 1;
  let upward = true;

  while (x > 0) {
    if (x === 6) x--; // Skip timing column

    const rows = upward
      ? Array.from({ length: size }, (_, i) => size - 1 - i)
      : Array.from({ length: size }, (_, i) => i);

    for (const y of rows) {
      for (const dx of [0, -1]) {
        const col = x + dx;
        if (col < 0) continue;
        if (matrix[y][col] !== -1) continue;
        matrix[y][col] = bitIdx < bits.length ? bits[bitIdx++] : 0;
      }
    }

    x -= 2;
    upward = !upward;
  }
}

function applyMask(matrix, maskNum) {
  const size = matrix.length;
  const maskFn = [
    (r, c) => (r + c) % 2 === 0,
    (r, c) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2 + (r * c) % 3) === 0,
    (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0,
    (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0,
  ][maskNum];

  // We need to track which cells are data vs pattern
  // For simplicity, we'll clone the matrix before data placement
  // and only mask data cells
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (isDataCell(matrix, r, c, size) && maskFn(r, c)) {
        matrix[r][c] ^= 1;
      }
    }
  }
}

function isDataCell(matrix, r, c, size) {
  // Finder patterns + separators
  if (r <= 8 && c <= 8) return false;
  if (r <= 8 && c >= size - 8) return false;
  if (r >= size - 8 && c <= 8) return false;
  // Timing
  if (r === 6 || c === 6) return false;
  return true;
}

// Format info (ECL L = 01, mask patterns 0-7)
const FORMAT_STRINGS = [
  0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976,
];

function addFormatInfo(matrix, maskNum) {
  const size = matrix.length;
  const info = FORMAT_STRINGS[maskNum];

  // Around top-left finder
  const bits = [];
  for (let i = 14; i >= 0; i--) bits.push((info >> i) & 1);

  // Horizontal (row 8)
  const hPositions = [0, 1, 2, 3, 4, 5, 7, 8, size - 8, size - 7, size - 6, size - 5, size - 4, size - 3, size - 2];
  for (let i = 0; i < 15; i++) {
    matrix[8][hPositions[i]] = bits[i];
  }

  // Vertical (col 8)
  const vPositions = [0, 1, 2, 3, 4, 5, 7, 8, size - 7, size - 6, size - 5, size - 4, size - 3, size - 2, size - 1];
  for (let i = 0; i < 15; i++) {
    matrix[vPositions[14 - i]][8] = bits[i];
  }
}

function generateQR(text) {
  const version = getVersion(text.length);
  const data = encodeData(text, version);
  const matrix = createMatrix(version);

  addPatterns(matrix, version);
  placeData(matrix, data);
  applyMask(matrix, 0); // Use mask 0 for simplicity
  addFormatInfo(matrix, 0);

  return matrix;
}

function toSVG(matrix, options = {}) {
  const { moduleSize = 4, margin = 4, darkColor = "#000", lightColor = "#fff" } = options;
  const size = matrix.length;
  const fullSize = (size + margin * 2) * moduleSize;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fullSize} ${fullSize}" width="${fullSize}" height="${fullSize}">`;
  svg += `<rect width="${fullSize}" height="${fullSize}" fill="${lightColor}"/>`;

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix[r][c] === 1) {
        const x = (c + margin) * moduleSize;
        const y = (r + margin) * moduleSize;
        svg += `<rect x="${x}" y="${y}" width="${moduleSize}" height="${moduleSize}" fill="${darkColor}"/>`;
      }
    }
  }

  svg += "</svg>";
  return svg;
}

function generateSVG(text, options) {
  const matrix = generateQR(text);
  return toSVG(matrix, options);
}

module.exports = { generateQR, toSVG, generateSVG };
