/**
 * The one composition of a session's interrupt, resume, and stop controls and
 * of the copy that names an interrupted, resumed, or stopped run, so the
 * terminal and the web client admit the same controls from the same row and
 * describe the same state in the same words (PI-AGENT-020, PI-AGENT-072,
 * PI-INTERACTION-043, PI-INTERACTION-101, PI-INTERACTION-103, PI-INTERACTION-044, PI-INTERACTION-115, PI-INTERACTION-140).
 */

import { isActiveActivity, type FrontendMutation, type RuntimeClient, type ChatSessionAction, type SessionCatalogRow, type SessionRow, type StoppedBy, type SubagentSessionAction, type WorkflowDefinitionDrift, type WorkflowSessionAction } from "../app-service-types.js"
import type { StatusView } from "../status-protocol-types.js"
import type { LoadedWorkflowView, WorkflowAgentLive } from "../workflow-view-protocol-types.js"
import { errorMessage } from "../../infra/error-message.js"
import type { AgentGroupBlock, PausedBy } from "../../infra/output-blocks.js"
import type { WorkflowAgentModel } from "./workflow-agent.js"
import type { WorkflowAgentAddress } from "./workflow-addresses.js"
import { lostToCleanClose } from "./connection-failures.js"
import { CANCELED_LABEL, interruptedLabel, PARTIAL_LABEL, STOPPED_LABEL, SUBAGENT_INTERRUPTED_LABEL } from "../../infra/output/run-labels.js"
interface WorkControlOwner {
  readonly workflowId: string
  readonly admittedActions: readonly ("workflow.send" | "workflow.interrupt" | "workflow.resume" | "workflow.restart" | "workflow.stop" | "workflow.delete")[]
}

/** Any row's admitted actions; a control reads the ones its kind admits. */
type SessionAction = ChatSessionAction | WorkflowSessionAction | SubagentSessionAction | WorkControlOwner["admittedActions"][number]

/** The controls a row admits. A message reaches every chat, and a child
 *  while it has not ended; Interrupt is the one resumable cut of every
 *  agent-shaped session; Resume continues it; Stop ends the current child
 *  execution. Non-completed subagents also admit explicit Resume after Stop.
 *  A row listed without turn-end evidence
 *  admits no Resume; the detail read always carries it. */
export interface SessionControls {
  readonly message: boolean
  readonly interrupt: boolean
  readonly resume: boolean
  /** A workflow whose saved progress cannot run starts again from its
   *  recorded request. */
  readonly restart: boolean
  readonly stop: boolean
}

type ControlRow = Pick<SessionRow, "kind" | "admittedActions"> | WorkControlOwner

export function sessionControls(row: ControlRow | undefined): SessionControls {
  const actions: readonly SessionAction[] = row?.admittedActions ?? []
  if (row === undefined) return { message: false, interrupt: false, resume: false, restart: false, stop: false }
  return {
    message: "workflowId" in row ? row.admittedActions.includes("workflow.send") : row.kind === "chat" || actions.includes("session.send"),
    interrupt: actions.includes("workflowId" in row ? "workflow.interrupt" : interruptMutationType(row.kind)),
    resume: actions.includes("workflowId" in row ? "workflow.resume" : resumeMutationType(row.kind)),
    restart: actions.includes("workflow.restart"),
    stop: actions.includes("background.terminate") || ("workflowId" in row && row.admittedActions.includes("workflow.stop")),
  }
}

/** The controls a session offers now. Interrupt and Resume are one slot:
 *  Interrupt while a turn or an agent runs and the row admits it, Resume while
 *  nothing runs and the row admits it; never both, and neither when the
 *  row cannot say (a listing without evidence). Stop ends the current execution and is
 *  separate. */
export interface OfferedSessionControls {
  readonly primary: "interrupt" | "resume" | null
  readonly stop: boolean
}

/** The row admits from durable evidence, which still names the interrupt
 *  until the resumed turn's reply commits, so the row can admit Interrupt
 *  and Resume together; the live status says which one applies now
 *  (`isInterruptible`), and an Interrupt is offered only while there is
 *  something to interrupt. */
export function offeredSessionControls(row: Pick<SessionRow, "kind" | "admittedActions" | "parentSessionId" | "parentToolUseId"> | null | undefined, interruptible: boolean): OfferedSessionControls {
  const admitted = sessionControls(row ?? undefined)
  const primary = interruptible ? admitted.interrupt ? "interrupt" : null : admitted.resume ? "resume" : null
  return { primary, stop: stopMutation(row ?? undefined) !== undefined }
}

/** A subagent header takes Interrupt or Resume from its child's admitted
 *  row. Stop belongs to the running parent call, not to a settled card. */
