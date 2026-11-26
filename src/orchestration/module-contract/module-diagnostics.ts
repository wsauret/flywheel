import type { StoredFact } from "../../infra/substrate/store/event-store-types.js"
import type { AttemptRow } from "../../workflows/view/types.js"

/** Retained attempt identity, timing, and request attribution. No execution authority. */
export interface AttemptExecutionHistory {
  readonly attempts: readonly Pick<AttemptRow, "id" | "name" | "definitionId" | "workflowDefinitionId" | "status" | "startedAt" | "completedAt">[]
  /** The attempts that started in each conversation, in start order, with
   *  the time of each start. A reopened agent continues in its failed
   *  attempt's conversation, so one conversation can hold several attempts. */
  readonly conversationAttempts: ReadonlyMap<string, readonly ConversationAttemptStart[]>
}

export interface ConversationAttemptStart {
  readonly attemptId: string
  readonly startedAt: number
}

/** The measured child totals needed to attribute parent request efficiency. */
export interface ChildExecutionMetrics {
  readonly runId: string
  readonly status: "created" | "completed" | "partial" | "failed" | "interrupted" | "paused" | "cancelled" | "stopped"
  readonly toolUseId?: string
  readonly modelRequestId?: string
  readonly completedAt?: number
  readonly durationMs?: number
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadInputTokens?: number
  readonly cacheCreationInputTokens?: number
  readonly reasoningTokens?: number
  readonly totalCostUsd?: number
}

/** Installed history remains readable when its module no longer admits work. */
export interface ModuleRetainedDiagnostics {
  attempts?(events: readonly StoredFact[]): AttemptExecutionHistory | undefined
  children?(events: readonly StoredFact[]): readonly ChildExecutionMetrics[]
}

interface ExecutionDiagnostics {
  readonly attempts: AttemptExecutionHistory | undefined
  readonly children: readonly ChildExecutionMetrics[]
}

/** Folds `events` through the retained diagnostics of every installed module that declares them. */
export function retainedExecutionDiagnostics(events: readonly StoredFact[], diagnostics: readonly ModuleRetainedDiagnostics[]): ExecutionDiagnostics {
  const histories = diagnostics.flatMap((module) => {
    const history = module.attempts?.(events)
    return history ? [history] : []
  })
  if (histories.length > 1) throw new Error("Multiple modules provide attempt execution history")
  return { attempts: histories[0], children: diagnostics.flatMap((module) => module.children?.(events) ?? []) }
}
