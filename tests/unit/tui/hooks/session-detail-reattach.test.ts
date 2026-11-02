import { describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import { createRuntimeConnection } from "../../../../src/protocol/client/connection.js"
import { createSessionDetailCache } from "../../../../src/tui/hooks/create-session-surface.js"
import { heartbeatRuntime, heldBackoff, waitFor } from "../../protocol/client/_connection-fixtures.js"

/** A detail hold over a real connection, across the reattach that the
 *  connection's lane rules shape. */
describe("a detail hold across a reattach", () => {
  it("reads a session retained while no lane is open once, on the next lane", async () => {
    const runtime = await heartbeatRuntime()
    const backoff = heldBackoff()
    const connection = createRuntimeConnection({ socket: runtime.client, random: () => 0, waitForBackoff: backoff.waitForBackoff })
    try {
      await createRoot(async (dispose) => {
        const cache = createSessionDetailCache(connection, connection)
        connection.subscribe(() => {})
        await runtime.heartbeat()
        await waitFor(() => connection.state === "connected")
        runtime.endLatest()
        await waitFor(() => backoff.waiting() === 1)
        // The read this hold starts waits for the lane, and the connection
        // drops it there, because a holder holds again on each new lane.
        const hold = cache.retain("child-1")
        backoff.release()
        await waitFor(() => runtime.connections() === 2)
        await Bun.sleep(50)
        expect(runtime.arrivals.slice(runtime.arrivals.lastIndexOf("events"))).toEqual(["events", "query:sessionDetailSnapshot"])
        hold.release()
        dispose()
      })
    } finally {
      await connection.close()
      await runtime.close()
    }
  })
})
