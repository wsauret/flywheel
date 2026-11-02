import type { SessionInputProducer } from "../../infra/chat-input.js"
import { DebugLog } from "../../infra/debug-log.js"
import { coalesceRepeats } from "../../infra/repeat-coalescer.js"
import type { SessionRelation } from "../../infra/chat-input-schema.js"
import { queuedUserInputKey } from "./conversation/queued-user-inputs.js"
import { liveSessionControls, liveWorkflowControls, messageDisposition, type RecipientState, type DeliveryOutcome } from "./live-session-control.js"
import { workflowRunReader } from "../module-catalog.js"
import { readPlannedSessionContinuationAsync } from "./planned-session-continuation.js"
import { observeSessionChanged, observeSessionResumed, observeSessionYield, openReplyWait, restoreReplyWaits, sessionNameOf, waitsReach, type ReplyWaitDeps, type ReplyWaitRecipientState, type ReplyWaitTasks, type SessionYield } from "./reply-waits.js"
import { readPendingTurnEnd } from "./chat-session-run-evidence.js"
import { subagentRunCut } from "./child-continuation.js"
import { installedChildSessionHistory } from "./module-session-operations.js"
import type { ChildSessionControl } from "./child-session-control.js"
import { sessionDisplayName, type ReplayedSession, type Session } from "./schemas.js"
import type { WorkflowMembership } from "../../infra/session-workflow-membership.js"
import { resolveWorkflowDeliveryAddress } from "../workflow-host/workflow-addressing.js"
import type { WorkflowMessageAddress } from "../../workflows/context-bundle/context-facts.js"
import { deliverSessionInput, deliverWorkflowInput, readRecipientState, readWorkflowRecipientState, readWorkflowRecipientStates, type SessionInputDeliveryDeps } from "./session-input-delivery.js"

/** The recipient as a result names it. `name` is the recipient's display
 *  name, present when the session exists. */
type Addressed = { readonly to: string; readonly name?: string }

/** What `message_session` reports to its sender. The reply never comes back
 *  as this result: it arrives later as an incoming message. `waiting` says
 *  that the call opened a reply wait. */
export type MessageSessionResult = Addressed & (
  | { readonly status: "delivered"; readonly waiting: boolean }
  | { readonly status: "held"; readonly reason: "interrupted" | "no_reader" | "wake_limit"; readonly waiting: boolean }
  | { readonly status: "refused"; readonly reason: "not_found" | "deleted" | "settled" | "handing_off" | "self" | "waits_on_you" | "not_parent_or_child" | "duplicate" }
  /** `targets` named no item or agent that reads the message now. `detail`
   *  says why and lists every valid target with its state. */
  | { readonly status: "refused"; readonly reason: "address"; readonly detail: string }
  | { readonly status: "refused"; readonly reason: "workflow_wait" }
)

/** How a session reads to a caller of `list_sessions`. */
export type SessionListState = "running" | "handing_off" | "idle" | "interrupted" | "closed" | "settled"

/** One row of `list_sessions`. */
export interface SessionListing {
  readonly id: string
  readonly kind: Session["kind"] | "workflow"
  readonly relation: SessionRelation
  readonly name: string
  readonly state: SessionListState
  readonly target: "session" | "workflow"
  readonly owningChat?: string
  readonly workflowMembership?: WorkflowMembership
}

/** Who a session is, as its identity prompt section states it. */
export interface SessionIdentity {
  readonly sessionId: string
  readonly conversationId: string
  readonly kind: Session["kind"]
  /** The parent of a subagent or a workflow. A chat is a root. */
  readonly parent?: { readonly sessionId: string; readonly name: string }
  /** The session at the top of the parent chain: the chat whose tree holds this session, or the session itself. */
  readonly rootSessionId: string
  readonly workflowMembership?: WorkflowMembership
  readonly importedResources?: { readonly workflowId: string; readonly conversationId: string }
}

/** The sending tool call. The runtime fills every field, so the model of the
 *  sender cannot claim another identity or another hop. */
