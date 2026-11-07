import { batch, createComponent, createRoot, createSignal } from "solid-js"
import type { InlineSettingAction } from "../../client/settings-actions.js"
import type { ModuleId } from "../../../../src/protocol/module-ids.js"
import type { RuntimeAuthStatusSnapshotResult, RuntimeAuthView } from "../../../../src/protocol/auth-status-protocol-types.js"
import type { ProviderCatalogDiscovery, ProviderModelRow, ProviderModelTarget, ProviderModelView, RuntimeProviderModelHiddenResult } from "../../../../src/protocol/provider-model-preference-protocol-types.js"
import { fakeClient, fakeClientActions, fakeRuntimeSession, fakeViewState, fakeWebModuleHost } from "../../app/client-context-fixture.js"
import { fakeRuntimeConnection } from "../../client/runtime-connection-fixture.js"
import type { ModuleDomainViews } from "../../client/module-domain-views.js"
import type { ClientViewState } from "../../client/view-state.js"
import { PersistentPane } from "../../app/persistent-pane.js"
import { createQuestionInteractions, QuestionPanel } from "../../app/question-panel.js"
import { SessionNotices } from "../../app/session-notices.js"
import { ProviderModelsSheet } from "../../app/sheets/provider-models-sheet.js"
import { AgentHeader } from "./agent-header.js"
import type { WorkflowAgentModel } from "../../../../src/protocol/client/workflow-agent.js"
import { WorkflowCard } from "./card.js"
import { workflowCard } from "../../../../src/protocol/client/workflow-card.js"
import { workflowOutline } from "../../../../src/protocol/client/workflow-outline.js"
import { ToolbarBadges } from "../../app/toolbar-badges.js"
import { SettingsSheet } from "../../app/sheets/settings-sheet.js"
import { StatusSheet } from "../../app/sheets/status-sheet.js"
import type { PanelSettings } from "../../client/session-settings.js"
import type { LoadedWorkflowView, WorkflowAgentLive } from "../../../../src/protocol/workflow-view-protocol-types.js"
import { createElement, insert, nodes, textContent } from "../../app/render-ownership-host-fixture.js"
import { actionOwner } from "../../app/action-owner-fixture.js"
import type { RoleAssignmentView } from "../../../../src/protocol/role-protocol-types.js"

const tick = async (): Promise<void> => {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
}

const authFor = (providerId: string): RuntimeAuthView => ({
  autoEnableNewModels: { enabled: true, eligibilityRevision: 1 },
  providers: [{
    providerId,
    kind: "singleton",
    source: "stored_key",
    expired: false,
    modelCapable: true,
    loginMethod: "api-key",
    statusRank: 0,
    group: "model",
    accounts: [],
    displayName: "OpenAI",
  }],
  warnings: [],
  profile: { id: "personal", displayName: "Personal", source: "default", availableProfiles: [] },
  subscriptionSpendConsent: { kind: "unavailable", profileId: "personal", message: "Flywheel could not read this profile's paid-use settings. Paid use is off until it can." },
})

