import type { Redacted } from "effect"
import type { SessionBackgroundWorkQuery, SessionBackgroundWorkResult } from "./background-index-protocol-types.js"
import type { MutationFilesQuery, MutationFilesResult, MutationPatchWindowQuery, MutationPatchWindowResult } from "./mutation-evidence-protocol-types.js"
import type { SessionChangeSummaryQuery, SessionChangeSummaryResult, SessionChangesQuery, SessionChangesResult, SessionChangeDiffQuery, SessionChangeDiffResult, SessionChangesSetViewed, SessionChangesSetViewedResult, SessionChangesUndo, SessionChangesUndoResult } from "./session-changes-protocol-types.js"
import type { CommandOutcome, RuntimeCommandCatalogResult, RuntimeCommandInvocation } from "./command-catalog-protocol-types.js"
import type { RuntimeModelRolesResult } from "./model-role-protocol-types.js"
import type { RuntimeUiPatch, RuntimeUiSnapshot } from "./runtime-ui-protocol-types.js"
import type { RuntimeBudgetSnapshotResult } from "./budget-protocol-types.js"
import type { RuntimeAuthStatusScope, RuntimeAuthStatusSnapshotResult } from "./auth-status-protocol-types.js"
import type { RuntimeUpdateSnapshotResult } from "./update-protocol-types.js"
import type { BinaryModule, ModulePreset, RuntimeModuleSnapshotResult, WorkflowsMode } from "./module-protocol-types.js"
import type { RuntimeStatusSnapshotResult } from "./status-protocol-types.js"
import type { ProtocolModuleMutation, ProtocolModuleMutationResult, ProtocolModuleMutationType, ProtocolModuleQuery, ProtocolModuleQueryResult, ProtocolModuleQueryType } from "./modules.js"
import type { AgentInputAnswer, RuntimeQuestionSnapshotResult } from "./question-protocol-types.js"
import type { RuntimeSessionDetailQuery, RuntimeSessionDetailResult, RuntimeSessionDetailSnapshotResult } from "./session-detail-protocol-types.js"
import type { RuntimeRoleSnapshotResult } from "./role-protocol-types.js"
import type { HydratedOutputGroupChildrenBatch, HydratedOutputRange, HydratedOutputBlockBody, OutputGroupChildrenRequest, OutputRangeRequest, OutputBlockBodyRequest, OutputWindowRequest, OutputWindowSnapshot,
  TranscriptSearchRequest,
  TranscriptSearchResult,
  ProjectFilesRequest,
  ProjectFilesResult,
} from "./transcript-protocol-types.js"
import type { ChatInputLike } from "../infra/chat-input.js"
import type { SessionNotice } from "../infra/session-notice.js"
import type { MutationEvidence } from "../infra/mutation-evidence.js"
import type { ToolResultAction } from "../infra/tool-result-action.js"
import type { ToolAction } from "../infra/workflow-types.js"
import type { AgentFailureDisplay, ContainerKind, DegradedBlock, DiffOmission, MessageSender, ProvisionalDiff, PausedBy, ToolPresentation, WorkflowCard } from "../infra/output-blocks.js"
import type {
  EffortOptionRow,
  ModelAssignmentRow,
  ModelOptionRow,
  RuntimeEffortOptionsQuery,
  RuntimeModelAssignmentsQuery,
  RuntimeModelOptionsQuery,
  RuntimeResetModelAssignmentsMutation,
  RuntimeResetModelAssignmentsResult,
  RuntimeSaveModelEffortMutation,
  RuntimeSaveModelEffortResult,
  ModelSelectionEffort,
  RuntimeSessionModelPlanQuery,
  RuntimeSessionModelPlanResult,
} from "./model-assignment-protocol-types.js"
import type { RuntimeModelCatalogRefreshScope, ProviderModelView, RuntimeDeselectAllProviderModelsMutation, RuntimeProviderModelHiddenResult, RuntimeProviderModelsQuery, RuntimeRecheckProviderModelsMutation, RuntimeSetProviderAutoEnableNewModelsMutation, RuntimeSetProviderAutoEnableNewModelsResult, RuntimeSetProviderFreeRoutesMutation, RuntimeSetProviderModelMutation, RuntimeSetProviderModelResult } from "./provider-model-preference-protocol-types.js"
import type { RuntimeAuthProfileDeletionPreview, RuntimeAuthProfileMutation, RuntimeAuthProfileMutationResult } from "./auth-profile-selection-protocol-types.js"
import type { RuntimeConfigMutation, RuntimeConfigMutationResult, RuntimeConfigSnapshotResult } from "./runtime-config-protocol-types.js"
import type { RuntimeAuthLoginMutation, RuntimeAuthLoginResult } from "./auth-login-protocol-types.js"
import type { SubscriptionSpendConsentMutation, SubscriptionSpendConsentMutationResult } from "./subscription-spend-consent-protocol-types.js"
import type { RuntimeGitAiAttributionSnapshotResult } from "./git-ai-attribution-protocol-types.js"
import type { RuntimeGitSnapshotResult } from "./git-protocol-types.js"
import type { CommandUsageRecordMutation, RuntimeCommandUsageSnapshotResult } from "./command-usage-protocol-types.js"
import type { ServeStartRefusal } from "./serve-handshake.js"
import type { RuntimeRelease } from "./runtime-protocol-schemas.js"

export type Unsubscribe = () => void

/** The account-resolved assignment used for a new chat. Pending means the
 * deferred resolver has not settled; none is its canonical no-assignment
 * result. Labels and tier guesses are not part of this wire contract. */
export type RuntimeChatDefault =
  | { readonly kind: "pending" }
  | { readonly kind: "none" }
  | { readonly kind: "model"; readonly model: string; readonly effort: ModelSelectionEffort }

