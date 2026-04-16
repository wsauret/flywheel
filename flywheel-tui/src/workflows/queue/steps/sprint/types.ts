// SPRINT_HINT — typed constant for dispatcher hint, scaffolding key,
// and template registration. Never use a raw "sprint" string.

export const SPRINT_HINT = "sprint" as const;

// SprintIterationRecord — one iteration of the sprint loop

export interface SprintIterationRecord {
  /** 1-based iteration number. */
  iteration: number;
  /** Worker handoff summary (extracted from handoffData). */
  workerSummary: string;
  /** Evaluator feedback text when eval did not pass. */
  evalFeedback?: string;
  /** Whether native verification checks passed this iteration. */
  nativeCheckPassed?: boolean;
  /** Whether the worker process crashed. */
  workerCrashed?: boolean;
}

// SprintLoopState — sprint lifecycle tracking (discriminated on status)

interface SprintLoopBase {
  iterationCount: number;
  history: SprintIterationRecord[];
}

export type SprintLoopState =
  | (SprintLoopBase & { status: "running" })
  | (SprintLoopBase & { status: "completed" })
  | (SprintLoopBase & { status: "exhausted"; reason: string });
