/** @jsxImportSource @opentui/solid */

/** Regression: the picker result is rebuilt on every clock tick (time-ago
 *  labels) and catalog refresh. Those data refreshes must never re-pin a
 *  user-owned wheel-scroll position back to the cursor; only a cursor move,
 *  a filter edit, or a viewport resize may sync the scroll. */

import { testRender } from "@opentui/solid"
import { describe, expect, it } from "bun:test"
import { createSignal } from "solid-js"
import type { SessionCatalogRow } from "../../../../src/protocol/app-service-types.js"
import type { PickerRow, PickerSessionRow } from "../../../../src/tui/session-picker/picker-types.js"

function catalogRow(id: string, title: string): SessionCatalogRow {
  return {
    id,
    kind: "chat",
    title,
    lifecycleState: "inactive",
    notices: [],
    inputMode: { kind: "chat" },
    lastUpdated: "2026-01-01T00:00:00.000Z",
    executionCwd: "/scratch/project",
    totalsLoading: true,
  }
}

function sessionRow(index: number): PickerSessionRow {
  const id = `s${String(index).padStart(2, "0")}`
  return {
    kind: "session",
    id,
    session: catalogRow(id, `session-${String(index).padStart(2, "0")}`),
    category: "Today",
  }
}

function resultOf(rows: readonly PickerRow[]) {
  return { rows, totalMatches: rows.length, capped: false, effectiveHighlightQuery: "", timeAgoWidth: 3 }
}

const HEIGHT = 14

async function renderPicker() {
  const [{ SessionPickerList }, { ThemeProvider, useTheme }, { TickPoolProvider }] = await Promise.all([
    import("../../../../src/tui/session-picker/session-picker-list.js"),
    import("../../../../src/tui/context/theme.js"),
    import("../../../../src/tui/context/tick-pool-context.js"),
  ])
  const rows = Array.from({ length: 40 }, (_, index) => sessionRow(index))
  const [result, setResult] = createSignal(resultOf(rows))
  const [cursor, setCursor] = createSignal(0)
  const [filterQuery] = createSignal("")

  function Picker() {
    const { theme } = useTheme()
    return <SessionPickerList
      result={result()}
      cursor={cursor()}
      navigationRevision={cursor()}
      actions={[]}
      theme={theme}
      height={HEIGHT}
      rowWidth={60}
      statusView={() => undefined}
      now={Date.parse("2026-01-01T00:10:00.000Z")}
      filterQuery={filterQuery()}
      inputPresentation={{ value: filterQuery(), cursor: filterQuery().length, selection: null, preferredVisualColumn: null }}
      inputPlaceholder="Search"
      renaming={false}
      renamePresentation={() => ({ value: "", cursor: 0, selection: null, preferredVisualColumn: null })}
      onRowClick={() => {}}
    />
  }

  const rendered = await testRender(
    () => <ThemeProvider mode="dark"><TickPoolProvider><Picker /></TickPoolProvider></ThemeProvider>,
    { width: 70, height: HEIGHT },
  )
  await rendered.flush()
  return { rendered, rows, setResult, setCursor }
}

describe("session picker scroll ownership", () => {
  it("holds a wheel-scrolled position across data refreshes, and follows the cursor", async () => {
    const { rendered, rows, setResult, setCursor } = await renderPicker()
    try {
      expect(rendered.captureCharFrame()).toContain("session-00")

      // Wheel down without moving the cursor: the user now owns the position.
      for (let i = 0; i < 15; i += 1) {
        await rendered.mockMouse.scroll(10, 8, "down")
        await rendered.flush()
      }
      const scrolled = rendered.captureCharFrame()
      expect(scrolled).not.toContain("session-00")

      // A data refresh (clock tick / catalog patch) rebuilds every row object.
      setResult(resultOf(rows.map((row) => ({ ...row, session: { ...row.session } }))))
      await rendered.flush()
      expect(rendered.captureCharFrame()).toBe(scrolled)
      setResult(resultOf([sessionRow(99), { kind: "header", id: "new-group", label: "Yesterday" }, ...rows]))
      await rendered.flush()
      expect(rendered.captureCharFrame()).toBe(scrolled)

      // A real cursor move still pulls the viewport back to the cursor.
      setCursor(0)
      setCursor(1)
      await rendered.flush()
      expect(rendered.captureCharFrame()).toContain("session-01")
    } finally {
      rendered.renderer.destroy()
    }
  })

  it("updates retained keyed rows in place: changed title renders, reorder keeps content correct", async () => {
    const { rendered, rows, setResult, setCursor } = await renderPicker()
    try {
      expect(rendered.captureCharFrame()).toContain("session-00")

      // Same ids, one visible content change: <Key by="id"> must update the
      // retained row, not render the stale props it was created with.
      const renamed = rows.map((row, index) => index === 0
        ? { ...row, session: { ...row.session, title: "renamed-session" } }
        : row)
      setResult(resultOf(renamed))
      await rendered.flush()
      const frame = rendered.captureCharFrame()
      expect(frame).toContain("renamed-session")
      expect(frame).not.toContain("session-00")

      // Reorder: the retained keyed rows must follow their new indices.
      setResult(resultOf(renamed.toReversed()))
      await rendered.flush()
      expect(rendered.captureCharFrame()).toContain("renamed-session")
      setCursor(1)
      setCursor(0)
      await rendered.flush()
      expect(rendered.captureCharFrame()).toContain("session-39")
    } finally {
      rendered.renderer.destroy()
    }
  })

  it("reveals the date header when the cursor wraps from the bottom to the first session", async () => {
    const { rendered, rows, setResult, setCursor } = await renderPicker()
    try {
      setResult(resultOf([{ kind: "header", id: "header:Today", label: "Today" }, ...rows]))
      setCursor(1)
      await rendered.flush()
      expect(rendered.captureCharFrame()).toContain("Today")
      setCursor(rows.length)
      await rendered.flush()
      expect(rendered.captureCharFrame()).toContain("session-39")
      expect(rendered.captureCharFrame()).not.toContain("Today")
      setCursor(1)
      await rendered.flush()
      expect(rendered.captureCharFrame()).toContain("Today")
      expect(rendered.captureCharFrame()).toContain("session-00")
    } finally {
      rendered.renderer.destroy()
    }
  })
})
