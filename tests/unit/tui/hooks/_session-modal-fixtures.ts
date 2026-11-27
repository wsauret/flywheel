import { mock, spyOn } from "bun:test"
import { createSignal } from "solid-js"
import { selectNeedsYou } from "../../../../src/protocol/client/session/needs-you.js"
import type { UnreadChatsView } from "../../../../src/protocol/session/unread-protocol-types.js"
import { chatMarks } from "../../../../src/tui/components/notices/chat-marks.js"
import type { RuntimeClient, SessionCatalogError, SessionCatalogRow } from "../../../../src/protocol/runtime/app-service-types.js"
import type { FrontendWorkflowView } from "../../../../src/protocol/session/workflow-view-protocol-types.js"
import { createShellState, type ShellSignals } from "../../../../src/tui/hooks/state/shell-state.js"
import { createModalStack } from "../../../../src/tui/components/modal-stack.js"
import type { SessionActivationResult } from "../../../../src/tui/hooks/foreground/session-activation.js"
import { useSessionModal } from "../../../../src/tui/hooks/overlays/modals/session/use-session-modal.js"
import { fakeLanes } from "../../../helpers/fake-lanes.js"
import { runtimeDispatch, runtimeQuery, type QueryAnswer } from "../../../helpers/runtime-dispatch.js"

export const mockClipboardCopy = mock(async (_text: string) => {})

type LoadingCatalogRow = Extract<SessionCatalogRow, { readonly totalsLoading: true }>

export function session(overrides: Partial<Omit<LoadingCatalogRow, "totalsLoading">> & { id: string }): SessionCatalogRow {
  return {
    kind: "chat",
    title: overrides.id,
    executionCwd: "/scratch/flywheel-test",
    lifecycleState: "inactive",
    notices: [],
    inputMode: { kind: "chat" },
    lastUpdated: "2026-05-22T00:00:00.000Z",
    totalsLoading: true,
    ...overrides,
  }
}

interface QueueViews {
  [sessionId: string]: FrontendWorkflowView | undefined
}

export function createSignals(
  _queueViews: QueueViews = {},
  foregroundIdValue?: string,
): ShellSignals {
  const [foregroundId, setForegroundId] = createSignal<string | undefined>(foregroundIdValue)
  const { signals } = createShellState({
    appService: {
      query: async () => { throw new Error("unexpected shell query") },
      dispatch: async () => { throw new Error("unexpected shell mutation") },
      subscribe: () => () => {},
      ...fakeLanes().client,
    },
    runtimeConfig: { view: () => undefined, settlePublication: async () => false },
    now: () => Date.parse("2026-05-22T00:10:00.000Z"),
    projectRoot: "/scratch/flywheel-test",
    setTerminalTitle: () => {},
    showToast: () => {},
  })
  return {
    ...signals,
    foregroundId,
    setForegroundId,
  }
}

function createAppService(dispatch?: (command: { type: string; sessionId?: string }) => Promise<{ ok: true } | { ok: false; error: string }>, chatSearch?: QueryAnswer<"chatSearch">) {
  const accept = async () => ({ ok: true as const })
  const answer = dispatch ?? accept
  const answerQuery = runtimeQuery({ chatSearch: chatSearch ?? (async () => ({ chats: [] })) })
  // The abort signal of each query, in order, so a test can see which searches were cancelled.
  const querySignals: (AbortSignal | undefined)[] = []
  const query: RuntimeClient["query"] = (request, options) => {
    querySignals.push(options?.signal)
    return answerQuery(request)
  }
  const appService = { dispatch: runtimeDispatch({
    "workflow.interrupt": async () => ({ kind: "interrupt", interrupted: true }),
    "workflow.resume": accept, "chat.resume": accept, "chat.interrupt": accept,
    "session.delete": answer, "session.rename": answer, "session.close": answer,
    "chat.mark_read": answer, "chat.mark_unread": answer,
  }), query }
  spyOn(appService, "dispatch")
  return { appService, querySignals }
}

export function createModal(options: {
  sessions: readonly SessionCatalogRow[]
  errors?: readonly SessionCatalogError[]
  queueViews?: QueueViews
  foregroundId?: string
  now?: () => number
  /** The project's sessions that wait on a question, oldest question first. */
  waitingSessions?: readonly string[]
  /** The project's stopped unread chats and chats with unread messages. */
  unreadChats?: () => UnreadChatsView | undefined
  activateSession?: (session: SessionCatalogRow) => Promise<SessionActivationResult>
  deleteActiveSession?: (sessionId: string) => Promise<void>
  closeChat?: (sessionId: string) => Promise<void>
  dispatch?: (command: { type: string; sessionId?: string }) => Promise<{ ok: true } | { ok: false; error: string }>
  showToast?: (opts: { message: string; variant: "info" | "warning" | "error" | "success"; duration?: number }) => void
  /** The runtime's answer to a search of chat messages; none found when absent. */
  chatSearch?: QueryAnswer<"chatSearch">
}) {
  const modals = createModalStack()
  const { appService, querySignals } = createAppService(options.dispatch, options.chatSearch)
  const landOnEntry = mock((_entryId: string) => {})
  const activateSession = options.activateSession ?? mock(async () => ({ ok: true as const }))
  const activateSessionById = mock(async (_id: string) => {})
  const closeChat = mock(options.closeChat ?? (async (_id: string) => {}))
  const signals = createSignals(options.queueViews, options.foregroundId)
  if (options.now) signals.now = options.now
  const waiting = { sessions: (options.waitingSessions ?? []).map((sessionId, index) => ({ sessionId, openedAt: index })) }
  // Every chat that the sets name is listed here, so the fixture never reads
  // the catalog that the tests count reads of.
  const needsYou = () => {
    const unread = options.unreadChats?.()
    const listed = [...waiting.sessions, ...(unread?.stopped ?? [])].map((chat) => ({ id: chat.sessionId })).concat((unread?.unread ?? []).map((id) => ({ id })))
    return selectNeedsYou({ waiting, unread, listed })
  }
  signals.needsYou = needsYou
  signals.chatMark = (sessionId) => chatMarks(needsYou()).get(sessionId)
  const hook = useSessionModal({
    modal: modals,
    renderModal: () => "mock-element",
    signals,
    appService,
    showToast: options.showToast ?? mock(() => {}),
    sessions: () => options.sessions,
    sessionCatalogErrors: () => options.errors ?? [],
    activateSession,
    activateSessionById,
    landOnEntry,
    closeChat,
    deleteActiveSession: options.deleteActiveSession ?? mock(async () => {}),
    clipboard: { copy: mockClipboardCopy, readImage: async () => null },
  }, 0)
  return { hook, modals, appService, querySignals, activateSession, activateSessionById, landOnEntry, closeChat }
}

/** Press ctrl with a letter, as a terminal reports it. */
export function pressCtrl(modals: { input(evt: { name: string; ctrl?: boolean; sequence?: string }): boolean }, letter: string): void {
  modals.input({ name: letter, ctrl: true, sequence: String.fromCharCode(letter.charCodeAt(0) - 96) })
}

export function rowLabels(hook: ReturnType<typeof useSessionModal>): string[] {
  return hook.sessionModalResult().rows.map((row) => {
    if (row.kind === "header") return row.label
    if (row.kind === "corrupt") return `corrupt:${row.sessionId}`
    if (row.kind === "found") return `found:${row.session.id}`
    return row.session.id
  })
}
