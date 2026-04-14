import { createBudgetTracker } from "./budget-tracker.js"
import type { BudgetTracker } from "./budget-tracker-types.js"
import { createTraceWriter, type TraceWriter } from "./trace-writer.js"
import { createTranscriptWriter, type TranscriptWriter } from "./transcript-writer.js"
import { createTraceCollector, type TraceCollector } from "./trace-collector.js"
import { createTraceEventHandler } from "../engines/subprocess/trace-event-handler.js"
import type { FlywheelConfig } from "../config/schema.js"
import type { EventBus, EmitFn, Unsubscribe } from "../../infra/event-bus.js"
import type { BudgetLimits } from "../../workflows/schemas.js"
import { extractContextUpdate, contextWindowForModel } from "../engines/providers/claude-context.js"

interface SessionInfraDeps {
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

  const traceWriter = config.tracing.enabled
    ? createTraceWriter({ sessionId, baseDir: projectCwd, maxTraces: config.tracing.max_traces })
    : null
  const transcriptWriter = config.tracing.enabled
    ? createTranscriptWriter({ sessionId, baseDir: projectCwd })
    : null
  const traceCollector = config.tracing.enabled && traceWriter
    ? createTraceCollector({ writer: traceWriter, sessionId, workflowName: description })
    : null

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
  const unsubs: Unsubscribe[] = [
    bus.subscribeToType("subprocess:spawned", () => infra.budgetTracker.onNewSubprocess()),
    bus.subscribeToType("subprocess:ndjson", (e) => {
      infra.budgetTracker.handleEvent(e.ndjsonEvent)
      const ctxUpdate = extractContextUpdate(e.ndjsonEvent)
      if (ctxUpdate) {
        infra.budgetTracker.updateContextUtilization(ctxUpdate.promptTokens, ctxUpdate.contextWindow)
      }
    }),
  ]

  if (metricsWriter) {
    unsubs.push(bus.subscribeToType("budget:metrics-changed", (e) => {
      metricsWriter({
        tokens: e.tokens,
        cost: e.cost,
        contextPercent: infra.budgetTracker.getContextUtilization().percent,
      })
    }))
  }

  if (infra.transcriptWriter) {
    const tw = infra.transcriptWriter
    unsubs.push(bus.subscribeToType("subprocess:ndjson", (e) => tw.handleEvent(e.ndjsonEvent)))
  }

  if (infra.traceCollector) {
    const traceHandler = createTraceEventHandler({ emit, workflowId })
    unsubs.push(bus.subscribeToType("subprocess:ndjson", (e) => traceHandler.handleEvent(e.ndjsonEvent)))
    unsubs.push(...infra.traceCollector.subscribeToEvents(bus))
  }

  return unsubs
}
