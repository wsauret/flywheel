import { asAsyncEventReadSurface, type AsyncEventWriter, type EventReader, type EventStoreAppend, type GuardedEventStoreAppend, type StoredFact } from "../../../../src/infra/event-store-types.js"
import { inMemoryEventReader } from "../../../helpers/in-memory-event-reader.js"
import { createWorkflowContextStore } from "../../../../src/workflows/context-bundle/context-store.js"
import { buildContextInputSeededFact } from "../../../../src/workflows/context-bundle/context-facts.js"
import { createWorkflowViewStore } from "../../../../src/workflows/view/view-store.js"
import { queueFactsForState } from "../../../../src/workflows/view/view-diff.js"
import type { ResolvedAgent } from "../../../../src/workflows/definitions/agent-resolution.js"
import { testSkill, testSkillRevision } from "../../../helpers/skill-fixtures.js"
import { repoDefinitions } from "../../../helpers/project-definitions.js"
import type { SkillRegistryRevision } from "../../../../src/workflows/skills/skill-schema.js"
import type { ProjectDefinitionRegistryRevision } from "../../../../src/workflows/definitions/definition-registry.js"
import type { WorkflowDefinition } from "../../../../src/workflows/schema/workflow-schema.js"
import { compileWorkflowControl } from "../../../../src/workflows/vm/compile/compile.js"
import { createWorkflowVmHost } from "../../../../src/workflows/vm/host/host.js"
import type { WorkflowVmHostDeps } from "../../../../src/workflows/vm/host/host-types.js"
import { flattenWorkflowView } from "../../../../src/workflows/vm/view/view-flatten.js"
import { buildWorkflowControlInitializedFact, parseWorkflowSessionFact } from "../../../../src/workflows/vm/facts/session-facts.js"
import type { DecodedWorkflowProposalEvent, WorkflowProposalEncoding } from "../../../../src/workflows/vm/facts/events.js"
import { replayWorkflowControl } from "../../../../src/workflows/vm/recovery/fact-fold.js"
import { replayDecodedWorkflow, transitionDecodedWorkflow } from "../../../../src/workflows/vm/control/transition.js"
import { composeWorkflowCompanions } from "../../../../src/workflows/vm/control/companions.js"
import { resolveWorkflowAgents } from "../../../../src/workflows/definitions/agent-resolution.js"
import { loadedWorkflow } from "../../../helpers/workflow-files.js"
import { refusingEventWriter } from "../../../helpers/event-writer-doubles.js"

const workPhase = { phase: "work", brief: "Do the work work.", name: "Work", output: { summary: "Result" }, writes: [{ id: "artifact", lifetime: "transient" }] }

export const workflow = loadedWorkflow({
  id: "host-test",
  name: "Host test",
  phases: [workPhase],
})
const workSkill = testSkill("work", { name: "Work" })
const reviewSkill = testSkill("review", { name: "Review" })

/** The revision every fixture host and compilation is pinned to. */
export const fixtureSkills: SkillRegistryRevision = testSkillRevision([workSkill, reviewSkill])
const fixtureRevision = (skills = fixtureSkills, personas: ProjectDefinitionRegistryRevision["personas"] = new Map()) => {
  const revision = repoDefinitions().captureRevision()
  return Object.freeze({ ...revision, skills, personas })
}
export const definition: ResolvedAgent = requireAgent(resolveWorkflowAgents(workflow), "work")
export const sequentialWorkflow = loadedWorkflow({
  id: "host-sequential",
  name: "Host sequential",
  phases: [workPhase, { phase: "review", brief: "Do the review work.", name: "Review", writes: [] }],
})

function requireAgent(agents: ReadonlyMap<string, ResolvedAgent>, definitionId: string): ResolvedAgent {
  const agent = agents.get(definitionId)
  if (!agent) throw new Error(`Fixture workflow needs agent ${definitionId}`)
  return agent
}

