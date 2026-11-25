import type { StoredFact } from "../../../infra/store/event-store-types.js"
import type { DefinitionLineageView } from "../../../workflows/run/definition-provenance-projection.js"
import type { WorkflowCapabilityBoundary, WorkflowLaunchBindingSchema, WorkflowRunSettingsSchema } from "../../../workflows/run/run-facts.js"

/** The control authority of an interrupter: a person, then the parent
 *  agent, then the runtime and every other cause. A lower rank wins. */
export const interruptRank = (by: TurnInterruption): number => by === "person" ? 0 : by === "agent" ? 1 : 2

/** Selects one cut with person-first control authority; equal actors retain their original evidence. */
export function strongestInterrupt<T extends { readonly by: TurnInterruption }>(cuts: readonly (T | undefined)[]): T | undefined {
  return cuts.filter((cut): cut is T => cut !== undefined).toSorted((a, b) => interruptRank(a.by) - interruptRank(b.by))[0]
}
import type { TurnInterruption } from "../conversation/turn-end-record.js"

/** Who holds a workflow run's whole-run cut, and when it was made. */
export type WorkflowRunCut = { readonly by: "person" | "agent" | "runtime" | "replacement"; readonly timestamp: number }

/** The run cut after `recorded` commits over `current`. A release clears
 *  any cut. A cut replaces the current one only when its author ranks
 *  above the current author (person, then parent agent, then runtime),
 *  so a person's cut yields only to a release. */
export function nextRunCut(current: WorkflowRunCut | null, recorded: WorkflowRunCut | null): WorkflowRunCut | null {
  return recorded === null ? null : strongestInterrupt([current ?? undefined, recorded]) ?? null
}

/** Configuration and current invocation ownership, independent of replaceable VM control roots. */
export type WorkflowRunRecord = typeof WorkflowRunSettingsSchema.Type & {
  readonly launchedFrom: typeof WorkflowLaunchBindingSchema.Type
}

/** Workflow-keyed reads. Missing records return null; unreadable durable facts report their decoding error. */
export interface WorkflowRunReader {
  readCut(workflowId: string): Promise<WorkflowRunCut | null>
  readAttempt(workflowId: string, attemptId: string): Promise<import("../../../workflows/control-facts/graph-types.js").Attempt | null>
  /** The attempt that a member session serves now (refer to
   *  `servedAttempts`), else the attempt that opened the session. */
  readMemberAttempt(workflowId: string, member: { readonly attemptId: string; readonly conversationId: string }): Promise<import("../../../workflows/control-facts/graph-types.js").Attempt | null>
  read(workflowId: string): Promise<WorkflowRunRecord | null>
  /** The run while it can still take a turn: null when it is missing,
   *  deleted, or completed. */
  readOpen(workflowId: string): Promise<WorkflowRunRecord | null>
  readRequest(workflowId: string): Promise<string | null>
  readCreationRequest(workflowId: string): Promise<string | null>
  /** The boundary the launch recorded, or undefined when it recorded none. */
  readCapabilityBoundary(workflowId: string): Promise<WorkflowCapabilityBoundary | undefined>
  readDefinitionLineage(workflowId: string): Promise<DefinitionLineageView>
  /** Current launch bindings determine which runs a chat owns, including zero-member runs. */
  listForParent(parentSessionId: string): Promise<readonly { readonly workflowId: string; readonly run: WorkflowRunRecord }[]>
  list(): Promise<readonly { readonly workflowId: string; readonly run: WorkflowRunRecord }[]>
  /** Every run that can still take a turn, in registration order. */
  listOpen(): Promise<readonly { readonly workflowId: string; readonly run: WorkflowRunRecord }[]>
  /** The workflows whose run, or whether it can still take a turn, a
   *  committed batch changes. Makes no read. */
  changedRuns(events: readonly StoredFact[]): ReadonlySet<string>
}

/** Guarded edits of aggregate-owned settings. A concurrent control/configuration commit returns false. */
export interface WorkflowRunWriter {
  update(workflowId: string, edit: (current: WorkflowRunRecord) => WorkflowRunRecord | null, labelSource?: "user" | "generated" | "configuration"): Promise<boolean>
}
