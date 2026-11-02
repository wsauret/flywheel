import { readAppVersion } from "../../infra/app-version.js"
import { ownBuildId } from "../../infra/update/live-builds.js"
import { readCapturedFacts, type AsyncEventStateReadSurface, type AsyncEventWriter } from "../../infra/event-store-types.js"
import { errorMessage as extractErrorMessage } from "../../infra/error-message.js"
import type { ProjectDirectories } from "../../infra/directory-authorities.js"
import { chatInputText, type ChatInputLike } from "../../infra/chat-input.js"
import { readWorkflowAgentTurnEnds, workflowInteractionRefusal, workflowStopRefusal } from "../session/chat-session-run-evidence.js"
import { parentMayContinue, personCutRefusal, workflowStepCut, type ChildCut } from "../session/child-continuation.js"
import type { ChildControlAnswer } from "../module-seams.js"
import { WHOLE_WORKFLOW, type WorkflowDeliveryAddress } from "../session/conversation/addressed-workflow-messages.js"
import { Log } from "../../infra/log.js"
import type { ProjectDefinitionRegistry } from "../../workflows/definition-registry.js"
import type { AdmittedWorkflowDeps, WorkflowDeps } from "./deps.js"
import type { SessionManager } from "../session/manager.js"
import { recordBackgroundFailure } from "../../infra/operation-log.js"
import type { SessionLifecycleState } from "../session/types.js"
import type { SessionAuthAdmission } from "../session/session-auth-profile.js"
import { recoverSessionHistory, type FirstPartyModuleComposition } from "../modules.js"
import { reconcileWorkflowAgentInput } from "./agent-input-recovery.js"
import { resumedWorkflowConversations } from "../../workflows/view/live-conversations.js"
import type { WorkflowHosts } from "./host-collection.js"
import type { SessionStore } from "../session-store/types.js"
import { prepareWorkflowAgents } from "./publish.js"
import { bindWorkflowDepsToSession } from "./deps.js"
import { executionCwdFromSession } from "../session/session-execution-directory.js"
import { workflowRunOwner, workflowRunReader } from "../module-catalog.js"
import { buildWorkflowDefinitionLineageFacts } from "./definition-lineage.js"
import { WorkflowPreflightError, type WorkflowResult, type WorkflowWake } from "./runner-types.js"
import { claimAnsweredDecision, inspectAnsweredDecision } from "../session/agent-input-decision.js"
import { createSessionFactWriter } from "../session/session-fact-writer.js"
import { resolveWorkflowDeliveryAddress, type WorkflowTargets } from "./workflow-addressing.js"
import { deliverWorkflowInput } from "../session/session-input-delivery.js"
import { personMessageKey } from "../session/conversation/queued-user-inputs.js"
import { recordPersonMessageReceipt, workflowPersonMessage } from "../session/conversation/person-message-ledger.js"
import type { ChildSessionReconciliation } from "../session/child-session-reconciliation.js"
import type { CapabilityGrant, ModulePolicy } from "../config/module-policy.js"
import type { WorkflowsMode } from "../../protocol/module-protocol-types.js"
import type { RecallInput, RecallResult } from "../../protocol/conversation-recall.js"
import type { DefinitionAvailabilityOwner } from "../app-service/definition-availability.js"
import {
  approvalRefusal,
  workflowLaunchMismatch,
  workflowLaunchRefusal,
  type ModelWorkflowLaunchRequest,
  type WorkflowApprovalBinding,
  type WorkflowLaunchRefusal,
} from "./launch-origin.js"
import { admitWorkflowOperation, workflowCapabilityAccess, type WorkflowAdmission } from "./workflow-admission.js"
import { runDefinition } from "./definition-source.js"
import type { WorkflowLaunchApprovalSource } from "../session/agent-input-facts.js"
import { assessWorkflowRecovery, commitWorkflowRecovery } from "./recovery-commit.js"
import { describeWorkflowRecoveryDegradation } from "../../workflows/vm/recovery.js"
import { replayWorkflowControl, resumesFailedAgents } from "../../workflows/vm/fact-fold.js"
import { workflowAggregateId } from "../../workflows/vm/session-facts.js"
import { createWorkflowLaunchLifecycle } from "./launch-lifecycle.js"
import type { WorkflowLaunchHost } from "./launch-operation-contract.js"
import { createWorkflowLaunchPipeline, type AdmitWorkflowOperation, type StartWorkflowResult } from "./launch-pipeline.js"
import type { ChatRunner } from "../chat/runner-types.js"

