import { createSignal } from "solid-js"
import { createModalStack } from "../../../../src/tui/components/modal-stack.js"
import { createSettingsModalController } from "../../../../src/tui/hooks/settings-modal-controller.js"
import type { SettingsEditResult, SettingsRow } from "../../../../src/tui/hooks/settings-modal-types.js"

/** One row of each interactive kind, with controlled write settlement. */
export function createHarness(options: { blocked?: () => boolean; unavailableReason?: string; activeUnavailableReason?: () => string | undefined; initialDraft?: string; formatDraft?: (draft: string) => string } = {}) {
  const modals = createModalStack()
  const calls: string[] = []
  const submitted: string[] = []
  const errors: string[] = []
  const [selected, setSelected] = createSignal<readonly string[]>(["alpha"])
  let submitResult: SettingsEditResult | Promise<SettingsEditResult> = { ok: true }
  const submit = (draft: string) => { submitted.push(draft); return submitResult }
  const rows: SettingsRow[] = [
    { kind: "cycle", id: "cycle", label: "Cycle", value: () => "ON", onActivate: () => calls.push("cycle") },
    { kind: "action", id: "action", label: "Action", value: () => "Ready", onActivate: () => calls.push("action") },
    { kind: "picker", id: "picker", label: "Picker", value: () => "current", onActivate: () => calls.push("picker") },
    { kind: "navigation", id: "navigation", label: "Navigation", onActivate: () => calls.push("navigation") },
    {
      kind: "edit", id: "edit", label: "Edit", value: () => "42", unavailableReason: options.activeUnavailableReason,
      edit: {
        hint: "Type a number.", current: () => "42", initialDraft: () => options.initialDraft ?? "7",
        formatDraft: options.formatDraft ?? ((draft) => `<${draft}>`),
        sanitizeInput: (text) => /^\d+$/.test(text) ? text : "",
        sanitizePaste: (text) => text.replace(/\D/g, ""), submit,
      },
    },
    {
      kind: "multiselect", id: "multiselect", label: "Multiselect", unavailableReason: options.activeUnavailableReason,
      value: () => `${selected().length} on`,
      options: () => [{ id: "alpha", label: "Alpha" }, { id: "beta", label: "Beta" }, { id: "gamma", label: "Gamma" }],
      selectedIds: selected,
      onToggle: (id) => { calls.push(`toggle:${id}`); setSelected((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]) },
    },
    {
      kind: "single-select", id: "single-select", label: "Profile", value: () => "Alpha", currentId: () => "alpha",
      options: () => [
        { kind: "choice", id: "alpha", label: "Alpha" }, { kind: "choice", id: "beta", label: "Beta" },
        { kind: "action", id: "create", label: "Create profile", edit: { hint: "Name the profile.", current: () => "", initialDraft: () => "new", submit } },
      ],
      onSelect: (id) => { calls.push(`select:${id}`) },
    },
    {
      kind: "single-select", id: "single-select-hotkey", label: "Hotkey Profile", value: () => "Alpha", currentId: () => "alpha", filterable: false,
      hotkeys: [{ key: "r", hint: "r rename", run: (id) => { calls.push(`rename:${id}`) } }],
      options: () => [
        { kind: "choice", id: "alpha", label: "Alpha" }, { kind: "choice", id: "beta", label: "Beta" },
        { kind: "action", id: "create", label: "Create profile", edit: { hint: "Name the profile.", current: () => "", initialDraft: () => "new", submit } },
      ],
      onSelect: (id) => { calls.push(`select:${id}`) },
    },
    { kind: "separator" },
    { kind: "cycle", id: "unavailable", label: "Unavailable", value: () => "ON", unavailableReason: () => options.unavailableReason ?? "not published yet", onActivate: () => calls.push("unavailable") },
  ]
  const controller = createSettingsModalController({
    rows: () => rows, modal: modals, renderModal: () => "modal",
    blocked: options.blocked ?? (() => false), onError: (error) => errors.push(error),
  })
  return { modals, controller, calls, submitted, errors, selected, setSubmitResult: (result: SettingsEditResult | Promise<SettingsEditResult>) => { submitResult = result } }
}
