// Pixel-level fingerprint used to confirm that two photos are practically
// identical. Embedding similarity is semantic, so burst shots can score >0.99.
// Three signals must all agree: a difference hash (structure), an 8x8 colour
// grid (filters/brightness) and a 32x32 grayscale grid compared by its WORST
// cell (small local changes such as a blink or a moved hand, which averages
// would hide). Even so, tiny changes can slip through at thumbnail size —
// review a few groups with flicker compare before trusting a bulk select.

export interface Fingerprint {
  dhash: Uint8Array; // 64 bits as 8 bytes
  color: Uint8Array; // 8x8 grid, RGB
  gray: Uint8Array; // 32x32 grayscale grid
}

export interface PixelThresholds {
  maxHamming: number; // bits out of 64
  maxColorMae: number; // mean abs error per channel, 0-255
  maxCellDiff: number; // worst single 32x32 grayscale cell, 0-255
}

export const DEFAULT_PIXEL_THRESHOLDS: PixelThresholds = {
  maxHamming: 2,
  maxColorMae: 4,
  maxCellDiff: 24,
};

/** Box-average RGBA pixels down to a cols x rows RGB grid. */
function downsample(
  rgba: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  cols: number,
  rows: number,
): Float64Array {
  const sums = new Float64Array(cols * rows * 3);
  const counts = new Float64Array(cols * rows);
  for (let y = 0; y < h; y++) {
    const cy = Math.min(rows - 1, Math.floor((y * rows) / h));
    for (let x = 0; x < w; x++) {
      const cx = Math.min(cols - 1, Math.floor((x * cols) / w));
      const c = cy * cols + cx;
      const i = (y * w + x) * 4;
      sums[c * 3] += rgba[i];
      sums[c * 3 + 1] += rgba[i + 1];
      sums[c * 3 + 2] += rgba[i + 2];
      counts[c]++;
    }
  }
  for (let c = 0; c < cols * rows; c++) {
    const n = counts[c] || 1;
    sums[c * 3] /= n;
    sums[c * 3 + 1] /= n;
    sums[c * 3 + 2] /= n;
  }
  return sums;
}

export function computeFingerprint(
  rgba: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
): Fingerprint {
  // dHash: 9x8 grayscale, compare horizontal neighbours.
  const g = downsample(rgba, w, h, 9, 8);
  const gray = (c: number) =>
    0.299 * g[c * 3] + 0.587 * g[c * 3 + 1] + 0.114 * g[c * 3 + 2];
  const dhash = new Uint8Array(8);
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      if (gray(row * 9 + col) > gray(row * 9 + col + 1))
        dhash[row] |= 1 << col;
    }
  }
  const c8 = downsample(rgba, w, h, 8, 8);
  const color = Uint8Array.from(c8, (v) => Math.round(v));
  const g32 = downsample(rgba, w, h, 32, 32);
  const gray32 = new Uint8Array(32 * 32);
  for (let c = 0; c < gray32.length; c++)
    gray32[c] = Math.round(0.299 * g32[c * 3] + 0.587 * g32[c * 3 + 1] + 0.114 * g32[c * 3 + 2]);
  return { dhash, color, gray: gray32 };
}

export function hamming(a: Uint8Array, b: Uint8Array): number {
  let bits = 0;
  for (let i = 0; i < a.length; i++) {
    let x = a[i] ^ b[i];
    while (x) {
      bits += x & 1;
      x >>= 1;
    }
  }
  return bits;
}

export function colorMae(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

export function maxCellDiff(a: Uint8Array, b: Uint8Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

/** True only if EVERY pair passes — an average could hide one odd item. */
export function allPairsIdentical(
  fps: Fingerprint[],
  t: PixelThresholds = DEFAULT_PIXEL_THRESHOLDS,
): boolean {
  for (let i = 0; i < fps.length; i++) {
    for (let j = i + 1; j < fps.length; j++) {
      if (
        hamming(fps[i].dhash, fps[j].dhash) > t.maxHamming ||
        colorMae(fps[i].color, fps[j].color) > t.maxColorMae ||
        maxCellDiff(fps[i].gray, fps[j].gray) > t.maxCellDiff
      )
        return false;
    }
  }
  return true;
}
