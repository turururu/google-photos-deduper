import { describe, it, expect } from "vitest"
import { nearExactExclusions, isNearExactCandidate } from "../../lib/near-exact"
import type { GpdMediaItem } from "../../lib/types"

const item = (o: Partial<GpdMediaItem> = {}): GpdMediaItem => ({
  mediaKey: Math.random().toString(36),
  dedupKey: "",
  thumb: "",
  timestamp: 1_700_000_000_000,
  creationTimestamp: 1,
  resWidth: 4000,
  resHeight: 3000,
  isOriginalQuality: true,
  ...o,
})

// A clearly-better item (more pixels) so the keep pick is unambiguous.
const pair = (a: Partial<GpdMediaItem> = {}, b: Partial<GpdMediaItem> = {}) => [
  item({ resWidth: 4000, resHeight: 3000, ...a }),
  item({ resWidth: 2000, resHeight: 1500, ...b }),
]

describe("nearExactExclusions", () => {
  it("accepts a clean pair", () => {
    expect(isNearExactCandidate(pair(), 0.999)).toBe(true)
  })
  it("excludes low similarity", () => {
    expect(nearExactExclusions(pair(), 0.99)).toContain("similarity")
  })
  it("excludes groups larger than 4", () => {
    const g = [...pair(), item({ resWidth: 1000, resHeight: 750 }), item({ resWidth: 500, resHeight: 375 }), item({ resWidth: 250, resHeight: 187.5 })]
    expect(nearExactExclusions(g, 0.999)).toContain("size")
  })
  it("excludes taken dates >2 s apart (ms units)", () => {
    expect(nearExactExclusions(pair({}, { timestamp: 1_700_000_003_000 }), 0.999)).toContain("time")
    expect(nearExactExclusions(pair({}, { timestamp: 1_700_000_002_000 }), 0.999)).not.toContain("time")
  })
  it("excludes videos", () => {
    expect(nearExactExclusions(pair({ duration: 5 }), 0.999)).toContain("video")
  })
  it("excludes different orientation / aspect", () => {
    expect(nearExactExclusions(pair({}, { resWidth: 1500, resHeight: 2000 }), 0.999)).toContain("aspect")
    expect(nearExactExclusions(pair({}, { resWidth: 2000, resHeight: 1400 }), 0.999)).toContain("aspect")
  })
  it("excludes missing dimensions", () => {
    expect(nearExactExclusions(pair({}, { resWidth: undefined }), 0.999)).toContain("aspect")
  })
  it("excludes multiple favorites", () => {
    expect(nearExactExclusions(pair({ isFavorite: true }, { isFavorite: true }), 0.999)).toContain("multiple-favorites")
  })
  it("allows tied keep pick (pixel check decides)", () => {
    const same = [item(), item({ creationTimestamp: 2 })]
    expect(nearExactExclusions(same, 0.999)).toEqual([])
  })
})
