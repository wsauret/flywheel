import type { ChatInput, ChatInputLike } from "../../infra/chat-input.js"
import type { AttachedRuntimeClient, FrontendOutputBlock } from "../app-service-types.js"
import { lostWithLane } from "./connection-failures.js"
import type { TranscriptChange } from "./transcript-store.js"
import { returnedInputSubmissionId } from "../composer-returns.js"

/** Where one message is on its way to the runtime. `waiting` is a message
 *  whose connection ended before the runtime answered, or that the person
 *  sent while the connection was down. It goes out again by itself, with
 *  the same identity, when the next connection opens, and the runtime
 *  records it once (ARCH-SESSIONS-030). A client shows it queued, as it shows
 *  `sending`. `accepted` keeps the session's block count this client knew
 *  when the runtime took it, which a later window compares with its first
 *  block; undefined when the client knew no count. A `failed` message is one
 *  the runtime refused, with its words. An `unconfirmed` message is one
 *  whose answer a fault other than the connection's end lost: it may have
 *  arrived, and this client cannot say. Both stay until the person recalls
 *  them for editing. */
type ChatSubmissionDelivery =
  | { readonly kind: "sending" }
  | { readonly kind: "waiting" }
  | { readonly kind: "accepted"; readonly position: number | undefined }
  | { readonly kind: "failed"; readonly error: string }
  | { readonly kind: "unconfirmed" }

/** What a send answers when an unknown fault lost its answer, in place of
 *  the transport's own words, which name no cause a person can act on. */
const UNCONFIRMED_SEND = "Flywheel did not confirm that the message arrived. Edit it to send it again."

/** What a command with no words of its own answers when its connection
 *  ended first. It shows no entry, so nothing sends it again. */
export const UNCONFIRMED_COMMAND = "Flywheel did not confirm that the command arrived. Run it again if it does not start."

/** What Up says about a message on its way: one still being sent, or one
 *  that waits for the connection. Until the runtime answers, the message
 *  may already be recorded, so it cannot come back for editing, and Up
 *  says so instead of reaching the runtime's queued recall or history. A
 *  client shows both as queued and offers no Edit control for either. */
export const WAITING_RECALL = "Flywheel is still sending this message, so you cannot edit it now. If the connection is down, Flywheel sends it when the connection returns."

function undelivered(delivery: ChatSubmissionDelivery): boolean {
  return delivery.kind === "failed" || delivery.kind === "unconfirmed"
}

/** Whether a message is on its way: sent with no answer yet, or waiting to
 *  be sent again. */
function onItsWay(delivery: ChatSubmissionDelivery): boolean {
  return delivery.kind === "sending" || delivery.kind === "waiting"
}

/** What every client says beside a message that is not delivered: the
 *  runtime's refusal, or that the message is not confirmed. Each client adds
 *  its own way to edit the message. Undefined while it is on its way. */
export function undeliveredNotice(delivery: ChatSubmissionDelivery): string | undefined {
  if (delivery.kind === "failed") return `Not delivered: ${delivery.error}`
  return delivery.kind === "unconfirmed" ? "Not confirmed" : undefined
}

/** One message a person sent that the runtime has not yet shown back. A client
 *  renders it as a queued user message, marked as not delivered when its
 *  delivery failed. */
export interface LocalChatSubmission {
  readonly id: string
  readonly input: ChatInput
  readonly timestamp: number
  readonly delivery: ChatSubmissionDelivery
}

/** The runtime's answer to one `session.send`. `confirmedSubmissionIds` is
 *  its receipt for a message it already shows, or holds from an earlier
 *  copy. `inTranscript` says that a session transcript shows those
 *  messages or their returned notices, now or when its reader takes them. */
export type ChatSubmissionResult = { readonly ok: true; readonly confirmedSubmissionIds?: readonly string[]; readonly inTranscript?: boolean } | { readonly ok: false; readonly error: string; readonly kind?: "stale" | "handing_off" }

/** What one send means for the person. A waiting message stays queued until
 * connection returns. With `draft_kept`, the caller keeps its draft and shows
 * the warning without a failed-delivery row. */
type ChatSendOutcome =
  | { readonly kind: "sent" }
  | { readonly kind: "waiting" }
  | { readonly kind: "failed"; readonly error: string }
  | { readonly kind: "draft_kept"; readonly error: string }