const log = Log.create({ service: "workflow-controller" })

export interface WorkflowControllerDeps extends ProjectDirectories {
  executionCwd?: string
  workflowHosts: WorkflowHosts
  sessionStore: SessionStore
  /** Attaches a launched child's parent chat without starting a turn. */
  openChatRunner?: (sessionId: string) => Promise<ChatRunner | undefined>
  manager: SessionManager
  /** Definition owner of the project this controller launches workflows in. */
  definitions: ProjectDefinitionRegistry
  /** Admission boundary of every new launch and resume. Read under the config
   *  ownership lock, so a launch is ordered against every settings write. */
  capabilities: Pick<ModulePolicy, "admit" | "state">
  /** The modules an admitted launch or resume composes in this host. The host
   *  composes its own runtime with this same rule, so every worker of a
   *  workflow composes exactly the modules its host composes. */
  composeModules: (grant: CapabilityGrant) => FirstPartyModuleComposition
  /** Availability owner each admitted launch captures its definition view from. */
  availability: Pick<DefinitionAvailabilityOwner, "capture">
  /** Live Workflows mode. ASK mediates model-originated launches only. */
  workflowMode: () => WorkflowsMode
  /** Sole profile-bound runtime authority shared with chat and subagents. */
  authAdmission: SessionAuthAdmission<WorkflowDeps>
  buildDefinitionLineageFacts?: typeof buildWorkflowDefinitionLineageFacts
  onRunnerDone?: (id: string, lifecycleState: SessionLifecycleState, result: WorkflowResult) => void
  onRunnerError?: (id: string, errorMessage: string) => void | Promise<void>
  eventReader: AsyncEventStateReadSurface
  projectionReader: AsyncEventStateReadSurface
  eventWriter: AsyncEventWriter
  recall: (conversationId: string, input: RecallInput) => Promise<RecallResult>
  /** Admits a child workflow's completion delivery through its parent chat's actor. */
  reconcileChildSessionCompletions?: (parentSessionId: string) => Promise<ChildSessionReconciliation>
}

type ResumeWorkflowResult =
  /** `continued` answers a capacity wake of a live workflow: the waiting
   *  conversations it named that continue now. A capacity wake that starts
   *  the run continues every conversation it names. */
  | { kind: "resumed"; sessionId: string; continued?: ReadonlySet<string> }
  | { kind: "already_running"; sessionId: string }
  | { kind: "not_found"; message: string }
  | { kind: "unavailable"; message: string }
  | { kind: "definition_drift"; message: string }
  | { kind: "pre_cutover"; message: string }
  | { kind: "malformed_state"; message: string }
  /** Durable state that cannot execute, but that a person's Restart can run again from its recorded request. */
  | { kind: "recovery_required"; message: string }
  | { kind: "drift_evidence_persistence"; message: string }
  | { kind: "config"; message: string }
  | { kind: "runtime_start"; message: string }
  | { kind: "stopped"; message: string }
  | { kind: "terminal"; message: string }

type SendWorkflowResult =
  | { kind: "delivered"; sessionId: string; confirmedSubmissionIds?: readonly string[] }
  | { kind: "retained"; sessionId: string; confirmedSubmissionIds?: readonly string[] }
  | { kind: "resume_failed"; sessionId: string; message: string }
  | { kind: "not_delivered"; sessionId: string }
  /** `targets` named no item or agent that reads the message now. */
  | { kind: "address_refused"; sessionId: string; message: string }

type RestartWorkflowResult =
  | { kind: "restarted"; sessionId: string }
  | { kind: "failed"; message: string }

type TerminalControl =
  | { readonly kind: "open" }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "failed_agents" }

/** The workflow host. It is also the launch host its composition binds to the
 *  workflows module's retained launch operations. */
