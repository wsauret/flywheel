import type { BriefPersonaSlot, WorkflowTree } from "../../protocol/workflow-view-protocol-types.js";


export type AttemptStatus =
  | "pending"
  | "running"
  | "completed"
  | "blocked"
  | "failed"
  | "skipped";

/** The `then` chain that a stored version 9 row recorded. Remove after
 *  2027-04-30, with that row. */
export interface StepThen {
  readonly step: string; // stored key of a retired version
  readonly when?: string;
  readonly then?: StepThen;
}

/** One attempt of an agent of the workflow. */
export interface AttemptRow {
  /** The attempt id. */
  readonly id: string;
  /** The agent record this attempt runs. Artifact and definition lookups
   *  resolve by it, so one workflow may run one brief in several records. */
  readonly definitionId: string;
  /** The brief that the attempt runs. It names the model seat: durable
   *  model assignments select the model by it (`brief.<briefId>`,
   *  `brief.<briefId>.persona.<role>`). */
  readonly briefId: string;
  /** ID of the workflow definition that produced this attempt. */
  readonly workflowDefinitionId: string;
  readonly name: string;
  readonly status: AttemptStatus;
  readonly description?: string;
  /** The item of an agent of a list. */
  readonly item?: unknown;
  /** Compiled subagent slots: derived from brief frontmatter and persona
   *  metadata at compile time. */
  readonly subagents?: readonly BriefPersonaSlot[];
  /** Workflow-local artifacts this attempt writes after handoff validation. */
  readonly writes: readonly string[];
  /** The conversation of the attempt's agent. Persisted so a resumed attempt
   *  continues its conversation instead of starting fresh. */
  readonly lastConversationId?: string;
  /** Number of crash-recovery retries committed for this attempt. */
  readonly resumeRevertCount: number;
  /** Epoch ms of the first `step.status.changed` to running, and of the
   *  latest one to a settled status. The view projection derives both from
   *  the fact timestamps; no producer writes them. */
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly toolUses?: number;
}

type WorkflowState =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "paused";

export interface MutationLogEntry {
  /** Epoch ms timestamp of when the mutation occurred. */
  readonly timestamp: number;
  /** Kind of mutation (insert, remove, skip, reorder, replace, status-change). */
  readonly action: string;
  /** Workflow-control provenance for the mutation. */
  readonly actor: string;
  /** Why the mutation was performed. */
  readonly reason: string;
  /** IDs of the attempts that the mutation affected. */
  readonly attemptIds: readonly string[];
}

export interface WorkflowView {
  attempts: readonly AttemptRow[];
  /** The sole operational hierarchy, including work without an attempt. */
  tree: WorkflowTree;
  /** Index of the current (or next) attempt to run. */
  cursor: number;
  status: WorkflowState;
  /** Provenance log of all mutations applied to the rows. */
  mutationLog: readonly MutationLogEntry[];
  /** The most attempts that the run can hold. */
  maxAttempts?: number;
  /** Durable `conversation:<id>` key for the conversation after the workflow
   *  completes. Minted before its first turn so a paused-then-resumed
   *  follow-up reopens the same tree; the run-level analogue of an attempt's
   *  `lastConversationId`. */
  followUpConversationId?: string;
}
