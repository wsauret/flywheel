import { RGBA, type TextChunk } from "@opentui/core"
import { describe, expect, it } from "bun:test"
import { marked, type Token, type Tokens } from "marked"
import { renderMarkdownToken, plainOf } from "../../../../src/tui/output-blocks/markdown/format-token.js"
import type { MarkdownStyles } from "../../../../src/tui/output-blocks/markdown/markdown-styles.js"

const codeColor = RGBA.fromInts(1, 2, 3, 255)
const style = { attr: 0 }

const styles: MarkdownStyles = {
  h1: style,
  h2: style,
  h3: style,
  h4: style,
  h5: style,
  h6: style,
  strong: style,
  emphasis: style,
  code: { ...style, fg: codeColor },
  codeBlock: style,
  link: style,
  listMarker: style,
  blockquoteBody: style,
  blockquoteBar: style,
  horizontalRule: style,
  image: style,
}

// marked's open `Tokens.Generic` arm (`type: string`) keeps a `type` check from
// narrowing to the concrete interface the lexer emits, so these predicates pin it.
function isParagraph(token: Token | undefined): token is Tokens.Paragraph {
  return token?.type === "paragraph"
}
function isText(token: Token | undefined): token is Tokens.Text {
  return token?.type === "text"
}

function paragraphToken(markdown: string): Tokens.Paragraph {
  const token = marked.lexer(markdown)[0]
  if (!isParagraph(token)) throw new Error("fixture did not produce a paragraph")
  return token
}

function textToken(markdown: string): Tokens.Text {
  const child = paragraphToken(markdown).tokens[0]
  if (!isText(child)) throw new Error("fixture did not produce a text token")
  return child
}

function chunksFor(markdown: string): TextChunk[] {
  return renderMarkdownToken(textToken(markdown), styles)
}

function inlineChunksFor(markdown: string): TextChunk[] {
  return paragraphToken(markdown).tokens.flatMap((child) => renderMarkdownToken(child, styles))
}

function hasWhitespaceOnlyChunk(chunks: TextChunk[]): boolean {
  return chunks.some((c) => /^\s+$/.test(c.text))
}

describe("renderMarkdownToken markdown text whitespace", () => {
  it("keeps ordinary paragraph text round-trippable without standalone spaces", () => {
    const text = "All required reviewers were dispatched already"
    const chunks = chunksFor(text)

    expect(plainOf(chunks)).toBe(text)
    expect(plainOf(chunks)).toContain("reviewers were dispatched")
    expect(hasWhitespaceOnlyChunk(chunks)).toBe(false)
  })

  it("keeps file paths plain while folding standalone spaces", () => {
    const chunks = chunksFor("see src/app.ts for details")

    expect(chunks.some((c) => c.link)).toBe(false)
    expect(plainOf(chunks)).toBe("see src/app.ts for details")
    expect(hasWhitespaceOnlyChunk(chunks)).toBe(false)
  })

  it("does not emit a leading-space chunk before a wrapped word", () => {
    const chunks = chunksFor("All required reviewers were dispatched already")
    const dispatchedIndex = chunks.findIndex((c) => c.text.includes("dispatched"))

    expect(dispatchedIndex).toBeGreaterThan(-1)
    expect(chunks[dispatchedIndex]?.text.startsWith(" ")).toBe(false)
    expect(hasWhitespaceOnlyChunk(chunks)).toBe(false)
  })
})

describe("renderMarkdownToken path rendering", () => {
  it("renders a backticked file path as code-colored text without a link", () => {
    const chunks = inlineChunksFor("see `src/app.ts` here")
    const code = chunks.find((c) => c.text === "src/app.ts")

    expect(code?.link).toBeUndefined()
    expect(code?.fg?.equals(codeColor)).toBe(true)
  })

  it("does not linkify non-path backticked code", () => {
    for (const code of ["`git status`", "`useState`", "`let x = 1`"]) {
      const chunks = inlineChunksFor(`run ${code} now`)
      expect(chunks.some((c) => c.link)).toBe(false)
    }
  })

  it("renders path line references as plain text", () => {
    const backticked = inlineChunksFor("open `src/app.ts:42:3`")
    const plain = chunksFor("edited src/app.ts:42 today")

    expect(backticked.find((c) => c.text === "src/app.ts:42:3")?.link).toBeUndefined()
    expect(plain.find((c) => c.text.includes("src/app.ts:42"))?.link).toBeUndefined()
    expect(plainOf(plain)).toBe("edited src/app.ts:42 today")
  })
})
