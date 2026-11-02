import type { EmitFn } from "../../infra/event-bus.js"
import { interruptedLabel } from "../../infra/output/run-labels.js"
import type { ConversationMessage } from "../agent-runtime/llm/types.js"
import { isRuntimeInterruption, type ControlInterruption, type PlannedCutInterrupt, type TurnInterruption } from "../session/conversation/turn-end-record.js"

/** The conversation a workflow turn owner holds, as its turn ends use it. */
interface HeldConversation {
  /** Records a turn end. A writer inside a turn holds it for its next save
   *  point, behind every turn end it holds already. */
  commitTurnEnd(by: TurnInterruption): Promise<ConversationMessage>
  /** Makes the turn ends held so far durable, at once or when the owner's
   *  turn ends, as the owner commits its turn's writes. */
  settleTurnEnds(): Promise<void>
}

/** The interruptions of one workflow turn owner, an agent's worker. It knows who the next turn end that the
 *  owner's loop records names, and whether the runtime's cut ended the
 *  owner's turn, so a person's interrupt of that turn is recorded through the
 *  owner's own conversation writer, as a chat's runner records it, and never
 *  through a second writer while the owner holds the conversation
 *  (ARCH-WORKFLOWS-020). */
export interface WorkflowTurnInterruptions {
  /** The owner holds its conversation from now on. The returned function
   *  ends the hold, before the owner disposes its writer. */
  hold(conversation: HeldConversation): () => void
  /** Cuts the owner's running turn as `by` through `interruptGeneration`.
   *  True when it cut a generation. */
  interrupt(by: TurnInterruption, interruptGeneration: () => boolean): boolean
  /** The owner's loop records its interrupted turn end through the held
   *  conversation, naming who cut the turn. */
  record(): Promise<ConversationMessage>
  /** The owner's loop took a person's message or Resume, so its turn runs
   *  again and no cut ended it. */
  resumed(): void
  /** The interrupt of a person or the parent agent, `by`, of the turn the
   *  runtime's cut ended (`PlannedCutInterrupt`). A turn that has recorded
   *  the cut parks, and the turn end that names `by` is recorded over it
   *  through the held conversation, which settles it as it settles the
   *  cut's own. A turn that still unwinds has not recorded yet, so its one
   *  record names `by`. Either way the owner shows the interrupt as an
   *  ordinary interrupt by `by` shows. `running` for a turn no cut ended,
   *  and `ended` when no owner holds the conversation. */
  interruptPlannedCut(by: ControlInterruption): Promise<PlannedCutInterrupt>
}

export function createWorkflowTurnInterruptions(input: {
  readonly emit: EmitFn
  readonly sessionId: string
  readonly currentInterruption: () => TurnInterruption
  readonly overrideInterruption: (by: ControlInterruption) => void
}): WorkflowTurnInterruptions {
  let held: HeldConversation | null = null
  // The runtime's cut of the owner's turn: `unwinding` until the loop has
  // recorded it, then `at-rest` while the loop parks on it.
  let cut: "unwinding" | "at-rest" | null = null
  return {
    hold(conversation) {
      held = conversation
      cut = null
      return () => { if (held === conversation) held = null }
    },
    interrupt(by, interruptGeneration) {
      // Set before the generation is cut, so the record the cut leads to
      // reads them however soon it runs.
      const before = cut
      if (isRuntimeInterruption(by)) cut = "unwinding"
      if (interruptGeneration()) return true
      cut = before
      return false
    },
    record() {
      if (held === null) return Promise.reject(new Error("No workflow turn holds a conversation to record its turn end in"))
      const by = input.currentInterruption()
      cut = cut === "unwinding" && isRuntimeInterruption(by) ? "at-rest" : null
      return held.commitTurnEnd(by)
    },
    resumed() {
      cut = null
    },
    async interruptPlannedCut(by) {
      const conversation = held
      if (conversation === null) return "ended"
      if (cut === null) return "running"
      const atRest = cut === "at-rest"
      cut = null
      input.overrideInterruption(by)
      input.emit("agent.system_message.recorded", { sessionId: input.sessionId, data: { message: interruptedLabel(by) } })
      if (atRest) {
        await conversation.commitTurnEnd(by)
        await conversation.settleTurnEnds()
      }
      return "recorded"
    },
  }
}