export function mountProviderModels() {
  return createRoot((disposeRoot) => {
    const root = createElement("root")
    let authStatus: RuntimeAuthStatusSnapshotResult = { snapshotPosition: 1, auth: authFor("openai") }
    const [state, setState] = createSignal(fakeViewState({ authStatus }))
    const publishAuth = (next: RuntimeAuthStatusSnapshotResult) => {
      authStatus = next
      setState((current) => ({ ...current, authStatus }))
    }
    const queries: Array<{ readonly resolve: (modelId?: string, checked?: boolean) => void; readonly resolveRows: (rows: readonly ProviderModelRow[], audit?: ProviderModelView["audit"]) => void; readonly reject: (cause: unknown) => void }> = []
    let queryCount = 0
    let dispatchCount = 0
    const dispatches: Array<() => void> = []
    const reports: string[] = []
    const refreshes: unknown[] = []
    const mutations: unknown[] = []
    /** A write that waits for `settleDispatch`, then answers that the row it wrote is hidden. */
    const heldWrite = (mutation: { readonly queriedProfileId: string; readonly queriedEligibilityRevision: number; readonly target: ProviderModelTarget }) => {
      dispatchCount += 1
      mutations.push(mutation)
      return new Promise<RuntimeProviderModelHiddenResult>((resolve) => {
        dispatches.push(() => resolve({ profileId: mutation.queriedProfileId, eligibilityRevision: mutation.queriedEligibilityRevision, target: mutation.target, hidden: true }))
      })
    }
    const catalog: ProviderCatalogDiscovery = { kind: "available", provenance: "static", liveOutcome: "valid" }
    const connection = fakeRuntimeConnection({
      queries: {
        "provider_models.query": (request) => {
          queryCount += 1
          const revision = queryCount
          return new Promise((resolve, reject) => {
            queries.push({
              resolve: (modelId, checked = true) => resolve({
                profileId: "personal",
                eligibilityRevision: revision,
                target: request.target,
                providerDisplayName: request.target.providerId,
                catalog,
                rows: [{ modelId: modelId ?? `model-${revision}`, checked, optInAvailable: true, configured: false }],
              }),
              reject,
              resolveRows: (rows, audit) => resolve({
                profileId: "personal",
                eligibilityRevision: revision,
                target: request.target,
                providerDisplayName: request.target.providerId,
                catalog,
                rows,
                recheckAvailable: true,
                audit,
              }),
            })
          })
        },
      },
      mutations: {
        "auth.catalog.refresh": (request) => {
          refreshes.push(request)
          return { ok: true }
        },
        "provider_model.set": heldWrite,
        "provider_models.recheck": heldWrite,
      },
    })
    const client = fakeClient({
      state,
      connection,
      report(_severity, message) { reports.push(message) },
      actions: fakeClientActions(actionOwner((message) => reports.push(message)), fakeRuntimeSession(), connection),
    })
    Reflect.set(globalThis, "__flywheelStabilityTestClient", client)
    insert(root, createComponent(ProviderModelsSheet, {}))
    return {
      dispose() { disposeRoot(); Reflect.deleteProperty(globalThis, "__flywheelStabilityTestClient") },
      ready: tick,
      text: () => textContent(root),
      queryCount: () => queryCount,
      resolve: (modelId?: string, checked?: boolean) => queries.shift()?.resolve(modelId, checked),
      resolveRows: (rows: readonly ProviderModelRow[], audit?: ProviderModelView["audit"]) => queries.shift()?.resolveRows(rows, audit),
      rowNamed: (modelId: string) => nodes(root).find((node) => node.tag === "button" && textContent(node).includes(modelId)),
      working: (label: string) => nodes(root).find((node) => node.tag === "button" && textContent(node).includes(label))?.properties["aria-busy"] === true,
      press: (label: string) => {
        const click = nodes(root).find((node) => node.tag === "button" && textContent(node) === label)?.properties.onClick
        if (typeof click !== "function") return false
        click()
        return true
      },
      row: () => nodes(root).find((node) => node.tag === "button" && textContent(node).includes("model-")),
      body: () => nodes(root).find((node) => typeof node.properties.class === "string" && node.properties.class.split(" ").includes("sheet-body")),
      refreshes: () => refreshes,
      reject: (message: string) => queries.shift()?.reject(new Error(message)),
      reports: () => reports,
      dispatchCount: () => dispatchCount,
      mutations: () => mutations,
      settleDispatch: () => dispatches.shift()?.(),
      equivalent: async () => { setState((current) => ({ ...current })); await tick() },
      authRevision: async (eligibility = true) => {
        publishAuth({
          auth: { ...authStatus.auth, autoEnableNewModels: { enabled: true, eligibilityRevision: (authStatus.auth.autoEnableNewModels?.eligibilityRevision ?? 0) + Number(eligibility) } },
          snapshotPosition: authStatus.snapshotPosition + 1,
        })
        await tick()
      },
      switchTarget: async () => {
        publishAuth({ snapshotPosition: authStatus.snapshotPosition + 1, auth: authFor("anthropic") })
        await tick()
      },
      mutate: () => {
        const button = nodes(root).find((node) => node.tag === "button" && textContent(node).includes("model-"))
        const click = button?.properties.onClick
        if (typeof click !== "function") return false
        click()
        return true
      },
    }
  })
}

