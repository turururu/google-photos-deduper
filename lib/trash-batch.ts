import { countFullyTrashedGroups, type KeptOverrides } from "./kept-overrides";
import type { DuplicateGroup, GpdMediaItem } from "./types";

export interface TrashBatch {
  dedupKeys: string[];
  mediaKeysToTrash: string[];
  fullyTrashedGroups: number;
  unreviewedGroups: number;
}

/** Everything marked for trash: each marked group's photos that are not kept. */
export function buildTrashBatch(
  groups: DuplicateGroup[],
  items: Record<string, GpdMediaItem>,
  trashableIds: Set<string>,
  keptOf: (g: DuplicateGroup) => Set<string>,
  reviewedIds: Set<string>,
): TrashBatch {
  const dedupKeys: string[] = [];
  const mediaKeysToTrash: string[] = [];
  for (const g of groups) {
    if (!trashableIds.has(g.id)) continue;
    const kept = keptOf(g);
    for (const key of g.mediaKeys) {
      if (kept.has(key)) continue;
      const item = items[key];
      if (item?.dedupKey) {
        dedupKeys.push(item.dedupKey);
        mediaKeysToTrash.push(key);
      }
    }
  }
  return {
    dedupKeys,
    mediaKeysToTrash,
    fullyTrashedGroups: countFullyTrashedGroups(groups, trashableIds, keptOf),
    unreviewedGroups: [...trashableIds].filter((id) => !reviewedIds.has(id)).length,
  };
}

/** Make these photos stay: widens the kept override of every group that holds them. */
export function keepPhotos(
  overrides: KeptOverrides,
  groups: DuplicateGroup[],
  keys: Set<string>,
  keptOf: (g: DuplicateGroup) => Set<string>,
): KeptOverrides {
  const next = { ...overrides };
  for (const g of groups) {
    const add = g.mediaKeys.filter((k) => keys.has(k));
    if (add.length > 0) next[g.id] = new Set([...keptOf(g), ...add]);
  }
  return next;
}