/** What Up or a message's Edit control finds among a session's own entries:
 *  a message that did not go through, back for editing with no identity, so
 *  that its resubmission gets a new one; or a message on its way, which
 *  stays, with the words that say why. */
export type LocalRecall =
  | { readonly kind: "input"; readonly input: ChatInput }
  | { readonly kind: "waiting"; readonly notice: string }

/** A message the runtime has not answered, as a client hands it to the
 *  client that replaces it: a reloaded page or a restarted terminal shows it
 *  queued again and sends it on its first connection. This is the shape
 *  each client stores as it is, so the input keeps only what a person
 *  typed and the identity it goes out under. */
export interface UnsentChatSubmission {
  readonly sessionId: string
  readonly id: string
  readonly input: Pick<ChatInput, "text" | "attachments" | "invocation"> & { readonly submissionIds: readonly string[] }
  readonly timestamp: number
}

/** The client state a submission was sent and settled in, for diagnostics. */
export interface ChatSubmissionContext {
  readonly health: string
  readonly foregroundId: string | undefined
}

/** One metadata-only account of a failed, slow, or unfinished submission. It
 *  never carries the message text, the attachment bytes, or the error words. */
interface ChatSubmissionFeedback {
  readonly sessionId: string
  readonly payload: {
    readonly submissionId: string
    readonly outcome: "adopted" | "withdrawn" | "failed" | "incomplete"
    readonly failed: boolean
    readonly slow: boolean
    readonly durationMs: number
    readonly dispatchMs: number | null
    readonly adoptedMs: number | null
    readonly withdrawnMs: number | null
    readonly firstFrameMs: number | null
    readonly maxFrameGapMs: number
    readonly resends: number
    readonly textBytes: number
    readonly attachmentCount: number
    readonly submittedContext: ChatSubmissionContext | null
    readonly settledContext: ChatSubmissionContext | null
  }
}

/** The resident transcript window a client holds after a change: the
 *  absolute index of its first block, or null while nothing is resident. */
export interface ChatSubmissionWindow {
  readonly startBlockIndex: number | null
}

export interface ChatSubmissionsDeps {
  /** A message's first send, through the client's own admission. */
  readonly dispatch: (sessionId: string, input: ChatInput) => Promise<ChatSubmissionResult>
  /** Sends a waiting message again straight to the runtime, with no
   *  client-side admission: its first send passed that admission, and a
   *  refusal now could fail a message the runtime already recorded. Without
   *  it, `dispatch` sends it again. */
  readonly resend?: (sessionId: string, input: ChatInput) => Promise<ChatSubmissionResult>
  /** Each new lane sends the waiting messages again. */
  readonly lanes: Pick<AttachedRuntimeClient, "onLane">
  /** The messages a predecessor client handed over unanswered. They show
   *  queued at once and go out on the first lane. */
  readonly unsent?: readonly UnsentChatSubmission[]
  readonly now?: () => number
  /** The session's block count as this client knows it now, or undefined
   *  when it reads no transcript of that session. */
  readonly position?: (sessionId: string) => number | undefined
  readonly context?: () => ChatSubmissionContext
  /** Receives one account per abnormal submission. Without it, no timing is kept. */
  readonly feedback?: (feedback: ChatSubmissionFeedback) => void
}

