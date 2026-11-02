/**
 * The one reading of context pressure every client shows.
 *
 * Proactive compaction triggers on an absolute token cap
 * (`proactiveCompactionThreshold`), not on the model's full window, so the
 * informative number is how much room is left before that cap: a session at
 * 30k tokens under a 270k cap has 89% of its runway left even when it has
 * used only 3% of a million-token window. Deriving it here, from the two wire
 * values every client already has, keeps the TUI and an editor client telling
 * the same story.
 */

interface CompactionReading {
  /** 0..1, how much of the runway to the cap is used. Drives a gauge. */
  readonly usedFraction: number
  /** 0..100, how much runway is left before auto-compaction. */
  readonly remainingPercent: number
}

/** Null when proactive compaction is off (threshold 0), in which case the
 *  window itself is the only ceiling and `contextPercent` is the reading. */
export function compactionReading(contextPromptTokens: number, threshold: number): CompactionReading | null {
  if (!Number.isFinite(threshold) || threshold <= 0) return null
  const used = Math.min(1, Math.max(0, contextPromptTokens / threshold))
  return { usedFraction: used, remainingPercent: Math.max(0, Math.round((1 - used) * 100)) }
}

export interface ContextGaugeCopy {
  /** Fraction of the compaction threshold used, or window share when disabled. */
  readonly used: number
  readonly reading: string
  readonly detail: string
}

/** Shared context explanation for terminal and web controls. */
export function contextGaugeCopy(budget: { contextPercent: number; contextPromptTokens: number; compactionThreshold: number }): ContextGaugeCopy {
  const reading = compactionReading(budget.contextPromptTokens, budget.compactionThreshold)
  const tokens = budget.contextPromptTokens.toLocaleString()
  if (reading === null) {
    return {
      used: Math.min(1, Math.max(0, budget.contextPercent / 100)),
      reading: `${Math.round(budget.contextPercent)}% of the context window used.`,
      detail: `${tokens} tokens in context; auto-compact is off.`,
    }
  }
  return {
    used: reading.usedFraction,
    reading: `${reading.remainingPercent}% of context remaining until auto-compact.`,
    detail: `${tokens} of ${budget.compactionThreshold.toLocaleString()} tokens before compaction.`,
  }
}
