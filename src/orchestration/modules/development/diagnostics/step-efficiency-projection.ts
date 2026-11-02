import { retainedExecutionDiagnostics, type ChildExecutionMetrics, type AttemptExecutionHistory } from "../../../module-diagnostics.js"
import { installedModules } from "../../../module-catalog.js"
import type { AttemptStatus } from "../../../../workflows/view/types.js"
import type { StoredFact } from "../../../../infra/event-store-types.js"
import { loadProviderRequestAuditFromEvents } from "../../../session/provider-request-audit-projection.js"
import type { ProviderRequestAuditEntry } from "../../../session/provider-request-audit-types.js"
import { loadToolExecutionTimelineFromEvents } from "../../../session/tool-execution-projection.js"
import type { ToolExecutionEntry } from "../../../session/tool-execution-types.js"

export interface StepEfficiencyInterval {
  after?: number
  before?: number
}

export interface StepEfficiencyEntry {
  attemptId: string
  agentName: string
  definitionId: string
  workflowDefinitionId: string
  status: AttemptStatus
  startedAt?: number
  completedAt?: number
  durationMs?: number
  modelRequests: number
  successfulModelRequests: number
  failedModelRequests: number
  modelLatencyMs: number
  parentModelLatencyMs: number
  subagentModelLatencyMs: number
  parentRequests: number
  subagentRequests: number
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  reasoningTokens: number
  promptTokens: number
  cacheHitRatio: number
  costUsd: number
  parentWorkerCostUsd: number
  subagentCostUsd: number
  toolCallCount: number
  toolCompletedCount: number
  toolLatencyMs: number
  foregroundToolLatencyMs: number
  subagentToolLatencyMs: number
  outputRecoveryCount: number
  semanticOutputRecoveryCount: number
  byteOutputRecoveryCount: number
  thinkingStallCount: number
  thinkingStallRecoveryCount: number
  subagentCount: number
  failedSubagentCount: number
  subagentDurationMs: number
}

export function loadStepEfficiencyFromEvents(
  events: readonly StoredFact[],
  interval: StepEfficiencyInterval = {},
): StepEfficiencyEntry[] {
  const history = retainedExecutionDiagnostics(events, installedModules())
  const execution = history.attempts
  if (!execution) return []

  const entries = new Map(execution.attempts.map((attempt) => [attempt.id, initialEntry(attempt)]))

  const conversationToAttempt = execution.conversationToAttempt
  const providerRequests = loadProviderRequestAuditFromEvents(events)
  const requestById = new Map(providerRequests.map((request) => [request.requestId, request]))
  const tools = loadToolExecutionTimelineFromEvents(events)
  const toolById = new Map(tools.map((tool) => [tool.toolUseId, tool]))
  const subagents = history.children
  const childRunByToolUseId = subagentByToolUseId(subagents)
  const subagentUsageCovered = new Set<string>()
  const attemptForRequest = createAttemptRequestResolver(requestById, conversationToAttempt, toolById, childRunByToolUseId)

  applyProviderResponses(entries, providerRequests, interval, attemptForRequest, childRunByToolUseId)
  applyProviderUsage(entries, providerRequests, interval, attemptForRequest, childRunByToolUseId, subagentUsageCovered)
  applyProviderStreamTelemetry(entries, providerRequests, interval, attemptForRequest)
  applyToolEfficiency(entries, tools, interval, attemptForRequest, childRunByToolUseId)
  applySubagentEfficiency(entries, subagents, interval, attemptForRequest, subagentUsageCovered)

  return execution.attempts.map((attempt) => finalizeEntry(entries.get(attempt.id) ?? initialEntry(attempt)))
}

type AttemptRequestResolver = (requestId: string, seen?: Set<string>) => string | undefined

