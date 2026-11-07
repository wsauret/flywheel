import type { ChatInput } from "../../infra/chat-input.js"
import type { AsyncEventStateReadSurface } from "../../infra/event-store-types.js"
import { heldAtWakeLimit, liveWorkflowControl, type LiveRecipientState, type LiveSessionControl } from "../session/live-session-control.js"
import type { WorkflowAgentInput } from "./agent-inputs.js"
import type { WorkflowInjectionQueue } from "./injection-queue.js"

/** The live delivery of one running workflow agent's messages (`LiveSessionControl.deliver`). A message held behind an
 *  interrupt continues the agent through the workflow's hand-back: a person's message always, and a session's message
 *  only from the agent's parent. A delivered message enters the agent's queue once, and a person's message also ends
 *  the agent's capacity wait. Every message is refused while the agent hands off. */
export function workflowMemberDelivery(member: {
  readonly store: AsyncEventStateReadSurface
  readonly workflowId: string
  readonly queue: WorkflowInjectionQueue
  readonly input: Pick<WorkflowAgentInput, "resumeFromPerson" | "resumeFromParent">
  readonly state: () => LiveRecipientState
  /** Whether this delivery is the first of the message to the agent. */
  readonly claimDelivery: (message: ChatInput) => boolean
  readonly onQueued: (message: ChatInput) => void
  /** Ends a capacity wait at once, and whether one ended. */
  readonly continueNow: () => boolean
}): LiveSessionControl["deliver"] {
  const handBack = (continueMember: () => boolean): Promise<boolean | undefined> | undefined =>
    liveWorkflowControl(member.store, member.workflowId)?.handBackMember(continueMember)
  return async (input, decide) => {
    if (member.queue.isHandingOff) return { status: "refused", reason: "handing_off" }
    let outcome = decide(member.state())
    if (outcome.status === "refused") return outcome
    if (outcome.status === "held" && outcome.reason === "interrupted" && input.producer?.kind !== "session") {
      const continued = await handBack(() => member.input.resumeFromPerson())
      if (continued === undefined) return outcome
      if (continued) outcome = { status: "delivered", startsTurn: true }
    }
    if (member.queue.isHandingOff) return { status: "refused", reason: "handing_off" }
    if (member.claimDelivery(input)) {
      member.queue.enqueueMessage(input, { held: heldAtWakeLimit(outcome) })
      member.onQueued(input)
      // A person's message ends a capacity wait at once, and the run
      // that continues reads it (PI-MODEL-063).
      if (input.producer?.kind !== "session" && member.continueNow()) return { status: "delivered", startsTurn: true }
    }
    if (outcome.status === "held" && outcome.reason === "interrupted" && input.producer?.kind === "session" && input.producer.envelope?.relation === "parent" && await handBack(() => member.input.resumeFromParent()) === true) {
      return { status: "delivered", startsTurn: true }
    }
    return outcome
  }
}
