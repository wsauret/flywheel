import type { DefinitionLineageView } from "../../workflows/definition-provenance-projection.js"
import type { WorkflowLaunchBindingSchema, WorkflowRunSettingsSchema } from "../../workflows/run-facts.js"
import { strongestInterrupt } from "../session/child-continuation.js"

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
  readAttempt(workflowId: string, attemptId: string): Promise<import("../../workflows/vm/graph-types.js").Attempt | null>
  read(workflowId: string): Promise<WorkflowRunRecord | null>
  readRequest(workflowId: string): Promise<string | null>
  readCreationRequest(workflowId: string): Promise<string | null>
  readDefinitionLineage(workflowId: string): Promise<DefinitionLineageView>
  /** Current launch bindings determine which runs a chat owns, including zero-member runs. */
  listForParent(parentSessionId: string): Promise<readonly { readonly workflowId: string; readonly run: WorkflowRunRecord }[]>
  list(): Promise<readonly { readonly workflowId: string; readonly run: WorkflowRunRecord }[]>
}

/** Guarded edits of aggregate-owned settings. A concurrent control/configuration commit returns false. */
export interface WorkflowRunWriter {
  update(workflowId: string, edit: (current: WorkflowRunRecord) => WorkflowRunRecord | null, labelSource?: "user" | "generated" | "configuration"): Promise<boolean>
}