function createAttemptRequestResolver(
  requestById: ReadonlyMap<string, ProviderRequestAuditEntry>,
  conversationToAttempt: ReadonlyMap<string, string>,
  toolById: ReadonlyMap<string, ToolExecutionEntry>,
  childRunByToolUseId: ReadonlyMap<string, ChildExecutionMetrics>,
): AttemptRequestResolver {
  const resolve: AttemptRequestResolver = (requestId, seen = new Set<string>()) => {
    if (seen.has(requestId)) return undefined
    seen.add(requestId)
    const request = requestById.get(requestId)
    if (!request) return undefined
    const direct = request.usage?.workflowAttemptId
      ?? (request.identity.conversationId ? conversationToAttempt.get(request.identity.conversationId) : undefined)
    if (direct) return direct
    const parentToolUseId = request.usage?.parentToolUseId ?? request.prompt?.parentToolUseId
    if (!parentToolUseId) return undefined
    const parentRequestId = childRunByToolUseId.get(parentToolUseId)?.modelRequestId ?? toolById.get(parentToolUseId)?.modelRequestId
    return parentRequestId ? resolve(parentRequestId, seen) : undefined
  }
  return resolve
}

function applyProviderResponses(
  entries: Map<string, StepEfficiencyEntry>,
  providerRequests: readonly ProviderRequestAuditEntry[],
  interval: StepEfficiencyInterval,
  attemptForRequest: AttemptRequestResolver,
  childRunByToolUseId: ReadonlyMap<string, ChildExecutionMetrics>,
): void {
  for (const request of providerRequests) {
    const response = request.response
    if (!response || !inInterval(request.respondedAt, interval)) continue
    const entry = entryForRequest(entries, request.requestId, attemptForRequest)
    if (!entry) continue
    const parentToolUseId = request.usage?.parentToolUseId ?? request.prompt?.parentToolUseId
    addModelResponse(entry, response, parentToolUseId ? childRunByToolUseId.has(parentToolUseId) : false)
  }
}

function applyProviderUsage(
  entries: Map<string, StepEfficiencyEntry>,
  providerRequests: readonly ProviderRequestAuditEntry[],
  interval: StepEfficiencyInterval,
  attemptForRequest: AttemptRequestResolver,
  childRunByToolUseId: ReadonlyMap<string, ChildExecutionMetrics>,
  subagentUsageCovered: Set<string>,
): void {
  for (const request of providerRequests) {
    const usage = request.usage
    if (!usage || !inInterval(usage.recordedAt, interval)) continue
    const entry = entryForRequest(entries, request.requestId, attemptForRequest)
    if (!entry) continue
    const parentToolUseId = usage.parentToolUseId ?? request.prompt?.parentToolUseId
    const childRun = parentToolUseId ? childRunByToolUseId.get(parentToolUseId) : undefined
    addUsage(entry, usage, childRun !== undefined)
    if (childRun) subagentUsageCovered.add(childRun.runId)
  }
}

function applyProviderStreamTelemetry(
  entries: Map<string, StepEfficiencyEntry>,
  providerRequests: readonly ProviderRequestAuditEntry[],
  interval: StepEfficiencyInterval,
  attemptForRequest: AttemptRequestResolver,
): void {
  for (const request of providerRequests) {
    const entry = entryForRequest(entries, request.requestId, attemptForRequest)
    if (entry) addStreamTelemetry(entry, request, interval)
  }
}

function applyToolEfficiency(
  entries: Map<string, StepEfficiencyEntry>,
  tools: readonly ToolExecutionEntry[],
  interval: StepEfficiencyInterval,
  attemptForRequest: AttemptRequestResolver,
  childRunByToolUseId: ReadonlyMap<string, ChildExecutionMetrics>,
): void {
  for (const tool of tools) {
    const timestamp = tool.completedAt ?? tool.calledAt
    if (!inInterval(timestamp, interval)) continue
    const attemptId = stepForTool(tool, attemptForRequest, childRunByToolUseId)
    const entry = attemptId ? entries.get(attemptId) : undefined
    if (entry) addTool(entry, tool)
  }
}

function applySubagentEfficiency(
  entries: Map<string, StepEfficiencyEntry>,
  subagents: readonly ChildExecutionMetrics[],
  interval: StepEfficiencyInterval,
  attemptForRequest: AttemptRequestResolver,
  subagentUsageCovered: ReadonlySet<string>,
): void {
  for (const subagent of subagents) {
    if (!inInterval(subagent.completedAt, interval)) continue
    const attemptId = subagent.modelRequestId ? attemptForRequest(subagent.modelRequestId) : undefined
    const entry = attemptId ? entries.get(attemptId) : undefined
    if (entry) addSubagent(entry, subagent, !subagentUsageCovered.has(subagent.runId))
  }
}

