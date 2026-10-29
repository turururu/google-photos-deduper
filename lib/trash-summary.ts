import type { GpdMediaItem } from "./types";

export interface TrashSummary {
  items: number;
  known: number; // items whose storage use is known
  bytes: number; // storage that counts against quota, for known items
}

/**
 * Storage freed by trashing: items that don't count against quota free nothing,
 * so prefer Google's own `spaceTaken`, then file size, and skip when
 * `takesUpSpace` is false.
 */
export function summarizeTrash(items: GpdMediaItem[]): TrashSummary {
  let known = 0;
  let bytes = 0;
  for (const i of items) {
    if (i.takesUpSpace === false) {
      known++;
      continue;
    }
    const b = i.spaceTaken ?? i.size;
    if (typeof b === "number") {
      known++;
      bytes += b;
    }
  }
  return { items: items.length, known, bytes };
}
