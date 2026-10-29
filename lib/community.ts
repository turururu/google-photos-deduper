// Full pairwise community detection, split into pure pieces so rows can be
// scored in parallel workers and merged deterministically on the main thread.

/**
 * Items of one similarity row at or above `threshold`, best first (ties by index).
 * Null unless at least `minSize` items qualify (the row itself counts, as cos=1).
 */
export function rowCluster(row: Float32Array, threshold: number, minSize = 2): number[] | null {
  let count = 0;
  for (let j = 0; j < row.length; j++) if (row[j] >= threshold) count++;
  if (count < minSize) return null;
  const idx: number[] = [];
  for (let j = 0; j < row.length; j++) if (row[j] >= threshold) idx.push(j);
  idx.sort((a, b) => row[b] - row[a] || a - b);
  return idx;
}

/**
 * Candidate community of every row in [start, end) against all `n` embeddings
 * (L2-normalised, so cosine = dot product). Rows come back in row order; with
 * `seedFirst` each cluster starts with its own row.
 */
export function extractRowCommunities(
  flat: Float32Array,
  n: number,
  dim: number,
  start: number,
  end: number,
  threshold: number,
  onRows?: (done: number) => void,
  seedFirst = false,
): number[][] {
  const out: number[][] = [];
  const row = new Float32Array(n);
  const dim4 = dim - (dim % 4);
  for (let i = start; i < end; i++) {
    const ao = i * dim;
    for (let j = 0; j < n; j++) {
      const bo = j * dim;
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
      let k = 0;
      for (; k < dim4; k += 4) {
        s0 += flat[ao + k] * flat[bo + k];
        s1 += flat[ao + k + 1] * flat[bo + k + 1];
        s2 += flat[ao + k + 2] * flat[bo + k + 2];
        s3 += flat[ao + k + 3] * flat[bo + k + 3];
      }
      for (; k < dim; k++) s0 += flat[ao + k] * flat[bo + k];
      row[j] = s0 + s1 + s2 + s3;
    }
    const c = rowCluster(row, threshold);
    if (c) out.push(seedFirst ? [i, ...c.filter((x) => x !== i)] : c);
    if (onRows && (i - start + 1) % 64 === 0) onRows(i - start + 1);
  }
  return out;
}

/**
 * Greedy, largest-first, non-overlapping communities from per-row candidates.
 * Each item ends up in at most one community; members come back sorted by index.
 */
export function mergeCommunities(extracted: number[][], minSize = 2): number[][] {
  const sorted = [...extracted].sort((a, b) => b.length - a.length);
  const assigned = new Set<number>();
  const unique: number[][] = [];
  for (const community of sorted) {
    const free = community
      .slice()
      .sort((a, b) => a - b)
      .filter((idx) => !assigned.has(idx));
    if (free.length >= minSize) {
      unique.push(free);
      for (const idx of free) assigned.add(idx);
    }
  }
  unique.sort((a, b) => b.length - a.length);
  return unique;
}
