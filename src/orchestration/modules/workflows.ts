import { readAttemptExecutionHistory } from "./workflows/history/efficiency.js"
import { createWorkflowToolSummaryReader } from "./workflows/history/tool-summary.js"
import { adoptWorkflowChildren, workflowChildrenNeedAdoption } from "./workflows/migrations/adopt-workflow-children.js"
import { readWorkflowAgentSessionTitle } from "./workflows/agent-title.js"
import { titleWorkflowAgentSessions } from "./workflows/migrations/workflow-agent-session-titles.js"
import { convertWorkflowAgentSessions, workflowAgentSessionsNeedConversion } from "./workflows/migrations/workflow-agent-sessions.js"
import { workflowsProtocol } from "../../protocol/modules/workflows.js"
import { moduleProtocol } from "../app-service/module-protocol-host.js"
import { createWorkflowsProtocol, workflowBackgroundReaders, workflowProtocolServices } from "./workflows/protocol.js"
import { invalidateSupersededQueueFacts } from "./workflows/queue-maintenance.js"
import { migrateLegacyStepCatalog } from "./workflows/migrations/legacy-step-catalog-filesystem.js"
import { migrateQueueStepSkillId } from "./workflows/migrations/queue-step-skill-id.js"
import { migrateRetiredSelfReview } from "./workflows/migrations/retired-self-review.js"
import { migrateRetiredChildAskUser } from "./workflows/migrations/retired-child-ask-user.js"
import { migrateStepRowContentId } from "./workflows/migrations/step-row-content-id.js"
import { migrateLoopBodyRows } from "./workflows/migrations/loop-body-rows.js"
import { migrateResumeRevertAttemptId } from "./workflows/migrations/resume-revert-attempt-id.js"
import { migrateContextRecipientStepId } from "./workflows/migrations/context-recipient-step-id.js"
import { migrateWorkflowDefinitionIdentityContext } from "./workflows/migrations/workflow-definition-identity.js"
import { migrateDefinitionLoadedHandoffFilename } from "./workflows/migrations/definition-loaded-handoff-filename.js"
import { migrateDefinitionIdentitySkillCatalog } from "./workflows/migrations/workflow-definition-identity-skill-catalog.js"
import { migrateWorkflowDefinitionIdentityGraph } from "./workflows/migrations/workflow-definition-identity-graph.js"
import { migrateWorkflowDefinitionIdentityRetiredSelfReview } from "./workflows/migrations/workflow-definition-identity-retired-self-review.js"
import { migrateWorkflowDefinitionIdentityRetiredChildAskUser } from "./workflows/migrations/workflow-definition-identity-retired-child-ask-user.js"
import { migrateWorkflowDefinitionIdentityRetiredBlocked } from "./workflows/migrations/workflow-definition-identity-retired-blocked.js"
import { migrateWorkflowDefinitionIdentityPersonaShell } from "./workflows/migrations/workflow-definition-identity-persona-shell.js"
import { HANDOFF_REVISION_MIGRATIONS, migrateHandoffRevisions } from "./workflows/migrations/workflow-definition-identity-handoff-revisions.js"
import { dropLegacyWorkflowPruneEvidence } from "./workflows/migrations/workflow-prune-evidence.js"
import { DefinitionProvenanceFactSchemas } from "../../workflows/definition-provenance-facts.js"
import { HandoffFactSchemas } from "../../workflows/output-contract/facts.js"
import { isWorkflowExecutionFact } from "../../workflows/output-contract/workflow-completion.js"
import { fileURLToPath } from "node:url"
import { Log } from "../../infra/log.js"
import { moduleRuntimeHandle, type ModuleRuntimes } from "../../infra/module-runtime.js"
import type { KernelToolDeps } from "../agent-runtime/tools/kernel-tool-deps.js"
import type { ModuleRuntimeServices } from "../agent-runtime/module-runtime-services.js"
import type { RuntimeTool } from "../agent-runtime/tools/types.js"
import { ORCHESTRATION_REMINDER, orchestrationSection } from "./workflows/orchestration.js"
import type { LaunchingSessionAuthority } from "../workflow-host/path-workflow.js"
import type { ToolDeclaration } from "../agent-runtime/tools/tool-registry.js"
import { moduleDisabledReason } from "../../protocol/module-ids.js"
import type { WorkflowToolDeps } from "../agent-runtime/tools/workflow-tool.js"
import { createWorkflowTool, WORKFLOW_RUNTIME_INVOCATION_TOOL } from "../agent-runtime/tools/workflow.js"
import { createModelsTool, MODELS_TOOL_DEFINITION } from "./workflows/models.js"
import type { FirstPartyModule } from "../modules.js"
import type { CliNounContribution } from "../cli-contribution.js"
import { workflowLaunchTargets } from "../workflow-host/launch-origin.js"
import { createBudgetAwarenessObserver, createContextPressureObserver } from "../agent-runtime/batch-observers.js"
import { workflowLaunchRetainedOperation } from "./workflows/launch-operation.js"
import { workflowWorkControl, workflowWorkState } from "./workflows/child-session.js"
import { parseProjectionFact } from "../../infra/event-projection.js"
import { parseSessionRuntimeFact } from "../../infra/runtime-fact-parser.js"
import { WorkflowRunFactSchemas } from "../../workflows/run-facts.js"
import { createWorkflowPlacements, createWorkflowRunReader, createWorkflowSettingsReader } from "./workflows/run-record.js"
import { createWorkflowRunWriter, workflowRegistration, startedWorkflowAttempt, workflowAdoption, workflowAccounting, workflowDeletion, workflowSettlement, workflowCutAppend, workflowIsDeleted } from "./workflows/run-facts.js"
import { settleWorkflowDeletion } from "./workflows/deletion.js"
import { createWorkflowHosts } from "./workflows/host-collection.js"