interface SendingCall {
  readonly sessionId: string
  readonly conversationId: string
  readonly toolUseId: string
  readonly hop: number
}

/** The kernel authority behind `message_session`, `list_sessions`, and the
 *  child rows and controls of `process`: one per project, shared by every
 *  session of the project and by its children. */
export interface SessionMessaging {
  /** The controls of the children that the caller started. `process` lists
   *  and controls them, and `list_sessions` leaves them out. */
  readonly children: ChildSessionControl
  /** Delivers `text` to session `to`. `personWords` returns the words of the
   *  person that the sender read since its last exchange with the recipient,
   *  which the runtime attaches (the model declares nothing about the
   *  person). With `wait`, a delivered message also opens a reply wait in
   *  the sender's background work; with `wait` and no `text`, the call only
   *  opens the wait. A wait on a session that is neither the sender's parent
   *  nor its own child refuses the whole call. A text that repeats the last
   *  text of the sender to `to` in the same `exchange`, less than 30 seconds
   *  after delivery accepted it, is refused as `duplicate`. */
  send(input: {
    readonly sender: SendingCall
    readonly target: "session" | "workflow"
    readonly to: string
    readonly text?: string
    /** Items or agents of the workflow `to` that the text is for: item keys
     *  of a phase over a list, or agent ids of a phase of named agents. Only
     *  the workflow's parent sends them, always with a text. The whole call is
     *  refused before anything is written when one names no item or agent that reads
     *  the message now. */
    readonly targets?: readonly string[]
    /** The sending call of the last message that the sender read from `to`,
     *  from the sender's own history. A message from the recipient starts a
     *  new exchange, so the same short answer to its next question is a new
     *  message. */
    readonly exchange?: string
    readonly wait?: ReplyWaitTasks
    /** The sender's run, which takes back its own interrupted child that
     *  holds this message, when the parent may continue the child's latest
     *  cut (`parentMayContinue`). */
    readonly handBack?: boolean
    readonly personWords: (recipient: Pick<ReplayedSession, "launchedFrom">) => string | undefined
  }): Promise<MessageSessionResult>
  /** Ties one run of a session to the reply waits of the project (ARCH-SESSIONS-032).
   *  Before it resolves, the run registers again in `tasks` each
   *  wait that the session holds. */
  observeRun(run: { readonly sessionId: string; readonly tasks?: ReplyWaitTasks }): Promise<SessionRunWaits>
  /** The sessions that the caller can message and did not start: its
   *  parent, its siblings, and every other session of the project that runs
   *  in this process. The caller's own children are in `children`. */
  list(callerSessionId: string): Promise<readonly SessionListing[]>
  /** The identity of `sessionId`, or nothing for a session that is gone. */
  identity(sessionId: string): Promise<SessionIdentity | undefined>
}

/** The parent of a child session. A chat's `launchedFrom` names the chat it
 *  was forked from, which is not a parent. */
function parentSessionIdOf(session: ReplayedSession): string | undefined {
  return session.kind === "chat" ? undefined : session.launchedFrom?.parentSessionId
}

/** A session with its id, which its replayed metadata does not carry. */
interface IdentifiedSession {
  readonly id: string
  readonly session: ReplayedSession
}

/** How `subject` relates to `viewer`: `parent` when `subject` is the parent
 *  of `viewer`, `child` when it is a child of `viewer`, `sibling` when both
 *  have one parent. */
function sessionRelation(subject: IdentifiedSession, viewer: IdentifiedSession): SessionRelation {
  const viewerParent = parentSessionIdOf(viewer.session)
  const subjectParent = parentSessionIdOf(subject.session)
  if (viewerParent === subject.id) return "parent"
  if (subjectParent === viewer.id) return "child"
  if (viewerParent !== undefined && viewerParent === subjectParent) return "sibling"
  return "other"
}

