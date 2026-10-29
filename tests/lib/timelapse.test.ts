import { describe, it, expect } from "vitest"
import { buildClips, sampleClips, patchMp4Dates, clipFileStem, buildTouchScript } from "../../lib/timelapse"
import type { GpdMediaItem, DuplicateGroup } from "../../lib/types"

const mk = (k: string, t: number): GpdMediaItem => ({ mediaKey: k, dedupKey: k, thumb: "", timestamp: t, creationTimestamp: 0 })

describe("timelapse clips", () => {
  const items: Record<string, GpdMediaItem> = {}
  const groups: DuplicateGroup[] = []
  for (let g = 0; g < 100; g++) {
    const a = `a${g}`, b = `b${g}`
    items[a] = mk(a, g * 1000 + 5)
    items[b] = mk(b, g * 1000)
    groups.push({ id: `g${g}`, mediaKeys: [a, b], originalMediaKey: a, similarity: 1 })
  }
  it("orders frames within a clip and clips by time", () => {
    const clips = buildClips([...groups].reverse(), items)
    expect(clips[0].groupId).toBe("g0")
    expect(clips[0].items.map((i) => i.mediaKey)).toEqual(["b0", "a0"])
  })
  it("keeps everything under the cap", () => {
    expect(sampleClips(buildClips(groups, items), 1000)).toHaveLength(100)
  })
  it("samples evenly spread clips over the cap", () => {
    const s = sampleClips(buildClips(groups, items), 20)
    expect(s.length).toBe(10)
    expect(s.reduce((n, c) => n + c.items.length, 0)).toBeLessThanOrEqual(20)
    expect(s[0].groupId).toBe("g0")
    expect(s[s.length - 1].groupId).toBe("g99")
    const idx = s.map((c) => Number(c.groupId.slice(1)))
    const gaps = idx.slice(1).map((v, i) => v - idx[i])
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1)
  })
})

describe("dated clip files", () => {
  const be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
  const mk = (t: string, payload: number[]) => [...be(8 + payload.length), ...[...t].map((c) => c.charCodeAt(0)), ...payload]
  const mvhd = () => mk("mvhd", [0, 0, 0, 0, ...new Array(16).fill(0)])
  it("stamps creation time into mvhd inside moov", () => {
    const b = new Uint8Array([...mk("moov", mvhd())])
    expect(patchMp4Dates(b, Date.UTC(2024, 4, 10, 12, 0, 0))).toBe(true)
    // moov header 8 + mvhd header 8 + version/flags 4 = creation at 20
    expect(new DataView(b.buffer).getUint32(20)).toBe(Math.floor(Date.UTC(2024, 4, 10, 12) / 1000) + 2082844800)
  })
  it("ignores header-like bytes inside mdat", () => {
    const fake = mk("mvhd", new Array(24).fill(7))
    const b = new Uint8Array([...mk("mdat", fake)])
    const before = Array.from(b)
    expect(patchMp4Dates(b, 0)).toBe(false)
    expect(Array.from(b)).toEqual(before)
  })
  it("reports false when there is no mp4 header", () => {
    expect(patchMp4Dates(new Uint8Array(64), 0)).toBe(false)
  })
  it("builds a Photos-parsable local-time filename", () => {
    expect(clipFileStem(new Date(2024, 4, 10, 7, 5, 9).getTime())).toBe("VID_20240510_070509")
  })
})

it("builds a touch script with local-time stamps", () => {
  const out = buildTouchScript([{ name: "VID_a.mp4", taken: new Date(2024, 4, 10, 7, 5, 9).getTime() }])
  expect(out).toContain("touch -t 202405100705.09 'VID_a.mp4'")
})
