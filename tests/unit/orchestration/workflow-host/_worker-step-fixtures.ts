import { Schema } from "effect"
import { createEmit, EventBus, type EmitFn } from "../../../../src/infra/event-bus"
import type { AgentDefinition } from "../../../../src/infra/agent-definition"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import type { CommandHandoverAuthority } from "../../../../src/orchestration/agent-runtime/command-handover"
import type { ActiveBackgroundCommandDescriptor } from "../../../../src/orchestration/agent-runtime/background-work"
import type { AgentFactory } from "../../../../src/orchestration/agent-runtime/types"
import type { ResolvedRoles } from "../../../../src/orchestration/config/roles"
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js"
import { createSessionManager } from "../../../../src/orchestration/session/manager"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer"
import { createWorkerCallback } from "../../../../src/orchestration/workflow-host/agent-callback"
import { resolveWorkflowAgents, type ResolvedAgent } from "../../../../src/workflows/agent-resolution"
import type { AttemptRow } from "../../../../src/workflows/view/types"
import { WorkflowDefinitionSchema } from "../../../../src/workflows/workflow-schema"
import { planEveryCapability } from "../../../helpers/attempt-brief"
import { testAuthContext } from "../../../helpers/auth-context"
import { testDirectories } from "../../../helpers/directories"
import { fixedAvailability, repoDefinitions } from "../../../helpers/project-definitions"
import { workflowAgentInputs } from "../../../helpers/workflow-agent-inputs"
import { publishWorkerAttempt } from "./_workflow-host-fixtures"
import { makeWorkflowDeps } from "./_workflow-controller-fixtures"

export const WORKFLOW = "workflow-1"
export const CONVERSATION = "agent-step-1"
export const STEP: AttemptRow = { id: "step-1", definitionId: "work", workflowDefinitionId: "wf", name: "Work", briefId: "work", status: "running", writes: [], resumeRevertCount: 0 }

/** A project store in `dir` whose workflow has admitted `STEP` in `CONVERSATION`, with the step's session. */
export async function publishStep(dir: string) {
  const store = createSqliteEventStore(resolveEventStoreDbFile(dir))
  const published = await publishWorkerAttempt({ projectRoot: dir, reader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store), workflowId: WORKFLOW, attemptId: STEP.id, conversationId: CONVERSATION })
  return { store, sessionId: published.member.sessionId, manager: published.manager }
}

/** A member worker built with the executor's command handover. */
export function handoverWorker(dir: string, createAgent: AgentFactory, commandHandover: CommandHandoverAuthority, emit: EmitFn = createEmit(new EventBus()), inputs = workflowAgentInputs(commandHandover.projectionReader, WORKFLOW), resolvedAgents: ReadonlyMap<string, ResolvedAgent> = resolveWorkflowAgents(Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
  id: "wf", name: "Workflow", phases: [{ phase: "work", brief: "Do the work.", name: "Work" }],
})), personas: ReadonlyMap<string, AgentDefinition> = new Map(), onBackgroundCommandsChanged?: (commands: readonly ActiveBackgroundCommandDescriptor[]) => void, workflowId = WORKFLOW, overrides: Partial<Pick<Parameters<typeof createWorkerCallback>[0], "attachChildProjection" | "planCapabilities" | "capabilityAccess">> = {}) {
  const { accountHome, userDataRoot } = testDirectories(dir)
  const manager = createSessionManager({ projectRoot: dir, executionCwd: dir, projectionReader: commandHandover.projectionReader, writer: commandHandover.writer })
  return createWorkerCallback({
    ...makeWorkflowDeps(),
    createAgent,
    createLLMClient: () => { throw new Error("no step here creates a client of its own") },
    captureProviderConnection: makeWorkflowDeps().captureProviderConnection,
    auth: testAuthContext(),
    proactiveCompactionThreshold: () => 270_000,
    resolveRoles: async (): Promise<ResolvedRoles> => new Map([["workflow-agent", { roleId: "workflow-agent", model: "test-model", effort: "high" }]]),
    emit,
    sessionId: workflowId,
    projectRoot: dir,
    userDataRoot,
    accountHome,
    executionCwd: dir,
    moduleSelection: composeFirstPartyModules(),
    agentInputs: inputs.agentInputs,
    deactivateSession: id => manager.updateLifecycleState(id, "inactive"),
    sessionEventWriter: createSessionFactWriter({ sessionId: workflowId, writer: commandHandover.writer }),
    attachChildProjection: async input => ({
      onEvent: event => emit(event.type, { sessionId: input.sessionId, data: event.data }),
      lifecycle: {}, queueUserMessage() {}, updateMetrics() {}, updateBackgroundCommands: commands => onBackgroundCommandsChanged?.(commands), updateForegroundBash() {}, updateOperations() {}, dispose: async () => {},
    }),
    skills: repoDefinitions().skills(),
    availability: () => fixedAvailability({ personas }),
    planCapabilities: planEveryCapability,
    eventStore: commandHandover.reader,
    projectionReader: commandHandover.projectionReader,
    eventWriter: commandHandover.writer,
    recall: async () => ({ hits: [] }),
    commandHandover,
    resolvedAgents,
    ...overrides,
  }).worker
}