/** The account service refused an attach with a cause a person can read. */
export class AccountAttachFailedError extends Error {
  override readonly name = "AccountAttachFailedError"
  /** The cause the service named, when the lane reset does not remedy it. */
  constructor(message: string, readonly refusal?: ServeStartRefusal) {
    super(message)
  }
}

/** The queries the kernel answers itself. A module's snapshot queries come
 *  from the protocol registry and join them in `RuntimeQuery`. */
type RuntimeKernelQuery =
  | SessionChangeSummaryQuery
  | SessionChangesQuery
  | SessionChangeDiffQuery
  | SessionBackgroundWorkQuery
  | MutationFilesQuery
  | MutationPatchWindowQuery
  | { readonly type: "snapshot" }
  | { readonly type: "outputWindow"; readonly sessionId: string; readonly request: OutputWindowRequest }
  | { readonly type: "outputRange"; readonly sessionId: string; readonly request: OutputRangeRequest }
  | { readonly type: "outputGroupChildren"; readonly sessionId: string; readonly request: OutputGroupChildrenRequest }
  | { readonly type: "outputBlockBody"; readonly sessionId: string; readonly request: OutputBlockBodyRequest }
  | { readonly type: "transcriptSearch"; readonly request: TranscriptSearchRequest }
  | { readonly type: "projectFiles"; readonly request: ProjectFilesRequest }
  | { readonly type: "statusSnapshot"; readonly sessionIds: readonly string[] }
  | { readonly type: "budgetSnapshot"; readonly sessionIds: readonly string[] }
  | { readonly type: "questionSnapshot"; readonly sessionIds: readonly string[] }
  | { readonly type: "roleSnapshot"; readonly sessionIds: readonly string[] }
  | { readonly type: "authStatusSnapshot"; readonly scope: RuntimeAuthStatusScope }
  | { readonly type: "authProfileDeletionPreview"; readonly id: string }
  | { readonly type: "updateSnapshot" }
  | { readonly type: "moduleSnapshot" }
  | { readonly type: "configSnapshot" }
  | { readonly type: "gitAiAttributionSnapshot" }
  | { readonly type: "gitSnapshot" }
  | { readonly type: "commandUsageSnapshot" }
  | ({ readonly type: "sessionDetail" } & RuntimeSessionDetailQuery)
  | { readonly type: "sessionDetailSnapshot"; readonly sessionIds: readonly string[] }
  | { readonly type: "recallQueuedMessage"; readonly sessionId: string }
  | { readonly type: "commandCatalog" }
  | ({ readonly type: "modelAssignments" } & RuntimeModelAssignmentsQuery)
  | ({ readonly type: "sessionModelPlan" } & RuntimeSessionModelPlanQuery)
  | ({ readonly type: "modelOptions" } & RuntimeModelOptionsQuery)
  | ({ readonly type: "effortOptions" } & RuntimeEffortOptionsQuery)
  | { readonly type: "modelRoles" }
  | ({ readonly type: "provider_models.query" } & RuntimeProviderModelsQuery)

export type RuntimeQuery = RuntimeKernelQuery | ProtocolModuleQuery

/** The result a query's discriminant selects. A module query maps through
 *  the registry; every other discriminant is a kernel row. */
export type RuntimeQueryResult<Q extends RuntimeQuery> =
  Q extends { readonly type: infer Type extends ProtocolModuleQueryType } ? ProtocolModuleQueryResult<Type>
    : Q extends SessionChangeSummaryQuery ? SessionChangeSummaryResult
    : Q extends SessionChangesQuery ? SessionChangesResult
    : Q extends SessionChangeDiffQuery ? SessionChangeDiffResult
    : Q extends SessionBackgroundWorkQuery ? SessionBackgroundWorkResult
    : Q extends MutationFilesQuery ? MutationFilesResult
    : Q extends MutationPatchWindowQuery ? MutationPatchWindowResult
    : Q extends { readonly type: "snapshot" } ? RuntimeUiSnapshot
    : Q extends { readonly type: "outputWindow" } ? OutputWindowSnapshot
      : Q extends { readonly type: "outputRange" } ? HydratedOutputRange
        : Q extends { readonly type: "outputGroupChildren" } ? HydratedOutputGroupChildrenBatch
          : Q extends { readonly type: "outputBlockBody" } ? HydratedOutputBlockBody
          : Q extends { readonly type: "transcriptSearch" } ? TranscriptSearchResult
          : Q extends { readonly type: "projectFiles" } ? ProjectFilesResult
            : Q extends { readonly type: "statusSnapshot" } ? RuntimeStatusSnapshotResult
              : Q extends { readonly type: "budgetSnapshot" } ? RuntimeBudgetSnapshotResult
                  : Q extends { readonly type: "questionSnapshot" } ? RuntimeQuestionSnapshotResult
                  : Q extends { readonly type: "roleSnapshot" } ? RuntimeRoleSnapshotResult
                    : Q extends { readonly type: "authStatusSnapshot" } ? RuntimeAuthStatusSnapshotResult
                    : Q extends { readonly type: "authProfileDeletionPreview" } ? RuntimeAuthProfileDeletionPreview
                        : Q extends { readonly type: "updateSnapshot" } ? RuntimeUpdateSnapshotResult
                          : Q extends { readonly type: "moduleSnapshot" } ? RuntimeModuleSnapshotResult
                          : Q extends { readonly type: "configSnapshot" } ? RuntimeConfigSnapshotResult
                              : Q extends { readonly type: "gitAiAttributionSnapshot" } ? RuntimeGitAiAttributionSnapshotResult
                              : Q extends { readonly type: "gitSnapshot" } ? RuntimeGitSnapshotResult
                              : Q extends { readonly type: "commandUsageSnapshot" } ? RuntimeCommandUsageSnapshotResult
                              : Q extends { readonly type: "sessionDetail" } ? RuntimeSessionDetailResult
                              : Q extends { readonly type: "sessionDetailSnapshot" } ? RuntimeSessionDetailSnapshotResult
                                  : Q extends { readonly type: "recallQueuedMessage" } ? ChatInputLike | null
                                    : Q extends { readonly type: "commandCatalog" } ? RuntimeCommandCatalogResult
                                      : Q extends { readonly type: "modelAssignments" } ? readonly ModelAssignmentRow[]
                                      : Q extends { readonly type: "sessionModelPlan" } ? RuntimeSessionModelPlanResult
                                        : Q extends { readonly type: "modelOptions" } ? readonly ModelOptionRow[]
                                          : Q extends { readonly type: "effortOptions" } ? readonly EffortOptionRow[]
                                            : Q extends { readonly type: "modelRoles" } ? RuntimeModelRolesResult
                                              : Q extends { readonly type: "provider_models.query" } ? ProviderModelView
                                                          : never

