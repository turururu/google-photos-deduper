/**
 * Returns true if stored scan results are valid for the given context.
 * Used by both the UI (mount load, incremental cache) and the reducer
 * (health check) so future invalidation conditions only need to be added here.
 */
export function areScanResultsValid(
  stored: { accountEmail?: string },
  context: { accountEmail?: string },
): boolean {
  // Account mismatch: results belong to a different account
  if (stored.accountEmail && context.accountEmail && stored.accountEmail !== context.accountEmail)
    return false;
  return true;
}

/** What the saved groups were computed with; incremental scans need an exact match. */
export interface ScanMeta {
  mode: "smart" | "full";
  threshold: number;
  dateRange: string; // JSON of settings.dateRange
  nextSeq: number; // next unused group number
}

type MetaSettings = { scanMode: "smart" | "full"; similarityThreshold: number; dateRange?: unknown };

export function scanMetaFor(settings: MetaSettings, nextSeq: number): ScanMeta {
  return {
    mode: settings.scanMode,
    threshold: settings.similarityThreshold,
    dateRange: JSON.stringify(settings.dateRange ?? null),
    nextSeq,
  };
}

/** Only full-mode results made with identical settings can be extended; anything else rescans fully. */
export function canResumeScan(meta: ScanMeta | undefined, settings: MetaSettings): boolean {
  if (!meta || settings.scanMode !== "full" || meta.mode !== "full") return false;
  const now = scanMetaFor(settings, 0);
  return meta.threshold === now.threshold && meta.dateRange === now.dateRange;
}

/**
 * Selection state to carry into an incremental result. Groups that gained or lost
 * photos (or are new) are reset to the default: selected, not reviewed, no keep override.
 */
export function carryOverSelection(
  saved: { selectedGroupIds: string[]; keptOverrides: Record<string, string[]> } | undefined,
  reviewed: string[] | undefined,
  groupIds: string[],
  changedIds: string[],
  newIds: string[],
  /** members before and after the update, by group id (needed for changed groups) */
  members: { before: Record<string, string[]>; after: Record<string, string[]> } = { before: {}, after: {} },
): { selected: Set<string>; keptOverrides: Record<string, Set<string>>; reviewed: Set<string> } {
  const valid = new Set(groupIds);
  const changed = new Set(changedIds);
  const reset = new Set([...changedIds, ...newIds]);
  const keep = (id: string) => valid.has(id) && !reset.has(id);
  // A changed group keeps its checked state (unchecked means "keep all"); only new groups start checked.
  const selected = saved
    ? new Set(saved.selectedGroupIds.filter((id) => valid.has(id) && !newIds.includes(id)))
    : new Set(groupIds);
  for (const id of newIds) if (valid.has(id)) selected.add(id);
  const keptOverrides: Record<string, Set<string>> = {};
  for (const [id, keys] of Object.entries(saved?.keptOverrides ?? {})) {
    if (keep(id)) {
      keptOverrides[id] = new Set(keys);
    } else if (changed.has(id) && valid.has(id)) {
      // Whatever the user kept stays kept; photos that joined stay until reviewed.
      const after = new Set(members.after[id] ?? []);
      const before = new Set(members.before[id] ?? []);
      const next = new Set(keys.filter((k) => after.has(k)));
      if (next.size > 0) {
        for (const k of after) if (!before.has(k)) next.add(k);
        keptOverrides[id] = next;
      }
    }
  }
  return { selected, keptOverrides, reviewed: new Set((reviewed ?? []).filter(keep)) };
}
