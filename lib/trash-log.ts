import type { GpdMediaItem } from "./types";

export interface TrashLogEntry {
  dedupKey: string;
  mediaKey: string;
  fileName?: string;
  taken?: number;
  productUrl?: string;
  trashedAt: number;
  restored?: boolean;
}

export function appendTrashLog(
  log: TrashLogEntry[],
  trashedKeys: string[],
  mediaItems: Record<string, GpdMediaItem>,
  now = Date.now(),
): TrashLogEntry[] {
  const have = new Set(log.filter((e) => !e.restored).map((e) => e.dedupKey));
  const added: TrashLogEntry[] = [];
  for (const k of trashedKeys) {
    const i = mediaItems[k];
    if (!i || have.has(i.dedupKey)) continue;
    have.add(i.dedupKey);
    added.push({
      dedupKey: i.dedupKey,
      mediaKey: i.mediaKey,
      fileName: i.fileName,
      taken: i.timestamp,
      productUrl: i.productUrl,
      trashedAt: now,
    });
  }
  return [...log, ...added];
}

export function markRestored(log: TrashLogEntry[], dedupKeys: Iterable<string>): TrashLogEntry[] {
  const set = new Set(dedupKeys);
  return log.map((e) => (set.has(e.dedupKey) && !e.restored ? { ...e, restored: true } : e));
}

const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;

export function trashLogToCsv(log: TrashLogEntry[]): string {
  const rows = log.map((e) =>
    [
      q(e.fileName),
      q(e.taken ? new Date(e.taken).toISOString() : ""),
      q(new Date(e.trashedAt).toISOString()),
      q(e.restored ? "restored" : "trashed"),
      q(e.productUrl),
      q(e.dedupKey),
    ].join(","),
  );
  return ["file,taken,trashed_at,status,link,dedup_key", ...rows].join("\n") + "\n";
}
