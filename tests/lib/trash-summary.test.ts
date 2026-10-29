import { describe, it, expect } from "vitest"
import { summarizeTrash } from "../../lib/trash-summary"

const it0 = (o: any) => ({ mediaKey: "x", dedupKey: "x", thumb: "", timestamp: 0, creationTimestamp: 0, ...o })

describe("summarizeTrash", () => {
  it("prefers spaceTaken, falls back to size, skips non-quota items", () => {
    const s = summarizeTrash([
      it0({ spaceTaken: 100, size: 999 }),
      it0({ size: 50 }),
      it0({ takesUpSpace: false, size: 7000 }),
      it0({}),
    ])
    expect(s).toEqual({ items: 4, known: 3, bytes: 150 })
  })
})
