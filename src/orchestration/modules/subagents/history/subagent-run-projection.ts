import { createEventProjection, parseProjectionFact, reduceEvents } from "../../../../infra/event-projection.js"
import type { AsyncEventStateReadSurface, StoredFact } from "../../../../infra/event-store-types.js"
import { heldProjection } from "../../../../infra/projection-registry.js"
import { InvariantViolation } from "../../../../infra/invariant.js"
import { parseSubagentRunFact, type SubagentRunFact } from "../facts.js"
import type { SubagentRunEntry, SubagentRunState } from "./subagent-run-types.js"
import { HashMap, Option } from "effect"

export const SUBAGENT_RUN_FACT_TYPES = ["child_run.created", "child_run.ownership.recovered", "subagent.prompted", "subagent.completed", "subagent.interrupted", "subagent.paused", "subagent.resumed"] as const

// Equal activity timestamps keep the original ledger's creation order.
function subagentRunsFromProjection(state: SubagentRunState): SubagentRunEntry[] {
  return Array.from(HashMap.values(state.runs))
    .sort((a, b) => firstTimestamp(a.entry) - firstTimestamp(b.entry) || a.ordinal - b.ordinal)
    .map(({ entry }) => ({
      ...entry,
      tools: [...entry.tools],
      promptToolNames: entry.promptToolNames ? [...entry.promptToolNames] : undefined,
    }))
}

export function loadSubagentRunsFromEvents(events: readonly StoredFact[]): SubagentRunEntry[] {
  return subagentRunsFromProjection(reduceEvents(events, {
    initialState,
    reduce: reduceSubagentRunEvent,
    factTypes: SUBAGENT_RUN_FACT_TYPES,
  }))
}

/** Reads one child's run ledger, advancing its held fold through new facts. */
export async function readSubagentRuns(
  reader: AsyncEventStateReadSurface,
  sessionId: string,
): Promise<SubagentRunEntry[]> {
  return subagentRunsFromProjection(await subagentRunProjection(reader, sessionId).replay())
}

function subagentRunProjection(reader: AsyncEventStateReadSurface, sessionId: string) {
  return heldProjection(reader, `subagent-runs:${sessionId}`, () => createEventProjection<SubagentRunState>(reader, {
    aggregateId: `session:${sessionId}`,
    factTypes: SUBAGENT_RUN_FACT_TYPES,
    initialState,
    reduce: reduceSubagentRunEvent,
  }))
}

function initialState(): SubagentRunState {
  return {
    runCount: 0,
    completedCount: 0,
    failedCount: 0,
    interruptedCount: 0,
    runs: HashMap.empty(),
  }
}

function reduceSubagentRunEvent(state: SubagentRunState, event: StoredFact): SubagentRunState {
  const fact = parseProjectionFact(event, parseSubagentRunFact)

  switch (fact.type) {
    case "child_run.ownership.recovered": {
      const existing = requireSubagentRun(state, fact.payload.childRunId, event)
      return commitRun(state, { ...existing, parentSessionId: fact.payload.parentSessionId, parentConversationId: fact.payload.parentConversationId })
    }
    case "child_run.created":
      return commitRun(state, createdRunEntry(fact.payload, event), { runCount: 1 })
    case "subagent.prompted":
      return commitRun(state, promptedRunEntry(requireOpenSubagentRun(state, fact.payload.childRunId, event), fact.payload, event))
    case "subagent.completed": {
      const existing = requireUnsettledSubagentRun(state, fact.payload.childRunId, event)
      return commitRun(state, completedRunEntry(existing, fact.payload, event), {
        completedCount: fact.payload.status === "completed" ? 1 : 0,
        failedCount: fact.payload.status === "failed" ? 1 : 0,
        interruptedCount: existing.status === "interrupted" ? -1 : 0,
      })
    }
    case "subagent.interrupted":
      return commitRun(
        state,
        interruptedRunEntry(requireOpenSubagentRun(state, fact.payload.childRunId, event), fact.payload, event),
        { interruptedCount: 1 },
      )
    case "subagent.paused": {
      const existing = requireSubagentRun(state, fact.payload.childRunId, event)
      if (existing.status !== "created") {
        throw new InvariantViolation({
          kind: "duplicate-event",
          eventType: event.type,
          eventPosition: event.position,
          aggregateId: event.aggregateId,
          detail: `subagent ${fact.payload.childRunId} is not running (${existing.status})`,
        })
      }
      return commitRun(state, {
        ...existing,
        status: "paused",
        pausedBy: fact.payload.pausedBy,
        pausedAt: event.timestamp,
        pauseEventId: event.id,
      })
    }
    case "subagent.resumed": {
      const existing = requireUnsettledSubagentRun(state, fact.payload.childRunId, event)
      if (fact.payload.continuation !== (existing.continuationCount ?? 0) + 1) {
        throw new InvariantViolation({
          kind: "duplicate-event",
          eventType: event.type,
          eventPosition: event.position,
          aggregateId: event.aggregateId,
          detail: `subagent ${fact.payload.childRunId} continuation is out of sequence`,
        })
      }
      return commitRun(state, {
        ...existing,
        status: "created",
        continuationCount: fact.payload.continuation,
        interruptedAt: undefined,
        interruptionEventId: undefined,
        interruptionReason: undefined,
        recoveryId: undefined,
        pausedBy: undefined,
        pausedAt: undefined,
        pauseEventId: undefined,
      })
    }
  }
}

