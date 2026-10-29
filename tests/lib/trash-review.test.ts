import { describe, it, expect } from "vitest"
import { reviewTrash } from "../../lib/trash-review"

const T = { maxHamming: 2, maxColorMae: 4, maxCellDiff: 24 }
const mk = (k: string) => ({ mediaKey: k, dedupKey: k, thumb: "", timestamp: 1_000_000, resWidth: 2000, resHeight: 1500 }) as any
const items = (ks: string[]) => Object.fromEntries(ks.map((k) => [k, mk(k)]))
const grp = (id: string, keys: string[]) => ({ id, mediaKeys: keys, originalMediaKey: keys[0], similarity: 0.9 })
const scanOf = (id: string, a: string, b: string, cellDiff: number) =>
  ({ groupsScanned: 1, skipped: {}, pairs: { [id]: [{ a, b, hamming: 0, colorMae: 0, cellDiff }] } })

describe("reviewTrash", () => {
  const g = grp("g", ["a", "b"])
  const it_ = items(["a", "b"])
  const keep = (s: string[]) => () => new Set(s)

  it("proves a trashed photo against its keeper", () => {
    const r = reviewTrash([g], it_, keep(["a"]), scanOf("g", "a", "b", 3), T)
    expect(r.rows).toEqual([expect.objectContaining({ key: "b", keeperKey: "a", status: "proven" })])
  })
  it("is unproven when the pair fails or was not scanned", () => {
    expect(reviewTrash([g], it_, keep(["a"]), scanOf("g", "a", "b", 90), T).counts.unproven).toBe(1)
    expect(reviewTrash([g], it_, keep(["a"]), null, T).counts.unproven).toBe(1)
  })
  it("flags a group with no survivor", () => {
    expect(reviewTrash([g], it_, keep([]), null, T).counts["no-keeper"]).toBe(2)
  })
  it("flags a photo that another group keeps", () => {
    const g2 = grp("h", ["b", "c"])
    const r = reviewTrash([g, g2], items(["a", "b", "c"]), (x) => new Set(x.id === "g" ? ["a"] : ["b"]), null, T)
    expect(r.rows.find((x) => x.groupId === "g")!.status).toBe("conflict")
  })
})
