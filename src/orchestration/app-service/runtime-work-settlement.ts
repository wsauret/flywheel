import { isActiveActivity, type FrontendEvent, type FrontendMutation, type MutationResult, type RuntimeClient } from "../../protocol/app-service-types.js"
import type { HeadlessChatOutcome } from "../../protocol/headless-chat.js"
import { isWorkingStatus, type StatusView } from "../../protocol/status-protocol-types.js"
import { createOrderedLane } from "../../infra/ordered-lane.js"
import { durableBranchHasUserMessage } from "../session/conversation/conversation-tree-handle.js"
import type { RuntimeChatKernel } from "./runtime-chat-kernel.js"
import type { RuntimeSupervisor } from "./runtime-supervisor-types.js"
import type { WorkflowHosts } from "../workflow-host/host-collection.js"
import type { AsyncEventStateReadSurface } from "../../infra/event-store-types.js"
import { liveWorkflowControl, onLiveWorkChanged } from "../session/live-session-control.js"

/** Includes preflight, acknowledgement, and draining without inventing session rows. */
export function workflowSettlementOwners(hosts: WorkflowHosts, reader: AsyncEventStateReadSurface): Pick<SettlementDeps, "busyWorkflows" | "onWorkflowChange"> {
  return {
    busyWorkflows: async () => (await Promise.all(hosts.allIds().map(async (id) =>
      await liveWorkflowControl(reader, id)?.state() === "interrupted" ? undefined : id))).filter((id): id is string => id !== undefined),
    onWorkflowChange: (listener) => {
      const offHosts = hosts.onChange(listener)
      const offControls = onLiveWorkChanged(reader, listener)
      return () => { offHosts(); offControls() }
    },
  }
}

/** Own the actual accepted tails and join startup work that can enqueue more tails. */
export function createSessionWorkSettlement<Startup>(startup: () => Promise<Startup> | undefined) {
  const mailbox = createOrderedLane()
  const acceptedWork = new Set<Promise<unknown>>()
  function ownAcceptedWork<A>(work: Promise<A>): Promise<A> {
    acceptedWork.add(work)
    void work.then(() => acceptedWork.delete(work), () => acceptedWork.delete(work))
    return work
  }
  async function waitForStartup(): Promise<void> {
    const work = startup()
    if (work) await Promise.allSettled([work])
  }
  const hasAcceptedWork = () => acceptedWork.size > 0 || startup() !== undefined
  async function awaitAcceptedWork(): Promise<void> {
    for (;;) {
      await mailbox.settled()
      await Promise.allSettled(acceptedWork)
      await waitForStartup()
      await mailbox.settled()
      if (!hasAcceptedWork()) return
    }
  }
  return { mailbox, ownAcceptedWork, waitForStartup, hasAcceptedWork, awaitAcceptedWork }
}

/** Adopt history-free chat shells before dispatch and correlate accepted targets
 * with runtime settlement. The underlying mutation outcome remains unchanged.
 */
export function createSettledRuntimeDispatch(
  deps: Pick<RuntimeChatKernel, "manager" | "sessionStore" | "eventReader"> & {
    readonly client: RuntimeClient
    readonly supervisor: Pick<RuntimeSupervisor, "adoptBlankChat">
    readonly settlement: RuntimeWorkSettlement
  },
): RuntimeClient["dispatch"] {
  function dispatch<C extends FrontendMutation>(command: C): Promise<MutationResult<C>>
  async function dispatch(command: FrontendMutation): Promise<MutationResult<FrontendMutation>> {
    if (command.type === "session.activate" || command.type === "session.send") {
      const session = await deps.manager.read(command.sessionId)
      // An empty durable chat has no history from which activation can load a runner.
      if (session?.kind === "chat" && !deps.sessionStore.has(command.sessionId)
        && !await durableBranchHasUserMessage({ sessionId: command.sessionId, conversationId: session.conversationId, store: deps.eventReader })) {
        deps.supervisor.adoptBlankChat({
          sessionId: command.sessionId, conversationId: session.conversationId, description: session.label,
        })
      }
    }
    const result = await deps.client.dispatch(command)
    if (typeof result === "object" && result !== null
      && "ok" in result && result.ok) {
      deps.settlement.accepted([
        ...("sessionId" in result && typeof result.sessionId === "string" ? [result.sessionId] : []),
        ...("sessionId" in command && typeof command.sessionId === "string" ? [command.sessionId] : []),
      ])
    }
    return result
  }
  return dispatch
}

export interface RuntimeWorkSettlement {
  /** Retain the identities of successfully accepted dispatch targets. */
  accepted(sessionIds: readonly string[]): void
  /** Join admission tails, then read current owners. Never interrupts work. */
  read(rootSessionId: string): Promise<HeadlessChatOutcome | "busy">
  /** Ownership changes only. Content and accounting patches do not wake readers. */
  onChange(listener: () => void): () => void
}