function createdRunEntry(
  payload: Extract<SubagentRunFact, { type: "child_run.created" }>["payload"],
  event: StoredFact,
): SubagentRunEntry {
  if ("childSessionId" in payload) {
    return {
      childSessionId: payload.childSessionId,
      childRunId: payload.childRunId,
      status: "created",
      conversationId: payload.conversationId,
      parentSessionId: payload.parentSessionId,
      parentConversationId: payload.parentConversationId,
      parentToolCallId: payload.parentToolCallId,
      toolUseId: payload.parentToolCallId,
      parentDepth: payload.parentDepth,
      agentType: payload.persona.name,
      personaKind: payload.persona.kind,
      capabilityGrant: payload.capabilityGrant,
      admittedModuleIds: [...payload.admittedModuleIds],
      skillsRevision: payload.skillsRevision,
      description: payload.description,
      model: payload.model,
      tools: [...payload.tools],
      maxTurns: payload.budget.maxTurns,
      maxTokens: payload.budget.maxTokens,
      createdAt: event.timestamp,
      createEventId: event.id,
      executionCwd: payload.executionCwd,
      ...(payload.modelRequestId ? { modelRequestId: payload.modelRequestId } : {}),
      ...(payload.effort ? { effort: payload.effort } : {}),
      ...(payload.fork ? { fork: true } : {}),
    }
  }
  return {
    childRunId: payload.childRunId,
    status: "created",
    agentType: payload.agentType,
    description: payload.description,
    model: payload.model,
    tools: [...payload.tools],
    maxTurns: payload.maxTurns,
    createdAt: event.timestamp,
    createEventId: event.id,
    ...(payload.toolUseId ? { toolUseId: payload.toolUseId } : {}),
    ...(payload.modelRequestId ? { modelRequestId: payload.modelRequestId } : {}),
    ...(payload.conversationId ? { conversationId: payload.conversationId } : {}),
    ...(payload.effort ? { effort: payload.effort } : {}),
    ...(payload.fork ? { fork: true } : {}),
    ...(payload.executionCwd ? { executionCwd: payload.executionCwd } : {}),
  }
}

function promptedRunEntry(
  existing: SubagentRunEntry,
  payload: Extract<SubagentRunFact, { type: "subagent.prompted" }>["payload"],
  event: StoredFact,
): SubagentRunEntry {
  return {
    ...existing,
    prompt: payload.prompt,
    task: payload.task,
    promptToolNames: [...payload.toolNames],
    promptedAt: event.timestamp,
    promptEventId: event.id,
  }
}