export function createMemoryStore(initial: readonly EventStoreAppend[]): EventReader & AsyncEventWriter & { events: StoredFact[] } {
  const events: StoredFact[] = initial.map((event, index) => stored(event, index, index + 1))
  const reader = inMemoryEventReader(events)
  const appendBatch = async (appends: readonly EventStoreAppend[]): Promise<StoredFact[]> => {
    const aggregate = appends[0]?.aggregateId
    const firstSeq = aggregate ? reader.aggregateSeq(aggregate) + 1 : 0
    const written = appends.map((event, index) => stored(event, firstSeq + index, events.length + index + 1))
    events.push(...written)
    return written
  }
  return {
    ...refusingEventWriter(),
    ...reader,
    events,
    append: async (event) => (await appendBatch([event]))[0] ?? Promise.reject(new Error("append returned no event")),
    appendBatch,
    appendGuarded: async (event) => ({ kind: "stored", events: await appendBatch([event]) }),
    appendBatchGuarded: async (appends: readonly GuardedEventStoreAppend[]) => ({ kind: "stored", events: await appendBatch(appends) }),
    pruneSupersededEvents: async () => 0,
  }
}

function stored(event: GuardedEventStoreAppend, seq: number, position: number): StoredFact {
  const { expectedSeq: _expectedSeq, payloadJson: _serialized, ...persisted } = event
  return { ...persisted, id: `event-${position}`, seq, position }
}

function workflowStores(store: EventReader & AsyncEventWriter) {
  const reader = asAsyncEventReadSurface(store)
  return {
    queueStore: createWorkflowViewStore({ sessionId: "session", reader }),
    contextStore: createWorkflowContextStore({ sessionId: "session", reader }),
  }
}

/** The facts a launch of one workflow commits, resolved against `skills`. */
export function initialFacts(
  selectedWorkflow: WorkflowDefinition = workflow,
  skills: SkillRegistryRevision = fixtureSkills,
): EventStoreAppend[] {
  const resolved = resolveWorkflowAgents(selectedWorkflow)
  const control = compileWorkflowControl(selectedWorkflow, resolved, { skills })
  const queueFacts = queueFactsForState(null, flattenWorkflowView(control, resolved))
  const facts = [
    buildWorkflowControlInitializedFact({ ...control, aggregateSeq: 1 + queueFacts.length }),
    buildContextInputSeededFact(selectedWorkflow.id, "Host test canonical request"),
    ...queueFacts,
  ].map(parseWorkflowSessionFact)
  return facts.map((fact, index) => ({
    aggregateId: "workflow:session",
    sessionId: "session",
    timestamp: 10,
    type: fact.type,
    version: fact.version,
    actor: fact.actor,
    payload: fact.payload,
    ...(index === 0 ? { expectedSeq: 0 } : {}),
  }))
}

/** The host deps that a test host does not exercise: commits append to
 *  `writer` alone, every attempt may start, no message is addressed, and
 *  disposal releases nothing. */
export function quietHostDeps(writer: AsyncEventWriter): Pick<WorkflowVmHostDeps, "commitBatch" | "conversationId" | "preAttemptPolicy" | "addressedMessages" | "onPostPreflight" | "lifecycle"> {
  return {
    commitBatch: (events) => writer.appendBatchGuarded(events),
    conversationId: () => `agent-${crypto.randomUUID()}`,
    preAttemptPolicy: () => null,
    addressedMessages: { read: async () => [], retire: async () => {} },
    onPostPreflight: () => {},
    lifecycle: { settleBackground: () => {}, drainEventBus: () => {}, drainWriter: () => {}, disposeProjections: () => {}, disposeRemaining: () => {} },
  }
}

type TestHostOverrides = Partial<WorkflowVmHostDeps> & {
  readonly workflow?: WorkflowDefinition
  readonly skills?: SkillRegistryRevision
  readonly personas?: ReadonlyMap<string, import("../../../../src/infra/agent-definition.js").AgentDefinition>
}

export function testHost(
  store: EventReader & AsyncEventWriter,
  overrides: TestHostOverrides = {},
): ReturnType<typeof createWorkflowVmHost> {
  return createWorkflowVmHost(testHostDeps(store, overrides))
}

