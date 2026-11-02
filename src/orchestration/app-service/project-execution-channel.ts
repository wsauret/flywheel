import { randomUUID } from "node:crypto"
import { Schema } from "effect"
import { pack, unpack } from "msgpackr"
import { errorMessage } from "../../infra/error-message.js"
import { trackLoopSpan } from "../../infra/event-loop-lag.js"
import type { InternalProcessEndpoint } from "../../infra/internal-process-channel.js"
import { Log } from "../../infra/log.js"
import { coalesceRepeats } from "../../infra/repeat-coalescer.js"
import type { ReattachableProcessEndpoint } from "../../infra/reattachable-process-endpoint.js"
import type {
  FrontendEvent,
  FrontendMutation,
  MutationResult,
  RuntimeClient,
  RuntimeQuery,
  RuntimeQueryResult,
} from "../../protocol/app-service-types.js"
import { RuntimeCallTimeout, runtimeCallPolicies } from "../../protocol/runtime-client-deadlines.js"
import { decodeRuntimeEventFrame } from "../../protocol/client/runtime-event-intake.js"
import {
  FrontendMutationSchema,
  RuntimeQuerySchema,
  runtimeQueryResultSchema,
} from "../../protocol/runtime-protocol-schemas.js"
import { runtimeDispatchResultSchema } from "../../protocol/runtime-dispatch-result-schemas.js"

const CorrelationIdSchema = Schema.String.check(Schema.isMinLength(1))
const Strict = { onExcessProperty: "error" } as const

const QueryEnvelopeSchema = Schema.Struct({
  kind: Schema.Literal("query"),
  id: CorrelationIdSchema,
  query: RuntimeQuerySchema,
}).pipe(Schema.annotate({ parseOptions: Strict }))
const DispatchEnvelopeSchema = Schema.Struct({
  kind: Schema.Literal("dispatch"),
  id: CorrelationIdSchema,
  mutation: FrontendMutationSchema,
}).pipe(Schema.annotate({ parseOptions: Strict }))
const ResultEnvelopeSchema = Schema.Struct({
  kind: Schema.Literal("result"),
  id: CorrelationIdSchema,
  result: Schema.Unknown,
}).pipe(Schema.annotate({ parseOptions: Strict }))
const ErrorEnvelopeSchema = Schema.Struct({
  kind: Schema.Literal("error"),
  id: CorrelationIdSchema,
  message: Schema.String,
}).pipe(Schema.annotate({ parseOptions: Strict }))
const RefusedEnvelopeSchema = Schema.Struct({
  kind: Schema.Literal("refused"),
  id: CorrelationIdSchema,
}).pipe(Schema.annotate({ parseOptions: Strict }))
// Each frame is the MessagePack encoding of one runtime event frame, in
// publication order. The executor encodes each event once, bounds its queue by
// those bytes, and sends the events queued together as one message whose
// frames the transport copies as they are; the account decodes each frame
// strictly.
const EventsEnvelopeSchema = Schema.Struct({
  kind: Schema.Literal("events"),
  frames: Schema.Array(Schema.Uint8Array),
}).pipe(Schema.annotate({ parseOptions: Strict }))
const GapEnvelopeSchema = Schema.Struct({ kind: Schema.Literal("gap") }).pipe(Schema.annotate({ parseOptions: Strict }))

// The account's whole union of watched sessions. It asks for no answer, and
// the executor applies it as it reads it, so every call the account sends
// after it is served under it.
const WatchEnvelopeSchema = Schema.Struct({
  kind: Schema.Literal("watch"),
  sessionIds: Schema.Array(Schema.String),
}).pipe(Schema.annotate({ parseOptions: Strict }))

// No client of the account shows the session any more, while its hold waits
// for a reattach (`ProjectExecutionClient.hideSession`). It is a call, so it
// keeps its place among the account's calls, and the executor takes it as it
// reads it.
const HideEnvelopeSchema = Schema.Struct({
  kind: Schema.Literal("hide"),
  id: CorrelationIdSchema,
  sessionId: Schema.String,
}).pipe(Schema.annotate({ parseOptions: Strict }))

