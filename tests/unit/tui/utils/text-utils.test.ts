import { describe, it, expect } from "bun:test"
import { BoxRenderable, TextRenderable, fg } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { displayWidth, fitChunks, shareWidth, truncateText, truncateToWidth, useWrappedLineCount } from "../../../../src/tui/utils/text"

describe("wrappedLineCount", () => {
  for (const wrapMode of ["word", undefined] as const) {
    it(`matches native text rows with ${wrapMode ?? "inherited default"} wrapping`, async () => {
      let countRows: ReturnType<typeof useWrappedLineCount> | undefined
      const result = await testRender(() => {
        countRows = useWrappedLineCount()
        return null
      }, { width: 70, height: 2 })
      if (!countRows) throw new Error("counter did not mount")
      try {
        for (const [text, width, rows] of [
          [Array.from({ length: 7 }, () => "日本語日本語日本語日本").join(" "), 61, 3],
          ["日本語 abc 日本語", 5, 5],
          ["日本 語日 本語", 7, 2],
          ["", 5, 1],
          ["\n", 5, 2],
          ["a\n\nb\n", 5, 4],
        ] as const) {
          const host = new BoxRenderable(result.renderer, { width, flexDirection: "column" })
          const node = new TextRenderable(result.renderer, { content: text, ...(wrapMode === undefined ? {} : { wrapMode }) })
          host.add(node)
          result.renderer.root.add(host)
          await result.renderOnce()
          expect(node.virtualLineCount).toBe(rows)
          expect(countRows(text, width)).toBe(node.virtualLineCount)
          host.destroy()
        }
      } finally {
        await result.renderer.destroy()
      }
    })
  }
})

describe("truncate", () => {
  it("returns text unchanged when shorter than maxLen", () => {
    expect(truncateText("hello", 10)).toBe("hello")
  })

  it("returns text unchanged when exactly maxLen", () => {
    expect(truncateText("hello", 5)).toBe("hello")
  })

  it("truncates to maxLen total characters including ellipsis", () => {
    const result = truncateText("abcdefghij", 6)
    expect(result).toBe("abcde\u2026")
    expect(result.length).toBe(6)
  })

  it("hard-slices without ellipsis when maxLen < 4", () => {
    expect(truncateText("hello", 3)).toBe("hel")
    expect(truncateText("hello", 2)).toBe("he")
    expect(truncateText("hello", 1)).toBe("h")
    expect(truncateText("hello", 0)).toBe("")
  })

  it("handles maxLen of exactly 4 (boundary for ellipsis behavior)", () => {
    expect(truncateText("abcde", 4)).toBe("abc\u2026")
  })
})

describe("displayWidth", () => {
  it("measures printable ASCII by length", () => {
    expect(displayWidth("")).toBe(0)
    expect(displayWidth("hello world 123 ~!@#")).toBe(20)
  })

  it("counts the columns that the renderer draws, so a mark after the text fits in exactly that many columns plus one", async () => {
    // Wide CJK, an emoji sequence, a combining mark, box drawing, an ANSI
    // escape that the renderer draws as text, symbols that the renderer draws
    // wide (U+2764, U+203C) or narrow (U+2699), a soft hyphen, a tab, and
    // controls that the renderer draws in no column, among them 0x1f and
    // DEL, which bracket the printable-ASCII fast path.
    const char = String.fromCodePoint
    const texts = ["日本語", "👩‍👩‍👧‍👦", `e${char(0x301)}`, "└ rail │", `${char(0x1b)}[31mred`, `${char(0x2764)} love`, `${char(0x203c)}!`, `${char(0x2699)} gear`, `a${char(0xad)}b`, `a${char(9)}b`, `a${char(7)}b`, `a${char(0x1f)}b`, `a${char(0x7f)}b`, `a${char(0x9b)}b`]
    const result = await testRender(() => null, { width: 40, height: 2 })
    const markShown = async (text: string, width: number) => {
      const host = new BoxRenderable(result.renderer, { width })
      host.add(new TextRenderable(result.renderer, { content: `${text}|`, wrapMode: "none" }))
      result.renderer.root.add(host)
      await result.renderOnce()
      const shown = result.captureCharFrame().split("\n")[0]?.includes("|")
      host.destroy()
      return shown
    }
    try {
      for (const text of texts) {
        expect({ text, fits: await markShown(text, displayWidth(text) + 1), clipped: !await markShown(text, displayWidth(text)) }).toEqual({ text, fits: true, clipped: true })
      }
    } finally {
      await result.renderer.destroy()
    }
  })
})

describe("truncateToWidth", () => {
  it("keeps a symbol that the renderer draws wide inside the width, with its ellipsis shown", async () => {
    const heart = String.fromCodePoint(0x2764)
    const result = await testRender(() => null, { width: 10, height: 2 })
    try {
      const host = new BoxRenderable(result.renderer, { width: 3 })
      host.add(new TextRenderable(result.renderer, { content: truncateToWidth(`${heart}${heart}${heart}abc`, 3, "…"), wrapMode: "none" }))
      result.renderer.root.add(host)
      await result.renderOnce()
      expect(result.captureCharFrame().split("\n")[0]?.trimEnd()).toBe(`${heart}…`)
    } finally {
      await result.renderer.destroy()
    }
  })
})

describe("shareWidth", () => {
  it("cuts no text while every text fits, then cuts the widest first, and gives the columns left to the first text it cut", () => {
    expect(shareWidth([11, 30], 41)).toEqual([11, 30])
    expect(shareWidth([11, 30], 30)).toEqual([11, 19])
    expect(shareWidth([20, 20], 25)).toEqual([13, 12])
    expect(shareWidth([3, 40], 2)).toEqual([1, 1])
  })
})

describe("fitChunks", () => {
  const texts = (chunks: readonly { readonly text: string }[]) => chunks.map(({ text }) => text)
  it("keeps whole chunks while they fit and ends the one that does not fit in an ellipsis", () => {
    const chunks = [fg("#ffffff")("gates  "), fg("#888888")("claude-haiku-5.5 low")]
    expect(texts(fitChunks(chunks, 30))).toEqual(["gates  ", "claude-haiku-5.5 low"])
    expect(texts(fitChunks(chunks, 15))).toEqual(["gates  ", "claude-…"])
  })

  it("drops a cut chunk that would keep no text before its ellipsis, so no column shows a lone ellipsis", () => {
    const chunks = [fg("#ffffff")("gates"), fg("#888888")("        "), fg("#888888")("3/3 done")]
    expect(texts(fitChunks(chunks, 9))).toEqual(["gates"])
    expect(texts(fitChunks([fg("#ffffff")("gates"), fg("#888888")("3/3 done")], 6))).toEqual(["gates"])
  })
})
