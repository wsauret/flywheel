import { Cause, Effect, Exit, Layer, ManagedRuntime, Schema, Stream } from "effect"
import { RpcClient, RpcClientError, type RpcGroup } from "effect/rpc"
import { Socket } from "effect/socket"

import type {
  AttachedRuntimeClient,
  FrontendEvent,
  FrontendMutation,
  MutationResult,
  RuntimeProtocolRefusal,
  RuntimeTransportHealth,
  RuntimeQuery,
  RuntimeQueryResult,
} from "../app-service-types.js"
import type { RuntimeInvalidationReason } from "../runtime-ui-protocol-types.js"
import { RuntimeProtocolError, RuntimeProtocolRpc, runtimeQueryResultSchema } from "../runtime-protocol-schemas.js"
import { layerMsgPack } from "../rpc-msgpack.js"
import { stringRequestId } from "../rpc-request-id.js"
import { runtimeDispatchResultSchema } from "../runtime-dispatch-result-schemas.js"
import { RUNTIME_LIVENESS_POLICY, RUNTIME_PROTOCOL_VERSION, type RuntimeLivenessPolicy } from "../runtime-liveness.js"
import { applyRuntimeCallPolicy, RuntimeCallTimeout, runtimeCallPolicies, type RuntimeCallPolicy } from "../runtime-client-deadlines.js"
import { socketProtocolLayer } from "./socket-protocol.js"
import { laneSchedulerLayer, type LaneHost } from "./lane-scheduler.js"
import { decodeRuntimeEventFrame } from "./runtime-event-intake.js"
import type { LaneEndCause, RuntimeClientDiagnostic } from "../runtime-client-diagnostics.js"
import { LaneAttachTiming, laneBurst, laneCallOf, type LaneCall, type LaneWait } from "./lane-attach.js"
import type { ServeStartRefusal } from "../serve-handshake.js"
import { attachRefusal, foundNothingListening, isClientMismatch, LaneSilence, laneEndCause, lostToCleanClose, lostWithLane, protocolRefusal, RuntimeLaneLost, RuntimeSilent } from "./connection-failures.js"

/** A runtime client over any `Socket` transport.
 *
 *  The transport is handed in as a layer and never named here: the editor host
 *  supplies a Node socket to the account service, a webview supplies a
 *  `postMessage` bridge to that host, and a browser supplies a WebSocket to the
 *  relay. Every one of them gets the same call, cursor, and recovery semantics,
 *  which is what ARCH-PROTOCOL-004 means by a transport changing only framing and
 *  lifetime.
 *
 *  Three of its properties are load-bearing and none is obvious.
 *
 *  Silence is treated as failure. The runtime merges a heartbeat into every
 *  subscription for exactly this reason: without guaranteed traffic, a wedged
 *  event lane and an idle one are observationally identical, and the pane above
 *  it looks healthy while going stale. Past the deadline this fails the
 *  subscription and reconnects rather than trusting the quiet. That deadline
 *  is the lane's only clock: the RPC transport underneath carries no ping of
 *  its own (see `socket-protocol.ts`), so a slow answer to a request never
 *  counts as a dead socket.
 *
 *  A lost connection invalidates rather than resumes. When a lane breaks, the
 *  client publishes an invalidation that voids what every receiver holds, and
 *  each receiver reads its state again when the next lane opens. Local state
 *  never becomes the recovery authority, because what it holds is exactly
 *  what stopped being trustworthy.
 *
 *  A lane opens on a write, not on an answer. Each attach writes the event
 *  subscription first, and the lane opens once that write is on an open
 *  socket. The runtime serves every call written after the subscription only
 *  once the subscription is registered, so the reads a lane opens with go out
 *  beside the subscription with no round trip between them, and each one sees
 *  every change the lane does not carry. */

type ProtocolClient = RpcClient.RpcClient<
  RpcGroup.Rpcs<typeof RuntimeProtocolRpc>,
  RpcClientError.RpcClientError
>

const RECONNECT_BASE_MS = 250
const RECONNECT_MAX_MS = 30_000
export const MAX_RECONNECT_ATTEMPT = 16
/** How long recovery may keep failing before the connection reports a fault.
 *  A service restart and a cold project open both finish well inside it, so
 *  what a person sees of a drop that heals is nothing at all. Attach evidence
 *  decides the fault once the window ends, never the backoff (`armFault`). */
const FAULT_AFTER_MS = 10_000

/** Exponential backoff with jitter, so several clients recovering from one
 *  runtime restart do not arrive together. The runtime's relay control channel
 *  waits by the same rule, so a relay outage sees one retry shape from both
 *  sides. */
export function reconnectBackoffMs(attempt: number, random: () => number = Math.random): number {
  const grown = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS)
  return grown * (0.5 + random() * 0.5)
}

/** The round trip `resume` uses to prove a fresh-looking lane. The cheapest
 *  read the runtime serves: a synchronous in-memory view, answered on every
 *  placement. Its answer, not its content, is the evidence. */
const RESUME_PROBE: RuntimeQuery = { type: "commandUsageSnapshot" }

