import { contentEvidence } from "../../../../infra/runtime-facts/content-evidence.js"
import { createRuntimeEvent } from "../../../../infra/runtime-facts/runtime-event-factory.js"
import { mapRuntimeEventToSessionRuntimeFacts } from "../../../../infra/runtime-facts/runtime-fact-mapper.js"
import type { ToolOutcome } from "../../../../infra/runtime-facts/tool-outcome.js"
import type { ToolExecutionEntry } from "../../runtime-facts/tool-execution-types.js"
import type { tryOpenConversationTree } from "../../conversation/tree/conversation-tree-handle.js"

/** Old result bytes remain the notification identity when only workflow terminology changed. */
export function retainedSettledContent(content: string, workflowId: string, tool: ToolExecutionEntry): string {
  const previous = content.replace(`(workflow ${workflowId})`, `(session ${workflowId})`).replace("from its workflow card.", "from its session.")
  return tool.contentSha256 === contentEvidence(previous).sha256 ? previous : content
}

/** Prepares the canonical result without inventing provider identity for
 *  runtime invocations. An adoption names only the call it publishes in the
 *  same batch, which no timeline holds yet. */
export function childSessionResultFact(tool: Pick<ToolExecutionEntry, "toolUseId" | "modelRequestId" | "parentToolUseId">, content: string, outcome: ToolOutcome) {
  const [fact] = mapRuntimeEventToSessionRuntimeFacts(createRuntimeEvent("tool.result.recorded", {
    tool_use_id: tool.toolUseId,
    content: [{ type: "text", text: content }],
    outcome,
    ...(tool.modelRequestId ? { model_request_id: tool.modelRequestId } : {}),
    ...(tool.parentToolUseId ? { parent_tool_use_id: tool.parentToolUseId } : {}),
  }))
  if (!fact || fact.type !== "tool.result.recorded") throw new Error("Workflow completion did not produce a result fact")
  return fact
}

/** The name a workflow's completion and Stop words use: the goal its call
 *  input records, or else its definition id. A completion recorded earlier
 *  is found again by these exact words, so every writer of them reads this. */
export function workflowNotificationLabel(input: ToolExecutionEntry["input"], workflowDefinitionId: string): string {
  const summary = input?.summary ?? input?.task_summary
  return typeof summary === "string" && summary.length > 0 ? summary : workflowDefinitionId
}

export function isCompletionEntry(
  entry: Awaited<ReturnType<NonNullable<Awaited<ReturnType<typeof tryOpenConversationTree>>>["getEntry"]>>,
  message: string,
): boolean {
  return entry?.kind === "message"
    && entry.message.kind === "user"
    && entry.message.origin === "system"
    && entry.message.content === message
    && entry.message.replyRequired === true
}

/** The entry a live completion, Stop, or start failure of a workflow child
 *  commits in its parent. A result that differs from the one its parent
 *  already read is a new outcome, such as a resumed run's, and gets its own
 *  entry; `revision` names that outcome, so a repeated reconciliation of it
 *  finds the same entry. */
export function workflowCompletionEntryId(
  childSessionId: string,
  revision: number | string,
  message: string,
  existingBaseEntry: Parameters<typeof isCompletionEntry>[0],
): string {
  return existingBaseEntry && !isCompletionEntry(existingBaseEntry, message)
    ? revisedCompletionEntryId(childSessionId, revision, message)
    : `workflow-completion:${childSessionId}`
}

/** The entry of an outcome that differs from the one its parent already read or holds. */
export function revisedCompletionEntryId(childSessionId: string, revision: number | string, message: string): string {
  return `workflow-completion:${childSessionId}:${revision}:${contentEvidence(message).sha256}:reply-required`
}
