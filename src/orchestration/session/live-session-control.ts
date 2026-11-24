import type { WorkflowDeliveryAddress } from "./conversation/addressed-workflow-messages.js"
import type { ChatInput, ChatInputLike } from "../../infra/chat-input.js"
import type { AsyncEventStateReadSurface } from "../../infra/event-store-types.js"
import type { HeldBackgroundNotification } from "./conversation/queued-background-notifications.js"
import type { TurnInterruption } from "./conversation/turn-end-record.js"
import { NO_MODULE_RUNTIMES, type ModuleRuntimes } from "../../infra/module-runtime.js"
import type { SessionMetadataReader } from "./schemas.js"
import type { SessionStore } from "../session-store/types.js"
import type { ChatRunner } from "../chat/runner-types.js"
import type { BackgroundWorkTracking } from "../agent-runtime/background-work.js"
import type { DeliveryOutcome, LiveRecipientState } from "./message-disposition.js"

/** The assembled parent host that owns child execution and tracking. */
interface ParentHost {
  modules(): Promise<ModuleRuntimes>
  readonly backgroundTasks: BackgroundWorkTracking | undefined
}

/** Resolves a child's parent host, attaching a chat idle without starting a turn.
 *  A subagent must already have a live host. An agent of a workflow is waited
 *  for while its workflow runs it, because a successor resumes the agent's
 *  children as the workflow's resume assembles the agent again. */
export async function parentHost(deps: {
  readonly manager: SessionMetadataReader
  readonly sessionStore: SessionStore
  readonly eventReader: AsyncEventStateReadSurface
  readonly openChatRunner?: (sessionId: string) => Promise<ChatRunner | undefined>
}, parentSessionId: string, conversationId: string | undefined): Promise<ParentHost | undefined> {
  const parent = await deps.manager.read(parentSessionId)
  if (parent?.kind === "subagent") {
    const child = liveChildRun(deps.eventReader, parentSessionId)?.child
    const modules = await child?.modules()
    return modules && child ? { modules: async () => modules, backgroundTasks: child.backgroundTasks } : undefined
  }
  const entry = deps.sessionStore.get(parentSessionId)
  if (parent?.kind === "workflow-agent") {
    if (conversationId !== undefined && parent.conversationId !== conversationId) return undefined
    const member = await liveWorkflowControl(deps.eventReader, parent.workflowMembership.workflowId)?.memberHost(parent.conversationId)
    return member ? { modules: async () => member.modules, backgroundTasks: member.backgroundTasks } : undefined
  }
  if (parent?.kind !== "chat") return undefined
  const runner = (entry?.kind === "chat" ? entry.runner : undefined) ?? await deps.openChatRunner?.(parentSessionId)
  if (!runner) return undefined
  return {
    modules: async () => runner.moduleRuntimes && runner.moduleRuntimes !== NO_MODULE_RUNTIMES ? runner.moduleRuntimes : await runner.hold(),
    backgroundTasks: runner.backgroundTasks,
  }
}

/** What a running subagent's card shows of its current run, read live. */
interface LiveChildRunProgress {
  readonly toolUses: number
  readonly totalTokens: number
  readonly startedAtMs: number
}

/** The run binding of a subagent and its cut controls. */
interface LiveChildRun {
  readonly runId: string
  readonly parentSessionId: string
  readonly parentConversationId: string
  readonly parentToolCallId: string
  /** Waits for this live run's host, or returns nothing if the run ends before assembly. */
  modules(): Promise<ModuleRuntimes | undefined>
  readonly backgroundTasks: BackgroundWorkTracking
  /** Ends the run as a Stop: a person's Stop settles it as `stopped`, and
   *  its parent agent's Stop as `cancelled`. A `deletion` ends it for a
   *  delete, which returns the unread messages of every sender but the
   *  parent with its tombstone. */
  stop(by: "person" | "agent" | "deletion"): void
  /** Cuts the run and settles it as interrupted by `by` (saved as
   *  `paused`), keeping its binding for resume. Resolves once the run is
   *  settled and its session inactive, with false when the run's end was
   *  already decided, such as by its handoff, the return of its loop, or a
   *  failure; it resolves after settlement either way. The interrupt of a
   *  person, of the parent agent, and of the runtime's planned replacement
   *  are this one operation. */
  interrupt(by: TurnInterruption): Promise<boolean>
  /** The operations and tokens of the current run so far, read from the
   *  run's own counters on each call and never stored. */
  progress(): LiveChildRunProgress
}

