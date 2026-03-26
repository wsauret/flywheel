/**
 * Sprint Types — shared type definitions for sprint mode.
 *
 * These types are used by:
 *   - src/sprint/escalation-context.ts
 *   - src/queue/sprint.ts
 *
 * Extracted from the former sprint-loop.ts so they can be shared
 * without depending on the deleted loop implementation.
 */

import type { VerificationResult } from "./verification-runner";

// ---------------------------------------------------------------------------
// Sprint Iteration Record
// ---------------------------------------------------------------------------

export interface SprintIterationRecord {
  iteration: number;
  workerSummary: string;
  verificationResult?: VerificationResult;
  evaluatorPassed?: boolean;
  evaluatorFeedback?: {
    implementation: string;
    script: string;
  };
  scriptContent?: string;
  workerCrashed?: boolean;
  missingArtifact?: string;
}

// ---------------------------------------------------------------------------
// Sprint Loop Result
// ---------------------------------------------------------------------------

export interface SprintLoopResult {
  /** Whether the sprint completed successfully (evaluator or script passed). */
  completed: boolean;
  /** Number of iterations actually used. */
  iterationsUsed: number;
  /** Whether the sprint was escalated (hard cap reached). */
  escalated: boolean;
  /** Full iteration history for escalation carry-forward. */
  iterationHistory: SprintIterationRecord[];
  /** Stop reason when not completed. */
  reason?: string;
}
