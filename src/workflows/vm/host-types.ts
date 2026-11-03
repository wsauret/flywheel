import { Schema } from "effect"
import type { AsyncEventStateReadSurface, AsyncEventWriter, GuardedAppendResult, GuardedEventStoreAppend } from "../../infra/event-store-types.js"
import type { WorkflowView } from "../view/types.js"
import type { WorkflowContextStore } from "../context-bundle/context-store.js"
import type { AddressedAddendum, RequestAddendumMessage } from "../context-bundle/context-facts.js"
import type { WorkflowViewStore } from "../view/view-store.js"
import type { ProjectDefinitionRegistryRevision } from "../definition-registry.js"
import type { WorkflowDefinition } from "../workflow-schema.js"
import type { AttemptExecutor } from "./attempt-runner.js"
import type { AttemptExecutionInput } from "./commands.js"

const IdSchema = Schema.NonEmptyString
const MessageSchema = Schema.NonEmptyString

export class WorkflowHostStorageError extends Schema.TaggedError<WorkflowHostStorageError>()(
  "WorkflowHostStorageError",
  { operation: Schema.NonEmptyString, message: MessageSchema },
) {}

export class WorkflowHostWorkerError extends Schema.TaggedError<WorkflowHostWorkerError>()(
  "WorkflowHostWorkerError",
  { attemptId: IdSchema, message: MessageSchema },
) {}

export class WorkflowAttemptRefusedError extends Schema.TaggedError<WorkflowAttemptRefusedError>()(
  "WorkflowAttemptRefusedError",
  { attemptId: IdSchema, message: MessageSchema },
) {}

export class WorkflowHostFollowUpError extends Schema.TaggedError<WorkflowHostFollowUpError>()(
  "WorkflowHostFollowUpError",
  { conversationId: IdSchema, message: MessageSchema },
) {}

export class WorkflowHostInterruptionError extends Schema.TaggedError<WorkflowHostInterruptionError>()(
  "WorkflowHostInterruptionError",
  { operation: Schema.NonEmptyString, message: MessageSchema },
) {}

export class WorkflowHostLifecycleError extends Schema.TaggedError<WorkflowHostLifecycleError>()(
  "WorkflowHostLifecycleError",
  { operation: Schema.NonEmptyString, message: MessageSchema, failures: Schema.Array(Schema.String) },
) {}

export class WorkflowPreCutoverError extends Schema.TaggedError<WorkflowPreCutoverError>()(
  "WorkflowPreCutoverError",
  { sessionId: IdSchema, message: MessageSchema },
) {}

export class WorkflowMalformedStateError extends Schema.TaggedError<WorkflowMalformedStateError>()(
  "WorkflowMalformedStateError",
  { sessionId: IdSchema, message: MessageSchema },
) {}

export class WorkflowDriftEvidencePersistenceError extends Schema.TaggedError<WorkflowDriftEvidencePersistenceError>()(
  "WorkflowDriftEvidencePersistenceError",
  { workflowId: IdSchema, message: MessageSchema },
) {}

export type WorkflowVmHostFailure =
  | { readonly kind: "attempt_refused"; readonly attemptId: string; readonly message: string }
  | { readonly kind: "storage"; readonly operation: string; readonly message: string }
  | { readonly kind: "worker"; readonly attemptId: string; readonly message: string }
  | { readonly kind: "follow_up"; readonly conversationId: string; readonly message: string }
  | { readonly kind: "interruption"; readonly operation: string; readonly message: string }
  | { readonly kind: "lifecycle"; readonly operation: string; readonly message: string; readonly failures: readonly string[] }
  | { readonly kind: "definition_drift"; readonly workflowId: string; readonly message: string }
  | { readonly kind: "pre_cutover"; readonly sessionId: string; readonly message: string }
  | { readonly kind: "malformed_state"; readonly sessionId: string; readonly message: string }
  | { readonly kind: "drift_evidence_persistence"; readonly workflowId: string; readonly message: string }
  | { readonly kind: "workflow"; readonly message: string }

interface WorkflowVmHostProgress {
  readonly attemptsCompleted: number
  readonly attemptsTotal: number
  readonly view: WorkflowView
  /** The workflow aggregate's append position right after the committed
   *  control revision that the run ended on. Later facts on the aggregate,
   *  such as a learning review's, only raise the position that a reader of
   *  committed control sees. */
  readonly controlSeq: number
}

export type WorkflowVmHostRunResult =
  | ({ readonly kind: "completed" } & WorkflowVmHostProgress)
  | ({ readonly kind: "paused"; readonly reason: string } & WorkflowVmHostProgress)
  | ({ readonly kind: "failed"; readonly failure: WorkflowVmHostFailure } & Partial<WorkflowVmHostProgress>)