export interface RuntimeClient {
  query<Q extends RuntimeQuery>(query: Q): Promise<RuntimeQueryResult<Q>>
  dispatch<C extends FrontendMutation>(command: C): Promise<MutationResult<C>>
  subscribe(listener: (event: FrontendEvent) => void): Unsubscribe
  /** Release client resources; the transport owns whether the runtime follows. */
  close(): Promise<void>
}

/** A runtime client that reaches the runtime over an event lane that can
 *  break and attach again, as every client of the published protocol does.
 *
 *  A lane is one attach: it opens when the client has written its event
 *  subscription to an open socket, and it ends when that subscription ends.
 *  The runtime serves every call written after the subscription only once
 *  the subscription is registered (ARCH-PROTOCOL-015), so a read started when a lane
 *  opens sees every change the lane does not carry. That makes the lane the
 *  one seed trigger: each receiver reads its whole view once per lane, and
 *  never at construction or on a break. */
export interface AttachedRuntimeClient extends RuntimeClient {
  /** Calls `listener` with the lane's id at once when a lane is open, and
   *  again each time a new lane opens. Ids grow; one lane calls a listener
   *  once. */
  onLane(listener: (lane: number) => void): Unsubscribe
  /** Follows the live output of `sessionId` on the open lane until the
   *  returned release or the lane's end, whichever comes first. A receiver
   *  of the output domain watches its session on each lane before it reads
   *  it, and every watch of one lane goes to the runtime as one whole-set
   *  `output.watch` set, written before any call made after the watch. */
  watchOutput(sessionId: string): Unsubscribe
}

/** One file riding with a message: an image or a text file, base64, with the
 *  marker the message shows in its place and the file's own name when it had one. */
export interface ProtocolChatAttachment {
  readonly marker: string
  readonly mediaType: string
  readonly data: string
  readonly name?: string
}

export interface ProtocolChatInputObject {
  readonly text: string
  readonly attachments?: readonly ProtocolChatAttachment[]
  /** Inline skill invocation display metadata (see infra/chat-input.ts). */
  readonly invocation?: { readonly label: string; readonly args?: string }
  /** The identities the sending client shows this input under until the
   *  runtime's transcript shows it back. */
  readonly submissionIds?: readonly string[]
}

type ProtocolChatInput = string | ProtocolChatInputObject

export type FrontendActivity = "absent" | "idle" | "awaiting_user" | "waiting" | "thinking" | "generating" | "executing_tools"

/** True while the agent is doing work: streaming phases only, never parked or absent. */
export function isActiveActivity(activity: FrontendActivity | undefined): boolean {
  return activity === "waiting" || activity === "thinking" || activity === "generating" || activity === "executing_tools"
}
/** Whether a session's turn is at rest, so its runner can end without
 *  cutting work: no turn runs and none waits on background work. A turn
 *  parked on a question is at rest, because a stop keeps the question for
 *  the next runner (PI-INTERACTION-009). */
export function isTurnAtRest(status: { readonly activity: FrontendActivity; readonly waitingOnBackgroundWork: boolean }): boolean {
  return !isActiveActivity(status.activity) && !status.waitingOnBackgroundWork
}
export type FrontendConnectionState = "connected" | "retrying" | "connecting" | "reconnecting" | "down"
type FrontendSessionLifecycleState = "active" | "inactive"

export type FrontendToolStreamingText =
  | { readonly content: string; readonly filetype?: string; readonly proposedDiff?: never; readonly previewCheck?: never }
  | { readonly proposedDiff: ProvisionalDiff; readonly content?: never; readonly filetype?: never; readonly previewCheck?: never }
  | { readonly previewCheck: string; readonly content?: never; readonly filetype?: never; readonly proposedDiff?: never }

export type FrontendToolEntry =
  | FrontendToolEntryBase & { readonly status: "pending" | "streaming" | "completed" | "interrupted" }
  | FrontendToolEntryBase & { readonly status: "error"; readonly errorMessage: string }
  | FrontendToolEntryBase & { readonly status: "blocked"; readonly statusMessage: string }

