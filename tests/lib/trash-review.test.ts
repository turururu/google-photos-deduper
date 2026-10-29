import { describe, it, expect } from "vitest"
import { reviewTrash } from "../../lib/trash-review"

const mk = (k: string, w = 2000, h = 1500) => ({ mediaKey: k, dedupKey: k, thumb: "", timestamp: 1_000_000, resWidth: w, resHeight: h }) as any
const items = (ks: string[]) => Object.fromEntries(ks.map((k) => [k, mk(k)]))
const grp = (id: string, keys: string[]) => ({ id, mediaKeys: keys, originalMediaKey: keys[0], similarity: 0.9 })
// unit vectors with a chosen cosine to [1,0]
const vec = (cos: number) => new Float32Array([cos, Math.sqrt(1 - cos * cos)])
const embs = (o: Record<string, number>) => new Map(Object.entries(o).map(([k, c]) => [k, vec(c)]))

describe("reviewTrash", () => {
  const g = grp("g", ["a", "b"])
  const it_ = items(["a", "b"])
  const keep = (s: string[]) => () => new Set(s)

  it("matches a trashed photo to a close keeper of similar resolution", () => {
    const r = reviewTrash([g], it_, keep(["a"]), new Set(["b"]), embs({ a: 1, b: 0.99 }))
    expect(r.rows).toEqual([expect.objectContaining({ key: "b", keeperKey: "a", status: "matched" })])
  })
  it("no-match when too different, resolution differs, or nothing is loaded", () => {
    expect(reviewTrash([g], it_, keep(["a"]), new Set(["b"]), embs({ a: 1, b: 0.9 })).counts["no-match"]).toBe(1)
    expect(reviewTrash([g], it_, keep(["a"]), new Set(["b"]), null).counts["no-match"]).toBe(1)
    const res = { a: mk("a"), b: mk("b", 1000, 750) }
    expect(reviewTrash([g], res, keep(["a"]), new Set(["b"]), embs({ a: 1, b: 0.99 })).counts["no-match"]).toBe(1)
  })
  it("flags a group with no survivor", () => {
    expect(reviewTrash([g], it_, keep([]), new Set(["a", "b"]), null).counts["no-keeper"]).toBe(2)
  })
  it("flags a photo that another group keeps", () => {
    const g2 = grp("h", ["b", "c"])
    const r = reviewTrash([g, g2], items(["a", "b", "c"]), (x) => new Set(x.id === "g" ? ["a"] : ["b"]), new Set(["b", "c"]), null)
    expect(r.rows.find((x) => x.groupId === "g")!.status).toBe("conflict")
  })
  it("any matching keeper is enough, not just the closest in time", () => {
    const g3 = grp("g", ["a", "b", "d"])
    const r = reviewTrash([g3], items(["a", "b", "d"]), keep(["a", "d"]), new Set(["b"]), embs({ a: 1, b: 0.99, d: 0.5 }))
    expect(r.rows[0]).toEqual(expect.objectContaining({ status: "matched", keeperKey: "a" }))
  })
  it("rows follow the trash set: dropped photos vanish and clear conflicts", () => {
    const g2 = grp("h", ["b", "c"])
    const kept = (x: any) => new Set(x.id === "g" ? ["a"] : ["b"])
    const all = items(["a", "b", "c"])
    expect(reviewTrash([g, g2], all, kept, new Set(["b", "c"]), null).counts.conflict).toBeGreaterThan(0)
    const shrunk = reviewTrash([g, g2], all, kept, new Set(["c"]), null)
    expect(shrunk.rows.map((r) => r.key)).toEqual(["c"])
    expect(shrunk.counts.conflict).toBe(0)
  })
})