/** How long `resume` waits for the probe before it reattaches. A working lane
 *  answers in one round trip: 60 to 150 ms over the relay, and a phone's own
 *  link adds up to a few hundred. A half-open socket takes the probe and
 *  answers nothing, and a person who chose the placement waits this long. A
 *  wrong guess costs one reattach, under a second, so the deadline is far
 *  below the 5 s call deadline. */
const RESUME_PROBE_DEADLINE_MS = 1_000

/** The lane's lifecycle, for the code that drives it and its tests.
 *  Presentation reads `health`, never this: recovering is nothing a person
 *  sees, so no surface imports this shape. `connected` means the runtime
 *  answered on the lane; a lane is open from its subscription's write. */
type ConnectionState = "connecting" | "connected" | "recovering" | "closed"

type Unsubscribe = () => void

export interface RuntimeConnection extends AttachedRuntimeClient {
  /** Sends bounded diagnostics best-effort through the existing RPC. No retry queue is retained. */
  reportDiagnostic(diagnostic: RuntimeClientDiagnostic): void
  /** Resolve only after the current transport and protocol layer are ready. */
  ready(): Promise<void>
  /** A call made while the connection attaches waits for the lane and goes
   *  out after its subscription; it fails with the attach's own cause when
   *  that attach fails, or at its own deadline. */
  query<Q extends RuntimeQuery>(query: Q): Promise<RuntimeQueryResult<Q>>
  dispatch<C extends FrontendMutation>(mutation: C): Promise<MutationResult<C>>
  /** Live runtime events. Subscribing starts the event lane; the last
   *  subscriber leaving releases it. */
  subscribe(listener: (event: FrontendEvent) => void): Unsubscribe
  onStateChange(listener: (state: ConnectionState) => void): Unsubscribe
  readonly state: ConnectionState
  /** Whether the runtime answers this client; see `RuntimeTransportHealth`. Also
   *  published to subscribers as the transport-local `runtime.health` event. */
  readonly health: RuntimeTransportHealth
  onHealthChange(listener: (health: RuntimeTransportHealth) => void): Unsubscribe
  /** The attach failed with a cause the runtime itself reported, and with
   *  the refusal it named when the lane reset alone does not remedy its
   *  start. The fault shows at once with those words and stands until the
   *  runtime answers. */
  fault(cause: string, refusal?: ServeStartRefusal | RuntimeProtocolRefusal): void
  /** Drops the current attach and takes the next one immediately.
   *
   *  The runtime is shared with every other client on this project, so this
   *  cannot mean "restart the runtime": killing it would take down turns
   *  belonging to clients that never asked. What it fixes is this client: a
   *  lane that is wedged, or a backoff with 30 seconds left to run while the
   *  user is waiting. */
  reconnect(): void
  /** Makes sure the lane works, and keeps a lane that does. Two callers ask
   *  for this: the page that is in front of the person again after being
   *  suspended, and the person who chooses the placement already on screen
   *  (the host's `ensureConnected` command).
   *
   *  A lane that is not up reattaches at once instead of waiting out a
   *  backoff sized for a runtime outage. A lane that says connected is not
   *  taken at its word: a socket that died while the page was suspended
   *  delivers no close event, and its silence deadline may still be most of a
   *  minute away. One that has heard nothing for two heartbeats reattaches
   *  now; one that looks fresh must answer a round trip started after the
   *  wake, because the frames it heard around the wake may have sat in the
   *  browser's buffer while the page was away. */
  resume(): void
  /** The host saw the runtime appear: its presence lists this client's
   *  project as open after it was asleep or absent, as when a machine
   *  restarted. A fault without the runtime's own words rests on attaches
   *  made while nothing served the project, so it no longer describes the
   *  runtime there now: it ends, a new fault window starts, and the next
   *  attach goes out at once. A runtime that then does not answer for the
   *  whole window shows the fault again. A fault the runtime stated stays.
   *  With no fault, only a backoff between attempts is cut short. */
  appeared(): void
  /** Ends the connection for good. The event lane and its recovery stop at
   *  once, and no call starts after this. A call already in flight finishes on the transport it has before that
   *  transport is released: disposing it under the call would interrupt it,
   *  and a lossless mutation would be lost with no word to its caller. The
   *  caller bounds how long it waits. Every call returns the same promise. */
  close(): Promise<void>
}