export function mountQuestionOwnership() {
  return createRoot((disposeRoot) => {
    const root = createElement("root")
    const [block, setBlock] = createSignal({
      kind: "question" as const,
      toolUseId: "question-a",
      timestamp: 1,
      questions: [{ question: "Name?", header: "Name", multiSelect: false, choices: [{ kind: "freeform" as const, label: "Other" }] }],
    })
    Reflect.set(globalThis, "__flywheelStabilityTestClient", fakeClient({ actions: fakeClientActions({ answer() {}, cancelQuestion() {} }) }))
    insert(root, createComponent(QuestionPanel, { block, interactions: createQuestionInteractions(), sessionId: () => "chat" }))
    const input = () => nodes(root).find((node) => node.tag === "textarea")
    const answer = () => nodes(root).find((node) => node.tag === "button" && textContent(node) === "Answer")
    return {
      dispose() { disposeRoot(); Reflect.deleteProperty(globalThis, "__flywheelStabilityTestClient") },
      type(value: string) {
        const other = nodes(root).find((node) => node.tag === "button" && textContent(node).includes("Other"))
        const open = other?.properties.onClick
        if (typeof open === "function") open()
        const field = input()
        const handler = field?.properties.onInput
        if (!field || typeof handler !== "function") throw new Error("Question input is unavailable")
        handler({ currentTarget: Object.assign(field, { value }) })
      },
      answerDisabled: () => answer()?.properties.disabled,
      replace: async (toolUseId: string) => { setBlock((current) => ({ ...current, toolUseId })); await tick() },
      refresh: async () => { setBlock((current) => ({ ...current })); await tick() },
    }
  })
}

