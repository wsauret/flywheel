import type { BudgetTracker } from "./budget-tracker-types.js"
import type { TraceWriter } from "./trace-writer.js"
import type { TranscriptWriter } from "./transcript-writer.js"
import type { TraceCollector } from "./trace-collector.js"
import type { OutputFlusher } from "./output-persistence.js"

export interface SessionResources {
  budgetTracker: BudgetTracker
  traceWriter: TraceWriter | null
  transcriptWriter: TranscriptWriter | null
  traceCollector: TraceCollector | null
  outputFlusher: OutputFlusher
}

const disposedSet = new WeakSet<SessionResources>()

export async function disposeSessionResources(
  resources: SessionResources,
  traceStatus: "ok" | "error",
): Promise<void> {
  if (disposedSet.has(resources)) return
  disposedSet.add(resources)

  const { budgetTracker, traceWriter, transcriptWriter, traceCollector, outputFlusher } = resources

  // Ordering: finalize traces → flush → dispose (ADR-006 disposal protocol)
  traceCollector?.finalize(traceStatus)
  await outputFlusher.flush()
  budgetTracker.flush()
  await traceCollector?.dispose()
  await traceWriter?.dispose()
  await transcriptWriter?.dispose()
  await budgetTracker.dispose()
  await outputFlusher.dispose()
}
