import { RGBA, createTextAttributes } from "@opentui/core"
import { describe, expect, it } from "bun:test"
import { marked, type Token, type Tokens } from "marked"
import {
  buildTableModel,
  CARDVIEW_LINE_THRESHOLD,
  COLUMN_MIN_CONTENT_CAP,
  MIN_COLUMN_WIDTH,
  shouldUseCardView,
} from "../../../../src/tui/output-blocks/markdown/markdown-table-helpers.js"
import type { MarkdownStyles } from "../../../../src/tui/output-blocks/markdown/markdown-styles.js"
import { BOLD, ITALIC, UNDERLINE } from "../../../../src/tui/utils/text-attributes.js"

const DIM = createTextAttributes({ dim: true })

const codeColor = RGBA.fromInts(1, 2, 3, 255)
const linkColor = RGBA.fromInts(4, 5, 6, 255)

const styles: MarkdownStyles = {
  h1: { attr: BOLD },
  h2: { attr: BOLD },
  h3: { attr: BOLD },
  h4: { attr: BOLD },
  h5: { attr: BOLD },
  h6: { attr: BOLD },
  strong: { attr: BOLD },
  emphasis: { attr: ITALIC },
  code: { attr: 0, fg: codeColor },
  codeBlock: { attr: 0, fg: codeColor },
  link: { attr: UNDERLINE, fg: linkColor },
  listMarker: { attr: 0 },
  blockquoteBody: { attr: ITALIC },
  blockquoteBar: { attr: 0 },
  horizontalRule: { attr: 0 },
  image: { attr: 0 },
}

// marked's open `Tokens.Generic` arm (`type: string`) keeps a `type` check from
// narrowing to the concrete interface the lexer emits, so the predicate pins it.
function isTable(token: Token): token is Tokens.Table {
  return token.type === "table"
}

function table(markdown: string): Tokens.Table {
  const token = marked.lexer(markdown).find(isTable)
  if (!token) throw new Error("fixture did not produce a table")
  return token
}