const RequestEnvelopeSchema = Schema.Union([QueryEnvelopeSchema, DispatchEnvelopeSchema, WatchEnvelopeSchema, HideEnvelopeSchema])
const ResponseEnvelopeSchema = Schema.Union([ResultEnvelopeSchema, ErrorEnvelopeSchema, RefusedEnvelopeSchema, EventsEnvelopeSchema, GapEnvelopeSchema])
type RequestEnvelope = typeof RequestEnvelopeSchema.Type
type ResponseEnvelope = typeof ResponseEnvelopeSchema.Type

const decodeRequest = Schema.decodeUnknownSync(RequestEnvelopeSchema)
const decodeResponse = Schema.decodeUnknownSync(ResponseEnvelopeSchema)
const encodeQuery = Schema.encodeUnknownSync(QueryEnvelopeSchema)
const encodeDispatch = Schema.encodeUnknownSync(DispatchEnvelopeSchema)
const encodeResult = Schema.encodeUnknownSync(ResultEnvelopeSchema)
const encodeError = Schema.encodeUnknownSync(ErrorEnvelopeSchema)
const encodeRefused = Schema.encodeUnknownSync(RefusedEnvelopeSchema)
const encodeWatch = Schema.encodeUnknownSync(WatchEnvelopeSchema)
const encodeHide = Schema.encodeUnknownSync(HideEnvelopeSchema)

type ExecutionRuntime = Pick<RuntimeClient, "query" | "dispatch" | "subscribe"> & {
  /** Applies the account's union of watched sessions to the output gate. */
  watchOutput(sessionIds: readonly string[]): void
  /** See `ProjectExecutionClient.hideSession`. */
  hideSession(sessionId: string): Promise<void>
}

export const PROJECT_EXECUTION_MAX_OUTSTANDING_CALLS = 64
// The one bound on events waiting for the account to drain, in bytes. A burst
// is as large as the catalog: a background hydration publishes one row per
// session, and a gap here costs every attached client a full re-snapshot of
// every domain, so the queue holds a few thousand rows before it gives up.
const MAX_EVENT_BYTES = 8 * 1024 * 1024
// The packed bytes one events message carries, unless a single event is larger.
// A backlog goes as several messages, so no one write holds the whole queue.
const MAX_EVENT_BATCH_BYTES = 256 * 1024
const CAPACITY_ERROR = `project execution channel capacity exceeded (${PROJECT_EXECUTION_MAX_OUTSTANDING_CALLS} outstanding calls)`

/** A call was in flight when its transport detached, so its outcome is
 *  unknown. The endpoint holds new sends until a transport reattaches, so a
 *  caller whose call is idempotent can send it again and be answered by the
 *  reattached executor. */
export class ProjectExecutionChannelDetached extends Error {
  constructor(cause: Error) {
    super(`project execution channel detached: ${cause.message}`, { cause })
    this.name = "ProjectExecutionChannelDetached"
  }
}

/** The executor read this call while it stopped, and a stopping executor
 *  runs no call it has not admitted, so the call never ran. Its caller takes
 *  it again once that executor's generation has ended, as it takes a call
 *  sent after the end, unless the call only withdrew what that generation
 *  showed, which its end withdraws too. */
export class ProjectExecutionStopping extends Error {
  constructor() {
    super("project executor is stopping, so it did not run the call")
    this.name = "ProjectExecutionStopping"
  }
}
const REPAIR_RETRY_MS = 1_000
/** How long one repair failure collects the retries that fail the same way. */
const REPAIR_FAILURE_WINDOW_MS = 30_000
const log = Log.create({ service: "project-execution-channel" })

/** Private recovery subscription. The callback repairs account projections before acknowledging the gap. */
export interface ProjectExecutionClient extends RuntimeClient {
  onOutputGap(listener: () => Promise<void>): () => void
  /** States the whole union of watched sessions to the executor, ahead of
   *  every call sent after it. A detached channel sends nothing: its
   *  reattached transport states the current union first. */
  watchOutput(sessionIds: readonly string[]): void
  /** No client shows the session, while its runner stays for a reattach: its
   *  idle engines stop. The executor takes it before every call sent after
   *  it, and a later `session.activate` shows the session again. Resolves
   *  once the session's actor has taken it. */
  hideSession(sessionId: string): Promise<void>
}

