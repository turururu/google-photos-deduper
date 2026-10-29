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
