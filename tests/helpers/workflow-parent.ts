import { expect } from "bun:test"
import type { ProjectDirectories } from "../../src/infra/directory-authorities.js"
import type { AsyncEventStateReadSurface, AsyncEventWriter } from "../../src/infra/event-store-types.js"
import { recoverProject } from "./project-recovery.js"
import { chatSessionActions, readChatTurnEnd } from "../../src/orchestration/session/chat-session-run-evidence.js"
import type { SessionManager } from "../../src/orchestration/session/manager.js"
import { removeOwnerPid } from "../../src/orchestration/session/pid-lock.js"
import type { WorkflowLaunchBinding } from "../../src/orchestration/session/child-session-publication.js"
import { projectBlocksFromEntries } from "../../src/orchestration/session/conversation/conversation-block-projection.js"
import { buildSessionContext } from "../../src/orchestration/session/conversation/conversation-tree-context.js"
import { readTranscript } from "../../src/orchestration/session/conversation/conversation-tree-handle.js"
import { isSettledRecord } from "../../src/orchestration/session/conversation/turn-end-record.js"
import type { MessageEntry } from "../../src/orchestration/session/conversation/conversation-entry-types.js"
import { WORKFLOW_LAUNCH_OPERATION_KIND } from "../../src/orchestration/workflow-host/launch-operation-contract.js"

/** Answers the launch binding of a workflow published under a chat. Every
 *  workflow has a chat parent: the manager refuses a publication whose parent
 *  is not the chat conversation the binding names. Without `parentSessionId`,
 *  the helper creates an inactive parent chat first. */
export async function workflowParentBinding(
  manager: Pick<SessionManager, "createChat" | "read">,
  input: {
    readonly workflowDefinitionId: string
    readonly description?: string
    readonly toolUseId?: string
    readonly parentSessionId?: string
  },
): Promise<WorkflowLaunchBinding> {
  const parentSessionId = input.parentSessionId ?? await manager.createChat({ name: "Parent chat", initialState: "inactive" })
  const parent = await manager.read(parentSessionId)
  if (parent?.kind !== "chat") throw new Error(`Workflow parent ${parentSessionId} is not a chat`)
  return {
    parentSessionId,
    conversationId: parent.conversationId,
    workflowDefinitionId: input.workflowDefinitionId,
    toolUseId: input.toolUseId ?? `workflow-${crypto.randomUUID()}`,
    ...(input.description !== undefined ? { description: input.description } : {}),
  }
}

/** Proves that a runtime launch left its parent chat settled: the launch's
 *  acknowledgement is a recorded turn end that admits no Resume, the parent
 *  holds no launch cell, and an ownerless recovery pass that claims the
 *  parent, as it would after its owner died, appends nothing to its
 *  conversation. The parent ends inactive, as that pass leaves it.
 *
 *  Each settled record also reads as one user message to the model, with no
 *  provider tool exchange for a launch, and shows to a person as their own
 *  message or, when the runtime wrote it, as a system row. Answers those
 *  records, oldest first. */
export async function expectSettledLaunchParent(input: {
  readonly reader: AsyncEventStateReadSurface
  readonly writer: AsyncEventWriter
  readonly manager: SessionManager
  readonly directories: ProjectDirectories
  readonly parentSessionId: string
}): Promise<readonly MessageEntry["message"][]> {
  const parent = await input.manager.read(input.parentSessionId)
  if (parent?.kind !== "chat") throw new Error(`Launch parent ${input.parentSessionId} is not a chat`)
  const turnEnd = await readChatTurnEnd(input.reader, parent.conversationId)
  expect(turnEnd).toEqual({ end: { reason: "settled" }, recorded: true })
  const branch = await readTranscript({ conversationId: parent.conversationId, sessionId: input.parentSessionId, store: input.reader }) ?? []
  const records = branch.flatMap((entry) => entry.kind === "message" && isSettledRecord(entry) && entry.message?.kind === "user" ? [entry.message] : [])
  expect(records.length).toBeGreaterThan(0)
  const children = await Promise.all((parent.childSessionIds ?? []).map((childSessionId) => input.manager.read(childSessionId)))
  const launchCalls = new Set(children.flatMap((child) => child?.launchedFrom?.toolUseId ?? []))
  const context = buildSessionContext(branch, { allowAssistantTail: true }).messages
  expect(context.filter((message) => message.kind === "toolResult" && launchCalls.has(message.toolUseId))).toEqual([])
  expect(context.flatMap((message) => message.kind === "assistant" && Array.isArray(message.content) ? message.content.filter((block) => block.type === "tool_use" && launchCalls.has(block.id)) : [])).toEqual([])
  const rows = projectBlocksFromEntries(branch, { executionCwd: input.directories.projectRoot })
  for (const record of records) {
    expect(rows).toContainEqual(record.origin === "system"
      ? expect.objectContaining({ kind: "system", message: record.content })
      : expect.objectContaining({ kind: "userMessage", content: record.content }))
  }
  expect(await input.reader.readInFlight(input.parentSessionId, WORKFLOW_LAUNCH_OPERATION_KIND)).toEqual([])
  expect(chatSessionActions("chat", parent.lifecycleState, turnEnd)).not.toContain("chat.resume")
  const conversation = `conversation:${parent.conversationId}`
  const sequence = await input.reader.aggregateSeq(conversation)
  // Recovery claims only an active session whose owner is gone, so the
  // parent is left as a process that died holding it would leave it.
  if (parent.lifecycleState === "inactive") await input.manager.updateLifecycleState(input.parentSessionId, "active")
  removeOwnerPid(input.parentSessionId, input.directories.projectRoot)
  const recovered = await recoverProject({ directories: input.directories, reader: input.reader, writer: input.writer }, "ownerless")
  expect(recovered.sessionIds).toContain(input.parentSessionId)
  expect(await input.reader.aggregateSeq(conversation)).toBe(sequence)
  return records
}
