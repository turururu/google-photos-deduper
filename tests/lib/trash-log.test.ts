import { describe, it, expect } from "vitest"
import { appendTrashLog, markRestored, trashLogToCsv } from "../../lib/trash-log"

const items: any = {
  a: { mediaKey: "a", dedupKey: "da", fileName: 'x"y.jpg', timestamp: 1000, productUrl: "u" },
  b: { mediaKey: "b", dedupKey: "db" },
}
describe("trash log", () => {
  it("appends, skips duplicates and unknown keys", () => {
    let log = appendTrashLog([], ["a", "zz"], items, 5)
    expect(log.map((e) => e.dedupKey)).toEqual(["da"])
    log = appendTrashLog(log, ["a", "b"], items, 6)
    expect(log.map((e) => e.dedupKey)).toEqual(["da", "db"])
  })
  it("marks restored and allows re-logging after restore", () => {
    let log = markRestored(appendTrashLog([], ["a"], items, 5), ["da"])
    expect(log[0].restored).toBe(true)
    log = appendTrashLog(log, ["a"], items, 9)
    expect(log).toHaveLength(2)
  })
  it("escapes csv", () => {
    const csv = trashLogToCsv(appendTrashLog([], ["a"], items, 5))
    expect(csv).toContain('"x""y.jpg"')
    expect(csv.split("\n")[0]).toContain("dedup_key")
  })
})