/** The launch surface of one runner. Each request reads the live mode. */
export interface WorkflowsRuntime {
  readonly deps: () => WorkflowToolDeps
  /** The authority of this runner's session under one planned tool set. */
  readonly authority: (planned: ReadonlyMap<string, RuntimeTool>) => LaunchingSessionAuthority
}

const workflowsRuntime = moduleRuntimeHandle<WorkflowsRuntime>("workflows")

/** The root chat orchestrates while Workflows is On. */
function orchestrates({ kernel, tools, modules }: { readonly kernel: KernelToolDeps; readonly tools: ReadonlyMap<string, RuntimeTool>; readonly modules: ModuleRuntimes }): boolean {
  return kernel.purpose.kind === "interactive-chat" && tools.has("workflow") && modules.get(workflowsRuntime)?.deps().mode === "on"
}

function createWorkflowsRuntime(services: ModuleRuntimeServices): WorkflowsRuntime | undefined {
  const { startWorkflow, background } = services
  if (!startWorkflow || !background) return undefined
  return {
    deps: () => ({
      startWorkflow,
      onRenderEvent: services.onBackgroundEvent ?? services.onEvent,
      // A host that owns no capability policy still asks: approval is the
      // conservative default for a model-originated launch.
      mode: services.workflowMode?.() ?? "ask",
      resolveLaunchTarget: workflowLaunchTargets({ revision: () => services.definitions.captureRevision(), sessionDir: services.sessionDir, executionCwd: services.executionCwd }),
      ...(services.sessionDir === undefined ? {} : { sessionDir: services.sessionDir }),
      executionCwd: services.executionCwd,
    }),
    authority: (planned) => launchingSessionAuthority(planned, services),
  }
}

/** What the calling session may grant the agents of a workflow file: the
 *  actions of its planned tools, and the personas its subagent tool can
 *  dispatch. A session that plans no subagent tool dispatches no persona. */
export function launchingSessionAuthority(planned: ReadonlyMap<string, RuntimeTool>, services: Pick<ModuleRuntimeServices, "allowedSubagentTypes" | "personas">): LaunchingSessionAuthority {
  const toolActions = new Set([...planned.values()].map((tool) => tool.action))
  if (!toolActions.has("task_subagent")) return { toolActions, personas: new Set() }
  const personas = [...services.personas.values()].filter((agent) => agent.kind === "persona").map((agent) => agent.name)
  return { toolActions, personas: new Set(services.allowedSubagentTypes ? personas.filter((name) => services.allowedSubagentTypes?.has(name)) : personas) }
}

/** What a tool built before its request's tools are planned may grant: nothing. */
const NO_AUTHORITY: LaunchingSessionAuthority = { toolActions: new Set(), personas: new Set() }

