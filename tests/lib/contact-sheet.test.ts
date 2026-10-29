import { describe, it, expect } from "vitest"
import { renderSheet, escapeHtml } from "../../lib/contact-sheet"

describe("contact sheet", () => {
  it("escapes html", () => expect(escapeHtml('<a "&">')).toBe("&lt;a &quot;&amp;&quot;&gt;"))
  it("renders entries and blocks non-https links", () => {
    const base = { dedupKey: "", thumb: "", timestamp: 0, creationTimestamp: 0 }
    const html = renderSheet([
      { item: { ...base, mediaKey: "k1", fileName: "<b>x</b>", productUrl: "https://photos.google.com/p/1" }, dataUrl: "data:image/jpeg;base64,AA" },
      { item: { ...base, mediaKey: "k2", productUrl: "javascript:alert(1)" }, dataUrl: null },
    ], "T")
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;")
    expect(html).toContain('href="https://photos.google.com/p/1"')
    expect(html).not.toContain("javascript:")
    expect(html).toContain("no preview")
  })
})
