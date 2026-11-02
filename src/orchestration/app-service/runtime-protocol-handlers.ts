import { Cause, Context, Deferred, Effect, Exit, Layer, Result, Schema, Stream } from "effect"
import type { RpcGroup } from "effect/unstable/rpc"
import { Rpc } from "effect/unstable/rpc"
import { DebugLog } from "../../infra/debug-log.js"
import type { OperationLogger } from "../../infra/operation-log.js"
import { errorMessage } from "../../infra/error-message.js"
import { trackLoopSpan } from "../../infra/event-loop-lag.js"
import type { FlywheelAppService } from "./app-service.js"
import type { ProjectControlClient } from "./project-control-client.js"
import type { OutputWatches } from "./output-watches.js"
import type { RuntimeEventFrame } from "../../protocol/app-service-types.js"
import { classifyRuntimeProtocolErrorKind, RuntimeProtocolError, RuntimeProtocolRpc, runtimeQueryResultSchema } from "../../protocol/runtime-protocol-schemas.js"
import { runtimeDispatchResultSchema } from "../../protocol/runtime-dispatch-result-schemas.js"
import { RUNTIME_LIVENESS_POLICY, RUNTIME_PROTOCOL_VERSION, type RuntimeLivenessPolicy } from "../../protocol/runtime-liveness.js"
import { runtimeEventDelivery } from "./runtime-event-delivery.js"
import { coalesceRepeats } from "../../infra/repeat-coalescer.js"

/** What one project serves its client connections: the account facade, and
 *  the owner of the sessions each connection watches. */
interface RuntimeProtocolProject {
  readonly client: Pick<FlywheelAppService, "subscribe"> & Pick<ProjectControlClient, "query" | "dispatch" | "disconnect">
  readonly outputWatches: Pick<OutputWatches, "state" | "drop" | "watches">
}

/** The transport-neutral half of the runtime server: the mapping from the
 *  RuntimeProtocolRpc surface onto a FlywheelAppService, and the subscribed
 *  event stream. Account project compositions serve it over each admitted
 *  local, browser, or relay transport. */

/** The RuntimeProtocolError travels the wire as MsgPack on every transport;
 *  an unbounded error string (a multi-megabyte provider payload echoed into a
 *  message) bloats every frame.
 *  Cap it at the boundary without touching the shared errorMessage util. */
const MAX_WIRE_ERROR_LEN = 1024

/** A client refused for its protocol version retries at most every 30
 *  seconds until the versions agree, which can take hours. */
const PROTOCOL_REFUSAL_WINDOW_MS = 60 * 60_000

export function truncateWireError(message: string): string {
  if (message.length <= MAX_WIRE_ERROR_LEN) return message
  return `${message.slice(0, MAX_WIRE_ERROR_LEN)}… [truncated ${message.length - MAX_WIRE_ERROR_LEN} chars]`
}

export interface RuntimeHandlerOptions {
  /** The release this runtime runs, which a refusal of another protocol
   *  version names. */
  readonly version: string
  readonly liveness?: RuntimeLivenessPolicy
  /** The identity of the client this process serves, or undefined when it
   *  serves none. A web client states its own at every event attach and one
   *  that is not this runtime's is refused; the terminal states none. */
  readonly clientIdentity?: () => Promise<string | undefined>
}

