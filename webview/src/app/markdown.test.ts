import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { createMarkdownStream, renderCode, renderDiff } from "./markdown.js"

const plan = "# Plan\n\nFirst paragraph of the plan.\n\n- one\n- two\n\n```ts\nconst a = 1\n```\n\nClosing words."

describe("markdown links", () => {
  for (const destination of [
    // oxlint-disable-next-line eslint/no-script-url -- boundary: this fixture verifies executable links are rejected.
    "javascript:alert(1)",
    // oxlint-disable-next-line eslint/no-script-url -- boundary: this fixture verifies mixed-case executable links are rejected.
    "JaVaScRiPt:alert(1)",
    "data:text/html,alert(1)",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "custom:action",
    "java\tscript:alert(1)",
    "\u0001javascript:alert(1)",
    "&#106;avascript:alert(1)",
    "&#x6A;avascript:alert(1)",
    "javascript&colon;alert(1)",
    "java&Tab;script:alert(1)",
    "java&NewLine;script:alert(1)",
    "java&#13;script:alert(1)",
    "&#9;JaVaScRiPt&#58;alert(1)",
    "&#106avascript:alert(1)",
    "http://[invalid",
  ]) {
    test(`renders ${JSON.stringify(destination)} as an inert formatted label`, () => {
      const step = createMarkdownStream().advance(
        `[**Open** *now* \`code\` &amp; <b>](<${destination}> "Title")`,
      )
      assert.equal(step.settledHtml, "")
      assert.equal(step.tailHtml, "<p><strong>Open</strong> <em>now</em> <code>code</code> &amp; &lt;b&gt;</p>\n")
    })
  }

  for (const [destination, attribute] of [
    ["https://example.com/path", "https://example.com/path"],
    ["HTTP://example.com/path", "HTTP://example.com/path"],
    ["mailto:person@example.com", "mailto:person@example.com"],
    ["tel:+15551234567", "tel:+15551234567"],
    ["docs/page", "docs/page"],
    ["../docs/page", "../docs/page"],
    ["/docs/page", "/docs/page"],
    ["//example.com/path", "//example.com/path"],
    ["#section", "#section"],
    ["?page=2", "?page=2"],
    ["", ""],
    ["https://example.com/?a=1&b=2", "https://example.com/?a=1&amp;b=2"],
    ["https://example.com/?a=1&amp;b=2", "https://example.com/?a=1&amp;b=2"],
    ["https&colon;//example.com/&#x61;", "https://example.com/a"],
    ["docs/a%20b", "docs/a%20b"],
    ["docs/a b", "docs/a b"],
    ["https://example.com/?q=&quot;quoted&quot;", "https://example.com/?q=&quot;quoted&quot;"],
    ["https://example.com/?q=&amp;colon;", "https://example.com/?q=&amp;colon;"],
    ["javascript%3Aalert(1)", "javascript%3Aalert(1)"],
    ["./javascript:alert(1)", "./javascript:alert(1)"],
  ]) {
    test(`preserves safe destination ${JSON.stringify(destination)} and label/title formatting`, () => {
      const step = createMarkdownStream().advance(
        `[**Open** *now* \`code\` &amp;](<${destination}> 'Title &amp; &quot;quote&quot;')`,
      )
      assert.equal(
        step.tailHtml,
        `<p><a href="${attribute}" title="Title &amp; &quot;quote&quot;"><strong>Open</strong> <em>now</em> <code>code</code> &amp;</a></p>\n`,
      )
    })
  }

  test("validates reference links and autolinks through the same renderer", () => {
    const source = "[**Reference**][target]\n\n[target]: javascript:alert(1)\n\n<javascript:alert(1)>"
    const step = createMarkdownStream().advance(source)
    assert.equal(step.settledHtml + step.tailHtml, "<p><strong>Reference</strong></p>\n<p>javascript:alert(1)</p>\n")
  })

  test("preserves complete and incomplete title entity display without double decoding", () => {
    const step = createMarkdownStream().advance('[Label](https://example.com/ "A &copy; &copy &amp;colon; &unknown;")')
    assert.equal(
      step.tailHtml,
      '<p><a href="https://example.com/" title="A \u00a9 &amp;copy &amp;colon; &amp;unknown;">Label</a></p>\n',
    )
  })

  test("applies the same policy when a live block becomes settled", () => {
    const stream = createMarkdownStream()
    const source = "[**Unsafe**](javascript:alert(1))"
    assert.equal(stream.advance(source).tailHtml, "<p><strong>Unsafe</strong></p>\n")
    const next = stream.advance(`${source}\n\n[Safe](https://example.com/)`)
    assert.equal(next.settledHtml, "<p><strong>Unsafe</strong></p>\n")
    assert.equal(next.tailHtml, '<p><a href="https://example.com/">Safe</a></p>\n')
  })

  test("keeps raw HTML inert and preserves code and diff rendering", () => {
    const rawHtml = createMarkdownStream().advance('<script>alert("x")</script>')
    assert.equal(rawHtml.tailHtml, "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;")
    const code = createMarkdownStream().advance('```unknown\n<a href="javascript:alert(1)">\n```')
    assert.equal(code.tailHtml, '<pre class="code"><span class="code-tools"><button type="button" class="code-copy" aria-label="Copy code">Copy</button></span><code>&lt;a href=&quot;javascript:alert(1)&quot;&gt;</code></pre>')
    assert.equal(renderCode('<a href="javascript:alert(1)">'), "&lt;a href=&quot;javascript:alert(1)&quot;&gt;")
    assert.equal(
      renderDiff('-<a href="javascript:alert(1)">\n+safe\n'),
      '<div class="diff"><div class="diff-line diff-del">-&lt;a href=&quot;javascript:alert(1)&quot;&gt;</div><div class="diff-line diff-add">+safe</div></div>',
    )
  })
})