export function subagentCardControls(row: Parameters<typeof offeredSessionControls>[0], inFlight: boolean): OfferedSessionControls {
  const offered = offeredSessionControls(row, inFlight)
  return { primary: offered.primary, stop: inFlight }
}

/** A listed chat as its detail read leaves it. The catalog listing carries
 *  no turn-end evidence, and the detail read does: the actions the evidence
 *  admits, such as Resume after an interrupt. Every client lays that
 *  evidence over the listed row, which stays the authority for everything
 *  else. A detail of another kind, or none, lays nothing. */
export function withDetailEvidence(listed: SessionCatalogRow, detail: SessionRow | null | undefined): SessionCatalogRow {
  if (detail === null || detail === undefined || detail.kind !== "chat" || detail.admittedActions === undefined) return listed
  return { ...listed, admittedActions: detail.admittedActions }
}

type InterruptStatus = Pick<StatusView, "activity" | "waitingOnBackgroundWork">

/** Whether a session has something an Interrupt cuts now: a running turn or
 *  agent, or a park that waits on background work. A park that waits on
 *  background work is still the agent's turn, so the person can take it
 *  back before the work settles and starts the agent again. Every
 *  Interrupt control, the Escape key, and the hint that names it read this
 *  one rule. */
export function isInterruptible(status: InterruptStatus | undefined): boolean {
  return isActiveActivity(status?.activity) || status?.waitingOnBackgroundWork === true
}

/** Says when a session's admitted actions, read once from its detail, are
 *  stale. The status stream draws the line: a session that stops being
 *  interruptible has ended its turn, and the runtime reports that only
 *  after the turn-end record is durable, so a read then sees what the
 *  record admits (Resume after an interrupt). A session that becomes
 *  interruptible admits Interrupt again, and a status that goes away (a
 *  child settled) leaves the live row behind. The first status a session
 *  reports is a baseline, not an edge. */
interface AdmissionEdges {
  /** Records the session's status and answers whether its admitted actions must be read again. */
  observe(sessionId: string, status: InterruptStatus | undefined): boolean
  forget(sessionId: string): void
}

export function createAdmissionEdges(): AdmissionEdges {
  const interruptible = new Map<string, boolean>()
  return {
    observe(sessionId, status) {
      const prior = interruptible.get(sessionId)
      if (status === undefined) {
        interruptible.delete(sessionId)
        return prior !== undefined
      }
      const next = isInterruptible(status)
      interruptible.set(sessionId, next)
      return prior !== undefined && prior !== next
    },
    forget(sessionId) { interruptible.delete(sessionId) },
  }
}

/** The interrupt mutation a row's kind answers to; one control, three sessions. */
export function interruptMutationType(kind: SessionRow["kind"]): "chat.interrupt" | "subagent.interrupt" {
  return kind === "subagent" ? "subagent.interrupt" : "chat.interrupt"
}

/** What a person hears when a control is not taken: the runtime's refusal in
 *  its own words, a warning when nothing was running, or the failure that
 *  kept the dispatch from being answered. */
export interface ControlRefusal {
  readonly reason: string
  readonly variant: "warning" | "error"
}

/** Dispatches the Interrupt a row's kind answers to, for every control that
 *  offers one, and never rejects. It answers nothing when the runtime took
 *  the interrupt, and nothing when the runtime's clean close lost the dispatch
 *  with its connection, as a planned replacement's stop does: that is a
 *  routine stop, not a fault to show (PI-REMOTE-012). Otherwise it answers the
 *  refusal or the failure. A workflow answers whether an agent was running and
 *  why the runtime could not interrupt it; a chat or a child answers with a
 *  mutation result. */
export async function dispatchInterrupt(client: Pick<RuntimeClient, "dispatch">, row: Pick<SessionRow, "id" | "kind"> | Pick<WorkControlOwner, "workflowId">, targets?: readonly string[]): Promise<ControlRefusal | undefined> {
  try {
    if ("workflowId" in row) {
      const result = await client.dispatch({ type: "workflow.interrupt", workflowId: row.workflowId, ...(targets === undefined ? {} : { targets }) })
      if (result.kind !== "interrupt") return { reason: `unexpected ${result.kind}`, variant: "error" }
      if (result.interrupted) return undefined
      return result.reason === undefined ? { reason: "nothing is running", variant: "warning" } : { reason: result.reason, variant: "error" }
    }
    const result = await client.dispatch({ type: row.kind === "subagent" ? "subagent.interrupt" : "chat.interrupt", sessionId: row.id })
    return result.ok ? undefined : { reason: result.error, variant: "error" }
  } catch (cause) {
    return lostToCleanClose(cause) ? undefined : { reason: errorMessage(cause), variant: "error" }
  }
}