interface FrontendToolEntryBase {
  readonly kind: "tool"
  readonly id: string
  /** Raw machine tool identifier. Display capability and bash settlement key
   *  off this; everything a user reads comes from `presentation`. */
  readonly name: string
  readonly presentation: ToolPresentation
  /** What the tool does, as the runtime read it from the tool's display
   *  contract. Absent from a runtime older than this client, whose rows then
   *  fold into no run. */
  readonly action?: ToolAction
  readonly timestamp: number
  /** Display-only run category assigned once from the invocation's parent relationship. */
  readonly runCategoryOverride?: "execute"
  readonly invocationBody?: { readonly content: string; readonly filetype: string; readonly presentation?: "disclosure" }
  readonly linkUri?: string
  readonly diff?: string
  readonly content?: string
  readonly filetype?: string
  readonly exitCode?: number
  readonly background?: boolean
  /** When work that outlived the call ended, such as a background command
   *  that ran on after its launch returned. Absent while that work runs and
   *  when no end was recorded. */
  readonly endedAt?: number
  readonly resultAction?: ToolResultAction
  readonly fileChangeKind?: "create" | "replace" | "patch"
  /** The call's input declared that it edits project files: it presents as a
   *  file edit while it streams and runs, before any change has landed. */
  readonly declaresMutation?: true
  readonly proposedDiff?: ProvisionalDiff
  readonly mutationEvidence?: MutationEvidence
  /** Derived-history wire truncation metadata. The full body is fetched lazily
   *  via `outputBlockBody`. Absent when nothing was omitted. */
  readonly diffOmission?: DiffOmission
  readonly invocationBodyOmittedBytes?: number
  readonly contentOmittedLines?: number
}

interface FrontendQuestionAnswers {
  readonly [question: string]: string
}
type FrontendQuestionChoice =
  | { readonly kind: "option"; readonly choiceId?: string; readonly label: string; readonly description?: string; readonly recommended?: boolean; readonly requiresText?: boolean }
  | { readonly kind: "freeform"; readonly label: string; readonly placeholder?: string }

interface FrontendQuestionEntry {
  readonly question: string
  readonly header?: string
  readonly choices: FrontendQuestionChoice[]
  readonly multiSelect: boolean
}

interface FrontendQuestionBlock {
  readonly kind: "question"
  readonly toolUseId: string
  readonly questions: FrontendQuestionEntry[]
  readonly answers?: FrontendQuestionAnswers
  readonly cancelled?: boolean
  readonly timestamp: number
}

interface FrontendContainerBase {
  readonly kind: "agentGroup"
  readonly id: string
  readonly label: string
  readonly description: string
  readonly activity?: ToolPresentation
  readonly summary?: string
  readonly children: FrontendToolEntry[]
  readonly totalToolCount: number
  readonly latestChild?: string
  readonly duration?: number
  readonly activeStartedAt?: number
  readonly timestamp: number
  readonly toolUseId: string
}

type FrontendContainerStatus =
  | { readonly status: "pending" | "queued" | "active" | "completed" | "partial" | "cancelled" | "stopped" | "interrupted" }
  | { readonly status: "paused"; readonly pausedBy: PausedBy }
  | { readonly status: "error"; readonly failure: AgentFailureDisplay }

type FrontendContainerBlock = FrontendContainerBase & FrontendContainerStatus & { readonly containerKind: ContainerKind; readonly agentType?: string; readonly totalTokens?: number; readonly model?: string; readonly linkUri?: string; readonly card?: WorkflowCard }

export type FrontendOutputBlock =
  | DegradedBlock
  | { readonly kind: "text"; readonly id: string; readonly content: string; readonly timestamp: number }
  | FrontendToolEntry
  | FrontendContainerBlock
  | {
    readonly kind: "system"
    readonly id: string
    readonly message: string
    readonly level?: "info" | "error"
    readonly mutationEvidence?: MutationEvidence
    /** Mutation lines the wire edge omitted from this notice. */
    readonly diffOmission?: DiffOmission
    readonly timestamp: number
  }
  | { readonly kind: "thinking"; readonly id: string; readonly content: string; readonly status: "streaming" | "completed"; readonly timestamp: number; readonly completedAt?: number }
  | { readonly kind: "divider"; readonly id: string; readonly label: string; readonly timestamp: number }
  | { readonly kind: "userMessage"; readonly id: string; readonly content: string; readonly timestamp: number; readonly pending: boolean; readonly injected: boolean; readonly submissionIds?: readonly string[]; readonly imageCount?: number; readonly from?: FrontendMessageSender }
  | FrontendQuestionBlock

/** The session that sent a message row: its name and relation to the
 *  recipient when it sent, and the words of the person it attached. */
export type FrontendMessageSender = MessageSender

export interface SessionCatalogError {
  readonly sessionId: string
  readonly scope: "metadata" | "budget" | "duration" | "diffStats" | "fork" | "output"
  readonly reason: string
}


interface FrontendAgentInputAnswers {
  readonly [question: string]: AgentInputAnswer
}
export const SHORT_TITLE_MAX_CHARS = 14

/** Preserve an explicit compact title; absent and legacy empty titles use the original title's first 14 characters. */
export function effectiveSessionShortTitle(title: string, shortTitle?: string): string {
  return shortTitle || title.slice(0, SHORT_TITLE_MAX_CHARS)
}

/** Omitted fields keep their current value. User descriptions have no length cap. */
export interface SessionTitlePatch {
  readonly title?: string
  readonly shortTitle?: string
}

