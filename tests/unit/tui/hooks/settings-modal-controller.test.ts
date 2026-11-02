import { describe, expect, it } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createModalStack } from "../../../../src/tui/components/modal-stack.js"
import { createSettingsModalController } from "../../../../src/tui/hooks/settings-modal-controller.js"
import type { SettingsEditResult, SettingsRow } from "../../../../src/tui/hooks/settings-modal-types.js"
import { groupDigits } from "../../../../src/tui/hooks/settings-digit-input.js"
import { createHarness } from "./settings-modal-controller-harness.js"
type Harness = ReturnType<typeof createHarness>

const ROW = { cycle: 0, action: 1, picker: 2, navigation: 3, edit: 4, multiselect: 5, singleSelect: 6, singleSelectHotkey: 7, unavailable: 9 } as const

function openEdit(controller: ReturnType<typeof createHarness>["controller"]): void {
  controller.open()
  controller.activateRow(ROW.edit)
}

describe("settings modal controller activation", () => {
  it("routes every interactive row kind to its own callback", () => {
    createRoot((dispose) => {
      const { controller, calls } = createHarness()
      controller.open()

      controller.activateRow(ROW.cycle)
      controller.activateRow(ROW.action)
      controller.activateRow(ROW.picker)
      controller.activateRow(ROW.navigation)
      expect(calls).toEqual(["cycle", "action", "picker", "navigation"])

      controller.activateRow(ROW.edit)
      expect(controller.view().kind).toBe("edit")
      controller.activateRow(ROW.multiselect)
      expect(controller.view().kind).toBe("multiselect")
      dispose()
    })
  })

  it("keeps Settings open under picker and navigation destinations", () => {
    createRoot((dispose) => {
      const { controller, modals, calls } = createHarness()
      controller.open()

      controller.activateRow(ROW.picker)

      // The settings-tree child pushes itself above this entry; the settings
      // entry stays on the stack so the left arrow can return to it.
      expect(modals.stack.length).toBe(1)
      expect(controller.view().kind).toBe("list")
      expect(calls).toEqual(["picker"])
      dispose()
    })
  })

  it("focuses an unavailable row but refuses to activate it", () => {
    createRoot((dispose) => {
      const { controller, calls } = createHarness()
      controller.open()

      controller.activateRow(ROW.unavailable)

      expect(controller.cursor()).toBe(ROW.unavailable)
      expect(calls).toEqual([])
      expect(controller.view().kind).toBe("list")
      dispose()
    })
  })

  it("ignores separators and every key while a durable write is pending", () => {
    createRoot((dispose) => {
      const [blocked, setBlocked] = createSignal(false)
      const { controller, modals, calls } = createHarness({ blocked })
      controller.open()

      controller.activateRow(7)
      expect(calls).toEqual([])

      setBlocked(true)
      modals.input({ name: "space" })
      controller.activateRow(ROW.cycle)
      controller.activateRow(ROW.multiselect)
      controller.toggleOption(0)
      expect(calls).toEqual([])
      dispose()
    })
  })
})

