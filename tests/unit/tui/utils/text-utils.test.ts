import { describe, it, expect } from "bun:test"
import stringWidth from "string-width"
import { BoxRenderable, TextRenderable, fg } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { displayWidth, fitChunks, shareWidth, truncateText, useWrappedLineCount } from "../../../../src/tui/utils/text"

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

  it("agrees with string-width on the strings the fast path skips", () => {
    // Wide CJK, emoji sequences, combining marks, box drawing, ANSI escapes,
    // control characters: everything non-ASCII must take the exact path.
    for (const text of ["日本語", "👩‍👩‍👧‍👦", "e\u0301", "└ rail │", "\u001B[31mred\u001B[0m", "tab\there", "line\nbreak"]) {
      expect(displayWidth(text)).toBe(stringWidth(text))
    }
  })

  it("locks the fast-path predicate boundaries against string-width", () => {
    // 0x1f (below space), space, tilde, and DEL bracket the printable-ASCII
    // range; each must agree exactly with string-width.
    for (const text of ["\u001f", " ", "~", "\u007f", "a\u001fb", "a\u007fb"]) {
      expect(displayWidth(text)).toBe(stringWidth(text))
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
