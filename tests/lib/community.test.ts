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
  it("matches a brute-force reference on random data with planted copies", () => {
    let seed = 7
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296) - 0.5
    const n = 60, dim = 16
    const rows: number[][] = []
    for (let i = 0; i < n; i++) {
      rows.push(i % 5 === 1 ? rows[i - 1].map((x) => x + rnd() * 0.02) : Array.from({ length: dim }, rnd))
    }
    const unit = rows.map(norm)
    const f = Float32Array.from(unit.flat())
    const threshold = 0.98
    const dot = (a: number[], b: number[]) => a.reduce((s, x, k) => s + x * b[k], 0)
    const ref: number[][] = []
    for (let i = 0; i < n; i++) {
      const c = unit.map((v, j) => [j, dot(unit[i], v)] as const).filter(([, d]) => d >= threshold)
      if (c.length >= 2) ref.push(c.sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([j]) => j))
    }
    expect(mergeCommunities(extractRowCommunities(f, n, dim, 0, n, threshold))).toEqual(mergeCommunities(ref))
  })
})
