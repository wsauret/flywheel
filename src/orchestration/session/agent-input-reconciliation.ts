import { contentEvidence } from "../../infra/content-evidence.js"
import type { AsyncEventStateReadSurface, AsyncEventWriter } from "../../infra/event-store-types.js"
import { InvariantViolation } from "../../infra/invariant.js"
import { hydrateToolContentFact } from "../../infra/tool-content-hydration.js"
import { parseSessionRuntimeFact } from "./session-runtime-event-types.js"
import { Log } from "../../infra/log.js"
import { answeredAskUserResult, retiredWorkflowLaunchText } from "../agent-runtime/tools/ask-user.js"
import { ASK_USER_CANCELLED_RESULT } from "../../infra/tools/displays/ask-user.js"
import { interruptedToolResult } from "../agent-runtime/llm/heal-messages.js"
import type { ConversationMessage } from "../agent-runtime/llm/types.js"
import { loadAgentInputProjection, type AgentInputEntry } from "./agent-input-projection.js"
import { createSessionFactWriter } from "./session-fact-writer.js"
import type { ConversationEntry } from "./conversation/conversation-entry-types.js"
import { tryOpenConversationTree } from "./conversation/conversation-tree-handle.js"

const log = Log.create({ service: "agent-input-reconciliation" })

/** The result of a question that an agent of a workflow asked before such
 *  agents stopped asking the person (PI-AGENT-024). Remove after 2027-04-03 with the
 *  withdrawal that writes it. */
const RETIRED_CHILD_QUESTION_RESULT = {
  content: "This question was withdrawn: only the root chat asks the person. If you still need the answer, send your parent the question with message_session and wait for its reply.",
  outcome: "cancelled",
} as const

interface ReconcileAgentInputOptions {
  conversationId: string
  sessionId: string
  store: AsyncEventStateReadSurface
  projectionReader?: AsyncEventStateReadSurface
  writer: AsyncEventWriter
  /** "session" (the default) requires every interaction in the session to
   *  belong to this conversation, which is chat's one-conversation shape.
   *  "conversation" considers only this conversation's interactions, for
   *  workflow sessions that own one tree per agent plus a follow-up. */
  interactionScope?: "session" | "conversation"
}

export interface AgentInputReconciliation {
  entries: ConversationEntry[] | null
  protectedPending: boolean
  completedLeaf: boolean
  /** Ask User owns terminal and pending state for these tool calls, so generic
   *  interrupted-tool repair must not synthesize a competing result. */
  protectedToolUseIds: readonly string[]
  /** Ask ids still awaiting an answer in the current open exchange. */
  pendingToolUseIds: readonly string[]
}

/** Reconciles human-input batches at activation.
 *
 *  Reads the committed branch only. This runs on a freshly opened tree, whose
 *  held turn belongs to whichever process is writing it and is therefore not
 *  visible here by construction. */
