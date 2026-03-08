// Beautiful QR code generator — round-dot SVG output, no dependencies
// Implements QR Code Model 2 with error correction level L
// Based on the QR code specification (ISO/IEC 18004)

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

function getVersion(byteLength) {
  for (let v = 1; v <= 10; v++) {
    const countBits = v <= 9 ? 8 : 16;
    const dataBits = 4 + countBits + byteLength * 8;
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
  for (let i = 0; i < data.length; i++) {
    const coef = data[i] ^ result[0];
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

  let bits = "";
  bits += "0100"; // Byte mode
  bits += bytes.length.toString(2).padStart(countBits, "0");
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");

  const totalDataBits = ec.totalDC * 8;
  const termLen = Math.min(4, totalDataBits - bits.length);
  bits += "0".repeat(termLen);
  while (bits.length % 8 !== 0) bits += "0";

  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (bits.length < totalDataBits) {
    bits += padBytes[padIdx % 2].toString(2).padStart(8, "0");
    padIdx++;
  }

  const data = new Uint8Array(ec.totalDC);
  for (let i = 0; i < ec.totalDC; i++) {
    data[i] = parseInt(bits.substr(i * 8, 8), 2);
  }

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

  const maxDataLen = Math.max(...dataBlocks.map((b) => b.length));
  const interleaved = [];
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of dataBlocks) {
      if (i < block.length) interleaved.push(block[i]);
    }
  }
  for (let i = 0; i < ec.ecPerBlock; i++) {
    for (const block of ecBlocks) {
      interleaved.push(block[i]);
    }
  }

  return interleaved;
}

function createMatrix(version) {
  const size = getSize(version);
  return Array.from({ length: size }, () => new Int8Array(size).fill(-1));
}

// Separate boolean matrix to track function pattern cells (not maskable)
function createFunctionMask(size) {
  return Array.from({ length: size }, () => new Uint8Array(size));
}

function markFunction(fnMask, r, c) {
  if (r >= 0 && r < fnMask.length && c >= 0 && c < fnMask.length) {
    fnMask[r][c] = 1;
  }
}

function addFinderPattern(matrix, fnMask, row, col) {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const mr = row + r, mc = col + c;
      if (mr < 0 || mr >= matrix.length || mc < 0 || mc >= matrix.length) continue;
      const inOuter = r >= 0 && r <= 6 && c >= 0 && c <= 6;
      const inInner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      const onBorder = r === 0 || r === 6 || c === 0 || c === 6;
      matrix[mr][mc] = (inInner || (inOuter && onBorder)) ? 1 : 0;
      markFunction(fnMask, mr, mc);
    }
  }
}

function addAlignmentPattern(matrix, fnMask, row, col) {
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      const onBorder = Math.abs(r) === 2 || Math.abs(c) === 2;
      const isCenter = r === 0 && c === 0;
      matrix[row + r][col + c] = (onBorder || isCenter) ? 1 : 0;
      markFunction(fnMask, row + r, col + c);
    }
  }
}

const ALIGNMENT_POSITIONS = [
  null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 52],
];

function addPatterns(matrix, fnMask, version) {
  const size = matrix.length;

  addFinderPattern(matrix, fnMask, 0, 0);
  addFinderPattern(matrix, fnMask, 0, size - 7);
  addFinderPattern(matrix, fnMask, size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    matrix[6][i] = i % 2 === 0 ? 1 : 0;
    matrix[i][6] = i % 2 === 0 ? 1 : 0;
    markFunction(fnMask, 6, i);
    markFunction(fnMask, i, 6);
  }

  // Alignment patterns
  if (version >= 2) {
    const positions = ALIGNMENT_POSITIONS[version];
    for (const r of positions) {
      for (const c of positions) {
        if (fnMask[r][c]) continue; // Skip if overlaps finder
        addAlignmentPattern(matrix, fnMask, r, c);
      }
    }
  }

  // Dark module
  matrix[size - 8][8] = 1;
  markFunction(fnMask, size - 8, 8);

  // Reserve format info areas
  for (let i = 0; i < 8; i++) {
    if (matrix[8][i] === -1) matrix[8][i] = 0;
    if (matrix[i][8] === -1) matrix[i][8] = 0;
    if (matrix[8][size - 1 - i] === -1) matrix[8][size - 1 - i] = 0;
    if (matrix[size - 1 - i][8] === -1) matrix[size - 1 - i][8] = 0;
    markFunction(fnMask, 8, i);
    markFunction(fnMask, i, 8);
    markFunction(fnMask, 8, size - 1 - i);
    markFunction(fnMask, size - 1 - i, 8);
  }
  if (matrix[8][8] === -1) matrix[8][8] = 0;
  markFunction(fnMask, 8, 8);
}

