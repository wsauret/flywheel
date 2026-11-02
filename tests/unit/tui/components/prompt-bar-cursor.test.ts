import { describe, it, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const shellSource = readFileSync(join(import.meta.dir, "../../../../src/tui/components/composer.tsx"), "utf8")
const bodySource = readFileSync(join(import.meta.dir, "../../../../src/tui/components/composer-frame.tsx"), "utf8")

describe("prompt bar cursor", () => {
  it("uses the textarea default cursor style", () => {
    expect(bodySource).not.toMatch(/const PROMPT_CURSOR_STYLE = \{ style: "line", blinking: true \} as const/)
    expect(bodySource).not.toMatch(/<textarea[\s\S]*cursorStyle=\{/)
  })

  it("renders prompt text through the textarea instead of a text overlay", () => {
    expect(bodySource).not.toMatch(/textColor=\{transparent\}/)
    expect(bodySource).not.toMatch(/focusedTextColor=\{transparent\}/)
    expect(bodySource).not.toMatch(/styledOverlay/)
    expect(bodySource).toMatch(/placeholder=\{props\.text \? null : new StyledText/)
  })

  it("shows the active-agent interrupt hint in the prompt bar without replacing the idle chat hint", () => {
    expect(shellSource).toContain("Send a message to the running turn")
    expect(shellSource).toContain("esc to interrupt")
    expect(shellSource).toMatch(/Send a message \(\$\{keymap\.chordFor\("new"\)\} for fresh chat\)/)
    expect(shellSource).not.toContain("esc interrupt")
  })

  it("insets the prompt cursor, placeholder, and ghost text together", () => {
    expect(bodySource).toMatch(/const PROMPT_LEFT_INSET = 3/)
    expect(bodySource).toMatch(/<textarea[\s\S]*position="absolute" top=\{geometry\(\)\.top\} left=\{PROMPT_LEFT_INSET\}/)
    expect(bodySource).toMatch(/width=\{Math\.max\(0, geometry\(\)\.width - PROMPT_LEFT_INSET\)\}/)
    expect(shellSource).toMatch(/top=\{cursorRow\(\) \+ promptTopOffset\(\)\} left=\{cursorCol\(\) \+ PROMPT_LEFT_INSET\}/)
  })

  it("keeps prompt text inside the frame padding", () => {
    expect(bodySource).toContain("PROMPT_FRAME_HORIZONTAL_INSET")
    expect(bodySource).toMatch(/width: Math\.max\(0, width - PROMPT_FRAME_HORIZONTAL_INSET\)/)
    expect(bodySource).toMatch(/<box position="relative" width=\{geometry\(\)\.width\}/)
  })

  it("does not cap prompt height", () => {
    expect(shellSource).not.toMatch(/Math\.min\(5/)
    expect(bodySource).not.toMatch(/Math\.min\(5/)
    expect(shellSource).toMatch(/setComposerHeight\(Math\.max\(1, prompt\.editorView\.getTotalVirtualLineCount\(\)\)\)/)
    expect(shellSource).not.toMatch(/visiblePromptEnd/)
  })
})