export interface WorkflowController extends WorkflowLaunchHost {
  /** A model's workflow tool call. */
  startWorkflow(request: ModelWorkflowLaunchRequest): Promise<StartWorkflowResult | WorkflowLaunchRefusal>
  /** Explicit controls retain their address. Only the internal successor supplies planned wake. */
  resumeWorkflow(sessionId: string, address?: WorkflowDeliveryAddress, continuation?: { readonly wake: Exclude<WorkflowWake, WorkflowDeliveryAddress> }): Promise<ResumeWorkflowResult>
  /** A person's message to a workflow, which starts an interrupted or
   *  paused workflow again: to the whole workflow, to the items and agents
   *  that `targets` names, or, from an agent view, to the item or named
   *  agent of that view's attempt. */
  sendWorkflow(sessionId: string, input: ChatInputLike, targets?: WorkflowTargets): Promise<SendWorkflowResult>
  /** A person's Restart of a workflow whose saved progress is damaged. */
  restartWorkflow(sessionId: string): Promise<RestartWorkflowResult>
}

/** The receipt of a delivery, absent when it confirms no submission. */
function confirmed({ confirmedSubmissionIds }: { readonly confirmedSubmissionIds?: readonly string[] }): { confirmedSubmissionIds?: readonly string[] } {
  return confirmedSubmissionIds ? { confirmedSubmissionIds } : {}
}

