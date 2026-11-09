import { canonicalDirectory, resolveExecutionDirectoryInput } from "../../infra/directory-authorities.js"
import { errorDetail, errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import { recordBackgroundFailure } from "../../infra/operation-log.js"
import type { PublishedWorkflowLaunch } from "../agent-runtime/tools/workflow-tool.js"
import type { RetainedOperationCell, RetainedOperationCommitResult } from "../module-seams.js"
import { WorkflowParentRefusal, type WorkflowLaunchBinding } from "../session/child-session-publication.js"
import { turnEndEntryId } from "../session/conversation/turn-end-record.js"
import { workflowRunReader, workflowRunWriter } from "../module-catalog.js"
import { executionCwdFromSession, requireSessionExecutionCwd } from "../session/session-execution-directory.js"
import type { WorkflowControllerDeps } from "./controller.js"
import { bindWorkflowDepsToSession, type AdmittedWorkflowDeps } from "./deps.js"
import type { WorkflowLaunchLifecycle } from "./launch-lifecycle.js"
import type { WorkflowLaunchOperation } from "./launch-operation-contract.js"
import type { ModelWorkflowLaunchOrigin, ModelWorkflowLaunchRequest, WorkflowApprovalBinding, WorkflowLaunchRefusal } from "./launch-origin.js"
import { prepareWorkflowLaunch, publishWorkflow, WorkflowInputRejectedError } from "./publish.js"
import type { WorkflowCapabilityBoundary } from "../../workflows/run-facts.js"
import {
  launchCapabilityBoundary,
  workflowCapabilityAccess,
  type ResolvedWorkflowDefinition,
  type WorkflowAdmission,
  type WorkflowDefinitionResolution,
  type WorkflowDefinitionResolver,
} from "./workflow-admission.js"
import { describeDefinitionRefusal, launchStructureRefusal, launchWarningLines, loadPathWorkflow, WORKFLOW_FILE_RECOVERY, workflowFileName, type PathWorkflowLaunch } from "./path-workflow.js"
import type { WorkflowLaunchApprovalSource } from "../session/agent-input-facts.js"
import { resolveSessionDir } from "../../infra/paths.js"
import { WorkflowStructureRejectedError } from "../../workflows/vm/structural-admission.js"
import type { WorkflowDefinition } from "../../workflows/workflow-schema.js"
import { readInheritedCheckpointIntent } from "../session/conversation-checkpoint.js"

const log = Log.create({ service: "workflow-controller" })

type Admitted = Extract<WorkflowAdmission, { readonly ok: true }>

/** Admission of one operation over the definition its resolver finds, for a run that a person reads or, when
 *  `unattended`, one that no person reads. */
export type AdmitWorkflowOperation = <R extends ResolvedWorkflowDefinition>(operation: string, resolve: WorkflowDefinitionResolver<R>, unattended: boolean) => Promise<WorkflowAdmission<R>>

/** What a model launch's source resolves to. A workflow file adds what its
 *  pipeline found, which the call's result reports. */
interface ModelLaunchDefinition extends ResolvedWorkflowDefinition {
  readonly launchedFile: PathWorkflowLaunch
}

/** What one model launch admits: the operation the refusal names, and the
 *  resolver of its definition. */
interface ModelLaunchSource {
  readonly operation: string
  readonly resolve: WorkflowDefinitionResolver<ModelLaunchDefinition>
}

/** A model launch's live run: its tool call follows `done`, and `terminate`
 *  is the launch's one Stop (`WorkflowLaunchHost.stopLaunch`). */
export type StartWorkflowResult = PublishedWorkflowLaunch & { readonly parentSessionId: string }

/** A launch whose admission, directory, auth admission, and definition
 *  preparation passed: everything publication and start read. */
interface PreparedLaunch {
  /** The definition admission resolved; the child runs this object. */
  readonly workflow: WorkflowDefinition
  readonly workflowDeps: AdmittedWorkflowDeps
  /** The launching agent's boundary, which `workflowDeps` holds and the run's
   *  registration records for every later start of the run. */
  readonly capabilityBoundary: WorkflowCapabilityBoundary | undefined
  readonly prepared: Awaited<ReturnType<typeof prepareWorkflowLaunch>>
  /** The child's directory when the launch named one; absent, the child
   *  takes its parent's directory at publication. */
  readonly executionCwd: string | undefined
  readonly workflowName: string
}

/** Why a launch cannot start, as the reason kind its decision records and
 *  the refusal its caller reads. */
interface LaunchRefusal extends WorkflowLaunchRefusal {
  readonly reasonKind: "admission" | "definition" | "origin" | "directory" | "input" | "config" | "parent" | "acceptance" | "publication"
}

type Preparation = { readonly ok: true; readonly launch: PreparedLaunch } | ({ readonly ok: false } & LaunchRefusal)

/** The model path's own evidence: the ASK approval of its tool call.
 *  `inspect` reads it before preparation and `claim` consumes it after, so a
 *  preparation failure leaves the approval reusable. Each checks the approval
 *  against `source`, the binding of what admission resolved, and answers the
 *  refusal, or undefined when the launch may proceed. */
interface ModelLaunchApproval {
  inspect(source: WorkflowApprovalBinding): Promise<WorkflowLaunchRefusal | undefined>
  claim(source: WorkflowApprovalBinding): Promise<WorkflowLaunchRefusal | undefined>
}

interface WorkflowLaunchPipeline {
  /** A model's workflow tool call: its committed call is the evidence, so the
   *  launch publishes under it and starts the child before it answers. */
  launchModel(request: ModelWorkflowLaunchRequest, approval: ModelLaunchApproval): Promise<StartWorkflowResult | WorkflowLaunchRefusal>
  commitLaunch(operation: WorkflowLaunchOperation, cell: RetainedOperationCell): Promise<RetainedOperationCommitResult>
}

/** The one launch pipeline (ARCH-WORKFLOWS-017). Admission, directory resolution, auth
 *  admission, definition preparation, publication, dispatch, and the
 *  start-failure policy exist once; each origin supplies only its evidence. */
export function createWorkflowLaunchPipeline(
  deps: WorkflowControllerDeps,
  lifecycle: WorkflowLaunchLifecycle,
  admit: AdmitWorkflowOperation,
): WorkflowLaunchPipeline {
  const { manager, workflowHosts, projectRoot, projectionReader } = deps
  const runs = workflowRunReader(projectionReader)
  const settings = workflowRunWriter(projectionReader, (input) => manager.commitWorkflow(input))
  /** Prepare one launch of the definition admission resolved. Only a model
   *  launch carries structured input, so a stored runtime intent never holds
   *  any. A launch of a workflow file names `file`, so a refusal of its flow
   *  or of its input contract is located in the file and tells the author
   *  how to repair it. */
  async function prepare(intent: Pick<ModelWorkflowLaunchRequest, "description" | "launchCwd" | "input">, origin: ModelWorkflowLaunchOrigin, admission: Admitted, file: PathWorkflowLaunch): Promise<Preparation> {
    const { chatSessionId: parentSessionId, conversationId: parentConversationId } = origin
    const { workflow } = admission
    const definitionRevision = admission.availability.definitionRevision
    // A workflow's cwd is a per-agent value that never joins the chat tree's
    // shared agent host key: it travels in the agent file (`.meta.json` cwd),
    // so agents in different directories share one Claude engine process. A
    // new per-agent launch value starts another process, so it belongs in
    // HOST_SPLIT_EXCEPTIONS (provider-claude-agent-sdk/agent-host/host-registry.ts)
    // with its reason.
    let executionCwd: string | undefined
    if (intent.launchCwd !== undefined) {
      try {
        const parentExecutionCwd = await requireSessionExecutionCwd(manager, parentSessionId, projectRoot)
        executionCwd = canonicalDirectory(resolveExecutionDirectoryInput(parentExecutionCwd, intent.launchCwd), "workflow execution directory")
      } catch (error) {
        return { ok: false, reasonKind: "directory", error: `Workflow directory error: ${errorMessage(error)}` }
      }
    }
    try {
      const auth = await deps.authAdmission.admit(parentSessionId)
      // The admitted set narrows only what the workflow's agents may call: they
      // advertise the tools of their chat tree's module capture (SharedTree in
      // agent-runtime/shared-tree.ts), because advertising another set would
      // start another Claude engine process for the tree.
      const moduleSelection = deps.composeModules(admission.grant)
      const capabilityBoundary = launchCapabilityBoundary(origin.capabilityAccess)
      const workflowDeps: AdmittedWorkflowDeps = {
        ...auth.workflowDeps,
        capabilityAccess: workflowCapabilityAccess(deps.capabilities, admission.grant, capabilityBoundary),
        moduleSelection: () => moduleSelection,
        definitionRevision,
      }
      const prepared = await prepareWorkflowLaunch({
        workflow,
        description: intent.description,
        inheritedIntent: await readInheritedCheckpointIntent(projectionReader, parentSessionId, parentConversationId),
        deps: workflowDeps,
        authProfileId: auth.profile.persistedId,
        projectRoot,
        definitionRevision,
        ...(intent.input === undefined ? {} : { input: intent.input }),
        verification: file.verification.result,
        warnings: launchWarningLines(file),
        buildDefinitionLineageFacts: deps.buildDefinitionLineageFacts,
      })
      return { ok: true, launch: { workflow, workflowDeps, capabilityBoundary, prepared, executionCwd, workflowName: workflow.name } }
    } catch (error) {
      if (error instanceof WorkflowInputRejectedError) return { ok: false, reasonKind: "input", error: error.message, recovery: WORKFLOW_FILE_RECOVERY }
      if (error instanceof WorkflowStructureRejectedError) {
        const refusal = launchStructureRefusal(file, error)
        return { ok: false, reasonKind: "definition", ...describeDefinitionRefusal(`The workflow file ${file.shown} cannot launch: `, refusal), recovery: WORKFLOW_FILE_RECOVERY }
      }
      log.warn("workflow launch config error", { workflowDefinitionId: workflow.id, error: errorMessage(error), errorDetail: errorDetail(error) })
      return { ok: false, reasonKind: "config", error: `Config error: ${errorMessage(error)}` }
    }
  }

  /** One decision record per launch decision: ids and kinds only (F099). */
  function decide(decision: "accepted" | "refused" | "committed" | "retained" | "start-failed", fields: {
    readonly childSessionId?: string
    readonly parentSessionId?: string
    readonly operationId?: string
    readonly workflowDefinitionId?: string
    readonly source?: WorkflowLaunchApprovalSource["kind"]
    readonly origin: string
    readonly reasonKind?: string
  }): void {
    log.info("workflow launch decision", { decision, ...fields })
  }

  function refuse(refusal: LaunchRefusal, fields: Parameters<typeof decide>[1]): WorkflowLaunchRefusal {
    decide("refused", { ...fields, reasonKind: refusal.reasonKind })
    return { error: refusal.error, ...(refusal.problems === undefined ? {} : { problems: refusal.problems }), ...(refusal.recovery === undefined ? {} : { recovery: refusal.recovery }) }
  }

  /** Starts a published child. Failure reconciliation waits for the parent's
   * writer, so its settlement is separate from the dispatch that writer joins.
   * A model call keeps the detached policy because it can wait on this start. */
  async function startChild(input: { readonly childSessionId: string; readonly description: string; readonly launch: PreparedLaunch; readonly fields: Parameters<typeof decide>[1] }) {
    const { childSessionId: sessionId, launch } = input
    const tracked = await lifecycle.track(sessionId, launch.workflowName, "new")
    try {
      const run = await runs.read(sessionId)
      if (!run) throw new Error(`Workflow not found: ${sessionId}`)
      const executionCwd = executionCwdFromSession(run, sessionId, projectRoot)
      await deps.authAdmission.admitWorkflow(sessionId)
      await workflowHosts.start({
        sessionId,
        workflow: launch.workflow,
        startMode: "launch",
        description: input.description,
        executionCwd,
        projectRoot,
        manager,
        workflowDeps: bindWorkflowDepsToSession(launch.workflowDeps, {
          capture: async () => (await deps.authAdmission.admitWorkflow(sessionId)).workflowDeps,
          current: () => deps.authAdmission.currentWorkflow(sessionId).workflowDeps,
        }),
        recall: deps.recall,
        onSessionName: (labels) => {
          void settings.update(sessionId, (current) => ({ ...current, ...labels, name: labels.label }), "generated")
            .catch((error: unknown) => recordBackgroundFailure(log, "record generated workflow name", { workflowId: sessionId }, error))
        },
        onCoreCompleted: lifecycle.notifyOriginCoreCompleted,
        onInterruptionChanged: lifecycle.notifyInterruption,
        onRunnerDone: lifecycle.handleRunnerDone,
        onRunnerError: lifecycle.handleRunnerError,
      })
    } catch (error) {
      decide("start-failed", input.fields)
      const settlement = lifecycle.handleStartFailure(sessionId, error).catch((failure: unknown) => {
        recordBackgroundFailure(log, "settle workflow start failure", { sessionId }, failure)
      })
      return { tracked, settlement }
    }
    return { tracked }
  }

  /** The resolver of one model launch's source. A workflow file resolves
   *  through the path pipeline in the launching chat's session directory,
   *  within that chat's tools and personas. */
  function modelSource(request: ModelWorkflowLaunchRequest): ModelLaunchSource {
    const { source, origin } = request
    const sessionDir = resolveSessionDir(origin.chatSessionId, projectRoot)
    return {
      operation: `the workflow file ${workflowFileName(source.path, sessionDir)}`,
      resolve: async (revision): Promise<WorkflowDefinitionResolution<ModelLaunchDefinition>> => {
        const loaded = await loadPathWorkflow({
          path: source.path,
          ...(request.savedContent === undefined ? {} : { savedContent: request.savedContent }),
          sessionDir,
          revision,
          authority: origin.authority,
        })
        return loaded.ok ? { ok: true, workflow: loaded.workflow, launchedFile: loaded } : loaded
      },
    }
  }

  async function launchModel(request: ModelWorkflowLaunchRequest, approval: ModelLaunchApproval): Promise<StartWorkflowResult | WorkflowLaunchRefusal> {
    const { origin } = request
    const parentSessionId = origin.chatSessionId
    const parent = await manager.read(parentSessionId)
    if (parent?.kind !== "chat" || parent.conversationId !== origin.conversationId) {
      return refuse({ reasonKind: "origin", error: `Workflow parent ${parentSessionId} is not the host-attested chat conversation` }, { parentSessionId, origin: origin.kind })
    }
    const requested = modelSource(request)
    const admission = await admit(requested.operation, requested.resolve, origin.capabilityAccess?.unattended === true)
    if (!admission.ok) {
      // A workflow file's refusal tells the agent how to repair the file.
      const recovery = admission.recovery === undefined ? {} : { recovery: admission.recovery }
      return refuse(admission.diagnostics
        ? { reasonKind: "definition", ...describeDefinitionRefusal("", admission), ...recovery }
        : { reasonKind: "admission", error: admission.reason, ...recovery }, { parentSessionId, source: request.source.kind, origin: origin.kind })
    }
    const { launchedFile } = admission
    const fields = { parentSessionId, workflowDefinitionId: admission.workflow.id, source: request.source.kind, origin: origin.kind }
    const approvalSource: WorkflowApprovalBinding = {
        kind: "path",
        path: launchedFile.file,
        definitionSha256: launchedFile.definitionSha256,
        ...(launchedFile.retiredDefinitionSha256 === undefined ? {} : { retiredDefinitionSha256: launchedFile.retiredDefinitionSha256 }),
      }
    const unapproved = await approval.inspect(approvalSource)
    if (unapproved) return refuse({ reasonKind: "origin", ...unapproved }, fields)
    const preparation = await prepare(request, origin, admission, launchedFile)
    if (!preparation.ok) return refuse(preparation, fields)
    const unclaimed = await approval.claim(approvalSource)
    if (unclaimed) return refuse({ reasonKind: "origin", ...unclaimed }, fields)
    const { launch } = preparation
    let childSessionId: string
    try {
      childSessionId = await publishWorkflow({
        manager,
        prepared: launch.prepared,
        launchedFrom: binding(launch.workflow.id, request.description, parentSessionId, origin.conversationId, origin.toolUseId),
        ...(launch.capabilityBoundary ? { capabilityBoundary: launch.capabilityBoundary } : {}),
        ...(request.summary !== undefined ? { summary: request.summary } : {}),
        ...(launch.executionCwd ? { executionCwd: launch.executionCwd } : {}),
      })
    } catch (error) {
      if (error instanceof WorkflowParentRefusal) return refuse({ reasonKind: "parent", error: error.message }, fields)
      log.warn("workflow publish error", { workflowDefinitionId: launch.workflow.id, error: errorMessage(error), errorDetail: errorDetail(error) })
      return refuse({ reasonKind: "publication", error: `Workflow publish error: ${errorMessage(error)}` }, fields)
    }
    const committed = { ...fields, childSessionId }
    decide("committed", committed)
    const { tracked } = await startChild({ childSessionId, description: request.description, launch, fields: committed })
    return {
      workflowId: childSessionId,
      parentSessionId,
      stepModels: launch.prepared.stepModels,
      ...tracked,
      workflowFile: {
          path: launchedFile.file,
          definitionSha256: launchedFile.definitionSha256,
          verification: launchedFile.verification.result,
          verificationUncertainties: [...new Set(launchedFile.verification.uncertainties.map(({ name }) => name))],
          worstCaseAttempts: launch.prepared.worstCaseAttempts,
          warnings: launchWarningLines(launchedFile),
      },
    }
  }

  /** Settle launches accepted by an earlier build without starting new work.
   *  Published children stay intact. Remove this reader after 2027-04-30. */
  async function commitLaunch(operation: WorkflowLaunchOperation, cell: RetainedOperationCell): Promise<RetainedOperationCommitResult> {
    const fields = { operationId: operation.operationId, parentSessionId: operation.parentSessionId, childSessionId: operation.childSessionId, workflowDefinitionId: operation.launch.workflowDefinitionId, origin: operation.initiator }
    // A commit whose cell is gone repeats one that already settled the
    // launch: that commit published it or refused it, and retired the cell.
    // A Resume that read the cell before then hands the writer the same
    // launch again. It starts nothing and frees the writer's queue.
    const settledEarlier = async (): Promise<RetainedOperationCommitResult | undefined> => {
      if ((await deps.eventReader.readInFlight(cell.sessionId, cell.kind)).some((row) => row.key === cell.key)) return undefined
      log.debug("workflow launch already settled", { operationId: operation.operationId, parentSessionId: operation.parentSessionId })
      return { kind: "committed", dispatch: () => {} }
    }
    const repeated = await settledEarlier()
    if (repeated) return repeated
    const result = await commit(operation, cell, fields)
    if (result.kind === "retained") {
      // A concurrent commit of the same launch can settle it while this
      // one runs. Only a cell that still waits is retained.
      const settled = await settledEarlier()
      if (settled) return settled
      decide("retained", fields)
    }
    return result
  }

  async function commit(operation: WorkflowLaunchOperation, cell: RetainedOperationCell, fields: Parameters<typeof decide>[1]): Promise<RetainedOperationCommitResult> {
    const existing = await runs.read(operation.childSessionId)
    if (existing?.launchedFrom.parentSessionId === operation.parentSessionId && existing.launchedFrom.toolUseId === operation.toolUseId) {
      // A repeated acceptance of a launch this parent already published: the
      // child exists, so the commit only retires the cell and starts nothing.
      if (!deps.eventWriter.swapInFlight) throw new Error("Workflow launch commit requires exact in-flight write authority")
      if (!await deps.eventWriter.swapInFlight(cell.sessionId, cell.kind, cell.key, cell.raw, null)) return { kind: "retained" }
      decide("committed", fields)
      return { kind: "committed", dispatch: () => {} }
    }
    // A refusal settles the person's command with the reason, under the id
    // the acknowledgement would have taken, and retires the cell with it.
    decide("refused", { ...fields, reasonKind: "retired" })
    const content = `The ${operation.launch.workflowDefinitionId} workflow could not start: Flywheel no longer launches a workflow by name. Ask the chat to write and launch a workflow file.`
    return {
      kind: "refused",
      notice: { kind: "user", origin: "system", content },
      noticeId: turnEndEntryId({ reason: "settled" }, operation.operationId),
      retire: { op: "swap", kind: cell.kind, key: cell.key, expectedRaw: cell.raw, payload: null },
    }
  }

  return { launchModel, commitLaunch }
}

/** The parent chat call a published workflow belongs to. */
function binding(workflowDefinitionId: string, description: string, parentSessionId: string, conversationId: string, toolUseId: string): WorkflowLaunchBinding {
  return { parentSessionId, conversationId, workflowDefinitionId, description, toolUseId }
}