export function runtimeHandlers(
  project: RuntimeProtocolProject,
  log: OperationLogger,
  options: RuntimeHandlerOptions,
): Layer.Layer<Rpc.ToHandler<RpcGroup.Rpcs<typeof RuntimeProtocolRpc>>> {
  const { client, outputWatches } = project
  const liveness = options.liveness ?? RUNTIME_LIVENESS_POLICY
  const ownIdentity = options.clientIdentity ?? (() => Promise.resolve(undefined))
  // A refused client keeps attaching until the versions agree, so the first
  // refusal of each offered version records in full and its repeats as one
  // count per window.
  const protocolRefusals = coalesceRepeats<undefined>({
    windowMs: PROTOCOL_REFUSAL_WINDOW_MS,
    first: (offered) => {
      log.info("runtime event stream refused a client of another protocol", { offered, own: RUNTIME_PROTOCOL_VERSION })
    },
    repeated: (offered, repeats) => {
      log.info("runtime event stream refused a client of another protocol again", { offered, own: RUNTIME_PROTOCOL_VERSION, count: repeats.count, windowMs: repeats.windowMs })
    },
  })
  /** The event stream of an attach whose bundle the runtime admitted: one
   *  that states this runtime's protocol version. A client that states
   *  another, or none, speaks a protocol this runtime cannot serve, so it is
   *  refused with this runtime's release, by which the client tells whether
   *  it or the runtime must update. */
  const admittedDelivery = (connection: Rpc.ServerClient, protocolVersion: number | undefined, settle: () => void): Stream.Stream<RuntimeEventFrame, RuntimeProtocolError> => {
    if (protocolVersion === RUNTIME_PROTOCOL_VERSION) return runtimeEventDelivery(client, log, liveness, settle, { watches: (sessionId) => outputWatches.watches(connection, sessionId) })
    protocolRefusals.observe(String(protocolVersion ?? "none"), undefined)
    return Stream.fail(new RuntimeProtocolError({
      kind: "protocol-mismatch",
      message: `the runtime runs Flywheel ${options.version}, which speaks protocol ${RUNTIME_PROTOCOL_VERSION}, and this client speaks ${protocolVersion ?? "an earlier one"}`,
      runtime: { version: options.version, protocolVersion: RUNTIME_PROTOCOL_VERSION },
    }))
  }
  // The handlers live as long as their transport, and its end reports the
  // refusals still counted.
  return RuntimeProtocolRpc.toLayer(Effect.as(Effect.addFinalizer(() => Effect.sync(() => protocolRefusals.end())), RuntimeProtocolRpc.of({
    // Encoded with the codec the query's discriminant selects, so the wire
    // carries exactly the declared result shape.
    // A query names its connection too: a detail snapshot holds the
    // sessions it reads for that connection alone.
    RuntimeQuery: (query, { client: connection }) => afterSubscriptions(connection, fromPromise(`query:${query.type}`, async () => Schema.encodeUnknownSync(runtimeQueryResultSchema(query.type))(await client.query(query, connection)))),
    // Each mutation names the connection that sent it, so the sessions a
    // connection shows are held by that connection alone (ARCH-RUNTIME-023).
    // A watch statement applies, and reaches the executor, before the call
    // this connection sends next is forwarded, so the read that follows a
    // watch is served under it.
    RuntimeDispatch: (mutation, { client: connection }) => afterSubscriptions(connection, fromPromise(`dispatch:${mutation.type}`, async () => {
      if (mutation.type !== "output.watch") return Schema.encodeUnknownSync(runtimeDispatchResultSchema(mutation.type))(await client.dispatch(mutation, connection))
      outputWatches.state(connection, mutation.sessionIds)
      return Schema.encodeUnknownSync(runtimeDispatchResultSchema(mutation.type))({ ok: true })
    })),
    // A client opens one event lane per connection and ends the connection
    // when its lane ends, so the lane's end, a refused attach included, is the
    // connection's end and lets go of every session it held.
    RuntimeEvents: (attach, { client: connection }) => {
      // Recorded here, as the request arrives, before anything yields: the
      // calls the client wrote after this subscription arrive after it and
      // wait for it, while a call that arrived before it is already served.
      const gate = openSubscriptionGate(connection)
      const settle = (): void => gate.settle()
      // The bundle is checked before the protocol version: a page of another
      // bundle reloads from the runtime whatever protocol it speaks, and a
      // page of this runtime's bundle speaks this runtime's protocol.
      return (attach.clientIdentity === undefined
        ? admittedDelivery(connection, attach.protocolVersion, settle)
        : Stream.unwrap(Effect.promise(ownIdentity).pipe(Effect.flatMap((own) => {
          // A runtime that serves no client has nothing to compare against, and
          // a page that reloads from it gets no page at all, so its bundle is
          // admitted.
          if (own === undefined || own === attach.clientIdentity) return Effect.succeed(admittedDelivery(connection, attach.protocolVersion, settle))
          log.info("runtime event stream refused a client of another build", { offered: attach.clientIdentity, own })
          return Effect.fail(new RuntimeProtocolError({ kind: "client-mismatch", message: "the runtime serves another client than this page runs" }))
        })))).pipe(
        // A subscription that failed fails the calls that waited for it with
        // its own failure; one that ended releases them to a connection that
        // is ending too.
        Stream.onExit((exit) => Effect.sync(() => {
          const failure = Exit.isFailure(exit) ? Cause.findError(exit.cause) : undefined
          gate.settle(failure !== undefined && Result.isSuccess(failure) ? failure.success : undefined)
        })),
        Stream.ensuring(Effect.sync(() => {
          outputWatches.drop(connection)
          client.disconnect(connection)
        })),
      )
    },
    RuntimeClientDiagnostic: (diagnostic) => Effect.sync(() => {
      if (diagnostic.kind === "background_read") {
        const { kind: _kind, ...evidence } = diagnostic
        DebugLog.record({ type: "runtime.client.background_read", notable: true, payload: evidence })
        return
      }
      if (diagnostic.kind === "input_responsiveness") {
        const { kind: _kind, sessionId, ...evidence } = diagnostic
        DebugLog.record({ type: "runtime.client.input_responsiveness", notable: true, ...(sessionId === undefined ? {} : { sessionId }), payload: evidence })
        return
      }
      if (diagnostic.kind === "lane_attach") {
        const { kind: _kind, ...timing } = diagnostic
        DebugLog.record({ type: "runtime.client.lane_attached", payload: timing })
        return
      }
      const fields = diagnostic.kind === "unsupported_patch"
        ? { ...diagnostic.cursor, eventType: "patch", payloadKind: diagnostic.payloadKind }
        : { eventType: diagnostic.eventType }
      log.warn("runtime client skipped an unsupported event", fields)
    }),
  })))
}

