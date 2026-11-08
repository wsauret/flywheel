import { describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import { SHIPPED_MODULES, moduleProtocolRows } from "../../../../src/orchestration/modules.js"
import { MODULE_IDS } from "../../../../src/protocol/module-ids.js"
import {
  activate,
  CAPABILITY_ROW_IDS,
  moduleRuntime,
  clearMocks,
  createModal,
  flush,
  PRESET_ROW_ID,
  rowIds,
  rowOf,
  UNKNOWN_ID_ERROR,
  valueOf,
  moduleDescriptorIdentity,
  type PolicyResult,
} from "./_settings-modal-fixtures.js"

const BINARY_MODULE_IDS = moduleProtocolRows(MODULE_IDS)
  .filter((module) => module.setting?.control === "binary")
  .toSorted((left, right) => right.dependencies.length - left.dependencies.length)
  .map((module) => module.id)

describe("Settings capability rows", () => {
  it("turns a provider module on and off with no confirmation", async () => {
    await createRoot(async (dispose) => {
      const id = "provider-claude-agent-sdk"
      const runtime = moduleRuntime({ capabilities: [] })
      const { modal } = createModal({ runtime })
      modal.openSettingsModal()
      expect(rowOf(modal, id).label).toBe("Anthropic Subscription")
      expect(valueOf(modal, id)).toBe("Off")
      activate(modal, id)
      await flush()
      expect(modal.settingsView()).not.toMatchObject({ kind: "confirmation" })
      expect(runtime.capabilities.setModule).toHaveBeenLastCalledWith(id, false, true)
      expect(valueOf(modal, id)).toBe("On - not configured")
      activate(modal, id)
      await flush()
      expect(runtime.capabilities.setModule).toHaveBeenLastCalledWith(id, true, false)
      expect(valueOf(modal, id)).toBe("Off")
      dispose()
    })
  })

  it("toggles a section boolean and removes its control when the module turns off", async () => {
    await createRoot(async (dispose) => {
      const runtime = moduleRuntime({ capabilities: ["remote"] })
      const { modal, configDispatch } = createModal({ runtime })
      modal.openSettingsModal()
      expect(valueOf(modal, "remote:remote:keep_awake")).toBe("YES")
      activate(modal, "remote:remote:keep_awake")
      await flush()
      expect(configDispatch).toHaveBeenLastCalledWith({ type: "config.mutate", setting: { id: "module", section: "remote", key: "keep_awake", expected: { kind: "value", value: true }, desired: false } })
      expect(valueOf(modal, "remote:remote:keep_awake")).toBe("NO")
      runtime.replace([])
      expect(rowIds(modal)).not.toContain("remote:remote:keep_awake")
      runtime.replace(["remote"])
      expect(valueOf(modal, "remote:remote:keep_awake")).toBe("NO")
      dispose()
    })
  })

  it("shows a module row that describes the browser only in the browser, beside its module's own row", () => {
    createRoot((dispose) => {
      const { modal } = createModal({ runtime: moduleRuntime({ capabilities: ["project-notifications"] }) })
      modal.openSettingsModal()
      const ids = rowIds(modal)
      expect(ids).toContain("project-notifications")
      expect(ids).not.toContain("project-notifications:notificationsDesktop")
      dispose()
    })
  })

  it("derives every capability row and its order from protocol metadata", () => {
    clearMocks()
    createRoot((dispose) => {
      const { modal } = createModal()
      modal.openSettingsModal()

      const ids = rowIds(modal)
      const capabilityIds = ids.filter((id) => CAPABILITY_ROW_IDS.includes(id))
      expect(capabilityIds.toSorted()).toEqual([...CAPABILITY_ROW_IDS].toSorted())
      for (const id of CAPABILITY_ROW_IDS) expect(rowOf(modal, id).kind).toBe("cycle")
      expect(rowOf(modal, PRESET_ROW_ID).kind).toBe("single-select")
      expect(ids.filter((id) => id === PRESET_ROW_ID)).toEqual([PRESET_ROW_ID])
      dispose()
    })
  })

  it("places the preferred provider in Web retrieval and steps it with arrow keys", async () => {
    clearMocks()
    await createRoot(async (dispose) => {
      const { modal, modals, settings, configDispatch } = createModal()
      modal.openSettingsModal()
      // The group opens inline, as on the web; its first row is the provider.
      activate(modal, "capability-group:Web retrieval")
      modals.input({ name: "down" })

      expect(rowOf(modal, "web-search-provider")).toMatchObject({ kind: "cycle", label: "Web search provider" })
      expect(valueOf(modal, "web-search-provider")).toBe("ChatGPT")

      modals.input({ name: "right" })
      await flush()
      expect(configDispatch).toHaveBeenLastCalledWith({ type: "config.mutate", setting: { id: "webSearchProvider", expected: { kind: "value", value: "chatgpt" }, desired: "exa" } })
      expect(settings.values.webSearchProvider).toBe("exa")
      expect(valueOf(modal, "web-search-provider")).toBe("Exa")

      modals.input({ name: "left" })
      await flush()
      expect(configDispatch).toHaveBeenLastCalledWith({ type: "config.mutate", setting: { id: "webSearchProvider", expected: { kind: "value", value: "exa" }, desired: "chatgpt" } })
      expect(settings.values.webSearchProvider).toBe("chatgpt")
      expect(modal.settingsView()).toMatchObject({ kind: "list" })
      dispose()
    })
  })

  it("derives provider identities from provider contributions", () => {
    const rows = moduleProtocolRows(MODULE_IDS)
    for (const module of SHIPPED_MODULES) {
      const provider = module.contributions.find((contribution) => contribution.domain === "providers" || contribution.domain === "webBackends")
      const row = rows.find((candidate) => candidate.id === module.id)
      expect(row?.setting?.providerId).toBe(provider?.id)
    }
  })

  it("states no row of the retired confirmation and Learning Reviews settings", () => {
    clearMocks()
    createRoot((dispose) => {
      const { modal } = createModal()
      modal.openSettingsModal()

      const ids = rowIds(modal)
      for (const retired of ["workflow-confirmation", "learning-reviews", "features-custom", "features-minimal", "features-full"]) {
        expect(ids).not.toContain(retired)
      }
      dispose()
    })
  })

  it("creates no capability rows before protocol metadata arrives", () => {
    clearMocks()
    createRoot((dispose) => {
      const runtime = moduleRuntime({ capabilities: ["skills"], hydrated: false })
      const { modal } = createModal({ runtime })
      modal.openSettingsModal()

      for (const id of [...CAPABILITY_ROW_IDS, PRESET_ROW_ID, "capability-group:Agent capabilities"]) expect(rowIds(modal)).not.toContain(id)
      expect(runtime.capabilities.setModule).not.toHaveBeenCalled()

      runtime.hydrate()
      expect(rowIds(modal)).toContain("capability-group:Agent capabilities")
      expect(valueOf(modal, "skills")).toBe("YES")
      expect(valueOf(modal, "learning")).toBe("NO")
      expect(rowOf(modal, "learning").unavailableReason?.()).toBeUndefined()
      expect(rowOf(modal, "learning").lockedReason?.()).toBeUndefined()
      dispose()
    })
  })

  it("reads every row from the runtime publication, including an external replacement", async () => {
    clearMocks()
    await createRoot(async (dispose) => {
      const runtime = moduleRuntime({ capabilities: ["skills"] })
      const { modal } = createModal({ runtime })
      modal.openSettingsModal()
      await flush()

      expect(valueOf(modal, "workflow-mode")).toBe("Off")
      expect(valueOf(modal, "learning")).toBe("NO")

      runtime.replace(["workflows", "skills", "learning"])

      expect(valueOf(modal, "workflow-mode")).toBe("Ask first")
      expect(valueOf(modal, "learning")).toBe("YES")
      expect(runtime.capabilities.setModule).not.toHaveBeenCalled()
      expect(runtime.capabilities.setWorkflowMode).not.toHaveBeenCalled()
      dispose()
    })
  })

  it("cycles Workflows On to Ask first to Off to On through the runtime", async () => {
    clearMocks()
    await createRoot(async (dispose) => {
      const runtime = moduleRuntime({ capabilities: ["workflows", "skills"], confirmationRequired: false })
      const { modal } = createModal({ runtime })
      modal.openSettingsModal()
      await flush()
      expect(valueOf(modal, "workflow-mode")).toBe("On")

      for (const [mode, value] of [["ask", "Ask first"], ["off", "Off"], ["on", "On"]] as const) {
        activate(modal, "workflow-mode")
        await flush()
        expect(runtime.capabilities.setWorkflowMode).toHaveBeenLastCalledWith(mode === "ask" ? "on" : mode === "off" ? "ask" : "off", mode)
        expect(valueOf(modal, "workflow-mode")).toBe(value)
      }

      // The tri-state control is the only Workflows mutation: it is never split
      // into a member change plus a separate confirmation write.
      expect(runtime.capabilities.setWorkflowMode).toHaveBeenCalledTimes(3)
      expect(runtime.capabilities.setModule).not.toHaveBeenCalled()
      dispose()
    })
  })

  it("toggles each binary capability as one member change", async () => {
    clearMocks()
    await createRoot(async (dispose) => {
      const runtime = moduleRuntime({ capabilities: [...BINARY_MODULE_IDS] })
      const { modal } = createModal({ runtime })
      modal.openSettingsModal()
      await flush()

      for (const feature of BINARY_MODULE_IDS) {
        expect(["YES", "On", "On - active", "On - not configured"]).toContain(valueOf(modal, feature))
        const row = rowOf(modal, feature)
        const unavailable = (row.unavailableReason?.() ?? row.lockedReason?.()) !== undefined
        activate(modal, feature)
        await flush()
        if (unavailable) continue
        expect(runtime.capabilities.setModule).toHaveBeenLastCalledWith(feature, true, false)
        expect(["NO", "Off"]).toContain(valueOf(modal, feature))
      }

      activate(modal, "learning")
      await flush()
      expect(runtime.capabilities.setModule).toHaveBeenLastCalledWith("learning", false, true)
      expect(valueOf(modal, "learning")).toBe("YES")
      dispose()
    })
  })

  it("opens explicit preset choices without writes and confirms only Minimal reductions", async () => {
    clearMocks()
    await createRoot(async (dispose) => {
      const runtime = moduleRuntime({ capabilities: ["skills"] })
      const { modal, modals } = createModal({ runtime })
      modal.openSettingsModal()
      await flush()

      expect(valueOf(modal, PRESET_ROW_ID)).toBe("Custom")
      activate(modal, PRESET_ROW_ID)
      expect(modal.settingsView()).toMatchObject({ kind: "single-select", filterable: false })
      const custom = modal.settingsView()
      if (custom.kind !== "single-select") throw new Error("Expected preset picker")
      expect(custom.currentId).toBeUndefined()
      expect(custom.result.rows.flatMap((row) => row.kind === "option" ? [row.option.value] : [])).toEqual(["full", "minimal"])
      expect(runtime.capabilities.setModules).not.toHaveBeenCalled()
      modals.input({ name: "escape" })
      expect(runtime.capabilities.setModules).not.toHaveBeenCalled()
      modals.input({ name: "right" })
      modals.input({ name: "left" })
      expect(runtime.capabilities.setModules).not.toHaveBeenCalled()
      modal.openSettingsModal()

      activate(modal, PRESET_ROW_ID)
      modal.selectSettingsOption(0)
      await flush()
      expect(runtime.capabilities.setModules).toHaveBeenLastCalledWith("full", { moduleIds: ["skills"], requireWorkflowConfirmation: true, descriptorIdentity: moduleDescriptorIdentity(["skills"], true) })
      expect(valueOf(modal, PRESET_ROW_ID)).toBe("Full")
      for (const id of BINARY_MODULE_IDS) {
        if (MODULE_IDS.includes(id)) expect(["YES", "On", "On - active", "On - not configured"]).toContain(valueOf(modal, id))
        else expect(valueOf(modal, id)).toBe("Off")
      }

      activate(modal, PRESET_ROW_ID)
      expect(modal.settingsView()).toMatchObject({ kind: "single-select", currentId: "full" })
      expect(runtime.capabilities.setModules).toHaveBeenCalledTimes(1)
      modal.selectSettingsOption(1)
      expect(modal.settingsView()).toMatchObject({ kind: "confirmation", choice: "cancel" })
      modals.input({ name: "return" })
      expect(runtime.capabilities.setModules).toHaveBeenCalledTimes(1)

      activate(modal, PRESET_ROW_ID)
      modal.selectSettingsOption(1)
      modals.input({ name: "escape" })
      expect(runtime.capabilities.setModules).toHaveBeenCalledTimes(1)
      modal.openSettingsModal()

      activate(modal, PRESET_ROW_ID)
      modal.selectSettingsOption(1)
      modals.input({ name: "left" })
      modals.input({ name: "return" })
      await flush()
      expect(runtime.capabilities.setModules).toHaveBeenCalledTimes(2)
      expect(runtime.capabilities.setModules).toHaveBeenLastCalledWith("minimal", { moduleIds: MODULE_IDS, requireWorkflowConfirmation: true, descriptorIdentity: moduleDescriptorIdentity(MODULE_IDS, true) })
      expect(valueOf(modal, PRESET_ROW_ID)).toBe("Minimal")
      for (const id of BINARY_MODULE_IDS) expect(["NO", "Off"]).toContain(valueOf(modal, id))
      expect(valueOf(modal, "workflow-mode")).toBe("Off")

      activate(modal, PRESET_ROW_ID)
      expect(modal.settingsView()).toMatchObject({ kind: "single-select", currentId: "minimal" })
      expect(runtime.capabilities.setModules).toHaveBeenCalledTimes(2)
      modal.selectSettingsOption(0)
      await flush()
      expect(runtime.capabilities.setModules).toHaveBeenLastCalledWith("full", { moduleIds: [], requireWorkflowConfirmation: true, descriptorIdentity: moduleDescriptorIdentity([], true) })
      expect(valueOf(modal, PRESET_ROW_ID)).toBe("Full")
      dispose()
    })
  })

  it("treats the preset as a complete state: Full restores ASK over an ON preference", async () => {
    clearMocks()
    await createRoot(async (dispose) => {
      // Everything enabled with Workflows ON is not the Full preset: Full is
      // the complete set with Workflows at ASK.
      const runtime = moduleRuntime({ confirmationRequired: false })
      const { modal, modals } = createModal({ runtime })
      modal.openSettingsModal()
      await flush()
      expect(valueOf(modal, "workflow-mode")).toBe("On")
      expect(valueOf(modal, PRESET_ROW_ID)).toBe("Custom")

      activate(modal, PRESET_ROW_ID)
      modal.selectSettingsOption(0)
      await flush()

      expect(runtime.capabilities.setModules).toHaveBeenLastCalledWith("full", { moduleIds: MODULE_IDS, requireWorkflowConfirmation: false, descriptorIdentity: moduleDescriptorIdentity(MODULE_IDS, false) })
      expect(runtime.confirmationRequired()).toBe(true)
      expect(valueOf(modal, "workflow-mode")).toBe("Ask first")
      expect(valueOf(modal, PRESET_ROW_ID)).toBe("Full")

      // Minimal is Workflows OFF; the restored ASK preference survives it.
      activate(modal, PRESET_ROW_ID)
      modal.selectSettingsOption(1)
      modals.input({ name: "left" })
      modals.input({ name: "return" })
      await flush()
      expect(runtime.capabilities.setModules).toHaveBeenLastCalledWith("minimal", { moduleIds: MODULE_IDS, requireWorkflowConfirmation: true, descriptorIdentity: moduleDescriptorIdentity(MODULE_IDS, true) })
      expect(runtime.confirmationRequired()).toBe(true)
      expect(valueOf(modal, PRESET_ROW_ID)).toBe("Minimal")
      dispose()
    })
  })

  it("submits the pre-confirmation selection once and reports a stale refusal", async () => {
    await createRoot(async (dispose) => {
      const runtime = moduleRuntime({ capabilities: ["skills"], confirmationRequired: false })
      const { modal, modals, showToast } = createModal({ runtime })
      runtime.capabilities.setModules.mockImplementationOnce(async () => ({ ok: false, error: { message: "selection changed" } }))
      modal.openSettingsModal()
      activate(modal, PRESET_ROW_ID)
      modal.selectSettingsOption(1)
      runtime.replace(["skills", "learning"])
      modals.input({ name: "left" })
      modals.input({ name: "return" })
      await flush()
      expect(runtime.capabilities.setModules).toHaveBeenCalledTimes(1)
      expect(runtime.capabilities.setModules).toHaveBeenCalledWith("minimal", { moduleIds: ["skills"], requireWorkflowConfirmation: false, descriptorIdentity: moduleDescriptorIdentity(["skills"], false) })
      expect(showToast).toHaveBeenCalledWith({ message: "Capabilities preset update failed: selection changed", variant: "error" })
      dispose()
    })
  })

  it("turns Skills off while Workflows stays selected, off until Skills is on again", async () => {
    clearMocks()
    await createRoot(async (dispose) => {
      const runtime = moduleRuntime({ capabilities: ["workflows", "skills"] })
      const { modal, showToast } = createModal({ runtime })
      modal.openSettingsModal()
      await flush()

      activate(modal, "skills")
      await flush()

      expect(runtime.capabilities.setModule).toHaveBeenLastCalledWith("skills", true, false)
      expect(showToast).toHaveBeenCalledWith({ message: "Skills disabled", variant: "success" })
      expect(valueOf(modal, "skills")).toBe("NO")
      expect(valueOf(modal, "workflow-mode")).toBe("Off")

      activate(modal, "skills")
      await flush()
      expect(valueOf(modal, "skills")).toBe("YES")
      expect(valueOf(modal, "workflow-mode")).toBe("Ask first")
      dispose()
    })
  })

  it("leaves the published selection unchanged and reports a failed capability command", async () => {
    clearMocks()
    await createRoot(async (dispose) => {
      const runtime = moduleRuntime()
      const { modal, showToast } = createModal({ runtime })
      runtime.capabilities.setModule.mockImplementationOnce(async () => ({ ok: false, error: { message: "runtime refused" } }))
      modal.openSettingsModal()
      await flush()

      activate(modal, "learning")
      await flush()

      expect(showToast).toHaveBeenCalledWith({ message: "Learning update failed: runtime refused", variant: "error" })
      expect(valueOf(modal, "learning")).toBe("YES")
      dispose()
    })
  })

  it("gives one modal instance the pending write and drops a superseded settlement", async () => {
    clearMocks()
    const pending = Promise.withResolvers<PolicyResult>()
    await createRoot(async (dispose) => {
      const runtime = moduleRuntime()
      const { modal, modals, showToast } = createModal({ runtime })
      runtime.capabilities.setModule.mockImplementationOnce(() => pending.promise)
      modal.openSettingsModal()
      await flush()

      activate(modal, "learning")
      activate(modal, "learning")
      activate(modal, "subagents")
      expect(runtime.capabilities.setModule).toHaveBeenCalledTimes(1)

      modals.input({ name: "escape" })
      modal.openSettingsModal()
      showToast.mockClear()

      // The reopened instance is not blocked by the superseded pending write.
      activate(modal, "subagents")
      await flush()
      expect(runtime.capabilities.setModule).toHaveBeenLastCalledWith("subagents", true, false)

      pending.resolve({ ok: true })
      await flush()

      expect(showToast).not.toHaveBeenCalledWith({ message: "Learning disabled", variant: "success" })
      dispose()
    })
  })

  it("drops a capability settlement after close without reopen", async () => {
    clearMocks()
    const pending = Promise.withResolvers<PolicyResult>()
    await createRoot(async (dispose) => {
      const runtime = moduleRuntime()
      const { modal, modals, showToast } = createModal({ runtime })
      runtime.capabilities.setModule.mockImplementationOnce(() => pending.promise)
      modal.openSettingsModal()
      await flush()

      activate(modal, "learning")
      modals.clear()
      showToast.mockClear()

      pending.resolve({ ok: true })
      await flush()

      expect(showToast).not.toHaveBeenCalled()
      dispose()
    })
  })

  it("locks member toggles with their values for an invalid selection and repairs only by complete replacement", async () => {
    clearMocks()
    await createRoot(async (dispose) => {
      const runtime = moduleRuntime({ capabilities: [], error: UNKNOWN_ID_ERROR })
      const { modal, showToast } = createModal({ runtime })
      modal.openSettingsModal()
      await flush()

      expect(showToast).toHaveBeenCalledWith({ message: `Capability configuration: ${UNKNOWN_ID_ERROR}`, variant: "error", duration: 10000 })
      // The last valid selection stays in force, so each row shows its value
      // and is locked rather than unavailable.
      for (const id of CAPABILITY_ROW_IDS) {
        expect(rowOf(modal, id).unavailableReason?.()).toBeUndefined()
        expect(rowOf(modal, id).lockedReason?.()).toBe(UNKNOWN_ID_ERROR)
        expect(valueOf(modal, id)).not.toBe("N/A")
      }
      expect(rowOf(modal, PRESET_ROW_ID).unavailableReason?.()).toBeUndefined()

      const [firstCapabilityRowId] = CAPABILITY_ROW_IDS
      if (firstCapabilityRowId === undefined) throw new Error("Expected a capability row")
      activate(modal, firstCapabilityRowId)
      await flush()
      expect(runtime.capabilities.setModule).not.toHaveBeenCalled()
      expect(runtime.capabilities.setWorkflowMode).not.toHaveBeenCalled()

      activate(modal, PRESET_ROW_ID)
      modal.selectSettingsOption(0)
      await flush()
      expect(runtime.capabilities.setModules).toHaveBeenCalledWith("full", { moduleIds: [], requireWorkflowConfirmation: true, descriptorIdentity: moduleDescriptorIdentity([], true) })
      expect(valueOf(modal, PRESET_ROW_ID)).toBe("Full")
      dispose()
    })
  })

  it("reports each distinct live error once and leaves nothing behind after it clears", async () => {
    clearMocks()
    await createRoot(async (dispose) => {
      const runtime = moduleRuntime({ capabilities: ["skills"] })
      const { modal, showToast } = createModal({ runtime })
      modal.openSettingsModal()
      await flush()
      expect(showToast).not.toHaveBeenCalled()

      runtime.publishError(UNKNOWN_ID_ERROR)
      expect(showToast).toHaveBeenCalledTimes(1)
      expect(showToast).toHaveBeenLastCalledWith({ message: `Capability configuration: ${UNKNOWN_ID_ERROR}`, variant: "error", duration: 10000 })

      runtime.publishError(UNKNOWN_ID_ERROR)
      expect(showToast).toHaveBeenCalledTimes(1)

      // Clearing is the absence of the error, not an event of its own.
      runtime.clearError()
      expect(showToast).toHaveBeenCalledTimes(1)

      // And once cleared, the same error is news again.
      runtime.publishError(UNKNOWN_ID_ERROR)
      expect(showToast).toHaveBeenCalledTimes(2)
      dispose()
    })
  })

  it("shows and changes the persisted process policy from the runtime publication", async () => {
    clearMocks()
    await createRoot(async (dispose) => {
      const runtime = moduleRuntime()
      const { modal, showToast } = createModal({ runtime })
      modal.openSettingsModal()
      await flush()

      const row = rowOf(modal, "allow-persistent-processes")
      expect(row.label).toBe("Allow persistent processes")
      expect(row.description).toBe("Let selected processes outlive Flywheel; you must stop them.")
      expect(valueOf(modal, "allow-persistent-processes")).toBe("NO")

      activate(modal, "allow-persistent-processes")
      await flush()

      expect(runtime.capabilities.setPersistentProcesses).toHaveBeenCalledWith(false, true)
      expect(valueOf(modal, "allow-persistent-processes")).toBe("YES")
      expect(showToast).toHaveBeenLastCalledWith({ message: "Persistent processes enabled for future runs", variant: "success" })
      dispose()
    })
  })

  it("keeps CLI-forced process persistence effective after persisted toggles", async () => {
    clearMocks()
    await createRoot(async (dispose) => {
      const runtime = moduleRuntime({ persistentProcesses: { persisted: false, effective: true, forcedByCli: true } })
      const { modal, showToast } = createModal({ runtime })
      modal.openSettingsModal()
      await flush()

      expect(valueOf(modal, "allow-persistent-processes")).toBe("On for this run via CLI")
      activate(modal, "allow-persistent-processes")
      await flush()
      expect(valueOf(modal, "allow-persistent-processes")).toBe("YES")

      activate(modal, "allow-persistent-processes")
      await flush()

      expect(runtime.capabilities.setPersistentProcesses).toHaveBeenLastCalledWith(true, false)
      expect(valueOf(modal, "allow-persistent-processes")).toBe("On for this run via CLI")
      expect(showToast).toHaveBeenLastCalledWith({ message: "Persistent processes disabled for future runs; still on for this run by the command line", variant: "success" })
      dispose()
    })
  })
})
