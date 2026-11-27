import { createComponent, createRoot, createSignal, type JSX } from "solid-js"

import type { MutationResult, RuntimeHealth, RuntimeRestartReadiness } from "../../../src/protocol/runtime/app-service-types.js"
import type { RuntimeConnection } from "../../../src/protocol/client/runtime/connection.js"
import type { BudgetSummary } from "../../../src/protocol/client/host/host-contract.js"
import type { UpdateStatus, UpdateStatusView } from "../../../src/protocol/runtime/update-protocol-types.js"
import type { ClientViewState, SessionSummary } from "../client/session/view-state.js"
import { createModuleDomainMonitors, type ModuleDomainViews } from "../client/domains/module-domain-views.js"
import { fakeLanes } from "../../../tests/helpers/fake-lanes.js"
import { fakeRuntimeConnection, type FakeConnectionScript } from "./runtime-connection-fixture.js"
import { statusView } from "../../../tests/helpers/runtime-views.js"
import type { ClientContextValue } from "../app/client-context.js"
import { ClientContext } from "../app/client-context.js"
import { fakeClient, fakeClientActions, fakeRuntimeSession } from "../app/client-context-fixture.js"
import type { PlacementLabels, ScreenStack } from "../app/screens/screen-stack.js"
import { createCommandPanel } from "../app/composer/menus/command-panel.js"
import { createElement, insert, nodes, textContent } from "./render-ownership-host-fixture.js"
import { SessionList } from "../app/sessions/session-list.js"
import { selectNeedsYou } from "../../../src/protocol/client/session/needs-you.js"
import type { WaitingSessionsView } from "../../../src/protocol/session/question-protocol-types.js"
import type { UnreadChatsView } from "../../../src/protocol/session/unread-protocol-types.js"
import { StatusSheet } from "../app/sheets/workspace/status-sheet.js"
import { Toolbar } from "../app/toolbar/toolbar.js"

/** Every module domain with no view landed, as the real monitors read
 *  before their lane opens. */
function emptyModules(): ModuleDomainViews {
  const monitors = createModuleDomainMonitors({ connection: fakeRuntimeConnection({}, fakeLanes({ open: false }).client), onChange: () => {} })
  const views = monitors.views(undefined)
  monitors.dispose()
  return views
}

const EMPTY_MODULES = emptyModules()
const NO_ONE_NEEDED = selectNeedsYou({ waiting: undefined, unread: undefined, listed: [] })

const LOADING_BUDGET: BudgetSummary = { totalsLoading: true, compactionThreshold: 100_000 }
const READY_BUDGET = {
  totalsLoading: false,
  totalTokens: 12_345,
  contextPromptTokens: 4_000,
  cost: 1.25,
  billedCost: 0.5,
  priceUnavailable: false,
  contextPercent: 25,
  compactionThreshold: 100_000,
} as const satisfies BudgetSummary

function state(budget: BudgetSummary = LOADING_BUDGET, health: RuntimeHealth = { kind: "healthy" }): ClientViewState {
  return {
    stage: "ready",
    desktopPermission: "unsupported",
    providers: [],
    builtInCommands: [],
    offCommands: [],
    budget,
    notices: [],
    groups: {},
    health,
    status: "idle",
    sessionId: "session-a",
    executionCwd: "/tmp/project",
    sessions: [summary()],
    needsYou: NO_ONE_NEEDED,
    newestQuestionOpenedAt: undefined,
    children: [],
    roleAssignments: () => undefined,
    subscribeRoleAssignments: () => () => {},
    subscribeStatus: () => () => {},
    sessionErrors: [],
    modules: EMPTY_MODULES,
    blocks: [],
    localSubmissions: [],
    streamingToolText: {},
    bodies: {},
    visibleMessageCount: 0,
    startBlockIndex: null,
    windowGeneration: 0,
    hasBefore: false,
    atTail: true,
    hasNewer: false,
    transcriptAvailable: true,
    settledOutputPosition: 0,
    appliedOutputPosition: 0,
    busy: false,
    interruptible: false,
    windowCurrent: true,
    changes: undefined,
    projectRoot: "/tmp/project",
    git: { directories: {} },
    runtimeVersion: "test",
    commandUsage: [],
  }
}

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "session-a",
    title: "Session A",
    kind: "chat",
    lifecycleState: "inactive",
    active: false,
    working: false,
    lastUpdated: "2026-09-18T12:00:00.000Z",
    totalsLoading: true,
    ...overrides,
  }
}

