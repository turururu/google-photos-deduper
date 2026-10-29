import type { DuplicateGroup, GpdMediaItem } from "./types";

export type SortKey =
  | "similarity-desc"
  | "similarity-asc"
  | "size-desc"
  | "removable-desc"
  | "taken-desc"
  | "taken-asc";

export interface ViewPrefs {
  sort: SortKey;
  minSimilarity: number; // 0-1
  maxSimilarity: number; // 0-1
  onlyPairs: boolean;
  noFavorites: boolean;
  hideReviewed: boolean;
  // Session-only: filter by trash-selection, judged against a snapshot so
  // ticking a group doesn't make it vanish mid-click.
  selection: "all" | "selected" | "unselected";
  // Taken-date range as yyyy-mm-dd (local). Deliberately not persisted.
  takenFrom: string;
  takenTo: string;
}

export const DEFAULT_VIEW_PREFS: ViewPrefs = {
  sort: "similarity-desc",
  minSimilarity: 0,
  maxSimilarity: 1,
  onlyPairs: false,
  noFavorites: true,
  hideReviewed: false,
  selection: "all",
  takenFrom: "",
  takenTo: "",
};

/** Prefs as stored: the date range is session-only so it can't hide groups after a rescan. */
export function persistablePrefs(p: ViewPrefs): ViewPrefs {
  return { ...p, takenFrom: "", takenTo: "", selection: "all" };
}

function dayStart(d: string): number {
  return d ? new Date(`${d}T00:00:00`).getTime() : -Infinity;
}
function dayEnd(d: string): number {
  return d ? new Date(`${d}T23:59:59.999`).getTime() : Infinity;
}

const pixels = (i: GpdMediaItem) => (i.resWidth ?? 0) * (i.resHeight ?? 0);

function itemsOf(g: DuplicateGroup, m: Record<string, GpdMediaItem>) {
  return g.mediaKeys.map((k) => m[k]).filter(Boolean);
}

/** Pixels that would be removed if only the best item were kept (storage proxy). */
function removablePixels(items: GpdMediaItem[]): number {
  const total = items.reduce((s, i) => s + pixels(i), 0);
  return total - Math.max(0, ...items.map(pixels));
}

const takenOf = (items: GpdMediaItem[]) =>
  items.length ? Math.min(...items.map((i) => i.timestamp ?? 0)) : 0;

// Rounded so a slider at 0.99 doesn't drop a group stored as 0.98999.
const EPS = 1e-6;

export function applyViewPrefs(
  groups: DuplicateGroup[],
  mediaItems: Record<string, GpdMediaItem>,
  prefs: ViewPrefs,
  reviewed?: Set<string>,
  selectedSnapshot?: Set<string>,
): DuplicateGroup[] {
  const from = dayStart(prefs.takenFrom);
  const to = dayEnd(prefs.takenTo);
  const rows = groups
    .map((g) => ({ g, items: itemsOf(g, mediaItems) }))
    .filter(({ g, items }) => {
      if (g.similarity < prefs.minSimilarity - EPS) return false;
      if (g.similarity > prefs.maxSimilarity + EPS) return false;
      if (prefs.onlyPairs && g.mediaKeys.length !== 2) return false;
      if (prefs.noFavorites && items.some((i) => i.isFavorite === true)) return false;
      if (prefs.hideReviewed && reviewed?.has(g.id)) return false;
      if (prefs.selection !== "all" && selectedSnapshot) {
        if (selectedSnapshot.has(g.id) !== (prefs.selection === "selected")) return false;
      }
      if (from !== -Infinity || to !== Infinity) {
        const t = takenOf(items);
        if (t < from || t > to) return false;
      }
      return true;
    });

  const key: Record<SortKey, (r: (typeof rows)[number]) => number> = {
    "similarity-desc": (r) => -r.g.similarity,
    "similarity-asc": (r) => r.g.similarity,
    "size-desc": (r) => -r.g.mediaKeys.length,
    "removable-desc": (r) => -removablePixels(r.items),
    "taken-desc": (r) => -takenOf(r.items),
    "taken-asc": (r) => takenOf(r.items),
  };
  const f = key[prefs.sort];
  // Array.sort is stable, so ties keep scan order.
  return rows.sort((a, b) => f(a) - f(b)).map((r) => r.g);
}

/**
 * Groups that may actually be trashed: selected AND currently shown. Hidden
 * groups (filtered out) must never be trashed by a click the user can't see
 * the effect of.
 */
export function effectiveSelection(
  selected: Set<string>,
  shown: DuplicateGroup[],
): Set<string> {
  return new Set(shown.filter((g) => selected.has(g.id)).map((g) => g.id));
}

/**
 * Groups a trash click may touch. Same as the visible list except that
 * "Hide reviewed" never narrows it: reviewed groups are the ones the user has
 * looked at and approved, so hiding them must not exclude them from trashing
 * (and leave every unreviewed, still-selected group as the only target).
 */
export function trashScope(
  groups: DuplicateGroup[],
  mediaItems: Record<string, GpdMediaItem>,
  prefs: ViewPrefs,
  reviewed?: Set<string>,
): DuplicateGroup[] {
  // Neither "hide reviewed" nor the selection view may narrow what trash touches.
  return applyViewPrefs(groups, mediaItems, { ...prefs, hideReviewed: false, selection: "all" }, reviewed);
}
