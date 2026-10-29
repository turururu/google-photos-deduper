import { describe, it, expect } from "vitest"
import { buildTrashBatch, keepPhotos } from "../../lib/trash-batch"

const mk = (k: string) => ({ mediaKey: k, dedupKey: "d" + k }) as any
const items = Object.fromEntries(["a", "b", "c", "d", "e"].map((k) => [k, mk(k)]))
const g1 = { id: "g1", mediaKeys: ["a", "b"], originalMediaKey: "a", similarity: 0.9 }
const g2 = { id: "g2", mediaKeys: ["c", "d", "e"], originalMediaKey: "c", similarity: 0.9 }
const groups = [g1, g2]
const marked = new Set(["g1", "g2"])

describe("trash batch", () => {
  it("restoring a photo from another group keeps the whole-group count", () => {
    const base: Record<string, Set<string>> = { g1: new Set(), g2: new Set(["c"]) }
    const keptOf = (g: any) => base[g.id]
    expect(buildTrashBatch(groups, items, marked, keptOf, new Set()).fullyTrashedGroups).toBe(1)
    const next = keepPhotos(base, groups, new Set(["d"]), keptOf)
    const b = buildTrashBatch(groups, items, marked, (g: any) => next[g.id], new Set())
    expect(b.fullyTrashedGroups).toBe(1)
    expect(b.mediaKeysToTrash.sort()).toEqual(["a", "b", "e"])
  })
  it("restoring from a whole-group trash ends the warning", () => {
    const base: Record<string, Set<string>> = { g1: new Set(), g2: new Set(["c"]) }
    const next = keepPhotos(base, groups, new Set(["a"]), (g: any) => base[g.id])
    expect(buildTrashBatch(groups, items, marked, (g: any) => next[g.id], new Set()).fullyTrashedGroups).toBe(0)
  })
})
