import type { DefinitionLineageView } from "../../workflows/definition-provenance-projection.js"
import type { WorkflowLaunchBindingSchema, WorkflowRunSettingsSchema } from "../../workflows/run-facts.js"

/** Configuration and current invocation ownership, independent of replaceable VM control roots. */
export type WorkflowRunRecord = typeof WorkflowRunSettingsSchema.Type & {
  readonly launchedFrom: typeof WorkflowLaunchBindingSchema.Type
}

/** Workflow-keyed reads. Missing records return null; unreadable durable facts report their decoding error. */
export interface WorkflowRunReader {
  readCut(workflowId: string): Promise<{ readonly by: "person" | "agent" | "runtime" | "replacement"; readonly timestamp: number } | null>
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
