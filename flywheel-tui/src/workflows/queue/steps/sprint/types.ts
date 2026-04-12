// ---------------------------------------------------------------------------
// Sprint Types — shared type definitions for sprint mode.
//
// Ported from src-legacy/queue/steps/sprint-work/sprint-types.ts
// and adapted to the new architecture:
//   - SprintLoopState uses a discriminated union (not two booleans)
//   - SprintConfig derived from FlywheelConfig['sprint'] via z.infer
//   - SPRINT_HINT is a typed const literal
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SPRINT_HINT — typed constant for dispatcher hint, scaffolding key,
// and template registration. Never use a raw "sprint" string.
// ---------------------------------------------------------------------------

export const SPRINT_HINT = "sprint" as const;

// ---------------------------------------------------------------------------
// SprintIterationRecord — one iteration of the sprint loop
// ---------------------------------------------------------------------------

export interface SprintIterationRecord {
  /** 1-based iteration number. */
  iteration: number;
  /** Worker handoff summary (extracted from handoffData). */
  workerSummary: string;
  /** Evaluator feedback text when eval did not pass. */
  evalFeedback?: string;
  /** Whether native verification checks passed this iteration. */
  nativeCheckPassed?: boolean;
  /** Whether the worker subprocess crashed. */
  workerCrashed?: boolean;
  /** Cached normalized feedback for stuck detection (avoids re-normalizing). */
  _normalizedFeedback?: string;
}

// ---------------------------------------------------------------------------
// SprintLoopState — discriminated union for sprint lifecycle
//
// Uses `status` discriminant instead of two booleans (completed + escalated)
// for safer exhaustiveness checking and cleaner pattern matching.
// ---------------------------------------------------------------------------

export interface SprintLoopState {
  /** Current sprint lifecycle status. */
  status: "running" | "completed" | "escalated";
  /** Number of iterations consumed so far. */
  iterationCount: number;
  /** Full iteration history for escalation carry-forward. */
  history: SprintIterationRecord[];
  /** Stop reason when escalated. */
  reason?: string;
}
