import { asAsyncEventReadSurface, type EventStoreReadSurface, type StoredFact } from "../../infra/event-store-types.js"
import { readProviderRequestAuditFact } from "./provider-request-audit-facts.js"
import { hashAgentPrompt, hashSystemPrompt, hashToolSurface } from "./provider-request-audit-hash.js"
import {
  providerRequestIdentityFromPayload,
  providerRequestIdentityKey,
  type HistoricalProviderRequestAuditTool,
  type ProviderRequestAuditEntry,
  type ProviderRequestAuditTool,
  type ProviderRequestIdentity,
} from "./provider-request-audit-types.js"
import { buildSessionContext, walkBranchFromLeaf } from "./conversation/conversation-tree-context.js"
import { maskToolResultsById } from "../agent-runtime/compaction/stale-tool-result-masker.js"
import { createConversationTreeProjection } from "./conversation/conversation-projection.js"
import type { ConversationEntry } from "./conversation/conversation-entry-types.js"
import { lowerToolHistoryById } from "../agent-runtime/llm/tool-history-projection.js"
import { applyContentRepairs } from "../agent-runtime/llm/content-repair.js"
import { applyHistoryLowering } from "../agent-runtime/llm/provider-history.js"
import { FUNCTION_TOOL_PRESENTATION, presentToolHistory } from "../agent-runtime/llm/types.js"

/** The prompt of a recorded request, refolded from durable facts and checked
 *  against the recorded hash. */
interface ReconstructedProviderRequestPrompt {
  kind: "reconstructed"
  systemPrompt: string
  messages: unknown[]
  tools: readonly (ProviderRequestAuditTool | HistoricalProviderRequestAuditTool)[]
  computedSha256: string
  /** True when the reconstructed prompt's sha256 equals the stored
   *  `promptSha256`. A recorded chat/worker request whose first-of-turn prompt
   *  came straight from `buildSessionContext` verifies here even after the
   *  conversation is later compacted, because the fold walks the immutable
   *  parent chain of the recorded leaf rather than the live branch. */
  verified: boolean
}

/** A recorded request whose bytes cannot be recovered from durable facts. The
 *  evidence that IS recorded is still reported, so inspection states exactly
 *  what the substrate holds instead of implying a stronger audit than the
 *  request's save-point boundary provides (ARCH-CONTEXT-005, ARCH-CONTEXT-007). */
interface UnavailableProviderRequestPrompt {
  kind: "unavailable"
  reason: "no-durable-messages" | "system-prompt-body-missing" | "tool-surface-body-missing"
  detail: string
  /** The recorded identity of the assembled prompt. Always present: it is part
   *  of the Tier-1 Ref. */
  promptSha256: string
  /** Recorded system-prompt body, or null when that body is what is missing. */
  systemPrompt: string | null
  /** Recorded tool surface, or null when that body is what is missing. */
  tools: readonly (ProviderRequestAuditTool | HistoricalProviderRequestAuditTool)[] | null
}

export type ProviderRequestPromptReconstruction =
  | ReconstructedProviderRequestPrompt
  | UnavailableProviderRequestPrompt

interface ReconstructDeps {
  entry: ProviderRequestAuditEntry
  store: EventStoreReadSurface
  /** The session aggregate's events, already fetched by the caller to load the
   *  audit entry. The system-prompt body lives in these `prompt.assembled`
   *  facts, so threading them in avoids a second read of the same aggregate. */
  sessionEvents: readonly StoredFact[]
}

/**
 * Reconstructs the full prompt for a recorded provider request by historical-
 * fold: fold the `conversation:<conversationId>` tree up to the recorded leaf
 * entry and assemble it through the same `buildSessionContext` path the runtime
 * used, then combine with the referenced system prompt and tool surface and
 * verify against the stored `promptSha256`.
 *
 * Lives in the SESSION layer (not agent-runtime) so agent-runtime imports
 * nothing from `session/conversation`.
 */
