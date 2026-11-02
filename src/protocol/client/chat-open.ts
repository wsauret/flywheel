import { generateSessionId } from "../../infra/session-id.js"
import type { AttachedRuntimeClient, FrontendMutation, MutationResult } from "../app-service-types.js"
import { lostWithLane } from "./connection-failures.js"

/** Opens a new chat under an id this client chooses, and answers the chat's
 *  id once the runtime has opened it. Rejects with the runtime's own words
 *  when it refuses.
 *
 *  An open whose lane ends before the runtime answers may have opened the
 *  chat or not, and the client cannot tell which. The open names its chat,
 *  so it goes out again once a newer lane opens, and the runtime answers
 *  that copy with the chat the first one opened: a lost answer never leaves
 *  a second chat (ARCH-SESSIONS-030). So a lost connection never fails the open; it
 *  waits for the connection, as a waiting message does. */
export async function openChat(client: Pick<AttachedRuntimeClient, "dispatch" | "onLane">): Promise<string> {
  const sessionId = generateSessionId()
  let lane = 0
  let opened: (() => void) | undefined
  const stopLanes = client.onLane((next) => {
    lane = next
    opened?.()
  })
  const nextLane = (): Promise<void> => new Promise((resolve) => { opened = resolve })
  try {
    for (;;) {
      const sentOn = lane
      let result: MutationResult<Extract<FrontendMutation, { type: "chat.open" }>>
      try {
        result = await client.dispatch({ type: "chat.open", sessionId })
      } catch (cause) {
        if (!lostWithLane(cause)) throw cause
        // The lane the open went out on is gone. A newer lane that opened
        // meanwhile takes the copy at once; otherwise the copy waits for one.
        if (lane === sentOn) await nextLane()
        continue
      }
      if (!result.ok) throw new Error(result.error)
      if (!result.sessionId) throw new Error("The runtime did not return the created session ID")
      return result.sessionId
    }
  } finally {
    stopLanes()
  }
}