/** One event subscription of a connection that is not registered yet. */
interface SubscriptionGate {
  readonly registered: Deferred.Deferred<void, RuntimeProtocolError>
  /** Settles the gate once and forgets it: registered or ended when `failure`
   *  is absent, failed with it otherwise. */
  settle(failure?: RuntimeProtocolError): void
}

/** The subscriptions each connection waits on, kept on the connection's own
 *  server record, which lives exactly as long as the connection. */
const PendingSubscriptions = Context.Service<Set<SubscriptionGate>>("flywheel/runtime/PendingSubscriptions")

function pendingSubscriptions(connection: Rpc.ServerClient): Set<SubscriptionGate> {
  const pending = Context.getOrUndefined(connection.annotations, PendingSubscriptions)
  if (pending !== undefined) return pending
  const created = new Set<SubscriptionGate>()
  connection.annotate(PendingSubscriptions, created)
  return created
}

/** Opens the gate of one subscription request on `connection`.
 *
 *  The order this keeps is the client's write order. RpcServer calls each
 *  handler synchronously, in the order the requests arrive on the socket, so
 *  a call that the client wrote after its subscription finds the gate here.
 *  The subscription itself registers only after an asynchronous step (the
 *  client identity check), and a call served before that would read a state
 *  whose next change the subscription never carries. The invariant this
 *  rests on: `RuntimeEvents` is the first message on each socket that a
 *  client's event loop dials, so no backlog of earlier messages can push the
 *  subscription past the scheduler's yield point. A call that a client makes
 *  before its event loop runs can open a socket that a later subscription
 *  then shares; that call arrives before the subscription, so no gate holds
 *  it. A second subscription on one socket gets its own gate, and each gate
 *  settles only its own waiters. */
function openSubscriptionGate(connection: Rpc.ServerClient): SubscriptionGate {
  const pending = pendingSubscriptions(connection)
  const registered = Deferred.makeUnsafe<void, RuntimeProtocolError>()
  const gate: SubscriptionGate = {
    registered,
    settle(failure) {
      if (!pending.delete(gate)) return
      Deferred.doneUnsafe(registered, failure === undefined ? Exit.void : Exit.fail(failure))
    },
  }
  pending.add(gate)
  return gate
}

/** Serves `effect` once every subscription that arrived before it on
 *  `connection` is registered, or fails with the failure of one that failed.
 *  A connection with no subscription waiting is served at once. */
function afterSubscriptions<A>(connection: Rpc.ServerClient, effect: Effect.Effect<A, RuntimeProtocolError>): Effect.Effect<A, RuntimeProtocolError> {
  const pending = Context.getOrUndefined(connection.annotations, PendingSubscriptions)
  if (pending === undefined || pending.size === 0) return effect
  const waits = [...pending].map((gate) => Deferred.await(gate.registered))
  return Effect.andThen(Effect.all(waits, { discard: true }), effect)
}

/** The RPC name registers as an in-flight loop span so an event-loop stall
 *  WARN can name what the stall delayed (session-fairness plan, phase 0). */
function fromPromise<A>(name: string, run: () => Promise<A>): Effect.Effect<A, RuntimeProtocolError> {
  return Effect.tryPromise({
    try: async () => {
      const end = trackLoopSpan("rpc", name)
      try {
        return await run()
      } finally {
        end()
      }
    },
    catch: (err) => new RuntimeProtocolError({ message: truncateWireError(errorMessage(err)), kind: classifyRuntimeProtocolErrorKind(err) }),
  })
}
