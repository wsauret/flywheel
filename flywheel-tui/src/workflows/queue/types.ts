// ---------------------------------------------------------------------------
// Queue System — Core Types
// ---------------------------------------------------------------------------
//
// Foundational types for the queue-based step execution engine.
// All data structures are validated at runtime via companion Zod schemas
// in ./schemas.ts.
//
// Terminology:
//   Step   — single unit of work (replaces "step")
//   Queue  — mutable, ordered list of steps for a session
//   Workflow — named template that generates an initial queue
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// EndOfSessionGateResult — inlined from session/validation-state
// (workflows must not depend on session module)
// ---------------------------------------------------------------------------

export interface FailedAssertion {
  /** Assertion ID (e.g., "VAL-AUTH-001") */
  id: string;
  /** Human-readable title (falls back to ID if no title map provided) */
  title: string;
  /** Current status: "pending", "failed", or "blocked" */
  status: string;
}

export interface EndOfSessionGateResult {
  /** Whether all relevant assertions passed */
  passed: boolean;
  /** Assertions that did not pass (empty when passed is true) */
  failedAssertions: FailedAssertion[];
  /** Total number of assertions in the state file */
  totalAssertions: number;
  /** Number of assertions with status "passed" */
  passedCount: number;
}

// ---------------------------------------------------------------------------
// StepType — re-exported from infra/ (canonical definition)
// ---------------------------------------------------------------------------

import type { StepType } from "../../infra/step-types.js";
export type { StepType };

// ---------------------------------------------------------------------------
// StepStatus — lifecycle state of a single step
// ---------------------------------------------------------------------------

export type StepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

// ---------------------------------------------------------------------------
// Step — a single unit of work in the queue
// ---------------------------------------------------------------------------

export interface Step {
  /** Unique identifier (UUID). */
  readonly id: string;
  /** What kind of step this is. */
  readonly type: StepType;
  /** Human-readable title for display. */
  readonly title: string;
  /** Current lifecycle status. */
  status: StepStatus;

  // --- Execution configuration (ADR-004 Decision 2) ---

  /** Longer description of what this step should accomplish. */
  description?: string;
  /** Guidance for the dispatcher's prompt strategy. */
  dispatcherHint?: string;
  /** Tool permission scoping for the worker. */
  toolScoping?: { read: boolean; bash: boolean; write: boolean; edit: boolean; task?: boolean };
  /**
   * Evaluator rubric — how to assess this step's output.
   * Set by templates for non-work steps; for work steps the dispatcher
   * derives criteria from acceptanceCriteria.
   */
  evaluationCriteria?: string;

  // --- Work content (populated for work steps from plan output) ---

  /** What the work must achieve (substance). Included in worker prompt. */
  acceptanceCriteria?: string[];
  /** Files relevant to this step's work. */
  fileReferences?: string[];

  // --- Human-in-the-loop component ---

  /**
   * Optional HITL component. When enabled, worker pauses mid-step
   * to present information and wait for user input.
   */
  hitl?: { prompt: string; enabled: boolean };

  // --- Grouping ---

  /** Groups related steps for feature boundary detection. */
  feature?: string;
  /** Validation contract assertion IDs this step fulfills. */
  fulfills?: string[];
  /** IDs of steps this step depends on (future DAG support). */
  dependsOn?: string[];
  /** Milestone this step belongs to. */
  milestone?: string;

  // --- P3 triage result (review steps only) ---

  /** P3 triage result from review step. Contains either explicit user selections or an auto-directive. */
  p3Triage?: {
    included?: Array<{ description: string; location?: string; suggestion: string }>;
    excluded?: Array<{ description: string; location?: string; suggestion: string }>;
    source?: string;
    directive?: string;
  };
}

// ---------------------------------------------------------------------------
// QueueStatus — overall queue lifecycle
// ---------------------------------------------------------------------------

export type QueueStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "paused";

// ---------------------------------------------------------------------------
// MutationLogEntry — provenance record for queue mutations
// ---------------------------------------------------------------------------

export interface MutationLogEntry {
  /** ISO-8601 timestamp of when the mutation occurred. */
  readonly timestamp: string;
  /** Kind of mutation (insert, remove, skip, reorder, replace, status-change). */
  readonly action: string;
  /** Who triggered the mutation (executor, user, sprint-hook, etc.). */
  readonly actor: string;
  /** Why the mutation was performed. */
  readonly reason: string;
  /** IDs of the steps affected by this mutation. */
  readonly stepIds: string[];
}

// ---------------------------------------------------------------------------
// Queue — the mutable, ordered list of steps for a session
// ---------------------------------------------------------------------------

export interface Queue {
  /** Ordered list of steps. */
  steps: Step[];
  /** Index of the current (or next) step to execute. */
  cursor: number;
  /** Overall queue lifecycle status. */
  status: QueueStatus;
  /** Provenance log of all mutations applied to this queue. */
  mutationLog: MutationLogEntry[];
  /** Maximum number of steps allowed. Inserts exceeding this are rejected. */
  maxSteps?: number;
}

// ---------------------------------------------------------------------------
// WorkflowTemplate — named preset that generates an initial queue
// ---------------------------------------------------------------------------

export interface WorkflowTemplate {
  /** Machine-readable name (e.g., "plan-work-review"). */
  readonly name: string;
  /** Human-readable label for display (e.g., "Plan + Work + Review"). */
  readonly label: string;
  /** Short description of what this workflow does. */
  readonly description: string;
  /** Step types to create in the initial queue. */
  readonly initialStepTypes: StepType[];
}

// ---------------------------------------------------------------------------
// Queue Execution Result Types
// ---------------------------------------------------------------------------

/**
 * Lightweight result for a completed step — used in QueueResult.stepResults
 * to communicate which step types completed.
 */
export interface CompletedStepResult {
  workflow: string;
  completed: boolean;
}

/**
 * Result from queue execution, used by queue-completion and shell.
 *
 * @deprecated Prefer StepExecutorResult from src/queue/executor.ts for new code.
 * This shim is retained for handleQueueCompletion() and session-orchestrator.
 */
export interface QueueResult {
  completed: boolean;
  stepsCompleted: number;
  stepsTotal: number;
  reason?: string;
  stepResults: CompletedStepResult[];
}

/**
 * End-of-session gate check function.
 * Called after all steps complete successfully, before declaring queue completion.
 * Returns the gate result indicating whether all validation assertions passed.
 */
export type EndOfSessionGateCheck = () => Promise<EndOfSessionGateResult>;
