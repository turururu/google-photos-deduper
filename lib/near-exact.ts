import type { GpdMediaItem } from "./types";

// Metadata-level pre-filter for "safe to bulk-select" groups. Passing here only
// makes a group a *candidate*; the pixel check (lib/pixel-hash.ts) must also
// pass for every pair before it is treated as practically identical.

export interface NearExactOptions {
  minSimilarity: number;
  maxTakenDiffMs: number; // `timestamp` is in milliseconds
  maxAspectDiff: number; // relative, 0.01 = 1%
  maxGroupSize: number;
}

export const DEFAULT_NEAR_EXACT: NearExactOptions = {
  minSimilarity: 0.995,
  maxTakenDiffMs: 2000,
  maxAspectDiff: 0.01,
  maxGroupSize: 4,
};

export type ExclusionReason =
  | "size"
  | "similarity"
  | "video"
  | "time"
  | "aspect"
  | "multiple-favorites";

export function nearExactExclusions(
  items: GpdMediaItem[],
  similarity: number,
  opts: NearExactOptions = DEFAULT_NEAR_EXACT,
): ExclusionReason[] {
  const out: ExclusionReason[] = [];
  if (items.length < 2 || items.length > opts.maxGroupSize) out.push("size");
  if (similarity < opts.minSimilarity) out.push("similarity");
  if (items.some((i) => i.duration !== undefined)) out.push("video");

  const times = items.map((i) => i.timestamp);
  if (Math.max(...times) - Math.min(...times) > opts.maxTakenDiffMs)
    out.push("time");

  const ratios = items.map((i) =>
    i.resWidth && i.resHeight ? i.resWidth / i.resHeight : NaN,
  );
  const ref = ratios[0];
  const sameOrientation = (r: number) => r >= 1 === ref >= 1;
  if (
    ratios.some(
      (r) =>
        !Number.isFinite(r) ||
        !sameOrientation(r) ||
        Math.abs(r - ref) / ref > opts.maxAspectDiff,
    )
  )
    out.push("aspect");

  if (items.filter((i) => i.isFavorite === true).length > 1)
    out.push("multiple-favorites");

  // Ties on favorite/quality/resolution are fine here: the pixel check proves
  // the photos are the same picture, and selectDefaultKeep breaks the tie.

  return out;
}

export function isNearExactCandidate(
  items: GpdMediaItem[],
  similarity: number,
  opts?: NearExactOptions,
): boolean {
  return nearExactExclusions(items, similarity, opts).length === 0;
}

/**
 * Metadata test for one pair: both photos (no video), taken within the window,
 * same orientation and aspect within tolerance. Used per pair when only part
 * of a group is identical.
 */
export function pairMetadataFailure(
  a: GpdMediaItem,
  b: GpdMediaItem,
  opts: NearExactOptions = DEFAULT_NEAR_EXACT,
): "video" | "time" | "shape" | null {
  if (a.duration !== undefined || b.duration !== undefined) return "video";
  // Missing times must fail: NaN would slip past a `>` comparison.
  if (!Number.isFinite(a.timestamp) || !Number.isFinite(b.timestamp)) return "time";
  if (Math.abs(a.timestamp - b.timestamp) > opts.maxTakenDiffMs) return "time";
  if (!a.resWidth || !a.resHeight || !b.resWidth || !b.resHeight) return "shape";
  const ra = a.resWidth / a.resHeight;
  const rb = b.resWidth / b.resHeight;
  if (ra >= 1 !== rb >= 1) return "shape";
  return Math.abs(ra - rb) / ra <= opts.maxAspectDiff ? null : "shape";
}

export function pairMetadataOk(
  a: GpdMediaItem,
  b: GpdMediaItem,
  opts: NearExactOptions = DEFAULT_NEAR_EXACT,
): boolean {
  return pairMetadataFailure(a, b, opts) === null;
}
