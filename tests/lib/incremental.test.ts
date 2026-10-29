import { describe, it, expect } from "vitest"
import { mergeIncremental } from "../../lib/incremental"
import { extractRowCommunities, mergeCommunities } from "../../lib/community"

const g = (id: string, mediaKeys: string[]) => ({ id, mediaKeys, originalMediaKey: mediaKeys[0], similarity: 0.9 })
// keys: a b (group g1), c d e (group g2), x (ungrouped old), n1 n2 n3 (new)
const keys = ["a", "b", "c", "d", "e", "x", "n1", "n2", "n3"]
const idx = (k: string) => keys.indexOf(k)
const cl = (seed: string, ...rest: string[]) => [seed, ...rest].map(idx)
const prev = [g("group-0", ["a", "b"]), g("group-1", ["c", "d", "e"])]
const FROM = idx("n1")

describe("mergeIncremental", () => {
  it("a new photo joins the old group it matches most; groups never merge", () => {
    const r = mergeIncremental(prev, keys, FROM, [cl("n1", "a", "c", "d")], 2)
    const g1 = r.groups.find((x) => x.id === "group-1")!
    expect(g1.mediaKeys).toContain("n1")
    expect(g1.status).toBe("changed")
    expect(r.groups.find((x) => x.id === "group-0")!.status).toBe("unchanged")
  })
  it("new photos pair up, or pick up an ungrouped old photo, under fresh ids", () => {
    const r = mergeIncremental(prev, keys, FROM, [cl("n2", "x", "n3"), cl("n3", "x", "n2")], 7)
    const created = r.groups.filter((x) => x.status === "new")
    expect(created).toHaveLength(1)
    expect(created[0].id).toBe("group-7")
    expect([...created[0].mediaKeys].sort()).toEqual(["n2", "n3", "x"])
    expect(r.nextSeq).toBe(8)
  })
  it("drops groups that fall below two photos and never reuses their id", () => {
    const left = keys.filter((k) => k !== "b")
    const r = mergeIncremental(prev, left, left.indexOf("n1"), [], 2)
    expect(r.droppedIds).toEqual(["group-0"])
    expect(r.groups.map((x) => x.id)).toEqual(["group-1"])
  })
  it("a new photo with no match changes nothing", () => {
    const r = mergeIncremental(prev, keys, FROM, [], 2)
    expect(r.groups.every((x) => x.status === "unchanged")).toBe(true)
  })
  it("a photo that lost a member is marked changed", () => {
    const left = keys.filter((k) => k !== "e")
    const r = mergeIncremental(prev, left, left.indexOf("n1"), [], 2)
    expect(r.groups.find((x) => x.id === "group-1")).toMatchObject({ status: "changed", mediaKeys: ["c", "d"] })
  })
})

describe("incremental equals a full rescan on planted copies", () => {
  it("same groups as comparing everything", () => {
    let seed = 11
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296) - 0.5
    const dim = 24, oldN = 40
    const base = Array.from({ length: oldN }, () => Array.from({ length: dim }, rnd))
    // old photos: 5 near-copy pairs; new photos: copies of old ones, one fresh pair, strangers
    const rows = base.map((v, i) => (i % 8 === 1 ? base[i - 1].map((x) => x + rnd() * 0.01) : v))
    const fresh = Array.from({ length: dim }, rnd)
    const added = [rows[0].map((x) => x + rnd() * 0.01), rows[9].map((x) => x + rnd() * 0.01), fresh, fresh.map((x) => x + rnd() * 0.01), Array.from({ length: dim }, rnd)]
    const all = [...rows, ...added]
    const unit = all.map((v) => { const l = Math.hypot(...v); return v.map((x) => x / l) })
    const flat = (n: number) => Float32Array.from(unit.slice(0, n).flat())
    const names = all.map((_, i) => `p${i}`)
    const thr = 0.98

    const oldGroups = mergeCommunities(extractRowCommunities(flat(oldN), oldN, dim, 0, oldN, thr)).map((m, i) => g(`group-${i}`, m.map((x) => names[x])))
    const n = all.length
    const clusters = extractRowCommunities(flat(n), n, dim, oldN, n, thr, undefined, true)
    const inc = mergeIncremental(oldGroups, names, oldN, clusters, oldGroups.length)
    const full = mergeCommunities(extractRowCommunities(flat(n), n, dim, 0, n, thr)).map((m) => m.map((x) => names[x]).sort().join())
    const got = inc.groups.map((x) => [...x.mediaKeys].sort().join())
    expect(got.sort()).toEqual(full.sort())
  })
})