function client(current: () => ClientViewState, script: FakeConnectionScript = {}, reconnect: () => void = () => {}, lanes: Parameters<typeof fakeRuntimeConnection>[1] = {}): ClientContextValue {
  return fakeClient({
    connection: fakeRuntimeConnection(script, lanes),
    actions: fakeClientActions({ reconnect }),
    state: current,
    confirm: async () => false,
    prompt: async () => undefined,
  })
}

/** The phone's screen stack showing the open chat under `placement`. */
function chatStack(placement: PlacementLabels | undefined): ScreenStack {
  return {
    screen: () => "chat", canForward: () => false, dragX: () => undefined, placement: () => placement,
    openChat() {}, showSessions() {}, back() {}, forward() {}, bindSwipe: () => () => {},
  }
}

function withClass(root: ReturnType<typeof createElement>, className: string) {
  return nodes(root).find((node) => typeof node.properties.class === "string" && node.properties.class.split(" ").includes(className))
}

function rowNamed(root: ReturnType<typeof createElement>, label: string) {
  return nodes(root).find((node) => typeof node.properties.class === "string"
    && node.properties.class.split(" ").includes("sheet-row")
    && node.children.some((child) => textContent(child).includes(label)))
}

/** The sheet row whose label is exactly `label`, not one that only starts with it. */
function rowLabelled(root: ReturnType<typeof createElement>, label: string) {
  return nodes(root).find((node) => typeof node.properties.class === "string"
    && node.properties.class.split(" ").includes("sheet-row")
    && nodes(node).some((child) => typeof child.properties.class === "string" && child.properties.class.split(" ").includes("sheet-row-label") && textContent(child) === label))
}

export function mountToolbarBudget(layout: "wide" | "folded" | "phone" | "narrow" = "wide") {
  return createRoot((dispose) => {
    const [current, setCurrent] = createSignal(state())
    const root = createElement("root")
    let compactions = 0
    let answerCompaction = () => {}
    const owner = fakeClientActions({}, fakeRuntimeSession({ get sessionId() { return current().sessionId }, compact: () => { compactions += 1; return new Promise<void>((resolve) => { answerCompaction = resolve }) } }))
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
    Object.defineProperty(globalThis, "document", { configurable: true, value: root.ownerDocument })
    insert(root, createComponent(ClientContext.Provider, {
      value: { ...client(current), actions: owner, ...(layout === "phone" ? { stack: chatStack({ project: "Phone project", machine: "Phone machine" }) } : {}) },
      get children() {
        return createComponent(Toolbar, { wide: layout === "wide", rail: { collapsed: layout === "folded", toggle() {} }, modules: [] })
      },
    }))
    return {
      dispose() {
        dispose()
        if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument)
        else Reflect.deleteProperty(globalThis, "document")
      },
      setReady() { setCurrent(state(READY_BUDGET)) },
      setBudget(budget: BudgetSummary) { setCurrent(state(budget)) },
      setBusy(busy: boolean) { setCurrent((value) => ({ ...value, busy })) },
      /** Lists `count` chats that need the person, which the header counts. */
      setNeedsYou(count: number) { setCurrent((value) => ({ ...value, needsYou: { rows: [], unread: new Set(), count } })) },
      needs: () => withClass(root, "toolbar-needs"),
      setLocation(executionCwd: string | undefined, git: ClientViewState["git"]) { setCurrent((value) => ({ ...value, executionCwd, git })) },
      location: () => withClass(root, layout === "phone" ? "toolbar-subtitle" : "toolbar-location"),
      locationText: () => {
        const location = withClass(root, layout === "phone" ? "toolbar-subtitle" : "toolbar-location")
        return location === undefined ? undefined : textContent(location)
      },
      setSession(sessionId: string, budget: BudgetSummary = LOADING_BUDGET) { setCurrent({ ...state(budget), sessionId }) },
      setUpdate(status: UpdateStatus) { setCurrent({ ...state(), update: { revision: 1, autoInstall: { persisted: true, forcedOff: false, effective: true }, status } }) },
      /** The update chip's words, or undefined while the toolbar shows no chip. */
      updateChipText: () => {
        const chip = withClass(root, "connection-update")
        return chip === undefined ? undefined : textContent(chip)
      },
      text: () => textContent(root),
      pill: () => withClass(root, "cost-pill"),
      generationSpeed: () => withClass(root, "generation-speed"),
      pillText: () => {
        const pill = withClass(root, "cost-pill")
        return pill === undefined ? "" : textContent(pill)
      },
      gauge: () => withClass(root, "context-gauge"),
      contextButton: () => withClass(root, "context-ring"),
      contextText: () => textContent(withClass(root, "context-ring") ?? root),
      contextPopover: () => withClass(root, "context-popover"),
      clickContext() {
        const button = withClass(root, "context-ring")
        if (!button || typeof button.properties.onClick !== "function") throw new Error("Toolbar has no context control")
        button.properties.onClick()
      },
      compactContext() {
        const button = nodes(root).find((node) => node.tag === "button" && textContent(node) === "Compact now")
        if (!button || typeof button.properties.onClick !== "function") throw new Error("Context popover has no compaction action")
        button.properties.onClick()
      },
      compactions: () => compactions,
      async answerCompaction() {
        answerCompaction()
        for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
      },
      stableControl: () => withClass(root, "toolbar-rail"),
    }
  })
}

