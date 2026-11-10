import { subagentTasks } from "./subagents/agent-tasks.js"
import { renderSubagentRoster } from "./subagents/execution/prompts.js"
import { scopedAgentRegistry } from "./subagents/execution/dispatch-configuration.js"
import { readChildExecutionMetrics } from "./subagents/history/efficiency.js"
import { SubagentRunFactSchemas, parseSubagentRunFact } from "./subagents/facts.js"
import { migrateSubagentPromptTaskInstructions } from "./subagents/migrations/subagent-prompt.js"
import { createSubagentToolSummaryReader } from "./subagents/history/tool-summary.js"
import { holdSubagentParentRuns, readSubagentParentReconciliationRuns } from "./subagents/history/subagent-history.js"
// oxlint-disable-next-line import/no-cycle -- retained history recovery is installed with the module descriptor.
import { recoverStaleSubagentRuns } from "./subagents/history/subagent-run-recovery.js"
import type { ModuleRuntimeServices } from "../agent-runtime/module-runtime-services.js"
import type { ServingModel } from "../agent-runtime/tools/kernel-tool-deps.js"
import { createSubagentTool, createSubagentResume, subagentToolDefinition, subagentToolWith } from "./subagents/tool.js"
import type { SubagentDispatchDeps } from "./subagents/execution/dispatch-deps.js"
import { deliverSessionInput } from "../session/session-input-delivery.js"
import { createSubagentContinuationService, subagentContinuationService } from "./subagents/execution/continuation-service.js"
import { subagentsRuntime, type SubagentsRuntime } from "./subagents/execution/runtime-binding.js"
// oxlint-disable-next-line import/no-cycle -- the descriptor constructs its own child-session authority.
import { createSubagentSessionAuthority } from "./subagents/execution/session-authority.js"
import { settleDeletedSubagent } from "./subagents/execution/direct-child-control.js"
import { subagentChildSession } from "./subagents/execution/child-session.js"
import { buildSubagentCompleted, buildSubagentResumed } from "./subagents/history/subagent-run-fact-writers.js"
import { loadSubagentRunsFromEvents, readSubagentRuns, SUBAGENT_RUN_FACT_TYPES } from "./subagents/history/subagent-run-projection.js"
import { prepareSessionFactAppend } from "../session/session-fact-writer.js"
import type { ToolDeclaration } from "../agent-runtime/tools/tool-registry.js"
import type { RoleResolver } from "../config/roles.js"
import type { ModuleId, FirstPartyModule, FirstPartyModuleComposition } from "../modules.js"
import { moduleProtocol, type ModuleProtocolRuntime, type ModuleProtocolServices } from "../app-service/module-protocol-host.js"
import { subagentsProtocol } from "../../protocol/modules/subagents.js"
import type { DefinitionAvailabilitySnapshot } from "../app-service/definition-availability.js"
import { availableToolNames } from "../agent-runtime/persona-tool-rules.js"
import type { AgentDefinition } from "../../infra/agent-definition.js"
import type { CapabilityCheck } from "../../infra/capability-text.js"
import { disabledTypesOf, subagentsConfigSection } from "./subagents/config.js"

const EMPTY_ROLE_RESOLVER: RoleResolver = async () => new Map()

