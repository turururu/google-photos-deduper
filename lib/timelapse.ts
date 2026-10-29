import type { DuplicateGroup, GpdMediaItem } from "./types";
import { buildThumbUrl } from "./photo-url";

// Local "time-motion" backup: each duplicate group becomes a short clip of its
// photos in taken-time order, and the clips are concatenated into one video file.
// Recording is real time (MediaRecorder), so the frame count is capped; when
// there are more frames than the cap, whole groups are sampled evenly across
// the timeline so the selection is spread as far apart as possible.
// MP4 is preferred (Google Photos accepts it); WebM is the fallback.

export const FPS = 10;
export const DEFAULT_MAX_FRAMES = 1500; // ~2.5 min of recording
const WIDTH = 960;
const HEIGHT = 540;
const THUMB_HEIGHT = 400;

export interface Clip {
  groupId: string;
  items: GpdMediaItem[]; // sorted by taken time
}

export function buildClips(
  groups: DuplicateGroup[],
  mediaItems: Record<string, GpdMediaItem>,
): Clip[] {
  return groups
    .map((g) => ({
      groupId: g.id,
      items: g.mediaKeys
        .map((k) => mediaItems[k])
        .filter(Boolean)
        .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0)),
    }))
    .filter((c) => c.items.length > 1)
    .sort((a, b) => (a.items[0].timestamp ?? 0) - (b.items[0].timestamp ?? 0));
}

/** Evenly spaced subset of clips (by timeline position) that fits maxFrames. */
export function sampleClips(clips: Clip[], maxFrames: number): Clip[] {
  const total = clips.reduce((s, c) => s + c.items.length, 0);
  if (total <= maxFrames) return clips;
  const avg = total / clips.length;
  const k = Math.max(1, Math.floor(maxFrames / avg));
  if (k >= clips.length) return clips;
  if (k === 1) return [clips[Math.floor((clips.length - 1) / 2)]];
  const picked: Clip[] = [];
  let frames = 0;
  for (let i = 0; i < k; i++) {
    const clip = clips[Math.round((i * (clips.length - 1)) / (k - 1))];
    if (frames + clip.items.length > maxFrames) break;
    picked.push(clip);
    frames += clip.items.length;
  }
  return picked;
}