/** Mounts the toolbar over the real actions layer, wide or as the phone's
 *  chat screen, whose session holds every Close, Delete, and Rename until
 *  `release`. The panel starts them, so no session row is on screen. */
export function mountToolbarActing(layout: "wide" | "phone") {
  return createRoot((dispose) => {
    const held: (() => void)[] = []
    const hold = () => new Promise<void>((resolve) => { held.push(resolve) })
    const owner = fakeClientActions({}, fakeRuntimeSession({ sessionId: "session-a", close: hold, remove: hold, rename: hold }))
    const value: ClientContextValue = { ...client(() => state()), actions: owner, ...(layout === "phone" ? { stack: chatStack(undefined) } : {}) }
    const root = createElement("root")
    insert(root, createComponent(ClientContext.Provider, {
      value,
      get children() { return createComponent(Toolbar, { wide: layout === "wide", modules: [] }) },
    }))
    return {
      actions: owner,
      dispose,
      release: async () => {
        for (const resolve of held.splice(0)) resolve()
        for (let index = 0; index < 12; index += 1) await Promise.resolve()
      },
      /** Whether the open chat's title reads working. */
      titleBusy: () => withClass(root, "toolbar-title")?.properties["aria-busy"] === true,
    }
  })
}

/** Mounts a sheet in the shared client context with controllable queries and session selection. `lanes` replaces the
 *  connection's open first lane, for a sheet that reads again when a lane opens. */
export function mountClientSheet(sheet: () => JSX.Element, script: FakeConnectionScript, lanes: Parameters<typeof fakeRuntimeConnection>[1] = {}) {
  return createRoot((dispose) => {
    const [current, setCurrent] = createSignal(state())
    const root = createElement("root")
    insert(root, createComponent(ClientContext.Provider, {
      value: client(current, script, undefined, lanes),
      get children() { return sheet() },
    }))
    return {
      dispose,
      elements: () => nodes(root),
      row: (label: string) => rowLabelled(root, label),
      setSession(sessionId: string) { setCurrent({ ...state(), sessionId }) },
      settle: async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve() },
      text: () => textContent(root),
      rowText: (label: string) => {
        const row = rowLabelled(root, label)
        return row === undefined ? undefined : textContent(row)
      },
      clickButton(labels: readonly string[]) {
        const button = nodes(root).find((node) => node.tag === "button" && labels.includes(textContent(node)))
        const click = button?.properties.onClick
        if (typeof click !== "function") throw new Error(`Sheet button unavailable: ${labels.join(", ")}`)
        click()
      },
    }
  })
}

/** The command menu with the catalog's Compact conversation entry, whose value reads the budget. */
export function mountCommandPanelBudget() {
  return createRoot((dispose) => {
    const compact = { id: "compact", title: "Compact conversation", description: "Compact", aliases: [], menu: { group: "chat", rank: 200 }, reading: "context-window" } as const
    const withCompact = (budget?: BudgetSummary): ClientViewState => ({ ...state(budget), builtInCommands: [compact] })
    const [current, setCurrent] = createSignal(withCompact())
    const root = createElement("root")
    const panel = createCommandPanel({ client: client(current), query: () => "", close() {} })
    insert(root, panel.view)
    const panelRow = (label: string) => nodes(root).find((node) => node.properties.class === "panel-row" && textContent(node).includes(label))
    return {
      dispose,
      setReady() { setCurrent(withCompact(READY_BUDGET)) },
      /** The ready budget with the trigger that the runtime published for the session. */
      setPublishedTrigger(compactionTriggerTokens: number) { setCurrent(withCompact({ ...READY_BUDGET, compactionTriggerTokens })) },
      spendRow: () => panelRow("Spend"),
      compactRow: () => panelRow("Compact conversation"),
      compactValue: () => withClass(panelRow("Compact conversation") ?? root, "panel-value"),
      compactValueText: () => {
        const value = withClass(panelRow("Compact conversation") ?? root, "panel-value")
        return value === undefined ? "" : textContent(value)
      },
    }
  })
}