/** Serves execution-owned runtime calls and output events without owning the
 *  runtime lifetime. `admits` says whether the executor takes new calls now;
 *  a call read while it does not, or once the drain has begun, never runs and
 *  is answered with a refusal, never left without an answer, so the account
 *  knows the call did not run and takes it again after this generation. */
export function serveProjectExecutionChannel(
  runtime: ExecutionRuntime,
  endpoint: InternalProcessEndpoint<unknown, unknown>,
  options: { readonly admits?: () => boolean } = {},
): (() => Promise<void>) & { drain(): Promise<void> } {
  const calls = new Set<Promise<void>>()
  const replies: Array<{ message: unknown; resolve: () => void }> = []
  const events: Uint8Array[] = []
  let eventBytes = 0
  let ready = 0
  // The wait for the end of the turn that queued the newest unready events.
  let turn: Promise<void> | undefined
  let pumping: Promise<void> | undefined
  let accepting = true
  let lost = false

  const send = (message: unknown): Promise<void> => {
    const completion = Promise.withResolvers<void>()
    replies.push({ message, resolve: completion.resolve })
    pump()
    return completion.promise
  }
  // A reply is eligible at once. An event is eligible only after the turn of
  // the event loop that queued it ends, so every event published in one turn
  // goes in one message whatever the pump is doing: the runtime UI bus hands
  // over each patch in its own microtask, so a pump that took events as they
  // arrived would send a burst a few patches at a time. `ready` counts the
  // eligible events at the head of the queue.
  function queueEvent(frame: Uint8Array): void {
    events.push(frame)
    eventBytes += frame.byteLength
    turn ??= new Promise<void>((resolve) => { setImmediate(resolve) }).then(() => {
      turn = undefined
      ready = events.length
      pump()
    })
  }
  // One pump sends one message at a time. A send waits under pressure and
  // fails only for a frame of its own. The channel outlives every such
  // failure: an unframeable reply answers its call with an error, an
  // unframeable event becomes a gap the account repairs from the store, and a
  // lost endpoint has already stopped admission.
  function pump(): void {
    if (pumping) return
    pumping = (async () => {
      while (replies.length || ready) {
        const reply = replies.shift()
        const message = reply ? reply.message : { kind: "events", frames: takeEvents() } satisfies ResponseEnvelope
        try {
          await endpoint.send(message)
        } catch (cause) {
          if (lost) { reply?.resolve(); continue }
          log.error("project execution channel send failed", { error: errorMessage(cause), kind: reply ? "reply" : "event" })
          if (reply) await answerUnsent(reply.message, cause)
          else markGap("send-failed")
        } finally {
          reply?.resolve()
        }
      }
    })().finally(() => {
      pumping = undefined
      if (replies.length || ready) pump()
    })
  }
  function takeEvents(): Uint8Array[] {
    let count = 0
    let bytes = 0
    for (const frame of events) {
      if (count === ready || (count > 0 && bytes + frame.byteLength > MAX_EVENT_BATCH_BYTES)) break
      count += 1
      bytes += frame.byteLength
    }
    eventBytes -= bytes
    ready -= count
    return events.splice(0, count)
  }
  async function answerUnsent(message: unknown, cause: unknown): Promise<void> {
    const id = typeof message === "object" && message !== null && "id" in message && typeof message.id === "string" ? message.id : undefined
    if (id === undefined) return
    try {
      await endpoint.send(encodeError({ kind: "error", id, message: `project execution reply could not be sent: ${errorMessage(cause)}` }))
    } catch (error) {
      if (!lost) log.error("project execution error reply failed", { error: errorMessage(error) })
    }
  }
  // A gap says only that the events queued before it were lost. Delivery goes
  // on at once: every later event is newer than the loss, so the account's one
  // repair converges however its snapshot reply and those events interleave.
  // Holding output until the account acknowledged a repair made continuous
  // output repeat the gap for as long as it ran. A gap costs every attached
  // client a full re-read, so each one says why it happened and how far behind
  // the account had fallen.
  function markGap(cause: "overflow" | "send-failed"): void {
    log.warn("project execution output gap", { cause, queuedEvents: events.length, queuedEventBytes: eventBytes, queuedReplies: replies.length })
    events.length = 0
    eventBytes = 0
    ready = 0
    void send({ kind: "gap" })
  }

  // Subscription precedes request admission so no output can be lost while the
  // executor starts accepting heavy calls.
  const unsubscribe = runtime.subscribe((event) => {
    if (event.type === "runtime.startup" || event.type === "runtime.health") return
    if (!accepting) return
    const frame = pack(event)
    if (eventBytes + frame.byteLength > MAX_EVENT_BYTES) {
      markGap("overflow")
      return
    }
    queueEvent(frame)
  })
  const stopMessages = endpoint.onMessage((value) => {
    let request: RequestEnvelope
    try {
      request = decodeRequest(value)
    } catch (error) {
      log.error("project execution request ignored: invalid envelope", { error: errorMessage(error) })
      return
    }
    if (request.kind === "watch") {
      runtime.watchOutput(request.sessionIds)
      return
    }
    if (!accepting || options.admits?.() === false) {
      void send(encodeRefused({ kind: "refused", id: request.id }))
      return
    }
    if (calls.size >= PROJECT_EXECUTION_MAX_OUTSTANDING_CALLS) {
      void send(encodeError({ kind: "error", id: request.id, message: CAPACITY_ERROR }))
      return
    }
    const call = serveCall(runtime, request, send)
    calls.add(call)
    void call.finally(() => calls.delete(call))
  })
  const stopClose = endpoint.onClose(() => {
    stopAdmission()
    stopMessages()
  })

  // Requests are still read after admission stops, until the endpoint
  // closes, so each one gets its refusal.
  function stopAdmission(): void {
    if (!accepting) return
    accepting = false
    lost = true
    unsubscribe()
  }

  let closing: Promise<void> | undefined
  const drain = async (): Promise<void> => {
    stopAdmission()
    await Promise.allSettled(calls)
    for (let active = turn ?? pumping; active; active = turn ?? pumping) await active
  }
  const close = () => {
    closing ??= (async () => {
      await drain()
      stopMessages()
      endpoint.close()
      stopClose()
      await endpoint.closed
    })()
    return closing
  }
  return Object.assign(close, { drain })
}

