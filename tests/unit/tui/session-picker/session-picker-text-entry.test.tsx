/** @jsxImportSource @opentui/solid */

import { testRender } from "@opentui/solid"
import { describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import type { TextEditorPresentation } from "../../../../src/tui/keymap/text-entry.js"
import type { SessionPickerResult } from "../../../../src/tui/hooks/use-session-modal-types.js"
import { createModal, session } from "../hooks/_session-modal-fixtures.js"

const presentation: TextEditorPresentation = {
  value: "alpha",
  cursor: 2,
  selection: null,
  preferredVisualColumn: null,
}

const EMPTY_RESULT: SessionPickerResult = { rows: [], totalMatches: 0, capped: false, effectiveHighlightQuery: "", timeAgoWidth: 0 }

/** Renders the picker list and returns its character frame. */
async function renderPickerFrame(field: { result: SessionPickerResult; filterQuery: string; inputPresentation: TextEditorPresentation; renaming?: boolean }): Promise<string> {
  const [{ SessionPickerList }, { ThemeProvider, useTheme }, { TickPoolProvider }] = await Promise.all([
    import("../../../../src/tui/session-picker/session-picker-list.js"),
    import("../../../../src/tui/context/theme.js"),
    import("../../../../src/tui/context/tick-pool-context.js"),
  ])

  function Picker() {
    const { theme } = useTheme()
    return <SessionPickerList
      {...field}
      cursor={0}
      navigationRevision={0}
      actions={[]}
      theme={theme}
      height={10}
      rowWidth={40}
      statusView={() => undefined}
      now={0}
      inputPlaceholder="Search"
      renaming={field.renaming ?? false}
      renamePresentation={() => presentation}
      onRowClick={() => {}}
    />
  }

  const rendered = await testRender(
    () => <ThemeProvider mode="dark"><TickPoolProvider><Picker /></TickPoolProvider></ThemeProvider>,
    { width: 50, height: 10 },
  )

  try {
    await rendered.flush()
    return rendered.captureCharFrame()
  } finally {
    rendered.renderer.destroy()
  }
}

describe("session picker text entry", () => {
  it("renders the caller-owned field presentation without a native input buffer", async () => {
    const frame = await renderPickerFrame({ result: EMPTY_RESULT, filterQuery: "alpha", inputPresentation: presentation })
    expect(frame).toContain("alpha")
    const renameFrame = await renderPickerFrame({ result: EMPTY_RESULT, filterQuery: "", inputPresentation: presentation, renaming: true })
    expect(renameFrame).toContain("Tab title (14 characters)")
    expect(renameFrame).toContain("Description")
  })

  it("types every printable letter, j and k included, into the search field", async () => {
    const field = createRoot((dispose) => {
      const { hook, modals } = createModal({ sessions: [session({ id: "alpha", title: "Alpha" })] })
      hook.openSessionsModal()
      for (const name of ["j", "k", "h", "l"]) modals.input({ name, raw: name, sequence: name })
      const typed = { result: hook.sessionModalResult(), filterQuery: hook.filterQuery(), inputPresentation: hook.inputPresentation() }
      dispose()
      return typed
    })
    const frame = await renderPickerFrame(field)
    expect(frame).toContain("jkhl")
  })
})
