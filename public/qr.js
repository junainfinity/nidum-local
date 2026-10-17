// Nidum Local — dependency-free QR code encoder (ISO/IEC 18004).
//
// Byte mode (UTF-8), versions 1–10, error correction L/M/Q/H (M by default),
// all eight data masks with the standard penalty rules, format and version
// information. Works as an ES module in current browsers and in Node 18+
// (uses only TextEncoder, which both provide as a global).
//
//   import { encode, toSvg } from './qr.js';
//   const qr = encode('http://recipes.local');   // { size, modules, version, mask, ecc }
//   const svg = toSvg(qr);                        // black on white, 7 px modules, 4-module quiet zone
//
// The symbol construction (function-pattern drawing, format/version bits, data
// placement and especially the penalty scoring with its run-history finder
// detection) closely follows Project Nayuki's QR Code generator library:
//
//   QR Code generator library (JavaScript/TypeScript)
//   Copyright (c) Project Nayuki. (MIT License)
//   https://www.nayuki.io/page/qr-code-generator-library
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy of
//   this software and associated documentation files (the "Software"), to deal in
//   the Software without restriction, including without limitation the rights to
//   use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
//   the Software, and to permit persons to whom the Software is furnished to do so,
//   subject to the following conditions:
//   - The above copyright notice and this permission notice shall be included in
//     all copies or substantial portions of the Software.
//   - The Software is provided "as is", without warranty of any kind, express or
//     implied, including but not limited to the warranties of merchantability,
//     fitness for a particular purpose and noninfringement. In no event shall the
//     authors or copyright holders be liable for any claim, damages or other
//     liability, whether in an action of contract, tort or otherwise, arising from,
//     out of or in connection with the Software or the use or other dealings in the
//     Software.

const MAX_VERSION = 10;

// Format-information bits for each level (ISO 18004 Table 12).
const ECC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };
const ECC_INDEX = { L: 0, M: 1, Q: 2, H: 3 };

// Error-correction block structure per version (ISO 18004 Table 9), indexed
// [version - 1][L, M, Q, H] → [ecCodewordsPerBlock, group1Blocks, group1DataCodewords,
// group2Blocks, group2DataCodewords]. Group 2 blocks carry one more data codeword.
const BLOCKS = [
  /* 1 */ [[7, 1, 19, 0, 0], [10, 1, 16, 0, 0], [13, 1, 13, 0, 0], [17, 1, 9, 0, 0]],
  /* 2 */ [[10, 1, 34, 0, 0], [16, 1, 28, 0, 0], [22, 1, 22, 0, 0], [28, 1, 16, 0, 0]],
  /* 3 */ [[15, 1, 55, 0, 0], [26, 1, 44, 0, 0], [18, 2, 17, 0, 0], [22, 2, 13, 0, 0]],
  /* 4 */ [[20, 1, 80, 0, 0], [18, 2, 32, 0, 0], [26, 2, 24, 0, 0], [16, 4, 9, 0, 0]],
  /* 5 */ [[26, 1, 108, 0, 0], [24, 2, 43, 0, 0], [18, 2, 15, 2, 16], [22, 2, 11, 2, 12]],
  /* 6 */ [[18, 2, 68, 0, 0], [16, 4, 27, 0, 0], [24, 4, 19, 0, 0], [28, 4, 15, 0, 0]],
  /* 7 */ [[20, 2, 78, 0, 0], [18, 4, 31, 0, 0], [18, 2, 14, 4, 15], [26, 4, 13, 1, 14]],
  /* 8 */ [[24, 2, 97, 0, 0], [22, 2, 38, 2, 39], [22, 4, 18, 2, 19], [26, 4, 14, 2, 15]],
  /* 9 */ [[30, 2, 116, 0, 0], [22, 3, 36, 2, 37], [20, 4, 16, 4, 17], [24, 4, 12, 4, 13]],
  /* 10 */ [[18, 2, 68, 2, 69], [26, 4, 43, 1, 44], [24, 6, 19, 2, 20], [28, 6, 15, 2, 16]],
];

// Alignment-pattern centre coordinates (ISO 18004 Annex E).
const ALIGNMENT = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

// Penalty weights (ISO 18004 §7.8.3.1).
const N1 = 3, N2 = 3, N3 = 40, N4 = 10;

// ---------------------------------------------------------------- GF(256) / Reed–Solomon

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // x^8 + x^4 + x^3 + x^2 + 1
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

function gfMul(a, b) {
  return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

const generatorCache = new Map();

// Generator polynomial ∏(x − α^i), i = 0..degree−1, highest-order coefficient
// first with the leading 1 dropped.
function rsGenerator(degree) {
  let g = generatorCache.get(degree);
  if (g) return g;
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  g = poly.slice(1);
  generatorCache.set(degree, g);
  return g;
}

/** Reed–Solomon error-correction codewords for `data` (array of bytes). */
export function rsEncode(data, ecCount) {
  const gen = rsGenerator(ecCount);
  const rem = new Array(ecCount).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem.shift();
    rem.push(0);
    for (let i = 0; i < ecCount; i++) rem[i] ^= gfMul(gen[i], factor);
  }
  return rem;
}