export function mountSessionListBudget() {
  return createRoot((dispose) => {
    const metadata = { awaitingAnswer: true, diffStats: { added: 1, modified: 2, removed: 3 } }
    const [sessions, setSessions] = createSignal<readonly SessionSummary[]>([summary(metadata)])
    const [shown, setShown] = createSignal(false)
    const [errors, setErrors] = createSignal<readonly { sessionId: string; scope: "metadata"; reason: string }[]>([])
    const deleted: string[] = []
    const root = createElement("root")
    insert(root, createComponent(SessionList, {
      get sessions() { return sessions() },
      get errors() { return errors() },
      needsYou: NO_ONE_NEEDED,
      turns: undefined,
      selected: "session-a",
      get shown() { return shown() },
      actions: { onSelect() {}, onCopy() {}, onDelete(id) { deleted.push(id) }, working: () => false },
    }))
    return {
      dispose,
      setErrors,
      deleted,
      elements: () => nodes(root),
      show() { setShown(true) },
      selectedRow: () => nodes(root).find((node) => node.properties["aria-selected"] === true),
      setNeed(overrides: Partial<SessionSummary>) { setSessions([summary(overrides)]) },
      badge: () => withClass(root, "session-badge"),
      setReady(diffStats = metadata.diffStats) { setSessions([summary({ ...metadata, diffStats, totalsLoading: false, totalCost: 1.25 })]) },
      text: () => textContent(root),
      meta: () => withClass(root, "session-meta"),
      metaText: () => {
        const meta = withClass(root, "session-meta")
        return meta === undefined ? "" : textContent(meta)
      },
      stableControl: () => nodes(root).find((node) => node.tag === "button"),
    }
  })
}

/** The rail's list with a search: title matches from the catalog, and the
 *  chats `found` answers for the messages, after a pause of 0 ms. A blank
 *  search, the index catch-up that the list sends as it opens, counts in
 *  `prepared` and answers no chats. */
export function mountSessionListSearch(found: (query: string, signal: AbortSignal) => Promise<{ chats: readonly { sessionId: string; entryId: string; snippet: string; excerpt?: { source: "checkpoint" | "final"; text: string } }[] }>) {
  return createRoot((dispose) => {
    const [filter, setFilter] = createSignal("")
    const opened: string[] = []
    let prepared = 0
    const root = createElement("root")
    insert(root, createComponent(SessionList, {
      sessions: [summary({ id: "kafka", title: "Kafka pipeline" }), summary({ id: "other", title: "Other work" }), summary({ id: "third", title: "Third" })],
      errors: [],
      needsYou: NO_ONE_NEEDED,
      turns: undefined,
      selected: undefined,
      get filter() { return filter() },
      contentSearchDelayMs: 0,
      actions: { onSelect() {}, working: () => false, searchChats: ({ query }, signal) => {
        if (query !== "") return found(query, signal)
        prepared++
        return Promise.resolve({ chats: [] })
      }, onOpenAt(sessionId, entryId) { opened.push(`${sessionId}@${entryId}`) } },
    }))
    return {
      dispose,
      setFilter,
      opened,
      prepared: () => prepared,
      text: () => textContent(root),
      click(id: string) {
        const row = nodes(root).find((node) => node.properties["data-found"] === id)
        if (!row || typeof row.properties.onClick !== "function") throw new Error(`No found row for ${id}`)
        row.properties.onClick()
      },
      row: (id: string) => nodes(root).find((node) => node.properties["data-session"] === id || node.properties["data-found"] === id),
      rowOrder: () => nodes(root).flatMap((node) => {
        const id = node.properties["data-session"] ?? node.properties["data-found"]
        return typeof id === "string" ? [id] : []
      }),
    }
  })
}

/** The rail's list fed the project's waiting and unread sets as the runtime
 *  publishes them: each publication a new object. Records the marks sent. */