export function createWorkflowController(deps: WorkflowControllerDeps): WorkflowController {
  const { workflowHosts, manager } = deps
  const { projectRoot } = deps
  const projectionReader = deps.projectionReader
  const runs = workflowRunReader(projectionReader)
  const settings = workflowRunOwner().writer(projectionReader, manager.commitWorkflow)

  let runtimeIdentityPromise: Promise<{ readonly version: string; readonly buildId: string }> | undefined
  const runtimeIdentity = (): Promise<{ readonly version: string; readonly buildId: string }> => {
    runtimeIdentityPromise ??= readAppVersion().then((version) => ({ version, buildId: ownBuildId(deps.userDataRoot) ?? version }))
    return runtimeIdentityPromise
  }


  const lifecycle = createWorkflowLaunchLifecycle(deps)
  const { notifyOriginCoreCompleted, handleRunnerDone, handleRunnerError } = lifecycle

  /** How the workflow's control answers a message or a Resume: a refusal, a
   *  failed run whose failed agents a Resume runs again (`resumesFailedAgents`),
   *  or open. A failed run takes no message. */
  async function terminalControl(sessionId: string, operation: "message" | "resume"): Promise<TerminalControl> {
    try {
      const facts = await readCapturedFacts(projectionReader, { aggregateId: workflowAggregateId(sessionId) })
      const control = replayWorkflowControl(facts)
      if (operation === "resume" && resumesFailedAgents(facts, control)) return { kind: "failed_agents" }
      const message = workflowInteractionRefusal(control.status)
      return message === undefined ? { kind: "open" } : { kind: "refused", message }
    } catch {
      // Historical or unreadable control keeps the existing recovery path,
      // which owns its typed diagnosis and preserves the original bytes.
      return { kind: "open" }
    }
  }

  /** Atomic admission of one launch or resume. Every caller runs this before
   *  dependency preparation, publication, and lifecycle mutation, so a refusal
   *  leaves nothing behind, and an admitted operation carries the grant its
   *  workers settle on. */
  const admit: AdmitWorkflowOperation = (operation, resolve) => admitWorkflowOperation({
    capabilities: deps.capabilities,
    availability: deps.availability,
    operation,
    resolve,
  })

  /** Admission of an existing run, over the definition that run executes. */
  const admitRun = (operation: string, sessionId: string, workflowDefinitionId: string): Promise<WorkflowAdmission> =>
    admit(operation, runDefinition({ reader: projectionReader, sessionId, workflowDefinitionId }))

  const pipeline = createWorkflowLaunchPipeline(deps, lifecycle, admit)

  /** A source as the model reads it in an approval refusal. */
  const describeSource = (source: WorkflowLaunchApprovalSource): string => source.kind === "registered"
    ? `the retired ${source.definitionId} workflow`
    : `the workflow file ${source.path}`

  /** What the live Workflows mode makes of one call's confirmation: a
   *  refusal, the ASK approval to check, or undefined when the launch needs
   *  none. The controller is the one mode authority. It reads the mode here
   *  rather than at the request that advertised the tool, so a stale call
   *  planned under one mode cannot bypass the setting that holds now, and ON
   *  refuses a confirmation it does not ask for rather than ignoring it. */
  function approvalOf(request: ModelWorkflowLaunchRequest): WorkflowLaunchRefusal | { readonly confirmationId: string } | undefined {
    const { confirmation } = request.origin
    const mode = deps.workflowMode()
    if (mode === "ask") return confirmation.kind === "supplied" ? { confirmationId: confirmation.confirmationId } : UNCONFIRMED_LAUNCH
    return mode === "on" && confirmation.kind === "supplied" ? CONFIRMATION_NOT_ACCEPTED : undefined
  }

  function modelLaunchDecisionRequest(request: ModelWorkflowLaunchRequest, source: WorkflowApprovalBinding, confirmationId: string) {
    const { origin } = request
    return {
      store: projectionReader,
      sessionId: origin.chatSessionId,
      interactionId: confirmationId,
      claimId: origin.toolUseId,
      consumption: "exactly-once" as const,
      verify: (decision: Parameters<typeof workflowLaunchMismatch>[0]["decision"], interaction: { readonly conversationId: string }) => workflowLaunchMismatch({
        decision,
        conversationId: interaction.conversationId,
        origin,
        source,
        describe: describeSource,
      }),
    }
  }

  /** Why this model-originated launch is not approved, or undefined when it is.
   *  ASK mediates model launches only. A granted claim is durable before any
   *  workflow side effect, so a later publication failure leaves the
   *  confirmation consumed and the model must ask again. */
  async function confirmModelLaunch(request: ModelWorkflowLaunchRequest, source: WorkflowApprovalBinding): Promise<WorkflowLaunchRefusal | undefined> {
    const approval = approvalOf(request)
    if (approval === undefined || "error" in approval) return approval
    const writer = createSessionFactWriter({ sessionId: request.origin.chatSessionId, writer: deps.eventWriter })
    try {
      const claim = await claimAnsweredDecision({
        ...modelLaunchDecisionRequest(request, source, approval.confirmationId),
        writer,
      })
      return claim.kind === "granted" ? undefined : workflowLaunchRefusal(claim.reason, approval.confirmationId)
    } finally {
      writer.dispose()
    }
  }

  /** Why the model's approval does not authorize this launch yet, read
   *  without consuming it, so a launch that fails preparation keeps it. */
  async function inspectModelLaunch(request: ModelWorkflowLaunchRequest, source: WorkflowApprovalBinding): Promise<WorkflowLaunchRefusal | undefined> {
    const approval = approvalOf(request)
    if (approval === undefined || "error" in approval) return approval
    const inspection = await inspectAnsweredDecision(modelLaunchDecisionRequest(request, source, approval.confirmationId))
    return inspection.kind === "refused" ? workflowLaunchRefusal(inspection.reason, approval.confirmationId) : undefined
  }

  async function startWorkflow(request: ModelWorkflowLaunchRequest): Promise<StartWorkflowResult | WorkflowLaunchRefusal> {
    return pipeline.launchModel(request, {
      inspect: (source) => inspectModelLaunch(request, source),
      claim: (source) => confirmModelLaunch(request, source),
    })
  }

  /** The latest cut of a launched workflow: its recorded run cut, its live
   *  runner's cut of the addressed agents, or the turn end its agent recorded
   *  while no runner holds it. A cut that only a person may continue wins
   *  over any cut the parent may continue, wherever each is recorded. */
  async function launchCut(sessionId: string, address: WorkflowDeliveryAddress = WHOLE_WORKFLOW): Promise<ChildCut | undefined> {
    const pending = await runs.readCut(sessionId)
    const recorded = pending && (pending.by === "person" || pending.by === "agent") ? { kind: "interrupt", by: pending.by } as const : undefined
    if (recorded?.by === "person") return recorded
    const runner = workflowHosts.get(sessionId)
    const reached = runner ? await runner.cut(address) : workflowStepCut(await readWorkflowAgentTurnEnds(projectionReader, sessionId), address)
    return reached && !parentMayContinue(reached) ? reached : recorded ?? reached
  }

  async function resumeLaunch(sessionId: string, address: WorkflowDeliveryAddress = WHOLE_WORKFLOW): Promise<ChildControlAnswer> {
    const cut = await launchCut(sessionId, address)
    if (cut && !parentMayContinue(cut)) return { ok: false, error: personCutRefusal(cut) }
    const resumed = await resumeWorkflow(sessionId, address)
    switch (resumed.kind) {
      case "resumed": return { ok: true }
      case "already_running": return { ok: false, error: "This workflow is not interrupted, so there is nothing to resume." }
      default: return { ok: false, error: resumed.message }
    }
  }

  async function resumeWorkflow(sessionId: string, address: WorkflowDeliveryAddress = WHOLE_WORKFLOW, continuation?: { readonly wake: Exclude<WorkflowWake, WorkflowDeliveryAddress> }): Promise<ResumeWorkflowResult> {
    const session = await runs.read(sessionId)
    const stopped = await workflowStopRefusal(projectionReader, session?.launchedFrom)
    if (stopped) return { kind: "stopped", message: stopped }
    const terminal = await terminalControl(sessionId, "resume")
    if (terminal.kind === "refused") return { kind: "terminal", message: terminal.message }
    // The runner that the failed run ended with, which this Resume may
    // retire. Any other runner is the successor of a concurrent Resume.
    const endedRunner = terminal.kind === "failed_agents" ? workflowHosts.get(sessionId) : undefined
    if (!session) {
      return { kind: "not_found", message: `Workflow session ${sessionId} was not found` }
    }
    // Every Resume is new work, so it passes the same module gate a launch
    // does, and a refusal starts nothing and leaves the workflow paused.
    const operation = `resuming the ${session.workflowDefinitionId} workflow`
    // A run that its failed agents ended has no agent to hand back: a runner
    // still registered for it only waits for its parent to acknowledge the
    // end, so the Resume runs the failed agents in a new run.
    if (terminal.kind !== "failed_agents" && workflowHosts.isRunning(sessionId)) {
      // A capacity wake continues the waiting agents inside the live run, and
      // only them, so an agent whose wait outlived an earlier wake's start
      // continues at its own time (PI-MODEL-039).
      if (continuation !== undefined && continuation.wake !== "planned") {
        return { kind: "resumed", sessionId, continued: workflowHosts.get(sessionId)?.continueCapacity(continuation.wake.capacity) ?? new Set() }
      }
      // A person can start the successor's owed work first. Its live runner
      // already continued runtime cuts; the successor cannot authorize other parks.
      if (continuation !== undefined) return { kind: "already_running", sessionId }
      // A live workflow whose agent a person interrupted continues that agent
      // inside its own attempt and conversation; the same evidence the row
      // admits Resume from gates it (PI-INTERACTION-044). The run keeps the
      // definition revision it captured, so an edit made while it was paused
      // does not reach it, and its runner admits the modules that revision
      // requires.
      const runner = workflowHosts.get(sessionId)
      if (!runner) return { kind: "already_running", sessionId }
      await lifecycle.track(sessionId, session.workflowDefinitionId, "continued")
      const handBack = await runner.handBack(address)
      switch (handBack.kind) {
        case "refused": return { kind: "unavailable", message: handBack.reason }
        case "continued": return { kind: "resumed", sessionId }
        case "not_parked": return { kind: "already_running", sessionId }
      }
    }

    // A Resume that starts the runner again reads the current definitions: it
    // is admitted before the recorded directory is resolved and before any
    // deps are prepared, and the runner's replay adopts or rejects each
    // definition change against the committed control identity (ARCH-WORKFLOWS-031, ARCH-WORKFLOWS-014).
    const admission = await admitRun(operation, sessionId, session.workflowDefinitionId)
    if (!admission.ok) return { kind: "unavailable", message: admission.reason }
    const definitionRevision = admission.availability.definitionRevision
    const moduleSelection = deps.composeModules(admission.grant)

    let executionCwd: string
    try {
      executionCwd = executionCwdFromSession(session, sessionId, projectRoot)
    } catch (err) {
      log.info("workflow resume refused", { sessionId, kind: "execution_directory_missing" })
      return { kind: "unavailable", message: extractErrorMessage(err) }
    }

    let wfDeps: AdmittedWorkflowDeps
    try {
      const auth = await deps.authAdmission.admitWorkflow(sessionId)
      wfDeps = {
        ...auth.workflowDeps,
        capabilityAccess: workflowCapabilityAccess(deps.capabilities, admission.grant),
        moduleSelection: () => moduleSelection,
        definitionRevision,
      }
      wfDeps = bindWorkflowDepsToSession(wfDeps, {
        capture: async () => (await deps.authAdmission.admitWorkflow(sessionId)).workflowDeps,
        current: () => deps.authAdmission.currentWorkflow(sessionId).workflowDeps,
      })
    } catch (err) {
      return { kind: "config", message: `Workflow resume configuration failed: ${extractErrorMessage(err)}` }
    }
    const description = await runs.readRequest(sessionId)
    if (description === null) return { kind: "runtime_start", message: "The original workflow request is unreadable. The workflow remains paused." }
    if (terminal.kind === "failed_agents") {
      const current = workflowHosts.get(sessionId)
      if (current !== undefined ? current !== endedRunner : workflowHosts.allIds().includes(sessionId)) return { kind: "already_running", sessionId }
      // The ended runner leaves before the new run takes its place; its run
      // ended, so leaving releases only its wait for the parent's
      // acknowledgement. A concurrent Resume that retired the same runner
      // may start first.
      if (current !== undefined) await workflowHosts.remove(sessionId, "runtime")
      if (workflowHosts.allIds().includes(sessionId)) return { kind: "already_running", sessionId }
    }
    try {
      await workflowHosts.start({
        sessionId,
        workflow: admission.workflow,
        startMode: "operator_resume",
        wake: continuation?.wake ?? address,
        description,
        executionCwd,
        projectRoot,
        manager,
        workflowDeps: wfDeps,
        recall: deps.recall,
        onPrepared: async (queue) => {
          // A subagent run recovers into the conversation stamped on it; only
          // an unstamped historical run, from a serial build, falls back to
          // the first live conversation.
          const liveConversationIds = resumedWorkflowConversations(queue)
          const recoveryConversationId = liveConversationIds[0]
          const { protectedToolUseIds } = await reconcileWorkflowAgentInput({
            sessionId,
            store: deps.eventReader,
            projectionReader,
            writer: deps.eventWriter,
            conversationIds: liveConversationIds,
          })
          await recoverSessionHistory({
            sessionId,
            reader: deps.eventReader,
            projectionReader,
            writer: deps.eventWriter,
            projectRoot,
            ...(recoveryConversationId ? { fallbackConversationId: recoveryConversationId } : {}),
            ...(protectedToolUseIds.size > 0 ? { protectedToolUseIds } : {}),
          })
          await lifecycle.track(sessionId, admission.workflow.name, "new")
        },
        onSessionName: (labels) => {
          void settings.update(sessionId, current => ({ ...current, ...labels, name: labels.label }), "generated")
            .catch((error: unknown) => recordBackgroundFailure(log, "record generated workflow name", { workflowId: sessionId }, error))
        },
        onCoreCompleted: notifyOriginCoreCompleted,
        onInterruptionChanged: lifecycle.notifyInterruption,
        onRunnerDone: handleRunnerDone,
        onRunnerError: handleRunnerError,
      })
    } catch (err) {
      if (err instanceof WorkflowPreflightError) {
        switch (err.failure.kind) {
          case "attempt_refused":
            log.info("workflow resume refused", { sessionId, attemptId: err.failure.attemptId, kind: err.failure.kind })
            return { kind: "unavailable", message: err.failure.message }
          case "definition_drift": return { kind: "definition_drift", message: err.failure.message }
          case "pre_cutover": return { kind: "pre_cutover", message: err.failure.message }
          case "malformed_state": return await malformedStateRefusal(sessionId, err.failure.message)
          case "drift_evidence_persistence": return { kind: "drift_evidence_persistence", message: err.failure.message }
          case "follow_up": return { kind: "unavailable", message: err.failure.message }
          default: return { kind: "runtime_start", message: `Workflow runtime preflight failed: ${err.failure.message}` }
        }
      }
      return { kind: "runtime_start", message: `Workflow runtime failed to start: ${extractErrorMessage(err)}` }
    }
    return { kind: "resumed", sessionId }
  }

  /** Word a Resume that durable state refused. Only state that Restart can
   * run again offers Restart; the raw reason kinds go to the log. */
  async function malformedStateRefusal(sessionId: string, detail: string): Promise<ResumeWorkflowResult> {
    const assessment = await assessWorkflowRecovery(projectionReader, sessionId)
    log.info("workflow resume refused", {
      sessionId,
      kind: "malformed_state",
      recovery: assessment.kind,
      reasons: assessment.kind === "executable" ? [] : assessment.reasons.map(({ kind }) => kind),
      detail,
    })
    switch (assessment.kind) {
      case "recoverable": return {
        kind: "recovery_required",
        message: `${describeWorkflowRecoveryDegradation(assessment.reasons[0])} Restart runs it again from its recorded request.`,
      }
      case "unrecoverable": return { kind: "malformed_state", message: assessment.message }
      // Recovery has nothing to restart, so Restart would meet this same failure.
      case "executable": return { kind: "malformed_state", message: "This workflow's saved progress could not be loaded. The workflow remains paused." }
    }
  }

  /** A message to a workflow (`session.send`): resume a detached workflow
   * and accept the message once. A running workflow takes the input through
   * the one delivery path, held in its cell until an agent reads it. The
   * input keeps its submission identities, so the client that sent it
   * retires its local copy when the delivery receipt places it in its
   * agents' views. */
  async function sendWorkflow(sessionId: string, input: ChatInputLike, targets?: WorkflowTargets): Promise<SendWorkflowResult> {
    // A person's message that the workflow holds or recorded already is a
    // copy a client sent again after its connection lost the answer. It is
    // answered before any refusal or resume, so a workflow that settled
    // since never refuses what it took, and it records nothing (ARCH-SESSIONS-030).
    const key = personMessageKey(input)
    const recorded = key === undefined ? undefined : await workflowPersonMessage(projectionReader, sessionId, key)
    if (recorded !== undefined) return { kind: "delivered", sessionId, confirmedSubmissionIds: recordPersonMessageReceipt(sessionId, input, recorded) }
    if (chatInputText(input).trim().length === 0) return { kind: "not_delivered", sessionId }
    const session = await runs.read(sessionId)
    const stopped = await workflowStopRefusal(projectionReader, session?.launchedFrom)
    if (stopped) return { kind: "resume_failed", sessionId, message: stopped }
    const terminal = await terminalControl(sessionId, "message")
    if (terminal.kind === "refused") return { kind: "resume_failed", sessionId, message: terminal.message }
    if (targets !== undefined && ("attemptId" in targets || targets.length > 0)) return await sendAddressed(sessionId, input, targets)
    if (!workflowHosts.isRunning(sessionId)) {
      if (!session) return { kind: "resume_failed", sessionId, message: `Workflow session ${sessionId} was not found` }
      const resumed = await resumeWorkflow(sessionId)
      if (resumed.kind !== "resumed" && resumed.kind !== "already_running") return { kind: "resume_failed", sessionId, message: resumed.message }
    }
    const delivery = await deliverWorkflowInput({ manager, projectionReader, eventWriter: deps.eventWriter }, sessionId, input)
    switch (delivery.status) {
      case "delivered": return { kind: "delivered", sessionId, ...confirmed(delivery) }
      case "held": return { kind: "retained", sessionId, ...confirmed(delivery) }
      case "refused": return { kind: "not_delivered", sessionId }
    }
  }

  /** A person's Restart of a workflow whose saved progress is damaged: it
   * publishes the recovery bootstrap (ARCH-WORKFLOWS-034) from the recorded request and the
   * proved committed work, then resumes the run. Only the person restarts a
   * workflow, because a restart replaces the damaged run's state. */
  async function restartWorkflow(sessionId: string): Promise<RestartWorkflowResult> {
    const session = await runs.read(sessionId)
    if (!session) return { kind: "failed", message: `Workflow session ${sessionId} was not found` }
    const stopped = await workflowStopRefusal(projectionReader, session.launchedFrom)
    if (stopped) return { kind: "failed", message: stopped }
    if (workflowHosts.isRunning(sessionId)) return { kind: "failed", message: "This workflow runs, so it has nothing to restart." }
    try {
      for (;;) {
        const admission = await admitRun(`restarting the ${session.workflowDefinitionId} workflow`, sessionId, session.workflowDefinitionId)
        if (!admission.ok) return { kind: "failed", message: admission.reason }
        const recovery = await commitWorkflowRecovery({
          sessionId,
          timestamp: new Date().toISOString(),
          reader: projectionReader,
          writer: deps.eventWriter,
          runtimeIdentity,
          prepare: async (basis, launchInput) => {
            const recoveredSession = await runs.read(sessionId)
            if (!recoveredSession) throw new WorkflowRecoveryPreparationError(`Workflow session ${sessionId} was not found`)
            try {
              const auth = await deps.authAdmission.admitWorkflow(sessionId)
              const definitionRevision = admission.availability.definitionRevision
              return prepareWorkflowAgents({
                workflow: admission.workflow,
                deps: {
                  ...auth.workflowDeps,
                  capabilityAccess: workflowCapabilityAccess(deps.capabilities, admission.grant),
                  moduleSelection: () => deps.composeModules(admission.grant),
                },
                definitionRevision,
              }, basis, launchInput)
            } catch (error) {
              throw new WorkflowRecoveryPreparationError(`Workflow restart configuration failed: ${extractErrorMessage(error)}`)
            }
          },
        })
        if (recovery.kind === "conflict") continue
        if (recovery.kind === "unrecoverable") return { kind: "failed", message: recovery.message }
        log.info("workflow restart committed recovery", { sessionId, recovery: recovery.kind })
        break
      }
    } catch (error) {
      if (error instanceof WorkflowRecoveryPreparationError) return { kind: "failed", message: error.message }
      throw error
    }
    const resumed = await resumeWorkflow(sessionId)
    return resumed.kind === "resumed" || resumed.kind === "already_running" ? { kind: "restarted", sessionId } : { kind: "failed", message: resumed.message }
  }

  /** A person's message to items or agents of a workflow, from an agent
   *  view. It is held in its addressed cell first. A live run hands back
   *  its interrupted agent itself; a workflow that does not run resumes, as
   *  any message of a person restarts its work (PI-INTERACTION-050). The
   *  next commit records the message for the items and agents it names, and
   *  a named agent that the resume continues reads it from its cell at its
   *  start. It never becomes recovery input, which the next agent of any
   *  item would read. */
  async function sendAddressed(sessionId: string, input: ChatInputLike, targets: WorkflowTargets): Promise<SendWorkflowResult> {
    const address = await resolveWorkflowDeliveryAddress(projectionReader, sessionId, targets)
    if (!address.ok) return { kind: "address_refused", sessionId, message: address.refusal }
    const delivery = await deliverWorkflowInput({ manager, projectionReader, eventWriter: deps.eventWriter }, sessionId, input, address.address)
    if (delivery.status === "refused") return { kind: "not_delivered", sessionId }
    if (workflowHosts.isRunning(sessionId)) return { kind: delivery.status === "delivered" ? "delivered" : "retained", sessionId, ...confirmed(delivery) }
    const resumed = await resumeWorkflow(sessionId, address.address)
    if (resumed.kind === "resumed" || resumed.kind === "already_running") return { kind: "delivered", sessionId }
    return { kind: "resume_failed", sessionId, message: `${resumed.message}. Your message is retained for the next resume.` }
  }

  return {
    restoreLaunchTracking: lifecycle.restoreLaunchTracking,
    startWorkflow,
    commitLaunch: pipeline.commitLaunch,
    stopLaunch: lifecycle.stopLaunch,
    launchCut,
    resumeLaunch,
    resumeWorkflow,
    sendWorkflow,
    restartWorkflow,
  }
}

const UNCONFIRMED_LAUNCH = approvalRefusal("This workflow launch needs the user's approval, and the call carried no confirmation_id.")
const CONFIRMATION_NOT_ACCEPTED: WorkflowLaunchRefusal = {
  error: "Workflows does not require approval in this session, so confirmation_id is not accepted.",
  recovery: "Call workflow again without it.",
}

class WorkflowRecoveryPreparationError extends Error {}