function entryForRequest(
  entries: Map<string, StepEfficiencyEntry>,
  requestId: string,
  attemptForRequest: AttemptRequestResolver,
): StepEfficiencyEntry | undefined {
  const attemptId = attemptForRequest(requestId)
  return attemptId ? entries.get(attemptId) : undefined
}

function initialEntry(attempt: AttemptExecutionHistory["attempts"][number]): StepEfficiencyEntry {
  return {
    attemptId: attempt.id,
    agentName: attempt.name,
    definitionId: attempt.definitionId,
    workflowDefinitionId: attempt.workflowDefinitionId,
    status: attempt.status,
    ...(attempt.startedAt === undefined ? {} : { startedAt: attempt.startedAt }),
    ...(attempt.completedAt === undefined ? {} : { completedAt: attempt.completedAt }),
    modelRequests: 0,
    successfulModelRequests: 0,
    failedModelRequests: 0,
    modelLatencyMs: 0,
    parentModelLatencyMs: 0,
    subagentModelLatencyMs: 0,
    parentRequests: 0,
    subagentRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningTokens: 0,
    promptTokens: 0,
    cacheHitRatio: 0,
    costUsd: 0,
    parentWorkerCostUsd: 0,
    subagentCostUsd: 0,
    toolCallCount: 0,
    toolCompletedCount: 0,
    toolLatencyMs: 0,
    foregroundToolLatencyMs: 0,
    subagentToolLatencyMs: 0,
    outputRecoveryCount: 0,
    semanticOutputRecoveryCount: 0,
    byteOutputRecoveryCount: 0,
    thinkingStallCount: 0,
    thinkingStallRecoveryCount: 0,
    subagentCount: 0,
    failedSubagentCount: 0,
    subagentDurationMs: 0,
  }
}

function subagentByToolUseId(subagents: readonly ChildExecutionMetrics[]): Map<string, ChildExecutionMetrics> {
  const map = new Map<string, ChildExecutionMetrics>()
  for (const subagent of subagents) {
    if (subagent.toolUseId) map.set(subagent.toolUseId, subagent)
  }
  return map
}

function stepForTool(
  tool: ToolExecutionEntry,
  attemptForRequest: (requestId: string) => string | undefined,
  childRunByToolUseId: ReadonlyMap<string, ChildExecutionMetrics>,
): string | undefined {
  if (tool.modelRequestId) return attemptForRequest(tool.modelRequestId)
  if (!tool.parentToolUseId) return undefined
  const parentRequestId = childRunByToolUseId.get(tool.parentToolUseId)?.modelRequestId
  return parentRequestId ? attemptForRequest(parentRequestId) : undefined
}

function addModelResponse(
  entry: StepEfficiencyEntry,
  response: NonNullable<ProviderRequestAuditEntry["response"]>,
  isSubagentRequest: boolean,
): void {
  entry.modelRequests += 1
  if (isSubagentRequest) entry.subagentRequests += 1
  else entry.parentRequests += 1
  if (response.outcome === "ok") entry.successfulModelRequests += 1
  else entry.failedModelRequests += 1
  entry.modelLatencyMs += response.durationMs
  if (isSubagentRequest) entry.subagentModelLatencyMs += response.durationMs
  else entry.parentModelLatencyMs += response.durationMs
}

