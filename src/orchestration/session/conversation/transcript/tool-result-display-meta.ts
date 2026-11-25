import type { MutationEvidence } from "../../../../infra/substrate/mutation-evidence.js"
import type { AgentFailureDisplay } from "../../../../infra/substrate/events/output-blocks.js"
import type { ToolResultAction } from "../../../../infra/substrate/events/tool-result-action.js"
import type { ToolOutcome } from "../../../../infra/substrate/runtime-facts/tool-outcome.js"

/** Display meta a completed tool's `tool.result.recorded` fact carried.
 *  Edit/replace diffs and filetypes live in the result `details`, not in the
 *  tool_use input the chat tree persists, so derived-history projections read
 *  this map to render the same diffs the live stream did. */
export interface ToolResultDisplayMeta {
  /** Terminal outcome from the real execution result. Deferred acknowledgements
   * in the conversation tree are not terminal evidence. */
  readonly terminalOutcome?: ToolOutcome
  /** Full user-facing result body, independent of model-context budgeting. */
  readonly displayContent?: string
  readonly diff?: string
  readonly filetype?: string
  readonly exitCode?: number
  readonly background?: boolean
  readonly executionOutput?: string
  readonly resultAction?: ToolResultAction
  readonly agentFailure?: AgentFailureDisplay
  /** Canonical artifact of the durable mutation the tool published, from its
   *  result or, for a mutating command that settled later, its settled record. */
  readonly mutationEvidence?: MutationEvidence
  /** The display name of the session the call addressed, whatever its outcome. */
  readonly targetName?: string
  /** The line of an ok result whose work now waits, such as a held message:
   *  its row settles as waiting with this line. */
  readonly statusMessage?: string
  /** The call read a short-form tool's contract (PI-AGENT-131). */
  readonly contractRead?: true
  /** When the background command the call started ended, from its settled
   *  background index record. */
  readonly endedAt?: number
}
