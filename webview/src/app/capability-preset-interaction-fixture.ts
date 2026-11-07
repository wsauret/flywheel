import { createComponent, createRoot, createSignal } from "solid-js"
import { capabilityPreset } from "../../../src/protocol/client/capabilities.js"
import type { FrontendMutation } from "../../../src/protocol/app-service-types.js"
import type { RuntimeModulesView } from "../../../src/protocol/module-protocol-types.js"
import { MODULE_IDS } from "../../../src/protocol/module-ids.js"
import type { PanelSettings } from "../client/session-settings.js"
import type { GitAiAttributionStatus } from "../../../src/protocol/git-ai-attribution-protocol-types.js"
import type { ConfirmRequest } from "./client-context.js"
import { ConfirmDialog } from "./dialogs.js"
import { CapabilitiesSheet } from "./sheets/capabilities-sheet.js"
import { SettingsSheet } from "./sheets/settings-sheet.js"
import { createElement, insert, nodes, textContent } from "./render-ownership-host-fixture.js"
import { createClientActions } from "../client/actions.js"
import { fakeClient, fakeRuntimeSession, fakeViewState } from "./client-context-fixture.js"
import { fakeRuntimeConnection } from "../client/runtime-connection-fixture.js"

/** Mounts either real sheet over the real actions layer; only transport and dialog answers are fakes. */
export function mountCapabilityPreset(sheet: "settings" | "capabilities") {
  return createRoot((disposeRoot) => {
    const root = createElement("root")
    const initialModuleIds = MODULE_IDS.slice(0, 1)
    const expandedModuleIds = MODULE_IDS.slice(0, 2)
    let current: RuntimeModulesView = {
      capabilities: initialModuleIds, moduleIds: initialModuleIds, descriptorIdentity: "before",
      modules: expandedModuleIds.map((id, index) => ({ id, installed: true, effective: index === 0, dependencies: [] })),
      warnings: [], requireWorkflowConfirmation: false, workflowsMode: "off",
      persistentProcesses: { persisted: false, effective: false, forcedByCli: false },
    }
    let settings: PanelSettings = {
      capabilities: current, moduleIds: initialModuleIds, capabilitiesOn: 1, capabilitiesTotal: 2, capabilityPreset: "custom",
      workflowMode: "off", persistentProcesses: current.persistentProcesses, moduleSettings: [],
      compactionThreshold: 50_000, idleCompaction: true, shellWriteGuard: true, autoDeleteSessionDays: 0, webSearchProvider: "chatgpt",
      showThinking: true, showBuild: false, writeSyntaxTheme: "nord", diffColors: "theme",
      profileId: "default", providerSettings: [], gitAiAttribution: false, allowTrainingRoutes: false, problems: [],
      profile: { displayName: "Default", count: 1 }, configProblems: [],
      seatSlot: { kind: "role", roleId: "chat" }, seatEfforts: [],
    }
    const mutations: FrontendMutation[] = []
    const confirmations: ConfirmRequest[] = []
    const reports: string[] = []
    let queries = 0
    let result: { ok: true } | { ok: false; error: string } = { ok: true }
    let answer: ((confirmed: boolean) => void) | undefined
    let dialog: { root: ReturnType<typeof createElement>; dispose: () => void } | undefined
    // While held, each write waits for `release`, as one in flight over a slow link does.
    let held: (() => void)[] | undefined
    const [shown, setShown] = createSignal<PanelSettings>(settings)
    const [gitAiAttribution, setGitAiAttribution] = createSignal<GitAiAttributionStatus | undefined>(undefined)
    const connection = fakeRuntimeConnection({
      onQuery: () => { queries += 1 },
      queries: { moduleSnapshot: () => ({ capabilities: current, snapshotPosition: 1 }) },
      onDispatch(mutation) {
        mutations.push(mutation)
        return held === undefined ? undefined : new Promise<void>((resolve) => { held?.push(resolve) })
      },
      mutations: {
        "settings.set_modules": () => result,
        "settings.set_module": () => result,
        "settings.set_workflow_mode": () => result,
        "config.mutate": () => (result.ok ? { kind: "committed", revision: mutations.length } : { kind: "stale", message: "The configuration changed before this update. Try again." }),
      },
    })
    /** The settings as the runtime holds them after every write so far, as a refresh reads them. */
    const written = (before: PanelSettings): PanelSettings => {
      let { workflowMode, compactionThreshold, autoDeleteSessionDays } = before
      for (const mutation of mutations) {
        if (mutation.type === "settings.set_workflow_mode") workflowMode = mutation.mode
        if (mutation.type === "config.mutate" && mutation.setting.id === "proactiveCompactionThreshold") compactionThreshold = Number(mutation.setting.desired)
        if (mutation.type === "config.mutate" && mutation.setting.id === "autoDeleteSessionDays") autoDeleteSessionDays = Number(mutation.setting.desired)
      }
      return { ...before, workflowMode, compactionThreshold, autoDeleteSessionDays }
    }
    const actions = createClientActions({
      session: fakeRuntimeSession({ get settings() { return settings }, refreshSettings: async () => { settings = written(settings) } }),
      connection,
      capabilities: {},
      report: (_severity, message) => { reports.push(message) },
      captureSurfaceOpener: () => () => {},
    })
    const settle = (confirmed: boolean) => {
      if (!answer) throw new Error("No confirmation to answer")
      answer(confirmed)
      answer = undefined
      dialog?.dispose()
      dialog = undefined
    }
    const idle = fakeViewState()
    const client = fakeClient({
      // The rows keep what they read at mount, as they do until the
      // runtime's next settings arrive.
      state: () => ({ ...idle, settings: shown(), gitAiAttribution: gitAiAttribution() }),
      actions,
      confirm(request: ConfirmRequest) {
        confirmations.push(request)
        return new Promise<boolean>((resolve) => {
          answer = resolve
          dialog = createRoot((dispose) => {
            const dialogRoot = createElement("root")
            insert(dialogRoot, createComponent(ConfirmDialog, { request, onSettle: settle }))
            return { root: dialogRoot, dispose }
          })
        })
      },
      report: (_severity, message) => { reports.push(message) },
      connection,
    })
    Reflect.set(globalThis, "__flywheelCapabilityPresetTestClient", client)
    insert(root, createComponent(sheet === "settings" ? SettingsSheet : CapabilitiesSheet, {}))
    return {
      async ready() { for (let index = 0; index < 20; index += 1) await Promise.resolve() },
      choose(label: string) {
        const button = nodes(root).find((node) => node.properties.role === "radio" && textContent(node) === label)
        const handler = button?.properties.onClick
        if (typeof handler !== "function") throw new Error(`Missing preset button ${label}`)
        handler({})
      },
      toggle(label: string) {
        const control = nodes(root).find((node) => node.properties.role === "switch" && node.properties["aria-label"] === label)
        const handler = control?.properties.onClick
        if (typeof handler !== "function") throw new Error(`Missing capability switch ${label}`)
        handler({})
      },
      answer: settle,
      answerDefault() {
        if (!dialog) throw new Error("No confirmation dialog")
        const button = nodes(dialog.root).find((node) => node.tag === "button" && node.properties["data-autofocus"] !== undefined)
        const handler = button?.properties.onClick
        if (typeof handler !== "function") throw new Error("Missing default confirmation action")
        handler({})
      },
      replace() {
        current = {
          ...current, capabilities: expandedModuleIds, moduleIds: expandedModuleIds,
          modules: current.modules.map((module) => ({ ...module, effective: true })),
          requireWorkflowConfirmation: true, workflowsMode: "ask", descriptorIdentity: "after",
        }
      },
      refuse() { result = { ok: false, error: "selection changed" } },
      hold() { held = [] },
      release() { const waiting = held ?? []; held = undefined; for (const resolve of waiting) resolve() },
      cycleWorkflowMode() { void actions.applySetting({ kind: "cycle-workflow-mode", direction: 1 }) },
      /** Opens the in-place field that shows `value`, types `draft` when one is given, and ends the edit with Enter, Escape, or by leaving the field. A key that closes the field is followed by the blur its input's removal fires in a browser. */
      edit(value: string, draft: string | undefined, end: "enter" | "escape" | "blur") {
        const shownValue = nodes(root).find((node) => node.tag === "button" && node.properties.class === "sheet-field-value" && textContent(node) === value)
        const begin = shownValue?.properties.onClick
        if (typeof begin !== "function") throw new Error(`Missing field showing ${value}`)
        begin({})
        const input = nodes(root).find((node) => node.tag === "input")
        const { onInput, onKeyDown, onBlur } = input?.properties ?? {}
        if (typeof onInput !== "function" || typeof onKeyDown !== "function" || typeof onBlur !== "function") throw new Error("The field opened no input")
        if (draft !== undefined) onInput({ currentTarget: { value: draft } })
        if (end === "blur") {
          onBlur({})
          return
        }
        onKeyDown({ key: end === "enter" ? "Enter" : "Escape", preventDefault() {}, stopPropagation() {} })
        onBlur({})
      },
      /** Delivers settings as the session's next settings read does. */
      publishSettings(change: Partial<PanelSettings>) { setShown({ ...shown(), ...change }) },
      /** Delivers the Git AI attribution status as its workspace patch does. */
      publishGitAiAttribution: setGitAiAttribution,
      /** Delivers a capability view as the session's module patch does. */
      publish(view: RuntimeModulesView) { setShown({ ...shown(), capabilities: view, capabilityPreset: capabilityPreset(view) }) },
      switches: () => nodes(root).filter((node) => node.properties.role === "switch").map((node) => ({ label: node.properties["aria-label"], on: node.properties["aria-checked"] === true, disabled: node.properties.disabled === true })),
      problems: () => nodes(root).filter((node) => node.properties.class === "sheet-problem" || node.properties.class === "sheet-row-problem").map(textContent),
      busyChoices: () => nodes(root).filter((node) => node.properties["aria-busy"] === true).map(textContent),
      mutations, confirmations, reports, initialModuleIds,
      queries: () => queries,
      checkedChoices: () => nodes(root).filter((node) => node.properties["aria-checked"] === true).map(textContent),
      button: (label: string) => nodes(root).find(node => node.tag === "button" && textContent(node) === label),
      dispose() { dialog?.dispose(); disposeRoot(); Reflect.deleteProperty(globalThis, "__flywheelCapabilityPresetTestClient") },
    }
  })
}
