import { keepComparator, type KeepOrder } from "./duplicate-detector";
import { pairKey, type IdenticalScan, type PairScore } from "./identical-scan";
import { pairMetadataOk } from "./near-exact";
import type { PixelThresholds } from "./pixel-hash";
import type { DuplicateGroup, GpdMediaItem } from "./types";

export interface GroupPlan {
  groupId: string;
  kept: string[]; // mediaKeys that stay
  trash: { key: string; keptKey: string; score: PairScore }[]; // each judged against a kept photo
  fully: boolean; // everything but one photo is trashed
}

const passes = (s: PairScore, t: PixelThresholds) =>
  s.hamming <= t.maxHamming && s.colorMae <= t.maxColorMae && s.cellDiff <= t.maxCellDiff;

/**
 * Safety rule: every photo planned for the trash passes the pixel check
 * (and the time/shape check) directly against a photo that STAYS kept.
 * Representatives are never trashed and matches are never chained.
 *
 * `locked` photos (favorites, videos, anything in an existing keep override)
 * are seeded as representatives and are never trashed.
 */
export function planGroup(
  group: DuplicateGroup,
  items: Record<string, GpdMediaItem>,
  scores: PairScore[],
  thresholds: PixelThresholds,
  opts: { keepOrder: KeepOrder; existingKept?: Set<string> },
): GroupPlan | null {
  const list = group.mediaKeys.map((k) => items[k]).filter(Boolean);
  if (list.length !== group.mediaKeys.length || list.length < 2) return null;
  const byPair = new Map(scores.map((s) => [pairKey(s.a, s.b), s]));
  const ranked = [...list].sort(keepComparator(opts.keepOrder));

  const isLocked = (i: GpdMediaItem) =>
    i.isFavorite === true || i.duration !== undefined || opts.existingKept?.has(i.mediaKey) === true;

  const reps: GpdMediaItem[] = ranked.filter(isLocked);
  const trash: GroupPlan["trash"] = [];
  for (const item of ranked) {
    if (isLocked(item)) continue;
    let match: { rep: GpdMediaItem; score: PairScore } | null = null;
    for (const rep of reps) {
      const score = byPair.get(pairKey(item.mediaKey, rep.mediaKey));
      if (score && pairMetadataOk(item, rep) && passes(score, thresholds)) {
        match = { rep, score };
        break;
      }
    }
    if (match) trash.push({ key: item.mediaKey, keptKey: match.rep.mediaKey, score: match.score });
    else reps.push(item);
  }
  return {
    groupId: group.id,
    kept: reps.map((r) => r.mediaKey),
    trash,
    fully: trash.length === list.length - 1,
  };
}

export function planAll(
  groups: DuplicateGroup[],
  items: Record<string, GpdMediaItem>,
  scan: IdenticalScan,
  thresholds: PixelThresholds,
  opts: { keepOrder: KeepOrder; keptOverrides?: Record<string, Set<string>> },
): GroupPlan[] {
  const out: GroupPlan[] = [];
  for (const g of groups) {
    const scores = scan.pairs[g.id];
    if (!scores) continue;
    const plan = planGroup(g, items, scores, thresholds, {
      keepOrder: opts.keepOrder,
      existingKept: opts.keptOverrides?.[g.id],
    });
    if (plan && plan.trash.length > 0) out.push(plan);
  }
  return out;
}

/**
 * Of the photos about to be trashed, those proven identical to a photo that
 * stays. Everything else deserves a video backup.
 */
export function provenIdentical(
  group: DuplicateGroup,
  items: Record<string, GpdMediaItem>,
  scores: PairScore[],
  thresholds: PixelThresholds,
  trashed: Set<string>,
): Set<string> {
  const byPair = new Map(scores.map((s) => [pairKey(s.a, s.b), s]));
  const kept = group.mediaKeys.filter((k) => !trashed.has(k) && items[k]);
  const proven = new Set<string>();
  for (const k of group.mediaKeys) {
    if (!trashed.has(k) || !items[k]) continue;
    for (const r of kept) {
      const s = byPair.get(pairKey(k, r));
      if (s && pairMetadataOk(items[k], items[r]) && passes(s, thresholds)) {
        proven.add(k);
        break;
      }
    }
  }
  return proven;
}

/** Merge plans into the selection (or replace it); never drops a kept photo. */
export function applyPlans(
  selected: Set<string>,
  kept: Record<string, Set<string>>,
  plans: GroupPlan[],
  opts: { replace?: boolean } = {},
): { selected: Set<string>; kept: Record<string, Set<string>> } {
  // replace: the result becomes the whole selection (stale marks are dropped);
  // kept sets are still only ever widened.
  const nextSel = new Set(opts.replace ? [] : selected)
  const nextKept = { ...kept }
  for (const p of plans) {
    nextSel.add(p.groupId)
    nextKept[p.groupId] = new Set([...(kept[p.groupId] ?? []), ...p.kept])
  }
  return { selected: nextSel, kept: nextKept }
}


/**
 * Conservative defaults: whole-group matches only, from groups whose overall
 * similarity clears the floor. `minSimilarity` null = floor disabled (scans
 * made before real similarity was stored all share one fake value).
 */
export function filterPlans(
  plans: GroupPlan[],
  groups: DuplicateGroup[],
  opts: { includeMixed: boolean; minSimilarity: number | null },
): GroupPlan[] {
  const sim = new Map(groups.map((g) => [g.id, g.similarity]));
  return plans.filter((p) => {
    if (!opts.includeMixed && !p.fully) return false;
    if (opts.minSimilarity !== null && (sim.get(p.groupId) ?? 0) < opts.minSimilarity - 1e-6) return false;
    return true;
  });
}
