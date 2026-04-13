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

export interface SessionInfraDeps {
  sessionId: string
  projectCwd: string
  config: FlywheelConfig
  description: string
  budgetTracker?: BudgetTracker
  emitter?: EmitFn
  workflowId?: string
  budgetLimits?: BudgetLimits
}

export interface SessionInfra {
  budgetTracker: BudgetTracker
  traceWriter: TraceWriter | null
  transcriptWriter: TranscriptWriter | null
  traceCollector: TraceCollector | null
}

export function createSessionInfra(deps: SessionInfraDeps): SessionInfra {
  const { sessionId, projectCwd, config, description } = deps

  const budgetTracker = deps.budgetTracker ?? createBudgetTracker({
    sessionId,
    baseDir: projectCwd,
    emitter: deps.emitter,
    workflowId: deps.workflowId,
    budgetLimits: deps.budgetLimits,
  })

  // Seed from config so % works before first "result" event; authoritative value overwrites later
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

export type MetricsWriter = (patch: { tokens: number; cost: number; contextPercent: number }) => void

export function wireSessionSubscribers(
  bus: EventBus,
  emit: EmitFn,
  workflowId: string,
  infra: Pick<SessionInfra, "budgetTracker" | "transcriptWriter" | "traceCollector">,
  metricsWriter?: MetricsWriter,
): Unsubscribe[] {
  const unsubs: Unsubscribe[] = []

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

  if (infra.transcriptWriter) {
    const tw = infra.transcriptWriter
    unsubs.push(
      bus.subscribeToType("subprocess:ndjson", (e) => {
        tw.handleEvent(e.ndjsonEvent)
      }),
    )
  }

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