/** The process-local input handle of one live session: a chat runner, a
 *  workflow runner, or a subagent run. Durable facts stay authoritative for
 *  every state the delivery reads; this handle only reaches the running
 *  loop. */
export interface LiveSessionControl {
  readonly sessionId: string
  /** A chat can remain registered with no attached runner. Child and member
   * controls expose their required registry through their own host binding. */
  readonly backgroundTasks?: BackgroundWorkTracking
  readonly child?: LiveChildRun
  readonly member?: {
    /** The workflow that runs this agent. */
    readonly workflowId: string
    modules(): Promise<ModuleRuntimes | undefined>
    readonly backgroundTasks: BackgroundWorkTracking
    compact(): Promise<boolean>
    interrupt(by: TurnInterruption): boolean
    releaseForegroundBash(toolUseId: string): boolean
    transferForegroundForReplacement(): Promise<void>
    terminateBackgroundWork(toolUseId: string): void
  }
  readonly settled?: Promise<void>
  /** Releases only the terminal workflow revision that parent reconciliation made durable. */
  acknowledgeCompletion?(aggregateSeq: number): void
  /** Current attempt conversations and admitted work, without publishing session aliases. */
  workProgress?(): Promise<WorkflowWorkProgress>
  /** The state a message would meet now, read without delivering anything.
   *  Each runner kind reports the park state that its loop states in
   *  `TurnParkedContext.park`. */
  state(): Promise<LiveRecipientState>
  /** Takes the latest unread human input back from this private session. */
  recallQueuedMessage?(): Promise<ChatInputLike | null>
  /** Owns admission from the durable hold through queue delivery or refusal cleanup.
   * The span ends only after the input reaches the queue or its hold is dropped.
   * Closing joins existing spans and refuses new spans with `handing_off`. */
  withInputAdmission?(admit: () => Promise<DeliveryOutcome>): Promise<DeliveryOutcome>
  /** Displays a notice already committed elsewhere, without model input or a turn. */
  publishCommittedNotice?(notice: { readonly id: string; readonly message: string; readonly timestamp: number }): void
  /** Hands one accepted message to the live session. Its cell is durable
   *  before the call, and the input carries the cell key in `dispatchIds`.
   *  The control reads its own state where it orders its input, asks
   *  `decide` what that state means for this message, and acts on the
   *  answer. A refused message never reaches its input source. A workflow's
   *  message with an `address` reaches the running agent only when that
   *  agent is one that the address names; only a workflow receives one. */
  deliver(input: ChatInput, decide: (state: LiveRecipientState) => DeliveryOutcome, address?: WorkflowDeliveryAddress): Promise<DeliveryOutcome>
  /** Hands one notice that the session already holds to the run that reads
   *  it now, which commits it under its key and retires the hold. A notice
   *  follows the completion-notice gate: it starts no turn behind an
   *  interrupt. False when no run reads it now; the hold then waits for the
   *  next run of its conversation. */
  notify(notification: HeldBackgroundNotification): Promise<boolean>
}
export interface LiveWorkflowControl extends Omit<LiveSessionControl, "sessionId" | "child" | "member"> {
  readonly kind: "workflow"
  readonly workflowId: string
  /** Hands one parked member back for a message that reached it: rechecks
   *  the run's capability admission, then runs `continueMember`. A member
   *  that continues continues the run, so the run's interrupt cut clears.
   *  Undefined when admission refuses, else whether the member continued. */
  handBackMember(continueMember: () => boolean): Promise<boolean | undefined>
  /** Waits for the assembled host of the running or pending agent whose
   *  conversation is `conversationId`. Undefined once the run ends, or when
   *  the run runs no such agent. */
  memberHost(conversationId: string): Promise<{ readonly modules: ModuleRuntimes; readonly backgroundTasks: BackgroundWorkTracking | undefined } | undefined>
}