export type WorkflowVmHostDisposeResult =
  | { readonly kind: "disposed" }
  | { readonly kind: "failed"; readonly failure: Extract<WorkflowVmHostFailure, { kind: "lifecycle" }> }

export type WorkflowVmStartMode = "launch" | "operator_resume"

export type WorkflowRuntimeEvent =
  | { readonly type: "workflow.run.initialized"; readonly data: { readonly attemptIds: readonly string[] } }
  | { readonly type: "workflow.attempt.started"; readonly data: { readonly attemptId: string; readonly agentName: string } }
  | { readonly type: "workflow.attempt.completed"; readonly data: { readonly attemptId: string; readonly agentName: string; readonly resultSummary?: string } }
  | { readonly type: "workflow.attempt.failed"; readonly data: { readonly attemptId: string; readonly agentName: string; readonly reason: string } }
  | { readonly type: "workflow.attempt.interrupted"; readonly data: { readonly attemptId: string; readonly agentName: string; readonly reason: string } }
  | { readonly type: "workflow.run.paused"; readonly data: { readonly reason: string; readonly attemptsCompleted: number } }
  | { readonly type: "workflow.run.completed"; readonly data: { readonly attemptsCompleted: number } }
  | { readonly type: "workflow.run.failed"; readonly data: { readonly reason: string; readonly attemptsCompleted: number } }

export interface WorkflowVmHostLifecycle {
  readonly flushConversation?: () => void | Promise<void>
  readonly settleBackground?: () => void | Promise<void>
  readonly drainEventBus?: () => void | Promise<void>
  readonly drainWriter?: () => void | Promise<void>
  readonly disposeProjections?: () => void | Promise<void>
  readonly disposeAdapters?: () => void | Promise<void>
  readonly disposeRemaining?: () => void | Promise<void>
}

/** The attempt that a commit settles, and the conversation it ran in. */
export interface SettlingAttempt {
  readonly attemptId: string
  readonly conversationId: string
}

export interface WorkflowVmHostDeps {
  readonly startMode: WorkflowVmStartMode
  readonly sessionId: string
  readonly reader: AsyncEventStateReadSurface
  readonly writer: AsyncEventWriter
  /** Production composition commits started member sessions in the same guarded transaction as VM control. */
  readonly commitBatch?: (events: readonly GuardedEventStoreAppend[]) => Promise<GuardedAppendResult>
  readonly queueStore: WorkflowViewStore
  readonly contextStore: WorkflowContextStore
  /** Complete immutable definition revision admitted for this run. Its
   *  skills and personas compose the run's agents. */
  readonly definitionRevision: ProjectDefinitionRegistryRevision
  /** The definition this run executes, which admission resolved from the
   *  workflow file. */
  readonly workflow: WorkflowDefinition
  readonly attemptRunner: AttemptExecutor
  readonly emit: (event: WorkflowRuntimeEvent) => void | Promise<void>
  readonly conversationId?: (input?: AttemptExecutionInput) => string
  readonly preAttemptPolicy?: (input: AttemptExecutionInput) => string | null | Promise<string | null>
  /** The messages that the attempt read from its parent session, in reading
   *  order, from every generation of its conversation. The commit that
   *  settles the attempt records each one that the workflow context does not
   *  hold yet as a request addendum. Required, so that no host can record
   *  nothing without a warning. */
  readonly requestAddenda: (attempt: SettlingAttempt) => Promise<readonly RequestAddendumMessage[]>
  /** The messages that a sender addressed to agents or phases of this
   *  workflow and that wait in their held cells. Each commit records every
   *  one that the context does not hold yet, and the host retires their
   *  cells once the commit is published. A host without it, such as a test
   *  host, holds no addressed message. */
  readonly addressedMessages?: {
    read(): Promise<readonly AddressedAddendum[]>
    retire(keys: readonly string[]): Promise<void>
  }
  /** The conversations of `since` that recorded a served model response
   *  strictly after the store position given for each, in one read. The
   *  RECOVER of a crashed run names the attempts whose conversation did, so
   *  their restart count starts over. */
  readonly servedConversations: (since: ReadonlyMap<string, number>) => Promise<ReadonlySet<string>>
  readonly onPostPreflight?: () => void | Promise<void>
  readonly lifecycle?: WorkflowVmHostLifecycle
  readonly now?: () => number
}

export interface WorkflowVmHost {
  /** Whether committed admission or deterministic control can progress without an attempt ending. */
  hasRunnableWork(): boolean
  run(): Promise<WorkflowVmHostRunResult>
  preflight(): Promise<WorkflowVmHostFailure | null>
  abort(reason: string): Promise<boolean>
  dispose(): Promise<WorkflowVmHostDisposeResult>
}