function placeData(matrix, fnMask, data) {
  const size = matrix.length;
  const bits = [];
  for (const byte of data) {
    for (let b = 7; b >= 0; b--) bits.push((byte >> b) & 1);
  }

  let bitIdx = 0;
  let x = size - 1;
  let upward = true;

  while (x > 0) {
    if (x === 6) x--;

    const rows = upward
      ? Array.from({ length: size }, (_, i) => size - 1 - i)
      : Array.from({ length: size }, (_, i) => i);

    for (const y of rows) {
      for (const dx of [0, -1]) {
        const col = x + dx;
        if (col < 0) continue;
        if (fnMask[y][col]) continue; // Skip function pattern cells
        matrix[y][col] = bitIdx < bits.length ? bits[bitIdx++] : 0;
      }
    }

    x -= 2;
    upward = !upward;
  }
}

function applyMask(matrix, fnMask, maskNum) {
  const size = matrix.length;
  const maskFns = [
    (r, c) => (r + c) % 2 === 0,
    (r, c) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2 + (r * c) % 3) === 0,
    (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0,
    (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0,
  ];
  const maskFn = maskFns[maskNum];

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!fnMask[r][c] && maskFn(r, c)) {
        matrix[r][c] ^= 1;
      }
    }
  }
}

// Penalty scoring for mask selection
function scoreMask(matrix) {
  const size = matrix.length;
  let penalty = 0;

  // Rule 1: runs of same color in rows and columns
  for (let r = 0; r < size; r++) {
    let runLen = 1;
    for (let c = 1; c < size; c++) {
      if (matrix[r][c] === matrix[r][c - 1]) {
        runLen++;
      } else {
        if (runLen >= 5) penalty += runLen - 2;
        runLen = 1;
      }
    }
    if (runLen >= 5) penalty += runLen - 2;
  }
  for (let c = 0; c < size; c++) {
    let runLen = 1;
    for (let r = 1; r < size; r++) {
      if (matrix[r][c] === matrix[r - 1][c]) {
        runLen++;
      } else {
        if (runLen >= 5) penalty += runLen - 2;
        runLen = 1;
      }
    }
    if (runLen >= 5) penalty += runLen - 2;
  }

  // Rule 2: 2x2 blocks of same color
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = matrix[r][c];
      if (v === matrix[r][c + 1] && v === matrix[r + 1][c] && v === matrix[r + 1][c + 1]) {
        penalty += 3;
      }
    }
  }

  return penalty;
}

// Format info (ECL L = 01, mask patterns 0-7)
const FORMAT_STRINGS = [
  0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976,
];

function addFormatInfo(matrix, fnMask, maskNum) {
  const size = matrix.length;
  const info = FORMAT_STRINGS[maskNum];
  const bits = [];
  for (let i = 14; i >= 0; i--) bits.push((info >> i) & 1);

  const hPositions = [0, 1, 2, 3, 4, 5, 7, 8, size - 8, size - 7, size - 6, size - 5, size - 4, size - 3, size - 2];
  for (let i = 0; i < 15; i++) matrix[8][hPositions[i]] = bits[i];

  const vPositions = [0, 1, 2, 3, 4, 5, 7, 8, size - 7, size - 6, size - 5, size - 4, size - 3, size - 2, size - 1];
  for (let i = 0; i < 15; i++) matrix[vPositions[14 - i]][8] = bits[i];
}

function generateQR(text) {
  const bytes = Buffer.from(text, "utf8");
  const version = getVersion(bytes.length);
  const data = encodeData(text, version);
  const size = getSize(version);
  const fnMask = createFunctionMask(size);

  // Try all 8 masks and pick the best one
  let bestMatrix = null;
  let bestMask = 0;
  let bestScore = Infinity;

  for (let m = 0; m < 8; m++) {
    const matrix = createMatrix(version);
    const fn = createFunctionMask(size);
    addPatterns(matrix, fn, version);
    placeData(matrix, fn, data);
    applyMask(matrix, fn, m);
    addFormatInfo(matrix, fn, m);
    const score = scoreMask(matrix);
    if (score < bestScore) {
      bestScore = score;
      bestMatrix = matrix;
      bestMask = m;
    }
  }

  return bestMatrix;
}

// ---------------------------------------------------------------------------
// Beautiful round-dot SVG renderer (Google-style)
// ---------------------------------------------------------------------------

function isFinderCenter(r, c, size) {
  // Returns which finder pattern this cell belongs to, or null
  // Finder patterns occupy 7x7 at three corners, plus 1-cell separator
  const finders = [
    { row: 0, col: 0 },
    { row: 0, col: size - 7 },
    { row: size - 7, col: 0 },
  ];
  for (const f of finders) {
    if (r >= f.row && r < f.row + 7 && c >= f.col && c < f.col + 7) {
      return f;
    }
  }
  return null;
}

function isAlignmentCenter(r, c, version) {
  if (version < 2) return false;
  const positions = ALIGNMENT_POSITIONS[version];
  for (const pr of positions) {
    for (const pc of positions) {
      if (Math.abs(r - pr) <= 2 && Math.abs(c - pc) <= 2) {
        // Check it's not overlapping a finder
        if (pr <= 8 && pc <= 8) continue;
        if (r === pr && c === pc) return { row: pr, col: pc, isCenter: true };
        if (Math.abs(r - pr) <= 2 && Math.abs(c - pc) <= 2) return { row: pr, col: pc, isCenter: false };
      }
    }
  }
  return false;
}

