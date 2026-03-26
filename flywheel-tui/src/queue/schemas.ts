import { z } from "zod";

// ---------------------------------------------------------------------------
// Queue System — Zod Schemas
// ---------------------------------------------------------------------------
//
// Runtime validation for all queue types. Companion to ./types.ts.
// Follows project conventions: .strict() on all object schemas,
// z.enum() for unions, z.infer<> for derived types.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// StepType
// ---------------------------------------------------------------------------

export const StepTypeSchema = z.enum([
  "plan",
  "work",
  "review",
  "ship",
  "debug",
  "research",
  "verify",
  "gate",
]);

// ---------------------------------------------------------------------------
// StepStatus
// ---------------------------------------------------------------------------

export const StepStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "skipped",
]);

// ---------------------------------------------------------------------------
// Step
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// HitlSchema — human-in-the-loop component
// ---------------------------------------------------------------------------

export const HitlSchema = z.object({
  /** What to present to the user. */
  prompt: z.string(),
  /** Whether HITL is active. When false the worker proceeds autonomously. */
  enabled: z.boolean(),
}).strict();

// ---------------------------------------------------------------------------
// ToolScopingStepSchema — per-step tool permission scoping
// ---------------------------------------------------------------------------

export const ToolScopingStepSchema = z.object({
  read: z.boolean(),
  bash: z.boolean(),
  write: z.boolean(),
  edit: z.boolean(),
}).strict();

export const StepSchema = z.object({
  /** Unique identifier (UUID). */
  id: z.string(),
  /** What kind of step this is. */
  type: StepTypeSchema,
  /** Human-readable title for display. */
  title: z.string(),
  /** Current lifecycle status. */
  status: StepStatusSchema,

  // --- Execution configuration (ADR-004 Decision 2) ---
  /** Longer description of what this step should accomplish. */
  description: z.string().optional(),
  /** Guidance for the dispatcher's prompt strategy. */
  dispatcherHint: z.string().optional(),
  /** Tool permission scoping for the worker. */
  toolScoping: ToolScopingStepSchema.optional(),
  /** Evaluator rubric — how to assess this step's output. */
  evaluationCriteria: z.string().optional(),

  // --- Work content ---
  /** What the work must achieve (substance). */
  acceptanceCriteria: z.array(z.string()).optional(),
  /** Files relevant to this step's work. */
  fileReferences: z.array(z.string()).optional(),

  // --- Human-in-the-loop ---
  /** Optional HITL component. */
  hitl: HitlSchema.optional(),

  // --- Grouping ---
  /** Groups related steps for feature boundary detection. */
  feature: z.string().optional(),
  /** Validation contract assertion IDs this step fulfills. */
  fulfills: z.array(z.string()).optional(),
  /** IDs of steps this step depends on (future DAG support). */
  dependsOn: z.array(z.string()).optional(),
  /** Milestone this step belongs to. */
  milestone: z.string().optional(),
}).strict();

// ---------------------------------------------------------------------------
// QueueStatus
// ---------------------------------------------------------------------------

export const QueueStatusSchema = z.enum([
  "idle",
  "running",
  "completed",
  "failed",
  "paused",
]);

// ---------------------------------------------------------------------------
// MutationLogEntry
// ---------------------------------------------------------------------------

export const MutationLogEntrySchema = z.object({
  /** ISO-8601 timestamp of when the mutation occurred. */
  timestamp: z.string(),
  /** Kind of mutation. */
  action: z.string(),
  /** Who triggered the mutation. */
  actor: z.string(),
  /** Why the mutation was performed. */
  reason: z.string(),
  /** IDs of the steps affected. */
  stepIds: z.array(z.string()),
}).strict();

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export const QueueSchema = z.object({
  /** Ordered list of steps. */
  steps: z.array(StepSchema),
  /** Index of the current (or next) step to execute. */
  cursor: z.number().int().min(0),
  /** Overall queue lifecycle status. */
  status: QueueStatusSchema,
  /** Provenance log of all mutations. */
  mutationLog: z.array(MutationLogEntrySchema),
  /** Maximum number of steps allowed. Inserts exceeding this are rejected. */
  maxSteps: z.number().int().min(1).optional(),
}).strict();

// ---------------------------------------------------------------------------
// WorkflowTemplate
// ---------------------------------------------------------------------------

export const WorkflowTemplateSchema = z.object({
  /** Machine-readable name. */
  name: z.string(),
  /** Human-readable label for display. */
  label: z.string(),
  /** Short description. */
  description: z.string(),
  /** Step types to create in the initial queue. */
  initialStepTypes: z.array(StepTypeSchema),
}).strict();
