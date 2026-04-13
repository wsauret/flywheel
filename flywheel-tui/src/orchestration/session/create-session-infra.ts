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
import { createTraceEventHandler } from "../engines/subprocess/trace-event-handler"
import type { FlywheelConfig } from "../config/schema"
import type { EventBus, EmitFn, Unsubscribe } from "../../infra/event-bus"
import type { BudgetLimits } from "../../workflows/schemas"
import { extractContextUpdate, contextWindowForModel } from "../engines/providers/claude-context"

// Types

export interface SessionInfraDeps {
  sessionId: string
  projectCwd: string
  config: FlywheelConfig
  /** Human-readable name for the trace (workflow description or "chat"). */
  description: string
  /** Override the budget tracker (e.g. for testing or resume). */
  budgetTracker?: BudgetTracker
  /** EventBus emitter — enables budget:metrics-changed and budget:exhausted emission. */
  emitter?: EmitFn
  /** Workflow/chat ID for budget event correlation. */
  workflowId?: string
  /** Budget limits — when provided, the tracker auto-checks exhaustion on cost updates. */
  budgetLimits?: BudgetLimits
}

export interface SessionInfra {
  budgetTracker: BudgetTracker
  traceWriter: TraceWriter | null
  transcriptWriter: TranscriptWriter | null
  traceCollector: TraceCollector | null
}

// Factory

export function createSessionInfra(deps: SessionInfraDeps): SessionInfra {
  const { sessionId, projectCwd, config, description } = deps

  const budgetTracker = deps.budgetTracker ?? createBudgetTracker({
    sessionId,
    baseDir: projectCwd,
    emitter: deps.emitter,
    workflowId: deps.workflowId,
    budgetLimits: deps.budgetLimits,
  })

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

// Shared EventBus subscriber wiring

/** Callback to write budget metrics directly to the session store. */
export type MetricsWriter = (patch: { tokens: number; cost: number; contextPercent: number }) => void

/**
 * Wire all infrastructure EventBus subscriptions: budget, transcript, tracing,
 * and optionally metrics-to-store propagation.
 *
 * Called by both workflow and chat modes. When metricsWriter is provided,
 * budget:metrics-changed events are forwarded to the store — this is the
 * single path for metrics propagation in both modes.
 */
export function wireSessionSubscribers(
  bus: EventBus,
  emit: EmitFn,
  workflowId: string,
  infra: Pick<SessionInfra, "budgetTracker" | "transcriptWriter" | "traceCollector">,
  metricsWriter?: MetricsWriter,
): Unsubscribe[] {
  const unsubs: Unsubscribe[] = []

  // Budget: subprocess lifecycle + NDJSON cost/token/context tracking
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

  // Metrics → store: budget:metrics-changed is emitted by the budget tracker
  // whenever cost/tokens change. Single subscription for both workflow and chat.
  // Uses event payload for tokens/cost; context % still from tracker (not in event).
  if (metricsWriter) {
    unsubs.push(
      bus.subscribeToType("budget:metrics-changed", (e) => {
        metricsWriter({
          tokens: e.tokens,
          cost: e.cost,
          contextPercent: infra.budgetTracker.getContextUtilization().percent,
        })
      }),
    )
  }

  // Transcript: NDJSON events → conversation log
  if (infra.transcriptWriter) {
    const tw = infra.transcriptWriter
    unsubs.push(
      bus.subscribeToType("subprocess:ndjson", (e) => {
        tw.handleEvent(e.ndjsonEvent)
      }),
    )
  }

  // Tracing: NDJSON → trace events → spans
  // TraceEventHandler converts subprocess NDJSON into trace:* FlywheelEvents.
  // TraceCollector subscribes to those events and builds span trees.
  if (infra.traceCollector) {
    const traceHandler = createTraceEventHandler({ emit, workflowId })
    unsubs.push(
      bus.subscribeToType("subprocess:ndjson", (e) => {
        traceHandler.handleEvent(e.ndjsonEvent)
      }),
    )
    unsubs.push(...infra.traceCollector.subscribeToEvents(bus))
  }

  return unsubs
}
