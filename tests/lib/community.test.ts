import { describe, it, expect } from "vitest"
import { extractRowCommunities, mergeCommunities, rowCluster } from "../../lib/community"
import { detectWorkerCount } from "../../lib/duplicate-detector"

// Unit vectors: two pairs of near-copies and a loner.
const vecs = [[1, 0, 0, 0, 0], [0.999, 0.045, 0, 0, 0], [0, 1, 0, 0, 0], [0, 0.999, 0.045, 0, 0], [0, 0, 0, 1, 0]]
const norm = (v: number[]) => { const l = Math.hypot(...v); return v.map((x) => x / l) }
const flat = Float32Array.from(vecs.flatMap(norm))

describe("community pieces", () => {
  it("rowCluster needs two qualifying items and orders best first", () => {
    expect(rowCluster(Float32Array.of(1, 0.2, 0.95), 0.9)).toEqual([0, 2])
    expect(rowCluster(Float32Array.of(1, 0.2, 0.3), 0.9)).toBeNull()
  })
  it("blocks over any row split merge to the same groups", () => {
    const whole = mergeCommunities(extractRowCommunities(flat, 5, 5, 0, 5, 0.99))
    const split = mergeCommunities([
      ...extractRowCommunities(flat, 5, 5, 0, 2, 0.99),
      ...extractRowCommunities(flat, 5, 5, 2, 5, 0.99),
    ])
    expect(split).toEqual(whole)
    expect(whole.map((g) => g.join())).toEqual(["0,1", "2,3"])
  })
  it("merge keeps each item in one community, largest first", () => {
    expect(mergeCommunities([[1, 2], [1, 2, 3], [4, 5]])).toEqual([[1, 2, 3], [4, 5]])
  })
  it("worker count respects cores and memory", () => {
    expect(detectWorkerCount(1000, 1024, 16)).toBe(6)
    expect(detectWorkerCount(1000, 1024, 3)).toBe(1)
    expect(detectWorkerCount(500_000, 1024, 16)).toBe(1)
  })
})
