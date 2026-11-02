import { mock, spyOn } from "bun:test"
import { createSignal } from "solid-js"
import type { SessionCatalogError, SessionCatalogRow } from "../../../../src/protocol/app-service-types.js"
import type { FrontendWorkflowView } from "../../../../src/protocol/workflow-view-protocol-types.js"
import { createShellState, type ShellSignals } from "../../../../src/tui/hooks/shell-state.js"
import { createModalStack } from "../../../../src/tui/components/modal-stack.js"
import type { SessionActivationResult } from "../../../../src/tui/hooks/session-activation.js"
import { useSessionModal } from "../../../../src/tui/hooks/use-session-modal.js"
import { fakeLanes } from "../../../helpers/fake-lanes.js"
import { runtimeDispatch } from "../../../helpers/runtime-dispatch.js"

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

function createAppService(dispatch?: (command: { type: string; sessionId?: string }) => Promise<{ ok: true } | { ok: false; error: string }>) {
  const accept = async () => ({ ok: true as const })
  const answer = dispatch ?? accept
  const appService = { dispatch: runtimeDispatch({
    "workflow.interrupt": async () => ({ kind: "interrupt", interrupted: true }),
    "workflow.resume": accept, "chat.resume": accept, "chat.interrupt": accept,
    "session.delete": answer, "session.rename": answer, "session.close": answer,
  }) }
  spyOn(appService, "dispatch")
  return appService
}

export function createModal(options: {
  sessions: readonly SessionCatalogRow[]
  errors?: readonly SessionCatalogError[]
  queueViews?: QueueViews
  foregroundId?: string
  now?: () => number
  activateSession?: (session: SessionCatalogRow) => Promise<SessionActivationResult>
  deleteActiveSession?: (sessionId: string) => Promise<void>
  dispatch?: (command: { type: string; sessionId?: string }) => Promise<{ ok: true } | { ok: false; error: string }>
  showToast?: (opts: { message: string; variant: "info" | "warning" | "error" | "success"; duration?: number }) => void
}) {
  const modals = createModalStack()
  const appService = createAppService(options.dispatch)
  const activateSession = options.activateSession ?? mock(async () => ({ ok: true as const }))
  const activateSessionById = mock(async (_id: string) => {})
  const signals = createSignals(options.queueViews, options.foregroundId)
  if (options.now) signals.now = options.now
  const hook = useSessionModal({
    modal: modals,
    renderModal: () => "mock-element",
    signals,
    appService,
    showToast: options.showToast ?? mock(() => {}),
    seedSessionCatalogRow: () => {},
    sessions: () => options.sessions,
    sessionCatalogErrors: () => options.errors ?? [],
    activateSession,
    activateSessionById,
    deleteActiveSession: options.deleteActiveSession ?? mock(async () => {}),
    clipboard: { copy: mockClipboardCopy, readImage: async () => null },
  }, 0)
  return { hook, modals, appService, activateSession, activateSessionById }
}

export function rowLabels(hook: ReturnType<typeof useSessionModal>): string[] {
  return hook.sessionModalResult().rows.map((row) => {
    if (row.kind === "header") return row.label
    if (row.kind === "corrupt") return `corrupt:${row.sessionId}`
    return row.session.id
  })
}
