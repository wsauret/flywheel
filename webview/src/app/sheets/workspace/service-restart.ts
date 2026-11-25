import type { RuntimeConnection } from "../../../../../src/protocol/client/runtime/connection.js"
import { restartNoSuccessorReason } from "../../../../../src/protocol/client/runtime/copy/service-restart-copy.js"

/** How long a client waits, once the old service left, for a successor to
 *  answer. A manager restarts the service within seconds and a source run
 *  takes its snapshot first, so a longer silence means nothing will answer. */
const SUCCESSOR_DEADLINE_MS = 120_000

/** Asks the account service to restart (PI-INTERACTION-048) and settles once
 *  this connection is attached to the service's successor, which a start
 *  identity that differs from the old service's proves. A reattach to the
 *  same service, such as after a phone's network drop while running work
 *  still holds the restart, keeps waiting. A refusal rejects with the
 *  runtime's reason, and the service stops nothing; so does a request that
 *  never reached it. Once the old service left, a successor that does not
 *  answer within the deadline rejects with that reason. A successor whose
 *  web client differs replaces this page before the wait ends. */
export async function restartService(connection: Pick<RuntimeConnection, "dispatch" | "query" | "onStateChange">, successorDeadlineMs = SUCCESSOR_DEADLINE_MS): Promise<void> {
  const before = (await connection.query({ type: "restartReadiness" })).serviceStart
  const done = Promise.withResolvers<void>()
  // A deadline can pass before the answer arrives; the wait below reports it.
  done.promise.catch(() => {})
  let left = false
  let deadline: ReturnType<typeof setTimeout> | undefined
  const clearDeadline = () => {
    clearTimeout(deadline)
    deadline = undefined
  }
  // The listener is in place before the request, so a drop that comes right
  // after the answer is seen.
  const stop = connection.onStateChange((state) => {
    if (state !== "connected") {
      left = true
      deadline ??= setTimeout(() => done.reject(new Error(restartNoSuccessorReason(Math.round(successorDeadlineMs / 1000)))), successorDeadlineMs)
      return
    }
    if (!left) return
    left = false
    connection.query({ type: "restartReadiness" }).then((now) => {
      if (now.serviceStart !== before) done.resolve()
      else clearDeadline()
    }, () => {
      // The next attach asks again, and the deadline still runs.
      left = true
    })
  })
  try {
    const result = await connection.dispatch({ type: "service.restart" })
    if (!result.ok) throw new Error(result.error)
    await done.promise
  } finally {
    stop()
    clearDeadline()
  }
}
