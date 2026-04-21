import { describe, it, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const shellSource = readFileSync(join(import.meta.dir, "../../src/tui/shell.tsx"), "utf8")

describe("prompt bar cursor", () => {
  it("uses the textarea default cursor style", () => {
    expect(shellSource).not.toMatch(/const PROMPT_CURSOR_STYLE = \{ style: "line", blinking: true \} as const/)
    expect(shellSource).not.toMatch(/<textarea[\s\S]*cursorStyle=\{/)
    expect(shellSource).toMatch(/<textarea[\s\S]*cursorColor=\{theme\.primary\}/)
  })
})
