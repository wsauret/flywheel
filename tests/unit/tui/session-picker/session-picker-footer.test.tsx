/** @jsxImportSource @opentui/solid */

import { testRender } from "@opentui/solid"
import { describe, expect, it } from "bun:test"
import type { PickerSessionRow } from "../../../../src/tui/session-picker/picker-types.js"

const row: PickerSessionRow = {
  kind: "session",
  id: "s1",
  session: { id: "s1", kind: "chat", title: "Fix the parser", lifecycleState: "active", notices: [], inputMode: { kind: "chat" }, lastUpdated: "2026-01-01T00:00:00.000Z", executionCwd: "/scratch/project", totalsLoading: true },
  category: "Today",
}

const CONTROLS = [{ key: "d", label: "delete" }, { key: "n", label: "rename" }, { key: "c", label: "copy session ID" }, { key: "i", label: "interrupt" }, { key: "x", label: "close chat" }]
const OPENS = [{ key: "enter", label: "open", opens: true as const }, { key: "ctrl+t", label: "open as tab", opens: true as const }]

async function footerLines(actions: readonly { key: string; label: string; opens?: true }[]): Promise<string[]> {
  const [{ SessionPickerList }, { ThemeProvider, useTheme }, { TickPoolProvider }] = await Promise.all([
    import("../../../../src/tui/session-picker/session-picker-list.js"),
    import("../../../../src/tui/context/theme.js"),
    import("../../../../src/tui/context/tick-pool-context.js"),
  ])
  function Picker() {
    const { theme } = useTheme()
    return <SessionPickerList
      result={{ rows: [row], totalMatches: 1, capped: false, effectiveHighlightQuery: "", timeAgoWidth: 3 }}
      cursor={0} navigationRevision={0} actions={actions} theme={theme} height={12} rowWidth={72}
      statusView={() => undefined} now={Date.parse("2026-01-01T00:10:00.000Z")} filterQuery=""
      inputPresentation={{ value: "", cursor: 0, selection: null, preferredVisualColumn: null }} inputPlaceholder="Search"
      renaming={false} renamePresentation={() => ({ value: "", cursor: 0, selection: null, preferredVisualColumn: null })} onRowClick={() => {}}
    />
  }
  const rendered = await testRender(() => <ThemeProvider mode="dark"><TickPoolProvider><Picker /></TickPoolProvider></ThemeProvider>, { width: 72, height: 12 })
  try {
    await rendered.renderOnce()
    return rendered.captureCharFrame().split("\n").map((line) => line.trim()).filter((line) => line.length > 0)
  } finally { rendered.renderer.destroy() }
}

describe("the Sessions picker footer", () => {
  it("keeps the row's own controls on their line and shows the open actions on a line of their own", async () => {
    const lines = await footerLines([...CONTROLS, ...OPENS])
    expect(lines.at(-2)).toBe("d delete · n rename · c copy session ID · i interrupt · x close chat")
    expect(lines.at(-1)).toBe("enter open · ctrl+t open as tab")
  })

  it("shows one line without open actions", async () => {
    const lines = await footerLines(CONTROLS)
    expect(lines.at(-1)).toBe("d delete · n rename · c copy session ID · i interrupt · x close chat")
    expect(lines.at(-2)).not.toContain("delete")
  })
})