export function mountWorkflowIdentity(inline = false) {
  return createRoot((disposeRoot) => {
    const root = createElement("root")
    const attempt = { id: "one", sessionId: "worker", definitionId: "agent", briefId: "x", name: "One", status: "running" as const, history: [] }
    const [view, setView] = createSignal<LoadedWorkflowView>({ attempts: [attempt], attemptsStatus: "loaded", state: "running", tree: { nodes: [
      { id: "one:phase", kind: "phase", form: "single", phaseId: "agent", label: "One", parentId: null, disposition: "running" },
      { id: "one", kind: "agent", definitionId: "agent", label: "One", parentId: "one:phase", disposition: "running", attempts: 1, currentAttemptId: "one" },
      { id: "map:phase:1", kind: "phase", form: "list", phaseId: "survey", label: "Survey", parentId: null, disposition: "running", list: { id: "map", expanded: true }, join: { reducer: "collect@1", state: "pending", slots: 1, completed: 0, failed: 0, pending: 1, missing: 0 } },
      { id: "leaf", kind: "agent", definitionId: "survey", label: "Survey", parentId: "map:phase:1", disposition: "running", attempts: 0, item: { nodeId: "branch", key: "target", label: "Target", ordinal: 1, text: "target" } },
      { id: "leaf-2", kind: "agent", definitionId: "survey", label: "Survey", parentId: "map:phase:1", disposition: "running", attempts: 0, item: { nodeId: "branch-2", key: "other", label: "Other", ordinal: 2, text: "other" } },
    ], currentAgentNodeId: "one" } })
    const outline = () => workflowOutline(view())
    let reading: RoleAssignmentView = { assignments: { chat: { model: "wrong-chat", effort: "low" } }, serving: { slot: { kind: "role", roleId: "brief.x.at.agent" }, selection: { model: "worker-model", effort: "high" } } }
    const roleListeners = new Set<(view: RoleAssignmentView | undefined) => void>()
    const actions: unknown[] = []
    insert(root, createComponent(WorkflowCard, {
      get card() { return workflowCard(outline(), { settled: false, size: inline ? "inline" : "full" }) },
      status: "active",
      live: [],
      now: () => 0,
      get sessions() { return new Map(outline().phases.flatMap(phase => phase.agents.flatMap(agent => agent.sessionId === undefined ? [] : [[agent.agentNodeId, agent.sessionId] as const]))) },
      roles: {
        get: () => reading,
        subscribe: (_id, listener) => { roleListeners.add(listener); listener(reading); return () => { roleListeners.delete(listener) } },
      },
      get full() { return inline ? undefined : { outline: outline(), followUp: false, selected: () => undefined, onSelect() {} } },
      onAction(action) { actions.push(action) },
    }))
    const row = () => nodes(root).find((node) => String(node.properties.class).startsWith("workflow-card-phase state-running") && textContent(node).includes("survey"))
    return {
      dispose: disposeRoot,
      text: () => textContent(root),
      modelNodes: () => nodes(root).filter(node => node.properties.class === "workflow-card-model"),
      changeModel: () => {
        reading = { ...reading, serving: { ...reading.serving!, selection: { model: "edited-model", effort: "medium" } } }
        for (const listener of roleListeners) listener(reading)
      },
      actions: () => actions,
      row,
      cells: () => nodes(root).filter((node) => String(node.properties.class).startsWith("workflow-card-agent ")),
      refresh: async () => { setView((current) => structuredClone(current)); await tick() },
      completeCell: async () => {
        setView((current) => ({ ...current, tree: { ...current.tree, nodes: current.tree.nodes.map((node) => node.id === "leaf" ? { ...node, disposition: "completed" } : node) } }))
        await tick()
      },
      attention: async (id: string) => {
        setView((current) => ({ ...current, tree: { ...current.tree, nodes: current.tree.nodes.map((node) => node.kind === "agent" && node.parentId === "map:phase:1" ? { ...node, disposition: node.id === id ? "failed" : "running" } : node) } }))
        await tick()
      },
    }
  })
}

/** `moduleId` names the module whose badge the toolbar shows. */
export function mountToolbarIdentity(moduleId: ModuleId) {
  return createRoot((dispose) => {
    const root = createElement("root")
    const [state, setState] = createSignal(fakeViewState())
    const [count, setCount] = createSignal(3)
    Reflect.set(globalThis, "__flywheelStabilityTestClient", fakeClient({ state }))
    insert(root, createComponent(ToolbarBadges, {
      modules: [{ id: moduleId, toolbar: () => ({ id: "bench", label: "benches", count: count(), action: { kind: "surface", id: "bench-board" } }) }],
      report() {},
    }))
    return {
      dispose,
      row: () => nodes(root).find((node) => node.tag === "button"),
      /** One client publish, as a fresh state, that shows `next` benches. */
      refresh: async (next = count()) => {
        batch(() => { setCount(next); setState((current) => ({ ...current })) })
        await tick()
      },
    }
  })
}

/** `modules` names the enabled modules and the views each publishes; the
 *  test names them, since module ids belong to their own homes. */
