import type { GpdMediaItem } from "./types";
import { buildThumbUrl } from "./photo-url";

// Local backup of items about to be trashed: a self-contained HTML contact
// sheet (embedded thumbnails, dates, link back to Google Photos). Nothing is
// uploaded. Chunked so a 13k-photo cleanup doesn't produce one giant file.

const THUMB_HEIGHT = 160;
export const SHEET_CHUNK = 1000;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface SheetEntry {
  item: GpdMediaItem;
  dataUrl: string | null;
}

export function renderSheet(entries: SheetEntry[], title: string): string {
  const cards = entries
    .map(({ item, dataUrl }) => {
      const name = escapeHtml(item.fileName || item.mediaKey);
      const taken = item.timestamp ? new Date(item.timestamp).toLocaleString() : "";
      const res = item.resWidth && item.resHeight ? `${item.resWidth}×${item.resHeight}` : "";
      const img = dataUrl ? `<img src="${dataUrl}" alt="${name}">` : `<div class="missing">no preview</div>`;
      const href = item.productUrl && /^https:\/\//.test(item.productUrl) ? escapeHtml(item.productUrl) : "";
      const link = href ? `<a href="${href}" target="_blank" rel="noreferrer">open</a>` : "";
      return `<figure>${img}<figcaption>${name}<br>${escapeHtml(taken)} ${res} ${link}</figcaption></figure>`;
    })
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:13px system-ui;margin:16px}main{display:flex;flex-wrap:wrap;gap:12px}
figure{margin:0;width:180px}img{height:160px;max-width:180px;object-fit:contain;background:#eee}
figcaption{color:#555;word-break:break-all}.missing{height:160px;background:#eee}</style>
<h1>${escapeHtml(title)}</h1><p>${entries.length} photos moved to Google Photos trash.</p><main>
${cards}
</main>`;
}

async function toDataUrl(item: GpdMediaItem): Promise<string | null> {
  try {
    const res = await fetch(buildThumbUrl(item.thumb, { height: THUMB_HEIGHT }), { credentials: "include" });
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const r = new FileReader();
      r.onloadend = () => resolve(typeof r.result === "string" ? r.result : null);
      r.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/** Builds the sheets one chunk at a time; calls onSheet so memory stays bounded. */
export async function buildContactSheets(
  items: GpdMediaItem[],
  onSheet: (filename: string, html: string) => void,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const stamp = new Date().toISOString().slice(0, 10);
  const chunks = Math.ceil(items.length / SHEET_CHUNK);
  let done = 0;
  for (let c = 0; c < chunks; c++) {
    const slice = items.slice(c * SHEET_CHUNK, (c + 1) * SHEET_CHUNK);
    const entries: SheetEntry[] = new Array(slice.length);
    let next = 0;
    const worker = async () => {
      for (let i = next++; i < slice.length; i = next++) {
        entries[i] = { item: slice[i], dataUrl: await toDataUrl(slice[i]) };
        onProgress?.(++done, items.length);
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    const name = `trashed-photos-${stamp}-part${c + 1}of${chunks}.html`;
    onSheet(name, renderSheet(entries, `Trashed photos ${stamp} (${c + 1}/${chunks})`));
  }
}
