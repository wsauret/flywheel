/**
 * The one reading of context pressure every client shows.
 *
 * Automatic compaction runs at a token count that the runtime decides per
 * session, not at the model's full window, so the informative number is how
 * much room is left before that count: a session at 30k tokens under a 270k
 * trigger has 89% of its runway left even when it has used only 3% of a
 * million-token window. The runtime publishes its trigger with the session's
 * totals (`compactionTriggerTokens`), because the trigger depends on the
 * model's window and on the size of a fresh context, which no client knows.
 * Deriving the reading here keeps the TUI and an editor client telling the
 * same story.
 */

/** The token count that the gauge measures against: the trigger that the
 *  runtime published for the session, or the configured count while the
 *  session's history states none. 0 means that no automatic compaction runs. */
export function compactionTrigger(budget: { readonly compactionThreshold: number; readonly compactionTriggerTokens?: number | undefined }): number {
  return budget.compactionTriggerTokens ?? budget.compactionThreshold
}

interface CompactionReading {
  /** 0..1, how much of the runway to the trigger is used. Drives a gauge. */
  readonly usedFraction: number
  /** 0..100, how much runway is left before auto-compaction. */
  readonly remainingPercent: number
}

/** `trigger` is the result of `compactionTrigger`. Null when no automatic
 *  compaction runs (trigger 0), in which case the window itself is the only
 *  ceiling and `contextPercent` is the reading. */
export function compactionReading(contextPromptTokens: number, trigger: number): CompactionReading | null {
  if (!Number.isFinite(trigger) || trigger <= 0) return null
  const used = Math.min(1, Math.max(0, contextPromptTokens / trigger))
  return { usedFraction: used, remainingPercent: Math.max(0, Math.round((1 - used) * 100)) }
}

export interface ContextGaugeCopy {
  /** Fraction of the compaction trigger used, or window share when none runs. */
  readonly used: number
  readonly reading: string
  readonly detail: string
}

/** Shared context explanation for terminal and web controls. */
export function contextGaugeCopy(budget: { contextPercent: number; contextPromptTokens: number; compactionThreshold: number; compactionTriggerTokens?: number | undefined }): ContextGaugeCopy {
  const trigger = compactionTrigger(budget)
  const reading = compactionReading(budget.contextPromptTokens, trigger)
  const tokens = budget.contextPromptTokens.toLocaleString()
  if (reading === null) {
    return {
      used: Math.min(1, Math.max(0, budget.contextPercent / 100)),
      reading: `${Math.round(budget.contextPercent)}% of the context window used.`,
      // The setting is on, but the runtime found no trigger that a fresh
      // context would be below.
      detail: budget.compactionThreshold > 0 ? `${tokens} tokens in context; auto-compact is deferred.` : `${tokens} tokens in context; auto-compact is off.`,
    }
  }
  return {
    used: reading.usedFraction,
    reading: `${reading.remainingPercent}% of context remaining until auto-compact.`,
    detail: `${tokens} of ${trigger.toLocaleString()} tokens before compaction.`,
  }
}
