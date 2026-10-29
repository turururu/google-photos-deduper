import { passes } from "./identical-plan";
import { pairKey, type IdenticalScan, type PairScore } from "./identical-scan";
import { pairMetadataOk } from "./near-exact";
import type { PixelThresholds } from "./pixel-hash";
import type { DuplicateGroup, GpdMediaItem } from "./types";

export type ReviewStatus =
  | "proven" // passes the pixel + metadata check against a photo that stays
  | "unproven" // a keeper exists but no pixel proof (hand-picked, or not scanned)
  | "no-keeper" // the whole group is going
  | "conflict"; // also kept by another group: cannot be trashed

export interface ReviewRow {
  groupId: string;
  key: string;
  keeperKey: string | null;
  status: ReviewStatus;
  score?: PairScore;
}

export interface TrashReview {
  rows: ReviewRow[];
  counts: Record<ReviewStatus, number>;
}

/**
 * For every photo in `trashSet`, find a photo of its group that is NOT in the
 * bin and say whether it is proven identical to it (any such keeper may prove
 * it, as in the planner). `scan` may be null (then nothing is proven).
 * A trashed photo that a marked group keeps is a conflict.
 */
export function reviewTrash(
  groups: DuplicateGroup[],
  items: Record<string, GpdMediaItem>,
  keptOf: (g: DuplicateGroup) => Set<string>,
  trashSet: Set<string>,
  scan: IdenticalScan | null,
  thresholds: PixelThresholds,
): TrashReview {
  const keptAnywhere = new Set<string>();
  for (const g of groups) for (const k of keptOf(g)) keptAnywhere.add(k);

  const rows: ReviewRow[] = [];
  for (const g of groups) {
    const keepers = g.mediaKeys.filter((k) => !trashSet.has(k) && items[k]);
    const byPair = new Map((scan?.pairs[g.id] ?? []).map((s) => [pairKey(s.a, s.b), s]));
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
      // Prefer a keeper that proves it (smallest local diff); else show the closest.
      let proof: { keeper: string; score: PairScore } | null = null;
      let closest: { keeper: string; score?: PairScore } | null = null;
      for (const k of keepers) {
        const score = byPair.get(pairKey(key, k));
        if (score && passes(score, thresholds) && pairMetadataOk(items[key], items[k])) {
          if (!proof || score.cellDiff < proof.score.cellDiff) proof = { keeper: k, score };
        }
        if (!closest || (score !== undefined && (closest.score === undefined || score.cellDiff < closest.score.cellDiff)))
          closest = { keeper: k, score };
      }
      const pick = proof ?? closest!;
      rows.push({ groupId: g.id, key, keeperKey: pick.keeper, status: proof ? "proven" : "unproven", score: pick.score });
    }
  }
  const counts: Record<ReviewStatus, number> = { proven: 0, unproven: 0, "no-keeper": 0, conflict: 0 };
  for (const r of rows) counts[r.status]++;
  return { rows, counts };
}
