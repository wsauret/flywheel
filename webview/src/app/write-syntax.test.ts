import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { writeSyntaxPresentation } from "./write-syntax.js"

const css = await Bun.file(new URL("../styles/write-syntax.css", import.meta.url)).text()
const markdownCss = await Bun.file(new URL("../styles/markdown.css", import.meta.url)).text()
const tokensCss = await Bun.file(new URL("../styles/tokens.css", import.meta.url)).text()

describe("Write syntax palette", () => {
  test("carries both catalog modes and colors unknown text and comments", () => {
    const presentation = writeSyntaxPresentation("create", "slate")

    assert.ok(presentation.style)
    assert.equal(presentation.style["--fw-write-syntax-text"], "light-dark(#4d5360, #b7bcc6)")
    assert.equal(presentation.style["--fw-write-syntax-comment"], "light-dark(#656d79, #8f96a3)")
    assert.match(css, /\.write-syntax \.diff-source > span:last-child[^{}]*\{[^}]*color: var\(--fw-write-syntax-text\)/s)
    assert.doesNotMatch(css, /\.write-syntax\s*\{[^}]*color:/s)
    assert.match(css, /\.write-syntax \.hljs-comment[^{}]*\{[^}]*var\(--fw-write-syntax-comment\)/s)
  })

  test("keeps legacy chat syntax values under explicit chat names", () => {
    assert.doesNotMatch(tokensCss, /--fw-syntax-/)
    assert.doesNotMatch(markdownCss, /--fw-syntax-/)
    assert.match(tokensCss, /--fw-chat-code-keyword: #7fb4f5/)
  })
})