export type FrontendMutation =
  | { type: "session.claim_composer_returns"; sessionId: string; submissionIds: readonly string[] }
  | SessionChangesUndo
  | SessionChangesSetViewed
  /** Opens a chat. A client that names the chat's `sessionId` can send the
   *  open again when its answer was lost: the runtime opens that chat once,
   *  and answers a later copy with the chat that exists. Only an open with
   *  no `initialMessage` names its chat. */
  | { type: "chat.open"; initialMessage?: ProtocolChatInput; sessionId?: string }
  /** A person's message to any session: a chat starts or joins a turn, and
   *  a subagent or a workflow takes it as its next input. A message to an
   *  interrupted session starts its work again (PI-INTERACTION-050).
   *  `targets` names items or agents of a workflow, as an agent view's
   *  composer addresses them; without it a message reaches the whole
   *  session. */
  | { type: "session.send"; sessionId: string; input: ProtocolChatInput; targets?: readonly string[] }
  | { type: "chat.compact"; sessionId: string }
  | { type: "background.terminate"; sessionId: string; toolUseId: string }
  /** Cuts the running turn and any running tool call, keeps what it
   *  committed, and records the turn end as interrupted by a person;
   *  `chat.resume` continues it (PI-INTERACTION-043, PI-INTERACTION-103). */
  | { type: "chat.interrupt"; sessionId: string }
  /** Continues an interrupted or unexpectedly exited turn from its committed
   *  context with no new message. */
  | { type: "chat.resume"; sessionId: string }
  | { type: "bash.detach"; sessionId: string; toolUseId: string }
  /** Continues the named message targets; missing or empty targets continue the whole workflow. */
  /** Runs a workflow whose saved progress is damaged again from its
   *  recorded request, while its row admits it (PI-INTERACTION-044, ARCH-WORKFLOWS-034). */
  /** Shows the session: the sender holds it, and an open session holds its
   *  runner (ARCH-SESSIONS-038). Holding again is a no-op. */
  | { type: "session.activate"; sessionId: string }
  /** Stops showing the session: the sender lets go of the hold its
   *  activation took. When no sender holds the session, the runtime ends its
   *  runner once its turn is at rest. It never closes, renames, or removes
   *  the session; `session.close` is the person's close. */
  | { type: "session.release"; sessionId: string }
  /** Lets go of the detail the sender read through `sessionDetailSnapshot`,
   *  so the runtime stops reading it for the sender. It never lets go of an
   *  activation: a tab the sender shows keeps its runner. */
  | { type: "session_detail.release"; sessionId: string }
  /** Stops following the background index of the session, which the
   *  sender's `sessionBackgroundWork` read follows (ARCH-PROTOCOL-069). When
   *  no sender follows the session any more, the runtime lets its index go. */
  | { type: "background.release"; sessionId: string }
  /** Names the whole set of sessions whose live output the sender's
   *  transcripts follow, replacing the set it named before. The runtime
   *  sends `output.delta` patches to a connection only for the sessions in
   *  its own set; output invalidations reach every connection. A connection
   *  starts each lane with no set, and its set ends with the lane. Only the
   *  account service's protocol boundary serves it. */
  | { type: "output.watch"; sessionIds: readonly string[] }
  | { type: "session.fork"; sessionId: string }
  /** Closes the chat: it ends the chat's work now, then removes an empty
   *  chat and keeps any other chat inactive. With `atRest`, the close of the
   *  chat's tab, it ends no work: the chat closes when its turn comes to
   *  rest, and an activation before then cancels the close (PI-INTERACTION-082). */
  | { type: "session.close"; sessionId: string; atRest?: true }
  /** An optional epoch-millisecond cutoff requires the owned tree to prove inactivity. */
  | { type: "session.delete"; sessionId: string; inactiveBefore?: number }
  | { type: "session.discard_transient"; sessionId: string }
  | { type: "session.reorder"; sessionId: string; beforeSessionId: string | null }
  | { type: "session.dismiss_notice"; sessionId: string; scope: string }
  | ({ type: "session.rename"; sessionId: string } & SessionTitlePatch)
  | { type: "question.answer"; sessionId: string; toolUseId: string; answers: FrontendAgentInputAnswers }
  | { type: "question.cancel"; sessionId: string; toolUseId: string }
  | { type: "auth.refresh"; profileId: string; operationId: string }
  /** Acknowledges catalog-only scheduling, not network completion. Results
   * publish through the existing scoped auth cursor and eligibility revision. */
  | { type: "auth.catalog.refresh"; scope: RuntimeModelCatalogRefreshScope }
  | RuntimeAuthLoginMutation
  /** Answers the `prompt` step of the exact login operation that asked it.
   *  The result is the flow's next step, as `auth.login` reports it. */
  | { type: "auth.login.answer"; providerId: string; operationId: string; answer: string }
  /** Supplies a short-lived browser OAuth code or callback URL to the exact
   *  runtime-owned login operation that created it. */
  | { type: "auth.login.complete"; operationId: string; input: Redacted.Redacted<string> }
  /** A scoped close cancels only its own operation, including preflight before a URL exists. */
  | { type: "auth.login.cancel"; loginQuestionId?: string; operationId?: string }
  /** Answers one provider-owned account episode. No paths or profile authority come from the client. */
  | { type: "auth.login.decline"; providerId: string; loginQuestionId: string }
  /** Removes a stored credential of the profile `profileId` names, or of the
   *  runtime's active profile: one account when `instanceId` names it, the
   *  provider's only credential otherwise. Completion publishes on `auth`. */
  | { type: "auth.account.disconnect"; providerId: string; instanceId?: string; profileId?: string }
  /** Sets or clears the label a person gave an account of the profile
   *  `profileId` names, or of the runtime's active profile. */
  | { type: "auth.account.rename"; providerId: string; instanceId: string; label?: string; profileId?: string }
  | RuntimeAuthProfileMutation
  | RuntimeConfigMutation
  | { type: "settings.set_module"; moduleId: BinaryModule; expected: boolean; enabled: boolean }
  | { type: "settings.set_modules"; preset: ModulePreset; expected: { readonly moduleIds: readonly BinaryModule[]; readonly requireWorkflowConfirmation: boolean; readonly descriptorIdentity: string } }
  | { type: "settings.set_workflow_mode"; expected: WorkflowsMode; mode: WorkflowsMode }
  | { type: "settings.set_persistent_processes"; expected: boolean; enabled: boolean }
  | { type: "settings.set_update_auto_install"; expected: boolean; value: boolean }
  | RuntimeCommandInvocation
  | CommandUsageRecordMutation
  | ({ type: "model.save_effort" } & RuntimeSaveModelEffortMutation)
  | ({ type: "model.reset_assignments" } & RuntimeResetModelAssignmentsMutation)
  | ({ type: "provider_model.set" } & RuntimeSetProviderModelMutation)
  | ({ type: "provider_models.deselect_all" } & RuntimeDeselectAllProviderModelsMutation)
  | ({ type: "provider_models.recheck" } & RuntimeRecheckProviderModelsMutation)
  | ({ type: "provider_models.set_auto_enable" } & RuntimeSetProviderAutoEnableNewModelsMutation)
  | ({ type: "provider_free_routes.set" } & RuntimeSetProviderFreeRoutesMutation)
  | { type: "background.warm" }
  | SubscriptionSpendConsentMutation
  | ProtocolModuleMutation

