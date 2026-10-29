import { describe, it, expect } from "vitest"
import { planGroup, provenIdentical, explainMisses } from "../../lib/identical-plan"
import { DEFAULT_NEAR_EXACT } from "../../lib/near-exact"

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

import { filterPlans, effectiveFloor, FLOOR_OFF } from "../../lib/identical-plan"
describe("filterPlans", () => {
  const plan = (groupId: string, fully: boolean) => ({ groupId, kept: ["k"], trash: [], fully })
  const groups = [
    { id: "hi", mediaKeys: [], originalMediaKey: "", similarity: 0.998 },
    { id: "lo", mediaKeys: [], originalMediaKey: "", similarity: 0.7 },
    { id: "mix", mediaKeys: [], originalMediaKey: "", similarity: 0.998 },
  ]
  const plans = [plan("hi", true), plan("lo", true), plan("mix", false)]
  it("drops mixed plans and low-similarity groups by default", () => {
    expect(filterPlans(plans, groups, { includeMixed: false, minSimilarity: 0.99 }).map((p) => p.groupId)).toEqual(["hi"])
  })
  it("includes mixed on request and can disable the floor", () => {
    expect(filterPlans(plans, groups, { includeMixed: true, minSimilarity: null }).map((p) => p.groupId)).toEqual(["hi", "lo", "mix"])
  })
})

describe("floor off still protects mixed low-similarity groups", () => {
  it("one identical pair among different photos is excluded without includeMixed", () => {
    const its = items([mk("a"), mk("b"), mk("c"), mk("d")])
    const g = { ...grp(["a", "b", "c", "d"]), similarity: 0.7 }
    const sc = [same("a", "b"), diff("a", "c"), diff("a", "d"), diff("b", "c"), diff("b", "d"), diff("c", "d")]
    const plan = planGroup(g, its, sc, T, opts)!
    expect(plan.fully).toBe(false)
    expect(filterPlans([plan], [g], { includeMixed: false, minSimilarity: effectiveFloor(0.8, true) })).toEqual([])
  })
  it("effectiveFloor is null when off or similarities are fake", () => {
    expect(effectiveFloor(FLOOR_OFF, true)).toBeNull()
    expect(effectiveFloor(0.95, false)).toBeNull()
    expect(effectiveFloor(0.95, true)).toBe(0.95)
  })
})

describe("applyPlans replace", () => {
  it("drops stale marks but keeps kept photos", () => {
    const r = applyPlans(new Set(["X", "G"]), { G: new Set(["k1"]) }, [{ groupId: "G", kept: ["k2"], trash: [], fully: true }], { replace: true })
    expect([...r.selected]).toEqual(["G"])
    expect([...r.kept.G].sort()).toEqual(["k1", "k2"])
  })
})

describe("time window and explanations", () => {
  const its = items([mk("a"), mk("b", { timestamp: 1_000_000 + 30_000 })])
  const g = grp(["a", "b"])
  const sc = [same("a", "b")]
  it("default window rejects a 30 s gap; widening accepts it", () => {
    expect(planGroup(g, its, sc, T, opts)!.trash).toHaveLength(0)
    const wide = { ...DEFAULT_NEAR_EXACT, maxTakenDiffMs: 60_000 }
    expect(planGroup(g, its, sc, T, { ...opts, meta: wide })!.trash).toHaveLength(1)
  })
  it("explains the failing check", () => {
    const plan = planGroup(g, its, sc, T, opts)!
    const m = explainMisses(g, its, sc, T, plan, opts)
    expect(m[0]).toMatchObject({ key: "b", against: "a", reason: "time", detail: "30 s apart" })
    const it2 = items([mk("a"), mk("b")])
    const p2 = planGroup(g, it2, [diff("a", "b")], T, opts)!
    expect(explainMisses(g, it2, [diff("a", "b")], T, p2, opts)[0].reason).toBe("structure")
    expect(explainMisses(g, it2, [], T, planGroup(g, it2, [], T, opts)!, opts)[0].reason).toBe("no score")
  })
})

describe("planGroup forceOne", () => {
  it("keeps exactly one photo and trashes the rest without pixel proof", async () => {
    const { planGroup } = await import("../../lib/identical-plan")
    const mk = (k: string) => ({ mediaKey: k, dedupKey: k, thumb: "", timestamp: 1, resWidth: 10, resHeight: 10 }) as any
    const items = { a: mk("a"), b: mk("b"), c: mk("c") }
    const g = { id: "g", mediaKeys: ["a", "b", "c"], originalMediaKey: "a", similarity: 0.9 }
    const p = planGroup(g, items, [], { maxHamming: 2, maxColorMae: 4, maxCellDiff: 24 }, { keepOrder: "oldest", forceOne: true })!
    expect(p.kept).toHaveLength(1)
    expect(p.trash).toHaveLength(2)
    expect(p.fully).toBe(true)
  })
})