export function mountModuleSheetIdentity(sheet: "settings" | "status", modules: { readonly ids: readonly ModuleId[]; readonly views: Partial<ModuleDomainViews> }) {
  return createRoot((dispose) => {
    const root = createElement("root")
    let settings: PanelSettings = {
      // Bash is on, in the Tools group, and its configuration row is the Steps
      // list; Exa puts the Web retrieval group, and the row it starts with, on the sheet.
      capabilities: {
        capabilities: ["bash", "web-exa"], moduleIds: ["bash", "web-exa"], descriptorIdentity: "test", warnings: [], requireWorkflowConfirmation: false, workflowsMode: "off", persistentProcesses: { persisted: false, effective: false, forcedByCli: false },
        modules: [{ id: "bash", installed: true, effective: true, dependencies: [], setting: { control: "binary", group: "Tools", label: "Bash", description: "Shell" }, configSettings: [{ control: "config-number-list", section: "synthetic", key: "steps", min: 1, max: 9, defaultValue: [1], label: "Steps", description: "A list" }] },
          { id: "web-exa", installed: true, effective: true, dependencies: [], setting: { control: "binary", group: "Web retrieval", label: "Exa web search", description: "Search with Exa" } }],
      },
      moduleIds: modules.ids, capabilitiesOn: 2, capabilitiesTotal: 2, capabilityPreset: "custom", workflowMode: "off",
      persistentProcesses: { persisted: false, effective: false, forcedByCli: false },
      compactionThreshold: 50_000, idleCompaction: true, shellWriteGuard: true, autoDeleteSessionDays: 0, webSearchProvider: "chatgpt", showThinking: true, showBuild: false,
      writeSyntaxTheme: "nord", diffColors: "theme", profileId: "default", providerSettings: [{ providerId: "copilot", key: "limit", label: "Copilot limit", description: "Usage limit", min: 0, max: 1000, off: 0, value: 100 }], gitAiAttribution: false, allowTrainingRoutes: false,
      problems: [], profile: { displayName: "Default", count: 1 }, configProblems: [], seatSlot: { kind: "role", roleId: "chat" }, seatEfforts: [],
      moduleSettings: [{ control: "config-number-list", section: "synthetic", key: "steps", min: 1, max: 9, defaultValue: [1], value: [1, 2], label: "Steps", description: "A list" }],
    }
    const idle = fakeViewState()
    const [state, setState] = createSignal<ClientViewState>({ ...idle, settings, modules: { ...idle.modules, ...modules.views }, health: { kind: "healthy" }, desktopPermission: "unsupported", authStatus: { snapshotPosition: 1, auth: authFor("openai") }, update: { revision: 1, autoInstall: { persisted: true, forcedOff: false, effective: true }, status: { kind: "idle" } } })
    const publishSettings = (next: PanelSettings) => {
      settings = next
      setState((current) => ({ ...current, settings }))
    }
    const writes: InlineSettingAction[] = []
    Reflect.set(globalThis, "__flywheelStabilityTestClient", fakeClient({
      state, actions: fakeClientActions({ applySetting: async (action) => { writes.push(action); return { kind: "applied" } } }),
    }))
    insert(root, createComponent(sheet === "settings" ? SettingsSheet : StatusSheet, {}))
    const row = (label: string) => nodes(root).find((node) => node.tag === "button" && textContent(node).startsWith(label))
    const input = () => nodes(root).find((node) => node.tag === "input" && node.properties["aria-label"] === "Steps")
    return {
      dispose, row, input,
      text: () => textContent(root),
      /** Every row's name, in the order the sheet shows them. */
      rowLabels: () => nodes(root).flatMap((node) => String(node.properties.class ?? "").split(" ").includes("sheet-row-label") ? [textContent(node)] : []),
      writes: () => writes,
      providerInput: () => nodes(root).find(node => node.tag === "input" && node.properties["aria-label"] === "Copilot limit"),
      providerField: () => nodes(root).find(node => String(node.properties["aria-label"]).startsWith("Copilot limit:")),
      editProvider: () => {
        const field = nodes(root).find(node => String(node.properties["aria-label"]).startsWith("Copilot limit:"))
        const click = field?.properties.onClick
        if (typeof click === "function") click()
      },
      providerValue: (value: number, profileId = "default") => publishSettings({ ...settings, profileId, providerSettings: settings.providerSettings.map(setting => ({ ...setting, value })) }),
      group: () => nodes(root).find((node) => node.properties.class === "sheet-subsection" && textContent(node) === "Tools"),
      ready: tick,
      edit: async () => {
        const button = nodes(root).find((node) => String(node.properties["aria-label"]).startsWith("Steps:"))
        const click = button?.properties.onClick
        if (typeof click !== "function") throw new Error("Missing Steps field")
        click()
        const change = input()?.properties.onInput
        if (typeof change !== "function") throw new Error("Missing Steps input")
        change({ currentTarget: { value: "1, 3, " } })
        await tick()
      },
      /** A publish of equal data as fresh objects; the state's methods stay, since a clone cannot copy them. */
      refresh: async () => {
        settings = structuredClone(settings)
        setState((current) => ({ ...current, settings, modules: structuredClone(current.modules), sessions: structuredClone(current.sessions), health: structuredClone(current.health) }))
        await tick()
      },
      changeValue: async () => {
        publishSettings({ ...settings, moduleSettings: settings.moduleSettings.map((setting) => setting.control === "config-number-list" ? { ...setting, value: [2, 4] } : setting) })
        await tick()
      },
      cancelEdit: () => {
        const handler = input()?.properties.onKeyDown
        if (typeof handler !== "function") throw new Error("Missing Steps input")
        handler({ key: "Escape", preventDefault() {}, stopPropagation() {} })
      },
      field: () => nodes(root).find((node) => String(node.properties["aria-label"]).startsWith("Steps:")),
    }
  })
}