export async function reconstructProviderRequestPrompt(
  deps: ReconstructDeps,
): Promise<ProviderRequestPromptReconstruction> {
  const { entry } = deps
  const strict = entry.auditVersion !== undefined && entry.auditVersion >= 3
  const prompt = entry.prompt
  if (!prompt) throw new Error(`provider request ${entry.requestId} has no prompt Ref to reconstruct`)
  const systemPrompt = resolveSystemPrompt(deps.sessionEvents, entry.identity, prompt.systemPromptHash)
  const tools = entry.toolSurface?.tools ?? null
  const unavailable = (
    reason: UnavailableProviderRequestPrompt["reason"],
    detail: string,
  ): UnavailableProviderRequestPrompt => ({
    kind: "unavailable",
    reason,
    detail,
    promptSha256: prompt.promptSha256,
    systemPrompt,
    tools,
  })

  const treePointer = prompt.treePointer
  if (!treePointer) {
    return unavailable(
      "no-durable-messages",
      `provider request ${entry.requestId} used a non-durable conversation, so its message bytes are not recoverable`,
    )
  }
  if (systemPrompt === null) {
    const detail = `no stored system prompt body for hash ${prompt.systemPromptHash} in conversation ${treePointer.conversationId}`
    if (strict) throw new Error(detail)
    return unavailable("system-prompt-body-missing", `${detail}; the first-seen body write did not persist`)
  }
  if (tools === null) {
    const detail = `no stored tool surface for hash ${prompt.toolSurfaceHash} in conversation ${treePointer.conversationId}`
    if (strict) throw new Error(detail)
    return unavailable("tool-surface-body-missing", `${detail}; the first-seen body write did not persist`)
  }
  if (strict) {
    if (hashSystemPrompt(systemPrompt) !== prompt.systemPromptHash) throw new Error(`system prompt body does not match hash ${prompt.systemPromptHash}`)
    if (hashToolSurface(tools, entry.toolSurface?.omittedTools ?? []) !== prompt.toolSurfaceHash) throw new Error(`tool surface body does not match hash ${prompt.toolSurfaceHash}`)
  }

  const branch = await foldBranchToLeaf(deps.store, treePointer.conversationId, treePointer.leafEntryId)
  const assembled = buildSessionContext(branch).messages
  // Replay the recorded stale-result mask (deterministic placeholders keyed by
  // toolUseId) so the reassembled prompt matches the masked bytes that were
  // actually sent and hashed.
  const staleMasking = prompt.staleMasking
  const maskedMessages = staleMasking
    ? maskToolResultsById(assembled, staleMasking.maskedToolUseIds, staleMasking.maskedToolUseInputIds ?? [])
    : assembled
  // The recorded branch holds every content-repair decision the request applied;
  // replay them between masking and lowering, the order of the live rebuild.
  // The provider-history edits follow, as the serving attempt applied them. A
  // request whose lowering changed nothing, or recorded before 2026-10-27, has none.
  const canonicalMessages = applyHistoryLowering(lowerToolHistoryById(
    applyContentRepairs(maskedMessages),
    prompt.toolHistoryProjection?.loweredToolUseIds ?? [],
  ), prompt.historyLowering?.edits ?? [])
  const toolNames = new Map(tools.flatMap((tool) => "executableId" in tool ? [[tool.executableId, tool.name] as const] : []))
  const presentedMessages = presentToolHistory(canonicalMessages, {
    ...FUNCTION_TOOL_PRESENTATION,
    wireName: (name) => toolNames.get(name) ?? name,
  })
  const messages: unknown[] = prompt.requestContext === undefined
    ? presentedMessages
    : [...presentedMessages, { kind: "user", content: prompt.requestContext }]

  const computedSha256 = hashAgentPrompt({ systemPrompt, messages, tools })
  return {
    kind: "reconstructed",
    systemPrompt,
    messages,
    tools,
    computedSha256,
    verified: computedSha256 === prompt.promptSha256,
  }
}

// Fold the recorded conversation tree up to the recorded leaf via its immutable
// parent chain, reproducing the branch as it existed when the request was
// made, independent of later appends or compaction.
async function foldBranchToLeaf(
  store: EventStoreReadSurface,
  conversationId: string,
  leafEntryId: string | null,
): Promise<ConversationEntry[]> {
  const { entriesById } = await createConversationTreeProjection(asAsyncEventReadSurface(store), conversationId).replay()
  return walkBranchFromLeaf(entriesById, leafEntryId, (gap) => {
    if (gap.kind === "leaf") throw new Error(`conversation ${conversationId} has no entry ${gap.leafEntryId} to fold from`)
    throw new Error(`conversation ${conversationId} entry ${gap.childId} references missing parent ${gap.parentId}`)
  })
}

/** The system prompt body is stored once per distinct hash within a
 *  conversation (within-conversation dedup). Finds the first `prompt.assembled`
 *  fact in this conversation that carried the body for `systemPromptHash`,
 *  scanning the session events the caller already loaded. Null means the body
 *  is not in the log: the write that carried it did not persist. */
function resolveSystemPrompt(
  sessionEvents: readonly StoredFact[],
  identity: ProviderRequestIdentity,
  systemPromptHash: string,
): string | null {
  for (const event of sessionEvents) {
    if (event.type !== "prompt.assembled") continue
    const fact = readProviderRequestAuditFact(event)
    if (fact.type !== "prompt.assembled") continue
    if (providerRequestIdentityKey(providerRequestIdentityFromPayload(fact.payload)) !== providerRequestIdentityKey(identity)) continue
    if (fact.payload.systemPromptHash !== systemPromptHash) continue
    if (fact.payload.systemPrompt !== undefined) return fact.payload.systemPrompt
  }
  return null
}
