/** @jsxImportSource @opentui/solid */
import { expect, it } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { ThemeProvider } from "../../../../src/tui/context/theme.js"
import { ThemeModal } from "../../../../src/tui/modals/theme-modal.js"

it("keeps the theme frame in place while saving a highlight", async () => {
  const [saving, setSaving] = createSignal(false)
  const result = await testRender(() => <ThemeProvider mode="dark">
    <box width="100%" height="100%" alignItems="center" justifyContent="center">
      <ThemeModal result={{ rows: [{ kind: "option", id: "flywheel", rowIndex: 0, option: { id: "flywheel", title: "Flywheel", value: "flywheel" } }], totalMatches: 1, capped: false }} cursor={0} current="flywheel" saving={saving()} onClose={() => {}} onRowClick={() => {}} />
    </box>
  </ThemeProvider>, { width: 80, height: 30 })
  try {
    await result.renderOnce()
    const occupiedRows = () => result.captureCharFrame().split("\n").filter((line) => line.trim() !== "").length
    const before = occupiedRows()
    setSaving(true)
    await result.renderOnce()
    const frame = result.captureCharFrame()
    expect(frame).toContain("Saving...")
    expect(occupiedRows()).toBe(before)
  } finally { result.renderer.destroy(); await result.renderer.closed }
})
