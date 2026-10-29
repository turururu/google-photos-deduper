import { describe, it, expect } from "vitest"
import { applyViewPrefs, effectiveSelection, trashScope, persistablePrefs, DEFAULT_VIEW_PREFS as DEFAULTS } from "../../lib/group-view"
import type { GpdMediaItem, DuplicateGroup } from "../../lib/types"

const it_ = (k: string, o: Partial<GpdMediaItem> = {}): GpdMediaItem => ({
  mediaKey: k, dedupKey: k, thumb: "", timestamp: 1000, creationTimestamp: 1, resWidth: 10, resHeight: 10, ...o,
})
const items: Record<string, GpdMediaItem> = Object.fromEntries(
  [it_("a1", { timestamp: 9000 }), it_("a2", { timestamp: 9000 }), it_("b1", { timestamp: 5000 }), it_("b2", { isFavorite: true }), it_("b3"),
   it_("c1", { resWidth: 100, resHeight: 100 }), it_("c2")].map((i) => [i.mediaKey, i]))
const groups: DuplicateGroup[] = [
  { id: "A", mediaKeys: ["a1", "a2"], originalMediaKey: "a1", similarity: 0.991 },
  { id: "B", mediaKeys: ["b1", "b2", "b3"], originalMediaKey: "b1", similarity: 0.999 },
  { id: "C", mediaKeys: ["c1", "c2"], originalMediaKey: "c1", similarity: 0.995 },
]
const BASE = { ...DEFAULTS, noFavorites: false }
const ids = (p = {}) => applyViewPrefs(groups, items, { ...BASE, ...p }).map((g) => g.id)

describe("applyViewPrefs", () => {
  it("sorts by similarity desc by default", () => expect(ids()).toEqual(["B", "C", "A"]))
  it("sorts ascending", () => expect(ids({ sort: "similarity-asc" })).toEqual(["A", "C", "B"]))
  it("sorts by group size", () => expect(ids({ sort: "size-desc" })[0]).toBe("B"))
  it("sorts by removable pixels", () => expect(ids({ sort: "removable-desc" })[0]).toBe("B"))
  it("sorts by taken date", () => expect(ids({ sort: "taken-desc" })[0]).toBe("A"))
  it("filters similarity range", () => expect(ids({ minSimilarity: 0.995, maxSimilarity: 0.999 })).toEqual(["B", "C"]))
  it("only pairs", () => expect(ids({ onlyPairs: true })).not.toContain("B"))
  it("no favorites", () => expect(ids({ noFavorites: true })).not.toContain("B"))
})

describe("effectiveSelection", () => {
  it("excludes selected groups hidden by filters", () => {
    const shown = applyViewPrefs(groups, items, { ...BASE, minSimilarity: 0.995 })
    const eff = effectiveSelection(new Set(["A", "B", "C"]), shown)
    expect([...eff].sort()).toEqual(["B", "C"])
  })
  it("equals the selection when nothing is filtered", () => {
    const eff = effectiveSelection(new Set(["A"]), applyViewPrefs(groups, items, BASE))
    expect([...eff]).toEqual(["A"])
  })
})

describe("date range and reviewed", () => {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
  it("filters by taken date (inclusive days)", () => {
    const t = new Date("2024-05-10T12:00:00").getTime()
    const m = { x1: it_("x1", { timestamp: t }), x2: it_("x2", { timestamp: t }), y1: it_("y1", { timestamp: 1000 }), y2: it_("y2", { timestamp: 1000 }) }
    const gs: DuplicateGroup[] = [
      { id: "X", mediaKeys: ["x1", "x2"], originalMediaKey: "x1", similarity: 1 },
      { id: "Y", mediaKeys: ["y1", "y2"], originalMediaKey: "y1", similarity: 1 },
    ]
    const r = (p = {}) => applyViewPrefs(gs, m, { ...BASE, ...p }).map((g) => g.id)
    expect(r({ takenFrom: "2024-05-10", takenTo: "2024-05-10" })).toEqual(["X"])
    expect(r({ takenTo: "2024-01-01" })).toEqual(["Y"])
    expect(day(t)).toBeTruthy()
  })
  it("hides reviewed groups", () => {
    const r = applyViewPrefs(groups, items, { ...BASE, hideReviewed: true }, new Set(["B"])).map((g) => g.id)
    expect(r).not.toContain("B")
  })
  it("does not persist the date range", () => {
    expect(persistablePrefs({ ...BASE, takenFrom: "2024-01-01" }).takenFrom).toBe("")
  })
})

describe("trashScope", () => {
  it("keeps reviewed+selected groups trashable while Hide reviewed is on", () => {
    const prefs = { ...BASE, hideReviewed: true }
    const reviewed = new Set(["B"])
    const shown = applyViewPrefs(groups, items, prefs, reviewed)
    expect(shown.map((g) => g.id)).not.toContain("B")
    const eff = effectiveSelection(new Set(["B"]), trashScope(groups, items, prefs, reviewed))
    expect([...eff]).toEqual(["B"])
  })
  it("still honors other filters", () => {
    const prefs = { ...BASE, hideReviewed: true, onlyPairs: true }
    expect(trashScope(groups, items, prefs, new Set()).map((g) => g.id)).not.toContain("B")
  })
})

describe("selection filter", () => {
  const snap = new Set(["A", "C"])
  const run = (selection: "all" | "selected" | "unselected") =>
    applyViewPrefs(groups, items, { ...BASE, selection }, undefined, snap).map((g) => g.id)
  it("shows only marked or only unmarked, judged on the snapshot", () => {
    expect(run("selected").sort()).toEqual(["A", "C"])
    expect(run("unselected")).toEqual(["B"])
    expect(run("all")).toHaveLength(3)
  })
  it("trashScope ignores it and persistablePrefs strips it", () => {
    expect(trashScope(groups, items, { ...BASE, selection: "selected" }).length).toBe(3)
    expect(persistablePrefs({ ...BASE, selection: "selected" }).selection).toBe("all")
  })
})

describe("space-aware view", () => {
  const sp = (k: string, o: Partial<GpdMediaItem>) => ({ ...items[k], ...o })
  const m = {
    ...items,
    a1: sp("a1", { spaceTaken: 5e6, takesUpSpace: true }), a2: sp("a2", { spaceTaken: 0, takesUpSpace: false }),
    c1: sp("c1", { spaceTaken: 3e6, takesUpSpace: true }), c2: sp("c2", { spaceTaken: 2e6, takesUpSpace: true }),
    b1: sp("b1", {}), b2: sp("b2", {}), b3: sp("b3", {}),
  }
  const run = (p = {}) => applyViewPrefs(groups, m, { ...BASE, ...p }).map((g) => g.id)
  it("sorts by quota freed, known sizes first", () =>
    expect(run({ sort: "removable-desc" })).toEqual(["C", "A", "B"]))
  it("freesSpace hides groups that free nothing", () => {
    expect(run({ freesSpace: true })).not.toContain("A")
    expect(run({ freesSpace: true })).toContain("B") // unknown sizes stay visible
  })
})
