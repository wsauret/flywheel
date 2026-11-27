/** @jsxImportSource @opentui/solid */

import { testRender } from "@opentui/solid"
import { describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import type { TextEditorPresentation } from "../../../../../src/tui/terminal/keymap/text-entry.js"
import type { SessionModalAction } from "../../../../../src/tui/hooks/overlays/modals/session/use-session-modal-types.js"
import type { SessionPickerResult } from "../../../../../src/tui/modals/session-picker/picker-types.js"
import { createModal, pressCtrl, session } from "../../hooks/_session-modal-fixtures.js"

const presentation: TextEditorPresentation = {
  value: "alpha",
  cursor: 2,
  selection: null,
  preferredVisualColumn: null,
}

const EMPTY_RESULT: SessionPickerResult = { rows: [], totalMatches: 0, capped: false, effectiveHighlightQuery: "", timeAgoWidth: 0, searchingMessages: false }

/** Renders the picker list and returns its character frame. */
async function renderPickerFrame(field: { result: SessionPickerResult; filterQuery: string; inputPresentation: TextEditorPresentation; renaming?: boolean; actions?: readonly SessionModalAction[]; rowWidth?: number }): Promise<string> {
  const [{ SessionPickerList }, { ThemeProvider, useTheme }, { TickPoolProvider }] = await Promise.all([
    import("../../../../../src/tui/modals/session-picker/session-picker-list.js"),
    import("../../../../../src/tui/context/theme.js"),
    import("../../../../../src/tui/context/tick-pool-context.js"),
  ])

  function Picker() {
    const { theme } = useTheme()
    return <SessionPickerList
      {...field}
      cursor={0}
      navigationRevision={0}
      actions={field.actions ?? []}
      theme={theme}
      height={10}
      rowWidth={field.rowWidth ?? 90}
      statusView={() => undefined}
      chatMark={() => undefined}
      now={0}
      inputPlaceholder="Search"
      renaming={field.renaming ?? false}
      renamePresentation={() => presentation}
      onRowClick={() => {}}
    />
  }

  const rendered = await testRender(
    () => <ThemeProvider mode="dark"><TickPoolProvider><Picker /></TickPoolProvider></ThemeProvider>,
    { width: 100, height: 10 },
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

  it("names the ctrl key of each row action in the footer while the search box has text", async () => {
    const field = createRoot((dispose) => {
      const { hook } = createModal({ sessions: [session({ id: "alpha", title: "Alpha", admittedActions: ["chat.resume", "session.delete"] })] })
      hook.openSessionsModal()
      hook.handleSessionFilter("alp")
      const typed = { result: hook.sessionModalResult(), filterQuery: hook.filterQuery(), inputPresentation: hook.inputPresentation(), actions: hook.sessionModalActions() }
      dispose()
      return typed
    })
    const frame = await renderPickerFrame({ ...field, rowWidth: 96 })
    expect(frame).toContain("ctrl+d delete · ctrl+e rename · ctrl+y copy session ID · ctrl+r resume · ctrl+t mark unread")
  })

  // At the list width of a split pane, the footer drops whole hints, the
  // ones that the row's state does not ask for first.
  it("keeps the primary control and the mark whole in a narrow footer", async () => {
    const field = createRoot((dispose) => {
      const { hook } = createModal({ sessions: [session({ id: "alpha", title: "Alpha", lifecycleState: "active", admittedActions: ["chat.resume", "session.delete"] })] })
      hook.openSessionsModal()
      const typed = { result: hook.sessionModalResult(), filterQuery: hook.filterQuery(), inputPresentation: hook.inputPresentation(), actions: hook.sessionModalActions() }
      dispose()
      return typed
    })
    const footer = (await renderPickerFrame({ ...field, rowWidth: 55 })).split("\n").find((line) => line.includes("ctrl+")) ?? ""
    expect(footer.trim()).toBe("ctrl+d delete · ctrl+r resume · ctrl+t mark unread")
  })

  it("deletes to the line start with ctrl+u in the search field and marks no chat", () => {
    createRoot((dispose) => {
      const { hook, modals, appService } = createModal({ sessions: [session({ id: "alpha", title: "Alpha" })] })
      hook.openSessionsModal()
      for (const name of ["a", "l", "p"]) modals.input({ name, raw: name, sequence: name })
      expect(hook.filterQuery()).toBe("alp")
      pressCtrl(modals, "u")
      expect(hook.filterQuery()).toBe("")
      expect(appService.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "chat.mark_unread" }))
      dispose()
    })
  })
})
