import { mock } from "bun:test"
import type { WorkflowHosts } from "../../../../src/orchestration/workflow-host/host-collection.js"
import type { WorkflowRunner } from "../../../../src/orchestration/workflow-host/runner-types.js"
import type { WorkflowControllerDeps } from "../../../../src/orchestration/workflow-host/lifecycle/controller.js"
import type { WorkflowDefinition } from "../../../../src/workflows/schema/workflow-schema.js"
import type { WorkflowProposalEvent } from "../../../../src/workflows/control-facts/events.js"
import type { CommittedWorkflowControl } from "../../../../src/workflows/control-facts/committed-control.js"
import { recoverWorkflowControl } from "../../../../src/workflows/vm/recovery/recovery.js"
import { replayDecodedWorkflow, transitionDecodedWorkflow } from "../../../../src/workflows/vm/control/transition.js"
import { composeWorkflowCompanions } from "../../../../src/workflows/vm/control/companions.js"
import { loadQueueSnapshotFromReader } from "../../../../src/workflows/vm/recovery/workflow-view.js"
import { resolveWorkflowAgents } from "../../../../src/workflows/definitions/agent-resolution.js"
import { createSessionManager } from "../../../../src/orchestration/session/manager.js"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncEventStateReadSurface, type AsyncEventWriter } from "../../../../src/infra/store/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../../src/infra/store/sqlite-event-store.js"
import { authoredGuardrailLimits, compileWorkflowControl } from "../../../../src/workflows/vm/compile/compile.js"
import { flattenWorkflowView } from "../../../../src/workflows/vm/view/view-flatten.js"
import { buildWorkflowControlInitializedFact } from "../../../../src/workflows/control-facts/family.js"
import { buildContextInputSeededFact } from "../../../../src/workflows/context-bundle/context-facts.js"
import { queueFactsForState } from "../../../../src/workflows/view/view-diff.js"
import { workflowMembershipReader } from "../../../../src/orchestration/session/metadata/workflow-membership.js"
import { repoDefinitions } from "../../../helpers/project-definitions.js"
import { loadedWorkflow } from "../../../helpers/workflow-files.js"

/** Admits one callback test's attempt without bypassing member publication. */
export async function publishWorkerAttempt(input: {
  projectRoot: string; reader: AsyncEventStateReadSurface; writer: AsyncEventWriter;
  workflowId: string; attemptId: string; conversationId: string; definitionId?: string;
  siblings?: readonly { readonly attemptId: string; readonly conversationId: string }[];
  /** How often a sibling's failed handoff tries again. */
  retry?: { readonly max: number; readonly stuck: boolean };
}) {
  const manager = createSessionManager({ projectRoot: input.projectRoot, executionCwd: input.projectRoot, projectionReader: input.reader, writer: input.writer })
  const workflow = loadedWorkflow({
    id: "worker-fixture", name: "Worker fixture",
    // A wide fan-out runs past the default attempt limit of 50.
    ...(input.siblings && input.siblings.length >= 50 ? { guardrails: { max_attempts: 4096 } } : {}),
    phases: input.siblings
      ? [{ phase: "work", agents: [input, ...input.siblings].map((_, index) => ({ agent: `work-${index}`, brief: "Do the work.", name: "Work", ...(input.retry ? { retry: input.retry } : {}) })) }]
      : [{ phase: input.definitionId ?? "work", brief: "Do the work.", name: "Work" }],
  })
  const existing = await workflowMembershipReader(input.reader).attempt(input.workflowId, input.attemptId)
  if (existing) return { manager, member: existing, workflow }
  const agents = resolvedAgentsOf(workflow)
  const compiled = compileWorkflowControl(workflow, agents, { skills: repoDefinitions().skills() }, authoredGuardrailLimits(workflow))
  const bindings = [input, ...input.siblings ?? []]
  const control = { ...compiled, attempts: compiled.attempts.map((attempt, index) => ({ ...attempt, id: bindings[index]!.attemptId })) }
  const queue = queueFactsForState(null, flattenWorkflowView(control, agents))
  const parentId = await manager.createChat({ name: "Parent" })
  const parent = await manager.read(parentId)
  if (parent?.kind !== "chat") throw new Error("Expected launching chat")
  await manager.publishWorkflow({
    id: input.workflowId, description: "Worker fixture", workflowDefinitionId: workflow.id,
    initialRoles: { "workflow-agent": { model: "gpt-5.4", effort: "medium" } },
    launchedFrom: { parentSessionId: parentId, conversationId: parent.conversationId, toolUseId: "worker-launch" },
    facts: [buildWorkflowControlInitializedFact({ ...control, aggregateSeq: queue.length + 1 }), buildContextInputSeededFact(workflow.id, "Worker fixture"), ...queue],
  })
  const deps = { manager, projectionReader: input.reader }
  // Each start transitions the control the previous commit proposed, so a
  // wide fan-out does not recover the whole aggregate once for each agent.
  let committed = await commitWorkflowEvent(deps, input.workflowId, workflow, { type: "START" })
  for (const binding of bindings) committed = await commitWorkflowEvent(deps, input.workflowId, workflow, { type: "ATTEMPT_STARTED", attemptId: binding.attemptId, conversationId: binding.conversationId }, committed)
  const member = await workflowMembershipReader(input.reader).attempt(input.workflowId, input.attemptId)
  if (!member) throw new Error("Expected committed workflow member")
  return { manager, member, workflow }
}

/** Opens a store in `dir`, publishes `wf-0` with the default profile, then
 *  registers `wf-<n>` for each later entry of `profileIds` from wf-0's
 *  registration. The caller closes the store. */