type BasicMutationResult =
  | {
    ok: true
    sessionId?: string
    sessionCatalogRow?: SessionCatalogRow
    sessionRemoved?: boolean
    /** Submission identities the runtime holds already: the agent views of a
     *  workflow show them, or the session recorded them before, and a copy
     *  that a client sent again recorded nothing (ARCH-SESSIONS-030). A client retires
     *  its copies at once, unless `inTranscript` says otherwise. */
    confirmedSubmissionIds?: readonly string[]
    /** A session transcript shows the confirmed messages or their returned
     *  notices, now or when its reader takes them, so that transcript retires the
     *  client's copies. A workflow has no transcript and never sets it. */
    inTranscript?: boolean
  }
  | MutationFailure

/** `handing_off` refuses a send because its recipient has started its handoff.
 * The sending composer keeps the input and shows the runtime's warning instead
 * of a failed-delivery entry. */
type MutationFailure = { ok: false; error: string; kind?: "stale" | "handing_off" }

export type MutationResult<C extends FrontendMutation | void = void> =
  C extends void ? BasicMutationResult
    : C extends { readonly type: "session.claim_composer_returns" } ? import("./composer-returns.js").ClaimComposerReturnsResult
    : C extends { readonly type: infer Type extends ProtocolModuleMutationType } ? ProtocolModuleMutationResult<Type>
    : C extends SessionChangesUndo ? SessionChangesUndoResult
    : C extends SessionChangesSetViewed ? SessionChangesSetViewedResult
    : C extends { type: "auth.login" | "auth.login.answer" } ? RuntimeAuthLoginResult
    : C extends RuntimeCommandInvocation ? CommandOutcome
      : C extends WorkflowOperation ? WorkflowOperationResult
      : C extends RuntimeAuthProfileMutation ? RuntimeAuthProfileMutationResult
      : C extends RuntimeConfigMutation ? RuntimeConfigMutationResult
          : C extends { type: "model.save_effort" } ? RuntimeSaveModelEffortResult
          : C extends { type: "model.reset_assignments" } ? RuntimeResetModelAssignmentsResult
            : C extends { type: "provider_model.set" } ? RuntimeSetProviderModelResult
              : C extends { type: "provider_models.deselect_all" } ? ProviderModelView | RuntimeProviderModelHiddenResult
              : C extends { type: "provider_models.recheck" } ? ProviderModelView | RuntimeProviderModelHiddenResult
                : C extends { type: "provider_models.set_auto_enable" } ? RuntimeSetProviderAutoEnableNewModelsResult
                : C extends { type: "provider_free_routes.set" } ? ProviderModelView | RuntimeProviderModelHiddenResult
              : C extends { type: "background.warm" } ? void
                        : C extends SubscriptionSpendConsentMutation ? SubscriptionSpendConsentMutationResult
                        : BasicMutationResult

/** Workflow control whose outcome reports whether work was interrupted. */
export type WorkflowOperation = Extract<ProtocolModuleMutation, { readonly type: "workflow.interrupt" }>

export type WorkflowOperationResult =
  /** `reason` says, in the runtime's words, why an interrupt that was asked
   *  for could not be done; an interrupt with nothing to cut has none. */
  | { kind: "interrupt"; interrupted: boolean; reason?: string }

export interface SessionCatalogSnapshot {
  readonly rows: readonly SessionCatalogRow[]
  readonly activeRuntimeCount: number
  readonly errors: readonly SessionCatalogError[]
}

export type SessionRuntimeView =
  | { kind: "detached" }
  | { kind: "starting" }
  | { kind: "idle" }
  | { kind: "streaming"; startedAt: number }
  | { kind: "awaiting_user" }
  | { kind: "stopping" }
  | { kind: "failed"; message: string }

/** Who ended a child's run with Stop: a person from a control, or the agent
 *  that requested the run. */
export type StoppedBy = "person" | "agent"
/** The status of one subagent run, as its run ledger records it. */
export type ChildRunStatus = "created" | "completed" | "partial" | "failed" | "cancelled" | "stopped" | "interrupted" | "paused"
/** What a child's row admits: a message while it runs or waits to resume,
 *  Interrupt and Stop (`background.terminate` on its parent's tool call)
 *  while it runs, and explicit Resume for a non-completed child that is not running. */
export type SubagentSessionAction = "session.send" | "subagent.interrupt" | "subagent.resume" | "background.terminate" | "session.delete"
/** What a chat's row admits: Interrupt while a turn runs, Resume while the
 *  conversation's last turn ended by an interrupt or an unexpected exit. A
 *  chat always takes a message, so no row names it, and a chat has
 *  no terminal stop. */
export type ChatSessionAction = "chat.interrupt" | "chat.resume" | "session.delete"
/** What a workflow's row admits: a message while it has not ended,
 *  Interrupt while an agent runs, Resume while an
 *  agent is interrupted or the workflow is paused or unfinished, and Stop
 *  (`background.terminate` on its parent's tool call) while it runs. Every
 *  workflow answers a tool call of its parent chat. */