function addUsage(
  entry: StepEfficiencyEntry,
  usage: NonNullable<ProviderRequestAuditEntry["usage"]>,
  isSubagentRequest: boolean,
): void {
  // Sums of reported tokens only: an unmeasured request and an unreported detail add nothing.
  entry.inputTokens += usage.inputTokens ?? 0
  entry.outputTokens += usage.outputTokens ?? 0
  entry.cacheReadInputTokens += usage.cacheReadInputTokens ?? 0
  entry.cacheCreationInputTokens += usage.cacheCreationInputTokens ?? 0
  entry.reasoningTokens += usage.reasoningTokens ?? 0
  entry.promptTokens += usage.promptTokens ?? 0
  if (usage.deltaCostUsd !== undefined) {
    entry.costUsd += usage.deltaCostUsd
    if (isSubagentRequest) entry.subagentCostUsd += usage.deltaCostUsd
    else entry.parentWorkerCostUsd += usage.deltaCostUsd
  }
}

function addTool(entry: StepEfficiencyEntry, tool: ToolExecutionEntry): void {
  entry.toolCallCount += 1
  if (tool.status === "completed" || tool.status === "failed" || tool.status === "interrupted") entry.toolCompletedCount += 1
  const latency = tool.calledAt !== undefined && tool.completedAt !== undefined
    ? Math.max(0, tool.completedAt - tool.calledAt)
    : 0
  entry.toolLatencyMs += latency
  if (tool.parentToolUseId) entry.subagentToolLatencyMs += latency
  else entry.foregroundToolLatencyMs += latency
  if (tool.fullContentPath) entry.outputRecoveryCount += 1
  if (tool.fullContentPath && tool.semanticOutputTruncated) entry.semanticOutputRecoveryCount += 1
  if (tool.fullContentPath && tool.byteOutputTruncated) entry.byteOutputRecoveryCount += 1
}

function addStreamTelemetry(
  entry: StepEfficiencyEntry,
  request: ProviderRequestAuditEntry,
  interval: StepEfficiencyInterval,
): void {
  const stream = request.stream
  if (!stream) return
  const rawEvents = stream.events
  if (rawEvents.length > 0) {
    for (const event of rawEvents) {
      if (!inInterval(event.timestamp, interval)) continue
      if (event.source === "watchdog" && event.kind === "thinking_stall") entry.thinkingStallCount += 1
      if (event.source === "normalized" && event.kind === "stream_retry" && disablesReasoning(event.metadata)) {
        entry.thinkingStallRecoveryCount += 1
      }
    }
    return
  }

  if (!stream.summary || !inInterval(stream.summary.completedAt ?? stream.summary.startedAt, interval)) return
  entry.thinkingStallCount += stream.summary.watchdog.thinkingStallCount
  entry.thinkingStallRecoveryCount += stream.summary.recovery.reasoningDisabledRetryCount
}

function disablesReasoning(metadata: StringMap<unknown>): boolean {
  return metadata.nextAttemptDisablesReasoning === true
}

function addSubagent(entry: StepEfficiencyEntry, subagent: ChildExecutionMetrics, useCompletionUsageFallback: boolean): void {
  entry.subagentCount += 1
  if (subagent.status === "failed") entry.failedSubagentCount += 1
  entry.subagentDurationMs += subagent.durationMs ?? 0
  if (!useCompletionUsageFallback) return
  entry.inputTokens += subagent.inputTokens ?? 0
  entry.outputTokens += subagent.outputTokens ?? 0
  entry.cacheReadInputTokens += subagent.cacheReadInputTokens ?? 0
  entry.cacheCreationInputTokens += subagent.cacheCreationInputTokens ?? 0
  entry.reasoningTokens += subagent.reasoningTokens ?? 0
  entry.promptTokens += (subagent.inputTokens ?? 0) + (subagent.cacheReadInputTokens ?? 0) + (subagent.cacheCreationInputTokens ?? 0)
  entry.costUsd += subagent.totalCostUsd ?? 0
  entry.subagentCostUsd += subagent.totalCostUsd ?? 0
}

function finalizeEntry(entry: StepEfficiencyEntry): StepEfficiencyEntry {
  const durationMs = entry.startedAt !== undefined && entry.completedAt !== undefined
    ? Math.max(0, entry.completedAt - entry.startedAt)
    : undefined
  return {
    ...entry,
    ...(durationMs !== undefined ? { durationMs } : {}),
    cacheHitRatio: entry.promptTokens > 0 ? entry.cacheReadInputTokens / entry.promptTokens : 0,
  }
}

