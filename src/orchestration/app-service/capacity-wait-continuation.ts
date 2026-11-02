import type { AsyncEventStateReadSurface } from "../../infra/event-store-types.js"
import { errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import { coalesceRepeats } from "../../infra/repeat-coalescer.js"
import type { RuntimeClient } from "../../protocol/app-service-types.js"
import { recordCapacityWait, type CapacityWaitLedger } from "../session/capacity-wait.js"
import { liveSessionControl } from "../session/live-session-control.js"
import { capacityContinuations, continuationTargetId, readPlannedSessionContinuationAsync, type CapacityWaitRow, type ContinuationLanes } from "../session/planned-session-continuation.js"
import type { WorkflowController } from "../workflow-host/controller.js"
import { resumeMutation } from "./replacement-continuation.js"
import { WHOLE_WORKFLOW } from "../session/conversation/addressed-workflow-messages.js"

const log = Log.create({ service: "capacity-wait-continuation" })

/** A wait whose continuation fails stays owed, and the account's wake tries
 *  it again on its backoff, so the failure of one session or workflow
 *  records once and its repeats are one count, reported when its
 *  continuation next starts or is refused. */
const failures = (what: string, field: "sessionId" | "workflowId") => coalesceRepeats<string>({
  windowMs: 10 * 60_000,
  first: (id, error) => { log.warn(`${what}; its row stays for the next attempt`, { [field]: id, error }) },
  repeated: (id, repeats) => { log.warn(`${what} again`, { [field]: id, count: repeats.count, windowMs: repeats.windowMs, error: repeats.events.at(-1) }) },
})
const hostFailures = failures("the host of a waiting child could not be restored", "sessionId")
const continuationFailures = failures("a capacity wait could not be continued", "sessionId")
const workflowFailures = failures("a capacity wait's workflow could not be resumed", "workflowId")

interface CapacityWaitContinuationInput {
  readonly projectionReader: AsyncEventStateReadSurface
  /** The store every live agent registers its control with. */
  readonly liveStore: AsyncEventStateReadSurface
  readonly manager: { read(sessionId: string): Promise<ContinuationSession | null> }
  readonly ledger: Pick<CapacityWaitLedger, "held" | "hold" | "retire" | "wakeAt">
  /** The executor's continuation lanes, where each resume takes turns with
   *  a person's interrupt of its session. */
  readonly lanes: ContinuationLanes
  readonly dispatch: RuntimeClient["dispatch"]
  /** The workflows, whose resume with a capacity wake continues only the
   *  agents of the conversations it names and keeps every other agent's cut. */
  readonly workflows: Pick<WorkflowController, "resumeWorkflow">
  /** Told once a session's continuation has settled, so the status every
   *  surface shows follows it. */
  readonly settled: (sessionId: string) => void
}

/** What the continuation reads of a session: its kind, and the workflow and
 *  conversation of an agent, or the parent of a child. */
type ContinuationSession =
  | { readonly kind: "chat" | "workflow" }
  | { readonly kind: "workflow-agent"; readonly conversationId: string; readonly workflowMembership: { readonly workflowId: string } }
  | { readonly kind: "subagent"; readonly launchedFrom: { readonly parentSessionId: string } }

/** How one continuation ended: the session's run continues and owns its
 *  row, the continuation was refused for good and the row is retired, or it
 *  could not start now and the row stays for the next attempt. */
type Continued = "continued" | "refused" | "pending"

/** Continues, through each session's owning host, every capacity wait whose
 *  time has come, judged by the wall clock, and that no run of this executor
 *  holds (PI-MODEL-039, ARCH-SESSIONS-039): a chat and a child by their
 *  Resume, the waiting agents of a workflow by one resume of the workflow
 *  that continues only them. Its run owns the row from then on. A wait whose
 *  time has not come is left to the account's wake at that time, so no
 *  request is sent before it.
 *
 *  A child whose parent is an agent of a workflow or another child needs its
 *  parent's host, so that host is restored first: the parent workflow
 *  continues the parent agent, and a parent child is resumed. A child whose
 *  host could not be restored keeps its row, as does a session whose
 *  continuation failed. A refused continuation, such as one of a session
 *  that is gone or a workflow a person stopped, retires its row. A row that
 *  was withdrawn, or that a run took over, before the session's lane opened
 *  is left as it is.
 *
 *  Resolves with the number of due rows still owed by a continuation that
 *  could not start, which the account's wake tries again, and the earliest
 *  time of a row left for later, at which the account wakes the project
 *  next. Never rejects. */
export async function continueCapacityWaits(input: CapacityWaitContinuationInput): Promise<{ readonly pending: number; readonly next: number | null }> {
  let unheld: readonly CapacityWaitRow[]
  try {
    unheld = (await capacityContinuations(input.projectionReader)).filter((continuation) => !input.ledger.held(continuationTargetId(continuation.target)))
  } catch (error) {
    log.warn("the capacity waits of the project could not be read; they stay for the next attempt", { error: errorMessage(error) })
    return { pending: 1, next: null }
  }
  const now = Date.now()
  const owed = unheld.filter((continuation) => continuation.continuesAt <= now)
  const later = unheld.flatMap(({ continuesAt }) => continuesAt > now ? [continuesAt] : [])
  const next = later.length === 0 ? null : Math.min(...later)
  const hosts = new Map<string, Promise<boolean>>()
  /** Each workflow's one resume, which answers for each conversation. */
  const workflows = new Map<string, Promise<(conversationId: string) => Continued>>()
  // The waiting agents of each workflow, which one resume continues together.
  const waitingAgents = new Map<string, Set<string>>()
  // The workflow and conversation of each waiting agent, or "unread" when
  // its session could not be read now, which leaves its row owed.
  const agents = new Map<string, { readonly workflowId: string; readonly conversationId: string } | "unread">()
  for (const continuation of owed) {
    const { target } = continuation
    if (target.kind !== "workflow-agent") continue
    let agent: ContinuationSession | null
    try {
      agent = await input.manager.read(target.sessionId)
    } catch (error) {
      continuationFailures.observe(target.sessionId, errorMessage(error))
      agents.set(target.sessionId, "unread")
      continue
    }
    if (agent?.kind !== "workflow-agent") continue
    const workflowId = agent.workflowMembership.workflowId
    agents.set(target.sessionId, { workflowId, conversationId: agent.conversationId })
    const set = waitingAgents.get(workflowId) ?? new Set()
    set.add(agent.conversationId)
    waitingAgents.set(workflowId, set)
  }
  const resumeWorkflow = async (workflowId: string, conversationId: string): Promise<Continued> => {
    const waiting = waitingAgents.get(workflowId) ?? new Set()
    waiting.add(conversationId)
    waitingAgents.set(workflowId, waiting)
    const running = workflows.get(workflowId) ?? input.workflows.resumeWorkflow(workflowId, WHOLE_WORKFLOW, { wake: { capacity: waiting } }).then((outcome): (conversationId: string) => Continued => {
      if (outcome.kind !== "unavailable") workflowFailures.end(workflowId)
      // A live workflow answers for each agent it named: one it did not
      // continue, such as one whose attempt has not opened, stays owed.
      if (outcome.kind === "resumed") {
        const { continued } = outcome
        return (id) => continued === undefined || continued.has(id) ? "continued" : "pending"
      }
      // A concurrent resume runs the workflow; the next wake continues the agent inside it.
      if (outcome.kind === "already_running") return () => "pending"
      if (outcome.kind === "unavailable") {
        workflowFailures.observe(workflowId, outcome.kind)
        return () => "pending"
      }
      log.warn("a capacity wait's workflow refused its continuation", { workflowId, kind: outcome.kind })
      return () => "refused"
    })
    workflows.set(workflowId, running)
    return (await running)(conversationId)
  }
  /** Whether the host of `sessionId` runs, after restoring it when it does not. */
  const ensureHost = (sessionId: string): Promise<boolean> => {
    const known = hosts.get(sessionId)
    if (known) return known
    const restored = (async () => {
      const session = await input.manager.read(sessionId)
      if (!session) return false
      if (session.kind === "chat") return true
      if (liveSessionControl(input.liveStore, sessionId)) return true
      if (session.kind === "workflow-agent") return await resumeWorkflow(session.workflowMembership.workflowId, session.conversationId) === "continued"
      if (session.kind !== "subagent" || !await ensureHost(session.launchedFrom.parentSessionId)) return false
      return resultOk(await input.dispatch(resumeMutation({ kind: "subagent", sessionId })))
    })().then((hosted) => {
      hostFailures.end(sessionId)
      return hosted
    }, (error: unknown) => {
      hostFailures.observe(sessionId, errorMessage(error))
      return false
    })
    hosts.set(sessionId, restored)
    return restored
  }
  const continueOne = async (continuation: CapacityWaitRow): Promise<Continued> => {
    const { target } = continuation
    if (target.kind === "workflow") return "refused"
    if (target.kind === "workflow-agent") {
      // Only a session that is gone or is no agent of a workflow refuses.
      const agent = agents.get(target.sessionId)
      if (agent === "unread") return "pending"
      return agent === undefined ? "refused" : await resumeWorkflow(agent.workflowId, agent.conversationId)
    }
    if (target.kind === "subagent") {
      const child = await input.manager.read(target.sessionId)
      if (child?.kind !== "subagent") return "refused"
      if (!await ensureHost(child.launchedFrom.parentSessionId)) return "pending"
      // The child may be the host of a waiting grandchild, which resumed it.
      if (liveSessionControl(input.liveStore, target.sessionId)) return "continued"
    }
    return resultOk(await input.dispatch(resumeMutation(target))) ? "continued" : "refused"
  }

  let pending = 0
  for (const continuation of owed) {
    const sessionId = continuationTargetId(continuation.target)
    let outcome: Continued | "withdrawn" = "pending"
    try {
      outcome = await input.lanes.resume(sessionId, async (mayDispatch) => {
        // The row is read again in the lane: a person's message, interrupt,
        // or Stop that came first withdrew the wait, and a run that waits
        // again holds its own row, so neither is continued here.
        const current = await readPlannedSessionContinuationAsync(input.projectionReader, sessionId)
        if (current?.handoffId !== undefined || current?.continuesAt !== continuation.continuesAt || input.ledger.held(sessionId) || !mayDispatch()) return "withdrawn"
        return await continueOne(continuation)
      })
      if (outcome !== "pending") continuationFailures.end(sessionId)
    } catch (error) {
      continuationFailures.observe(sessionId, errorMessage(error))
    }
    // One record per wait: its run takes the row over once, a refusal
    // records its withdrawal, and a continuation still pending records
    // nothing, since the account's wake tries it again.
    if (outcome === "continued") {
      recordCapacityWait("fired", { sessionId, continuesAt: continuation.continuesAt })
      input.ledger.hold(sessionId)
    } else if (outcome === "refused") await input.ledger.retire(sessionId, "refused")
    else if (outcome === "pending") pending += 1
    input.settled(sessionId)
  }
  return { pending, next }
}

/** What one continuation of an executor's capacity waits left: how many due
 *  waits are still owed by a continuation that could not start, the
 *  project's earliest owed time (`at`), which the account store holds, so a
 *  restart of the account or an end of this executor continues every row,
 *  and the earliest time of a row this continuation left for later
 *  (`next`), which the account wakes the project at once `at` passed. */
export interface CapacityContinuation {
  readonly pending: number
  readonly at: number | null
  readonly next: number | null
}

/** The executor's continuation of its capacity waits: one at a time, so a
 *  wake that arrives during the start's continuation finds the waits it
 *  started held. */
export function capacityContinuer(input: CapacityWaitContinuationInput): () => Promise<CapacityContinuation> {
  let running: Promise<unknown> = Promise.resolve()
  return () => {
    const continued = running.then(async () => ({ ...await continueCapacityWaits(input), at: await input.ledger.wakeAt() }))
    running = continued.catch(() => {})
    return continued
  }
}

function resultOk(result: unknown): boolean {
  return typeof result === "object" && result !== null && "ok" in result && result.ok === true
}
