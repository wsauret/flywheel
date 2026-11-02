import assert from "node:assert/strict"
import { test } from "node:test"

const css = await Bun.file(new URL("../styles/base.css", import.meta.url)).text()
const tokens = await Bun.file(new URL("../styles/tokens.css", import.meta.url)).text()

/** The declarations of every rule whose selector list satisfies `selector`. */
function declarationsOf(selector: (text: string) => boolean): Set<string> {
  const declarations = new Set<string>()
  for (const [, prelude, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (prelude === undefined || body === undefined) continue
    const text = prelude.replace(/\/\*[\s\S]*?\*\//g, "").trim()
    if (!selector(text)) continue
    for (const declaration of body.split(";")) if (declaration.trim()) declarations.add(declaration.trim())
  }
  return declarations
}

test("controls cannot become text selections", () => {
  const controls = css.match(/:where\(button, label:has\(input\), \[role="button"\], \[role="menuitem"\], \[role="option"\], \.changes-file-header\)\s*\{([^}]*)\}/s)?.[1]
  assert.ok(controls)
  const declarations = new Set(controls.split(";").map((declaration) => declaration.trim()).filter(Boolean))
  assert.ok(declarations.has("-webkit-user-select: none"))
  assert.ok(declarations.has("user-select: none"))
})

test("every tappable control kind shows the press token while pressed, and a disabled one does not", () => {
  assert.match(tokens, /--fw-press:\s*color-mix\(in srgb, var\(--fw-fg\) \d+%, transparent\);/)
  const press = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((rule) => rule[2]?.includes("var(--fw-press)"))
  assert.ok(press, "a rule paints the press token")
  const [, commented = "", body = ""] = press
  const prelude = commented.replace(/\/\*[\s\S]*?\*\//g, "")
  assert.match(body, /box-shadow:\s*inset 0 0 0 100vmax var\(--fw-press\)/)
  const [kinds = "", ...pressed] = prelude.split(":active")
  assert.ok(pressed.length > 0, "the rule applies while the control is pressed")
  for (const kind of ["button", '[role="button"]', '[role="option"]', '[role="menuitem"]', "summary", "a[href]", ".changes-file-header"]) {
    assert.ok(kinds.includes(kind), `${kind} shows a press state`)
  }
  assert.match(prelude, /:not\([^)]*:disabled, \[aria-disabled="true"\], \.static/)
})

test("a tap is never read as a double-tap zoom and shows no default highlight", () => {
  assert.ok(declarationsOf((text) => text === "*").has("touch-action: manipulation"))
  assert.ok(declarationsOf((text) => text === "html").has("-webkit-tap-highlight-color: transparent"))
})

test("a control whose action runs shows the working state, and it holds still under reduced motion", () => {
  const working = declarationsOf((text) => text.endsWith('[aria-busy="true"]') && text.includes('[role="option"]') && text.includes("button"))
  assert.ok(working.has("cursor: progress"))
  const animation = [...working].find((declaration) => declaration.startsWith("animation:"))
  const name = animation?.split(/\s+/)[1]
  assert.ok(name, "the working state animates")
  const frames = css.match(new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? ""
  assert.match(frames, /var\(--fw-press\)/)
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)?.[1] ?? ""
  assert.match(reduced, /\[aria-busy="true"\] \{ animation: none; box-shadow: inset 0 0 0 100vmax var\(--fw-press\); \}/)
  // A checkbox's label is the control a person taps, such as Viewed.
  for (const rules of [css, reduced]) assert.match(rules, /:where\([^)]*\blabel\b[^)]*\)\[aria-busy="true"\] \{/)
})

test("a recognized swipe shows no press, so the control under the finger does not stay tinted while it slides away", async () => {
  // The screen stack marks the client while a swipe back is recognized, and
  // a session row marks itself while its tray is dragged open.
  const released = declarationsOf((text) => text.startsWith(".client.dragging :where(button,"))
  assert.ok(released.has("box-shadow: none"), "a control under a swipe back shows no press")
  const rule = css.match(/\.client\.dragging :where\(([^)]*)\):active,\s*\.session-row\.dragging,\s*\.session-row\.dragging :where\(([^)]*)\):active \{ box-shadow: none; \}/)
  assert.ok(rule, "a dragged session row and its tray buttons show no press")
  for (const kind of ["button", '[role="button"]', '[role="option"]', '[role="menuitem"]', "summary", "a[href]"]) assert.ok(rule[1]?.includes(kind), `${kind} shows no press during a swipe back`)
  // A diff box tints its own ground on a press, so it opts out by itself.
  const blocks = await Bun.file(new URL("../styles/blocks.css", import.meta.url)).text()
  assert.match(blocks, /\.client:not\(\.dragging\) \.diff-openable:active \.diff \{ background: var\(--fw-press\); \}/)
})

test("every client field on a touch device reads the floored field size, over any component's own size", () => {
  const touch = css.match(/@media \(pointer: coarse\) \{([\s\S]*?)\n\}/)?.[1] ?? ""
  // `.client :is(...)` outranks a class rule such as `.composer-field textarea`.
  assert.match(touch, /\.client :is\(input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\):not\(\[type="range"\]\), textarea\) \{ font-size: var\(--fw-text-field\); \}/)
  assert.match(tokens, /@media \(pointer: coarse\) \{\s*:root \{ --fw-text-field: max\(var\(--fw-text\), 16px\); \}/)
})
