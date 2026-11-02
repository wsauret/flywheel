import { describe, expect, it, mock } from "bun:test"
import { createSignal } from "solid-js"
import type { RuntimeConfigView } from "../../../../src/protocol/runtime-config-protocol-types.js"
import type { RuntimeConfigCache } from "../../../../src/tui/hooks/shell-state.js"
import { useTabsHint } from "../../../../src/tui/hooks/use-tabs-hint.js"
import { configValues } from "../modals/_settings-modal-fixtures.js"
import type { FrontendMutation, MutationResult } from "../../../../src/protocol/app-service-types.js"
import { runtimeDispatch } from "../../../helpers/runtime-dispatch.js"

type ConfigMutation = Extract<FrontendMutation, { type: "config.mutate" }>

function view(dismissed: boolean): RuntimeConfigView {
  return { revision: 1, values: { ...configValues(), tabsHintDismissed: dismissed }, status: { kind: "valid" }, warnings: [], diagnostics: [] }
}

function configDispatch(handler: (command: ConfigMutation) => Promise<MutationResult<ConfigMutation>>) {
  return { dispatch: runtimeDispatch({ "config.mutate": handler }) }
}

describe("useTabsHint", () => {
  it("stays hidden until config loads, then follows the persisted dismissal", () => {
    const [current, setCurrent] = createSignal<RuntimeConfigView | undefined>()
    const hint = useTabsHint({ view: current, settlePublication: async () => true }, configDispatch(async () => ({ kind: "committed", revision: 2 })), () => {})

    expect(hint.dismissed()).toBe(true)
    setCurrent(view(false))
    expect(hint.dismissed()).toBe(false)
    setCurrent(view(true))
    expect(hint.dismissed()).toBe(true)
  })

  it("persists the dismissal with CAS and reports a failed write", async () => {
    const config: RuntimeConfigCache = { view: () => view(false), settlePublication: async () => true }
    const dispatch = mock(async (): Promise<MutationResult<ConfigMutation>> => ({ kind: "committed", revision: 2 }))
    const showToast = mock(() => {})
    await useTabsHint(config, configDispatch(dispatch), showToast).dismiss()

    expect(dispatch).toHaveBeenCalledWith({
      type: "config.mutate",
      setting: { id: "tabsHintDismissed", expected: { kind: "value", value: false }, desired: true },
    })
    expect(showToast).not.toHaveBeenCalled()

    dispatch.mockImplementation(async () => ({ kind: "stale", message: "The configuration changed before this update. Try again." }))
    await useTabsHint(config, configDispatch(dispatch), showToast).dismiss()
    expect(showToast).toHaveBeenCalledWith({ message: "Tabs hint dismissal failed: The configuration changed before this update. Try again.", variant: "error" })
  })
})
