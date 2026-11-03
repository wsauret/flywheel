import type { WorkflowDefinition } from "../../workflows/workflow-schema.js"
import type { WorkflowView } from "../../workflows/view/types.js"
import type { RecallInput, RecallResult } from "../../protocol/conversation-recall.js"
import type { SessionManager } from "../session/manager.js"
import type { AdmittedWorkflowDeps } from "./deps.js"
import type { EventStoreRuntime } from "../../infra/event-store-effect.js"
import type { AsyncEventStateReadSurface } from "../../infra/event-store-types.js"
import type { AttachChildSessionProjection } from "../module-seams.js"
import type { StoppedBy } from "../../protocol/app-service-types.js"
import type { WorkflowInterruption } from "../session/conversation/turn-end-record.js"
import type { WorkflowCompletionAcknowledgement, WorkflowResult, WorkflowWake, WorkflowRunner } from "./runner-types.js"

/** Admitted inputs of an aggregate host. Started attempts publish their own sessions. */
interface WorkflowStartOptions {
  wake?: WorkflowWake
  sessionId: string
  workflow: WorkflowDefinition
  startMode: "launch" | "operator_resume"
  description: string
  projectRoot: string
  executionCwd: string
  manager: SessionManager
  workflowDeps: AdmittedWorkflowDeps
  recall: (conversationId: string, input: RecallInput) => Promise<RecallResult>
  onSessionName?: (labels: { label: string; shortLabel: string }) => void
  onPrepared?: (queue: WorkflowView) => void | Promise<void>
  onDefinitionAccepted?: () => void | Promise<void>
  onCoreCompleted?: (workflowId: string, result: WorkflowResult) => Promise<WorkflowCompletionAcknowledgement>
  onInterruptionChanged?: (workflowId: string) => void
  onRunnerDone?: (workflowId: string, result: WorkflowResult) => void | Promise<void>
  onRunnerError?: (workflowId: string, err: unknown) => void | Promise<void>
}

export interface WorkflowRunnerFactoryOptions extends Omit<WorkflowStartOptions, "onRunnerDone" | "onRunnerError" | "onCoreCompleted"> {
  readonly runtime: EventStoreRuntime
  readonly projectionReader: AsyncEventStateReadSurface
  readonly attachChildProjection?: AttachChildSessionProjection
  onCoreCompleted?: (result: WorkflowResult) => Promise<WorkflowCompletionAcknowledgement>
}

/** Executor-owned host resources. Durable ownership and status stay in workflow facts. */
export interface WorkflowHosts {
  onChange(listener: () => void): () => void
  start(options: WorkflowStartOptions): Promise<string>
  get(workflowId: string): WorkflowRunner | undefined
  allIds(): readonly string[]
  isRunning(workflowId: string): boolean
  /** The Stop of a run, by a person or its parent agent. */
  abort(workflowId: string, by: StoppedBy): Promise<boolean>
  /** Aborts the run with `cause` and releases its host. */
  remove(workflowId: string, cause: WorkflowInterruption): Promise<void>
  refreshDeps(): Promise<void>
  /** Closes the collection and aborts every run with the cause `causeOf` names for it. */
  disposeAll(causeOf: (workflowId: string) => WorkflowInterruption): Promise<void>
}
