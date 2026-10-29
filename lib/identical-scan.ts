import type { DuplicateGroup, GpdMediaItem } from "./types";
import { buildThumbUrl } from "./photo-url";
import { isNearExactCandidate } from "./near-exact";
import {
  colorMae,
  computeFingerprint,
  hamming,
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
      fp = computeFingerprint(data, width, height);
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

export interface GroupPixelScore {
  groupId: string;
  maxHamming: number; // worst pair, bits out of 64
  maxColorMae: number; // worst pair, 0-255
  maxCellDiff: number; // worst pair, 0-255
}

export interface IdenticalScan {
  candidateCount: number;
  scores: GroupPixelScore[]; // candidates whose thumbnails all decoded
}

/**
 * Metadata-filters the groups, then fingerprints only the candidates and
 * records the worst pairwise distances. Thresholds are applied afterwards
 * (see `passingGroupIds`) so the UI can tune them without refetching.
 */
export async function scanIdenticalGroups(
  groups: DuplicateGroup[],
  mediaItems: Record<string, GpdMediaItem>,
  opts: { onProgress?: (done: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<IdenticalScan> {
  const candidates = groups
    .map((g) => ({
      group: g,
      items: g.mediaKeys.map((k) => mediaItems[k]).filter(Boolean),
    }))
    .filter(
      (c) =>
        c.items.length === c.group.mediaKeys.length &&
        isNearExactCandidate(c.items, c.group.similarity),
    );

  const scores: GroupPixelScore[] = [];
  const queue = [...candidates];
  let done = 0;
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      opts.signal?.throwIfAborted();
      const fps = await Promise.all(c.items.map((i) => fingerprintFor(i, opts.signal)));
      if (fps.every((f): f is Fingerprint => f !== null)) {
        let maxHamming = 0;
        let maxColorMae = 0;
        let maxCell = 0;
        for (let i = 0; i < fps.length; i++)
          for (let j = i + 1; j < fps.length; j++) {
            maxHamming = Math.max(maxHamming, hamming(fps[i].dhash, fps[j].dhash));
            maxColorMae = Math.max(maxColorMae, colorMae(fps[i].color, fps[j].color));
            maxCell = Math.max(maxCell, maxCellDiff(fps[i].gray, fps[j].gray));
          }
        scores.push({ groupId: c.group.id, maxHamming, maxColorMae, maxCellDiff: maxCell });
      }
      opts.onProgress?.(++done, candidates.length);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { candidateCount: candidates.length, scores };
}

export function passingGroupIds(scan: IdenticalScan, t: PixelThresholds): string[] {
  return scan.scores
    .filter((s) => s.maxHamming <= t.maxHamming && s.maxColorMae <= t.maxColorMae && s.maxCellDiff <= t.maxCellDiff)
    .map((s) => s.groupId);
}
