import { describe, expect, it } from "bun:test"
import { createSignal } from "solid-js"

import { createWriteRefusals } from "../../../../src/tui/hooks/settings-diagnostic-projection.js"
import type { SettingsRow } from "../../../../src/tui/hooks/settings-modal-types.js"

const row: SettingsRow = { kind: "cycle", id: "show-thinking", label: "Show thinking", value: () => "NO", onActivate: () => {} }
const warningOf = (annotated: SettingsRow): string | undefined => annotated.kind === "separator" ? undefined : annotated.warning

describe("settings write refusals", () => {
  it("marks the refused row until the configuration publishes a new revision", () => {
    const [revision, setRevision] = createSignal<number | undefined>(4)
    const refusals = createWriteRefusals(revision)
    expect(warningOf(refusals.annotate(row))).toBeUndefined()

    refusals.record("show-thinking", "Invalid TOML at line 2")
    expect(warningOf(refusals.annotate(row))).toBe("Not saved: Invalid TOML at line 2")
    expect(warningOf(refusals.annotate({ ...row, id: "diff-colors" }))).toBeUndefined()

    setRevision(5)
    expect(warningOf(refusals.annotate(row))).toBeUndefined()
  })
})
