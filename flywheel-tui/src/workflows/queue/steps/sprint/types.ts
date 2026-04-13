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
// SprintLoopState — sprint lifecycle tracking
// ---------------------------------------------------------------------------

export interface SprintLoopState {
  status: "running" | "completed" | "exhausted";
  iterationCount: number;
  history: SprintIterationRecord[];
  /** Set when status is "exhausted" (max iterations or stuck). */
  reason?: string;
}