export interface RuntimeConnectionOptions {
  /** The transport, as a layer built afresh for every attach. A socket is
   *  acquired when its layer is built, so a dead one cannot be retried; each
   *  attempt constructs this layer again and gets a new connection. */
  readonly socket: Layer.Layer<Socket.Socket>
  readonly onDiagnostic?: (message: string, detail?: unknown) => void
  readonly random?: () => number
  /** Wall clock for frame and lane age; tests advance it. */
  readonly now?: () => number
  /** Shared host/client timing policy. Production uses the protocol default;
   *  transport contract tests use a shorter, proportionate clock. */
  readonly liveness?: RuntimeLivenessPolicy
  /** Waits out one reconnect backoff step of `milliseconds`, or less once
   *  `woken` settles, which a reconnect or a resume request does. Production
   *  waits on a timer; tests read the steps it asks for. */
  readonly waitForBackoff?: (milliseconds: number, woken: Promise<void>) => Promise<void>
  /** How long recovery may fail before `health` reports a fault. */
  readonly faultAfterMs?: number
  /** How long `resume` waits for its probe; tests shorten it. */
  readonly resumeProbeDeadlineMs?: number
  /** The globals the connection's scheduler takes its tasks from; the page's
   *  own when absent. Tests pass a browser's set. */
  readonly schedulerHost?: LaneHost
  /** The identity of the client bundle this page runs, offered at every
   *  attach beside the protocol version that every client states. A web
   *  client always has one; the terminal and the editor host run no bundle
   *  and have none. */
  readonly clientIdentity?: string
  /** The runtime refused `clientIdentity` as not its own. The page must load
   *  itself again from the runtime; the connection stops reattaching, because
   *  no attempt with this bundle can succeed. */
  readonly onClientMismatch?: () => void
  /** Finds the runtime or starts it again, by the host's own find-or-start.
   *  The connection calls it before it reconnects when a dial found nothing
   *  listening after the lane had been connected: the runtime it reached
   *  has gone, and a host that can start one, such as the editor through
   *  its extension, starts it the way the terminal's find-or-start does. A
   *  rejection is a fault in its own words. */
  readonly ensureRuntime?: () => Promise<void>
}

/** How a lane failed: the cause its attempt rejected with. */
interface LaneFailure {
  readonly cause: unknown
}

/** Settles when the event loop should stop waiting on its current race: a
 *  close, a reconnect request, or the last subscriber leaving. */
interface Wake {
  readonly promise: Promise<void>
  readonly resolve: () => void
}

