/** @jsxImportSource @opentui/solid */

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const composerSource = readFileSync(join(import.meta.dir, "../../../../src/tui/components/composer-frame.tsx"), "utf8")

describe("Composer text entry", () => {
  it("configures the native textarea from the shared text-entry bindings", () => {
    expect(composerSource).toContain("NATIVE_TEXT_ENTRY_KEY_BINDINGS")
    expect(composerSource).toContain("keyBindings={NATIVE_TEXT_ENTRY_KEY_BINDINGS}")
    expect(composerSource).not.toContain("promptEditActionForKey")
  })

  it("uses resolver-owned selection colors", () => {
    expect(composerSource).toContain("selectionBg={props.theme.selectionBackground}")
    expect(composerSource).toContain("selectionFg={props.theme.selectionForeground}")
  })
})