const workflow = {
  category: "opt-in",
  action: "task_subagent",
  cloneInheritance: "reconstruct",
  learningReviewExecutable: false,
  semanticBundle: null,
  personaBaseline: false,
  registryOrder: 19,
  registrations: {
    workflow: {
      capabilities: ["workflows"],
      create: ({ kernel, modules }) => {
        const runtime = modules.get(workflowsRuntime)
        if (!runtime) return { reason: "no workflow starter available" }
        const deps = runtime.deps()
        if (deps.mode === "off") return { reason: moduleDisabledReason(["workflows"]) }
        const mode = deps.mode
        return {
          tool: createWorkflowTool({ ...deps, mode, askUserAvailable: false, authority: NO_AUTHORITY, capabilities: kernel.treeCapabilities }),
          // A launch in Ask mode carries its approval through ask_user, so the
          // tool settles only once the planned set says whether that channel exists.
          refine: (planned) => {
            const askUserAvailable = planned.has("ask_user")
            if (mode === "ask" && !askUserAvailable) return { reason: "workflow Ask mode requires the Ask User capability, which only a root chat has; a child session messages its parent to ask for a launch" }
            return { tool: createWorkflowTool({ ...deps, mode, askUserAvailable, authority: runtime.authority(planned), capabilities: kernel.treeCapabilities }) }
          },
        }
      },
    },
  },
} as const satisfies ToolDeclaration<"workflows">

/** The models table serves choosing a workflow agent's model and effort, so it
 *  is offered while Workflows is Ask or On, also before the person approves. */
const models = {
  category: "ambient",
  action: "ui_meta",
  cloneInheritance: "reconstruct",
  learningReviewExecutable: false,
  semanticBundle: null,
  personaBaseline: false,
  registryOrder: 23,
  registrations: {
    models: {
      capabilities: ["workflows"],
      create: ({ kernel }) => kernel.captureProviderConnection
        ? { tool: createModelsTool(kernel.captureProviderConnection, kernel.userDataRoot) }
        : { unusable: { tool: MODELS_TOOL_DEFINITION, reason: "no live model access capture available" } },
    },
  },
} as const satisfies ToolDeclaration<"workflows">

const workflowBudgetObserver = {
  seam: "workflow",
  observer: (context) => createBudgetAwarenessObserver(context.getBudgetInfo),
} as const satisfies FirstPartyModule["observers"][number]

const workflowContextPressureObserver = {
  seam: "workflow",
  observer: (context) => createContextPressureObserver(context.getContextPercent),
} as const satisfies FirstPartyModule["observers"][number]

const workflowNoun = {
  usage: "Usage: flywheel workflow verify <file> | flywheel workflow verify --workflow <id> | flywheel workflow reducers",
  verbs: {
    reducers: {
      syntax: "reducers",
      description: "List the registered reducers a map join can name.",
      run: async () => {
        const { runWorkflowReducers } = await import("./workflows/cli/reducers.js")
        runWorkflowReducers()
      },
    },
    verify: {
      syntax: "verify <file>",
      description: "Verify a workflow file compiles and is sound. With --workflow <id>, replay a workflow read-only.",
      run: async (args, { directories }) => {
        // Skill and persona load diagnostics belong in the project's debug log.
        // A workflow replay loads no definition and writes nothing, not even a log.
        if (args[0] !== "--workflow") await Log.init({ dir: directories.projectRoot })
        const { runWorkflowVerify } = await import("./workflows/cli/verify.js")
        process.exitCode = await runWorkflowVerify(args, directories)
      },
    },
  },
} as const satisfies CliNounContribution

