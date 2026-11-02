import { describe, expect, it } from "bun:test"
import { unwrapMarkdownFences } from "../../../../src/tui/output-blocks/markdown/unwrap-fences.js"

describe("unwrapMarkdownFences", () => {
  it("returns input unchanged when no fences present", () => {
    const src = "Hello\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n"
    expect(unwrapMarkdownFences(src)).toBe(src)
  })

  it("unwraps a markdown fence containing a real table", () => {
    const src = "```markdown\n| A | B |\n| --- | --- |\n| 1 | 2 |\n```\n"
    expect(unwrapMarkdownFences(src)).toBe("| A | B |\n| --- | --- |\n| 1 | 2 |\n")
  })

  it("accepts the short `md` info string", () => {
    const src = "```md\n| A | B |\n| --- | --- |\n| 1 | 2 |\n```\n"
    expect(unwrapMarkdownFences(src)).toBe("| A | B |\n| --- | --- |\n| 1 | 2 |\n")
  })

  it("leaves a markdown fence without a table intact", () => {
    const src = "```markdown\njust prose\nno table here\n```\n"
    expect(unwrapMarkdownFences(src)).toBe(src)
  })

  it("leaves non-markdown fences (bash, rust, etc.) intact", () => {
    const src = "```bash\n| A | B |\n| --- | --- |\n| 1 | 2 |\n```\n"
    expect(unwrapMarkdownFences(src)).toBe(src)
  })

  it("re-emits the opener when EOF arrives before the closer (streaming)", () => {
    const src = "```markdown\n| A | B |\n| --- | --- |\n"
    expect(unwrapMarkdownFences(src)).toBe(src)
  })

  it("unwraps blockquoted markdown fences containing a table", () => {
    const src = "> ```markdown\n> | A | B |\n> | --- | --- |\n> ```\n"
    expect(unwrapMarkdownFences(src)).toBe("> | A | B |\n> | --- | --- |\n")
  })

  it("handles tilde-marked fences", () => {
    const src = "~~~markdown\n| A | B |\n| --- | --- |\n| 1 | 2 |\n~~~\n"
    expect(unwrapMarkdownFences(src)).toBe("| A | B |\n| --- | --- |\n| 1 | 2 |\n")
  })

  it("only unwraps fences whose body contains header + delimiter pair", () => {
    // Header without delimiter immediately after is not a table.
    const src = "```markdown\n| A | B |\n\n| --- | --- |\n```\n"
    expect(unwrapMarkdownFences(src)).toBe(src)
  })

  it("handles multiple consecutive fences independently", () => {
    const src
      = "```markdown\n| A | B |\n| --- | --- |\n```\n"
      + "```bash\necho hi\n```\n"
      + "```markdown\nno table\n```\n"
    const want
      = "| A | B |\n| --- | --- |\n"
      + "```bash\necho hi\n```\n"
      + "```markdown\nno table\n```\n"
    expect(unwrapMarkdownFences(src)).toBe(want)
  })

  it("matches a longer closer (closer fence length >= opener length)", () => {
    const src = "```markdown\n| A | B |\n| --- | --- |\n``````\n"
    expect(unwrapMarkdownFences(src)).toBe("| A | B |\n| --- | --- |\n")
  })
})
