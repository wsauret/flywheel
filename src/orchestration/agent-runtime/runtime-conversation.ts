import type { AgentLoopPersistence, AgentLoopSeed } from "./agent-loop-types.js";
import { promptKindForPurpose } from "./agent-purpose.js";
import { createProviderRequestAuditWriter } from "./llm/provider-request-audit.js";
import type { AgentConversation, AgentOptions } from "./types.js";
import { projectToolHistoryAsContext } from "./llm/tool-history-projection.js";

export interface RuntimeConversation {
  readonly providerSessionKey: string;
  readonly artifactScopeId: string;
  readonly retrievalSessionId: string;
  readonly sessionId?: string;
  readonly aggregateId?: string;
  readonly requestAccounting?: Extract<AgentConversation, { kind: "replay" }>["requestAccounting"];
  readonly resolveLeafId?: () => Promise<string | null>;
  readonly flush?: (protectedToolUseIds?: ReadonlySet<string>) => Promise<void>;
  readonly awaitDurableFacts?: () => Promise<void>;
  readonly persistence: AgentLoopPersistence;
  readonly seed: () => AgentLoopSeed | Promise<AgentLoopSeed>;
}

export interface RuntimeConversationFallbacks {
  readonly providerSessionKey: string;
  readonly artifactScopeId: string;
  readonly retrievalSessionId: string;
}

const EMPTY_PERSISTENCE: AgentLoopPersistence = { history: { append: () => {} } };
function sessionScopes(sessionId: string | undefined, fallbacks: RuntimeConversationFallbacks) {
  return {
    artifactScopeId: sessionId ?? fallbacks.artifactScopeId,
    retrievalSessionId: sessionId ?? fallbacks.retrievalSessionId,
  };
}

export function resolveRuntimeConversation(conversation: AgentConversation, fallbacks: RuntimeConversationFallbacks): RuntimeConversation {
  switch (conversation.kind) {
    case "durable-tree":
      return {
        ...sessionScopes(conversation.sessionId, fallbacks),
        providerSessionKey: conversation.providerSessionKey ?? fallbacks.providerSessionKey,
        sessionId: conversation.sessionId,
        aggregateId: conversation.conversationId,
        resolveLeafId: conversation.resolveLeafId,
        flush: conversation.flush,
        awaitDurableFacts: conversation.awaitDurableFacts,
        persistence: {
          history: {
            append: conversation.append,
            reserveId: conversation.reserveMessageId,
            releaseId: conversation.releaseMessageId,
          },
          captureCommittedForkMessages: conversation.captureCommittedForkMessages,
          committedTree: conversation.committedTree,
          ...(conversation.recordInterruption ? { recordInterruption: conversation.recordInterruption } : {}),
          ...(conversation.recordCompaction ? { recordCompaction: conversation.recordCompaction } : {}),
        },
        seed: () => ({ kind: "resume", priorMessages: [...conversation.priorMessages] }),
      };
    case "replay":
      return {
        ...sessionScopes(conversation.sessionId, fallbacks),
        providerSessionKey: conversation.providerSessionKey ?? fallbacks.providerSessionKey,
        sessionId: conversation.sessionId,
        persistence: EMPTY_PERSISTENCE,
        ...(conversation.requestAccounting ? { requestAccounting: conversation.requestAccounting } : {}),
        seed: () => ({
          kind: "resume",
          priorMessages: conversation.historyProjection === "context-only"
            ? projectToolHistoryAsContext(conversation.priorMessages)
            : [...conversation.priorMessages],
        }),
      };
    case "ephemeral":
      return {
        ...sessionScopes(undefined, fallbacks),
        providerSessionKey: fallbacks.providerSessionKey,
        persistence: { history: { append: conversation.append } },
        seed: () => ({ kind: "fresh" }),
      };
    case "stateless":
      return {
        ...sessionScopes(undefined, fallbacks),
        providerSessionKey: fallbacks.providerSessionKey,
        persistence: EMPTY_PERSISTENCE,
        seed: () => ({ kind: "fresh" }),
      };
  }
}

export function createRuntimeRequestAudit(
  options: AgentOptions,
  conversation: RuntimeConversation,
): ReturnType<typeof createProviderRequestAuditWriter> {
  const writer = conversation.requestAccounting?.writer ?? options.sessionEventWriter;
  return createProviderRequestAuditWriter({
    ...(conversation.sessionId ? { sessionId: conversation.sessionId } : {}),
    ...(conversation.requestAccounting ? { owner: conversation.requestAccounting.owner } : conversation.sessionId ? { owner: { kind: "session" as const, sessionId: conversation.sessionId } } : {}),
    ...(writer ? { writer } : {}),
    identity: {
      providerSessionKey: conversation.providerSessionKey,
      ...(conversation.aggregateId ? { conversationId: conversation.aggregateId } : {}),
    },
    promptKind: promptKindForPurpose(options.purpose),
    ...(options.purpose.kind === "workflow-agent" ? { workflowAttemptId: options.purpose.workflowAttemptId } : {}),
    ...(conversation.resolveLeafId ? { resolveTreeLeafEntryId: conversation.resolveLeafId } : {}),
    ...(options.purpose.kind === "subagent" ? { parentToolUseId: options.purpose.parentToolUseId } : {}),
    ...(options.auditObserver ? { observe: options.auditObserver } : {}),
  });
}
