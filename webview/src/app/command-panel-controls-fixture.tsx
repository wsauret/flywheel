import { createComponent, createRoot } from "solid-js"

import type { ChildSessionRow, SessionCatalogRow, SessionRow } from "../../../src/protocol/app-service-types.js"
import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import type { StatusView } from "../../../src/protocol/status-protocol-types.js"
import { detailView, statusView } from "../../../tests/helpers/runtime-views.js"
import { fakeClient, fakeClientHost, fakePanelSettings } from "./client-context-fixture.js"
import { fakeRuntimeConnection } from "../client/runtime-connection-fixture.js"
import { authView } from "../client/session-connection-fixture.js"
import type { BuiltInCommandDescriptor } from "../../../src/protocol/command-catalog-protocol-types.js"
import { createClientActions } from "../client/actions.js"
import { createRuntimeSession } from "../client/session.js"
import { createViewProjection } from "../client/view-state.js"
import { ClientContext, type PromptRequest } from "./client-context.js"
import type { InlineSettingAction } from "../client/settings-actions.js"
import { createCommandPanel } from "./command-panel.js"
import { createElement, insert, nodes, textContent } from "./render-ownership-host-fixture.js"

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
}

const STAMP = "2026-09-22T12:00:00.000Z"

type ChildStatus = Pick<StatusView, "activity" | "waitingOnBackgroundWork" | "replyWaits">

/** What kind of child the panel's session shows. */
type ChildKind = ChildSessionRow["kind"]


/** A runtime with one chat and one running child of it. The child is never
 *  a catalog row (ARCH-PROTOCOL-048), so the client reads it through
 *  `sessionDetailSnapshot`, as it does in production. */
function childConnection(dispatched: unknown[], childStatus: ChildStatus, kind: ChildKind): RuntimeConnection {
  // A runtime status always lists the live work of its session.
  const status: StatusView = { ...statusView(childStatus.activity), ...childStatus }
  const chat: SessionCatalogRow = { id: "parent-chat", kind: "chat", title: "Parent", lifecycleState: "active", activity: "generating", inputMode: { kind: "chat" }, createdAt: STAMP, lastUpdated: STAMP, notices: [], executionCwd: "/workspace", totalsLoading: true }
  const shared = {
    id: "child", title: "Explorer", lifecycleState: "active", activity: "generating", inputMode: { kind: "message" },
    parentSessionId: "parent-chat", parentToolUseId: "tu-explorer", createdAt: STAMP, lastUpdated: STAMP, notices: [], executionCwd: "/workspace", totalsLoading: true,
  } as const
  const child: ChildSessionRow = kind === "subagent"
    ? { ...shared, kind, admittedActions: ["session.send", "subagent.interrupt", "background.terminate", "session.delete"] }
    : { ...shared, kind, workflowMembership: { kind: "attempt", workflowId: "workflow-1", attemptId: "attempt-1" }, admittedActions: ["session.send", "chat.interrupt", "session.delete"] }
  const rows: readonly SessionRow[] = [chat, child]
  return fakeRuntimeConnection({
    queries: {
      snapshot: () => ({ rows: [chat], activeRuntimeCount: 1, errors: [], snapshotPosition: 0, projectRoot: "/workspace", runtimeVersion: "test", runtimeBuildId: null, chatDefault: { kind: "none" }, executor: { kind: "serving" }, service: { kind: "serving" } }),
      sessionDetailSnapshot: (request) => ({ snapshotPosition: 0, views: request.sessionIds.map((sessionId) => {
        const row = rows.find((candidate) => candidate.id === sessionId)
        return { sessionId, view: row === undefined ? null : { ...detailView(row), status } }
      }) }),
      // The child is running or waiting on its own background work:
      // Interrupt is offered only while it has something to interrupt.
      statusSnapshot: (request) => ({ snapshotPosition: 0, views: request.sessionIds.map((sessionId) => ({ sessionId, view: status })) }),
    },
    onDispatch: (mutation) => { dispatched.push(mutation) },
    mutations: { "background.terminate": () => ({ ok: true }), "subagent.interrupt": () => ({ ok: true }), "session.delete": () => ({ ok: true }), "session.close": () => ({ ok: true }) },
  }, { reconnect() {} })
}