function createSubagentsProtocol(services: ModuleProtocolServices): ModuleProtocolRuntime<typeof subagentsProtocol> {
  /** Explicit child continuation attaches the parent host without starting its turn. */
  const resume = async (sessionId: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> => {
    if (!services.enabled()) return { ok: false as const, error: "Subagents are disabled" }
    const continuation = services.modules.get(subagentContinuationService)
    if (!continuation) return { ok: false as const, error: "Subagent execution is unavailable" }
    const result = await continuation.resume(sessionId)
    return result.outcome === "ok" ? { ok: true as const } : { ok: false as const, error: result.content }
  }
  return {
    serve: {},
    mutate: {
      // A person's Interrupt of a child is the one Interrupt of every
      // session: it cuts the child at once and settles its run as
      // interrupted by a person; the saved run status keeps its `paused`
      // name.
      async "subagent.interrupt"(mutation) {
        if (!services.enabled()) return { ok: false as const, error: "Subagents are disabled" }
        const interrupted = await services.interruptSession(mutation.sessionId)
        return interrupted ? { ok: true as const } : { ok: false as const, error: "Subagent is not running" }
      },
      "subagent.resume": (mutation) => resume(mutation.sessionId),
    },
    send: {
      kind: "subagent",
      // A person's message to a subagent. A child that an interrupt or an
      // unexpected exit left waiting holds the message and starts again with
      // it, as a message to an interrupted chat or workflow does (D19).
      async send(sessionId, input) {
        if (!services.enabled()) return { ok: false as const, error: "Subagents are disabled" }
        if (!services.manager || !services.eventWriter) return { ok: false as const, error: "Subagent control is unavailable" }
        const child = await services.manager.read(sessionId)
        if (child?.kind !== "subagent") return { ok: false as const, error: "Subagent session was not found" }
        const outcome = await deliverSessionInput({
          manager: services.manager,
          projectionReader: services.eventStore,
          eventWriter: services.eventWriter,
        }, sessionId, input)
        if (outcome.status === "refused") return { ok: false as const,
          ...(outcome.reason === "handing_off" ? { kind: "handing_off" as const } : {}),
          error: outcome.reason === "handing_off" ? "This agent has started its handoff and cannot read another message. Your draft was kept." : outcome.reason === "settled" ? "This subagent has ended, so it reads no more messages." : "Subagent session was not found" }
        // A receipt confirms a message the child holds already, and the
        // child's transcript retires the sender's copy when it shows it.
        const receipt = outcome.confirmedSubmissionIds ? { confirmedSubmissionIds: outcome.confirmedSubmissionIds, inTranscript: outcome.status === "delivered" ? outcome.inTranscript ?? true : true } : {}
        if (outcome.status !== "held" || outcome.reason !== "interrupted") return { ok: true as const, ...receipt }
        // A copy sent again also starts the child that its first copy did
        // not start, such as when the runtime stopped before that start.
        const resumed = await resume(sessionId)
        return resumed.ok ? { ...resumed, ...receipt } : { ok: false as const, error: `${resumed.error} Your message is kept, and the subagent reads it when it resumes.` }
      },
    },
    dispose() {},
  }
}

/** The agent types the roster names, from the tree check and the tree's
 *  capture so every agent of the tree reads the same roster: each available
 *  one, a persona with only the declared tools the capture can serve. */
function rosterAgents(agents: ReadonlyMap<string, AgentDefinition>, has: CapabilityCheck, capture: FirstPartyModuleComposition): ReadonlyMap<string, AgentDefinition> {
  return new Map([...agents].flatMap(([name, agent]) => has(`persona:${name}`)
    ? [[name, agent.kind === "persona" ? { ...agent, tools: availableToolNames(agent.tools, capture) } : agent] as const]
    : []))
}

/** Capabilities a child dispatch requires: this module and its dependencies. */
function subagentModuleRequirements(): readonly ModuleId[] {
  return [subagentsModule.id, ...subagentsModule.dependencies]
}

/** Dispatching a subagent starts work that outlives this turn, so it takes a
 *  host that owns it. No owner, no dispatch surface. */
function createSubagentsRuntime(services: ModuleRuntimeServices): SubagentsRuntime | undefined {
  const owner = services.dispatchOwner
  const subagentSessions = services.subagentSessions
  if (!owner || !subagentSessions || !services.sessionId || !services.conversation.aggregateId) return undefined
  const { sessionId, usageProfile, purpose } = services
  const conversationId = services.conversation.aggregateId
  const toolDeps = (serving: ServingModel, definitionAvailability: DefinitionAvailabilitySnapshot): SubagentDispatchDeps => ({
      userDataRoot: services.userDataRoot,
      accountHome: services.accountHome,
      agentRegistry: services.personas,
      capabilityRequirements: subagentModuleRequirements(),
      skills: services.boundSkills ?? services.definitions.skills(),
      definitionAvailability,
      createRunner: services.createRunner,
      planChildCapabilities: services.planChildCapabilities,
      modelFamily: serving.modelFamily,
      availableModels: services.availableModels?.get(serving.modelFamily) ?? serving.availableModels,
      parentModel: serving.model,
      parentEffort: serving.effort,
      parentProviderOptions: serving.providerOptions,
      parentPromptKind: services.promptKind,
      resolveRoles: services.resolveRoles ?? EMPTY_ROLE_RESOLVER,
      briefScope: purpose.kind === "workflow-agent" ? purpose.briefScope : undefined,
      allowedSubagentTypes: services.allowedSubagentTypes,
      onRenderEvent: services.onBackgroundEvent ?? services.onEvent,
      onChildRenderEvent: services.onChildEvent ?? ((_childSessionId, event) => (services.onBackgroundEvent ?? services.onEvent)(event)),
      waitForEventCapacity: services.waitForEventCapacity,
      backgroundTasks: owner.tasks,
      deliverParentNotification: async (_parentSessionId, notice) => {
        owner.tasks.deliverDurableSubagentNotification(notice)
        return true
      },
      childSlots: services.childSlots,
      subagentSessions,
      sessionDir: services.sessionDir,
      providerSessionKey: services.conversation.providerSessionKey,
      sessionId,
      sessionEventWriter: services.sessionEventWriter,
      ...(usageProfile ? { usageProfile } : {}),
      authProfileId: services.activeProfileId ?? usageProfile?.profileId ?? "default",
      ...(services.conversation.awaitDurableFacts ? { awaitDurableFacts: services.conversation.awaitDurableFacts } : {}),
      ...(services.auditObserver ? { auditObserver: services.auditObserver } : {}),
      ...(services.usageObserver ? { usageObserver: services.usageObserver } : {}),
      applyNestedStoredFact: services.applyNestedStoredFact,
      ...(services.sessionEventStore ? { sessionEventStore: services.sessionEventStore } : {}),
      ...(services.projectionReader ? { sessionEventReader: services.projectionReader } : {}),
      captureRuntimeConfig: services.captureRuntimeConfig,
      captureProviderConnection: services.captureProviderConnection,
      awaitModelAccessSettled: services.awaitModelAccessSettled,
      moduleSelection: services.moduleSelection,
      inheritableRuntimeSurfaces: services.inheritableRuntimeSurfaces,
  })
  return {
    conversationId,
    // A Resume reopens the recorded run, so the current selection's
    // availability is read only to complete its dependencies.
    // The availability owner imports the module catalog, which installs this
    // descriptor, so a Resume loads it on demand.
    resume: async (childSessionId, admission) => {
      // Only a running host's runtime is reachable for a Resume, and a capability plan registers with no host.
      if (!services.servingModel) throw new Error("A capability plan has no serving model to resume a child on.")
      const { definitionAvailabilityOf } = await import("../app-service/definition-availability.js")
      const availability = definitionAvailabilityOf(services.definitions.captureRevision(), services.moduleSelection().enabledModuleIds, disabledTypesOf(services.captureRuntimeConfig().moduleSections))
      return createSubagentResume({ ...toolDeps(services.servingModel, availability), ...admission })(childSessionId, {
        executionCwd: services.executionCwd, projectRoot: services.projectRoot,
        artifactScopeId: services.conversation.artifactScopeId, conversationId, signal: owner.signal,
        capabilityAccess: services.capabilityAccess,
      })
    },
    toolDeps,
  }
}

const subagent = {
  category: "opt-in",
  action: "task_subagent",
  cloneInheritance: "reconstruct",
  learningReviewExecutable: false,
  semanticBundle: null,
  personaBaseline: false,
  registryOrder: 17,
  registrations: {
    subagent: {
      capabilities: ["subagents"],
      create: ({ kernel, modules }) => {
        // While the tree's capture turns every agent type off, the tree has nothing to dispatch, so it plans no
        // dispatch tool, as with this module off (PI-CAP-023). The tree's capture decides, so every agent of the tree
        // plans the same tools (ARCH-CONTEXT-018).
        if (kernel.definitionAvailability.tree.availablePersonas.size === 0) return { reason: "every agent type is turned off in subagents.disabled_types" }
        const runtime = modules.get(subagentsRuntime)
        if (!runtime) return { unusable: { tool: subagentToolDefinition(kernel.treeCapabilities), reason: "no subagent registry available" } }
        // A capability plan (`planRunCapabilities`) reads only whether the tool is usable and calls nothing.
        if (!kernel.servingModel) return { tool: subagentToolWith(() => Promise.reject(new Error("A capability plan runs no tool.")), kernel.treeCapabilities) }
        return { tool: createSubagentTool(runtime.toolDeps(kernel.servingModel, kernel.definitionAvailability.live), kernel.treeCapabilities) }
      },
    },
  },
} as const satisfies ToolDeclaration<"subagents">


export const subagentsModule = {
  id: "subagents",
  dependencies: [],
  availability: { kind: "available" },
  protocol: moduleProtocol({ contract: subagentsProtocol, create: createSubagentsProtocol }),
  producesBackgroundWork: true,
  runtime: { handle: subagentsRuntime, create: createSubagentsRuntime },
  service: { handle: subagentContinuationService, create: createSubagentContinuationService },
  facts: { prefixes: ["child_run.", "subagent."], sessionSchemas: () => SubagentRunFactSchemas },
  sessionAdmission: {
    affectedSessions: (fact) => SUBAGENT_RUN_FACT_TYPES.some((type) => type === fact.type) ? [fact.sessionId] : [],
  },
  workspaceMigrations: [
    { phase: "stored-facts", order: 90, label: "subagent prompts", run: ({ dbFile }) => { migrateSubagentPromptTaskInstructions(dbFile) } },
  ],
  sessionHistory: {
    createToolSummaryReader: createSubagentToolSummaryReader,
    recover: async (input) => { await recoverStaleSubagentRuns(input) },
  },
  // A Stop of a subagent ends its run whatever its lifecycle: a live run
  // through its control, a waiting one by its recorded completion. The
  // parent agent's Resume continues it unless a person made its latest cut.
  childSession: subagentChildSession,
  // Deleting a child stops it as a person's Stop does, before the kernel
  // unlinks and deletes it.
  sessionDeletion: {
    kind: "subagent",
    settle: async ({ sessionId, session, reader, projectionReader, writer, projectRoot, deliverNotification }) => {
      if (session.kind !== "subagent") throw new Error("Subagent deletion requires subagent metadata")
      await settleDeletedSubagent({
        eventStore: reader, projectionReader, writer, projectRoot, deliverNotification,
        childSessionId: sessionId, parentSessionId: session.launchedFrom.parentSessionId, conversationId: session.conversationId,
      })
    },
  },
  childSessionHistory: {
    readAgentType: async (reader, sessionId) => (await readSubagentRuns(reader, sessionId)).at(-1)?.agentType,
    prepareOwnershipRecovery: (sessionId, input) => prepareSessionFactAppend(sessionId, parseSubagentRunFact({
      type: "child_run.ownership.recovered", version: 1, actor: "flywheel", payload: input,
    })),
    factTypes: SUBAGENT_RUN_FACT_TYPES,
    loadRuns: (events) => loadSubagentRunsFromEvents(events).map(({ parentToolCallId, toolUseId, ...run }) => ({
      ...run,
      ...((parentToolCallId ?? toolUseId) ? { parentToolUseId: parentToolCallId ?? toolUseId } : {}),
    })),
    readRuns: async (reader, sessionId) => (await readSubagentRuns(reader, sessionId)).map(({ parentToolCallId, toolUseId, ...run }) => ({
      ...run,
      ...((parentToolCallId ?? toolUseId) ? { parentToolUseId: parentToolCallId ?? toolUseId } : {}),
    })),
    readParentReconciliationRuns: async (reader, parentSessionId, children) => new Map([...await readSubagentParentReconciliationRuns(reader, parentSessionId, children)].map(([childSessionId, { runs, latestRunId }]) => [childSessionId, {
      latestRunId,
      runs: runs.map(({ parentToolCallId, toolUseId, ...run }) => ({
        ...run,
        ...((parentToolCallId ?? toolUseId) ? { parentToolUseId: parentToolCallId ?? toolUseId } : {}),
      })),
    }])),
    holdParentReconciliationRuns: holdSubagentParentRuns,
    prepareCompleted: (sessionId, input) => prepareSessionFactAppend(sessionId, buildSubagentCompleted(input)),
    prepareResumed: (sessionId, input) => prepareSessionFactAppend(sessionId, buildSubagentResumed(input)),
    createAuthority: createSubagentSessionAuthority,
  },
  retainedDiagnostics: { children: readChildExecutionMetrics },
  contributions: [
    { domain: "agentTasks", id: "subagent", value: subagentTasks },
    { domain: "tools", id: "subagent", value: { kind: "tool", name: "subagent", declaration: subagent } },
    // The subagent catalog varies with the dispatcher's grant, so it renders in the
    // session tier and the dispatch tool's bytes stay shared (ARCH-CONTEXT-018).
    { domain: "promptFragments", id: "subagent-roster", value: {
      order: 0,
      render: ({ kernel, tools, capabilities }) => tools.has("subagent")
        ? renderSubagentRoster(rosterAgents(scopedAgentRegistry(kernel.personas ?? new Map(), kernel.allowedSubagentTypes), capabilities, kernel.moduleSnapshot), capabilities)
        : undefined,
    } },
    { domain: "definitions", id: "subagents", value: { kind: "subagents", roles: true, retainInstalled: true, disabledTypes: disabledTypesOf } },
    { domain: "config", id: subagentsConfigSection.key, value: subagentsConfigSection },
    { domain: "settings", id: "subagents", value: { control: "binary", label: "Subagents", description: "Allow agents to delegate focused work" } },
  ],
  observers: [],
  transformers: [],
  gates: [],
} as const satisfies FirstPartyModule
