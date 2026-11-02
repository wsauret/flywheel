import { mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { scanDebugLogFiles } from "../../../src/infra/debug-log.js"
import { listenInternalProcessChannel, type InternalProcessEndpoint } from "../../../src/infra/internal-process-channel.js"
import { Log } from "../../../src/infra/log.js"
import { withDeadline } from "../../../src/infra/with-deadline.js"
import { decodeProjectStateRequest, decodeProjectStateResponse } from "../../../src/orchestration/app-service/project-state-protocol.js"

/** The heartbeat period of a test executor, which the account also counts
 *  in: thirty silent periods, 6 s, prove it wedged. The account counts them
 *  from the executor's launch, and the launch takes real time, not test
 *  periods. On a loaded test host, an executor took up to 4.7 s from its
 *  launch to its first heartbeat, most of it in module imports that block
 *  its event loop. The bound must stay above that, or a slow launch reads
 *  as a wedge. */
export const TEST_EXECUTOR_HEARTBEAT_INTERVAL_MS = 200

/** The `kind` of one channel message, or undefined when it has none. */
export function frameKind(message: unknown): string | undefined {
  return typeof message === "object" && message !== null && "kind" in message && typeof message.kind === "string" ? message.kind : undefined
}

/** The account's side of one executor channel, where the executor's frames
 *  that `drop` names never arrive. Every other frame passes. */
export function dropFrames<Outgoing, Incoming>(endpoint: InternalProcessEndpoint<Outgoing, Incoming>, drop: (message: Incoming) => boolean): InternalProcessEndpoint<Outgoing, Incoming> {
  return {
    ...endpoint,
    onMessage: (handler) => endpoint.onMessage((message) => drop(message) ? undefined : handler(message)),
  }
}

/** The account's side of one executor channel, where the executor's
 *  heartbeats stop after its first heartbeat or after its ready frame. What
 *  comes before proves the executor is listening; the silence after it
 *  proves the executor wedged at thirty periods, so whatever waits for it to
 *  answer then ends it. Every other frame passes. */
export function silenceHeartbeatsAfter<Outgoing, Incoming>(endpoint: InternalProcessEndpoint<Outgoing, Incoming>, after: "first" | "ready"): InternalProcessEndpoint<Outgoing, Incoming> {
  let silent = false
  return dropFrames(endpoint, (message) => {
    const kind = frameKind(message)
    const drop = silent && kind === "heartbeat"
    if (kind === (after === "first" ? "heartbeat" : "ready")) silent = true
    return drop
  })
}

/** Holds the real reply to one session's durable pause. Actor close awaits
 *  this acknowledgement, so the executor stops admission but keeps its
 *  channels and heartbeat until release. Release in finally. Used by both
 *  the public executor stop and account-generation routing probes. */
export function holdStopAcknowledgement() {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const tenHeartbeats = Promise.withResolvers<void>()
  const activated = Promise.withResolvers<void>()
  const refused = Promise.withResolvers<void>()
  const lifecycle = Promise.withResolvers<() => Promise<void>>()
  let sessionId: string | undefined
  let pauseId: number | undefined
  let activationId: string | undefined
  let dispatchId: string | undefined
  let holding = false
  let answered = false
  let heartbeats = 0
  const listen: typeof listenInternalProcessChannel = (options) => listenInternalProcessChannel({
    ...options,
    onConnection(endpoint) {
      options.onConnection({
        ...endpoint,
        onMessage: (handler) => endpoint.onMessage((message) => {
          const kind = frameKind(message)
          if (kind === "ready") lifecycle.resolve(() => endpoint.send({ kind: "stop", clientsHold: true }))
          if (kind === "stopped") answered = true
          if (kind === "heartbeat" && holding && !answered && ++heartbeats >= 10) tenHeartbeats.resolve()
          if (typeof message === "object" && message !== null && "id" in message) {
            if (kind === "result" && message.id === activationId) activated.resolve()
            if (kind === "refused" && message.id === dispatchId) refused.resolve()
          }
          // An executor sends its session writes inside its generation wrapper.
          const request = decodeProjectStateRequest(message, "execution")
          const operation = request?.operation.kind === "execution.operation" ? request.operation.operation : undefined
          if (request && operation?.kind === "session.control" && operation.command.kind === "session.update-lifecycle"
            && operation.command.id === sessionId && operation.command.lifecycleState === "inactive") pauseId = request.id
          return handler(message)
        }),
        async send(message) {
          if (frameKind(message) === "dispatch" && typeof message === "object" && message !== null
            && "id" in message && typeof message.id === "string" && "mutation" in message
            && typeof message.mutation === "object" && message.mutation !== null && "type" in message.mutation) {
            if (message.mutation.type === "session.activate") activationId = message.id
            if (message.mutation.type === "session.send" && holding) dispatchId = message.id
          }
          const response = decodeProjectStateResponse(message)
          if (pauseId !== undefined && response?.id === pauseId && response.result.kind === "session-result"
            && response.result.result.kind === "session.update-lifecycle.result") {
            holding = true
            entered.resolve()
            await release.promise
          }
          return endpoint.send(message)
        },
      })
    },
  })
  return {
    listen, entered: entered.promise, tenHeartbeats: tenHeartbeats.promise, activated: activated.promise, refused: refused.promise,
    arm: (id: string) => { sessionId = id },
    release: () => release.resolve(),
    heartbeats: () => heartbeats,
    answered: () => answered,
    // The control composition exposes no executor owner. This is its real
    // authenticated lifecycle endpoint, not public executor.stop().
    sendStop: async () => { await (await withDeadline(lifecycle.promise, 10_000))() },
  }
}

/** Writes this process's log at INFO under `dir`. The account runs in the
 *  test process, so its records of executor control land there, with the
 *  one record of each executor generation's end that it decides. The log
 *  writes each record before the call returns, so a read sees every record
 *  written so far, in order, and the log stays open. `records` reads the
 *  fields of every record; `ends` reads only the end records; `close`
 *  closes the log. */
export async function recordAccountLog(dir: string) {
  mkdirSync(dir, { recursive: true })
  await Log.init({ dir, level: "INFO" })
  const logDir = join(dir, ".flywheel", "log")
  const records = (): { readonly [key: string]: unknown }[] =>
    [...scanDebugLogFiles(readdirSync(logDir).map((file) => join(logDir, file)), { types: ["log.error", "log.warn", "log.info"] })]
      .map((record) => typeof record.payload === "object" && record.payload !== null ? { ...record.payload } : {})
  return {
    records,
    async ends(): Promise<{ readonly [key: string]: unknown }[]> {
      return records().filter((fields) => "message" in fields && fields.message === "executor generation ending")
    },
    close: () => Log.closeGlobal(),
  }
}