type CallEnvelope = Exclude<RequestEnvelope, { readonly kind: "watch" }>

// Each call reaches the runtime in the turn that read it, so the runtime takes
// a hide before a call that the account sent after it.
async function serveCall(runtime: ExecutionRuntime, request: CallEnvelope, send: (message: unknown) => Promise<void>): Promise<void> {
  const end = trackLoopSpan(`executor-${request.kind}`, request.kind === "query" ? request.query.type : request.kind === "dispatch" ? request.mutation.type : "session")
  try {
    const result = request.kind === "query"
      ? Schema.encodeUnknownSync(runtimeQueryResultSchema(request.query.type))(await runtime.query(request.query))
      : request.kind === "dispatch"
        ? Schema.encodeUnknownSync(runtimeDispatchResultSchema(request.mutation.type))(await runtime.dispatch(request.mutation))
        : await runtime.hideSession(request.sessionId).then(() => null)
    await send(encodeResult({ kind: "result", id: request.id, result }))
  } catch (cause) {
    await send(encodeError({
      kind: "error",
      id: request.id,
      message: errorMessage(cause),
    }))
  } finally {
    end()
  }
}

interface PendingCall {
  readonly resolve: (value: unknown) => void
  readonly reject: (reason: Error) => void
  readonly timer?: ReturnType<typeof setTimeout>
  settled: boolean
}

interface ProjectExecutionChannelClock {
  readonly setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  readonly clearTimeout: (timer: ReturnType<typeof setTimeout>) => void
}

const systemClock: ProjectExecutionChannelClock = {
  setTimeout,
  clearTimeout,
}