/** One workflow agent's view over a client whose state republishes as a
 *  fresh object, as each runtime publish does, with a transcript of one
 *  block. `queries` counts the reads of the agent's transcript, and
 *  `refreshes` the delayed rereads waiting on the captured timers. */
export function mountWorkflowAgent() {
  return createRoot((disposeRoot) => {
    const root = createElement("root")
    const [state, setState] = createSignal(fakeViewState({ sessionId: "workflow", interruptible: false, windowCurrent: true }))
    const [live, setLive] = createSignal<readonly WorkflowAgentLive[]>([])
    const [model, setModel] = createSignal<WorkflowAgentModel>({ agentNodeId: "leaf", follow: true, attemptId: "attempt", kind: "list", phaseId: "map", position: "1/1", state: "running", stateText: "running", emptyText: "No output yet", label: "alpha", definitionId: "work", name: "Agent", running: true, current: true, history: [] })
    let queries = 0
    const connection = fakeRuntimeConnection({ onQuery: () => { queries += 1 } })
    const actions = fakeClientActions({ working: () => false, canOpenFiles: false, openFile() {}, interrupt() {}, resume() {}, selectSession() {} }, fakeRuntimeSession(), connection)
    Reflect.set(globalThis, "__flywheelStabilityTestClient", fakeClient({ state, connection, actions }))
    const host = fakeWebModuleHost({ state, connection, actions })
    // The clocks are captured only once the fakes exist, so `refreshes` and
    // `clocks` count what the mounted header alone schedules.
    const originalMutationObserver = Object.getOwnPropertyDescriptor(globalThis, "MutationObserver")
    Object.defineProperty(globalThis, "MutationObserver", { configurable: true, writable: true, value: class { observe() {} disconnect() {} } })
    const originalSetTimeout = globalThis.setTimeout
    const originalClearTimeout = globalThis.clearTimeout
    const timers = new Map<number, () => void>()
    let nextTimer = 0
    Object.defineProperty(globalThis, "setTimeout", { configurable: true, writable: true, value: (run: () => void) => {
      nextTimer += 1
      timers.set(nextTimer, run)
      return nextTimer
    } })
    Object.defineProperty(globalThis, "clearTimeout", { configurable: true, writable: true, value: (timer: number) => { timers.delete(timer) } })
    const originalSetInterval = globalThis.setInterval
    let clocks = 0
    Object.defineProperty(globalThis, "setInterval", { configurable: true, writable: true, value: () => {
      clocks += 1
      return clocks
    } })
    insert(root, createComponent(AgentHeader, {
      host, place: () => ({ kind: "agent", workflowId: "workflow", chatSessionId: "chat", target: { kind: "agent", agentNodeId: "leaf", follow: true }, origin: "card" }), model,
      reading: () => ({ detail: undefined, view: { attemptsStatus: "loaded", name: "Map Run", attempts: [], tree: { nodes: [] } }, live: live() }),
      back() {}, next() {}, history() {},
    }))
    return {
      dispose() {
        disposeRoot()
        if (originalMutationObserver) Object.defineProperty(globalThis, "MutationObserver", originalMutationObserver)
        else Reflect.deleteProperty(globalThis, "MutationObserver")
        Object.defineProperty(globalThis, "setTimeout", { configurable: true, writable: true, value: originalSetTimeout })
        Object.defineProperty(globalThis, "clearTimeout", { configurable: true, writable: true, value: originalClearTimeout })
        Object.defineProperty(globalThis, "setInterval", { configurable: true, writable: true, value: originalSetInterval })
      },
      queries: () => queries,
      refreshes: () => timers.size,
      /** How many times the running agent's clock started. */
      clocks: () => clocks,
      text: () => textContent(root),
      ready: tick,
      /** A publish that changes nothing the agent view shows. */
      publish: async () => {
        setState((current) => ({ ...current }))
        setModel((current) => ({ ...current }))
        await tick()
      },
      /** A publish whose live state moves the agent's revision, as each action of an agent does. */
      step: async () => {
        batch(() => { setLive([{ attemptId: "attempt", sessionId: "member", operations: 1, duration: 0, revision: 1 }]); setState((current) => ({ ...current })) })
        await tick()
      },
      runRefreshes: async () => {
        const due = [...timers.values()]
        timers.clear()
        for (const run of due) run()
        await tick()
      },
    }
  })
}

