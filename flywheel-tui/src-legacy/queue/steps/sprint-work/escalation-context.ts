/**
 * Sprint Escalation Context — packages sprint iteration history for carry-forward
 * to the full queue (plan→work→review) when sprint exhausts its iteration cap.
 *
 * The escalation context includes:
 * - All attempt summaries from every sprint iteration
 * - All evaluator feedback (implementation + script channels)
 * - Verification script content and results from each iteration
 * - Worker crash/missing artifact information
 * - Number of iterations used and escalation reason
 *
 * This context is serialized as JSON and threaded through the queue's
 * args so the planner can account for what was already tried.
 */

import type { SprintIterationRecord, SprintLoopResult } from "./sprint-types"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EscalationContext {
  /** Number of sprint iterations that were executed. */
  iterationsUsed: number
  /** Reason for escalation (e.g., "Max iterations reached"). */
  reason: string
  /** Full iteration history with all attempt details. */
  iterationHistory: SprintIterationRecord[]
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build an EscalationContext from a SprintLoopResult.
 *
 * The context preserves the full iteration history as-is, including:
 * - workerSummary (what each attempt produced)
 * - evaluatorFeedback (dual-channel: implementation + script)
 * - verificationResult (stdout, stderr, exitCode, passed)
 * - scriptContent (verification script source code)
 * - workerCrashed / missingArtifact flags
 *
 * The result is JSON-serializable for threading through queue args.
 */
export function buildEscalationContext(result: SprintLoopResult): EscalationContext {
  return {
    iterationsUsed: result.iterationsUsed,
    reason: result.reason ?? "Sprint escalated",
    iterationHistory: result.iterationHistory,
  }
}