export interface ChatSubmissions {
  /** True while this window owns an input that is not consumed, recalled, or returned. */
  ownsSubmission(id: string): boolean
  /** Retires sender ownership after its composer-return claim settles. */
  settleReturned(submissionIds: readonly string[]): void
  /** Shows the input as a local entry at once, then dispatches it, or, while
   *  earlier messages to the session wait for the connection, queues it
   *  behind them. A failure stays on the entry, unless its awaited receipt
   *  says `draft_kept`. An invocation with no visible words gets no entry. */
  send(sessionId: string, input: ChatInput): Promise<ChatSendOutcome>
  /** Moves every entry of `from` to the end of `to`. A client that shows
   *  messages for a destination with no session yet, such as a new chat the
   *  runtime still creates, moves them to the session once it exists. */
  move(from: string, to: string): void
  /** Retires entries across owners whose identities these runtime blocks carry,
   *  and entries in `sessionId` that `window` proves the runtime showed before it: the runtime took
   *  them, and the window starts past the block count known then. A client
   *  that comes back to a session reads only its tail, so without this rule a
   *  message the runtime took while the person was away stays queued for good. */
  observe(sessionId: string, blocks: readonly FrontendOutputBlock[], window: ChatSubmissionWindow): void
  /** Called once per client frame while feedback is kept. Idle frames do no work. */
  frame(): void
  /** Reports unfinished submissions once and releases listeners. */
  dispose(): void
  /** Up and the Edit control, for every client. Takes the entry `entryId`
   *  names, or else the newest entry the runtime refused or did not confirm,
   *  out of the transcript and answers its input. When the named entry, or
   *  with none named any entry, is on its way, answers why it stays. Null
   *  when neither applies, and the client then asks the runtime's queued
   *  recall. */
  recallLocal(sessionId: string, entryId?: string): LocalRecall | null
  /** Runs the runtime's recall and retires the entries it withdrew. */
  recallQueued(sessionId: string, query: () => Promise<ChatInputLike | null>): Promise<ChatInputLike | null>
  /** The session's entries, oldest first. The array is replaced on every
   *  change and never mutated, so a client can compare it by identity. */
  pending(sessionId: string | undefined): readonly LocalChatSubmission[]
  /** Calls `listener` after every change to any session's entries. */
  subscribe(listener: () => void): () => void
  /** The messages on their way or waiting, oldest first in each session,
   *  for the client that replaces this one. */
  unsent(): readonly UnsentChatSubmission[]
}

interface SubmissionTiming {
  sessionId: string
  readonly startedAt: number
  readonly textBytes: number
  readonly attachmentCount: number
  readonly submittedContext: ChatSubmissionContext | undefined
  dispatchMs?: number
  adoptedMs?: number
  withdrawnMs?: number
  firstFrameMs?: number
  failed: boolean
  resends: number
  lastFrameAt: number
  maxFrameGapMs: number
}

const NONE: readonly LocalChatSubmission[] = Object.freeze([])
const SENDING: ChatSubmissionDelivery = Object.freeze({ kind: "sending" })
const WAITING: ChatSubmissionDelivery = Object.freeze({ kind: "waiting" })
const SENT: ChatSendOutcome = Object.freeze({ kind: "sent" })
const WAITS: ChatSendOutcome = Object.freeze({ kind: "waiting" })
const NONE_BLOCKS: readonly FrontendOutputBlock[] = Object.freeze([])
const SLOW_MS = 1_000

/** The blocks one transcript change delivered. A pure text append only grew a
 *  block that an earlier change already delivered. */
export function adoptedBlocks(change: TranscriptChange): readonly FrontendOutputBlock[] {
  if (change.kind === "window") return change.adopted
  if (change.kind !== "deltas") return NONE_BLOCKS
  return change.replaced.filter((replacement) => replacement.appendedText.length === 0).map((replacement) => replacement.next)
}

/** Owns unconfirmed client input for every client. Adopted runtime output
 *  confirms delivery to this transcript; a receipt confirms delivery to a
 *  workflow's agent views, since a workflow has no transcript. Matching uses submission identities, never
 *  equal text. Frame timing describes client frames, not whether a row is
 *  inside the viewport.
 *
 *  It is also the outbox of messages lost with the connection. A message
 *  whose lane ended waits, and each new lane sends the waiting messages of
 *  each session again, one at a time, in the order the person sent them. The
 *  runtime keys a person's message by its submission identity, so a message
 *  it recorded before the lane ended answers a receipt and is not recorded
 *  twice (ARCH-SESSIONS-030). */
