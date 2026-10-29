/**
 * Unit tests for lib/scan-results.ts — areScanResultsValid().
 *
 * This function is exercised indirectly by app-reducer.test.ts but
 * a direct test makes the invalidation contract explicit and catches
 * future condition additions without relying on reducer state boilerplate.
 */
import { describe, it, expect } from "vitest"
import { areScanResultsValid, canResumeScan, carryOverSelection, scanMetaFor } from "../../lib/scan-results"

describe("areScanResultsValid", () => {
  it("returns true when both account emails match", () => {
    expect(
      areScanResultsValid(
        { accountEmail: "user@example.com" },
        { accountEmail: "user@example.com" }
      )
    ).toBe(true)
  })

  it("returns false when account emails differ", () => {
    expect(
      areScanResultsValid(
        { accountEmail: "alice@example.com" },
        { accountEmail: "bob@example.com" }
      )
    ).toBe(false)
  })

  it("returns true when stored email is undefined (legacy results without email)", () => {
    expect(
      areScanResultsValid(
        { accountEmail: undefined },
        { accountEmail: "user@example.com" }
      )
    ).toBe(true)
  })

  it("returns true when context email is undefined (health check did not return email)", () => {
    expect(
      areScanResultsValid(
        { accountEmail: "user@example.com" },
        { accountEmail: undefined }
      )
    ).toBe(true)
  })

  it("returns true when both emails are undefined", () => {
    expect(
      areScanResultsValid(
        { accountEmail: undefined },
        { accountEmail: undefined }
      )
    ).toBe(true)
  })
})

describe("incremental scan support", () => {
  const st = { scanMode: "full" as const, similarityThreshold: 0.9, dateRange: undefined }
  it("resumes only full-mode results made with the same settings", () => {
    const meta = scanMetaFor(st, 5)
    expect(canResumeScan(meta, st)).toBe(true)
    expect(canResumeScan(meta, { ...st, similarityThreshold: 0.95 })).toBe(false)
    expect(canResumeScan(meta, { ...st, dateRange: { from: "2020-01-01" } })).toBe(false)
    expect(canResumeScan(meta, { ...st, scanMode: "smart" })).toBe(false)
    expect(canResumeScan(undefined, st)).toBe(false)
  })
  it("carries selection over but resets changed and new groups", () => {
    const r = carryOverSelection(
      { selectedGroupIds: ["a", "b", "gone"], keptOverrides: { a: ["x"], b: ["y"] } },
      ["a", "b"],
      ["a", "b", "c", "d"],
      ["b"],
      ["d"],
    )
    expect([...r.selected].sort()).toEqual(["a", "b", "d"]) // c was deselected by the user
    expect(Object.keys(r.keptOverrides)).toEqual(["a"])
    expect([...r.reviewed]).toEqual(["a"])
  })
  it("a changed group keeps the user's kept photos and the newcomers", () => {
    const r = carryOverSelection(
      { selectedGroupIds: ["a"], keptOverrides: { a: ["p", "q", "gone"] } },
      ["a"],
      ["a"],
      ["a"],
      [],
      { before: { a: ["p", "q", "gone", "r"] }, after: { a: ["p", "q", "r", "n"] } },
    )
    expect([...r.keptOverrides.a].sort()).toEqual(["n", "p", "q"])
    expect(r.selected.has("a")).toBe(true) // it was checked before
    expect(r.reviewed.has("a")).toBe(false)
  })
  it("a changed group the user unchecked stays unchecked and unreviewed", () => {
    const r = carryOverSelection(
      { selectedGroupIds: [], keptOverrides: {} },
      ["a"], ["a"], ["a"], [],
      { before: { a: ["p", "q"] }, after: { a: ["p", "q", "n"] } },
    )
    expect(r.selected.has("a")).toBe(false)
    expect(r.reviewed.has("a")).toBe(false)
  })
  it("drops the override when every kept photo left the group", () => {
    const r = carryOverSelection(
      { selectedGroupIds: ["a"], keptOverrides: { a: ["gone"] } },
      [], ["a"], ["a"], [],
      { before: { a: ["gone", "r", "s"] }, after: { a: ["r", "s", "n"] } },
    )
    expect(r.keptOverrides.a).toBeUndefined()
  })
})