export async function seedWorkflowRuns(dir: string, profileIds: readonly string[]) {
  const store = createSqliteEventStore(resolveEventStoreDbFile(dir))
  const base = asAsyncEventReadSurface(store)
  const { manager, workflow } = await publishWorkerAttempt({ projectRoot: dir, reader: base, writer: asAsyncEventWriter(store), workflowId: "wf-0", attemptId: "a", conversationId: "conv-0" })
  const [registration] = (await base.readSlice({ aggregateId: "workflow:wf-0", types: ["workflow.run.registered"] })).facts
  if (!registration || registration instanceof Error) throw new Error("the published workflow has no registration")
  const { type, version, actor, payload } = registration
  if (typeof payload !== "object" || payload === null || !("settings" in payload) || typeof payload.settings !== "object") throw new Error("the registration has no settings")
  for (let index = 1; index < profileIds.length; index++) {
    store.append({ type, version, actor, payload: { ...payload, settings: { ...payload.settings, authProfileId: profileIds[index] } }, aggregateId: `workflow:wf-${index}`, sessionId: `wf-${index}`, timestamp: 10 })
  }
  return { store, base, manager, workflow }
}

const resolvedAgents = new WeakMap<WorkflowDefinition, ReturnType<typeof resolveWorkflowAgents>>()
/** The agents of `workflow`, resolved once: resolving loads every agent's
 *  brief, so a wide fan-out that resolved them for each start would load
 *  its briefs once for each agent. */
function resolvedAgentsOf(workflow: WorkflowDefinition): ReturnType<typeof resolveWorkflowAgents> {
  let agents = resolvedAgents.get(workflow)
  if (!agents) resolvedAgents.set(workflow, agents = resolveWorkflowAgents(workflow))
  return agents
}

/** Publishes a VM proposal and its member through the structural owner, and
 *  returns the control it committed. `from` is the control that the previous
 *  commit returned; without it, the commit recovers the stored control. */
export async function commitWorkflowEvent(deps: Pick<WorkflowControllerDeps, "manager" | "projectionReader">, workflowId: string, workflow: WorkflowDefinition, event: WorkflowProposalEvent, from?: CommittedWorkflowControl): Promise<CommittedWorkflowControl> {
  const recovered = from ? { executable: true as const, control: from } : recoverWorkflowControl((await deps.projectionReader.readSlice({ aggregateId: `workflow:${workflowId}` }, true)).facts)
  if (!recovered.executable) throw new Error("Expected complete workflow control")
  const result = composeWorkflowCompanions(transitionDecodedWorkflow(replayDecodedWorkflow(recovered.control), event), {
    queue: await loadQueueSnapshotFromReader(deps.projectionReader, workflowId),
    resolvedAgents: resolvedAgentsOf(workflow), timestamp: 10, addenda: [],
  })
  if (result.command.kind !== "commit") throw new Error(`Expected proposal for ${event.type}`)
  const proposal = result.command.proposal
  const committed = await deps.manager.commitWorkflow({
    workflowId,
    events: proposal.facts.map((fact, index) => ({
      ...fact, aggregateId: `workflow:${workflowId}`, sessionId: workflowId, timestamp: 10,
      ...(index === 0 ? { expectedSeq: proposal.expectedSeq } : {}),
    })),
  })
  if (committed.kind !== "stored") throw new Error(`Workflow proposal conflicted: ${JSON.stringify(committed)}`)
  const pending = result.state.context.pending
  if (!pending) throw new Error(`Expected a pending proposal for ${event.type}`)
  return pending.proposedCommitted
}

/** Captures host admission without constructing a provider-backed runner. */
export function createMockWorkflowHosts() {
  const runners = new Map<string, WorkflowRunner>()
  const starts: Parameters<WorkflowHosts["start"]>[0][] = []
  const aborts: string[] = []
  const hosts: WorkflowHosts = {
    onChange: () => () => {},
    start: mock(async (options) => {
      await options.onDefinitionAccepted?.()
      starts.push(options)
      runners.set(options.sessionId, {
        sessionId: options.sessionId, abort: async () => {}, dispose: async () => {},
        resume: async () => false, continueCapacity: () => new Set(), interrupt: async () => false,
        cut: async () => undefined, interruption: () => undefined,
        handBack: async () => ({ kind: "not_parked" }),
        continueHeldMessages: async () => {}, prepare: async () => null,
        run: async () => ({ completed: false, attemptsCompleted: 0, attemptsTotal: 0, cost: 0, tokens: 0 }),
        readQueue: async () => { throw new Error("No mock queue") },
        interruptForReplacement: async () => false,
        interruptPlannedCut: async () => "ended",
        stepModuleRuntimes: async () => undefined, stepBackgroundTasks: () => undefined,
        releaseForegroundBash: () => false, transferForegroundForReplacement: async () => {},
        terminateBackgroundWork: () => {}, applyProjectionEvent: () => {},
        recallQueuedMessage: async () => null, compact: async () => false,
      })
      return options.sessionId
    }),
    get: (id) => runners.get(id),
    allIds: () => [...runners.keys()],
    isRunning: (id) => runners.has(id),
    whenClosed: async () => {},
    abort: mock(async (id, by) => { aborts.push(id); await runners.get(id)?.abort(by); return runners.has(id) }),
    remove: async (id) => { runners.delete(id) },
    refreshDeps: async () => {},
    disposeAll: async () => { runners.clear() },
  }
  return { ...hosts, _runners: runners, _startCalls: starts, _abortCalls: aborts }
}
