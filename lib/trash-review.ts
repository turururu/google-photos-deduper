import type { DuplicateGroup, GpdMediaItem } from "./types";

export type ReviewStatus =
  | "matched" // a photo that stays is very similar and about the same resolution
  | "no-match" // photos stay in the group, but none is close enough
  | "no-keeper" // the whole group is going
  | "conflict"; // also kept by another group: cannot be trashed

export interface ReviewLimits {
  /** Minimum cosine similarity between the trashed photo and a kept one. */
  minSimilarity: number;
  /** Largest relative difference in pixel count (0.03 = 3%). */
  maxResDiff: number;
}

export const DEFAULT_REVIEW_LIMITS: ReviewLimits = { minSimilarity: 0.97, maxResDiff: 0.03 };

export interface ReviewRow {
  groupId: string;
  key: string;
  keeperKey: string | null;
  status: ReviewStatus;
  similarity?: number;
  /** relative pixel-count difference to the shown keeper; undefined if a resolution is missing */
  resDiff?: number;
}

export interface TrashReview {
  rows: ReviewRow[];
  counts: Record<ReviewStatus, number>;
}

const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

export function resDiff(a: GpdMediaItem, b: GpdMediaItem): number | undefined {
  if (!a.resWidth || !a.resHeight || !b.resWidth || !b.resHeight) return undefined;
  const pa = a.resWidth * a.resHeight;
  const pb = b.resWidth * b.resHeight;
  return Math.abs(pa - pb) / Math.max(pa, pb);
}

/**
 * For every photo in `trashSet`, find the photo of its group that is NOT in the bin
 * and looks most like it, and say whether that is close enough to trust (similar
 * picture, similar resolution). `embeddings` may be null (nothing matches yet).
 * A trashed photo that a marked group keeps is a conflict.
 */
export function reviewTrash(
  groups: DuplicateGroup[],
  items: Record<string, GpdMediaItem>,
  keptOf: (g: DuplicateGroup) => Set<string>,
  trashSet: Set<string>,
  embeddings: Map<string, Float32Array> | null,
  limits: ReviewLimits = DEFAULT_REVIEW_LIMITS,
): TrashReview {
  const keptAnywhere = new Set<string>();
  for (const g of groups) for (const k of keptOf(g)) keptAnywhere.add(k);

  const rows: ReviewRow[] = [];
  for (const g of groups) {
    const keepers = g.mediaKeys.filter((k) => !trashSet.has(k) && items[k]);
    for (const key of g.mediaKeys) {
      if (!trashSet.has(key) || !items[key]) continue;
      if (keptAnywhere.has(key)) {
        rows.push({ groupId: g.id, key, keeperKey: null, status: "conflict" });
        continue;
      }
      if (keepers.length === 0) {
        rows.push({ groupId: g.id, key, keeperKey: null, status: "no-keeper" });
        continue;
      }
      // A matching keeper wins (most similar one); otherwise show the most similar for context.
      const emb = embeddings?.get(key);
      let best: { keeper: string; sim?: number; res?: number; ok: boolean } | null = null;
      for (const k of keepers) {
        const other = embeddings?.get(k);
        const sim = emb && other ? dot(emb, other) : undefined;
        const res = resDiff(items[key], items[k]);
        const ok = sim !== undefined && sim >= limits.minSimilarity && res !== undefined && res <= limits.maxResDiff;
        const better =
          !best ||
          (ok && !best.ok) ||
          (ok === best.ok && (sim ?? -1) > (best.sim ?? -1));
        if (better) best = { keeper: k, sim, res, ok };
      }
      rows.push({
        groupId: g.id,
        key,
        keeperKey: best!.keeper,
        status: best!.ok ? "matched" : "no-match",
        similarity: best!.sim,
        resDiff: best!.res,
      });
    }
  }
  const counts: Record<ReviewStatus, number> = { matched: 0, "no-match": 0, "no-keeper": 0, conflict: 0 };
  for (const r of rows) counts[r.status]++;
  return { rows, counts };
}