interface SettlementDeps {
  readonly busyWorkflows: () => Promise<readonly string[]>
  readonly onWorkflowChange: (listener: () => void) => () => void
  readonly client: RuntimeClient
  readonly awaitAcceptedWork: () => Promise<void>
  readonly ownedSessionIds: () => readonly string[]
  readonly runningChildren: () => Promise<readonly string[]>
  readonly keptSessions: () => readonly string[]
  readonly pendingTurnSettlement: (sessionId: string) => Promise<void> | undefined
  readonly failed: (sessionId: string) => boolean
  readonly requiresContinuation: (sessionId: string, rootSessionId: string) => Promise<boolean>
  readonly onLiveSessionRemoved: (listener: (sessionId: string) => void) => () => void
}

/** Settlement belongs to the runtime, not a frontend's historical session views.
 * The remembered ids identify work reached by this runtime, not lifecycle state.
 */
export function createRuntimeWorkSettlement(deps: SettlementDeps): RuntimeWorkSettlement {
  const reached = new Set<string>()
  const observedTurns = new WeakSet<Promise<void>>()
  const listeners = new Set<() => void>()
  return {
    accepted(sessionIds) { for (const id of sessionIds) reached.add(id) },
    async read(rootSessionId) {
      await deps.awaitAcceptedWork()
      const children = await deps.runningChildren()
      const workflows = await deps.busyWorkflows()
      const kept = deps.keptSessions()
      for (const id of [rootSessionId, ...deps.ownedSessionIds(), ...children, ...kept]) reached.add(id)
      const sessionIds = [...reached]
      const pendingTurns = new Set<string>()
      for (const id of sessionIds) {
        const pending = deps.pendingTurnSettlement(id)
        if (!pending) continue
        pendingTurns.add(id)
        if (observedTurns.has(pending)) continue
        observedTurns.add(pending)
        void pending.then(() => { for (const listener of listeners) listener() })
      }
      const [statuses, questions] = await Promise.all([
        deps.client.query({ type: "statusSnapshot", sessionIds }),
        deps.client.query({ type: "questionSnapshot", sessionIds }),
      ])
      const questionIds = new Set(questions.views.filter((entry) => entry.view !== null).map((entry) => entry.sessionId))
      // A question parks the model, not sibling commands in the same session.
      if (kept.length > 0 || children.length > 0 || workflows.length > 0 || statuses.views.some(({ sessionId, view }) =>
        view !== null && (view.activeBackgroundCommands.length > 0
          || view.activeForegroundBashToolCallIds.length > 0
          || isActiveActivity(view.activity) || view.activeSubagentCount > 0
          || !questionIds.has(sessionId) && isWorkingStatus(view)))) return "busy"
      if ([...pendingTurns].some((id) => !questionIds.has(id))) return "busy"
      if (questionIds.size > 0) return "input_required"
      if (sessionIds.some(deps.failed)) return "failed"
      if ((await Promise.all(sessionIds.map((id) => deps.requiresContinuation(id, rootSessionId)))).some(Boolean)) return "incomplete"
      return "complete"
    },
    onChange(listener) {
      listeners.add(listener)
      // This is notification coalescing, not a status cache: read always takes
      // fresh owner snapshots. Token counts and output positions are excluded.
      const signatures = new Map<string, string>()
      const unsubscribe = deps.client.subscribe((event: FrontendEvent) => {
        if (event.type !== "patch") return
        const { cursor, payload } = event.patch
        if (payload.kind === "status.updated" && cursor.scope === "session") {
          reached.add(cursor.sessionId)
          const signature = workSignature(payload.status)
          if (signatures.get(cursor.sessionId) === signature) return
          signatures.set(cursor.sessionId, signature)
          listener()
        } else if (payload.kind === "status.removed" || payload.kind === "question.updated"
          || payload.kind === "question.removed" || payload.kind === "session.added"
          || payload.kind === "session.removed") listener()
      })
      const unsubscribeRemoved = deps.onLiveSessionRemoved((sessionId) => { reached.add(sessionId); listener() })
      const unsubscribeWorkflows = deps.onWorkflowChange(listener)
      return () => { listeners.delete(listener); unsubscribe(); unsubscribeRemoved(); unsubscribeWorkflows() }
    },
  }
}

function workSignature(status: StatusView): string {
  return JSON.stringify([status.activity, status.activeSubagentCount, status.waitingOnBackgroundWork,
    status.activeBackgroundCommands.map((command) => command.id), status.activeForegroundBashToolCallIds,
    status.replyWaits.map((wait) => wait.sessionId)])
}
