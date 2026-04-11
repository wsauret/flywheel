/**
 * Shared Session Infrastructure Factory
 *
 * Extracts the common budget/trace/transcript setup used by both
 * WorkflowRunner and ChatRunner. Both runners call this factory —
 * that is the shared abstraction, not duplicated initialization.
 * Config-gated: transcript/trace creation respects `config.tracing.enabled`.
 *
 * Usage:
 *   const infra = createSessionInfra({ sessionId, projectCwd, config });
 *   // infra.budgetTracker, infra.traceWriter, infra.transcriptWriter, infra.traceCollector
 */

import { createBudgetTracker } from "./budget-tracker.js"
import type { BudgetTracker } from "./budget-tracker-types.js"
import { createTraceWriter, type TraceWriter } from "./trace-writer"
import { createTranscriptWriter, type TranscriptWriter } from "./transcript-writer"
import { createTraceCollector, type TraceCollector } from "./trace-collector"
import type { FlywheelConfig } from "../config/schema"
import type { EventBus } from "../../infra/event-bus"
import { extractContextUpdate, contextWindowForModel } from "../engines/providers/claude-context"

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

  // Seed context window from config model so % calculation works before the
  // first "result" NDJSON event. The [1m] suffix (1M context) is only in the
  // config string — Claude Code strips it in output. Authoritative value from
  // "result" events overwrites this when it arrives.
  const configModel = config.subprocess?.model ?? config.model ?? ""
  const estimatedWindow = contextWindowForModel(configModel)
  if (estimatedWindow > 0) budgetTracker.updateContextUtilization(0, estimatedWindow)

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

// ---------------------------------------------------------------------------
// Shared EventBus subscriber wiring
// ---------------------------------------------------------------------------

/**
 * Wire the shared budget + transcript EventBus subscriptions.
 *
 * Both WorkflowRunner (executor-factory) and ChatRunner (chat-session)
 * need identical budget/transcript wiring. Tracing is caller-specific
 * (workflow uses TraceEventHandler, chat uses feedChatEventToTrace).
 *
 * Returns unsubscribe functions — caller appends to their own unsub list.
 */
export function wireSessionSubscribers(
  bus: EventBus,
  infra: Pick<SessionInfra, "budgetTracker" | "transcriptWriter">,
): Array<() => void> {
  const unsubs: Array<() => void> = []

  unsubs.push(
    bus.subscribeToType("subprocess:spawned", () => {
      infra.budgetTracker.onNewSubprocess()
    }),
  )
  unsubs.push(
    bus.subscribeToType("subprocess:ndjson", (e) => {
      infra.budgetTracker.handleEvent(e.ndjsonEvent)
      const ctxUpdate = extractContextUpdate(e.ndjsonEvent)
      if (ctxUpdate) {
        infra.budgetTracker.updateContextUtilization(ctxUpdate.promptTokens, ctxUpdate.contextWindow)
      }
    }),
  )
  if (infra.transcriptWriter) {
    const tw = infra.transcriptWriter
    unsubs.push(
      bus.subscribeToType("subprocess:ndjson", (e) => {
        tw.handleEvent(e.ndjsonEvent)
      }),
    )
  }

  return unsubs
}
