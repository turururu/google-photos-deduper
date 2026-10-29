import type { DuplicateGroup, GpdMediaItem } from "./types";
import { buildThumbUrl } from "./photo-url";
import { pairMetadataOk } from "./near-exact";
import {
  colorMae,
  computeFingerprint,
  hamming,
  isFlat,
  maxCellDiff,
  type Fingerprint,
  type PixelThresholds,
} from "./pixel-hash";

// Same rendition as the scan, so most fetches hit the browser HTTP cache.
const THUMB_HEIGHT = 200;
const CONCURRENCY = 8;
const FETCH_TIMEOUT_MS = 8000;

// Fingerprints survive across clicks within a session.
const fingerprintCache = new Map<string, Fingerprint | null>();

async function fingerprintFor(
  item: GpdMediaItem,
  signal?: AbortSignal,
): Promise<Fingerprint | null> {
  const cached = fingerprintCache.get(item.mediaKey);
  if (cached) return cached;
  let fp: Fingerprint | null = null;
  try {
    const res = await fetch(buildThumbUrl(item.thumb, { height: THUMB_HEIGHT }), {
      credentials: "include",
      signal: signal
        ? (AbortSignal as typeof AbortSignal & { any(s: AbortSignal[]): AbortSignal }).any([
            AbortSignal.timeout(FETCH_TIMEOUT_MS),
            signal,
          ])
        : AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.ok) {
      const bitmap = await createImageBitmap(await res.blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(bitmap, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      const f = computeFingerprint(data, width, height);
      fp = isFlat(f) ? null : f; // flat images match anything: leave them uncompared
      bitmap.close();
    } else {
      res.body?.cancel();
    }
  } catch (e) {
    // User cancel aborts the scan; a timeout just skips this item.
    if (signal?.aborted) throw e;
  }
  // Only successes are cached, so a transient failure is retried next time.
  if (fp) fingerprintCache.set(item.mediaKey, fp);
  return fp;
}

export const MAX_GROUP_ITEMS = 20;

export interface PairScore {
  a: string; // mediaKey
  b: string; // mediaKey
  hamming: number; // bits out of 64
  colorMae: number; // 0-255
  cellDiff: number; // 0-255, worst local cell
}

export interface IdenticalScan {
  groupsScanned: number;
  skipped: Record<string, number>; // reason -> groups
  /** Raw pair scores (metadata-eligible pairs only); thresholds are applied later. */
  pairs: Record<string, PairScore[]>; // groupId -> scores
}

export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * Scores every metadata-eligible pair (photos, taken within the window, same
 * shape) in each group. Only items that belong to at least one such pair are
 * fetched. Thresholds are applied afterwards by the planner so the UI can tune
 * them without refetching.
 */
export async function scanIdenticalGroups(
  groups: DuplicateGroup[],
  mediaItems: Record<string, GpdMediaItem>,
  opts: { onProgress?: (done: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<IdenticalScan> {
  const skipped: Record<string, number> = {};
  const skip = (r: string) => (skipped[r] = (skipped[r] ?? 0) + 1);
  const work: { group: DuplicateGroup; pairs: [GpdMediaItem, GpdMediaItem][] }[] = [];
  for (const g of groups) {
    const items = g.mediaKeys.map((k) => mediaItems[k]).filter(Boolean);
    if (items.length !== g.mediaKeys.length) {
      skip("missing");
      continue;
    }
    if (items.length > MAX_GROUP_ITEMS) {
      skip("size");
      continue;
    }
    const pairs: [GpdMediaItem, GpdMediaItem][] = [];
    for (let i = 0; i < items.length; i++)
      for (let j = i + 1; j < items.length; j++)
        if (pairMetadataOk(items[i], items[j])) pairs.push([items[i], items[j]]);
    if (pairs.length === 0) {
      skip("no comparable pair");
      continue;
    }
    work.push({ group: g, pairs });
  }

  const result: Record<string, PairScore[]> = {};
  const queue = [...work];
  let done = 0;
  const worker = async () => {
    for (let w = queue.shift(); w; w = queue.shift()) {
      opts.signal?.throwIfAborted();
      const need = new Map<string, GpdMediaItem>();
      for (const [a, b] of w.pairs) {
        need.set(a.mediaKey, a);
        need.set(b.mediaKey, b);
      }
      const fps = new Map<string, Fingerprint>();
      await Promise.all(
        [...need.values()].map(async (it) => {
          const f = await fingerprintFor(it, opts.signal);
          if (f) fps.set(it.mediaKey, f);
        }),
      );
      const scores: PairScore[] = [];
      for (const [a, b] of w.pairs) {
        const fa = fps.get(a.mediaKey);
        const fb = fps.get(b.mediaKey);
        if (!fa || !fb) continue; // undecoded pair can never count as identical
        scores.push({
          a: a.mediaKey,
          b: b.mediaKey,
          hamming: hamming(fa.dhash, fb.dhash),
          colorMae: colorMae(fa.color, fb.color),
          cellDiff: maxCellDiff(fa.gray, fb.gray),
        });
      }
      result[w.group.id] = scores;
      opts.onProgress?.(++done, work.length);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { groupsScanned: work.length, skipped, pairs: result };
}