describe("streaming markdown", () => {
  test("renders complete large code and diff bodies without clipping copyable text", () => {
    const source = `/*${"x".repeat(81_920 - "/* closing-tail*/".length)} closing-tail*/`
    assert.equal(source.length, 81_920)
    assert.equal(renderCode(source, "ts").replace(/<[^>]+>/g, ""), source)
    assert.equal(renderDiff(`+${source}\n`), `<div class="diff"><div class="diff-line diff-add">+${source}</div></div>`)
  })

  test("emits each settled block once and re-renders only the live tail", () => {
    const stream = createMarkdownStream()
    const first = stream.advance("# Plan\n\nFirst paragraph")
    assert.equal(first.reset, false)
    assert.equal(first.settledHtml, "<h1>Plan</h1>\n")
    assert.equal(first.tailHtml, "<p>First paragraph</p>\n")

    const second = stream.advance("# Plan\n\nFirst paragraph of the plan.")
    assert.equal(second.settledHtml, "")
    assert.equal(second.tailHtml, "<p>First paragraph of the plan.</p>\n")

    const third = stream.advance("# Plan\n\nFirst paragraph of the plan.\n\n- one\n- tw")
    assert.equal(third.settledHtml, "<p>First paragraph of the plan.</p>\n")
    assert.match(third.tailHtml, /<ul>/)
  })

  test("settled and tail markup together equal the whole document rendered at once", () => {
    const whole = createMarkdownStream().advance(plan)
    const stream = createMarkdownStream()
    let settled = ""
    for (let end = 1; end <= plan.length; end += 7) {
      const step = stream.advance(plan.slice(0, end))
      settled = (step.reset ? "" : settled) + step.settledHtml
    }
    const last = stream.advance(plan)
    assert.equal(last.reset, false)
    assert.equal(settled + last.settledHtml + last.tailHtml, whole.settledHtml + whole.tailHtml)
  })

  test("keeps an unterminated fence in the tail", () => {
    const stream = createMarkdownStream()
    const step = stream.advance("Intro.\n\n```ts\nconst a = 1\nconst b = 2\n")
    assert.equal(step.settledHtml, "<p>Intro.</p>\n")
    assert.match(step.tailHtml, /<pre class="code">/)
  })

  test("starts over when the source stops extending what was settled", () => {
    const stream = createMarkdownStream()
    stream.advance("# One\n\nbody")
    const step = stream.advance("# Two\n\nbody")
    assert.equal(step.reset, true)
    assert.equal(step.settledHtml, "<h1>Two</h1>\n")
    assert.equal(step.tailHtml, "<p>body</p>\n")
  })
})

test("a code block's language and copy sit in a row above the code, not over its first line", async () => {
  const css = await Bun.file(new URL("../styles/markdown.css", import.meta.url)).text()
  const tools = css.match(/\.code-tools\s*\{([^}]*)\}/s)?.[1]
  assert.ok(tools)
  assert.doesNotMatch(tools, /position:\s*absolute/)
  assert.match(tools, /display:\s*flex;/)
})