export type WorkflowSessionAction = "session.send" | "workflow.interrupt" | "workflow.resume" | "workflow.restart" | "background.terminate" | "session.delete"
interface SessionRowBase {
  readonly id: string
  readonly title: string
  readonly shortTitle?: string
  readonly lifecycleState: FrontendSessionLifecycleState
  readonly notices: readonly SessionNotice[]
  readonly lastUpdated: string
  readonly createdAt?: string
  /** Canonical directory this session executes in (ARCH-DIRECTORIES-006, ARCH-DIRECTORIES-007), resolved at use time. */
  readonly executionCwd: string
  readonly parentSessionId?: string
  /** The parent's tool call this session answers, for a child workflow or
   *  subagent. Stop terminates it with `background.terminate`. */
  readonly parentToolUseId?: string
  /** Who ended this child's run for its parent with Stop: a person, or the
   *  requesting agent. A stopped subagent can explicitly resume in a new attempt. */
  readonly stoppedBy?: StoppedBy
  readonly childSessionIds?: readonly string[]
  readonly degraded?: true
  readonly unavailableFields?: readonly string[]
  /** Cold sessions have no resident runner. This does not change lifecycle. */
  readonly activity?: FrontendActivity
}
/** A session a person or a headless command opened: the only row the
 *  catalog lists and the `session` domain patches. */
interface SessionCatalogRowBase extends SessionRowBase {
  /** The actions the runtime admits: Interrupt while a turn runs, and Resume
   *  while an interrupted turn waits to continue. A chat has no Stop. A
   *  chat's Resume needs its conversation's turn-end evidence, which only a
   *  detail read carries, so a listing row admits no Resume until its detail
   *  is read. */
  readonly admittedActions?: readonly ChatSessionAction[]
}
/** A child a session launched. It is never a catalog row: a client reaches it
 *  from its card in the parent transcript and reads it through `sessionDetail`
 *  and the per-session domains (ARCH-PROTOCOL-048). */
interface ChildSessionRowBase extends SessionRowBase {
  readonly kind: "subagent"
  /** The current run's terminal outcome; absent while it can still run. */
  readonly runOutcome?: Exclude<ChildRunStatus, "created" | "interrupted" | "paused">
  readonly inputMode: { readonly kind: "message" }
  /** Actions admitted by the current child runtime. */
  readonly admittedActions: readonly SubagentSessionAction[]
}

type SessionCatalogTotals =
  | {
    readonly totalsLoading: true
    readonly totalCost?: never
    readonly totalBilledCost?: never
    readonly priceUnavailable?: never
    readonly totalTokens?: never
    readonly contextPercent?: never
    readonly contextPromptTokens?: never
    readonly durationMs?: never
    readonly diffStats?: never
  }
  | {
    readonly totalsLoading: false
    readonly totalCost: number
    readonly totalBilledCost: number
    readonly priceUnavailable: boolean
    readonly totalTokens: number
    readonly contextPercent: number
    readonly contextPromptTokens: number
    readonly durationMs: number
    readonly diffStats?: SessionDiffStats
  }

export type SessionCatalogRow = SessionCatalogRowBase & SessionCatalogTotals & {
  readonly kind: "chat"
  readonly inputMode: { readonly kind: "chat" }
}
/** One part of a workflow's definition that no longer matches the run that
 *  started: its graph of phases (`graph`, or `workflow` for a run that
 *  recorded its whole definition), one agent record (`agent`), the workflow
 *  engine (`version`), or a skill or persona that the run composes. `id` names
 *  the agent record, skill, or persona; on a `graph` change it names one phase
 *  whose own entries changed, as the path of phase ids joined with "/". An
 *  agent change says which `aspect` changed: the `policy` the workflow
 *  imposes, the `content` (instructions and contract text), or the `output`
 *  shape. An agent change with no `id` is an output contract that several
 *  agents shared. */
export interface WorkflowDefinitionChange {
  readonly component: "workflow" | "graph" | "agent" | "version" | "skill" | "persona"
  readonly id?: string
  readonly aspect?: "policy" | "content" | "output"
}
/** Why a workflow cannot continue: its last Resume found that the definition
 *  changed after the workflow started, and its control has not moved since
 *  (ARCH-WORKFLOWS-014, PI-AGENT-015). */
export interface WorkflowDefinitionDrift {
  readonly workflowDefinitionId: string
  readonly changes: readonly WorkflowDefinitionChange[]
}
interface WorkflowAgentSessionRowBase extends SessionRowBase {
  readonly kind: "workflow-agent"
  readonly inputMode: { readonly kind: "message" }
  readonly workflowMembership: import("../infra/session-workflow-membership.js").WorkflowMembership
  readonly admittedActions: readonly ("session.send" | "chat.interrupt" | "chat.resume" | "session.delete")[]
}
export type ChildSessionRow = (ChildSessionRowBase | WorkflowAgentSessionRowBase) & SessionCatalogTotals
/** Any session's row: listed in the catalog, or a child served by detail. */
export type SessionRow = SessionCatalogRow | ChildSessionRow
export type SessionInputMode = SessionRow["inputMode"]

/** Aggregate line counts of the session's recorded file mutations. Folded
 *  from the durable file-mutation facts; the fold assigns the fact-side
 *  counts to this declared shape, so the two cannot drift silently. */
export interface SessionDiffStats {
  added: number
  modified: number
  removed: number
}


/** One blocking startup step the runtime is inside right now, as a reader
 *  decodes it from a frame that another build can send. Anything that blocks
 *  the load path must show the user a notice and progress. Producers hand
 *  each other the step id (`StartupReached`), and `startupPhase` gives it
 *  this label and count once, where the step leaves the build. `progress` is
 *  optional on the wire because an earlier build's phase can carry none. */
export interface RuntimeStartupPhase {
  readonly label: string
  readonly progress?: { readonly step: number; readonly total: number }
}

/** Where runtime startup stands: inside a named blocking phase, or failed.
 *  A failure is terminal only for that attempt - the client re-runs
 *  find-or-start before its next dial - so a later lane supersedes it. */
