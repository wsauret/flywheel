import { newestCall } from "../../../infra/output/newest-call.js"
import { isAgentInFlight, type AnyBlock } from "../../../infra/output-blocks.js"
import type { WorkflowAgentLive } from "../../../protocol/workflow-view-protocol-types.js"
import type { FrontendActivity } from "../../../protocol/app-service-types.js"

/** What one running agent of a workflow has done so far: the operations it
 *  ran, counted from its runtime events as its attempt's outcome counts them,
 *  the active time of its session's clock, and from the blocks of its own
 *  transcript its newest call, its pending messages, its live-only system
 *  notices, and the revision of its conversation. */
export function agentLive(sessionId: string, attemptId: string, operations: number | undefined, blocks: readonly AnyBlock[], runtimeActivity: FrontendActivity, time: Pick<WorkflowAgentLive, "duration" | "activeStartedAt">, interruptedAt?: number): WorkflowAgentLive {
  const activity = newestCall(blocks)
  return {
    attemptId,
    sessionId,
    ...(operations === undefined ? {} : { operations }),
    ...time,
    revision: conversationRevision(blocks),
    ...(activity === undefined ? { runtimeActivity } : { activity }),
    ...(interruptedAt === undefined ? {} : { interruptedAt }),
  }
}

/** A number that moves when the agent's conversation can hold a block that a
 *  reader of it has not read: a new block starts once the one before it was
 *  committed, and a call or a thought settles when its result is committed.
 *  A reader of the attempt's conversation reads it again when this moves,
 *  and no streamed word moves it. */
function conversationRevision(blocks: readonly AnyBlock[]): number {
  let settled = 0
  for (const block of blocks) {
    if (block.kind === "tool" && block.status !== "pending" && block.status !== "streaming") settled += 1
    else if (block.kind === "agentGroup" && !isAgentInFlight(block.status)) settled += 1
    else if (block.kind === "thinking" && block.status === "completed") settled += 1
  }
  return blocks.length + settled
}

