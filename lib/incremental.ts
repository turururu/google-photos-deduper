// Incremental duplicate detection: only photos that were not part of the previous
// scan are compared (against everything); old groups keep their ids.
import { mergeCommunities } from "./community";
import type { DuplicateGroup } from "./types";

export interface GroupDelta {
  id: string;
  mediaKeys: string[]; // members after the update (unsorted)
  status: "unchanged" | "changed" | "new";
}

export interface IncrementalResult {
  groups: GroupDelta[]; // old groups first (original order), then new ones
  droppedIds: string[]; // old groups that fell below two photos
  nextSeq: number;
}

/**
 * @param prevGroups   groups of the previous scan
 * @param keys         mediaKey of every compared photo, indexed like the clusters;
 *                     photos that were already in the previous scan come first
 * @param newFrom      index of the first new photo in `keys`
 * @param rowClusters  one per new photo: [its own index, ...indices at or above the threshold]
 * @param nextSeq      next unused group number, so a dropped id is never reused
 */
export function mergeIncremental(
  prevGroups: DuplicateGroup[],
  keys: string[],
  newFrom: number,
  rowClusters: number[][],
  nextSeq: number,
): IncrementalResult {
  const indexOf = new Map(keys.map((k, i) => [k, i]));
  const groupOfIdx = new Map<number, number>(); // photo index -> position in `kept`
  const kept: GroupDelta[] = [];
  const droppedIds: string[] = [];

  for (const g of prevGroups) {
    const members = g.mediaKeys.filter((k) => indexOf.has(k));
    if (members.length < 2) {
      droppedIds.push(g.id);
      continue;
    }
    const pos = kept.length;
    kept.push({ id: g.id, mediaKeys: members, status: members.length === g.mediaKeys.length ? "unchanged" : "changed" });
    for (const k of members) groupOfIdx.set(indexOf.get(k)!, pos);
  }

  // Phase 1: a new photo joins the old group it matches the most members of.
  const assigned = new Set<number>();
  const deferred: { idx: number; neighbours: number[] }[] = [];
  for (const cluster of rowClusters) {
    const [seed, ...neighbours] = cluster;
    if (seed === undefined || seed < newFrom) continue;
    const counts = new Map<number, number>();
    for (const n of neighbours) {
      const pos = groupOfIdx.get(n);
      if (pos !== undefined) counts.set(pos, (counts.get(pos) ?? 0) + 1);
    }
    let best = -1;
    let bestCount = 0;
    for (const [pos, c] of counts) if (c > bestCount || (c === bestCount && pos < best)) { best = pos; bestCount = c; }
    if (best >= 0) {
      kept[best].mediaKeys.push(keys[seed]);
      kept[best].status = "changed";
      groupOfIdx.set(seed, best);
      assigned.add(seed);
    } else deferred.push({ idx: seed, neighbours });
  }

  // Phase 2: remaining new photos group with each other or with old ungrouped photos.
  const free = (i: number) => !groupOfIdx.has(i) && !assigned.has(i);
  const candidates = deferred
    .filter((d) => free(d.idx))
    .map((d) => [d.idx, ...d.neighbours.filter(free)]);
  let seq = nextSeq;
  const created: GroupDelta[] = mergeCommunities(candidates).map((members) => ({
    id: `group-${seq++}`,
    mediaKeys: members.map((i) => keys[i]),
    status: "new" as const,
  }));

  return { groups: [...kept, ...created], droppedIds, nextSeq: seq };
}
