import { describe, expect, it } from "bun:test"
import type { TextChunk } from "@opentui/core"
import { wrapToolRowChunks } from "../../../../src/tui/output-blocks/tool-row-wrap.js"

const chunk = (text: string, attributes?: number): TextChunk => ({ __isChunk: true, text, attributes })
const plain = (chunks: readonly TextChunk[]): string => chunks.map((c) => c.text).join("")

describe("wrapToolRowChunks", () => {
  it("caps styled rows without losing the continuation rail or exceeding cell width", () => {
    const out = wrapToolRowChunks([chunk("├ ")], [chunk("界".repeat(20), 7)], 10, [chunk("│")], 2)
    expect(plain(out)).toBe("├ 界界界界\n│ 界界界…")
    expect(out.filter((part) => part.text.includes("界")).every((part) => part.attributes === 7)).toBe(true)
  })

  it("does not mark an exact two-line fit as truncated", () => {
    expect(plain(wrapToolRowChunks([chunk("├ ")], [chunk("abcdefgh")], 6, [chunk("│")], 2)))
      .toBe("├ abcd\n│ efgh")
  })

  it("keeps a short summary complete when its suffix wraps to the second line", () => {
    const out = wrapToolRowChunks([chunk("├ ")], [chunk("abcd")], 8, [chunk("│")], 2, [chunk(" done")])
    expect(plain(out)).toBe("├ abcd\n│ done")
  })

  it("never truncates a long status suffix and preserves its styled continuation rail", () => {
    const out = wrapToolRowChunks([chunk("├ ")], [chunk("body ".repeat(20))], 20, [chunk("│", 7)], 2, [chunk(" Permission denied for this workspace", 1)])
    expect(plain(out)).toContain("… Permission")
    expect(plain(out).replace(/\n│ */g, " ")).toContain("Permission denied for this workspace")
    expect(out.filter((part) => part.text === "│").every((part) => part.attributes === 7)).toBe(true)
  })

  it("keeps a capped row bounded when its prefix consumes the available width", () => {
    const out = wrapToolRowChunks([chunk("linear.save_issue ")], [chunk("description=".repeat(10))], 10, [], 2)
    expect(plain(out).split("\n")).toHaveLength(2)
    expect(plain(out).endsWith("…")).toBe(true)
    expect(plain(wrapToolRowChunks([chunk("name ")], [chunk("body")], 1, [], 2))).toBe("…")
  })

  it("wraps an unlimited row without an indent when its prefix consumes the available width", () => {
    const out = wrapToolRowChunks([chunk("Resume Benchmark ")], [chunk("long-result-id")], 8, [], undefined, [chunk(" stop")])
    const lines = plain(out).split("\n")
    expect(lines.every(line => line.length <= 8)).toBe(true)
    expect(lines.every(line => !line.startsWith(" "))).toBe(true)
    expect(lines.join("")).toBe("ResumeBenchmarklong-result-idstop")
  })

  it("returns prefix + body unchanged when it fits on one line", () => {
    const prefix = [chunk(" └ "), chunk("Read ")]
    const body = [chunk("a.ts, b.ts")]
    const out = wrapToolRowChunks(prefix, body, 40)
    expect(plain(out)).toBe(" └ Read a.ts, b.ts")
    expect(plain(out)).not.toContain("\n")
  })

  it("hangs continuation lines under the start of the detail", () => {
    const prefix = [chunk(" └ "), chunk("Read ")] // display width 8
    const body = [chunk("alpha, beta, gamma")]
    const out = wrapToolRowChunks(prefix, body, 15) // avail = 15 - 8 = 7
    // Each continuation line is indented by the prefix width (8 spaces) so the
    // basenames line up under "alpha".
    expect(plain(out)).toBe(" └ Read alpha,\n        beta,\n        gamma")
  })

  it("preserves styling of a source chunk across a wrap boundary", () => {
    const prefix = [chunk("Read ")]
    const body = [chunk("aaaa bbbb", 7)] // attributes=7 stands in for a style
    const out = wrapToolRowChunks(prefix, body, 9) // avail = 4, forces a wrap
    const styled = out.filter((c) => c.text === "aaaa" || c.text === "bbbb")
    expect(styled.length).toBe(2)
    expect(styled.every((c) => c.attributes === 7)).toBe(true)
  })

  it("hard-splits an over-long unbreakable word across lines", () => {
    const prefix = [chunk("Read ")]
    const body = [chunk("verylongunbreakableword next")]
    const out = wrapToolRowChunks(prefix, body, 10) // avail = 5
    // Every character survives; no line exceeds the width budget, so the
    // renderer's own wrapMode never kicks in.
    expect(plain(out)).toBe("Read veryl\n     ongun\n     break\n     ablew\n     ord\n     next")
  })

  it("returns the prefix alone for an empty body", () => {
    const prefix = [chunk(" └ "), chunk("Read ")]
    expect(plain(wrapToolRowChunks(prefix, [], 40))).toBe(" └ Read ")
  })

  it("does not wrap when the measured width is not yet available", () => {
    const prefix = [chunk("Read ")]
    const body = [chunk("a, b, c, d, e")]
    expect(plain(wrapToolRowChunks(prefix, body, 0))).toBe("Read a, b, c, d, e")
  })

  it("hard-breaks on embedded newlines and preserves line indentation", () => {
    const prefix = [chunk("└ ")] // display width 2
    const body = [chunk("python3 - <<'EOF'\nif True:\n    print('hi')\nEOF")]
    const out = wrapToolRowChunks(prefix, body, 40)
    expect(plain(out)).toBe("└ python3 - <<'EOF'\n  if True:\n      print('hi')\n  EOF")
  })

  it("treats carriage returns as hard breaks with the hanging indent", () => {
    const prefix = [chunk("└ ")] // display width 2
    const body = [chunk("first paragraph\r\rsecond paragraph\r\nthird")]
    const out = wrapToolRowChunks(prefix, body, 40)
    expect(plain(out)).toBe("└ first paragraph\n\n  second paragraph\n  third")
  })

  it("keeps a CRLF split across styled chunks as one break with styles intact", () => {
    const prefix = [chunk("└ ")]
    const body = [chunk("first\r", 1), chunk("\nsecond", 2)]
    const out = wrapToolRowChunks(prefix, body, 40)
    expect(plain(out)).toBe("└ first\n  second")
    expect(out.find((c) => c.text.includes("first"))?.attributes).toBe(1)
    expect(out.find((c) => c.text.includes("second"))?.attributes).toBe(2)
  })

  it("word-wraps within a hard line while keeping later hard lines intact", () => {
    const prefix = [chunk("└ ")] // width 2, avail = 10
    const body = [chunk("alpha beta gamma\nnext")]
    const out = wrapToolRowChunks(prefix, body, 12)
    expect(plain(out)).toBe("└ alpha beta\n  gamma\n  next")
  })

  it("renders the continuation rail padded to the prefix width", () => {
    const prefix = [chunk("├─ ")] // display width 3
    const body = [chunk("mkdir -p x\ncp a b")]
    const out = wrapToolRowChunks(prefix, body, 40, [chunk("│")])
    expect(plain(out)).toBe("├─ mkdir -p x\n│  cp a b")
  })

  it("uses the rail on soft-wrapped continuation lines too", () => {
    const prefix = [chunk("├─ ")] // width 3, avail = 9
    const body = [chunk("alpha beta gamma")]
    const out = wrapToolRowChunks(prefix, body, 12, [chunk("│")])
    expect(plain(out)).toBe("├─ alpha\n│  beta\n│  gamma")
  })

  it("keeps exact-fit trailing spaces on the current line", () => {
    const out = wrapToolRowChunks([chunk("├ ")], [chunk("hello ")], 8, [chunk("│")])

    expect(plain(out)).toBe("├ hello ")
  })

  it("rails every continuation row needed by trailing spaces", () => {
    const out = wrapToolRowChunks([chunk("├ ")], [chunk(`planet${" ".repeat(13)}`)], 8, [chunk("│")])

    expect(plain(out)).toBe("├ planet\n│       \n│       \n│  ")
  })

  it("preserves a whitespace-only body across railed rows", () => {
    const out = wrapToolRowChunks([chunk("├ ")], [chunk(" ".repeat(7))], 8, [chunk("│")])

    expect(plain(out)).toBe("├       \n│  ")
  })

  it("preserves a whitespace-only hard line across railed rows", () => {
    const out = wrapToolRowChunks([chunk("├ ")], [chunk(`hello\n${" ".repeat(7)}`)], 8, [chunk("│")])

    expect(plain(out)).toBe("├ hello\n│       \n│  ")
  })

  it("does not wrap when the measured width is NaN (between layouts)", () => {
    // OpenTUI reports NaN dimensions while a box is between layouts. NaN fails
    // every comparison, so a naive "too narrow" guard passes it through to the
    // wrap loop, which then breaks after every word (one row per word). The
    // not-ready guard must treat NaN as unmeasured and emit unwrapped.
    const prefix = [chunk("Read ")]
    const body = [chunk("a, b, c, d, e")]
    expect(plain(wrapToolRowChunks(prefix, body, Number.NaN))).toBe("Read a, b, c, d, e")
  })

  it("wraps wide CJK characters by display width, not code-point count", () => {
    const prefix = [chunk(" └ ")] // width 3
    // Each CJK character is display width 2, so avail = 11 - 3 = 8 fits 4.
    const body = [chunk("日本語日本語")]
    const out = wrapToolRowChunks(prefix, body, 11)
    expect(plain(out)).toBe(" └ 日本語日\n   本語")
  })

  it("keeps a combining sequence with its base across a wrap boundary", () => {
    const prefix = [chunk(" └ ")] // width 3
    // "e\u0301" measures as width 1; five of them fit in avail = 8 - 3 = 5.
    const body = [chunk("e\u0301".repeat(6))]
    const out = wrapToolRowChunks(prefix, body, 8)
    const lines = plain(out).split("\n")
    expect(lines[0]).toBe(" └ " + "e\u0301".repeat(5))
    expect(lines[1]).toBe("   e\u0301")
  })
})