export function mountPersistentPane() {
  return createRoot((disposeRoot) => {
    const root = createElement("root")
    const [active, setActive] = createSignal(false)
    let mounts = 0
    const Resident = () => {
      mounts += 1
      const [count, setCount] = createSignal(0)
      return <button class="resident-state" onClick={() => setCount((value) => value + 1)}>draft-{count()}</button>
    }
    insert(root, createComponent(PersistentPane, {
      get active() { return active() },
      get children() { return createComponent(Resident, {}) },
      takeover: <div class="test-takeover" />,
    }))
    const resident = () => nodes(root).find((node) => node.properties.class === "resident-state")
    const container = () => nodes(root).find((node) => node.properties.class === "pane-resident")
    return {
      dispose: disposeRoot,
      mounts: () => mounts,
      resident,
      text: () => textContent(root),
      inert: () => container()?.properties.inert === true,
      activate: async () => { setActive(true); await tick() },
      takeOver: async () => { setActive(false); await tick() },
      edit() {
        const click = resident()?.properties.onClick
        if (typeof click !== "function") throw new Error("Resident control is unavailable")
        click()
      },
    }
  })
}

export function mountNoticeIdentity() {
  return createRoot((disposeRoot) => {
    const root = createElement("root")
    const notice = { scope: "provider", severity: "warning", title: "Provider", message: "Reconnect" }
    const [notices, setNotices] = createSignal([notice])
    insert(root, createComponent(SessionNotices, {
      get notices() { return notices() },
      hasHostCommand: () => false,
      runHostCommand() {},
      dismiss() {},
      dismissing: () => false,
    }))
    const row = () => nodes(root).find((node) => node.properties.class === "notice severity-warning")
    return {
      dispose: disposeRoot,
      row,
      refresh: async () => { setNotices((current) => current.map((entry) => ({ ...entry }))); await tick() },
    }
  })
}