/** The live workflow frontier and the conversations that can make progress. */
interface WorkflowWorkProgress {
  readonly runnable: boolean
  readonly members: readonly {
    readonly sessionId: string
    readonly conversationId: string
    readonly state: LiveRecipientState
    readonly tasks?: Pick<BackgroundWorkTracking, "liveWorkReferences" | "observeWorkChanges">
  }[]
}

/** A control that carries a subagent run binding. */
export type LiveChildControl = LiveSessionControl & { readonly child: LiveChildRun }

/** The key of one live session or workflow: the key its control registers
 *  under and the key a change of its live work names. */
export type LiveWorkKey = `session:${string}` | `workflow:${string}`

const controlsByStore = new WeakMap<AsyncEventStateReadSurface, Map<LiveWorkKey, LiveSessionControl | LiveWorkflowControl>>()
const waitersByStore = new WeakMap<AsyncEventStateReadSurface, Map<string, Set<() => void>>>()
const removalListenersByStore = new WeakMap<AsyncEventStateReadSurface, Set<(sessionId: string) => void>>()
const workListenersByStore = new WeakMap<AsyncEventStateReadSurface, Set<(key: LiveWorkKey) => void>>()

/** Publishes a change of the live work that `key` names: its registration or
 *  removal, a workflow frontier, or a member state. */
export function notifyLiveWorkChanged(store: AsyncEventStateReadSurface, key: LiveWorkKey): void {
  for (const listener of workListenersByStore.get(store) ?? []) listener(key)
}