/** Connects a runtime proxy whose close operation owns only the transport endpoint. */
export function connectProjectExecutionChannel(
  endpoint: InternalProcessEndpoint<unknown, unknown> & Partial<Pick<ReattachableProcessEndpoint<unknown, unknown>, "onDetach" | "onReattach">>,
  options: {
    readonly clock?: ProjectExecutionChannelClock
    /** The account's current union of watched sessions, which a reattached
     *  transport states first: a statement made while it was detached, or in
     *  flight when it detached, may never have reached the executor. */
    readonly watchedOutput?: () => readonly string[]
  } = {},
): ProjectExecutionClient {
  const { clock = systemClock, watchedOutput } = options
  const pending = new Map<string, PendingCall>()
  const queued = new Map<string, { message: unknown; call: PendingCall }>()
  const listeners = new Set<(event: FrontendEvent) => void>()
  let closed = false
  let detached = false
  let gapPending = false
  let repairInFlight = false
  let repairTimer: ReturnType<typeof setTimeout> | undefined
  let repair: (() => Promise<void>) | undefined
  // An executor too busy to answer fails every retry the same way, once a
  // second. The first failure records; the rest count and report once, when a
  // repair succeeds, the window closes, or the channel closes.
  const repairFailures = coalesceRepeats<null>({
    windowMs: REPAIR_FAILURE_WINDOW_MS,
    first: (error) => { log.warn("project execution output repair failed; retrying", { error, retryMs: REPAIR_RETRY_MS }) },
    repeated: (error, repeats) => { log.warn("project execution output repair failed again", { error, count: repeats.count, windowMs: repeats.windowMs }) },
  })
  // A failed repair is retried, never escalated. The executor never waits on
  // a repair, so a repair answers to nothing but the gap it was asked for.
  function recover(): void {
    if (!gapPending || !repair || closed || detached || repairInFlight || repairTimer !== undefined) return
    gapPending = false
    repairInFlight = true
    const runRepair = repair
    void (async () => {
      try {
        await runRepair()
        repairFailures.end()
      } catch (error: unknown) {
        if (closed) return
        repairFailures.observe(errorMessage(error), null)
        gapPending = true
        repairTimer = clock.setTimeout(() => {
          repairTimer = undefined
          recover()
        }, REPAIR_RETRY_MS)
      } finally {
        repairInFlight = false
        recover()
      }
    })()
  }

  const lose = (reason: Error): void => {
    if (closed) return
    closed = true
    repairFailures.end()
    if (repairTimer !== undefined) clock.clearTimeout(repairTimer)
    for (const call of [...pending.values(), ...Array.from(queued.values(), entry => entry.call)]) {
      if (call.timer !== undefined) clock.clearTimeout(call.timer)
      if (!call.settled) call.reject(reason)
    }
    pending.clear()
    queued.clear()
  }

  endpoint.onClose(lose)
  // Calls in flight on a lost transport have an unknown outcome and fail
  // with that truth; the transport that replaces it starts from a gap, so
  // any output the dead socket held is repaired from the store.
  endpoint.onDetach?.((cause) => {
    detached = true
    const error = new ProjectExecutionChannelDetached(cause)
    for (const call of pending.values()) {
      if (call.timer !== undefined) clock.clearTimeout(call.timer)
      if (!call.settled) { call.settled = true; call.reject(error) }
    }
    pending.clear()
    gapPending = true
  })
  endpoint.onReattach?.(() => {
    detached = false
    if (watchedOutput !== undefined) sendWatch(watchedOutput())
    pumpRequests()
    recover()
  })
  endpoint.onMessage((value) => {
    let message: ResponseEnvelope
    try {
      message = decodeResponse(value)
    } catch (error) {
      log.error("project execution response ignored: invalid envelope", { error: errorMessage(error) })
      return
    }
    if (message.kind === "gap") {
      gapPending = true
      recover()
      return
    }
    if (message.kind === "events") {
      for (const frame of message.frames) deliverEvent(frame)
      return
    }
    const call = pending.get(message.id)
    if (call === undefined) {
      log.warn("project execution response ignored: unknown correlation", { id: message.id })
      return
    }
    pending.delete(message.id)
    pumpRequests()
    if (call.timer !== undefined) clock.clearTimeout(call.timer)
    if (call.settled) return
    call.settled = true
    if (message.kind === "error") {
      call.reject(new Error(message.message))
      return
    }
    if (message.kind === "refused") {
      call.reject(new ProjectExecutionStopping())
      return
    }
    try {
      call.resolve(message.result)
    } catch (cause) {
      call.reject(cause instanceof Error ? cause : new Error(String(cause)))
    }
  })

  function deliverEvent(frame: Uint8Array): void {
    let intake: ReturnType<typeof decodeRuntimeEventFrame>
    try {
      intake = decodeRuntimeEventFrame(unpack(frame))
    } catch (error) {
      log.error("project execution response ignored: invalid event frame", { error: errorMessage(error) })
      return
    }
    // The executor sends its app-service events only; a lane frame is the
    // client lane's own and means nothing on this channel.
    if (intake.kind === "frame" && intake.frame.type === "patch") {
      const event = intake.frame
      for (const listener of listeners) listener(event)
    }
  }

  function sendWatch(sessionIds: readonly string[]): void {
    void endpoint.send(encodeWatch({ kind: "watch", sessionIds })).catch((cause: unknown) => {
      log.warn("project execution output watch was not sent", { error: errorMessage(cause), sessions: sessionIds.length })
    })
  }

  function pumpRequests(): void {
    if (closed || detached) return
    while (pending.size < PROJECT_EXECUTION_MAX_OUTSTANDING_CALLS && queued.size > 0) {
      const next = queued.entries().next().value
      if (next === undefined) return
      const [id, { message, call }] = next
      queued.delete(id)
      pending.set(id, call)
      void endpoint.send(message).catch((cause) => {
        const sent = pending.get(id)
        if (sent === undefined) return
        pending.delete(id)
        if (sent.timer !== undefined) clock.clearTimeout(sent.timer)
        if (!sent.settled) {
          sent.settled = true
          sent.reject(cause instanceof Error ? cause : new Error(String(cause)))
        }
        pumpRequests()
      })
    }
  }

  function request<Result>(id: string, message: unknown, decode: (value: unknown) => Result, deadlineMs?: number): Promise<Result> {
    if (closed) return Promise.reject(new Error("project execution channel closed"))
    return new Promise((resolve, reject) => {
      const timer = deadlineMs === undefined
        ? undefined
        : clock.setTimeout(() => {
          const call = pending.get(id) ?? queued.get(id)?.call
          if (call === undefined || call.settled) return
          queued.delete(id)
          call.settled = true
          reject(RuntimeCallTimeout.forDeadline(deadlineMs))
        }, deadlineMs)
      queued.set(id, { message, call: { resolve: (value) => { resolve(decode(value)) }, reject, timer, settled: false } })
      pumpRequests()
    })
  }

  // The query discriminant selects its result codec, as the public connection does.
  function query<Q extends RuntimeQuery>(request: Q): Promise<RuntimeQueryResult<Q>>
  function query(runtimeQuery: RuntimeQuery) {
    const policy = runtimeCallPolicies[runtimeQuery.type]
    const id = randomUUID()
    return request(
      id,
      encodeQuery({ kind: "query", id, query: runtimeQuery }),
      Schema.decodeUnknownSync(runtimeQueryResultSchema(runtimeQuery.type)),
      policy._tag === "BestEffort" ? policy.deadlineMs : undefined,
    )
  }
  function dispatch<C extends FrontendMutation>(mutation: C): Promise<MutationResult<C>>
  function dispatch(mutation: FrontendMutation) {
    const id = randomUUID()
    return request(
      id,
      encodeDispatch({ kind: "dispatch", id, mutation }),
      Schema.decodeUnknownSync(runtimeDispatchResultSchema(mutation.type)),
    )
  }
  function hideSession(sessionId: string): Promise<void> {
    const id = randomUUID()
    return request(id, encodeHide({ kind: "hide", id, sessionId }), () => {})
  }

  return {
    onOutputGap(listener) {
      repair = listener
      recover()
      return () => { if (repair === listener) repair = undefined }
    },
    query,
    dispatch,
    hideSession,
    watchOutput(sessionIds) {
      if (!closed && !detached) sendWatch(sessionIds)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async close() {
      endpoint.close()
      await endpoint.closed
    },
  }
}