export function resumeMutationType(kind: SessionRow["kind"]): "chat.resume" | "subagent.resume" {
  return kind === "subagent" ? "subagent.resume" : "chat.resume"
}

/** Serializes Resume with workflow message targets; other session kinds remain target-free. */
export function resumeMutation(row: Pick<SessionRow, "id" | "kind"> | Pick<WorkControlOwner, "workflowId">, targets?: readonly string[]): Extract<FrontendMutation, { type: "chat.resume" | "workflow.resume" | "subagent.resume" }> {
  return "workflowId" in row
    ? { type: "workflow.resume", workflowId: row.workflowId, ...(targets === undefined ? {} : { targets }) }
    : { type: row.kind === "subagent" ? "subagent.resume" : "chat.resume", sessionId: row.id }
}

/** An agent control always carries its nonempty address and requires the corresponding admitted workflow action. */
export function agentViewControl(row: ControlRow | null | undefined, model: Pick<WorkflowAgentModel, "state"> | undefined, address: WorkflowAgentAddress | undefined, interruptible: boolean): { readonly kind: "interrupt" | "resume"; readonly targets: readonly [string] } | null {
  if (!row || !("workflowId" in row) || !address?.target || model === undefined) return null
  const admitted = sessionControls(row)
  const kind = model.state === "parked" || (model.state === "running" && !interruptible)
    ? admitted.resume ? "resume" : null
    : model.state === "running" && admitted.interrupt ? "interrupt" : null
  return kind === null ? null : { kind, targets: [address.target] }
}

/** A park labels the workflow when nothing remains interruptible, which an agent that counts its operations live and that no interrupt holds is, and something holds it: an agent that an interrupt holds in the workflow's `workflow_live` value, or the session row's Resume or Restart admission. Restart is admitted only for saved progress that cannot run, which holds the run as an interrupt does. */
export function workflowParked(live: readonly WorkflowAgentLive[], row?: ControlRow | null): boolean {
  const controls = sessionControls(row ?? undefined)
  const interruptible = live.some(({ operations, interruptedAt }) => operations !== undefined && interruptedAt === undefined)
  return !interruptible && (controls.resume || controls.restart || live.some(({ interruptedAt }) => interruptedAt !== undefined))
}

/** A control of a whole workflow, which its card's header offers. */
export type WorkflowControl = "interrupt" | "resume" | "restart"

/** The controls of a workflow card's header: the workflow's own control,
 *  when the row admits one, and whether Stop shows. */
export interface WorkflowCardControls {
  readonly primary?: WorkflowControl
  readonly stop: boolean
}

/** The controls of a workflow card's header, at both sizes. The detail row
 *  admits from durable evidence, so it can admit Interrupt and Resume
 *  together; the card's block says which applies now. Saved progress that
 *  cannot run offers Restart, which runs the workflow again from its
 *  recorded request. While an interrupt parks the run (`parked`), the
 *  workflow's own control is Resume; otherwise it is Interrupt, else Resume,
 *  as the row admits them. Stop ends the parent's call, which the card's
 *  block can stop while its run goes on and the row admits while the call
 *  still waits. */
export function workflowCardControls(row: ControlRow | undefined, inFlight: boolean, parked: boolean): WorkflowCardControls {
  const admitted = sessionControls(row)
  const primary = admitted.restart ? "restart" : parked ? (admitted.resume ? "resume" : undefined) : admitted.interrupt ? "interrupt" : admitted.resume ? "resume" : undefined
  return { ...(primary === undefined ? {} : { primary }), stop: inFlight || admitted.stop }
}

/** Stop is the parent's termination of the tool call this session answers:
 *  the same `background.terminate` that stops a background command. It is
 *  absent for a row that admits no Stop or carries no parent tool call. */
export function stopMutation(row: Pick<SessionRow, "kind" | "admittedActions" | "parentSessionId" | "parentToolUseId"> | undefined): Extract<FrontendMutation, { type: "background.terminate" }> | undefined {
  if (!sessionControls(row).stop || row?.parentSessionId === undefined || row.parentToolUseId === undefined) return undefined
  return { type: "background.terminate", sessionId: row.parentSessionId, toolUseId: row.parentToolUseId }
}

/** Who ended a stopped child, in the words its card uses. */
export function stoppedLabel(by: StoppedBy): string {
  return by === "person" ? STOPPED_LABEL : CANCELED_LABEL
}

/** The run state a child card carries on either side of the wire: the saved
 *  `paused` state names who interrupted it. */
type RunState =
  | { readonly status: Exclude<AgentGroupBlock["status"], "paused"> }
  | { readonly status: "paused"; readonly pausedBy: PausedBy }