describe("buildTableModel", () => {
  it("reports each column's intrinsic minimum content width from the longest single word", () => {
    const model = buildTableModel(
      table("| A | B |\n| --- | --- |\n| short | longestword |\n| mediumword | x |\n"),
      styles,
    )

    expect(model.columns[0]?.minContentWidth).toBe("mediumword".length)
    expect(model.columns[1]?.minContentWidth).toBe("longestword".length)
  })

  it("keeps huge longest-word metrics out of the Yoga minimum width", () => {
    const huge = "x".repeat(190)
    const model = buildTableModel(
      table(`| Name | Value |\n| --- | --- |\n| ${huge} | ok |\n`),
      styles,
    )

    expect(model.columns[0]?.minContentWidth).toBe(190)
    expect(model.columns[0]?.flex.minWidth).toBe(COLUMN_MIN_CONTENT_CAP + 1)
    expect(model.columns[0]?.flex.minWidth).toBeLessThan(model.columns[0]!.minContentWidth)
    expect(model.columns[0]?.minContentWidth).toBeGreaterThanOrEqual(100)
  })

  it("reports each column's max content width from the widest plain cell", () => {
    const model = buildTableModel(
      table("| A | Heading |\n| --- | --- |\n| alpha beta | z |\n| x | wider content here |\n"),
      styles,
    )

    expect(model.columns[0]?.maxContentWidth).toBe("alpha beta".length)
    expect(model.columns[0]?.flex.flexBasis).toBe("alpha beta".length)
    expect(model.columns[1]?.maxContentWidth).toBe("wider content here".length)
    expect(model.columns[1]?.flex.flexBasis).toBe("wider content here".length)
  })

  it("models headers as centered and bold while null body alignment defaults to left", () => {
    const model = buildTableModel(
      table("| A | B |\n| --- | --- |\n| x | y |\n"),
      styles,
    )

    expect(model.header[0]?.align).toBe("center")
    expect(model.header[0]?.chunks.every((c) => ((c.attributes ?? 0) & BOLD) === BOLD)).toBe(true)
    expect(model.rows[0]?.[0]?.align).toBe("left")
    expect(model.columns[0]?.align).toBeNull()
  })

  it("honors explicit body alignment for left, center, and right columns", () => {
    const model = buildTableModel(
      table("| L | C | R |\n| :--- | :---: | ---: |\n| left | center | right |\n"),
      styles,
    )

    expect(model.columns.map((c) => c.align)).toEqual(["left", "center", "right"])
    expect(model.rows[0]?.map((c) => c.align)).toEqual(["left", "center", "right"])
  })

  it("keeps cached grid and card-value colors and attributes without terminal dimming", () => {
    const model = buildTableModel(
      table("| **Label** | Value |\n| --- | --- |\n| [link](https://example.com) | `code` and **bold** |\n"),
      styles,
    )

    const allChunks = [
      ...model.header.flatMap((cell) => cell.chunks),
      ...model.rows.flatMap((row) => row.flatMap((cell) => cell.chunks)),
    ]
    expect(allChunks.length).toBeGreaterThan(0)
    expect(allChunks.every((c) => ((c.attributes ?? 0) & DIM) === 0)).toBe(true)

    const boldHeader = model.header[0]?.chunks[0]
    expect(((boldHeader?.attributes ?? 0) & BOLD)).toBe(BOLD)

    const linkChunk = model.rows[0]?.[0]?.chunks.find((c) => c.link?.url === "https://example.com")
    expect(linkChunk?.fg).toBe(linkColor)
    expect(((linkChunk?.attributes ?? 0) & UNDERLINE)).toBe(UNDERLINE)
    expect(((linkChunk?.attributes ?? 0) & DIM)).toBe(0)

    const codeChunk = model.rows[0]?.[1]?.chunks.find((c) => c.text === "code")
    expect(codeChunk?.fg).toBe(codeColor)
    expect(((codeChunk?.attributes ?? 0) & DIM)).toBe(0)

    const boldBodyChunk = model.rows[0]?.[1]?.chunks.find((c) => c.text === "bold")
    expect(((boldBodyChunk?.attributes ?? 0) & BOLD)).toBe(BOLD)
    expect(((boldBodyChunk?.attributes ?? 0) & DIM)).toBe(0)

    expect(model.cardLabels[0]).toBe("Label")
    expect(model.rows[0]?.[1]?.chunks.map((c) => c.text).join(""))
      .toBe("code and bold")
  })

  it("normalizes rows to the header-driven column count", () => {
    const token = table("| A | B | C |\n| --- | --- | --- |\n| x | y | z |\n")
    token.rows = [[token.rows[0]![0]!]]

    const model = buildTableModel(token, styles)

    expect(model.columnCount).toBe(3)
    expect(model.rows).toHaveLength(1)
    expect(model.rows[0]).toHaveLength(3)
    expect(model.rows[0]?.map((cell) => cell.plain)).toEqual(["x", "", ""])
    expect(model.rows[0]?.map((cell) => cell.align)).toEqual(["left", "left", "left"])
  })
})

describe("shouldUseCardView", () => {
  it("switches to card view only when projected wrapped height exceeds the threshold", () => {
    const model = buildTableModel(
      table("| A | B |\n| --- | --- |\n| one two three four five six seven eight | short |\n"),
      styles,
    )

    expect(shouldUseCardView(model, 80)).toBe(false)
    expect(shouldUseCardView(model, 6)).toBe(true)
  })

  it("stays in grid mode at the card-view line threshold", () => {
    const words = Array.from({ length: CARDVIEW_LINE_THRESHOLD }, (_, i) => `w${i}`).join(" ")
    const model = buildTableModel(
      table(`| A |\n| --- |\n| ${words} |\n`),
      styles,
    )

    expect(shouldUseCardView(model, MIN_COLUMN_WIDTH)).toBe(false)
  })
})