export async function reconcileAgentInput(options: ReconcileAgentInputOptions): Promise<AgentInputReconciliation> {
  const interactions = await withdrawRetiredWorkflowLaunches(options, await conversationInteractions(options))
  const interactionToolUseIds = [...interactions.values()].map((interaction) => interaction.toolUseId)
  const tree = await tryOpenConversationTree({
    ...options,
    store: options.projectionReader ?? options.store,
  })
  if (!tree) return {
    entries: null,
    protectedPending: false,
    completedLeaf: false,
    protectedToolUseIds: interactionToolUseIds,
    pendingToolUseIds: [],
  }
  try {
    const committed = await tree.getBranch()
    const assistantIndex = findOpenAskAssistant(committed, interactions)
    if (assistantIndex < 0) return {
      entries: committed,
      protectedPending: false,
      completedLeaf: false,
      protectedToolUseIds: toolUseIdsWithoutResults(interactionToolUseIds, committed),
      pendingToolUseIds: [],
    }
    const assistantEntry = committed[assistantIndex]
    if (!assistantEntry || assistantEntry.kind !== "message" || assistantEntry.message.kind !== "assistant") {
      throw new Error("agent-input reconciliation selected a non-assistant anchor")
    }
    const uses = typeof assistantEntry.message.content === "string"
      ? []
      : assistantEntry.message.content.filter((block) => block.type === "tool_use")
    const askUses = uses.filter((use) => use.name === "ask_user")
    const pendingToolUseIds = askUses
      .filter((use) => interactions.get(use.id)?.kind === "pending")
      .map((use) => use.id)
    const settledAskResults = new Map(askUses.flatMap((use) => {
      const state = interactions.get(use.id)
      if (!state || state.kind === "pending" || state.kind === "unreadable") return []
      if (state.kind === "withdrawn") {
        const withdrawn = withdrawnAskResult(state)
        return withdrawn ? [[use.id, withdrawn] as const] : []
      }
      const settled = state.kind === "answered"
        ? answeredAskUserResult(state.request, state.answers, state.decision, use.id)
        : { content: ASK_USER_CANCELLED_RESULT, outcome: "cancelled" as const }
      return [[use.id, settled] as const]
    }))
    await recordRecoveredToolResults(options, settledAskResults)

    const committedResultIds = toolResultIds(committed)
    const results: ConversationMessage[] = uses.flatMap((use) => {
      if (committedResultIds.has(use.id)) return []
      if (use.name !== "ask_user") return [interruptedToolResult(use)]
      const state = interactions.get(use.id)
      if (state?.kind === "pending") return []
      const settled = settledAskResults.get(use.id)
      if (!settled) return [interruptedToolResult(use)]
      return [{
        kind: "toolResult" as const,
        toolUseId: use.id,
        content: [{ type: "text" as const, text: settled.content }],
        ...(settled.outcome === "cancelled" ? { isError: true } : {}),
      }]
    })
    if (results.length > 0) {
      const outcome = await tree.appendMessages(results)
      if (outcome.kind === "notCommitted") {
        const refreshedResultIds = toolResultIds(await tree.getBranch())
        if (!results.every((result) => result.kind !== "toolResult" || refreshedResultIds.has(result.toolUseId))) throw outcome.cause
      }
    }
    const refreshed = await tree.getBranch()
    const completedLeaf = pendingToolUseIds.length === 0 && hasCompleteToolResultTail(refreshed, uses.map((use) => use.id))
    return {
      entries: refreshed,
      protectedPending: pendingToolUseIds.length > 0,
      completedLeaf,
      protectedToolUseIds: toolUseIdsWithoutResults(interactionToolUseIds, refreshed),
      pendingToolUseIds,
    }
  } finally {
    tree.getStorage().dispose()
  }
}

async function conversationInteractions(options: ReconcileAgentInputOptions): Promise<ReadonlyMap<string, AgentInputEntry>> {
  const loaded = await loadAgentInputProjection(options.projectionReader ?? options.store, options.sessionId)
  const interactions = options.interactionScope === "conversation"
    ? new Map([...loaded].filter(([, interaction]) => interaction.conversationId === options.conversationId))
    : loaded
  for (const interaction of interactions.values()) {
    if (interaction.conversationId !== options.conversationId) {
      throw new InvariantViolation({
        kind: "schema-mismatch",
        eventType: "agent_input.requested",
        eventPosition: -1,
        aggregateId: `session:${options.sessionId}`,
        detail: `interaction ${interaction.interactionId} belongs to conversation ${interaction.conversationId}, not ${options.conversationId}`,
      })
    }
  }
  return interactions
}

/** Closes each open question of an earlier build that asks to launch a
 *  workflow by name. No answer can grant that launch now, so the question
 *  never holds the conversation, and its ask settles with the name of the
 *  retired workflow. Remove after 2027-04-30. */
async function withdrawRetiredWorkflowLaunches(
  options: ReconcileAgentInputOptions,
  interactions: ReadonlyMap<string, AgentInputEntry>,
): Promise<ReadonlyMap<string, AgentInputEntry>> {
  const retired = [...interactions.values()].filter((interaction) => interaction.kind === "pending"
    && interaction.decision?.kind === "workflow_launch" && interaction.decision.source.kind === "registered")
  if (retired.length === 0) return interactions
  const writer = createSessionFactWriter({ sessionId: options.sessionId, writer: options.writer })
  try {
    for (const { interactionId } of retired) {
      await writer.record({ type: "agent_input.withdrawn", version: 2, actor: "flywheel", payload: { interactionId, reason: "workflow_launch_retired" } })
    }
  } finally {
    writer.dispose()
  }
  log.info("retired workflow launch questions withdrawn", { sessionId: options.sessionId, count: retired.length, reason: "workflow_launch_retired" })
  return conversationInteractions(options)
}

/** The settled result of a withdrawn question. A runtime interrupt settles
 *  none: its ask reads as an interrupted tool call, so the resumed turn asks
 *  again. */