export function mountSessionListUnread(sessions: readonly SessionSummary[]) {
  return createRoot((dispose) => {
    const [listed, setListed] = createSignal(sessions)
    const [waiting, setWaiting] = createSignal<WaitingSessionsView | undefined>()
    const [unread, setUnread] = createSignal<UnreadChatsView | undefined>()
    const marked: string[] = []
    const root = createElement("root")
    insert(root, createComponent(SessionList, {
      get sessions() { return listed() },
      errors: [],
      get needsYou() { return selectNeedsYou({ waiting: waiting(), unread: unread(), listed: listed() }) },
      get turns() { return unread()?.turns },
      selected: undefined,
      grouped: true,
      actions: { onSelect() {}, working: () => false, onMarkRead(id) { marked.push(`read:${id}`) }, onMarkUnread(id) { marked.push(`unread:${id}`) } },
    }))
    const row = (id: string) => nodes(root).find((node) => node.properties["data-session"] === id)
    return {
      dispose,
      setListed,
      setWaiting: (waitingSessions: WaitingSessionsView["sessions"]) => setWaiting({ sessions: waitingSessions }),
      setUnread: (view: UnreadChatsView) => setUnread({ stopped: view.stopped.map((chat) => ({ ...chat })), unread: [...view.unread], turns: { ...view.turns } }),
      marked,
      row,
      rowOrder: () => nodes(root).flatMap((node) => typeof node.properties["data-session"] === "string" ? [node.properties["data-session"]] : []),
      headings: () => nodes(root).filter((node) => node.properties.class === "session-group-label").map(textContent),
      rowText: (id: string) => { const found = row(id); return found === undefined ? "" : textContent(found) },
      badges: (id: string) => { const found = row(id); return found === undefined ? [] : nodes(found).filter((node) => String(node.properties.class).startsWith("session-badge")) },
      action: (id: string, label: string) => { const found = row(id); return found === undefined ? undefined : nodes(found).find((node) => node.tag === "button" && node.properties.title === label) },
    }
  })
}

export function mountStatusBudget(nullableDetailBudget = false, source: "durable" | "live" = "durable") {
  return createRoot((dispose) => {
    const [current, setCurrent] = createSignal(state())
    const reconnects: number[] = []
    const detailRow = { id: "session-a", kind: "chat", title: "Session A", lifecycleState: "inactive", notices: [], inputMode: { kind: "chat" }, lastUpdated: "2026-09-18T12:00:00.000Z", executionCwd: "/tmp/project", totalsLoading: true } as const
    const query: FakeConnectionScript = {
      queries: {
        sessionDetail: () => {
          const detail = { id: detailRow.id, kind: detailRow.kind, row: detailRow, conversationId: "conversation-a", status: statusView() }
          const budget = { totalsLoading: true } as const
          // A live view always carries its budget; only a durable one may lack it.
          return { view: source === "live" ? { ...detail, source, streamingToolText: {}, budget } : { ...detail, source, budget: nullableDetailBudget ? null : budget } }
        },
        roleSnapshot: () => ({
          views: [{ sessionId: detailRow.id, view: { assignments: { chat: { model: "chat-model", effort: "high" } }, serving: { slot: { kind: "role", roleId: "chat" }, selection: { model: "chat-model", effort: "high" } } } }],
          snapshotPosition: 0,
        }),
      },
    }
    const root = createElement("root")
    insert(root, createComponent(ClientContext.Provider, {
      value: client(current, query, () => { reconnects.push(1) }),
      get children() { return createComponent(StatusSheet, {}) },
    }))
    return {
      dispose,
      setReady() { setCurrent(state(READY_BUDGET)) },
      setBudget(budget: BudgetSummary) { setCurrent(state(budget)) },
      setBusy(busy: boolean) { setCurrent((value) => ({ ...value, busy })) },
      setHealth(health: RuntimeHealth) { setCurrent(state(LOADING_BUDGET, health)) },
      runtimeRow: () => rowLabelled(root, "Runtime"),
      runtimeText: () => {
        const row = rowLabelled(root, "Runtime")
        return row === undefined ? "" : textContent(row)
      },
      /** The tone class the Runtime row's label carries. */
      runtimeTone: () => {
        const label = nodes(rowLabelled(root, "Runtime") ?? root).find((node) => typeof node.properties.class === "string" && node.properties.class.split(" ").includes("sheet-row-label"))
        const classes = label?.properties.classList
        const tone = typeof classes === "object" && classes !== null ? Object.entries(classes).find(([name, on]) => on === true && name.startsWith("tone-"))?.[0] : undefined
        return tone?.slice("tone-".length)
      },
      reconnects: () => reconnects.length,
      rolesText: () => {
        const row = rowLabelled(root, "Roles")
        return row === undefined ? "" : textContent(row)
      },
      settle: async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve() },
      text: () => textContent(root),
      sessionDetail: () => withClass(rowNamed(root, "Session") ?? root, "sheet-row-detail"),
      spendValue: () => withClass(rowNamed(root, "Spend") ?? root, "sheet-row-value"),
      sessionDetailText: () => {
        const detail = withClass(rowNamed(root, "Session") ?? root, "sheet-row-detail")
        return detail === undefined ? "" : textContent(detail)
      },
      spendValueText: () => {
        const value = withClass(rowNamed(root, "Spend") ?? root, "sheet-row-value")
        return value === undefined ? "" : textContent(value)
      },
      stableControl: () => nodes(root).find((node) => node.tag === "button" && node.properties["aria-label"] === "Close"),
    }
  })
}

