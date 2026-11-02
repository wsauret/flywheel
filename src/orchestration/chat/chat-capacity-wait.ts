import type { AsyncEventStateReadSurface } from "../../infra/event-store-types.js"
import type { SessionNoticeOperation } from "../../infra/session-notice.js"
import { createUnattendedRecovery } from "../agent-runtime/unattended-recovery.js"
import { capacityWaitAuthority } from "../session/capacity-wait.js"
import { capacityContinuations } from "../session/planned-session-continuation.js"

/** A chat's capacity wait (PI-MODEL-039): a turn whose every route is spent
 *  until a stated time waits for it and continues on its own, with its
 *  durable row armed in `eventStore`'s ledger. Every other failure stands,
 *  as it did: the person decides whether to send again. `resilience` is the
 *  pair of hooks the turn's runs take. */
export function createChatCapacityWait(input: {
  readonly sessionId: string
  readonly conversationId: string
  readonly eventStore: AsyncEventStateReadSurface
  readonly onNotice: (operation: SessionNoticeOperation) => void
}) {
  const recovery = createUnattendedRecovery({
    sessionId: input.sessionId,
    runId: input.conversationId,
    caller: "chat",
    agentName: "Chat",
    onNotice: input.onNotice,
    capacity: capacityWaitAuthority(input.eventStore, { target: { kind: "chat", sessionId: input.sessionId } }),
  })
  return {
    ...recovery,
    resilience: { recover: recovery.recover, settle: recovery.settle },
    /** Whether the chat's row owes a wait whose time lies ahead. A time
     *  that has passed is the executor's continuation's to continue. */
    async owesWaitAhead(): Promise<boolean> {
      const [owed] = await capacityContinuations(input.eventStore, [input.sessionId])
      return owed !== undefined && owed.continuesAt > Date.now()
    },
  }
}