/** Whether `sender` may wait on `recipient`: only on its parent or on its own
 *  child. A child that waits on its parent asks for a decision it cannot make
 *  alone, and a parent that waits on its child asks for a fact about work it
 *  launched. Between any other sessions a wait parks one session on work that
 *  the other session owns, so the sender continues on its own judgment
 *  instead. */
function waitsAllowed(sender: IdentifiedSession, recipient: IdentifiedSession): boolean {
  const relation = sessionRelation(recipient, sender)
  return relation === "parent" || relation === "child"
}

/** How a session list reads a recipient state, or nothing for a session
 *  that is gone. */
export function listState(state: RecipientState): SessionListState | undefined {
  switch (state) {
    case "running":
    case "waiting_on_work":
    case "between_steps":
    case "planned_cut": return "running"
    case "handing_off": return "handing_off"
    case "idle": return "idle"
    case "interrupted": return "interrupted"
    case "at_rest": return "closed"
    case "settled": return "settled"
    case "deleted":
    case "not_found": return undefined
  }
}

/** Whether a message with this outcome can carry a wait. An interrupt is the
 *  one resumable cut: the addressee reads a message that it holds when it
 *  resumes, so a wait opens on it. Nothing reads a message held for any
 *  other reason until something else runs the addressee, so no wait opens. */
function admitsWait(outcome: DeliveryOutcome): boolean {
  return outcome.status === "delivered" || (outcome.status === "held" && outcome.reason === "interrupted")
}

/** The state a wait reads of its addressee. A session that a planned
 *  replacement cut reads as cut, whatever its live state says while this
 *  executor stops, because its successor resumes it. */
async function addresseeState(deps: SessionInputDeliveryDeps, sessionId: string): Promise<ReplyWaitRecipientState> {
  const session = await deps.manager.read(sessionId)
  const state = await readRecipientState(deps, sessionId, session)
  if (state === "interrupted") {
    const reader = deps.projectionReader
    if (session?.kind === "workflow-agent") {
      const cut = await readPendingTurnEnd(reader, session.conversationId)
      if (cut?.reason === "paused") return { state, by: cut.pausedBy }
    } else if (session?.kind === "subagent") {
      const run = (await installedChildSessionHistory().readRuns(reader, sessionId)).at(-1)
      if (run) {
        const recorded = run.conversationId ? await readPendingTurnEnd(reader, run.conversationId) : undefined
        const cut = subagentRunCut(run, recorded)
        if (cut?.kind === "interrupt") return { state, by: cut.by }
      }
    }
  }
  if (state !== "at_rest") return state
  return await readPlannedSessionContinuationAsync(deps.projectionReader, sessionId) ? "planned_cut" : state
}

/** The session at the top of `sessionId`'s parent chain, as its identity
 *  states it (`SessionIdentity.rootSessionId`): the root of its chat tree. */
export async function treeRootSessionIdOf(manager: SessionInputDeliveryDeps["manager"], sessionId: string): Promise<string> {
  return (await lineageOf({ manager }, sessionId)).at(-1) ?? sessionId
}

/** `sessionId` and the sessions above it, its parent first. A parent link
 *  that loops ends the walk. */
async function lineageOf(deps: Pick<SessionInputDeliveryDeps, "manager">, sessionId: string): Promise<readonly string[]> {
  const lineage: string[] = []
  let next: string | undefined = sessionId
  while (next !== undefined && !lineage.includes(next)) {
    lineage.push(next)
    const session = await deps.manager.read(next)
    next = session ? parentSessionIdOf(session) : undefined
  }
  return lineage
}

/** One part of an address, as the duplicate guard compares it. */
function addressKey(address: WorkflowMessageAddress): string {
  switch (address._tag) {
    case "workflow": return ""
    case "item": return address.itemNodeId
    case "agent": return address.nodeId
  }
}

/** How long a sent text counts as already sent to its recipient: a body
 *  that repeats the sender's last body inside the same 30 seconds is a
 *  retry of that send, not a new message. */
const DUPLICATE_WINDOW_MS = 30_000

/** Settles one claimed send: `accepted` is true when delivery delivered or
 *  held the text, and false when it refused the text or failed. */