function inInterval(timestamp: number | undefined, interval: StepEfficiencyInterval): boolean {
  if (timestamp === undefined) return interval.after === undefined && interval.before === undefined
  if (interval.after !== undefined && timestamp < interval.after) return false
  if (interval.before !== undefined && timestamp > interval.before) return false
  return true
}

export interface StepEfficiencySummary {
  stepCount: number
  modelRequests: number
  successfulModelRequests: number
  failedModelRequests: number
  modelLatencyMs: number
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  reasoningTokens: number
  costUsd: number
  parentWorkerCostUsd: number
  subagentCostUsd: number
  toolCallCount: number
  toolLatencyMs: number
  outputRecoveryCount: number
  semanticOutputRecoveryCount: number
  byteOutputRecoveryCount: number
  thinkingStallCount: number
  thinkingStallRecoveryCount: number
  subagentCount: number
  failedSubagentCount: number
  subagentDurationMs: number
}

export function summarizeStepEfficiency(entries: readonly StepEfficiencyEntry[]): StepEfficiencySummary {
  return entries.reduce<StepEfficiencySummary>((summary, entry) => ({
    stepCount: summary.stepCount + 1,
    modelRequests: summary.modelRequests + entry.modelRequests,
    successfulModelRequests: summary.successfulModelRequests + entry.successfulModelRequests,
    failedModelRequests: summary.failedModelRequests + entry.failedModelRequests,
    modelLatencyMs: summary.modelLatencyMs + entry.modelLatencyMs,
    inputTokens: summary.inputTokens + entry.inputTokens,
    outputTokens: summary.outputTokens + entry.outputTokens,
    cacheReadInputTokens: summary.cacheReadInputTokens + entry.cacheReadInputTokens,
    cacheCreationInputTokens: summary.cacheCreationInputTokens + entry.cacheCreationInputTokens,
    reasoningTokens: summary.reasoningTokens + entry.reasoningTokens,
    costUsd: summary.costUsd + entry.costUsd,
    parentWorkerCostUsd: summary.parentWorkerCostUsd + entry.parentWorkerCostUsd,
    subagentCostUsd: summary.subagentCostUsd + entry.subagentCostUsd,
    toolCallCount: summary.toolCallCount + entry.toolCallCount,
    toolLatencyMs: summary.toolLatencyMs + entry.toolLatencyMs,
    outputRecoveryCount: summary.outputRecoveryCount + entry.outputRecoveryCount,
    semanticOutputRecoveryCount: summary.semanticOutputRecoveryCount + entry.semanticOutputRecoveryCount,
    byteOutputRecoveryCount: summary.byteOutputRecoveryCount + entry.byteOutputRecoveryCount,
    thinkingStallCount: summary.thinkingStallCount + entry.thinkingStallCount,
    thinkingStallRecoveryCount: summary.thinkingStallRecoveryCount + entry.thinkingStallRecoveryCount,
    subagentCount: summary.subagentCount + entry.subagentCount,
    failedSubagentCount: summary.failedSubagentCount + entry.failedSubagentCount,
    subagentDurationMs: summary.subagentDurationMs + entry.subagentDurationMs,
  }), {
    stepCount: 0,
    modelRequests: 0,
    successfulModelRequests: 0,
    failedModelRequests: 0,
    modelLatencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    parentWorkerCostUsd: 0,
    subagentCostUsd: 0,
    toolCallCount: 0,
    toolLatencyMs: 0,
    outputRecoveryCount: 0,
    semanticOutputRecoveryCount: 0,
    byteOutputRecoveryCount: 0,
    thinkingStallCount: 0,
    thinkingStallRecoveryCount: 0,
    subagentCount: 0,
    failedSubagentCount: 0,
    subagentDurationMs: 0,
  })
}

export function hasStepActivity(entry: StepEfficiencyEntry): boolean {
  return entry.modelRequests > 0
    || entry.inputTokens > 0
    || entry.outputTokens > 0
    || entry.costUsd > 0
    || entry.toolCallCount > 0
    || entry.subagentCount > 0
}
interface StringMap<T> { [key: string]: T }
