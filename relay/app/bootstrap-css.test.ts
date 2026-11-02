import { expect, test } from "bun:test"

const bootstrap = await Bun.file(new URL("bootstrap.css", import.meta.url)).text()
const tokens = await Bun.file(new URL("../../webview/src/styles/tokens.css", import.meta.url)).text()

test("the pairing fields never set text below 16px on a touch device, so iOS never zooms the page", () => {
  expect(tokens).toMatch(/@media \(pointer: coarse\) \{\s*:root \{[^}]*--fw-text-field: max\(var\(--fw-text\), 16px\);/)
  const field = (bootstrap.match(/\.boot input \{([^}]*)\}/)?.[1] ?? "").split(";").map((declaration) => declaration.trim())
  // The shorthand resets the size, so the field's own size must come after it.
  expect(field.indexOf("font-size: var(--fw-text-field)")).toBeGreaterThan(field.indexOf("font: inherit"))
})
