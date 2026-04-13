// Queue System — Core Types
//
// Foundational types for the queue-based step execution engine.
// All data structures are validated at runtime via companion Zod schemas
// in ./schemas.ts.
//
// Terminology:
//   Step   — single unit of work (replaces "step")
//   Queue  — mutable, ordered list of steps for a session
//   Workflow — named template that generates an initial queue


// StepStatus — lifecycle state of a single step

export type StepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

// Step — a single unit of work in the queue

export interface Step {
  /** Unique identifier (UUID). */
  readonly id: string;
  /** What kind of step this is. */
  readonly type: "work" | "plan";
  /** Human-readable title for display. */
  readonly title: string;
  /** Current lifecycle status. */
  status: StepStatus;

  // --- Execution configuration (ADR-004 Decision 2) ---

  /** Longer description of what this step should accomplish. */
  description?: string;
  /** Guidance for the dispatcher's prompt strategy. */
  dispatcherHint?: string;
  /** Skip the dispatcher on this step — use scaffolding + step metadata directly.
   *  Set by sprint hook on retry steps to keep the loop tight (worker → evaluator). */
  skipDispatcher?: boolean;
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

  // --- Grouping ---

  /** Groups related steps for feature boundary detection. */
  feature?: string;
}

// QueueStatus — overall queue lifecycle

type QueueStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "paused";

// MutationLogEntry — provenance record for queue mutations

export interface MutationLogEntry {
  /** Epoch ms timestamp of when the mutation occurred. */
  readonly timestamp: number;
  /** Kind of mutation (insert, remove, skip, reorder, replace, status-change). */
  readonly action: string;
  /** Who triggered the mutation (executor, user, sprint-hook, etc.). */
  readonly actor: string;
  /** Why the mutation was performed. */
  readonly reason: string;
  /** IDs of the steps affected by this mutation. */
  readonly stepIds: string[];
}

// Queue — the mutable, ordered list of steps for a session

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