type ConnectionState = RuntimeConnection["state"]

/** The Status sheet over a runtime whose restart readiness is `initial`,
 *  which an error makes unreadable, and then what the case sets with
 *  `setReadiness`, and whose
 *  answer to a restart the case releases with `answer`. The case confirms or
 *  declines the one confirmation through `confirmations`, and moves the
 *  connection through `setConnection`, as a restart drops it and the
 *  successor takes it again. */
export function mountStatusRestart(initial: RuntimeRestartReadiness | Error) {
  return createRoot((dispose) => {
    const [current, setCurrent] = createSignal(state(READY_BUDGET))
    const confirmations: { readonly title: string; readonly detail?: string; readonly confirmLabel: string }[] = []
    let confirm = true
    let readiness: RuntimeRestartReadiness | Error = initial
    let answer = Promise.withResolvers<MutationResult>()
    let restarts = 0
    const stateListeners = new Set<(state: ConnectionState) => void>()
    const connection = fakeRuntimeConnection({
      queries: { restartReadiness: () => { if (readiness instanceof Error) throw readiness; return readiness } },
      mutations: { "service.restart": () => { restarts += 1; return answer.promise } },
    }, {
      onStateChange(listener) {
        stateListeners.add(listener)
        return () => { stateListeners.delete(listener) }
      },
    })
    const root = createElement("root")
    insert(root, createComponent(ClientContext.Provider, {
      value: fakeClient({
        connection,
        actions: fakeClientActions({}, fakeRuntimeSession(), connection),
        state: current,
        confirm: async (request) => { confirmations.push(request); return confirm },
        prompt: async () => undefined,
      }),
      get children() { return createComponent(StatusSheet, {}) },
    }))
    const row = () => rowLabelled(root, "Restart")
    const updatesRow = () => rowLabelled(root, "Updates")
    const control = (node: ReturnType<typeof createElement>) => node.tag === "button" || node.properties.role === "button"
    return {
      dispose,
      row,
      updatesRow,
      /** Every control that holds another control, which a screen reader
       *  announces as one control named by both. */
      nestedControls: () => nodes(root).filter((node) => control(node) && nodes(node).slice(1).some(control)),
      status: () => {
        const status = withClass(row() ?? root, "sheet-row-restart")
        return status === undefined ? "" : textContent(status)
      },
      statusNode: () => withClass(row() ?? root, "sheet-row-restart"),
      valueNode: () => withClass(updatesRow() ?? root, "sheet-row-value"),
      autoUpdateNode: () => withClass(updatesRow() ?? root, "sheet-row-auto-update"),
      text: (node: ReturnType<typeof createElement>) => textContent(node),
      setUpdate(update: UpdateStatusView) { setCurrent((previous) => ({ ...previous, update })) },
      tap() {
        const click = row()?.properties.onClick
        if (typeof click !== "function") throw new Error("The Restart row has no tap")
        click({})
      },
      decline() { confirm = false },
      setReadiness(next: RuntimeRestartReadiness) { readiness = next },
      confirmations,
      restarts: () => restarts,
      answer(result: MutationResult) {
        answer.resolve(result)
        answer = Promise.withResolvers<MutationResult>()
      },
      setConnection(next: ConnectionState) { for (const listener of stateListeners) listener(next) },
      settle: async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve() },
    }
  })
}