// ---------------------------------------------------------------- capacity helpers

function blockInfo(version, ecc) {
  const [ecPerBlock, b1, d1, b2, d2] = BLOCKS[version - 1][ECC_INDEX[ecc]];
  return { ecPerBlock, b1, d1, b2, d2, dataCodewords: b1 * d1 + b2 * d2 };
}

function countBits(version) {
  return version <= 9 ? 8 : 16; // byte mode character-count indicator length
}

/** Largest number of UTF-8 bytes that fits in `version` at level `ecc`. */
export function byteCapacity(version, ecc = 'M') {
  checkEcc(ecc);
  if (!(Number.isInteger(version) && version >= 1 && version <= MAX_VERSION)) {
    throw new RangeError(`QR: version must be an integer 1–${MAX_VERSION}, got ${version}`);
  }
  const bits = blockInfo(version, ecc).dataCodewords * 8 - 4 - countBits(version);
  return Math.floor(bits / 8);
}

function checkEcc(ecc) {
  if (!Object.prototype.hasOwnProperty.call(ECC_INDEX, ecc)) {
    throw new TypeError(`QR: unknown error correction level ${JSON.stringify(ecc)} (use L, M, Q or H)`);
  }
}

// ---------------------------------------------------------------- data codewords

function toBytes(input) {
  if (typeof input === 'string') return new TextEncoder().encode(input);
  if (input instanceof Uint8Array) return input;
  throw new TypeError('QR: encode() expects a string or a Uint8Array');
}

function dataCodewords(bytes, version, ecc) {
  const { dataCodewords: capacity } = blockInfo(version, ecc);
  const bits = [];
  const put = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4); // byte mode
  put(bytes.length, countBits(version));
  for (const b of bytes) put(b, 8);
  const capacityBits = capacity * 8;
  put(0, Math.min(4, capacityBits - bits.length)); // terminator
  while (bits.length % 8) bits.push(0);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    out.push(v);
  }
  for (let pad = 0xec; out.length < capacity; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

// Split into blocks, append RS codewords, interleave (ISO 18004 §7.6).
function finalCodewords(data, version, ecc) {
  const { ecPerBlock, b1, d1, b2, d2 } = blockInfo(version, ecc);
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (let i = 0; i < b1 + b2; i++) {
    const len = i < b1 ? d1 : d2;
    const block = data.slice(offset, offset + len);
    offset += len;
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, ecPerBlock));
  }
  const out = [];
  const maxData = Math.max(d1, d2);
  for (let i = 0; i < maxData; i++) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) out.push(block[i]);
  }
  return out;
}

// ---------------------------------------------------------------- matrix construction

function makeGrid(size, value) {
  return Array.from({ length: size }, () => new Array(size).fill(value));
}

function buildFunctionPatterns(version) {
  const size = version * 4 + 17;
  const modules = makeGrid(size, false);
  const reserved = makeGrid(size, false);
  const set = (x, y, dark) => {
    modules[y][x] = dark;
    reserved[y][x] = true;
  };

  // Timing patterns.
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  // Finder patterns with separators.
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, d !== 2 && d !== 4);
      }
    }
  }

  // Alignment patterns (skipping the three that would overlap finders).
  const pos = ALIGNMENT[version - 1];
  const last = pos.length - 1;
  for (let i = 0; i <= last; i++) {
    for (let j = 0; j <= last; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  // Reserve format areas (filled in after masking) and the dark module.
  drawFormatBits(set, size, 0);

  // Version information (versions 7+).
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }

  return { size, modules, reserved, set };
}

/** 18-bit version information word (BCH(18,6), generator 0x1F25); versions 7+ only. */
export function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

/** 15-bit format information word for a level and mask (BCH(15,5), XOR 0x5412). */
export function formatBits(ecc, mask) {
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

// `bits` is the 15-bit format word; bit 14 is the most significant.
function drawFormatBits(set, size, bits) {
  const bit = (i) => ((bits >>> i) & 1) === 1;
  // Copy around the top-left finder.
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  // Copy split between the top-right and bottom-left finders.
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true); // always-dark module
}

function placeData(modules, reserved, codewords) {
  const size = modules.length;
  const totalBits = codewords.length * 8;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip the vertical timing column
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < size; vert++) {
      const y = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (reserved[y][x]) continue;
        // Remainder bits (when the module count is not a multiple of 8) stay light.
        if (i < totalBits) {
          modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(modules, reserved, mask) {
  const fn = MASKS[mask];
  const size = modules.length;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!reserved[y][x] && fn(x, y)) modules[y][x] = !modules[y][x];
    }
  }
}

// ---------------------------------------------------------------- penalty (ISO 18004 §7.8.3)

/**
 * Penalty score of a finished matrix. Rule 3 (finder-like 1:1:3:1:1 runs with
 * four light modules on one side) treats the area outside the symbol as light,
 * as the quiet zone is; this matches Nayuki's reference implementation.
 */
