/**
 * Session Resources — unified disposal of session infrastructure.
 *
 * `SessionResources` is the canonical shape returned by `createSessionInfra`,
 * plus the `outputFlusher` owned by the runner.
 *
 * `disposeSessionResources()` ensures correct ordering:
 *   1. finalize traces (sync)
 *   2. flush output + budget
 *   3. dispose all resources
 *
 * Side effect ownership:
 *   - outputFlusher: owned by runner (workflow-runner or chat-runner)
 *   - label persistence: owned by registry effect
 *   - context warning: owned by chat-session
 */

import type { BudgetTracker } from "./budget-tracker"
import type { TraceWriter } from "./trace-writer"
import type { TranscriptWriter } from "./transcript-writer"
import type { TraceCollector } from "./trace-collector"
import type { OutputFlusher } from "./output-persistence"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionResources {
  budgetTracker: BudgetTracker
  traceWriter: TraceWriter | null
  transcriptWriter: TranscriptWriter | null
  traceCollector: TraceCollector | null
  outputFlusher: OutputFlusher
}

// ---------------------------------------------------------------------------
// Disposal
// ---------------------------------------------------------------------------

/** Track which resource instances have already been disposed to make double-dispose a no-op. */
const disposedSet = new WeakSet<SessionResources>()

/**
 * Dispose all session resources in the correct order:
 * 1. Finalize traces (sync) — closes open spans, writes index
 * 2. Flush — output flusher (async) + budget tracker (sync)
 * 3. Dispose — all writers, collectors, flusher, budget tracker
 *
 * Double-dispose is a safe no-op.
 */
export async function disposeSessionResources(
  resources: SessionResources,
  traceStatus: "ok" | "error",
): Promise<void> {
  if (disposedSet.has(resources)) return
  disposedSet.add(resources)

  const { budgetTracker, traceWriter, transcriptWriter, traceCollector, outputFlusher } = resources

  // 1. Finalize traces (sync)
  traceCollector?.finalize(traceStatus)

  // 2. Flush
  await outputFlusher.flush()
  budgetTracker.flush()

  // 3. Dispose all
  traceCollector?.dispose()
  traceWriter?.dispose()
  transcriptWriter?.dispose()
  budgetTracker.dispose()
  outputFlusher.dispose()
}
