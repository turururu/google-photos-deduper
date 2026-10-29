import { describe, it, expect } from "vitest"
import { planGroup, provenIdentical } from "../../lib/identical-plan"

const T = { maxHamming: 2, maxColorMae: 4, maxCellDiff: 24 }
const mk = (k: string, o: any = {}) => ({
  mediaKey: k, dedupKey: k, thumb: "", timestamp: 1_000_000, creationTimestamp: Number(k.charCodeAt(0)),
  resWidth: 2000, resHeight: 1500, ...o,
})
const same = (a: string, b: string) => ({ a, b, hamming: 0, colorMae: 0, cellDiff: 0 })
const diff = (a: string, b: string) => ({ a, b, hamming: 9, colorMae: 30, cellDiff: 90 })
const grp = (keys: string[]) => ({ id: "g", mediaKeys: keys, originalMediaKey: keys[0], similarity: 0.95 })
const items = (list: any[]) => Object.fromEntries(list.map((i) => [i.mediaKey, i]))
const opts = { keepOrder: "oldest" as const }

describe("planGroup", () => {
  it("fully identical group keeps exactly one", () => {
    const it = items([mk("a"), mk("b"), mk("c")])
    const p = planGroup(grp(["a", "b", "c"]), it, [same("a", "b"), same("a", "c"), same("b", "c")], T, opts)!
    expect(p.kept).toEqual(["a"])
    expect(p.trash.map((t) => t.key).sort()).toEqual(["b", "c"])
    expect(p.fully).toBe(true)
  })
  it("mixed group keeps representative plus unmatched photo", () => {
    const it = items([mk("a"), mk("b"), mk("c")])
    const p = planGroup(grp(["a", "b", "c"]), it, [same("a", "b"), diff("a", "c"), diff("b", "c")], T, opts)!
    expect(p.kept.sort()).toEqual(["a", "c"])
    expect(p.trash.map((t) => t.key)).toEqual(["b"])
    expect(p.fully).toBe(false)
  })
  it("never chains: A≈B, B≈C, A≉C trashes only B", () => {
    const it = items([mk("a"), mk("b"), mk("c")])
    const p = planGroup(grp(["a", "b", "c"]), it, [same("a", "b"), diff("a", "c"), same("b", "c")], T, opts)!
    expect(p.trash.map((t) => t.key)).toEqual(["b"])
    expect(p.kept.sort()).toEqual(["a", "c"])
    // every trashed photo is matched to a photo that stays
    for (const t of p.trash) expect(p.kept).toContain(t.keptKey)
  })
  it("never trashes a favorite", () => {
    const it = items([mk("a"), mk("b", { isFavorite: true })])
    const p = planGroup(grp(["a", "b"]), it, [same("a", "b")], T, opts)!
    expect(p.trash.map((t) => t.key)).toEqual(["a"]) // favorite ranks first and stays
    const none = planGroup(grp(["a", "b"]), items([mk("a", { isFavorite: true }), mk("b", { isFavorite: true })]), [same("a", "b")], T, opts)!
    expect(none.trash).toEqual([])
  })
  it("never trashes an existing override and uses it as representative", () => {
    const it = items([mk("a"), mk("b"), mk("c")])
    const p = planGroup(grp(["a", "b", "c"]), it, [same("a", "b"), same("a", "c"), same("b", "c")], T, { ...opts, existingKept: new Set(["c"]) })!
    expect(p.kept).toContain("c")
    expect(p.trash.map((t) => t.key)).not.toContain("c")
    expect(p.trash.every((t) => t.keptKey === "c")).toBe(true)
  })
  it("respects keep order for the representative", () => {
    const it = items([mk("a"), mk("b")])
    const old = planGroup(grp(["a", "b"]), it, [same("a", "b")], T, { keepOrder: "oldest" })!
    const nw = planGroup(grp(["a", "b"]), it, [same("a", "b")], T, { keepOrder: "newest" })!
    expect(old.kept).toEqual(["a"])
    expect(nw.kept).toEqual(["b"])
  })
  it("ignores a pair whose metadata disagrees (time apart)", () => {
    const it = items([mk("a"), mk("b", { timestamp: 1_000_000 + 60_000 })])
    const p = planGroup(grp(["a", "b"]), it, [same("a", "b")], T, opts)!
    expect(p.trash).toEqual([])
  })
})

describe("provenIdentical", () => {
  it("only flags trashed photos identical to a kept photo", () => {
    const it = items([mk("a"), mk("b"), mk("c")])
    const s = provenIdentical(grp(["a", "b", "c"]), it, [same("a", "b"), diff("a", "c"), diff("b", "c")], T, new Set(["b", "c"]))
    expect([...s]).toEqual(["b"])
  })
})

import { applyPlans } from "../../lib/identical-plan"
describe("applyPlans", () => {
  it("never deselects a group or drops a kept photo", () => {
    const r = applyPlans(new Set(["X", "G"]), { G: new Set(["k1"]) }, [{ groupId: "G", kept: ["k2"], trash: [], fully: true }])
    expect([...r.selected].sort()).toEqual(["G", "X"])
    expect([...r.kept.G].sort()).toEqual(["k1", "k2"])
  })
})