function completedRunEntry(
  existing: SubagentRunEntry,
  payload: Extract<SubagentRunFact, { type: "subagent.completed" }>["payload"],
  event: StoredFact,
): SubagentRunEntry {
  return {
    ...existing,
    status: payload.status,
    interruptedAt: undefined,
    interruptionEventId: undefined,
    interruptionReason: undefined,
    recoveryId: undefined,
    pausedBy: undefined,
    pausedAt: undefined,
    pauseEventId: undefined,
    isError: payload.isError,
    ...("modelFailure" in payload && payload.modelFailure ? { modelFailure: true as const } : {}),
    durationMs: payload.durationMs,
    ...(payload.totalTokens !== undefined ? { totalTokens: payload.totalTokens } : {}),
    ...(payload.inputTokens !== undefined ? { inputTokens: payload.inputTokens } : {}),
    ...(payload.outputTokens !== undefined ? { outputTokens: payload.outputTokens } : {}),
    ...(payload.cacheReadInputTokens !== undefined ? { cacheReadInputTokens: payload.cacheReadInputTokens } : {}),
    ...(payload.cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens: payload.cacheCreationInputTokens } : {}),
    ...(payload.reasoningTokens !== undefined ? { reasoningTokens: payload.reasoningTokens } : {}),
    ...(payload.totalCostUsd !== undefined ? { totalCostUsd: payload.totalCostUsd } : {}),
    ...(payload.toolUses !== undefined ? { toolUses: payload.toolUses } : {}),
    resultBytes: payload.resultBytes,
    resultSha256: payload.resultSha256,
    resultPreview: payload.resultPreview,
    ...("result" in payload ? { result: payload.result } : {}),
    completedAt: event.timestamp,
    completionEventId: event.id,
  }
}

function interruptedRunEntry(
  existing: SubagentRunEntry,
  payload: Extract<SubagentRunFact, { type: "subagent.interrupted" }>["payload"],
  event: StoredFact,
): SubagentRunEntry {
  return {
    ...existing,
    status: "interrupted",
    completedAt: event.timestamp,
    interruptedAt: event.timestamp,
    interruptionEventId: event.id,
    interruptionReason: payload.reason,
    recoveryId: payload.recoveryId,
  }
}

function requireSubagentRun(state: SubagentRunState, childRunId: string, event: StoredFact): SubagentRunEntry {
  const existing = Option.getOrUndefined(HashMap.get(state.runs, childRunId))?.entry
  if (existing) return existing
  throw new InvariantViolation({
    kind: "missing-producer-event",
    eventType: event.type,
    eventPosition: event.position,
    aggregateId: event.aggregateId,
    detail: `child_run.created has not been observed for childRunId ${childRunId}`,
  })
}

function requireOpenSubagentRun(state: SubagentRunState, childRunId: string, event: StoredFact): SubagentRunEntry {
  const existing = requireSubagentRun(state, childRunId, event)
  if (existing.status === "created" || (existing.status === "interrupted" && existing.interruptionReason === "runtime_restarted")) return existing
  throw new InvariantViolation({
    kind: "duplicate-event",
    eventType: event.type,
    eventPosition: event.position,
    aggregateId: event.aggregateId,
    detail: `subagent ${childRunId} is already terminal (${existing.status})`,
  })
}

/** A run with no terminal completion: running, paused, or interrupted by a
 *  crash. It continues from a pause, from a crash, or from a planned
 *  replacement that authorized it while it still ran, and a person's Stop
 *  completes it from any of these. A build that predates the Stop of a paused
 *  run rejects the `subagent.paused` then `subagent.completed` sequence, so a
 *  fallback to such a build cannot read the runs of a child stopped while
 *  paused. */
function requireUnsettledSubagentRun(state: SubagentRunState, childRunId: string, event: StoredFact): SubagentRunEntry {
  const existing = requireSubagentRun(state, childRunId, event)
  if (existing.status === "paused") return existing
  return requireOpenSubagentRun(state, childRunId, event)
}

function commitRun(
  state: SubagentRunState,
  next: SubagentRunEntry,
  increments: Partial<Pick<SubagentRunState, "runCount" | "completedCount" | "failedCount" | "interruptedCount">> = {},
): SubagentRunState {
  const ordinal = Option.getOrUndefined(HashMap.get(state.runs, next.childRunId))?.ordinal ?? state.runCount
  return {
    runCount: state.runCount + (increments.runCount ?? 0),
    completedCount: state.completedCount + (increments.completedCount ?? 0),
    failedCount: state.failedCount + (increments.failedCount ?? 0),
    interruptedCount: state.interruptedCount + (increments.interruptedCount ?? 0),
    runs: HashMap.set(state.runs, next.childRunId, { entry: next, ordinal }),
  }
}

/** When a run began: the first of its creation, prompt, and completion times it records. */
export function firstTimestamp(entry: SubagentRunEntry): number {
  return entry.createdAt ?? entry.promptedAt ?? entry.completedAt ?? 0
}
