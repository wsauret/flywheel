import type { AttachedRuntimeClient } from "../../../src/protocol/app-service-types.js"

/** Watches the live output of `sessionIds` on every lane of `client`, as a
 *  transcript store does for the session it shows: the runtime sends a
 *  session's output deltas only to a connection that watches it, and a
 *  watch ends with its lane. Returns the end of the watch. */
export function followOutput(client: Pick<AttachedRuntimeClient, "onLane" | "watchOutput">, sessionIds: readonly string[]): () => void {
  let releases: (() => void)[] = []
  const stopLanes = client.onLane(() => {
    releases = sessionIds.map((sessionId) => client.watchOutput(sessionId))
  })
  return () => {
    stopLanes()
    for (const release of releases) release()
  }
}
