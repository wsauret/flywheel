import { contentEvidence } from "../../../../infra/runtime-facts/content-evidence.js"
import type { StoredFact } from "../../../../infra/store/event-store-types.js"
import { parseSubagentRunFact, type SubagentRunFact } from "../facts.js"
import type {
  SubagentCompletionInput,
  DurableSubagentRunCreateInput,
  SubagentInterruptionInput,
  SubagentPauseInput,
  SubagentPromptInput,
  SubagentResumeInput,
} from "./subagent-run-types.js"

export interface SubagentRunFactWriter {
  record(fact: SubagentRunFact): Promise<StoredFact | null>
}

export function buildDurableSubagentCreated(input: DurableSubagentRunCreateInput): SubagentRunFact {
  return parseSubagentRunFact({
    type: "child_run.created",
    version: 3,
    actor: "flywheel",
    payload: {
      childSessionId: input.childSessionId,
      childRunId: input.childRunId,
      conversationId: input.conversationId,
      parentSessionId: input.parentSessionId,
      parentConversationId: input.parentConversationId,
      parentToolCallId: input.parentToolCallId,
      ...(input.modelRequestId ? { modelRequestId: input.modelRequestId } : {}),
      persona: input.persona,
      capabilityGrant: {
        ...input.capabilityGrant,
        required: [...input.capabilityGrant.required],
        capabilities: [...input.capabilityGrant.capabilities],
        moduleIds: [...input.capabilityGrant.moduleIds],
      },
      admittedModuleIds: [...input.admittedModuleIds],
      skillsRevision: input.skillsRevision,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.effort ? { effort: input.effort } : {}),
      tools: [...input.tools],
      executionCwd: input.executionCwd,
      budget: input.budget,
      parentDepth: input.parentDepth,
      description: input.description,
      ...(input.fork ? { fork: true } : {}),
    },
  })
}

export function buildSubagentPrompted(input: SubagentPromptInput): SubagentRunFact {
  return parseSubagentRunFact({
    type: "subagent.prompted",
    version: 3,
    actor: "flywheel",
    payload: {
      childRunId: input.childRunId,
      prompt: input.prompt,
      task: input.task,
      toolNames: [...input.toolNames],
    },
  })
}

export function buildSubagentCompleted(input: SubagentCompletionInput): SubagentRunFact {
  const result = contentEvidence(input.content)
  return parseSubagentRunFact({
    type: "subagent.completed",
    version: 5,
    actor: "flywheel",
    payload: {
      childRunId: input.childRunId,
      status: input.status,
      isError: input.isError,
      ...(input.modelFailure ? { modelFailure: true as const } : {}),
      durationMs: input.durationMs,
      ...(input.totalTokens !== undefined ? { totalTokens: input.totalTokens } : {}),
      ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
      ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
      ...(input.cacheReadInputTokens !== undefined ? { cacheReadInputTokens: input.cacheReadInputTokens } : {}),
      ...(input.cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens: input.cacheCreationInputTokens } : {}),
      ...(input.reasoningTokens !== undefined ? { reasoningTokens: input.reasoningTokens } : {}),
      ...(input.totalCostUsd !== undefined ? { totalCostUsd: input.totalCostUsd } : {}),
      ...(input.toolUses !== undefined ? { toolUses: input.toolUses } : {}),
      result: input.content,
      resultBytes: result.bytes,
      resultSha256: result.sha256,
      resultPreview: result.preview,
    },
  })
}

export function recordSubagentInterrupted(
  writer: SubagentRunFactWriter | null,
  input: SubagentInterruptionInput,
): void {
  if (!writer) return
  void writer.record(parseSubagentRunFact({
    type: "subagent.interrupted",
    version: 1,
    actor: "flywheel",
    payload: {
      childRunId: input.childRunId,
      reason: input.reason,
      recoveryId: input.recoveryId,
    },
  }))
}

export function buildSubagentPaused(input: SubagentPauseInput): SubagentRunFact {
  return parseSubagentRunFact({
    type: "subagent.paused",
    version: 1,
    actor: "flywheel",
    payload: input,
  })
}

export function buildSubagentResumed(input: SubagentResumeInput): SubagentRunFact {
  return parseSubagentRunFact({
    type: "subagent.resumed",
    version: 1,
    actor: "flywheel",
    payload: input,
  })
}
