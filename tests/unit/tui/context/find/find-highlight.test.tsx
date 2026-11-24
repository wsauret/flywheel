/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal, For } from "solid-js"
import { compileFind, type FindMatcher } from "../../../../../src/protocol/transcript-find.js"
import { createFindHighlight, findColors, FindBlockScope, FindHighlightProvider, type FindHighlight } from "@tui/context/find/find-highlight.js"
import { THEMES, ThemeProvider } from "@tui/context/theme.js"
import { contrastRatio, TEXT_MINIMUM_CONTRAST } from "@tui/context/theme/color-contrast.js"
import { resolveTheme } from "@tui/context/theme/resolve.js"
import { MarkdownBody } from "@tui/output-blocks/markdown/markdown-body.js"

const CURRENT = { fg: RGBA.fromHex("#000000"), bg: RGBA.fromHex("#ff6600") }
const OTHER = { fg: RGBA.fromHex("#111111"), bg: RGBA.fromHex("#ffcc00") }

function matcherFor(pattern: string): FindMatcher {
  const compiled = compileFind({ pattern, regex: false, matchCase: false })
  if (compiled.kind !== "ready") throw new Error("pattern does not compile")
  return compiled.matcher
}

async function renderBlocks(texts: readonly string[], matcher: () => FindMatcher | undefined) {
  let highlight!: FindHighlight
  function Harness() {
    highlight = createFindHighlight({ matcher, colors: () => ({ current: CURRENT, other: OTHER }), reveal: () => {} })
    return <FindHighlightProvider value={highlight}>
      <box flexDirection="column">
        <For each={texts}>{(text, index) => <FindBlockScope value={() => `text:a${index()}`}><MarkdownBody>{text}</MarkdownBody></FindBlockScope>}</For>
      </box>
    </FindHighlightProvider>
  }
  const result = await testRender(() => <ThemeProvider mode="dark" themeName="flywheel"><Harness /></ThemeProvider>, { width: 40, height: 12 })
  const spans = () => result.captureSpans().lines.flatMap((line, row) => line.spans.map((span) => ({ ...span, row })))
  const painted = (bg: RGBA) => spans().filter((span) => span.bg.equals(bg)).map(({ text, row }) => ({ text, row }))
  await result.renderOnce()
  return { result, highlight, painted }
}

describe("createFindHighlight", () => {
  it("paints every match of the rendered text, the target strongly, and points at the target's wrapped line", async () => {
    const [matcher, setMatcher] = createSignal<FindMatcher | undefined>(matcherFor("needle"))
    const { result, highlight, painted } = await renderBlocks(["A **needle** here, then a long run of words that wraps the line before the second needle ends it."], matcher)
    try {
      expect(painted(OTHER.bg)).toEqual([{ text: "needle", row: 0 }, { text: "needle", row: 2 }])

      const spot = highlight.locate({ blockId: "text:a0", occurrence: 1 })
      await result.renderOnce()
      expect(spot?.line).toBe(2)
      expect(painted(CURRENT.bg)).toEqual([{ text: "needle", row: 2 }])
      expect(painted(OTHER.bg)).toEqual([{ text: "needle", row: 0 }])

      // A block that shows no match, or fewer than the target's ordinal, has
      // no spot and paints no current match: the landing marks the block.
      expect(highlight.locate({ blockId: "text:other", occurrence: 0 })).toBeUndefined()
      expect(highlight.locate({ blockId: "text:a0", occurrence: 2 })).toBeUndefined()
      await result.renderOnce()
      expect(painted(CURRENT.bg)).toEqual([])

      setMatcher(undefined)
      await result.renderOnce()
      expect(painted(OTHER.bg)).toEqual([])
      expect(painted(CURRENT.bg)).toEqual([])
    } finally { result.renderer.destroy() }
  })

  it("repaints only the texts that held or hold the current match when it moves", async () => {
    const needle = matcherFor("needle")
    let reads = 0
    const { result, highlight, painted } = await renderBlocks(["one needle", "two needle", "three needle"], () => (text, limit) => { reads += 1; return needle(text, limit) })
    try {
      highlight.locate({ blockId: "text:a0", occurrence: 0 })
      await result.renderOnce()
      reads = 0
      highlight.locate({ blockId: "text:a1", occurrence: 0 })
      await result.renderOnce()
      expect(painted(CURRENT.bg)).toEqual([{ text: "needle", row: 1 }])
      // locate reads each text of its block once; the repaint reads the two texts.
      expect(reads).toBe(1 + 2)
    } finally { result.renderer.destroy() }
  })
})

describe("findColors", () => {
  it("paints other matches weaker than the current one, with readable text, in every bundled theme", () => {
    const failures: string[] = []
    for (const [name, json] of Object.entries(THEMES)) {
      if (json === "system") continue
      for (const mode of ["dark", "light"] as const) {
        const theme = resolveTheme(json, mode)
        const { current, other } = findColors(theme)
        if (contrastRatio(other.bg, theme.background) >= contrastRatio(current.bg, theme.background)) failures.push(`${name}/${mode} other is not weaker`)
        if (contrastRatio(other.fg, other.bg) < TEXT_MINIMUM_CONTRAST) failures.push(`${name}/${mode} other text unreadable`)
        if (contrastRatio(current.fg, current.bg) < TEXT_MINIMUM_CONTRAST) failures.push(`${name}/${mode} current text unreadable`)
      }
    }
    expect(failures).toEqual([])
  })
})