type SettleSend = (accepted: boolean) => void

interface SentTexts {
  /** Claims the send of `text` from `sender` to `to` in `exchange`, for
   *  the items or agents that `address` names. It resolves to nothing when
   *  the text repeats the last text that the sender sent there, in the same
   *  exchange and to the same address, less than DUPLICATE_WINDOW_MS ago,
   *  and delivery accepted that text. Otherwise it resolves to the function
   *  that settles this send. The same text to another item is another
   *  message. */
  claim(input: { readonly sender: string; readonly to: string; readonly exchange: string | undefined; readonly address: string | undefined; readonly text: string }): Promise<SettleSend | undefined>
}

/** The last text that one sender sent one recipient. */
interface LastSend {
  /** The exchange, the address, and the hash of the text. */
  readonly key: string
  readonly at: number
  readonly accepted: Promise<boolean>
}

/** The last text that each sender sent each recipient in the last
 *  DUPLICATE_WINDOW_MS, by hash. It lives in the memory of this process
 *  only, because it is a backstop against a sender that sends one message
 *  again and again, not a record of what was sent: the conversation is that
 *  record. Each entry expires after the window, so the map holds at most the
 *  sends of the last 30 seconds. The window reads the monotonic clock, so a
 *  wall clock that steps back cannot stretch it. */
function sentTexts(): SentTexts {
  // A claim deletes its pair before it sets it, so the map keeps send order
  // and the expired entries are always at its front.
  const lastSends = new Map<string, LastSend>()
  const refusals = coalesceRepeats<DuplicateSend>({
    windowMs: DUPLICATE_WINDOW_MS,
    first: (_key, send) => recordDuplicateRefusal(send),
    repeated: (_key, repeats) => {
      const send = repeats.events[0]
      if (send) recordDuplicateRefusal(send, { repeats: repeats.count, windowMs: repeats.windowMs })
    },
  })
  const expire = (now: number): void => {
    for (const [pair, last] of lastSends) {
      if (now - last.at < DUPLICATE_WINDOW_MS) break
      lastSends.delete(pair)
    }
  }
  return {
    async claim({ sender, to, exchange, address, text }) {
      const pair = `${sender}\0${to}`
      const textSha256 = new Bun.CryptoHasher("sha256").update(text).digest("hex")
      const key = `${exchange ?? ""}\0${address ?? ""}\0${textSha256}`
      for (;;) {
        expire(performance.now())
        const last = lastSends.get(pair)
        if (last?.key !== key) break
        // A copy sent in the same batch waits for the first copy, because
        // only a text that was sent makes a copy a duplicate. A first copy
        // that failed removes its entry, so the copy checks again.
        if (await last.accepted) {
          refusals.observe(`${pair}\0${key}`, { sender, to, textSha256 })
          return undefined
        }
      }
      // Nothing awaits between the last check and this claim, so two copies
      // cannot both pass.
      const { promise, resolve } = Promise.withResolvers<boolean>()
      const entry: LastSend = { key, at: performance.now(), accepted: promise }
      lastSends.delete(pair)
      lastSends.set(pair, entry)
      return (accepted) => {
        if (!accepted && lastSends.get(pair) === entry) lastSends.delete(pair)
        resolve(accepted)
      }
    },
  }
}

interface DuplicateSend {
  readonly sender: string
  readonly to: string
  readonly textSha256: string
}

/** One record of a duplicate refusal: the ids and the hash of the text, never
 *  the text. */
function recordDuplicateRefusal(send: DuplicateSend, repeats?: { readonly repeats: number; readonly windowMs: number }): void {
  DebugLog.record({ type: "session.message.duplicate_refused", sessionId: send.sender, payload: { to: send.to, textSha256: send.textSha256, ...repeats } })
}