/** Observes live ownership and workflow progress, not steady-state snapshots. */
export function onLiveWorkChanged(store: AsyncEventStateReadSurface, listener: (key: LiveWorkKey) => void): () => void {
  const listeners = workListenersByStore.get(store) ?? new Set<(key: LiveWorkKey) => void>()
  workListenersByStore.set(store, listeners)
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function controls(store: AsyncEventStateReadSurface): Map<LiveWorkKey, LiveSessionControl | LiveWorkflowControl> {
  const existing = controlsByStore.get(store)
  if (existing) return existing
  const created = new Map<LiveWorkKey, LiveSessionControl | LiveWorkflowControl>()
  controlsByStore.set(store, created)
  return created
}

function isChildControl(control: LiveSessionControl | LiveWorkflowControl | undefined): control is LiveChildControl {
  return control !== undefined && "sessionId" in control && control.child !== undefined
}

/** Returns only a process-local handle. Durable run and lineage facts remain authoritative. */
export function liveSessionControl(store: AsyncEventStateReadSurface, sessionId: string): LiveSessionControl | undefined {
  const control = controls(store).get(`session:${sessionId}`)
  return control && "sessionId" in control ? control : undefined
}

export function liveWorkflowControl(store: AsyncEventStateReadSurface, workflowId: string): LiveWorkflowControl | undefined {
  const control = controls(store).get(`workflow:${workflowId}`)
  return control && "workflowId" in control ? control : undefined
}

export function liveWorkflowControls(store: AsyncEventStateReadSurface): readonly LiveWorkflowControl[] {
  return [...controls(store).values()].filter((control): control is LiveWorkflowControl => "workflowId" in control)
}

/** The live subagent run of `sessionId`, if one runs in this process. */
export function liveChildRun(store: AsyncEventStateReadSurface, sessionId: string): LiveChildControl | undefined {
  const control = liveSessionControl(store, sessionId)
  return isChildControl(control) ? control : undefined
}

/** Every session live in this process, for the sessions a lookup lists. */
export function liveSessionControls(store: AsyncEventStateReadSurface): readonly LiveSessionControl[] {
  return [...controls(store).values()].filter((control): control is LiveSessionControl => "sessionId" in control)
}

/** Snapshot of the subagent runs live in this process, for a planned
 *  replacement and its blockers. Chat and workflow controls are not runs. */
export function liveChildRuns(store: AsyncEventStateReadSurface): readonly LiveChildControl[] {
  return [...controls(store).values()].filter(isChildControl)
}

/** The ids of `sessionIds` whose child runs still own work: a subagent run that is running, waiting on its own work,
 *  or between turns, and a workflow run that a person did not interrupt. On ordinary completion a workflow stays
 *  registered until reconciliation has submitted its result to the parent, so settlement sees no gap between the run
 *  and the parent's next turn. Stop, interruption, and runtime disposal reconcile outside the run by design. */
export async function runningChildSessionIds(store: AsyncEventStateReadSurface, sessionIds: readonly string[]): Promise<readonly string[]> {
  const running = await Promise.all(sessionIds.map(async (sessionId) => {
    const control = liveChildRun(store, sessionId)
    if (!control) return null
    const state = await control.state()
    return state === "running" || state === "waiting_on_work" || state === "between_steps" ? control.sessionId : null
  }))
  return running.filter((id) => id !== null)
}

/** Registers one live session until its owner ends. It creates no recovery state. */
export function registerLiveSessionControl(store: AsyncEventStateReadSurface, control: LiveSessionControl): () => void {
  const registered = controls(store)
  const key: LiveWorkKey = `session:${control.sessionId}`
  if (registered.has(key)) throw new Error(`Session is already live: ${control.sessionId}`)
  registered.set(key, control)
  // A member that joins or leaves changes its workflow's live work too, also
  // for a reader that has not read this member yet.
  const changed = (): void => {
    notifyLiveWorkChanged(store, key)
    if (control.member) notifyLiveWorkChanged(store, `workflow:${control.member.workflowId}`)
  }
  changed()
  if (isChildControl(control)) {
    const waiters = waitersByStore.get(store)?.get(control.sessionId)
    waitersByStore.get(store)?.delete(control.sessionId)
    for (const waiter of waiters ?? []) waiter()
  }
  return () => {
    if (registered.get(key) !== control) return
    registered.delete(key)
    changed()
    for (const listener of removalListenersByStore.get(store) ?? []) listener(control.sessionId)
  }
}

/** Registers aggregate work, including zero-member runs, until durable acknowledgement. */
export function registerLiveWorkflowControl(store: AsyncEventStateReadSurface, control: LiveWorkflowControl): () => void {
  const registered = controls(store)
  const key: LiveWorkKey = `workflow:${control.workflowId}`
  if (registered.has(key)) throw new Error(`Workflow is already live: ${control.workflowId}`)
  registered.set(key, control)
  notifyLiveWorkChanged(store, key)
  return () => {
    if (registered.get(key) !== control) return
    registered.delete(key)
    notifyLiveWorkChanged(store, key)
  }
}

/** Calls `listener` with the session id each time a live session leaves this
 *  process: its run settled, its runner was released, or its host closed.
 *  A listener reads durable state to learn which, because the removal alone
 *  does not say. */
export function onLiveSessionRemoved(store: AsyncEventStateReadSurface, listener: (sessionId: string) => void): () => void {
  const listeners = removalListenersByStore.get(store) ?? new Set<(sessionId: string) => void>()
  removalListenersByStore.set(store, listeners)
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** A wait for one subagent run to become live; `cancel` withdraws it. */
export interface LiveChildRunWait {
  readonly active: Promise<void>
  cancel(): void
}

/** Resolves once a run of `sessionId` is live in this process, at once if
 *  one already is. The caller bounds the wait. */
export function whenLiveChildRun(store: AsyncEventStateReadSurface, sessionId: string): LiveChildRunWait {
  if (liveChildRun(store, sessionId)) return { active: Promise.resolve(), cancel: () => undefined }
  const byStore = waitersByStore.get(store) ?? new Map<string, Set<() => void>>()
  waitersByStore.set(store, byStore)
  const waiters = byStore.get(sessionId) ?? new Set<() => void>()
  byStore.set(sessionId, waiters)
  const { promise, resolve } = Promise.withResolvers<void>()
  waiters.add(resolve)
  return {
    active: promise,
    cancel: () => {
      waiters.delete(resolve)
      if (waiters.size === 0 && byStore.get(sessionId) === waiters) byStore.delete(sessionId)
    },
  }
}
