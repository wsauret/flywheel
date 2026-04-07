/**
 * Shared Session Infrastructure Factory
 *
 * Extracts the common budget/trace/transcript setup used by both
 * WorkflowRunner and ChatRunner. Config-gated: transcript/trace
 * creation respects `config.tracing.enabled`.
 *
 * Usage:
 *   const infra = createSessionInfra({ sessionId, projectCwd, config });
 *   // infra.budgetTracker, infra.traceWriter, infra.transcriptWriter, infra.traceCollector
 */

import { createBudgetTracker, type BudgetTracker } from "./budget-tracker"
import { createTraceWriter, type TraceWriter } from "./trace-writer"
import { createTranscriptWriter, type TranscriptWriter } from "./transcript-writer"
import { createTraceCollector, type TraceCollector } from "./trace-collector"
import type { FlywheelConfig } from "../config/loader"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionInfraDeps {
  sessionId: string
  projectCwd: string
  config: FlywheelConfig
  /** Human-readable name for the trace (workflow description or "chat"). */
  description: string
  /** Override the budget tracker (e.g. for testing or resume). */
  budgetTracker?: BudgetTracker
}

export interface SessionInfra {
  budgetTracker: BudgetTracker
  traceWriter: TraceWriter | null
  transcriptWriter: TranscriptWriter | null
  traceCollector: TraceCollector | null
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSessionInfra(deps: SessionInfraDeps): SessionInfra {
  const { sessionId, projectCwd, config, description } = deps

  const budgetTracker = deps.budgetTracker ?? createBudgetTracker({ sessionId, baseDir: projectCwd })

  let traceWriter: TraceWriter | null = null
  let transcriptWriter: TranscriptWriter | null = null
  let traceCollector: TraceCollector | null = null

  if (config.tracing.enabled) {
    traceWriter = createTraceWriter({
      sessionId,
      baseDir: projectCwd,
      maxTraces: config.tracing.max_traces,
    })
    transcriptWriter = createTranscriptWriter({ sessionId, baseDir: projectCwd })
    traceCollector = createTraceCollector({
      writer: traceWriter,
      sessionId,
      workflowName: description,
    })
  }

  return { budgetTracker, traceWriter, transcriptWriter, traceCollector }
}
