import assert from "node:assert/strict"
import { test } from "node:test"

// Comments go first: an assignment quoted or commented out in prose sets nothing.
const declarations = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "")
const tokens = declarations(await Bun.file(new URL("../src/styles/tokens.css", import.meta.url)).text())
const theme = declarations(await Bun.file(new URL("theme.css", import.meta.url)).text())

/** Names whose value names a colour of its own: the palette a theme must
 *  restate. A value built only from other tokens follows them on its own; one
 *  that shades a token toward black or white follows the token's theme. */
function literalPaletteNames(css: string): Set<string> {
  const names = new Set<string>()
  for (const [, name, value] of css.matchAll(/(--fw-[\w-]+):\s*([^;]+);/g)) {
    if (value !== undefined && /^color-mix\(in srgb,\s*var\(--fw-[\w-]+\)\s*(?:[\d.]+%)?,\s*(?:black|white)\s*(?:[\d.]+%)?\)$/i.test(value)) continue
    if (name !== undefined && value !== undefined && /#[0-9a-f]{3,8}\b|\brgba?\(|\b(?:white|black)\b/i.test(value)) names.add(name)
  }
  return names
}

test("the light set restates every literal colour of the dark default, so no dark value reaches a light ground", () => {
  assert.deepEqual([...literalPaletteNames(`
    --fw-token-shade: color-mix(in srgb, var(--fw-accent) 80%, black);
    --fw-token-lift: color-mix(in srgb, var(--fw-fg) 65%, white);
    --fw-dark-ground: #1c1b19;
    --fw-dark-mix: color-mix(in srgb, var(--fw-fg) 80%, #1c1b19);
    --fw-dark-named: black;
  `)], ["--fw-dark-ground", "--fw-dark-mix", "--fw-dark-named"])
  const light = theme.match(/@media \(prefers-color-scheme: light\) \{([\s\S]*)\n\}/)?.[1]
  assert.ok(light, "the browser hosts' theme has a light set")
  const assigned = literalPaletteNames(light)
  // Camera-readable codes keep black on white under every theme.
  const unchanged = new Set(["--fw-qr-ground", "--fw-qr-ink"])
  const missing = [...literalPaletteNames(tokens)].filter((name) => !assigned.has(name) && !unchanged.has(name))
  assert.deepEqual(missing, [])
})
