import assert from "node:assert/strict"
import { test } from "node:test"

const css = await Bun.file(new URL("../styles/find.css", import.meta.url)).text()

test("transcript search results cover transcript content", () => {
  const hits = css.match(/\.find-hits\s*\{([^}]*)\}/s)?.[1]
  assert.ok(hits)
  assert.match(hits, /background:\s*var\(--fw-menu-bg\);/)
  assert.doesNotMatch(hits, /background:\s*var\(--fw-bg-raised\);/)
})
