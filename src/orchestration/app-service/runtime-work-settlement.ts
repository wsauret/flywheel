import { isActiveActivity, type FrontendEvent, type FrontendMutation, type MutationResult, type RuntimeClient, type RuntimeQuery, type RuntimeQueryOptions, type RuntimeQueryResult } from "../../protocol/app-service-types.js"
import { settlementCursor, type ChatSettlementOutcome, type ChatSettlementResult, type ChatTurnEnding } from "../../protocol/chat-settlement-protocol-types.js"
import type { RuntimeUiBus } from "./runtime-ui-bus.js"
import type { StatusView } from "../../protocol/status-protocol-types.js"
import { createOrderedLane } from "../../infra/ordered-lane.js"
import { durableBranchHasUserMessage } from "../session/conversation/tree/conversation-tree-handle.js"
import type { RuntimeChatKernel } from "./runtime-chat-kernel.js"
import type { RuntimeSupervisor } from "./runtime-supervisor-types.js"
import type { WorkflowHosts } from "../workflow-host/host-collection.js"
import type { AsyncEventStateReadSurface } from "../../infra/event-store-types.js"
import { liveSessionControl, liveWorkflowControl, onLiveWorkChanged } from "../session/live-session-control.js"
import { workProgressesWithout } from "../session/reply-waits.js"
import type { BackgroundWorkTracking } from "../agent-runtime/background-work.js"
import type { WorkReference } from "../agent-runtime/background-work-progress.js"