export type RuntimeStartupStatus =
  | ({ readonly kind: "phase" } & RuntimeStartupPhase)
  | { readonly kind: "failed"; readonly error: string }

/** The runtime refused this client at its event attach because the client
 *  speaks another protocol version. It names the release the runtime runs
 *  and the protocol version that release speaks, so the client can tell
 *  whether it or the runtime is the older one. */
export type RuntimeProtocolRefusal = { readonly kind: "protocol-mismatch" } & RuntimeRelease

/** Whether the runtime answers this client, as its connection alone can
 *  tell. Recovery from a dropped connection is nothing anyone sees: the
 *  client reattaches on its own and reseeds, and reads healthy while it does.
 *  It reads faulted once recovery has failed for the fault window, or at once
 *  when the attach failed with a cause the runtime itself reported, which no
 *  retry heals within seconds. `since` is when the runtime last answered;
 *  `cause` is the runtime's own words when it has any, and `refusal` is the
 *  cause the service named for a start that the lane reset alone does not
 *  remedy, or the runtime's refusal of this client's protocol version, so
 *  the notice names the remedy that works. A fault clears the moment the
 *  runtime answers. */
export type RuntimeTransportHealth =
  | { readonly kind: "healthy" }
  | { readonly kind: "faulted"; readonly since: number; readonly cause?: string; readonly refusal?: ServeStartRefusal | RuntimeProtocolRefusal }

/** What a person should know about the process that runs a project's
 *  sessions, as the runtime reports it on the `executor` workspace domain.
 *  - `serving`: nothing to report.
 *  - `restarting`: the process stopped soon after it started more than once
 *    in a row, and a restart is scheduled that no restarted process has yet
 *    ended by reporting ready. `since` is when the first of those early
 *    stops happened; `cause` says in plain words how the last one ended,
 *    such as "stopped by signal SIGKILL".
 *  - `recovery_failed`: the process stopped and the runtime could not restore
 *    its sessions; `cause` says why in plain words, and is absent when the
 *    runtime knows no specific cause. The next message tries again, and this
 *    report ends when a recovery succeeds.
 *  Faults carry the outcome of their automatic report in `report`, which is
 *  absent while the report is sending. */
export type RuntimeExecutorState =
  | { readonly kind: "serving" }
  | { readonly kind: "restarting"; readonly since: number; readonly cause: string; readonly report?: RuntimeFaultReportOutcome }
  | { readonly kind: "recovery_failed"; readonly cause?: string; readonly report?: RuntimeFaultReportOutcome }

/** The outcome of the automatic report of a runtime fault.
 *  - `sent`: the report service accepted it as `reportId`.
 *  - `failed`: the send failed; the report text stays available for Copy.
 *  - `not-release`: the build is not an official release, so it carries no
 *    report endpoint and nothing was sent; the report text stays available
 *    for Copy. */
export type RuntimeFaultReportOutcome =
  | { readonly kind: "sent"; readonly reportId: string }
  | { readonly kind: "failed" }
  | { readonly kind: "not-release" }

/** What a person should know about the account service that serves the
 *  project, as that service reports it on the `service` workspace domain.
 *  - `serving`: nothing to report.
 *  - `crash_loop`: starts of the service stopped within their first minute
 *    after they listened more than once in a row, and the start that answers
 *    has not yet served its own first minute. `cause` is the latest stop's
 *    own words. The report ends when that start has served its minute. */
export type RuntimeServiceState =
  | { readonly kind: "serving" }
  | { readonly kind: "crash_loop"; readonly cause: string; readonly report?: RuntimeFaultReportOutcome }

/** The one runtime condition every surface renders: the connection's own
 *  health, or, while the runtime answers, what it reports about the account
 *  service that answers and about the process that runs the project's
 *  sessions. A connection fault outranks both reports, because a runtime that
 *  does not answer says nothing current. Sessions that could not be restored
 *  come next, because that fault asks the person to act. The service's crash
 *  loop outranks a project process that restarts, because the service serves
 *  the executor's project. */
export type RuntimeHealth =
  | RuntimeTransportHealth
  | Exclude<RuntimeServiceState, { readonly kind: "serving" }>
  | Exclude<RuntimeExecutorState, { readonly kind: "serving" }>

/** The change events the RPC event lane carries. A subset of `FrontendEvent`:
 *  `runtime.startup` and `runtime.health` never cross the wire because they
 *  exist precisely when the RPC server does not answer. */
type RuntimeWireEvent = { type: "patch"; patch: RuntimeUiPatch }

/** The subscription stream. Every `patch` event wraps one ordered
 *  `RuntimeUiPatch` - the canonical surface a client classifies through the
 *  sequencer. There is no coarse whole-snapshot event: a receiver reads its
 *  view when a lane opens (`AttachedRuntimeClient.onLane`).
 *  `runtime.startup` is transport-local: the client that started the runtime
 *  synthesizes it from the stdout handshake records that runtime writes while
 *  its RPC server is not yet serving, so subscribers can render blocking
 *  startup work and startup failure. */
export type FrontendEvent =
  | RuntimeWireEvent
  | { type: "runtime.startup"; status: RuntimeStartupStatus }
  | { type: "runtime.health"; health: RuntimeTransportHealth }

/** One frame on the runtime event lane: a change event, the runtime's first
 *  frame on each subscription (`runtime.connected`, which says that the
 *  subscription is registered and the runtime answers), or the periodic
 *  heartbeat the server emits so the client silence watchdog can distinguish
 *  an idle lane from a dead one. The connection consumes the first frame and
 *  the heartbeats; listeners only ever see FrontendEvent. */
export type RuntimeEventFrame = RuntimeWireEvent | { type: "runtime.connected" } | { type: "runtime.heartbeat" }