/** Mounts the real command panel over the real session and client actions,
 *  with a running child open (a subagent unless `kind` says otherwise), or
 *  its parent chat when `chat` is set, and records every mutation the panel's
 *  rows dispatch, every sheet it opens, and every notice it reports. The
 *  panel's command rows record their invocation in `invoked`, and
 *  `openSurface` opens the surface such a command names.
 *  `builtInCommands` the runtime's published commands, which the footer
 *  counts, `settings` whether the settings were read, `background` how many
 *  background commands run, `keyboardShortcuts` whether the host takes
 *  chords, and `query` the text typed after the slash. */
export async function mountChildCommandPanel(options: {
  readonly status?: ChildStatus
  readonly builtInCommands?: readonly BuiltInCommandDescriptor[]
  readonly kind?: ChildKind
  readonly query?: string
  readonly settings?: boolean
  readonly background?: number
  readonly keyboardShortcuts?: boolean
  readonly chat?: boolean
} = {}) {
  const { status = { activity: "generating", waitingOnBackgroundWork: false, replyWaits: [] }, kind = "subagent", query = "" } = options
  const dispatched: unknown[] = []
  const connection = childConnection(dispatched, status, kind)
  const session = createRuntimeSession({ connection })
  await settle()
  await session.select(options.chat ? "parent-chat" : "child")
  await settle()
  const reports: string[] = []
  const actions = createClientActions({ session, connection, capabilities: {}, report: (_severity, message) => { reports.push(message) }, captureSurfaceOpener: () => () => {} })
  const project = createViewProjection()
  const sheets: string[] = []
  const settingWrites: InlineSettingAction[] = []
  const prompts: PromptRequest[] = []
  const invoked: string[] = []
  const base = fakePanelSettings()
  const settings = fakePanelSettings({ seatEfforts: [
    { effort: "low", label: "Low", current: true, selectable: true },
    { effort: "medium", label: "Medium", current: false, selectable: true },
    { effort: "high", label: "High", current: false, selectable: true },
  ], capabilities: { ...base.capabilities, modules: [
    { id: "subagents", installed: true, effective: true, dependencies: [], setting: { control: "binary", label: "Subagents", description: "Delegate work" } },
  ] } })
  const client = fakeClient({
    connection,
    actions: { ...actions, applySetting: async (action) => { settingWrites.push(action); return { kind: "applied" } }, invokeCommand: (name) => { invoked.push(name) } },
    state: () => {
      const view = project(session)
      return {
        ...view,
        ...(options.builtInCommands === undefined ? {} : { builtInCommands: options.builtInCommands }),
        ...(options.settings ? {
          settings,
          authStatus: { snapshotPosition: 1, auth: { ...authView([]), profile: { id: "personal", displayName: "Personal", source: "default", availableProfiles: [] } } },
          update: { revision: 1, autoInstall: { persisted: true, forcedOff: false, effective: true }, status: { kind: "installed", version: "1.0.0" } },
        } : {}),
        ...(options.background === undefined ? {} : {
          processStatus: {
            activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [], ...view.processStatus,
            activeBackgroundCommands: Array.from({ length: options.background }, (_, index) => ({ id: `bg-${index}`, description: "sleep", toolUseId: `bg-${index}`, startedAtMs: 0 })),
          },
        }),
      }
    },
    // The clipboard lets the panel offer Copy session ID.
    host: fakeClientHost({ capabilities: { writeClipboardText: async () => {}, ...(options.keyboardShortcuts ? { keyboardShortcuts: true } : {}) } }),
    openSheet: (sheet) => { sheets.push(sheet) },
    report: (_severity, message) => { reports.push(message) },
    confirm: async () => false,
    prompt: async (request) => { prompts.push(request); return undefined },
  })
  return createRoot((dispose) => {
    const root = createElement("root")
    const panel = createCommandPanel({ client, query: () => query, close() {} })
    insert(root, createComponent(ClientContext.Provider, { value: client, get children() { return panel.view() } }))
    const rows = () => nodes(root).filter((node) => node.properties.class === "panel-row")
    const labelOf = (row: ReturnType<typeof rows>[number]) => {
      const label = nodes(row).find((node) => node.properties.class === "panel-label")
      return label === undefined ? "" : textContent(label).trim()
    }
    return {
      dispatched,
      reports,
      sheets,
      settingWrites,
      prompts,
      invoked,
      /** Opens the surface `id` as the command that names it does. */
      async openSurface(id: string) {
        client.surface(id)?.open()
        await settle()
      },
      labels: () => rows().map(labelOf),
      /** The list as it reads top to bottom: each section heading, then the
       *  name of each row under it, setting rows by their own label. */
      outline() {
        const sections: { section: string; rows: string[] }[] = []
        for (const node of nodes(root)) {
          const className = node.properties.class
          if (className === "panel-section") sections.push({ section: textContent(node).trim(), rows: [] })
          else if (className === "panel-row") sections.at(-1)?.rows.push(labelOf(node))
        }
        return sections
      },
      /** The value the row named `label` shows on its right, and whether its switch is on. */
      control(label: string) {
        const row = rows().find((candidate) => labelOf(candidate) === label)
        if (row === undefined) throw new Error(`No ${label} row`)
        const value = nodes(row).find((node) => node.properties.class === "panel-value")
        // This host records a `classList` binding as the object Solid passes.
        const classList = nodes(row).find((node) => node.properties.class === "panel-toggle")?.properties.classList
        return { value: value === undefined ? undefined : textContent(value).trim(), on: classList === undefined ? undefined : typeof classList === "object" && classList !== null && "on" in classList && classList.on === true }
      },
      /** Points at the row named `label`, then presses `key` as the composer
       *  hands keys to the panel. True when the panel took the key. */
      async key(label: string, key: string) {
        const enter = rows().find((row) => labelOf(row) === label)?.properties.onMouseEnter
        if (typeof enter !== "function") throw new Error(`No ${label} row`)
        enter({})
        const taken = panel.onKeyDown({ key, preventDefault() {} })
        await settle()
        return taken
      },
      /** The hover description of the row named `label`. */
      description: (label: string) => rows().find((row) => labelOf(row) === label)?.properties.title,
      /** The catalog footer's role and words, and a tap on it. */
      footer() {
        const node = nodes(root).find((candidate) => candidate.properties.class === "panel-footer")
        if (node === undefined) return undefined
        return {
          role: node.properties.role,
          text: textContent(node).trim(),
          tap() {
            const handler = node.properties.onClick
            if (typeof handler !== "function") throw new Error("The footer takes no tap")
            handler({ preventDefault() {} })
          },
        }
      },
      async pick(label: string) {
        const handler = rows().find((row) => labelOf(row) === label)?.properties.onClick
        if (typeof handler !== "function") throw new Error(`No ${label} row`)
        handler({ preventDefault() {} })
        await settle()
      },
      press(label: string, eventName: "onPointerDown" | "onMouseDown") {
        const handler = rows().find((row) => labelOf(row) === label)?.properties[eventName]
        if (typeof handler !== "function") throw new Error(`No ${eventName} for ${label}`)
        let prevented = false
        handler({ preventDefault() { prevented = true } })
        return prevented
      },
      dispose() {
        dispose()
        session.dispose()
      },
    }
  })
}

