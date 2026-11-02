import assert from "node:assert/strict"
import { test } from "node:test"

const css = await Bun.file(new URL("../styles/transcript.css", import.meta.url)).text()

test("reduced motion removes visual motion without changing the lifecycle gate", () => {
  const reduced = css.match(/@media \(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*)\}\s*$/)?.[1]
  assert.ok(reduced)
  assert.match(reduced, /\.activity-status\s*\{\s*transition:\s*none;\s*\}/s)
  assert.match(reduced, /\.working-marker::before\s*\{\s*animation:\s*none;\s*\}/s)
  assert.doesNotMatch(reduced, /display:\s*none|grid-template-rows|opacity/)
})