describe("settings modal controller groups", () => {
  function createGroupHarness() {
    const modals = createModalStack()
    const calls: string[] = []
    const [groupRows, setGroupRows] = createSignal<readonly SettingsRow[]>([
      { kind: "cycle", id: "provider-a", label: "Provider A", value: () => "On", onActivate: () => calls.push("provider-a"), onStep: (direction) => calls.push(`provider-a:${direction}`) },
      { kind: "cycle", id: "provider-b", label: "Provider B", value: () => "Off", onActivate: () => calls.push("provider-b") },
    ])
    const rows: readonly SettingsRow[] = [
      { kind: "cycle", id: "root", label: "Root", value: () => "On", onActivate: () => calls.push("root") },
      { kind: "group", id: "providers", label: "Model providers", rows: groupRows },
      { kind: "cycle", id: "tail", label: "Tail", value: () => "Off", onActivate: () => calls.push("tail") },
    ]
    const controller = createSettingsModalController({
      rows: () => rows,
      modal: modals,
      renderModal: () => "modal",
      blocked: () => false,
    })
    return { calls, controller, modals, setGroupRows }
  }

  it("enters a group and shows only its labeled rows", () => {
    createRoot((dispose) => {
      const { controller } = createGroupHarness()
      controller.open()

      controller.activateRow(1)

      const view = controller.view()
      expect(view.kind).toBe("list")
      if (view.kind === "list") {
        expect(view.label).toBe("Model providers")
        expect(view.rows?.map((row) => row.kind === "separator" ? "separator" : row.id)).toEqual(["provider-a", "provider-b"])
      }
      dispose()
    })
  })

  it("keeps the group open after a child toggle", () => {
    createRoot((dispose) => {
      const { calls, controller } = createGroupHarness()
      controller.open()
      controller.activateRow(1)

      controller.activateRow(0)

      expect(calls).toEqual(["provider-a"])
      expect(controller.view()).toMatchObject({ kind: "list", label: "Model providers" })
      dispose()
    })
  })

  it("steps a directional cycle before applying group back navigation", () => {
    createRoot((dispose) => {
      const { calls, controller, modals } = createGroupHarness()
      controller.open()
      controller.activateRow(1)

      modals.input({ name: "right" })
      modals.input({ name: "left" })

      expect(calls).toEqual(["provider-a:1", "provider-a:-1"])
      expect(controller.view()).toMatchObject({ kind: "list", label: "Model providers" })
      dispose()
    })
  })

  it("closes the whole modal on Escape from inside a group", () => {
    createRoot((dispose) => {
      const { controller, modals } = createGroupHarness()
      controller.open()
      controller.activateRow(1)

      modals.input({ name: "escape" })

      expect(modals.stack.length).toBe(0)
      dispose()
    })
  })

  it("backs out of a group on empty-query Backspace but stays inert at the root", () => {
    createRoot((dispose) => {
      const { controller, modals } = createGroupHarness()
      controller.open()
      controller.activateRow(1)
      modals.input({ name: "down" })

      modals.input({ name: "backspace" })

      expect(controller.view()).toMatchObject({ kind: "list", presentation: { value: "" } })
      expect(controller.cursor()).toBe(1)

      modals.input({ name: "backspace" })

      expect(controller.view()).toMatchObject({ kind: "list", presentation: { value: "" } })
      expect(modals.stack.length).toBe(1)
      dispose()
    })
  })

  it("refreshes published group rows without leaving the group", () => {
    createRoot((dispose) => {
      const { calls, controller, modals, setGroupRows } = createGroupHarness()
      controller.open()
      controller.activateRow(1)

      setGroupRows([
        { kind: "cycle", id: "provider-c", label: "Provider C", value: () => "On", onActivate: () => calls.push("provider-c") },
      ])

      const view = controller.view()
      expect(view.kind).toBe("list")
      if (view.kind === "list") {
        expect(view.label).toBe("Model providers")
        expect(view.rows?.map((row) => row.kind === "separator" ? "separator" : row.id)).toEqual(["provider-c"])
      }
      expect(controller.cursor()).toBe(0)
      modals.input({ name: "backspace" })
      expect(controller.view()).toMatchObject({ kind: "list", presentation: { value: "" } })
      expect(controller.cursor()).toBe(1)
      dispose()
    })
  })
})


