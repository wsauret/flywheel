import { describe, expect, it } from "bun:test"
import { marked } from "marked"
import { configureMarkdownLexer, renderMarkdownToken, plainOf } from "../../../../src/tui/output-blocks/markdown/format-token.js"
import type { MarkdownStyles } from "../../../../src/tui/output-blocks/markdown/markdown-styles.js"

const style = { attr: 0 }
const styles: MarkdownStyles = {
  h1: style, h2: style, h3: style, h4: style, h5: style, h6: style,
  strong: style, emphasis: style, code: style, codeBlock: style, link: style,
  listMarker: style, blockquoteBody: style, blockquoteBar: style,
  horizontalRule: style, image: style,
}

function render(markdown: string): string {
  configureMarkdownLexer()
  return plainOf(marked.lexer(markdown).flatMap((t) => renderMarkdownToken(t, styles)))
}

describe("markdown list markers", () => {
  // Markdown styling should keep the model's source linebreaks: tight lists stay
  // tight, loose lists stay loose.
  it("keeps ordered markers and spacing on a tight list", () => {
    expect(render("1. alpha\n2. beta\n3. gamma")).toBe("1. alpha\n2. beta\n3. gamma")
  })

  it("keeps bullet markers and spacing on a tight list", () => {
    expect(render("- alpha\n- beta")).toBe("- alpha\n- beta")
  })

  it("keeps bullet markers and spacing on a loose list", () => {
    expect(render("- alpha\n\n- beta")).toBe("- alpha\n\n- beta")
  })

  it("indents and spaces a nested list", () => {
    expect(render("1. alpha\n   - sub one\n   - sub two\n2. beta")).toBe(
      "1. alpha\n  - sub one\n  - sub two\n2. beta",
    )
  })

  it("respects an explicit ordered start", () => {
    expect(render("3. three\n\n4. four")).toBe("3. three\n\n4. four")
  })

  it("preserves paragraph spacing around a loose list", () => {
    const out = render("Intro line:\n\n1. alpha\n\n2. beta\n\nOutro line.")
    expect(out).toBe("Intro line:\n\n1. alpha\n\n2. beta\n\nOutro line.")
  })
})