/** Workflows include preflight, acknowledgement, and draining without inventing session rows. */
export function liveWorkSettlementOwners(hosts: WorkflowHosts, reader: AsyncEventStateReadSurface): Pick<SettlementDeps, "busyWorkflows" | "onWorkflowChange" | "progressesWithout" | "interrupted"> {
  return {
    progressesWithout: (work, held) => workProgressesWithout(reader, work, held),
    interrupted: async (sessionId) => await liveSessionControl(reader, sessionId)?.state() === "interrupted",
    busyWorkflows: async (members) => (await Promise.all(hosts.allIds().filter((id) => members.has(id)).map(async (id) =>
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

/** Adopt history-free chat shells before dispatch. The underlying mutation
 * outcome remains unchanged.
 */
export function createSettledRuntimeDispatch(
  deps: Pick<RuntimeChatKernel, "manager" | "sessionStore" | "eventReader"> & {
    readonly client: RuntimeClient
    readonly supervisor: Pick<RuntimeSupervisor, "adoptBlankChat">
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
    return await deps.client.dispatch(command)
  }
  return dispatch
}

export interface RuntimeWorkSettlement {
  /** Join the admission tails of the root's launch tree, then read the
   *  current owners of that tree. With scope `turn`, join and read only the
   *  root's own turn, which ignores the work that the turn launched. Never
   *  interrupts work. */
  read(rootSessionId: string, scope?: "turn"): Promise<ChatSettlementOutcome | "busy">
  /** Ownership changes only. Content and accounting patches do not wake readers. */
  onChange(listener: () => void): () => void
}

interface SettlementDeps {
  /** `rootSessionId` and every session it launched (`sessionSubtree`). The tree only grows. */
  readonly members: (rootSessionId: string) => Promise<readonly string[]>
  readonly busyWorkflows: (members: ReadonlySet<string>) => Promise<readonly string[]>
  readonly onWorkflowChange: (listener: () => void) => () => void
  /** Whether `work` can progress while every session in `held` stays where it is. */
  readonly progressesWithout: (work: readonly WorkReference[], held: ReadonlySet<string>) => Promise<boolean>
  /** Whether the live loop of `sessionId` parks interrupted, where only the
   *  person's message or Resume moves it. */
  readonly interrupted: (sessionId: string) => Promise<boolean>
  readonly client: RuntimeClient
  readonly awaitAcceptedWork: (sessionIds: readonly string[]) => Promise<void>
  readonly runningChildren: (sessionIds: readonly string[]) => Promise<readonly string[]>
  readonly keptSessions: () => readonly string[]
  readonly pendingTurnSettlement: (sessionId: string) => Promise<void> | undefined
  /** The background-work registry of a session's runner, which its agent loop also reads. */
  readonly backgroundWork: (sessionId: string) => Pick<BackgroundWorkTracking, "awaitedTaskCount" | "pendingDeliveryCount" | "liveWorkReferences"> | undefined
  readonly failed: (sessionId: string) => boolean
  readonly requiresContinuation: (sessionId: string, rootSessionId: string) => Promise<boolean>
  readonly onLiveSessionRemoved: (listener: (sessionId: string) => void) => () => void
}

/** Settlement belongs to the runtime, not a frontend's historical session
 * views. It reads only the root's launch tree: its subagents, its workflows
 * and their agents, never other chats of the project (PI-AGENT-074). A reply
 * wait on another chat holds the root through the root's own tracked work.
 */
export function createRuntimeWorkSettlement(deps: SettlementDeps): RuntimeWorkSettlement {
  const observedTurns = new WeakSet<Promise<void>>()
  const listeners = new Set<() => void>()
  /** The tree once its admission tails are joined. A joined tail can launch a
   *  child, which joins the tree, so the join repeats until the tree holds. */
  async function settledMembers(rootSessionId: string): Promise<readonly string[]> {
    for (;;) {
      const members = await deps.members(rootSessionId)
      await deps.awaitAcceptedWork(members)
      const after = await deps.members(rootSessionId)
      if (after.length === members.length) return after
    }
  }
  /** Whether the turn of `sessionId` still records its end. Its end wakes
   *  every reader once. */
  function turnPending(sessionId: string): boolean {
    const pending = deps.pendingTurnSettlement(sessionId)
    if (!pending) return false
    if (!observedTurns.has(pending)) {
      observedTurns.add(pending)
      void pending.then(() => { for (const listener of listeners) listener() })
    }
    return true
  }
  async function outcome(sessionIds: readonly string[], asked: boolean, rootSessionId: string): Promise<ChatSettlementOutcome> {
    if (asked) return "input_required"
    if (sessionIds.some(deps.failed)) return "failed"
    if ((await Promise.all(sessionIds.map((id) => deps.requiresContinuation(id, rootSessionId)))).some(Boolean)) return "incomplete"
    return "complete"
  }
  /** The root's own turn has stopped once its loop runs no model request,
   *  tool, or foreground command and its end is recorded. Its subagents,
   *  workflows, and background commands are not the turn. */
  async function readTurn(rootSessionId: string): Promise<ChatSettlementOutcome | "busy"> {
    await deps.awaitAcceptedWork([rootSessionId])
    const [statuses, questions] = await Promise.all([
      deps.client.query({ type: "statusSnapshot", sessionIds: [rootSessionId] }),
      deps.client.query({ type: "questionSnapshot", sessionIds: [rootSessionId] }),
    ])
    const view = statuses.views[0]?.view
    const asked = questions.views.some((entry) => entry.view !== null)
    if (view && (view.activeForegroundBashToolCallIds.length > 0 || isActiveActivity(view.activity))) return "busy"
    if (turnPending(rootSessionId) && !asked) return "busy"
    return await outcome([rootSessionId], asked, rootSessionId)
  }
  return {
    async read(rootSessionId, scope) {
      if (scope === "turn") return await readTurn(rootSessionId)
      const sessionIds = await settledMembers(rootSessionId)
      const memberSet = new Set(sessionIds)
      const children = await deps.runningChildren(sessionIds)
      const workflows = await deps.busyWorkflows(memberSet)
      const kept = deps.keptSessions().filter((id) => memberSet.has(id))
      const pendingTurns = sessionIds.filter(turnPending)
      const [statuses, questions, interrupted] = await Promise.all([
        deps.client.query({ type: "statusSnapshot", sessionIds }),
        deps.client.query({ type: "questionSnapshot", sessionIds }),
        Promise.all(sessionIds.map(async (id) => await deps.interrupted(id) ? [id] : [])),
      ])
      const questionIds = new Set(questions.views.filter((entry) => entry.view !== null).map((entry) => entry.sessionId))
      // Only a person moves a session that waits on a question or that a turn
      // interrupt parked, so work that waits for a reply only from such a
      // session cannot settle before the run reports the question
      // (PI-AGENT-075) or answers the interrupted prompt. Such a reply wait
      // stays open (PI-AGENT-025); only the prompt ends.
      const personHeld = new Set([...questionIds, ...interrupted.flat()])
      const progresses = async (work: WorkReference): Promise<boolean> => personHeld.size === 0 || await deps.progressesWithout([work], personHeld)
      // Background work is pending exactly when the agent loop awaits it: every
      // tracked command holds completion, and a command launched to persist is
      // not tracked. A question or an interrupt parks the model, not sibling
      // commands in the same session, but a notification of ended work cannot
      // commit until the person releases the turn, so it does not hold the park.
      const awaitsWork = async (sessionId: string): Promise<boolean> => {
        const work = deps.backgroundWork(sessionId)
        if (!work) return false
        if (!personHeld.has(sessionId)) return work.awaitedTaskCount() > 0
        // A pending delivery is a command reference, which always progresses.
        const stalled = (await Promise.all(work.liveWorkReferences().map(progresses))).filter((live) => !live).length
        return work.awaitedTaskCount() - work.pendingDeliveryCount() - stalled > 0
      }
      const holdsWork = async (sessionId: string, view: StatusView): Promise<boolean> =>
        view.activeForegroundBashToolCallIds.length > 0 || isActiveActivity(view.activity) || view.activeSubagentCount > 0
        || (await awaitsWork(sessionId) || !personHeld.has(sessionId) && view.waitingOnBackgroundWork)
          && (personHeld.has(sessionId) || await progresses({ kind: "session", sessionId }))
      const busyWorkflows = (await Promise.all(workflows.map((workflowId) => progresses({ kind: "workflow", workflowId })))).some(Boolean)
      if (kept.length > 0 || children.length > 0 || busyWorkflows
        || (await Promise.all(statuses.views.map(({ sessionId, view }) => view !== null && holdsWork(sessionId, view)))).some(Boolean)) return "busy"
      if (pendingTurns.some((id) => !questionIds.has(id))) return "busy"
      return await outcome(sessionIds, questionIds.size > 0, rootSessionId)
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
          const signature = workSignature(payload.status)
          if (signatures.get(cursor.sessionId) === signature) return
          signatures.set(cursor.sessionId, signature)
          listener()
        } else if (payload.kind === "status.removed" || payload.kind === "question.updated"
          || payload.kind === "question.removed" || payload.kind === "session.added"
          || payload.kind === "session.removed") listener()
      })
      const unsubscribeRemoved = deps.onLiveSessionRemoved(listener)
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

interface ServedChatSettlement {
  /** The runtime client's query, with `chatSettlement` answered here. */
  readonly query: RuntimeClient["query"]
  release(): void
}

/** Serves the `chatSettlement` query from the settlement owner and wakes the
 *  clients that wait on a chat with one `settlement.changed` patch per task
 *  for any burst of ownership changes. A woken client asks the query again.
 *  `release` stops the wakes. */
export function serveChatSettlement(deps: {
  readonly client: Pick<RuntimeClient, "query">
  readonly settlement: Pick<RuntimeWorkSettlement, "read" | "onChange">
  readonly currentTotals: (sessionId: string) => Promise<void>
  readonly turnEnding: (sessionId: string) => ChatTurnEnding | undefined
  readonly bus: Pick<RuntimeUiBus, "publish">
}): ServedChatSettlement {
  let timer: ReturnType<typeof setTimeout> | undefined
  const unsubscribe = deps.settlement.onChange(() => {
    timer ??= setTimeout(() => {
      timer = undefined
      deps.bus.publish({ cursor: settlementCursor(), payload: { kind: "settlement.changed" } })
    }, 0)
  })
  // It never waits for the work. Before a settled answer, the root's totals
  // catch up with every usage that the work recorded (ARCH-RUNTIME-079); a
  // failure to read them rejects.
  async function answer(sessionId: string, scope: "turn" | undefined): Promise<ChatSettlementResult> {
    const state = await deps.settlement.read(sessionId, scope)
    if (state === "busy") return { state }
    await deps.currentTotals(sessionId)
    const turnEnding = deps.turnEnding(sessionId)
    return turnEnding ? { state, turnEnding } : { state }
  }
  function query<Q extends RuntimeQuery>(request: Q, options?: RuntimeQueryOptions): Promise<RuntimeQueryResult<Q>>
  async function query(request: RuntimeQuery, options?: RuntimeQueryOptions): Promise<RuntimeQueryResult<RuntimeQuery>> {
    return request.type === "chatSettlement" ? await answer(request.sessionId, request.scope) : await deps.client.query(request, options)
  }
  return { query, release() { clearTimeout(timer); unsubscribe() } }
}