describe("settings modal controller editing", () => {
  it("opens on the row's draft, formats it, and returns to the list on a successful submit", () => {
    createRoot((dispose) => {
      const { controller, modals, submitted } = createHarness()
      openEdit(controller)

      const opened = controller.view()
      expect(opened.kind).toBe("edit")
      if (opened.kind === "edit") {
        expect(opened.label).toBe("Edit")
        expect(opened.hint).toBe("Type a number.")
        expect(opened.presentation.value).toBe("<7>")
        expect(opened.current).toBe("42")
      }

      // The rejected "x" must not consume the prefill; the first accepted key
      // replaces it, and later input appends.
      modals.input({ name: "x", raw: "x" })
      modals.input({ name: "9", raw: "9" })
      modals.paste("1a2")
      const typed = controller.view()
      if (typed.kind === "edit") expect(typed.presentation.value).toBe("<912>")

      modals.input({ name: "return" })
      expect(submitted).toEqual(["912"])
      expect(controller.view().kind).toBe("list")
      dispose()
    })
  })

  it("replaces the prefill with the first accepted paste", () => {
    createRoot((dispose) => {
      const { controller, modals } = createHarness()
      openEdit(controller)

      modals.paste("1a2")
      const pasted = controller.view()
      if (pasted.kind === "edit") expect(pasted.presentation.value).toBe("<12>")
      dispose()
    })
  })

  it("publishes the shared editor selection and replaces it with typed input", () => {
    createRoot((dispose) => {
      const { controller, modals } = createHarness()
      openEdit(controller)

      const opened = controller.view()
      if (opened.kind !== "edit") throw new Error("Expected edit view")
      expect(opened.presentation).toMatchObject({ value: "<7>", cursor: 3, selection: { start: 0, end: 3 } })

      modals.input({ name: "9", raw: "9" })
      const typed = controller.view()
      if (typed.kind !== "edit") throw new Error("Expected edit view")
      expect(typed.presentation).toMatchObject({ value: "<9>", cursor: 3, selection: null })
      dispose()
    })
  })

  it("maps grouped-digit cursor positions against the complete display value", () => {
    createRoot((dispose) => {
      const { controller, modals } = createHarness({ initialDraft: "1234", formatDraft: groupDigits })
      openEdit(controller)
      modals.input({ name: "right" })
      modals.input({ name: "left" })
      const view = controller.view()
      if (view.kind !== "edit") throw new Error("Expected edit view")
      expect(view.presentation).toMatchObject({ value: "1,234", cursor: 4, selection: null })
      dispose()
    })
  })

  it("keeps the prefill through a fully rejected paste, then replaces it on accepted input", () => {
    createRoot((dispose) => {
      const { controller, modals } = createHarness()
      openEdit(controller)

      modals.paste("abc")
      const rejected = controller.view()
      if (rejected.kind === "edit") expect(rejected.presentation.value).toBe("<7>")

      modals.input({ name: "9", raw: "9" })
      const typed = controller.view()
      if (typed.kind === "edit") expect(typed.presentation.value).toBe("<9>")
      dispose()
    })
  })

  it("keeps the editor open and shows the reported error when the submit is refused", () => {
    createRoot((dispose) => {
      const { controller, modals, setSubmitResult } = createHarness()
      setSubmitResult({ ok: false, error: "too small" })
      openEdit(controller)

      modals.input({ name: "return" })
      const refused = controller.view()
      expect(refused.kind).toBe("edit")
      if (refused.kind === "edit") expect(refused.error).toBe("too small")

      // Typing clears the reported error.
      modals.input({ name: "5", raw: "5" })
      const retyped = controller.view()
      if (retyped.kind === "edit") expect(retyped.error).toBeUndefined()
      dispose()
    })
  })

  it("shows a pending write after leaving and restores the saved row after refusal", async () => {
    await createRoot(async (dispose) => {
      let settle: (result: SettingsEditResult) => void = () => {}
      const pending = new Promise<SettingsEditResult>((resolve) => { settle = resolve })
      const { controller, modals, submitted, errors, setSubmitResult } = createHarness()
      setSubmitResult(pending)
      openEdit(controller)

      modals.input({ name: "return" })
      modals.input({ name: "return" })
      modals.input({ name: "5", raw: "5" })
      modals.paste("12")

      expect(submitted).toEqual(["7"])
      expect(controller.view()).toMatchObject({ kind: "edit", saving: true, presentation: { value: "<7>" } })
      modals.input({ name: "escape" })
      const view = controller.view()
      expect(view.kind).toBe("list")
      const row = view.kind === "list" ? view.rows[ROW.edit] : undefined
      expect(row?.kind === "edit" ? row.value() : undefined).toBe("Saving...")
      settle({ ok: false, error: "runtime refused" })
      await pending
      await Promise.resolve()

      expect(controller.view().kind).toBe("list")
      expect(errors).toEqual(["runtime refused"])
      dispose()
    })
  })

  it("drops async settlement after the modal closes or is replaced", async () => {
    await createRoot(async (dispose) => {
      let settle: (result: SettingsEditResult) => void = () => {}
      const pending = new Promise<SettingsEditResult>((resolve) => { settle = resolve })
      const { controller, modals, setSubmitResult } = createHarness()
      setSubmitResult(pending)
      openEdit(controller)
      modals.input({ name: "return" })
      controller.close()
      controller.open()
      settle({ ok: true })
      await pending
      await Promise.resolve()

      expect(controller.handle()?.isOpen()).toBe(true)
      expect(controller.view().kind).toBe("list")
      dispose()
    })
  })

  it("commits on Escape without writing while the person types", () => {
    createRoot((dispose) => {
      const { controller, modals, submitted } = createHarness()
      openEdit(controller)
      modals.input({ name: "1", raw: "1" })
      modals.input({ name: "4", raw: "4" })
      expect(submitted).toEqual([])
      modals.input({ name: "escape" })

      expect(submitted).toEqual(["14"])
      expect(controller.view().kind).toBe("list")
      expect(controller.cursor()).toBe(ROW.edit)
      dispose()
    })
  })

  it("commits a typed setting when the frame closes", () => {
    createRoot((dispose) => {
      const { controller, modals, submitted } = createHarness()
      openEdit(controller)
      modals.paste("14")
      modals.clear()
      expect(submitted).toEqual(["14"])
      dispose()
    })
  })
  it("reports a durable refusal after the frame closes", async () => {
    await createRoot(async (dispose) => {
      const pending = Promise.withResolvers<SettingsEditResult>()
      const { controller, modals, errors, setSubmitResult } = createHarness()
      setSubmitResult(pending.promise)
      openEdit(controller)
      modals.paste("14")
      modals.clear()
      pending.resolve({ ok: false, error: "disk unavailable" })
      await pending.promise
      await Promise.resolve()
      expect(errors).toEqual(["disk unavailable"])
      expect(modals.stack).toHaveLength(0)
      dispose()
    })
  })

  it("refuses an edit submit that becomes unavailable after opening", () => {
    createRoot((dispose) => {
      const [reason, setReason] = createSignal<string | undefined>()
      const { controller, modals, submitted } = createHarness({ activeUnavailableReason: reason })
      openEdit(controller)
      setReason("managed by policy")

      modals.input({ name: "return" })

      expect(submitted).toEqual([])
      expect(controller.view().kind).toBe("list")
      dispose()
    })
  })
})


