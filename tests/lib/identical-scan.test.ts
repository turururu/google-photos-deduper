import { describe, it, expect } from "vitest"
import { pairKey } from "../../lib/identical-scan"

describe("pairKey", () => {
  it("is order independent", () => {
    expect(pairKey("a", "b")).toBe(pairKey("b", "a"))
  })
})