/** A child card's run state in the words a person reads, or nothing for a
 *  state its header does not name. The projections write the same words from
 *  infra, so a card and its transcript row never disagree. */
export function runStatusLabel(block: RunState): string | undefined {
  switch (block.status) {
    case "interrupted": return SUBAGENT_INTERRUPTED_LABEL
    case "paused": return interruptedLabel(block.pausedBy)
    case "cancelled": return CANCELED_LABEL
    case "stopped": return STOPPED_LABEL
    case "partial": return PARTIAL_LABEL
    default: return undefined
  }
}

/** The state that a workflow's phase line names after its phases, in the
 *  words a person reads, or nothing while the workflow runs or waits to start. The
 *  state is the workflow view's, which every control commit restates from
 *  committed control. The saved `paused` state is an interrupt, unless its
 *  last Resume found a changed definition, and a Stop ends the run for its
 *  parent whatever the saved state says. A Stop reads "Stopped" or
 *  "Canceled" exactly as every other card names it, because the product
 *  names stopped work by who stopped it. The phase line of the web client and
 *  of the terminal both read this. */
export function workflowStateLabel(state: LoadedWorkflowView["state"], row: WorkflowStateRow | null | undefined, parked = false): string | undefined {
  if (row?.stoppedBy !== undefined) return stoppedLabel(row.stoppedBy)
  const presented = presentedWorkflowState(state, row)
  if (presented === "paused") return row?.definitionDrift === undefined ? "interrupted" : "cannot continue"
  return presented === "completed" || presented === "failed" ? presented : parked ? "interrupted" : undefined
}

/** What a workflow's held detail row adds to its view's state. */
export interface WorkflowStateRow {
  readonly stoppedBy?: StoppedBy
  readonly definitionDrift?: WorkflowDefinitionDrift
  readonly continuationOwed?: true
}

/** The state a workflow presents: its committed state, except that a run a
 *  planned replacement paused runs on while the successor owes it its
 *  continuation (`continuationOwed`, ARCH-SESSIONS-039). Committed control
 *  stays the view's state; the row's owed record is the only source of the
 *  difference. */
export function presentedWorkflowState(state: LoadedWorkflowView["state"], row: Pick<WorkflowStateRow, "continuationOwed"> | null | undefined): LoadedWorkflowView["state"] {
  return state === "paused" && row?.continuationOwed === true ? "running" : state
}

/** What a workflow's Resume does, in the words its control shows: a failed
 *  run runs its failed agents again, and any other run continues from its
 *  current phase. */
export function workflowResumeTitle(state: LoadedWorkflowView["state"]): string {
  return state === "failed"
    ? "Run the failed agents again, with no new message. Every finished agent that does not read a failed agent's output keeps its result."
    : "Continue this workflow from its current phase, with no new message"
}

/** What a workflow phase says while the output of an earlier phase still
 *  decides whether it runs. The workflow card reads this. */
export const CONDITIONAL_PHASE_LABEL = "if needed"

/** What a child that waits on the session that started it shows, on its
 *  card, in its viewer, and in the background index of its chat. */
export const WAITING_ON_PARENT = "Waiting on parent"

/** Selects the reply wait the status shows: the parent first, then the oldest open wait. */
export function displayedReplyWait<Wait extends StatusView["replyWaits"][number]>(waits: readonly Wait[], isParent: (wait: Wait) => boolean): Wait | undefined {
  return waits.find(isParent) ?? waits[0]
}

/** What a parked session waits on, in the words its status line and its
 *  card use: "Waiting on parent" while it waits on the session that started
 *  it, and "Waiting for message response" while it waits on another session. A session
 *  that waits on its parent and on others names its parent, which is the
 *  wait a person can answer. Nothing while it runs or waits on no reply. */
export function replyWaitLabel(status: Pick<StatusView, "waitingOnBackgroundWork" | "replyWaits"> | undefined, parentSessionId: string | undefined): string | undefined {
  const wait = status?.waitingOnBackgroundWork ? displayedReplyWait(status.replyWaits, (candidate) => candidate.sessionId === parentSessionId) : undefined
  if (wait === undefined) return undefined
  if (wait.sessionId === parentSessionId) return WAITING_ON_PARENT
  return "Waiting for message response"
}

/** The child's current activity and the reply it waits on. */
export interface ChildCardStatus {
  readonly waitingOn: string | undefined
  readonly activity?: StatusView["activity"]
}

export function childCardStatus(status: Pick<StatusView, "activity" | "waitingOnBackgroundWork" | "replyWaits"> | undefined, parentSessionId: string | undefined): ChildCardStatus {
  return {
    waitingOn: replyWaitLabel(status, parentSessionId),
    ...(status === undefined ? {} : { activity: status.activity }),
  }
}