describe("settings modal controller multiselect", () => {
  function optionTitles(view: ReturnType<Harness["controller"]["view"]>): string[] {
    return view.kind === "multiselect" ? view.result.rows.flatMap((row) => row.kind === "option" ? [row.option.title] : []) : []
  }

  it("filters as the user types and Backspace restores the wider list", () => {
    createRoot((dispose) => {
      const { controller, modals } = createHarness()
      controller.open()
      controller.activateRow(ROW.multiselect)

      modals.input({ name: "b", raw: "b" })
      const filtered = controller.view()
      if (filtered.kind === "multiselect") expect(filtered.presentation.value).toBe("b")
      expect(optionTitles(filtered)).toEqual(["Beta"])

      modals.input({ name: "backspace" })
      expect(optionTitles(controller.view())).toEqual(["Alpha", "Beta", "Gamma"])
      dispose()
    })
  })

  it("writes the focused option immediately from Space and Enter and keeps the subview open", () => {
    createRoot((dispose) => {
      const { controller, modals, calls, selected } = createHarness()
      controller.open()
      controller.activateRow(ROW.multiselect)

      modals.input({ name: "space" })
      expect(calls).toEqual(["toggle:alpha"])
      expect(selected()).toEqual([])
      expect(controller.view().kind).toBe("multiselect")

      modals.input({ name: "down" })
      modals.input({ name: "return" })
      expect(calls).toEqual(["toggle:alpha", "toggle:beta"])
      expect(selected()).toEqual(["beta"])
      const after = controller.view()
      expect(after.kind).toBe("multiselect")
      if (after.kind === "multiselect") {
        expect(after.cursor).toBe(1)
        expect(after.selectedIds).toEqual(["beta"])
      }
      dispose()
    })
  })

  it("toggles the clicked option through the same path as the keyboard", () => {
    createRoot((dispose) => {
      const { controller, calls } = createHarness()
      controller.open()
      controller.activateRow(ROW.multiselect)

      controller.toggleOption(2)

      expect(calls).toEqual(["toggle:gamma"])
      expect(controller.view().kind).toBe("multiselect")
      dispose()
    })
  })

  it("returns to the list on the left arrow and closes the modal on Escape", () => {
    createRoot((dispose) => {
      const { controller, modals } = createHarness()
      controller.open()
      controller.activateRow(ROW.multiselect)

      modals.input({ name: "left" })

      expect(controller.view().kind).toBe("list")
      expect(modals.stack.length).toBe(1)

      controller.activateRow(ROW.multiselect)
      modals.input({ name: "escape" })
      expect(modals.stack.length).toBe(0)
      dispose()
    })
  })

  it("refuses keyboard and mouse toggles after the multiselect becomes unavailable", () => {
    createRoot((dispose) => {
      const [reason, setReason] = createSignal<string | undefined>()
      const { controller, modals, calls } = createHarness({ activeUnavailableReason: reason })
      controller.open()
      controller.activateRow(ROW.multiselect)
      setReason("managed by policy")

      modals.input({ name: "space" })
      controller.toggleOption(0)

      expect(calls).toEqual([])
      expect(controller.view().kind).toBe("list")
      dispose()
    })
  })
})