export function penalty(modules) {
  const size = modules.length;
  let result = 0;

  const scanLine = (get) => {
    let runColor = false;
    let runLen = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    const addHistory = (len) => {
      if (history[0] === 0) len += size; // light border before the first run
      history.pop();
      history.unshift(len);
    };
    const countPatterns = () => {
      const n = history[1];
      const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
      return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) +
        (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0);
    };
    for (let i = 0; i < size; i++) {
      const c = get(i);
      if (c === runColor) {
        runLen++;
        if (runLen === 5) result += N1;
        else if (runLen > 5) result++;
      } else {
        addHistory(runLen);
        if (!runColor) result += countPatterns() * N3;
        runColor = c;
        runLen = 1;
      }
    }
    // Terminate the line, with the light border after it.
    if (runColor) {
      addHistory(runLen);
      runLen = 0;
    }
    addHistory(runLen + size);
    result += countPatterns() * N3;
  };

  for (let y = 0; y < size; y++) scanLine((x) => modules[y][x]);
  for (let x = 0; x < size; x++) scanLine((y) => modules[y][x]);

  // Rule 2: 2×2 blocks of one colour.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) result += N2;
    }
  }

  // Rule 4: dark/light balance, N4 per full 5 % step away from 50 %.
  let dark = 0;
  for (const row of modules) for (const c of row) if (c) dark++;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  result += k * N4;

  return result;
}

// ---------------------------------------------------------------- public API

/**
 * Encode `text` (UTF-8, byte mode) into a QR symbol.
 * @param {string|Uint8Array} text
 * @param {{ ecc?: 'L'|'M'|'Q'|'H', mask?: number, minVersion?: number }} [options]
 *   `mask` forces a mask (0–7) instead of choosing the lowest-penalty one;
 *   `minVersion` forces at least that version.
 * @returns {{ size: number, modules: boolean[][], version: number, mask: number, ecc: string }}
 *   `modules[y][x]` is true for a dark module (row-major, no quiet zone).
 */
export function encode(text, options) {
  const { ecc = 'M', mask: forcedMask, minVersion = 1 } = options ?? {};
  checkEcc(ecc);
  if (forcedMask !== undefined && !(Number.isInteger(forcedMask) && forcedMask >= 0 && forcedMask <= 7)) {
    throw new RangeError(`QR: mask must be an integer 0–7, got ${forcedMask}`);
  }
  if (!(Number.isInteger(minVersion) && minVersion >= 1 && minVersion <= MAX_VERSION)) {
    throw new RangeError(`QR: minVersion must be an integer 1–${MAX_VERSION}, got ${minVersion}`);
  }
  const bytes = toBytes(text);

  let version = minVersion;
  while (version <= MAX_VERSION && bytes.length > byteCapacity(version, ecc)) version++;
  if (version > MAX_VERSION) {
    const what = typeof text === 'string' ? `text is too long — ${bytes.length} bytes (UTF-8)` : `data is too long — ${bytes.length} bytes`;
    throw new RangeError(
      `QR: ${what}, but a version ${MAX_VERSION} code ` +
        `with error correction ${ecc} holds at most ${byteCapacity(MAX_VERSION, ecc)} bytes`,
    );
  }

  const codewords = finalCodewords(dataCodewords(bytes, version, ecc), version, ecc);
  const { size, modules, reserved, set } = buildFunctionPatterns(version);
  placeData(modules, reserved, codewords);

  const finish = (mask) => {
    applyMask(modules, reserved, mask);
    drawFormatBits(set, size, formatBits(ecc, mask));
  };

  let mask = forcedMask;
  if (mask === undefined) {
    let best = Infinity;
    for (let m = 0; m < 8; m++) {
      finish(m);
      const score = penalty(modules);
      if (score < best) {
        best = score;
        mask = m;
      }
      applyMask(modules, reserved, m); // XOR again to undo
    }
  }
  finish(mask);

  return { size, modules, version, mask, ecc };
}

/**
 * Render an encoded symbol as an SVG string: black modules on a white
 * background, `moduleSize` px per module, `quietZone` light modules of margin.
 */
export function toSvg(qr, options) {
  const { moduleSize = 7, quietZone = 4 } = options ?? {};
  for (const [name, value] of [['moduleSize', moduleSize], ['quietZone', quietZone]]) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(`QR: ${name} must be a finite number, got ${String(value)}`);
    }
  }
  if (!(moduleSize > 0)) throw new RangeError(`QR: moduleSize must be positive, got ${moduleSize}`);
  if (!(Number.isInteger(quietZone) && quietZone >= 0)) {
    throw new RangeError(`QR: quietZone must be a non-negative integer, got ${quietZone}`);
  }
  const n = qr.size + quietZone * 2;
  const px = n * moduleSize;
  let d = '';
  for (let y = 0; y < qr.size; y++) {
    const row = qr.modules[y];
    for (let x = 0; x < qr.size; ) {
      if (!row[x]) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < qr.size && row[x + run]) run++;
      d += `M${x + quietZone} ${y + quietZone}h${run}v1h-${run}z`;
      x += run;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${n} ${n}" ` +
    `shape-rendering="crispEdges">` +
    `<rect width="${n}" height="${n}" fill="#FFFFFF"/>` +
    `<path d="${d}" fill="#000000"/></svg>`
  );
}