async function loadBitmap(item: GpdMediaItem): Promise<ImageBitmap | null> {
  try {
    const res = await fetch(buildThumbUrl(item.thumb, { height: THUMB_HEIGHT }), {
      credentials: "include",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return await createImageBitmap(await res.blob());
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function pickMimeType(): string | null {
  for (const t of [
    "video/mp4;codecs=avc1",
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ]) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) return t;
  }
  return null;
}

export async function renderTimelapse(
  clips: Clip[],
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
  opts: { fps?: number; bitrate?: number } = {},
): Promise<{ blob: Blob; ext: "mp4" | "webm" }> {
  const fps = opts.fps ?? FPS;
  const mime = pickMimeType();
  if (!mime) throw new Error("This browser cannot record video.");
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext("2d")!;
  const stream = canvas.captureStream(fps);
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: opts.bitrate ?? 2_500_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise<void>((r) => (recorder.onstop = () => r()));

  const total = clips.reduce((s, c) => s + c.items.length, 0);
  let done = 0;
  // Load one clip ahead so network time doesn't stretch the held frames.
  const loadClip = (c: Clip) => Promise.all(c.items.map(loadBitmap));
  let pending = clips.length ? loadClip(clips[0]) : Promise.resolve([] as (ImageBitmap | null)[]);
  await pending; // don't record dead air while the first clip downloads
  recorder.start(1000);
  try {
    for (let ci = 0; ci < clips.length; ci++) {
      const clip = clips[ci];
      const bitmaps = await pending;
      pending = ci + 1 < clips.length ? loadClip(clips[ci + 1]) : Promise.resolve([]);
      for (let fi = 0; fi < clip.items.length; fi++) {
        signal?.throwIfAborted();
        const item = clip.items[fi];
        const bmp = bitmaps[fi];
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, WIDTH, HEIGHT);
        if (bmp) {
          const scale = Math.min(WIDTH / bmp.width, (HEIGHT - 40) / bmp.height);
          const w = bmp.width * scale;
          const h = bmp.height * scale;
          ctx.drawImage(bmp, (WIDTH - w) / 2, (HEIGHT - 40 - h) / 2, w, h);
          bmp.close();
        }
        ctx.fillStyle = "#fff";
        ctx.font = "16px system-ui";
        const when = item.timestamp ? new Date(item.timestamp).toLocaleString() : "";
        ctx.fillText(`${when}  ${item.fileName ?? ""}`, 12, HEIGHT - 14);
        await sleep(1000 / fps);
        onProgress?.(++done, total);
      }
      // brief hold between groups so clips are distinguishable
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      await sleep(1000 / fps);
    }
  } finally {
    if (recorder.state !== "inactive") recorder.stop();
    await stopped;
  }
  const ext = mime.startsWith("video/mp4") ? "mp4" : "webm";
  return { blob: new Blob(chunks, { type: `video/${ext}` }), ext };
}

// ------------------------------------------------------------
// One dated file per group
// ------------------------------------------------------------

const MP4_EPOCH_OFFSET = 2_082_844_800; // seconds between 1904-01-01 and 1970-01-01

/**
 * Stamps creation/modification times into every mvhd/tkhd/mdhd box so Google
 * Photos files the video under the original photo's date. MediaRecorder leaves
 * them at zero. Returns false if no box was found (e.g. WebM).
 */
export function patchMp4Dates(buf: Uint8Array, unixMs: number): boolean {
  const secs = Math.floor(unixMs / 1000) + MP4_EPOCH_OFFSET;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let patched = false;
  const type = (i: number) => String.fromCharCode(buf[i], buf[i + 1], buf[i + 2], buf[i + 3]);
  const stamp = (box: number) => {
    // box: offset of the size field; fullbox header = size(4) type(4) version/flags(4)
    const version = buf[box + 8];
    if (version === 0 && box + 20 <= buf.length) {
      view.setUint32(box + 12, secs);
      view.setUint32(box + 16, secs);
      patched = true;
    } else if (version === 1 && box + 28 <= buf.length) {
      view.setBigUint64(box + 12, BigInt(secs));
      view.setBigUint64(box + 20, BigInt(secs));
      patched = true;
    }
  };
  const walk = (start: number, end: number) => {
    let pos = start;
    while (pos + 8 <= end) {
      let size = view.getUint32(pos);
      const t = type(pos + 4);
      if (size === 1) {
        if (pos + 16 > end) return;
        size = Number(view.getBigUint64(pos + 8));
      } else if (size === 0) size = end - pos;
      if (size < 8 || pos + size > end) return;
      if (t === "mvhd" || t === "tkhd" || t === "mdhd") stamp(pos);
      else if (t === "moov" || t === "trak" || t === "mdia") walk(pos + 8, pos + size);
      pos += size;
    }
  };
  walk(0, buf.length);
  return patched;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** VID_YYYYMMDD_HHMMSS (local time) — a pattern Google Photos reads dates from. */
export function clipFileStem(takenMs: number): string {
  const d = new Date(takenMs);
  return `VID_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export const GROUP_CLIP_FPS = 4;
export const GROUP_CLIP_BITRATE = 600_000;
export const MAX_GROUP_CLIP_FRAMES = 4000; // ~17 min of real-time recording

/** Shell script that sets each file's modified time to the photo's taken date. */
export function buildTouchScript(stamps: { name: string; taken: number }[]): string {
  const lines = stamps.map(({ name, taken }) => {
    const d = new Date(taken);
    const t = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
    return `touch -t ${t} '${name.replace(/'/g, "'\\''")}'`;
  });
  return `#!/bin/sh\n# Run from this folder: sh set-dates.sh\ncd "$(dirname "$0")" || exit 1\n${lines.join("\n")}\n`;
}

interface DirHandle {
  getFileHandle(name: string, o: { create: boolean }): Promise<{
    createWritable(): Promise<{ write(b: Blob | Uint8Array): Promise<void>; close(): Promise<void> }>;
  }>;
}

/** Records one small dated video per group into a user-chosen folder. */
export async function writeGroupClips(
  dir: DirHandle,
  clips: Clip[],
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<{ files: number; bytes: number; dated: boolean }> {
  const total = clips.reduce((s, c) => s + c.items.length, 0);
  let done = 0;
  let bytes = 0;
  let dated = true;
  const used = new Set<string>();
  const stamps: { name: string; taken: number }[] = [];
  try {
    for (const clip of clips) {
      signal?.throwIfAborted();
      const taken = clip.items[0].timestamp || Date.now();
      const { blob, ext } = await renderTimelapse([clip], undefined, signal, {
        fps: GROUP_CLIP_FPS,
        bitrate: GROUP_CLIP_BITRATE,
      });
      const data = new Uint8Array(await blob.arrayBuffer());
      if (ext !== "mp4" || !patchMp4Dates(data, taken)) dated = false;
      let stem = clipFileStem(taken);
      for (let n = 2; used.has(stem); n++) stem = `${clipFileStem(taken)}_${n}`;
      used.add(stem);
      const handle = await dir.getFileHandle(`${stem}.${ext}`, { create: true });
      const w = await handle.createWritable();
      await w.write(data);
      await w.close();
      stamps.push({ name: `${stem}.${ext}`, taken });
      bytes += data.byteLength;
      done += clip.items.length;
      onProgress?.(done, total);
    }
  } finally {
    // Browsers can't set a file's modified time, so ship a script that does.
    const script = (await dir.getFileHandle("set-dates.sh", { create: true }));
    const sw = await script.createWritable();
    await sw.write(new Blob([buildTouchScript(stamps)]));
    await sw.close();
  }
  return { files: stamps.length, bytes, dated };
}