export const workflowsModule = {
  id: "workflows",
  protocol: moduleProtocol({ contract: workflowsProtocol, create: createWorkflowsProtocol, background: workflowBackgroundReaders }),
  selectionPolicy: ({ moduleIds, requireWorkflowConfirmation }) => requireWorkflowConfirmation && moduleIds.includes("workflows") && !moduleIds.includes("ask-user")
    ? "Workflows in Ask mode requires the Ask User capability. Enable Ask User, or set Workflows to On or Off."
    : undefined,
  dependencies: ["skills"],
  availability: { kind: "available" },
  producesBackgroundWork: true,
  runtime: { handle: workflowsRuntime, create: createWorkflowsRuntime },
  // The VM control ledger, attempts, lifecycle, context bundles, definition
  // provenance, handoffs, follow-ups, and the queue view, all defined in
  // `src/workflows/`. The runner's own `workflow.step.started`,
  // `workflow.worker_boundary.recorded`, and `workflow.tool_result.corrected`
  // share the spelling and stay kernel in the retention registry.
  facts: {
    prefixes: ["attempt.", "workflow.", "for.", "group.", "context.", "step_context.", "definition.", "handoff.", "follow_up.", "queue.", "step."],
    sessionSchemas: () => [...DefinitionProvenanceFactSchemas, ...HandoffFactSchemas, ...WorkflowRunFactSchemas] as const,
    invalidateSuperseded: invalidateSupersededQueueFacts,
  },
  workspaceMigrations: [
    { phase: "definition-overlays", order: 10, label: "legacy step catalog", run: ({ directories }) => { migrateLegacyStepCatalog(directories) } },
    { phase: "stored-facts", order: 10, label: "queue step skill ids", run: ({ dbFile }) => { migrateQueueStepSkillId(dbFile) } },
    { phase: "stored-facts", order: 15, label: "retired self-review policy, refused rows", run: ({ dbFile }) => { migrateRetiredSelfReview(dbFile) } },
    { phase: "stored-facts", order: 16, label: "retired child ask_user scope", run: ({ dbFile }) => { migrateRetiredChildAskUser(dbFile) } },
    { phase: "stored-facts", order: 17, label: "step row content ids", run: ({ dbFile }) => { migrateStepRowContentId(dbFile) } },
    { phase: "stored-facts", order: 18, label: "loop body rows", run: ({ dbFile }) => { migrateLoopBodyRows(dbFile) } },
    { phase: "stored-facts", order: 19, label: "resume revert attempt ids", run: ({ dbFile }) => { migrateResumeRevertAttemptId(dbFile) } },
    { phase: "stored-facts", order: 20, label: "context recipient step ids", run: ({ dbFile }) => { migrateContextRecipientStepId(dbFile) } },
    { phase: "stored-facts", order: 30, label: "workflow definition identity", run: ({ dbFile, directories }) => { migrateWorkflowDefinitionIdentityContext(dbFile, directories) } },
    { phase: "stored-facts", order: 40, label: "handoff filenames", run: ({ dbFile }) => { migrateDefinitionLoadedHandoffFilename(dbFile) } },
    { phase: "stored-facts", order: 50, label: "definition skill catalog", run: ({ dbFile, directories }) => { migrateDefinitionIdentitySkillCatalog(dbFile, directories) } },
    { phase: "stored-facts", order: 70, label: "workflow graph identities", run: ({ dbFile, directories }) => { migrateWorkflowDefinitionIdentityGraph(dbFile, directories) } },
    { phase: "stored-facts", order: 75, label: "retired self-review identities", run: ({ dbFile }) => { migrateWorkflowDefinitionIdentityRetiredSelfReview(dbFile) } },
    { phase: "stored-facts", order: 76, label: "retired child ask_user identities", run: ({ dbFile }) => { migrateWorkflowDefinitionIdentityRetiredChildAskUser(dbFile) } },
    { phase: "stored-facts", order: 77, label: "retired blocked identities", run: ({ dbFile }) => { migrateWorkflowDefinitionIdentityRetiredBlocked(dbFile) } },
    { phase: "stored-facts", order: 78, label: "persona shell identities", run: ({ dbFile }) => { migrateWorkflowDefinitionIdentityPersonaShell(dbFile) } },
    { phase: "stored-facts", order: 79, label: "handoff revision identities", run: ({ dbFile }) => { for (const migration of HANDOFF_REVISION_MIGRATIONS) migrateHandoffRevisions(dbFile, migration) } },
    { phase: "stored-facts", order: 80, label: "remove obsolete workflow prune evidence", requiresExclusiveOwner: true, run: ({ dbFile }) => { dropLegacyWorkflowPruneEvidence(dbFile) } },
    { phase: "stored-facts", order: 85, label: "workflow child ownership", requiresExclusiveOwner: true, requiredWhen: ({ dbFile }) => workflowChildrenNeedAdoption(dbFile), run: ({ dbFile, directories }) => { adoptWorkflowChildren(dbFile, directories.projectRoot) } },
    { phase: "stored-facts", order: 86, label: "workflow agent session ownership", requiresExclusiveOwner: true, requiredWhen: ({ dbFile }) => workflowAgentSessionsNeedConversion(dbFile), run: ({ dbFile }) => { convertWorkflowAgentSessions(dbFile) } },
    { phase: "stored-facts", order: 87, label: "workflow agent session titles", run: ({ dbFile }) => { titleWorkflowAgentSessions(dbFile) } },
  ],
  retainedDiagnostics: { attempts: readAttemptExecutionHistory },
  retainedOperations: [workflowLaunchRetainedOperation],
  sessionHistory: { createToolSummaryReader: createWorkflowToolSummaryReader },
  sessionAdmission: {
    affectedSessions(fact) {
      if (fact.type === "workflow.tool_result.corrected") {
        const corrected = parseProjectionFact(fact, parseSessionRuntimeFact)
        return corrected.type === "workflow.tool_result.corrected" ? [corrected.payload.childSessionId] : []
      }
      return fact.type === "workflow.control.initialized" || fact.type === "workflow.control.recovered"
        || fact.type === "workflow.control.committed" || fact.type === "definition.drift_rejected" || fact.type.startsWith("attempt.")
        ? [fact.sessionId] : []
    },
  },
  runtimeInvocationTool: WORKFLOW_RUNTIME_INVOCATION_TOOL,
  sessionDeletion: {
    kind: "workflow",
    settle: async (input) => {
      if (input.session.kind !== "workflow") throw new Error("Workflow deletion requires workflow metadata")
      const [{ recordChildWorkflowStop }, { reconcileChildSessionCompletions }] = await Promise.all([
        import("../session/child-workflow-result.js"),
        import("../session/child-session-reconciliation.js"),
      ])
      const binding = input.session.launchedFrom
      // Deletion stops the child as a person's Stop does, unless its call
      // already holds a result. It reconciles the parent either way, before
      // the child is unlinked, so the one notification of how the call ended
      // reaches the parent also when an earlier Stop's own reconciliation has
      // not run yet; after the unlink, no reconciliation finds the child.
      if (binding?.toolUseId !== undefined) {
        await recordChildWorkflowStop({
          reader: input.reader,
          projectionReader: input.projectionReader,
          writer: input.writer,
          parentSessionId: binding.parentSessionId,
          toolUseId: binding.toolUseId,
          childSessionId: input.sessionId,
          workflowDefinitionId: input.session.workflowDefinitionId,
          stoppedBy: "person",
        })
        const { deliverNotification } = input
        await reconcileChildSessionCompletions({
          parentSessionId: binding.parentSessionId,
          reader: input.reader,
          projectionReader: input.projectionReader,
          writer: input.writer,
          ...(deliverNotification ? { deliverNotification: (notification) => deliverNotification(binding.parentSessionId, notification) } : {}),
        })
      }
      await input.abort?.(input.sessionId)
    },
  },
  contributions: [
    { domain: "workflowRuns", id: "runs", value: {
      protocolServices: workflowProtocolServices, cut: workflowCutAppend, deleted: workflowIsDeleted, settles: workflowSettlement,
      hasExecutionAfter: (facts, position) => facts.some(fact => isWorkflowExecutionFact(fact) && fact.position > position),
      state: workflowWorkState, work: workflowWorkControl, deletion: workflowDeletion, settleDeletion: settleWorkflowDeletion, accounting: workflowAccounting, placements: createWorkflowPlacements, hosts: createWorkflowHosts, settings: createWorkflowSettingsReader, create: createWorkflowRunReader, writer: createWorkflowRunWriter, registration: workflowRegistration, startedAttempt: startedWorkflowAttempt, agentTitle: readWorkflowAgentSessionTitle, adoption: workflowAdoption,
      roleChanges: (facts) => [...new Set(facts.filter((fact) => fact.type === "workflow.run.settings.updated").map((fact) => fact.aggregateId.slice("workflow:".length)))],
    } },
    { domain: "questionDecisions", id: "workflow-launch", value: {
      tool: "workflow",
      create: ({ modules }) => {
        const runtime = modules.get(workflowsRuntime)?.deps()
        return runtime?.mode === "ask" ? { workflowLaunch: runtime.resolveLaunchTarget } : {}
      },
    } },
    { domain: "tools", id: "workflow", value: { kind: "tool", name: "workflow", declaration: workflow } },
    { domain: "tools", id: "models", value: { kind: "tool", name: "models", declaration: models } },
    { domain: "promptFragments", id: "workflow-orchestration", value: { order: 2, render: (input) => orchestrates(input) ? orchestrationSection(input.capabilities) : undefined } },
    { domain: "turnReminders", id: "workflow-orchestration", value: { ...ORCHESTRATION_REMINDER, holds: orchestrates } },
    { domain: "definitions", id: "workflows", value: { kind: "workflows" } },
    // The workflow-authoring method writes files that only the workflow tool runs (ARCH-STRUCTURE-031).
    { domain: "definitions", id: "workflows-bundle", value: { kind: "bundle", root: fileURLToPath(new URL("workflows/definitions", import.meta.url)) } },
    { domain: "settings", id: "workflows", value: { control: "workflow-mode", label: "Workflows", description: "Allow agents to launch workflows" } },
    { domain: "cli", id: "workflow", value: workflowNoun },
  ],
  observers: [workflowBudgetObserver, workflowContextPressureObserver],
  transformers: [],
  gates: [],
} as const satisfies FirstPartyModule