/** A published catalog in the runtime's shape, with each menu group's
 *  positions out of order so a panel must sort them. */
export const PUBLISHED_COMMANDS: readonly BuiltInCommandDescriptor[] = [
  { id: "fork", title: "Fork conversation", description: "Fork", aliases: [] },
  { id: "shortcuts", title: "Keyboard shortcuts", description: "Chords", aliases: [], opens: "keyboard-shortcuts", menu: { group: "top", rank: 900 } },
  { id: "new", title: "New chat", description: "Start a chat", aliases: [], opens: "new-chat", menu: { group: "chat", rank: 100 } },
  { id: "usage", title: "Usage", description: "Usage", aliases: [], opens: "usage", menu: { group: "top", rank: 100 } },
  { id: "bg", title: "Background work", description: "Background", aliases: [], opens: "background", menu: { group: "top", rank: 500 } },
  { id: "help", title: "Commands", description: "Every command", aliases: [], opens: "commands", menu: { group: "more", rank: 10 } },
  { id: "auth", title: "Authentication", description: "Sign in", aliases: ["login"], opens: "settings", target: { kind: "place", place: "authentication" }, menu: { group: "top", rank: 300 } },
  { id: "compact", title: "Compact conversation", description: "Compact", aliases: [], menu: { group: "chat", rank: 200 } },
]