/** Waits `milliseconds` on a timer, or less once `woken` settles. */
async function waitOrWake(milliseconds: number, woken: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const delayed = new Promise<void>((resolve) => { timer = setTimeout(resolve, milliseconds) })
  try {
    await Promise.race([delayed, woken])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function createRuntimeConnection(options: RuntimeConnectionOptions): RuntimeConnection {
  const listeners = new Set<(event: FrontendEvent) => void>()
  const laneListeners = new Set<(lane: number) => void>()
  const stateListeners = new Set<(state: ConnectionState) => void>()
  const healthListeners = new Set<(health: RuntimeTransportHealth) => void>()
  const faultAfterMs = options.faultAfterMs ?? FAULT_AFTER_MS
  const reportedUnsupportedEvents = new Set<string>()
  const random = options.random ?? Math.random
  const now = options.now ?? Date.now
  const liveness = options.liveness ?? RUNTIME_LIVENESS_POLICY
  const waitForBackoff = options.waitForBackoff ?? waitOrWake

  let state: ConnectionState = "connecting"
  let health: RuntimeTransportHealth = { kind: "healthy" }
  // When the runtime was last answering, kept across every failed attempt of
  // one recovery so the fault says how long it has been.
  let brokeAt: number | undefined
  // The fault window's end, then the deadline of an attach sent after it.
  let faultTimer: ReturnType<typeof setTimeout> | undefined
  // Whether this recovery's fault window has ended: from then on an attach
  // that does not answer is the fault's evidence.
  let windowEnded = false
  let lastFrameAt = 0
  // Frames heard from the runtime on every lane, so a call can tell whether
  // the runtime said anything while it waited.
  let framesHeard = 0
  // When the lane last became connected; undefined until the first attach.
  let connectedAt: number | undefined
  let probing = false
  let closing = false
  /** The runtime refused this page's bundle. No attach with these bytes can
   *  succeed, so no loop runs again until the host has reloaded the page;
   *  `close()` still disposes what is held. */
  let mismatched = false
  // The open lane's id, or 0 while no lane is open. Ids grow across lanes.
  let lane = 0
  let lanesOpened = 0
  // The runtime the running subscription attempt dials, so a lane opens only
  // for the attempt it belongs to.
  let attemptRuntime: ReturnType<typeof makeRuntime> | undefined
  // Calls made while the connection attaches. They go out when the lane opens.
  let waiting: LaneWait[] = []
  // The calls a lane opens with, collected while its listeners run.
  let burst: LaneWait[] | undefined
  // The sessions whose live output the receivers watch on this lane, with
  // how many receivers watch each, and the set last stated to the runtime.
  // Both belong to one lane: its end clears them, because the runtime
  // forgets a connection's set with the connection, and every receiver
  // watches again when the next lane opens.
  const watched = new Map<string, number>()
  let statedWatch: ReadonlySet<string> = new Set()
  let watchLane = 0
  let watchFlushQueued = false
  // How the current lane will end when the loop wakes it on purpose.
  let requestedEnd: "requested" | "probe" = "requested"
  let timing = new LaneAttachTiming("first", undefined)
  let runtime = makeRuntime()
  let eventLoop: Promise<void> | undefined
  // Resolved when the loop should stop waiting on the current attempt: a close,
  // or the last subscriber leaving. A healthy subscription never ends on its
  // own, because the runtime heartbeats into it forever, so waiting for one to
  // finish naturally is waiting for something that cannot happen.
  let wake: Wake = makeWake()

  function makeWake(): Wake {
    let resolve: () => void = () => {}
    const promise = new Promise<void>((settle) => {
      resolve = settle
    })
    return { promise, resolve }
  }

  function makeRuntime(): ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never> {
    reportedUnsupportedEvents.clear()
    const made: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never> = ManagedRuntime.make(
      socketProtocolLayer({ onRequestWritten: (request) => requestWritten(made, request.tag, request.payload) }).pipe(
        Layer.provide(options.socket),
        Layer.provide(layerMsgPack),
        Layer.provideMerge(laneSchedulerLayer(options.schedulerHost)),
      ),
    )
    return made
  }

  async function disposeRuntime(target: ReturnType<typeof makeRuntime>): Promise<void> {
    try {
      await target.dispose()
    } catch (cause) {
      options.onDiagnostic?.("runtime connection disposal failed", cause)
    }
  }

  function setState(next: ConnectionState): void {
    if (state === next || (closing && next !== "closed")) return
    state = next
    if (next === "connected") connectedAt = now()
    for (const listener of stateListeners) listener(next)
    if (next === "connected") recovered()
    if (next === "recovering") armFault()
  }

  function setHealth(next: RuntimeTransportHealth): void {
    if (closing) return
    if (health.kind === next.kind && (health.kind === "healthy" || (next.kind === "faulted" && health.cause === next.cause))) return
    health = next
    for (const listener of healthListeners) listener(next)
    const event: FrontendEvent = { type: "runtime.health", health: next }
    for (const listener of listeners) listener(event)
  }

  function clearFaultTimer(): void {
    if (faultTimer !== undefined) clearTimeout(faultTimer)
    faultTimer = undefined
  }

  /** The lane is down. The fault window starts at the first break of this
   *  recovery, not at each attempt, so a long backoff cannot hide a fault.
   *
   *  Nor can a backoff raise one. Attaches that fail at once grow the
   *  backoff, so when the window ends the next attach can still be seconds
   *  away, and a runtime that came back meanwhile would show as lost until
   *  that wait ran out. So the window's end only cuts a wait in progress
   *  short, and from then on the loop skips its waits until an attach gives
   *  evidence (`attachUnanswered`): one sent after the window that fails, or
   *  that has not answered one heartbeat interval after it was sent. An
   *  attach sent before the window ended is no evidence either way.
   *
   *  The window runs from when the runtime last answered. A lane that broke
   *  by silence has heard nothing for its whole deadline, longer than the
   *  window, so the attach after it is already the evidence. */
  function armFault(): void {
    brokeAt ??= now()
    if (faultTimer !== undefined || windowEnded) return
    faultTimer = setTimeout(() => {
      faultTimer = undefined
      if (closing || state === "connected" || health.kind === "faulted") return
      windowEnded = true
      // Between attempts the wake only cuts a backoff short; mid-attempt it
      // would end the attach.
      if (attemptRuntime === undefined) wake.resolve()
    }, Math.max(0, brokeAt + faultAfterMs - now()))
    faultTimer.unref?.()
  }

  /** Whether an attach sent now gives evidence for the fault. */
  function awaitingEvidence(): boolean {
    return windowEnded && health.kind !== "faulted"
  }

  /** An attach sent after the window did not answer: the runtime has not
   *  answered for the whole window and still does not. */
  function attachUnanswered(): void {
    clearFaultTimer()
    if (closing || !awaitingEvidence()) return
    setHealth({ kind: "faulted", since: brokeAt ?? now() })
  }

  function recovered(): void {
    clearFaultTimer()
    brokeAt = undefined
    windowEnded = false
    setHealth({ kind: "healthy" })
  }

  function fault(cause: string, refusal?: ServeStartRefusal | RuntimeProtocolRefusal): void {
    if (closing) return
    brokeAt ??= now()
    setHealth({ kind: "faulted", since: brokeAt, cause, ...(refusal === undefined ? {} : { refusal }) })
  }

  /** The synthetic patch that voids every receiver's resident state. It carries
   *  no real position because it belongs to no cursor's chain: it is the
   *  statement that the chains themselves stopped being trustworthy. */
  function publishInvalidation(reason: RuntimeInvalidationReason): void {
    const event: FrontendEvent = {
      type: "patch",
      patch: {
        cursor: { scope: "workspace", domain: "runtime" },
        position: 0,
        prevPosition: 0,
        payload: { kind: "runtime.invalidate", reason },
      },
    }
    for (const listener of listeners) listener(event)
  }

  /** A request reached an open socket. The subscription's write opens the
   *  lane; the first transcript read's write is part of the attach record. */
  function requestWritten(target: ReturnType<typeof makeRuntime>, tag: string, payload: unknown): void {
    if (tag === "RuntimeEvents") {
      // Off the writing fiber: the lane's listeners start calls of their own.
      queueMicrotask(() => openLane(target))
      return
    }
    if (target !== runtime || lane === 0) return
    if (tag === "RuntimeQuery" && typeof payload === "object" && payload !== null && "type" in payload && payload.type === "outputWindow") timing.transcriptWritten(now())
  }

  /** The subscription of the running attempt is on an open socket: the lane
   *  is open. Its listeners seed, the calls that waited for it go out, and
   *  the watch statement of what the listeners watch leads the burst, ahead
   *  of the transcript reads. */
  function openLane(target: ReturnType<typeof makeRuntime>): void {
    if (closing || target !== attemptRuntime || target !== runtime || lane !== 0) return
    lane = ++lanesOpened
    const openedAt = now()
    const seeds: LaneWait[] = []
    burst = seeds
    // A copy: a listener that adds another would otherwise call it twice,
    // once as it is added and once more in this loop.
    for (const listener of Array.from(laneListeners)) notifyLane(listener)
    flushWatch()
    burst = undefined
    const { send, dropped } = laneBurst(waiting, seeds)
    waiting = []
    for (const held of dropped) held.fail(new RuntimeLaneLost(new Error("a hold made while the connection attached is sent again by its holder on the new lane")))
    timing.opened(openedAt, send.length)
    for (const wait of send) wait.go()
  }

  function notifyLane(listener: (lane: number) => void): void {
    try {
      listener(lane)
    } catch (cause) {
      options.onDiagnostic?.("runtime lane listener threw", cause)
    }
  }

  /** Follows `sessionId`'s live output on the open lane. Changes coalesce:
   *  the set goes out as one statement at the end of the turn, or before
   *  the next call starts, whichever comes first. */
  function watchOutput(sessionId: string): Unsubscribe {
    const watchedOn = watchLane
    watched.set(sessionId, (watched.get(sessionId) ?? 0) + 1)
    watchChanged()
    let released = false
    return () => {
      if (released || watchedOn !== watchLane) return
      released = true
      const count = (watched.get(sessionId) ?? 1) - 1
      if (count === 0) watched.delete(sessionId)
      else watched.set(sessionId, count)
      watchChanged()
    }
  }

  function watchChanged(): void {
    if (watchFlushQueued) return
    watchFlushQueued = true
    queueMicrotask(flushWatch)
  }

  /** States the watched set to the runtime when it differs from the set
   *  stated on this lane. Inside a lane's burst the statement joins the
   *  burst, which sends it first; with no lane open there is nothing to
   *  state, and the next lane states what is watched then. */
  function flushWatch(): void {
    watchFlushQueued = false
    if (closing || lane === 0) return
    const sessionIds = [...watched.keys()]
    if (sessionIds.length === statedWatch.size && sessionIds.every((id) => statedWatch.has(id))) return
    statedWatch = new Set(sessionIds)
    void dispatch({ type: "output.watch", sessionIds }).catch((cause: unknown) => {
      if (!lostWithLane(cause)) options.onDiagnostic?.("runtime output watch statement failed", cause)
    })
  }

  /** The lane is gone, or never opened: every call that waited for it fails
   *  with the attempt's own cause. */
  function failWaiting(cause: unknown): void {
    const failed = waiting
    waiting = []
    for (const wait of failed) wait.fail(cause)
  }

  /** The loop stopped with no lane coming: the calls that waited go straight
   *  to the runtime, as a call made with no listener does. */
  function releaseWaiting(): void {
    const released = waiting
    waiting = []
    for (const wait of released) wait.go()
  }

  /** Calls wait for a lane only while one is being attached. With no event
   *  loop, such as a host that calls without subscribing, nothing would open
   *  one, so the call goes straight out. */
  function waitsForLane(): boolean {
    return eventLoop !== undefined && lane === 0 && !mismatched && (state === "connecting" || state === "recovering")
  }

  /** Waits for the next lane, the attach's failure, or the call's own
   *  deadline, and answers how long it waited. */
  function laneFor(kind: LaneCall, policy: RuntimeCallPolicy): Promise<void> {
    if (burst !== undefined) {
      const seeds = burst
      return new Promise((resolve, reject) => { seeds.push({ kind, go: resolve, fail: reject }) })
    }
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const wait: LaneWait = {
        kind,
        go: () => { clearTimeout(timer); resolve() },
        fail: (cause) => { clearTimeout(timer); reject(cause instanceof RuntimeLaneLost ? cause : new RuntimeLaneLost(cause)) },
      }
      if (policy._tag === "BestEffort") {
        timer = setTimeout(() => {
          waiting = waiting.filter((entry) => entry !== wait)
          reject(RuntimeCallTimeout.forDeadline(policy.deadlineMs))
        }, policy.deadlineMs)
      }
      waiting.push(wait)
    })
  }

  // Calls in flight. A runtime is recycled or closed only when nothing runs
  // on it: disposing one under a call interrupts the call's fibers, and the
  // caller sees an interruption where it asked for an answer.
  const inFlight = new Set<Promise<unknown>>()
  let recycleWanted = false
  let closed: Promise<void> | undefined

  /** One call. A deadline that passes with no frame heard since the call was
   *  made is the runtime's silence, not the call's failure (`RuntimeSilent`). */
  async function call<A>(run: (client: ProtocolClient) => Effect.Effect<A, unknown>, policy: RuntimeCallPolicy, kind: LaneCall): Promise<A> {
    const heard = framesHeard
    try {
      return await callOnLane(run, policy, kind)
    } catch (cause) {
      throw cause instanceof RuntimeCallTimeout && framesHeard === heard ? new RuntimeSilent(cause) : cause
    }
  }

  async function callOnLane<A>(run: (client: ProtocolClient) => Effect.Effect<A, unknown>, policy: RuntimeCallPolicy, kind: LaneCall): Promise<A> {
    if (closing) throw new Error("runtime connection is closed")
    // A watch changed before this call is stated before it, so a read the
    // runtime serves after the statement is followed by the output it covers.
    if (burst === undefined) flushWatch()
    const askedAt = now()
    if (burst !== undefined || waitsForLane()) await laneFor(kind, policy)
    if (closing) throw new Error("runtime connection is closed")
    // The time spent waiting for the lane counts against the call's deadline.
    const remaining: RuntimeCallPolicy = policy._tag === "BestEffort" ? { _tag: "BestEffort", deadlineMs: Math.max(0, policy.deadlineMs - (now() - askedAt)) } : policy
    const operation = Effect.scoped(Effect.flatMap(RpcClient.make(RuntimeProtocolRpc, { generateRequestId: stringRequestId }), run))
    const running = runtime.runPromiseExit(applyRuntimeCallPolicy(operation, remaining))
    inFlight.add(running)
    let exit: Exit.Exit<A, unknown>
    try {
      exit = await running
    } finally {
      inFlight.delete(running)
      if (recycleWanted) void recycleIdleRuntime()
    }
    if (Exit.isSuccess(exit)) return exit.value
    // Only the end of a lane disposes a runtime under a call: a close and an
    // idle recycle wait for every call in flight. So a call interrupted and
    // nothing else is a call the lane took down with it.
    if (Cause.hasInterruptsOnly(exit.cause)) throw new RuntimeLaneLost(new Error("the lane the call ran on ended"))
    throw Cause.squash(exit.cause)
  }

  function report(diagnostic: RuntimeClientDiagnostic): void {
    void call((client) => client.RuntimeClientDiagnostic(diagnostic), runtimeCallPolicies.clientDiagnostic, "call").catch((cause: unknown) => {
      if (!lostWithLane(cause)) options.onDiagnostic?.("runtime client diagnostic report failed", { diagnostic, cause })
    })
  }

  function reportUnsupportedEvent(diagnostic: RuntimeClientDiagnostic): void {
    const signature = JSON.stringify(diagnostic)
    if (reportedUnsupportedEvents.has(signature)) return
    reportedUnsupportedEvents.add(signature)
    report(diagnostic)
  }

  /** The runtime answered on the lane: one record of where the time to it
   *  went, durations and kinds only. */
  function reportAttach(): void {
    if (lane === 0) return
    const record = timing.answered(now())
    if (record !== undefined) report(record)
  }

  /** Replaces the runtime once no subscriber and no call uses it, so the next
   *  use dials afresh instead of reusing a socket that may have died while
   *  nobody was listening. The swap happens before the old runtime is
   *  disposed, so a call that starts meanwhile lands on the new one. */
  async function recycleIdleRuntime(): Promise<void> {
    if (closing || listeners.size > 0 || inFlight.size > 0) return
    recycleWanted = false
    const idle = runtime
    runtime = makeRuntime()
    await disposeRuntime(idle)
  }

  /** One subscription attempt. Settles when the stream ends for any reason; the
   *  loop above decides whether that becomes a reconnect. */
  function consumeEvents(signal: AbortSignal): Promise<void> {
    return runtime.runPromise(Effect.scoped(Effect.flatMap(RpcClient.make(RuntimeProtocolRpc, { generateRequestId: stringRequestId }), (client) =>
      client.RuntimeEvents({ protocolVersion: RUNTIME_PROTOCOL_VERSION, ...(options.clientIdentity === undefined ? {} : { clientIdentity: options.clientIdentity }) }).pipe(
        Stream.timeoutOrElse({
          duration: liveness.silenceDeadlineMs,
          orElse: () => Stream.fail(new LaneSilence(now() - lastFrameAt > liveness.silenceDeadlineMs * 2)),
        }),
        Stream.runForEach((input) => Effect.sync(() => {
          const decoded = decodeRuntimeEventFrame(input)
          lastFrameAt = now()
          framesHeard += 1
          setState("connected")
          if (closing) return
          if (decoded.kind === "unsupported") {
            reportUnsupportedEvent(decoded.diagnostic)
            return
          }
          const frame = decoded.frame
          // The runtime's first frame says that it answers; the lane opened
          // when the subscription was written, so it is no event of its own.
          if (frame.type === "runtime.connected") {
            reportAttach()
            return
          }
          if (frame.type === "runtime.heartbeat") return
          for (const listener of listeners) {
            try {
              listener(frame)
            } catch (cause) {
              options.onDiagnostic?.("runtime event listener threw", cause)
            }
          }
        })),
      ))), { signal })
  }

  /** Resolves true when the wake ended the attempt on request, false when the
   *  lane ended on its own, and rejects when the lane failed. */
  async function runSubscriptionAttempt(): Promise<boolean> {
    const controller = new AbortController()
    attemptRuntime = runtime
    lastFrameAt = now()
    timing.attemptStarted(now())
    const consuming = consumeEvents(controller.signal)
    try {
      return await Promise.race([consuming.then(() => false), wake.promise.then(() => true)])
    } finally {
      controller.abort()
      await consuming.catch(() => {})
      attemptRuntime = undefined
    }
  }

  /** The lane ended: the next attach's record starts from here. */
  function endLane(previousCause: LaneEndCause): void {
    if (lane === 0) return
    lane = 0
    watched.clear()
    statedWatch = new Set()
    watchLane += 1
    timing = new LaneAttachTiming(previousCause, now(), typeof document === "undefined" ? undefined : document.visibilityState)
  }

  async function runEventLoop(): Promise<void> {
    let attempt = 0
    // oxlint-disable-next-line no-unmodified-loop-condition -- close() flips `closing` from outside the loop while it is parked on an await
    while (!closing && listeners.size > 0) {
      wake = makeWake()
      requestedEnd = "requested"
      let nothingListening = false
      let requested = false
      let failed: LaneFailure | undefined
      // Captured before the attach: one that answers ends the window through
      // `recovered`, and one sent before the window ended is no evidence.
      const evidence = awaitingEvidence()
      if (evidence) {
        faultTimer = setTimeout(attachUnanswered, liveness.heartbeatIntervalMs)
        faultTimer.unref?.()
      }
      try {
        requested = await runSubscriptionAttempt()
      } catch (cause) {
        failed = { cause }
        // A lane the runtime closed cleanly is a stop the runtime chose, such
        // as a planned replacement's: the next attach finds it or its
        // successor, and nothing failed that a report could explain.
        const endCause = laneEndCause(cause)
        // A silent lane last heard the runtime at its last frame, a whole
        // silence deadline ago, and the fault window counts from there.
        if (endCause.kind === "silent") brokeAt ??= lastFrameAt
        // A protocol refusal repeats at every attempt until the versions
        // agree, and the fault it raised stands until then, so only the first
        // of a run with the same cause is reported.
        const refused = protocolRefusal(cause)
        const refusedAgain = refused !== undefined && health.kind === "faulted" && health.cause === refused.message
        if (!lostToCleanClose(cause) && endCause.kind !== "requested" && !refusedAgain) options.onDiagnostic?.("runtime event lane ended", endCause)
        nothingListening = foundNothingListening(cause)
        // A call that waited for this attach fails with its cause; a lane
        // that opened has none waiting.
        failWaiting(cause)
        // The runtime serves another client than this page runs. Only a page
        // loaded again from the runtime can attach, so the loop ends here and
        // the host reloads; another attempt with these bytes would be refused.
        if (isClientMismatch(cause)) {
          mismatched = true
          endLane({ kind: "refused" })
          setState("recovering")
          options.onClientMismatch?.()
          return
        }
        // The runtime said why it refused this attach; that is a fault now,
        // in its words, not something the next attempt heals in silence.
        const refusal = attachRefusal(cause)
        if (refusal !== undefined) fault(refusal.message, refusal.refusal)
        // The runtime speaks another protocol. The loop keeps attaching: a
        // runtime that updates, or a host that follows the runtime's build
        // before its next dial, ends the refusal, and the lane then opens.
        if (refused !== undefined) fault(refused.message, refused.refusal)
      }
      if (evidence && !requested && windowEnded) attachUnanswered()
      else if (evidence) clearFaultTimer()
      if (closing || listeners.size === 0) return
      // A lane that ended sooner than a heartbeat interval keeps the backoff
      // growing even when it delivered a frame, so a runtime that accepts each
      // attach and fails it at once is not redialed at the first step forever.
      // One that served longer, such as one a planned replacement ends, and
      // one ended on request start again at the first step.
      const served = state === "connected" && connectedAt !== undefined && now() - connectedAt >= liveness.heartbeatIntervalMs
      if (requested || served) attempt = 0

      // The backoff's wake exists from the moment the lane is known down, so
      // a reconnect or resume that lands while the dead runtime is still being
      // disposed skips the wait instead of resolving a wake nobody races.
      wake = makeWake()
      const previousCause: LaneEndCause = requested ? { kind: requestedEnd } : failed === undefined ? { kind: "closed", code: 1000 } : laneEndCause(failed.cause)
      endLane(previousCause)
      setState("recovering")
      // Everything held locally descends from a stream that just broke, so it
      // is void before the next attempt. Nothing reads it again until the
      // next lane opens.
      publishInvalidation("reconnect_required")

      // The connection is acquired when the layer is built, so a dead socket
      // cannot be retried. Recovery means a new runtime, not another attempt on
      // this one. A call made meanwhile, such as a re-read a receiver starts
      // when the lane is voided, waits for the next lane.
      await disposeRuntime(runtime)
      if (closing || listeners.size === 0) return
      runtime = makeRuntime()

      // A lane ended on request redials at once: the page asked for a fresh
      // lane, and no failure exists that a wait protects. Every other end
      // waits, so clients that one runtime replacement disconnects do not
      // all dial into the gap at the same moment. Past the fault window with
      // no evidence yet, the next attach is that evidence, so it goes now.
      if (!requested && !awaitingEvidence()) {
        const waitStartedAt = now()
        await waitForBackoff(reconnectBackoffMs(attempt, random), wake.promise)
        timing.waitedBackoff(now() - waitStartedAt)
        if (closing || listeners.size === 0) return
        attempt = Math.min(attempt + 1, MAX_RECONNECT_ATTEMPT)
      }
      if (nothingListening && connectedAt !== undefined && options.ensureRuntime) {
        try {
          await options.ensureRuntime()
        } catch (cause) {
          options.onDiagnostic?.("runtime find-or-start failed", cause)
          fault(cause instanceof Error ? cause.message : String(cause))
        }
        if (closing || listeners.size === 0) return
      }
    }
  }

  function ensureEventLoop(): void {
    if (closing || mismatched || eventLoop || listeners.size === 0) return
    eventLoop = runEventLoop().finally(async () => {
      eventLoop = undefined
      endLane({ kind: "requested" })
      if (closing) return
      if (listeners.size === 0) {
        recycleWanted = true
        await recycleIdleRuntime()
        if (closing) return
      }
      if (listeners.size > 0) ensureEventLoop()
      else releaseWaiting()
    })
  }

  // Overload signatures carry the query/result and mutation/result correlation
  // the transport erases; the RPC schemas validate it at runtime. A query
  // result arrives opaque and is decoded here with the codec its own
  // discriminant selects, so no other result shape can claim it.
  function query<Q extends RuntimeQuery>(request: Q): Promise<RuntimeQueryResult<Q>>
  function query(request: RuntimeQuery) {
    const decode = Schema.decodeUnknownEffect(runtimeQueryResultSchema(request.type))
    return call((client) => client.RuntimeQuery(request).pipe(Effect.flatMap(decode)), runtimeCallPolicies[request.type], laneCallOf(request))
  }

  function dispatch<C extends FrontendMutation>(mutation: C): Promise<MutationResult<C>>
  function dispatch(mutation: FrontendMutation) {
    const decode = Schema.decodeUnknownEffect(runtimeDispatchResultSchema(mutation.type))
    return call((client) => client.RuntimeDispatch(mutation).pipe(Effect.flatMap(decode)), runtimeCallPolicies.dispatch, laneCallOf(mutation))
  }

  return {
    get state() {
      return state
    },
    async ready() {
      await runtime.context()
    },
    query,
    dispatch,
    watchOutput,
    reportDiagnostic: report,
    subscribe(listener) {
      listeners.add(listener)
      ensureEventLoop()
      return () => {
        listeners.delete(listener)
        // Nothing left to deliver to. Release the loop instead of leaving it
        // parked on a subscription no one reads.
        if (listeners.size === 0) wake.resolve()
      }
    },
    onLane(listener) {
      laneListeners.add(listener)
      if (lane !== 0) notifyLane(listener)
      return () => {
        laneListeners.delete(listener)
      }
    },
    reconnect() {
      if (closing) return
      // Waking whatever the loop is racing is the whole mechanism: mid-lane it
      // breaks the attach and forces a fresh runtime, mid-backoff it skips the
      // remaining wait. Both are what "reconnect now" means from where the user
      // is standing.
      wake.resolve()
    },
    resume() {
      if (closing) return
      // Two heartbeat intervals: one heartbeat can be in flight, and a second
      // missing one means the lane was not delivering while the page was away.
      if (state !== "connected" || now() - lastFrameAt > liveness.heartbeatIntervalMs * 2) {
        wake.resolve()
        return
      }
      if (probing) return
      probing = true
      const probed = runtime
      // Any answer is a round trip, a protocol error included. No answer by
      // the deadline, or a transport failure, is the lane not answering; it is
      // reconnected only if it is still the lane in use, since the loop may
      // have replaced it since.
      const unanswered = () => {
        if (runtime !== probed || state !== "connected") return
        requestedEnd = "probe"
        wake.resolve()
      }
      const deadline = setTimeout(unanswered, options.resumeProbeDeadlineMs ?? RESUME_PROBE_DEADLINE_MS)
      void query(RESUME_PROBE).then(() => undefined, (cause: unknown) => {
        if (!(cause instanceof RuntimeProtocolError)) unanswered()
      }).finally(() => {
        clearTimeout(deadline)
        probing = false
      })
    },
    appeared() {
      if (closing || state === "connected") return
      if (health.kind === "faulted" && health.cause === undefined) {
        clearFaultTimer()
        windowEnded = false
        brokeAt = now()
        setHealth({ kind: "healthy" })
        armFault()
        // An attach in flight went to the absent runtime, so it ends and the
        // next one goes out at once.
        wake.resolve()
        return
      }
      // With no fault, an attach in flight may be the one that answers, so
      // only a backoff between attempts is cut short.
      if (attemptRuntime === undefined) wake.resolve()
    },
    onStateChange(listener) {
      stateListeners.add(listener)
      return () => {
        stateListeners.delete(listener)
      }
    },
    get health() { return health },
    onHealthChange(listener) {
      healthListeners.add(listener)
      return () => { healthListeners.delete(listener) }
    },
    fault,
    close() {
      closed ??= (async () => {
        closing = true
        clearFaultTimer()
        listeners.clear()
        laneListeners.clear()
        setState("closed")
        wake.resolve()
        failWaiting(new Error("runtime connection is closed"))
        await eventLoop?.catch(() => {})
        await Promise.allSettled(inFlight)
        await disposeRuntime(runtime)
      })()
      return closed
    },
  }
}