/** What one run of a session tells the waits on it. */
interface SessionRunWaits {
  /** The turn no longer parks on its previous dependency snapshot. */
  resumed(): void
  /** The turn ended or parked, so each wait on the session whose message it
   *  read ends with its last words, unless the agent asked to wait on work
   *  that can wake it without the waiter (`observeSessionYield`). */
  yielded(input: SessionYield): Promise<void>
  /** Something can have stopped the session from reading, such as the end
   *  of its run; each wait on it that can no longer be answered ends. An
   *  interrupt also reports here, and it ends no wait. */
  changed(): Promise<void>
}

/** Whether `recipient` is a child that `senderSessionId` started. */
function isOwnChild(recipient: ReplayedSession | null, senderSessionId: string): boolean {
  return recipient !== null && parentSessionIdOf(recipient) === senderSessionId
}

export function createSessionMessaging(deps: SessionInputDeliveryDeps, children: ChildSessionControl): SessionMessaging {
  const waitDeps: ReplyWaitDeps = {
    projectionReader: deps.projectionReader,
    eventWriter: deps.eventWriter,
    addresseeState: (sessionId) => addresseeState(deps, sessionId),
    lineage: (sessionId) => lineageOf(deps, sessionId),
  }
  const nameOf = (sessionId: string): Promise<string> => sessionNameOf(deps.manager.read, sessionId)
  const sent = sentTexts()

  /** Opens a wait with no text: it sends nothing, so it opens only where a
   *  message would carry a wait (`admitsWait`) and the end rules let it hold
   *  (`OpeningWait.accepted`), and it is refused where the addressee already
   *  waits on the sender for a reply. */
  async function waitWithoutText(sender: SendingCall, to: string, tasks: ReplyWaitTasks, recipient: ReplayedSession | null, addressed: Addressed): Promise<MessageSessionResult> {
    const outcome = messageDisposition({ state: await readRecipientState(deps, to, recipient), origin: "session", hop: 0, self: to === sender.sessionId })
    if (outcome.status === "refused") return { ...outcome, ...addressed }
    if (!admitsWait(outcome)) return { ...outcome, ...addressed, waiting: false }
    if (waitsReach(deps.projectionReader, to, sender.sessionId)) return { status: "refused", reason: "waits_on_you", ...addressed }
    const opened = await openReplyWait(waitDeps, { waiter: { sessionId: sender.sessionId, tasks }, addressee: { sessionId: to, name: addressed.name ?? to }, toolUseId: sender.toolUseId })
    const waiting = await opened.accepted()
    return outcome.status === "held" ? { ...outcome, ...addressed, waiting } : { status: "delivered", ...addressed, waiting }
  }

  /** A parent's message that its own interrupted child holds hands the
   *  child back when the parent may continue the child's latest cut: the
   *  child resumes and reads the message first. A workflow's runner hands
   *  its agent back as it delivers, so only a child that holds the message
   *  needs this. Behind a person's cut the message stays held. */
  async function handBackChild(senderSessionId: string, childSessionId: string, outcome: DeliveryOutcome, handBack: boolean | undefined, targets: readonly string[] | undefined): Promise<DeliveryOutcome> {
    if (outcome.status !== "held" || outcome.reason !== "interrupted" || !handBack) return outcome
    const resumed = await children.resume(senderSessionId, childSessionId, targets)
    return resumed.ok ? { status: "delivered", startsTurn: true } : outcome
  }

  /** The address of a message with `targets`: only to a workflow, and
   *  only from its parent. */
  async function addressOf(senderSessionId: string, to: string, targets: readonly string[]) {
    const run = await workflowRunReader(deps.projectionReader).read(to)
    if (run?.launchedFrom.parentSessionId !== senderSessionId) return { ok: false as const, refusal: "only the launching parent of a workflow addresses its items and agents. Send the message without targets." }
    return await resolveWorkflowDeliveryAddress(deps.projectionReader, to, targets)
  }

  return {
    children,

    async send({ sender, target, to, text, exchange, wait, handBack, personWords, targets }) {
      if (target === "workflow" && wait) return { status: "refused", reason: "workflow_wait", to }
      if (target === "session" && targets !== undefined) return { status: "refused", reason: "address", detail: "An agent-session target takes no targets. Select a workflow target for direction.", to }
      if (target === "workflow") {
        const run = await workflowRunReader(deps.projectionReader).read(to)
        const addressed: Addressed = { to, ...(run ? { name: run.label } : {}) }
        const state = await readWorkflowRecipientState(deps, to)
        const refused = messageDisposition({ state, origin: "session", hop: sender.hop, self: false })
        if (refused.status === "refused") return { ...refused, ...addressed }
        if (text === undefined) throw new Error("Workflow direction requires text")
        const address = targets === undefined ? undefined : await addressOf(sender.sessionId, to, targets)
        if (address && !address.ok) return { status: "refused", reason: "address", detail: address.refusal, ...addressed }
        const settle = await sent.claim({ sender: sender.sessionId, to: `workflow:${to}`, exchange, address: address?.address.addressedTo.map(addressKey).join(","), text })
        if (!settle) return { status: "refused", reason: "duplicate", ...addressed }
        let accepted = false
        try {
          const from = await deps.manager.read(sender.sessionId)
          const words = run ? personWords(run) : undefined
          const producer: SessionInputProducer = { kind: "session", ...sender, envelope: {
            name: from ? sessionDisplayName({ id: sender.sessionId, session: from }) : sender.sessionId,
            relation: run?.launchedFrom.parentSessionId === sender.sessionId ? "parent" : "other", waits: false,
            ...(words ? { personWords: words } : {}),
          } }
          const outcome = await deliverWorkflowInput(deps, to, { text, producer }, address?.address)
          accepted = outcome.status !== "refused"
          return outcome.status === "refused" ? { ...outcome, ...addressed } : { ...outcome, ...addressed, waiting: false }
        } finally { settle(accepted) }
      }
      const [from, recipient] = await Promise.all([deps.manager.read(sender.sessionId), deps.manager.read(to)])
      const addressed: Addressed = { to, ...(recipient ? { name: sessionDisplayName({ id: to, session: recipient }) } : {}) }
      // The whole call is refused before anything is delivered, so the sender
      // sends again without the wait instead of holding a delivered message
      // whose wait it cannot have.
      if (wait && recipient && to !== sender.sessionId && !(from && waitsAllowed({ id: sender.sessionId, session: from }, { id: to, session: recipient }))) {
        return { status: "refused", reason: "not_parent_or_child", ...addressed }
      }
      if (text === undefined) {
        if (!wait) throw new Error("message_session sends text, opens a wait, or both")
        return await waitWithoutText(sender, to, wait, recipient, addressed)
      }
      const settle = await sent.claim({ sender: sender.sessionId, to: `session:${to}`, exchange, address: undefined, text })
      if (!settle) return { status: "refused", reason: "duplicate", ...addressed }
      // Every path settles the claim, also a throw, so a copy that waits on
      // this send never waits forever.
      let accepted = false
      try {
        const words = recipient ? personWords(recipient) : undefined
        const producer: SessionInputProducer = {
          kind: "session",
          ...sender,
          envelope: {
            name: from ? sessionDisplayName({ id: sender.sessionId, session: from }) : sender.sessionId,
            relation: from && recipient ? sessionRelation({ id: sender.sessionId, session: from }, { id: to, session: recipient }) : "other",
            waits: wait !== undefined,
            ...(words ? { personWords: words } : {}),
          },
        }
        // The wait opens before the delivery, so a reply that the recipient
        // sends at once finds it and ends it. A message that cannot carry a
        // wait takes its wait back.
        const opened = wait && recipient
          ? await openReplyWait(waitDeps, { waiter: { sessionId: sender.sessionId, tasks: wait }, addressee: { sessionId: to, name: addressed.name ?? to }, toolUseId: sender.toolUseId, readKey: queuedUserInputKey(producer, undefined) })
          : undefined
        const delivered = await deliverSessionInput(deps, to, { text, producer }).catch((error: unknown) => {
          opened?.withdraw()
          throw error
        })
        const outcome = isOwnChild(recipient, sender.sessionId) ? await handBackChild(sender.sessionId, to, delivered, handBack, targets) : delivered
        accepted = outcome.status !== "refused"
        const waiting = opened !== undefined && admitsWait(outcome) && await opened.accepted()
        if (!waiting) opened?.withdraw()
        switch (outcome.status) {
          case "refused": return { ...outcome, ...addressed }
          case "held": return { ...outcome, ...addressed, waiting }
          case "delivered": return { status: "delivered", ...addressed, waiting }
        }
      } finally {
        settle(accepted)
      }
    },

    async observeRun({ sessionId, tasks }) {
      if (tasks) await restoreReplyWaits(waitDeps, { sessionId, tasks }, nameOf)
      return {
        resumed: () => observeSessionResumed(deps.projectionReader, sessionId),
        yielded: (input) => observeSessionYield(deps.projectionReader, { sessionId, ...(tasks ? { tasks } : {}) }, input),
        changed: () => { observeSessionResumed(deps.projectionReader, sessionId); return observeSessionChanged(deps.projectionReader, sessionId) },
      }
    },

    async identity(sessionId) {
      const session = await deps.manager.read(sessionId)
      if (!session || session.kind === "workflow") return undefined
      const parentId = parentSessionIdOf(session)
      const parent = parentId ? await deps.manager.read(parentId) : null
      return {
        sessionId,
        rootSessionId: await treeRootSessionIdOf(deps.manager, sessionId),
        conversationId: session.conversationId,
        kind: session.kind,
        ...(session.kind === "workflow-agent" ? { workflowMembership: session.workflowMembership } : {}),
        ...(session.kind === "workflow-agent" && session.importedResources ? { importedResources: session.importedResources } : {}),
        ...(parentId ? { parent: { sessionId: parentId, name: parent ? sessionDisplayName({ id: parentId, session: parent }) : parentId } } : {}),
      }
    },

    async list(callerSessionId) {
      const caller = await deps.manager.read(callerSessionId)
      if (!caller) return []
      const parentId = parentSessionIdOf(caller)
      const parent = parentId ? await deps.manager.read(parentId) : null
      const ids = new Set<string>([
        ...(parentId ? [parentId] : []),
        ...(parent?.childSessionIds ?? []),
        // The live registry is keyed by this project's reader, so it never
        // names a session of another project.
        ...liveSessionControls(deps.projectionReader).map((control) => control.sessionId),
      ])
      ids.delete(callerSessionId)
      const rows = await Promise.all([...ids].map(async (id): Promise<SessionListing | undefined> => {
        const session = id === parentId ? parent : await deps.manager.read(id)
        if (!session) return undefined
        const subject = { id, session }
        const relation = sessionRelation(subject, { id: callerSessionId, session: caller })
        // The caller's own children are work it started: `process` lists them.
        if (relation === "child") return undefined
        const state = listState(await readRecipientState(deps, id, session))
        return state ? { id, target: "session", kind: session.kind, relation, name: sessionDisplayName(subject), state, ...(session.kind === "workflow-agent" ? { workflowMembership: session.workflowMembership } : {}) } : undefined
      }))
      const runs = await workflowRunReader(deps.projectionReader).list()
      const live = new Set(liveWorkflowControls(deps.projectionReader).map(({ workflowId }) => workflowId))
      const visible = runs.filter(({ workflowId, run }) => run.launchedFrom.parentSessionId !== callerSessionId
        && (live.has(workflowId) || run.launchedFrom.parentSessionId === parentId))
      const states = await readWorkflowRecipientStates(deps, visible)
      const workflows = states.map(({ workflowId, run, state: recipientState }): SessionListing | undefined => {
        const state = listState(recipientState)
        return state ? { id: workflowId, target: "workflow", kind: "workflow", relation: "other", owningChat: run.launchedFrom.parentSessionId, name: run.label, state } : undefined
      })
      return [...rows.filter((row) => row !== undefined), ...workflows.filter((row) => row !== undefined)]
    },
  }
}
