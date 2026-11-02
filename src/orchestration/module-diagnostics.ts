import type { StoredFact } from "../infra/event-store-types.js"
import type { AttemptRow } from "../workflows/view/types.js"
import type { FirstPartyModule } from "./modules.js"

/** Retained attempt identity, timing, and request attribution. No execution authority. */
export interface AttemptExecutionHistory {
  readonly attempts: readonly Pick<AttemptRow, "id" | "name" | "definitionId" | "workflowDefinitionId" | "status" | "startedAt" | "completedAt">[]
  readonly conversationToAttempt: ReadonlyMap<string, string>
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

export function retainedExecutionDiagnostics(events: readonly StoredFact[], modules: readonly FirstPartyModule[]): ExecutionDiagnostics {
  const histories = modules.flatMap((module) => {
    const history = module.retainedDiagnostics?.attempts?.(events)
    return history ? [history] : []
  })
  if (histories.length > 1) throw new Error("Multiple modules provide attempt execution history")
  return { attempts: histories[0], children: modules.flatMap((module) => module.retainedDiagnostics?.children?.(events) ?? []) }
}