/** The deps of a test host over `store`: one session that launches the
 *  fixture workflow, whose attempts the test supplies. */
export function testHostDeps(
  store: EventReader & AsyncEventWriter,
  overrides: TestHostOverrides = {},
): WorkflowVmHostDeps {
  const selectedWorkflow = overrides.workflow ?? workflow
  const selectedSkills = overrides.skills ?? fixtureSkills
  const selectedPersonas = overrides.personas ?? new Map()
  const definitionRevision = overrides.definitionRevision
    ?? fixtureRevision(selectedSkills, selectedPersonas)
  const { workflow: _, skills: __, personas: ___, ...hostOverrides } = overrides
  return {
    ...quietHostDeps(overrides.writer ?? store),
    requestAddenda: async () => [],
    servedConversations: async () => new Set(),
    startMode: "launch",
    sessionId: "session",
    reader: asAsyncEventReadSurface(store),
    writer: store,
    ...workflowStores(store),
    definitionRevision,
    workflow: selectedWorkflow,
    conversationId: () => "conversation-1",
    attemptRunner: { run: async () => { throw new Error("unexpected worker") } },
    emit: () => {},
    now: () => 10,
    ...hostOverrides,
  }
}

type HistoricalFollowUpRequest = Pick<Extract<DecodedWorkflowProposalEvent, { type: "FOLLOW_UP_REQUESTED" }>, "identity" | "input">

/** Appends the proposal of `event` to the history of `selectedWorkflow` at
 *  `encoding`, the way the build that wrote that encoding committed it. A
 *  test uses it to build a stored history that no current path writes. */
export async function recordProposal(
  store: ReturnType<typeof createMemoryStore>,
  event: Parameters<typeof transitionDecodedWorkflow>[1],
  encoding?: WorkflowProposalEncoding,
  selectedWorkflow: WorkflowDefinition = workflow,
): Promise<void> {
  const { queueStore } = workflowStores(store)
  const proposed = composeWorkflowCompanions(
    transitionDecodedWorkflow(replayDecodedWorkflow(replayWorkflowControl(store.events)), event, encoding),
    { queue: await queueStore.loadQueue(), resolvedAgents: resolveWorkflowAgents(selectedWorkflow), timestamp: 10, addenda: [] },
  )
  if (proposed.command.kind !== "commit") throw new Error(`Expected a commit for ${event.type}`)
  await store.appendBatch(proposed.command.proposal.facts.map((fact) => ({
    aggregateId: "workflow:session", sessionId: "session", timestamp: 10,
    type: fact.type, version: fact.version, actor: fact.actor, payload: fact.payload,
  })))
}

/** Appends a follow-up request to a completed workflow the way a build before
 *  2026-10-03 committed it, when a workflow still took follow-up input in its
 *  own session, and, when `settled`, the turn that answered it. When
 *  `pausedReason` is set, it also appends the operator stop that paused the
 *  pending request. No current path writes these facts; stored history still
 *  holds them. */
export async function recordHistoricalFollowUp(
  store: ReturnType<typeof createMemoryStore>,
  request: HistoricalFollowUpRequest,
  options: { readonly settled?: boolean; readonly pausedReason?: string } = {},
): Promise<void> {
  const previous = replayWorkflowControl(store.events).followUp
  const conversationId = previous?.conversationId ?? "conversation-1"
  const requestSequence = (previous?.requestSequence ?? 0) + 1
  // Encoding 13 is the last that holds a follow-up run.
  await recordProposal(store, { type: "FOLLOW_UP_REQUESTED", ...request, conversationId, requestSequence }, 13)
  if (options.settled) await recordProposal(store, { type: "FOLLOW_UP_SUCCEEDED", conversationId, requestSequence }, 13)
  if (options.pausedReason !== undefined) await recordProposal(store, { type: "ABORT", reason: options.pausedReason })
}

export async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20 && !predicate(); attempt += 1) await Bun.sleep(1)
  if (!predicate()) throw new Error("Condition was not reached")
}
