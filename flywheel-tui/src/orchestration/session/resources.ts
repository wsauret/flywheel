import type { BudgetTracker } from "./budget-tracker-types.js"
import type { TraceWriter } from "./trace-writer"
import type { TranscriptWriter } from "./transcript-writer"
import type { TraceCollector } from "./trace-collector"
import type { OutputFlusher } from "./output-persistence"

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
  traceCollector?.dispose()
  traceWriter?.dispose()
  transcriptWriter?.dispose()
  budgetTracker.dispose()
  outputFlusher.dispose()
}