describe("settings modal controller single-select", () => {
  function optionTitles(view: ReturnType<Harness["controller"]["view"]>): string[] {
    return view.kind === "single-select" ? view.result.rows.flatMap((row) => row.kind === "option" ? [row.option.title] : []) : []
  }

  it("filters choices and invokes an ordinary selection exactly once before returning to the list", () => {
    createRoot((dispose) => {
      const { controller, modals, calls } = createHarness()
      controller.open()
      controller.activateRow(ROW.singleSelect)

      modals.input({ name: "b", raw: "b" })
      expect(optionTitles(controller.view())).toEqual(["Beta"])
      modals.input({ name: "return" })

      expect(calls).toEqual(["select:beta"])
      expect(controller.view().kind).toBe("list")
      dispose()
    })
  })

  it("runs a plain-letter choice hotkey on the option under the cursor and keeps other letters inert", () => {
    createRoot((dispose) => {
      const { controller, modals, calls } = createHarness()
      controller.open()
      controller.activateRow(ROW.singleSelectHotkey)

      modals.input({ name: "down" })
      modals.input({ name: "r", raw: "r" })

      expect(calls).toEqual(["rename:beta"])
      expect(controller.view()).toMatchObject({ kind: "single-select", filterable: false, hotkeyHint: "r rename" })
      // The row is not filterable, so a non-hotkey letter neither filters nor acts.
      modals.input({ name: "a", raw: "a" })
      expect(optionTitles(controller.view())).toEqual(["Alpha", "Beta", "Create profile"])
      // A modified press is never a hotkey.
      modals.input({ name: "r", ctrl: true })
      expect(calls).toEqual(["rename:beta"])
      dispose()
    })
  })

  it("opens an action in the shared editor and keeps its refusal visible", () => {
    createRoot((dispose) => {
      const { controller, modals, submitted, setSubmitResult } = createHarness()
      setSubmitResult({ ok: false, error: "already exists" })
      controller.open()
      controller.activateRow(ROW.singleSelect)
      controller.selectOption(2)

      const opened = controller.view()
      expect(opened.kind).toBe("edit")
      if (opened.kind === "edit") expect(opened.hint).toBe("Name the profile.")
      modals.input({ name: "return" })

      expect(submitted).toEqual(["new"])
      const refused = controller.view()
      expect(refused.kind).toBe("edit")
      if (refused.kind === "edit") expect(refused.error).toBe("already exists")
      dispose()
    })
  })

  it("returns to the settings list from the select on the left arrow and from its action editor on Escape", () => {
    createRoot((dispose) => {
      const { controller, modals } = createHarness()
      controller.open()
      controller.activateRow(ROW.singleSelect)
      modals.input({ name: "left" })
      expect(controller.view().kind).toBe("list")

      // The action editor is a text input, so Escape stays its cancel key.
      controller.activateRow(ROW.singleSelect)
      controller.selectOption(2)
      modals.input({ name: "escape" })
      expect(controller.view().kind).toBe("list")
      dispose()
    })
  })

  it("blocks keyboard and mouse selection while a durable mutation is pending", () => {
    createRoot((dispose) => {
      const [blocked, setBlocked] = createSignal(false)
      const { controller, modals, calls } = createHarness({ blocked })
      controller.open()
      controller.activateRow(ROW.singleSelect)
      setBlocked(true)

      modals.input({ name: "return" })
      controller.selectOption(1)

      expect(calls).toEqual([])
      expect(controller.view().kind).toBe("single-select")
      dispose()
    })
  })
})
