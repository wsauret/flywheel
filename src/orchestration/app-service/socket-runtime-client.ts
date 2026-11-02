import { diagnosticDetail, errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import { DebugLog } from "../../infra/debug-log.js"
import { startupTrace } from "../../infra/startup-trace.js"
import type { AttachedRuntimeClient, FrontendEvent, FrontendMutation, MutationResult, RuntimeClient, RuntimeQuery, RuntimeQueryResult, RuntimeStartupStatus, Unsubscribe } from "../../protocol/app-service-types.js"
import { createRuntimeConnection } from "../../protocol/client/connection.js"
import { ServeStartupFailure } from "../../protocol/serve-handshake.js"
import { withLoggedRuntimeClient } from "./app-service-logging.js"
import { bunSocketClientLayer } from "./bun-socket-rpc.js"

const log = Log.create({ service: "socket-runtime-client" })

export interface SocketRuntimeClientOptions {
  readonly socketPath: string
  /** Finds the runtime that serves this project, or starts one, and resolves
   *  once something is listening at `socketPath`. Every blocking startup step
   *  the runtime reports goes to `report`, so the load screen shows it; a
   *  start that fails rejects with the composition's own error. Called before
   *  every attach, so a runtime that went away is started again by the same
   *  route the first one was, until the client closes. */
  readonly ensureRuntime: (report: (status: RuntimeStartupStatus) => void) => Promise<void>
  /** Bytes sent immediately after each socket opens and before RPC framing. */
  readonly connectionPreface?: () => Uint8Array | Promise<Uint8Array>
}

/** The terminal's runtime client: the shared reconnecting connection over a
 *  Bun unix socket to the runtime that serves this project (ARCH-RUNTIME-005). The
 *  runtime is a separate process the terminal attaches to, the same one an
 *  editor window or a paired phone attaches to, so the terminal owns none of
 *  its lifetime: closing this client closes one connection and leaves every
 *  turn in flight running for the next client.
 *
 *  What this adds over the connection is the load screen. The runtime's
 *  account startup reaches the attach step through its stdout handshake,
 *  and project startup reaches it through the socket's pre-RPC handshake.
 *  Both publish the transport-local `runtime.startup` event, and a lane
 *  that opens supersedes it. */
export function createSocketRuntimeClient(options: SocketRuntimeClientOptions): AttachedRuntimeClient {
  const listeners = new Set<(event: FrontendEvent) => void>()
  let closed = false
  let closing: Promise<void> | undefined

  const publish = (event: FrontendEvent): void => {
    if (closed) return
    for (const listener of listeners) listener(event)
  }
  const report = (status: RuntimeStartupStatus): void => publish({ type: "runtime.startup", status })

  // One ensure at a time. The connection dials once per attach, and a call
  // that arrives during a cold start waits for that same start rather than
  // spawning a second one; a rejected ensure is forgotten so the next attach
  // tries again from the probe. A closed client asks for no runtime: the
  // service may be ending in the same instant, and one started now would
  // outlive this client with nobody attached to it.
  let ensuring: Promise<void> | undefined
  const ensure = (): Promise<void> => {
    if (closed) return Promise.reject(new Error("runtime client is closed"))
    if (!ensuring) {
      ensuring = options.ensureRuntime(report).catch((cause: unknown) => {
        // The runtime said why it cannot serve; that is a fault now, not
        // something the next attempt heals within seconds.
        const error = errorMessage(cause)
        report({ kind: "failed", error })
        connection.fault(error, cause instanceof ServeStartupFailure ? cause.refusal : undefined)
        throw cause
      }).finally(() => {
        ensuring = undefined
      })
    }
    return ensuring
  }

  const connection = createRuntimeConnection({
    socket: bunSocketClientLayer(options.socketPath, ensure, options.connectionPreface, (phase) => report({ kind: "phase", ...phase })),
    onDiagnostic: (message, detail) => log.warn(message, { detail: diagnosticDetail(detail) }),
  })
  connection.onLane((lane) => {
    DebugLog.record({
      type: "runtime.client.socket_attached",
      payload: { socketPath: options.socketPath, lane },
    })
  })

  // A call's deadline starts when the runtime can answer it. A cold start can
  // run a migration for longer than any control-read deadline, and a query
  // that timed out behind it would read as a dead runtime.
  let attaching: Promise<void> | undefined
  let attached = false
  const ready = (): Promise<void> => {
    attaching ??= ensure().then(() => connection.ready()).then(() => {
      attached = true
      startupTrace("socket runtime client attached")
    }, (cause: unknown) => {
      // The next call asks again; a start that failed is not final.
      attaching = undefined
      throw cause
    })
    return attaching
  }
  // Once attached, the connection owns recovery, and a call reaches it in the
  // same turn it is made. A close that begins in that turn, such as the exit
  // command's, then finds the call in flight and lets it finish.
  const whenReady = <A>(call: () => Promise<A>): Promise<A> => attached ? call() : ready().then(call)

  function queryRuntime<Q extends RuntimeQuery>(query: Q): Promise<RuntimeQueryResult<Q>>
  function queryRuntime(query: RuntimeQuery) {
    return whenReady(() => connection.query(query))
  }

  const client: RuntimeClient = {
    query: queryRuntime,
    dispatch<C extends FrontendMutation>(mutation: C): Promise<MutationResult<C>> {
      return whenReady(() => connection.dispatch(mutation))
    },
    subscribe(listener: (event: FrontendEvent) => void): Unsubscribe {
      listeners.add(listener)
      const release = connection.subscribe(listener)
      return () => {
        listeners.delete(listener)
        release()
      }
    },
    close() {
      closing ??= (async () => {
        closed = true
        listeners.clear()
        await connection.close()
      })()
      return closing
    },
  }
  return { ...withLoggedRuntimeClient(client, log, "socket-runtime-client", "client"), onLane: connection.onLane, watchOutput: connection.watchOutput }
}