function withdrawnAskResult(state: Extract<AgentInputEntry, { kind: "withdrawn" }>): { readonly content: string; readonly outcome: "cancelled" } | undefined {
  switch (state.reason) {
    case "runtime_interrupted":
      return undefined
    case "child_question_retired":
      return RETIRED_CHILD_QUESTION_RESULT
    case "workflow_launch_retired":
      return state.decision?.kind === "workflow_launch" && state.decision.source.kind === "registered"
        ? { content: retiredWorkflowLaunchText(state.decision.source.definitionId), outcome: "cancelled" }
        : undefined
  }
}

interface RecoveredToolCallIdentity {
  readonly modelRequestId?: string
  readonly parentToolUseId?: string
}

async function recordRecoveredToolResults(
  options: ReconcileAgentInputOptions,
  settledAskResults: ReadonlyMap<string, { readonly content: string; readonly outcome: "ok" | "cancelled" }>,
): Promise<void> {
  if (settledAskResults.size === 0) return
  const inputs = new Map<string, RecoveredToolCallIdentity>()
  const terminal = new Set<string>()
  const slice = await options.store.readSlice({
    aggregateId: `session:${options.sessionId}`,
    types: ["tool.input.completed", "tool.result.recorded"],
  })
  for (const stored of slice.facts) {
    // oxlint-disable-next-line eslint/no-throw-literal -- boundary: preserve the narrowed durable-row Error and its identity
    if (stored instanceof Error) throw stored
    // Stored tool results may carry content references; every strict parse reads the hydrated inline shape.
    const event = hydrateToolContentFact(stored, slice.toolContent)
    const fact = parseSessionRuntimeFact({ type: event.type, version: event.version, actor: event.actor, payload: event.payload })
    if (fact.type === "tool.input.completed") {
      inputs.set(fact.payload.toolUseId, {
        ...(fact.payload.modelRequestId ? { modelRequestId: fact.payload.modelRequestId } : {}),
        ...(fact.payload.parentToolUseId ? { parentToolUseId: fact.payload.parentToolUseId } : {}),
      })
    } else if (fact.type === "tool.result.recorded") {
      terminal.add(fact.payload.toolUseId)
    }
  }
  const writer = createSessionFactWriter({ sessionId: options.sessionId, writer: options.writer })
  try {
    for (const [toolUseId, settled] of settledAskResults) {
      const identity = inputs.get(toolUseId)
      if (!identity || terminal.has(toolUseId)) continue
      const evidence = contentEvidence(settled.content)
      await writer.record({
        type: "tool.result.recorded",
        version: 1,
        actor: "flywheel",
        payload: {
          toolUseId,
          outcome: settled.outcome,
          contentBytes: evidence.bytes,
          contentSha256: evidence.sha256,
          contentPreview: evidence.preview,
          contentTruncated: false,
          originalContentBytes: evidence.bytes,
          originalContentSha256: evidence.sha256,
          ...identity,
        },
      })
    }
  } finally {
    writer.dispose()
  }
}

function toolResultIds(entries: readonly ConversationEntry[]): Set<string> {
  const ids = new Set<string>()
  for (const entry of entries) {
    if (entry.kind === "message" && entry.message.kind === "toolResult") ids.add(entry.message.toolUseId)
  }
  return ids
}

function toolUseIdsWithoutResults(toolUseIds: readonly string[], entries: readonly ConversationEntry[]): string[] {
  const results = toolResultIds(entries)
  return toolUseIds.filter((toolUseId) => !results.has(toolUseId))
}

function hasCompleteToolResultTail(entries: readonly ConversationEntry[], toolUseIds: readonly string[]): boolean {
  if (toolUseIds.length === 0) return false
  const tail = entries.slice(-toolUseIds.length)
  if (tail.length !== toolUseIds.length) return false
  const resultIds = tail.flatMap((entry) => entry.kind === "message" && entry.message.kind === "toolResult" ? [entry.message.toolUseId] : [])
  return resultIds.length === toolUseIds.length && toolUseIds.every((id) => resultIds.includes(id))
}

function findOpenAskAssistant(entries: readonly ConversationEntry[], interactions: ReadonlyMap<string, unknown>): number {
  let index = entries.length - 1
  while (index >= 0) {
    const entry = entries[index]
    if (entry?.kind !== "message" || entry.message.kind !== "toolResult") break
    index -= 1
  }
  const entry = entries[index]
  if (entry?.kind !== "message" || entry.message.kind !== "assistant" || typeof entry.message.content === "string") return -1
  return entry.message.content.some((block) => block.type === "tool_use" && block.name === "ask_user" && interactions.has(block.id))
    ? index
    : -1
}
