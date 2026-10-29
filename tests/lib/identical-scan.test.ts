import { describe, it, expect } from "vitest"
import { passingGroupIds } from "../../lib/identical-scan"

describe("passingGroupIds", () => {
  const scan = {
    candidateCount: 3,
    scores: [
      { groupId: "a", maxHamming: 0, maxColorMae: 1, maxCellDiff: 5 },
      { groupId: "b", maxHamming: 3, maxColorMae: 1, maxCellDiff: 5 },
      { groupId: "c", maxHamming: 1, maxColorMae: 9, maxCellDiff: 5 },
    ],
  }
  it("applies both thresholds", () => {
    expect(passingGroupIds(scan, { maxHamming: 2, maxColorMae: 4, maxCellDiff: 24 })).toEqual(["a"])
  })
  it("local difference blocks a group", () => {
    const s2 = { candidateCount: 1, scores: [{ groupId: "x", maxHamming: 0, maxColorMae: 0, maxCellDiff: 80 }] }
    expect(passingGroupIds(s2, { maxHamming: 2, maxColorMae: 4, maxCellDiff: 24 })).toEqual([])
  })
  it("loosening thresholds admits more groups", () => {
    expect(passingGroupIds(scan, { maxHamming: 3, maxColorMae: 10, maxCellDiff: 24 })).toEqual(["a", "b", "c"])
  })
})
