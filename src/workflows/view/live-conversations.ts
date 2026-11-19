import type { WorkflowView } from "./types.js"

/** The conversations that a Resume of the run continues: the follow-up's
 *  when the run has one, else the conversation of every attempt that
 *  started and did not finish. Parallel agents pause together, so a run can
 *  hold several, in row order. A settled attempt's conversation is never
 *  one of them. */
export function liveWorkflowConversations(queue: WorkflowView): readonly string[] {
  if (queue.followUpConversationId !== undefined) return [queue.followUpConversationId]
  return queue.attempts.flatMap(({ status, lastConversationId }) =>
    (status === "pending" || status === "running") && lastConversationId !== undefined ? [lastConversationId] : [])
}

/** The conversations that a Resume prepares before it runs, each once:
 *  those of {@link liveWorkflowConversations}, and in a failed run the
 *  conversation of each failed attempt, because the Resume runs a failed
 *  attempt again in the conversation that it recorded, as it continued a
 *  paused attempt. A reopened attempt that failed again failed in the same
 *  conversation as the attempt that it reopened. */
export function resumedWorkflowConversations(queue: WorkflowView): readonly string[] {
  const failed = queue.status === "failed"
    ? queue.attempts.flatMap(({ status, lastConversationId }) => status === "failed" && lastConversationId !== undefined ? [lastConversationId] : [])
    : []
  return [...new Set([...liveWorkflowConversations(queue), ...failed])]
}
