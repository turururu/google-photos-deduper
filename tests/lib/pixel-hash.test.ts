import { describe, it, expect } from "vitest"
import { computeFingerprint, allPairsIdentical, hamming, maxCellDiff } from "../../lib/pixel-hash"

const W = 64, H = 64
const make = (fn: (x: number, y: number) => [number, number, number]) => {
  const d = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const [r, g, b] = fn(x, y)
      d.set([r, g, b, 255], (y * W + x) * 4)
    }
  return computeFingerprint(d, W, H)
}
const gradient = (x: number, y: number): [number, number, number] => [x * 4, y * 4, 128]

describe("pixel-hash", () => {
  it("identical images pass", () => {
    expect(allPairsIdentical([make(gradient), make(gradient)])).toBe(true)
  })
  it("tiny noise passes", () => {
    const noisy = make((x, y) => [Math.min(255, x * 4 + 1), y * 4, 128])
    expect(allPairsIdentical([make(gradient), noisy])).toBe(true)
  })
  it("brightness/filter edit fails on colour", () => {
    const bright = make((x, y) => [Math.min(255, x * 4 + 40), Math.min(255, y * 4 + 40), 168])
    expect(allPairsIdentical([make(gradient), bright])).toBe(false)
  })
  it("local content change fails on hash", () => {
    const changed = make((x, y) => (x > 20 && x < 44 && y > 20 && y < 44 ? [255 - x * 4, 0, 0] : gradient(x, y)))
    expect(hamming(make(gradient).dhash, changed.dhash)).toBeGreaterThan(2)
    expect(allPairsIdentical([make(gradient), changed])).toBe(false)
  })
  it("one odd item in a group of three fails (all pairs)", () => {
    const odd = make((x, y) => [255 - x * 4, y * 4, 0])
    expect(allPairsIdentical([make(gradient), make(gradient), odd])).toBe(false)
  })
  it("small local change (blink-like patch) fails on worst cell", () => {
    const patched = make((x, y) => (x >= 30 && x < 33 && y >= 30 && y < 33 ? [0, 0, 0] : gradient(x, y)))
    expect(maxCellDiff(make(gradient).gray, patched.gray)).toBeGreaterThan(24)
    expect(allPairsIdentical([make(gradient), patched])).toBe(false)
  })
})
