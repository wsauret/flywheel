import type { AsyncEventStateReadSurface, AsyncEventWriter } from "../../infra/event-store-types.js"
import { Log } from "../../infra/log.js"
import { loadAgentInputProjection } from "../session/agent-input-projection.js"
import { reconcileAgentInput } from "../session/agent-input-reconciliation.js"
import { createSessionFactWriter } from "../session/session-fact-writer.js"

const log = Log.create({ service: "workflow-agent-input-recovery" })

/** Folds settled ask_user questions into each recovering conversation before
 *  any agent of the workflow re-enters.
 *
 *  An agent of a workflow no longer asks the person (PI-AGENT-024), so a question
 *  that an agent of an earlier build left open is withdrawn here first, and its
 *  ask settles with a result that tells the agent to message its parent. Thus
 *  no stored question can hold a workflow from resuming. Remove the
 *  withdrawal after 2027-04-03. */
export async function reconcileWorkflowAgentInput(options: {
  sessionId: string
  store: AsyncEventStateReadSurface
  projectionReader: AsyncEventStateReadSurface
  writer: AsyncEventWriter
  conversationIds: readonly string[]
}): Promise<{ protectedToolUseIds: ReadonlySet<string> }> {
  const conversationIds = new Set(options.conversationIds)
  await withdrawRetiredStepQuestions(options, conversationIds)
  const protectedToolUseIds = new Set<string>()
  for (const conversationId of conversationIds) {
    const scoped = { conversationId, sessionId: options.sessionId, store: options.store, projectionReader: options.projectionReader, writer: options.writer } as const
    const outcome = await reconcileAgentInput({ ...scoped, interactionScope: "conversation" })
    for (const id of outcome.protectedToolUseIds) protectedToolUseIds.add(id)
  }
  return { protectedToolUseIds }
}

async function withdrawRetiredStepQuestions(
  options: { readonly sessionId: string; readonly projectionReader: AsyncEventStateReadSurface; readonly writer: AsyncEventWriter },
  conversationIds: ReadonlySet<string>,
): Promise<void> {
  const pending = [...(await loadAgentInputProjection(options.projectionReader, options.sessionId)).values()]
    .filter((interaction) => interaction.kind === "pending" && conversationIds.has(interaction.conversationId))
  if (pending.length === 0) return
  const writer = createSessionFactWriter({ sessionId: options.sessionId, writer: options.writer })
  try {
    for (const { interactionId } of pending) {
      await writer.record({ type: "agent_input.withdrawn", version: 2, actor: "flywheel", payload: { interactionId, reason: "child_question_retired" } })
    }
  } finally {
    writer.dispose()
  }
  log.info("retired agent questions withdrawn", { sessionId: options.sessionId, count: pending.length, reason: "child_question_retired" })
}