export function createChatSubmissions(deps: ChatSubmissionsDeps): ChatSubmissions {
  const sessions = new Map<string, readonly LocalChatSubmission[]>()
  // Queued output replaces the optimistic row before the model consumes it.
  const sent = new Set<string>()
  const listeners = new Set<() => void>()
  const timings = new Map<string, SubmissionTiming>()
  const now = deps.now ?? (() => performance.now())
  const encoder = new TextEncoder()
  const resend = deps.resend ?? deps.dispatch
  /** Entries a send already went out for, which go out again without
   *  client-side admission. An entry leaves it when it leaves the client. */
  const attempted = new Set<string>()
  /** Sessions whose waiting entries go out now, one at a time. */
  const flushing = new Set<string>()
  let lane = 0

  for (const handed of deps.unsent ?? []) {
    sent.add(handed.id)
    attempted.add(handed.id)
    sessions.set(handed.sessionId, [...(sessions.get(handed.sessionId) ?? NONE), { id: handed.id, input: handed.input, timestamp: handed.timestamp, delivery: WAITING }])
  }

  function write(sessionId: string, entries: readonly LocalChatSubmission[]): void {
    if (entries.length > 0) sessions.set(sessionId, entries)
    else sessions.delete(sessionId)
    for (const listener of listeners) listener()
  }

  function remove(sessionId: string, ids: ReadonlySet<string>): void {
    const entries = sessions.get(sessionId)
    if (!entries?.some((entry) => ids.has(entry.id))) return
    for (const entry of entries) if (ids.has(entry.id)) attempted.delete(entry.id)
    write(sessionId, entries.filter((entry) => !ids.has(entry.id)))
  }

  function report(id: string, timing: SubmissionTiming, incomplete = false): void {
    timings.delete(id)
    const failed = timing.failed || incomplete
    const slow = Math.max(timing.dispatchMs ?? 0, timing.adoptedMs ?? 0, timing.firstFrameMs ?? 0, timing.maxFrameGapMs) >= SLOW_MS
    if (!failed && !slow && timing.resends === 0) return
    deps.feedback?.({
      sessionId: timing.sessionId,
      payload: {
        submissionId: id,
        outcome: incomplete ? "incomplete" : timing.adoptedMs !== undefined ? "adopted" : timing.withdrawnMs !== undefined ? "withdrawn" : "failed",
        failed, slow,
        durationMs: now() - timing.startedAt,
        dispatchMs: timing.dispatchMs ?? null,
        adoptedMs: timing.adoptedMs ?? null,
        withdrawnMs: timing.withdrawnMs ?? null,
        firstFrameMs: timing.firstFrameMs ?? null,
        maxFrameGapMs: timing.maxFrameGapMs,
        resends: timing.resends,
        textBytes: timing.textBytes,
        attachmentCount: timing.attachmentCount,
        submittedContext: timing.submittedContext ?? null,
        settledContext: deps.context?.() ?? null,
      },
    })
  }

  /** The entry `id` names and the session it is in now. */
  function find(id: string): { readonly owner: string; readonly entry: LocalChatSubmission } | undefined {
    for (const [owner, entries] of sessions) {
      const entry = entries.find((candidate) => candidate.id === id)
      if (entry !== undefined) return { owner, entry }
    }
    return undefined
  }

  /** Records the delivery of entry `id` wherever it now is. An entry that
   *  adoption or a recall already retired stays retired, and a moved entry
   *  settles where it now is. */
  function deliver(id: string, delivery: (owner: string) => ChatSubmissionDelivery): void {
    const found = find(id)
    if (found === undefined) return
    const entries = sessions.get(found.owner) ?? NONE
    write(found.owner, entries.map((candidate) => (candidate === found.entry ? { ...found.entry, delivery: delivery(found.owner) } : candidate)))
  }

  /** Marks each tracked identity of `sessionId` with `field` once. */
  function settle(sessionId: string, ids: Iterable<string>, field: "adoptedMs" | "withdrawnMs"): void {
    const at = now()
    for (const id of ids) {
      const timing = timings.get(id)
      if (timing?.sessionId === sessionId) timing[field] ??= at - timing.startedAt
    }
  }

  function confirm(ids: ReadonlySet<string>): void {
    for (const owner of sessions.keys()) {
      settle(owner, ids, "adoptedMs")
      remove(owner, ids)
    }
  }

  /** Whether a new message to `sessionId` must wait behind earlier ones that
   *  wait for the connection, so that the session receives them in order. */
  function behindWaiting(sessionId: string): boolean {
    return flushing.has(sessionId) || (sessions.get(sessionId)?.some((entry) => entry.delivery.kind === "waiting") ?? false)
  }

  /** Sends entry `id` once and records what its send answered. A send whose
   *  lane ended leaves the entry waiting. When a newer lane opened while the
   *  send ran, no lane is left to send it again, so it goes out at once. */
  async function sendEntry(id: string, sessionId: string, input: ChatInput, sentAt: number | undefined, draftHeld: boolean): Promise<ChatSendOutcome> {
    const timing = timings.get(id)
    if (attempted.has(id) && timing) timing.resends += 1
    const via = attempted.has(id) ? resend : deps.dispatch
    attempted.add(id)
    const sentOnLane = lane
    let result: ChatSubmissionResult
    try {
      result = await via(sessionId, input)
    } catch (error) {
      if (timing) timing.dispatchMs ??= now() - timing.startedAt
      if (lostWithLane(error)) {
        deliver(id, () => WAITING)
        const at = find(id)
        if (at !== undefined && lane !== sentOnLane) flush(at.owner)
        return WAITS
      }
      if (timing) timing.failed = true
      deliver(id, () => ({ kind: "unconfirmed" }))
      return { kind: "failed", error: UNCONFIRMED_SEND }
    }
    if (timing) {
      timing.dispatchMs ??= now() - timing.startedAt
      timing.failed = !result.ok && !(result.kind === "handing_off" && draftHeld)
    }
    // A queued replay has no awaiting composer receipt. Its local entry is
    // the only editable copy, so a replay refusal must keep that entry.
    if (!result.ok && result.kind === "handing_off" && draftHeld) {
      const owner = find(id)?.owner
      sent.delete(id)
      if (owner !== undefined) {
        settle(owner, [id], "withdrawnMs")
        remove(owner, new Set([id]))
      }
      return { kind: "draft_kept", error: result.error }
    }
    // The runtime's own count places the message, never a clock: across
    // machines the client's clock and the runtime's disagree. A session
    // this client no longer reads keeps the count it knew at the send.
    deliver(id, result.ok ? (owner) => ({ kind: "accepted", position: deps.position?.(owner) ?? sentAt }) : () => ({ kind: "failed", error: result.error }))
    // A session with a transcript retires the entry when the transcript
    // shows the message, as for any accepted message: a child at rest shows
    // a message it holds only once it reads it, so the entry stays in view
    // until then. A workflow has no transcript, so its receipt retires it.
    if (result.ok && result.confirmedSubmissionIds && !result.inTranscript) {
      for (const confirmedId of result.confirmedSubmissionIds) sent.delete(confirmedId)
      confirm(new Set(result.confirmedSubmissionIds))
    }
    return result.ok ? SENT : { kind: "failed", error: result.error }
  }

  /** Sends the waiting entries of `sessionId` one at a time, oldest first,
   *  until none waits or a lane ends under one. Each send waits for the one
   *  before it to settle, so the runtime receives them in send order. */
  function flush(sessionId: string): void {
    if (flushing.has(sessionId)) return
    flushing.add(sessionId)
    void (async () => {
      try {
        for (;;) {
          const next = sessions.get(sessionId)?.find((entry) => entry.delivery.kind === "waiting")
          if (next === undefined) return
          deliver(next.id, () => SENDING)
          if (await sendEntry(next.id, sessionId, next.input, deps.position?.(sessionId), false) === WAITS) return
        }
      } finally {
        flushing.delete(sessionId)
      }
    })()
  }

  const stopLanes = deps.lanes.onLane((opened) => {
    lane = opened
    for (const [sessionId, entries] of sessions) if (entries.some((entry) => entry.delivery.kind === "waiting")) flush(sessionId)
  })

  return {
    ownsSubmission: (id) => sent.has(id),
    settleReturned(ids) { for (const id of ids) sent.delete(id) },
    async send(sessionId, input) {
      const id = crypto.randomUUID()
      const submitted: ChatInput = { ...input, submissionIds: [id] }
      if (input.invocation && !input.invocation.args) {
        // A divider shows no entry, so nothing sends it again: a lost lane
        // says that the command may not have arrived.
        try {
          const result = await deps.dispatch(sessionId, submitted)
          return result.ok ? SENT : { kind: "failed", error: result.error }
        } catch (error) {
          return { kind: "failed", error: lostWithLane(error) ? UNCONFIRMED_COMMAND : UNCONFIRMED_SEND }
        }
      }
      const sentAt = deps.position?.(sessionId)
      if (deps.feedback) {
        const startedAt = now()
        timings.set(id, {
          sessionId, startedAt, lastFrameAt: startedAt, maxFrameGapMs: 0, failed: false, resends: 0,
          textBytes: encoder.encode(input.text).byteLength, attachmentCount: input.attachments?.length ?? 0,
          submittedContext: deps.context?.(),
        })
      }
      const waits = behindWaiting(sessionId)
      sent.add(id)
      write(sessionId, [...(sessions.get(sessionId) ?? NONE), { id, input: submitted, timestamp: Date.now(), delivery: waits ? WAITING : SENDING }])
      // Waiting entries go out on the next lane, and a flush that runs now
      // takes this one after them.
      return waits ? WAITS : sendEntry(id, sessionId, submitted, sentAt, true)
    },
    move(from, to) {
      const moving = sessions.get(from)
      if (moving === undefined || from === to) return
      sessions.delete(from)
      for (const timing of timings.values()) if (timing.sessionId === from) timing.sessionId = to
      write(to, [...(sessions.get(to) ?? NONE), ...moving])
    },
    observe(sessionId, blocks, window) {
      const confirmed = new Set<string>()
      for (const block of blocks) {
        if (block.kind === "userMessage") for (const id of block.submissionIds ?? []) {
          confirmed.add(id)
          if (!block.pending) sent.delete(id)
        }
        const returned = block.kind === "system" ? returnedInputSubmissionId(block.id) : undefined
        if (returned !== undefined) confirmed.add(returned)
      }
      confirm(confirmed)
      const entries = sessions.get(sessionId)
      if (entries === undefined) return
      confirmed.clear()
      // The runtime writes an accepted message where it accepted it, so the
      // message lies before a window that starts past the count known then.
      const start = window.startBlockIndex
      if (start !== null) {
        for (const { id, delivery } of entries) if (delivery.kind === "accepted" && delivery.position !== undefined && start > delivery.position) confirmed.add(id)
      }
      if (confirmed.size === 0) return
      settle(sessionId, confirmed, "adoptedMs")
      remove(sessionId, confirmed)
    },
    frame() {
      if (timings.size === 0) return
      const at = now()
      for (const [id, timing] of timings) {
        timing.firstFrameMs ??= at - timing.startedAt
        timing.maxFrameGapMs = Math.max(timing.maxFrameGapMs, at - timing.lastFrameAt)
        timing.lastFrameAt = at
        if (timing.dispatchMs !== undefined && (timing.adoptedMs !== undefined || timing.withdrawnMs !== undefined || timing.failed)) report(id, timing)
      }
    },
    dispose() {
      stopLanes()
      sent.clear()
      for (const [id, timing] of timings) report(id, timing, true)
      listeners.clear()
    },
    recallLocal(sessionId, entryId) {
      const entries = sessions.get(sessionId) ?? NONE
      const named = entryId === undefined ? undefined : entries.find((candidate) => candidate.id === entryId)
      if (entryId !== undefined && named === undefined) return null
      const entry = named ?? entries.findLast((candidate) => undelivered(candidate.delivery))
      if (entry !== undefined && undelivered(entry.delivery)) {
        const { submissionIds: _ids, ...input } = entry.input
        settle(sessionId, [entry.id], "withdrawnMs")
        sent.delete(entry.id)
        remove(sessionId, new Set([entry.id]))
        return { kind: "input", input }
      }
      // A message still being sent is not yet known lost, and a waiting one
      // goes out again by itself. Either may already be recorded, so taking
      // it back could record it twice or lose the edit: it stays and says why.
      const onTheWay = named ?? entries.find((candidate) => onItsWay(candidate.delivery))
      return onTheWay !== undefined && onItsWay(onTheWay.delivery) ? { kind: "waiting", notice: WAITING_RECALL } : null
    },
    async recallQueued(sessionId, query) {
      const input = await query()
      // A successful runtime withdrawal can precede transcript adoption. Its
      // correlation retires the local entry even if recovery never sees that row.
      if (input && typeof input !== "string" && input.submissionIds?.length) {
        settle(sessionId, input.submissionIds, "withdrawnMs")
        for (const id of input.submissionIds) sent.delete(id)
        remove(sessionId, new Set(input.submissionIds))
      }
      return input
    },
    pending: (sessionId) => (sessionId === undefined ? undefined : sessions.get(sessionId)) ?? NONE,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    unsent() {
      return [...sessions].flatMap(([sessionId, entries]) => entries.flatMap(({ id, input, timestamp, delivery }) =>
        onItsWay(delivery)
          ? [{ sessionId, id, timestamp, input: {
            text: input.text,
            ...(input.attachments?.length ? { attachments: input.attachments } : {}),
            ...(input.invocation ? { invocation: input.invocation } : {}),
            submissionIds: input.submissionIds ?? [id],
          } }]
          : []))
    },
  }
}