function toSVG(matrix, options = {}) {
  const {
    moduleSize = 10,
    margin = 4,
    darkColor = "#000",
    lightColor = "#fff",
    finderColor = "#000",
    round = true,
  } = options;
  const size = matrix.length;
  const version = (size - 17) / 4;
  const fullSize = (size + margin * 2) * moduleSize;
  const m = moduleSize;
  const r = m * 0.45; // dot radius (slightly less than half for gaps)

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fullSize} ${fullSize}" width="${fullSize}" height="${fullSize}">`;
  svg += `<rect width="${fullSize}" height="${fullSize}" fill="${lightColor}" rx="${m * 0.5}"/>`;

  if (!round) {
    // Fallback: square modules
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        if (matrix[row][col] === 1) {
          const x = (col + margin) * m;
          const y = (row + margin) * m;
          svg += `<rect x="${x}" y="${y}" width="${m}" height="${m}" fill="${darkColor}"/>`;
        }
      }
    }
    svg += "</svg>";
    return svg;
  }

  // Render finder patterns as rounded shapes
  const finderPositions = [
    { row: 0, col: 0 },
    { row: 0, col: size - 7 },
    { row: size - 7, col: 0 },
  ];

  for (const fp of finderPositions) {
    const fx = (fp.col + margin) * m;
    const fy = (fp.row + margin) * m;
    const outerSize = 7 * m;
    const outerR = m * 1.4; // corner radius for outer ring

    // Outer ring (rounded rect outline)
    const ringWidth = m;
    svg += `<rect x="${fx}" y="${fy}" width="${outerSize}" height="${outerSize}" rx="${outerR}" ry="${outerR}" fill="${finderColor}"/>`;
    svg += `<rect x="${fx + ringWidth}" y="${fy + ringWidth}" width="${outerSize - ringWidth * 2}" height="${outerSize - ringWidth * 2}" rx="${outerR * 0.6}" ry="${outerR * 0.6}" fill="${lightColor}"/>`;

    // Inner filled rounded rect (3x3 center)
    const innerOff = 2 * m;
    const innerSize = 3 * m;
    const innerR = m * 0.8;
    svg += `<rect x="${fx + innerOff}" y="${fy + innerOff}" width="${innerSize}" height="${innerSize}" rx="${innerR}" ry="${innerR}" fill="${finderColor}"/>`;
  }

  // Render alignment patterns as rounded shapes
  if (version >= 2) {
    const positions = ALIGNMENT_POSITIONS[version];
    for (const ar of positions) {
      for (const ac of positions) {
        // Skip if overlapping finder
        const overlaps = finderPositions.some(
          (fp) => ar >= fp.row && ar < fp.row + 7 && ac >= fp.col && ac < fp.col + 7
        );
        if (overlaps) continue;

        const ax = (ac - 2 + margin) * m;
        const ay = (ar - 2 + margin) * m;
        const aSize = 5 * m;
        const aR = m * 0.8;

        // Outer ring
        svg += `<rect x="${ax}" y="${ay}" width="${aSize}" height="${aSize}" rx="${aR}" ry="${aR}" fill="${darkColor}"/>`;
        svg += `<rect x="${ax + m}" y="${ay + m}" width="${3 * m}" height="${3 * m}" rx="${aR * 0.5}" ry="${aR * 0.5}" fill="${lightColor}"/>`;
        // Center dot
        const cx = (ac + margin) * m + m * 0.5;
        const cy = (ar + margin) * m + m * 0.5;
        svg += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${darkColor}"/>`;
      }
    }
  }

  // Render all other dark modules as round dots
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (matrix[row][col] !== 1) continue;

      // Skip finder pattern cells (already drawn)
      const finder = isFinderCenter(row, col, size);
      if (finder) continue;
      // Skip finder separators (white border around finders)
      if (row <= 7 && col <= 7) continue;
      if (row <= 7 && col >= size - 8) continue;
      if (row >= size - 8 && col <= 7) continue;

      // Skip alignment pattern cells (already drawn)
      if (version >= 2) {
        const positions = ALIGNMENT_POSITIONS[version];
        let isAlign = false;
        for (const ar of positions) {
          for (const ac of positions) {
            const overlaps = finderPositions.some(
              (fp) => ar >= fp.row && ar < fp.row + 7 && ac >= fp.col && ac < fp.col + 7
            );
            if (overlaps) continue;
            if (Math.abs(row - ar) <= 2 && Math.abs(col - ac) <= 2) {
              isAlign = true;
              break;
            }
          }
          if (isAlign) break;
        }
        if (isAlign) continue;
      }

      // Draw round dot
      const cx = (col + margin) * m + m * 0.5;
      const cy = (row + margin) * m + m * 0.5;
      svg += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${darkColor}"/>`;
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
