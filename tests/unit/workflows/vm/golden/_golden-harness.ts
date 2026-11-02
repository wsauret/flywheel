import { asAsyncEventReadSurface, type AsyncGuardedEventWriter, type EventReader, type EventStoreAppend, type GuardedEventStoreAppend, type StoredFact } from "../../../../../src/infra/event-store-types.js"
import { createWorkflowContextStore } from "../../../../../src/workflows/context-bundle/context-store.js"
import { buildContextInputSeededFact } from "../../../../../src/workflows/context-bundle/context-facts.js"
import { createWorkflowViewStore } from "../../../../../src/workflows/view/view-store.js"
import { queueFactsForState } from "../../../../../src/workflows/view/view-diff.js"
import { testSkillRevision } from "../../../../helpers/skill-fixtures.js"
import { resolveWorkflowAgents } from "../../../../../src/workflows/agent-resolution.js"
import { compileWorkflowControl } from "../../../../../src/workflows/vm/compile.js"
import { createWorkflowVmHost } from "../../../../../src/workflows/vm/host.js"
import type { WorkflowVmHost, WorkflowVmHostDeps, WorkflowVmHostRunResult, WorkflowVmStartMode } from "../../../../../src/workflows/vm/host-types.js"
import { flattenWorkflowView } from "../../../../../src/workflows/vm/view-flatten.js"
import { buildWorkflowControlInitializedFact, parseWorkflowSessionFact } from "../../../../../src/workflows/vm/session-facts.js"
import { inMemoryEventReader } from "../../../../helpers/in-memory-event-reader.js"
import { repoDefinitions } from "../../../../helpers/project-definitions.js"
import type { CanonicalOutcome, CanonicalScenario } from "./_canonical-scenarios.js"

interface MemoryStore extends EventReader, AsyncGuardedEventWriter {
  readonly events: StoredFact[]
  /** The number of stored facts after each committed batch. */
  readonly batchEnds: number[]
}

export interface CanonicalObservation {
  readonly invocations: readonly string[]
  /** The item that each invocation received, in invocation order. */
  readonly invocationItems: readonly unknown[]
  readonly status: string
  readonly attempts: readonly string[]
  readonly completed: number
  readonly failed: number
  readonly committedEvents: readonly string[]
  /** Every fact the scenario stored, in position order. */
  readonly events: readonly StoredFact[]
  /** The number of stored facts after each committed batch, which is each
   *  prefix a reader can observe. */
  readonly batchEnds: readonly number[]
  readonly attemptDetails: readonly {
    readonly definitionId: string
    readonly status: string
    readonly resumeRevertCount: number
  }[]
}
export async function runCanonicalScenario(scenario: CanonicalScenario): Promise<CanonicalObservation> {
  const store = createStore(scenario)
  const invocations: string[] = []
  const invocationItems: unknown[] = []
  let outcomeIndex = 0
  let conversations = 0
  const reader = asAsyncEventReadSurface(store)

  const capturedRevision = repoDefinitions().captureRevision()
  const definitionRevision = Object.freeze({ ...capturedRevision, skills: scenarioSkills(), personas: new Map() })
  const outcomeRunner: WorkflowVmHostDeps["attemptRunner"] = {
    run: async (input, active) => {
      invocations.push(input.definitionId)
      invocationItems.push(input.item)
      const outcome = scenario.outcomes[outcomeIndex++]
      if (!outcome) throw new Error(`Scenario ${scenario.id} has no outcome for invocation ${outcomeIndex}`)
      return attemptOutcome(outcome, input.attemptId, active.conversationId)
    },
  }
  const makeHost = (startMode: WorkflowVmStartMode, attemptRunner = outcomeRunner): WorkflowVmHost => createWorkflowVmHost({
    servedConversations: async () => new Set(),
    requestAddenda: async () => [],
    startMode,
    sessionId: scenario.id,
    reader: asAsyncEventReadSurface(store),
    writer: store,
    queueStore: createWorkflowViewStore({ sessionId: scenario.id, reader }),
    contextStore: createWorkflowContextStore({ sessionId: scenario.id, reader }),
    definitionRevision,
    workflow: scenario.workflow,
    attemptRunner,
    conversationId: () => `conversation-${++conversations}`,
    emit: () => {},
    now: () => 10,
    ...(scenario.action === "pause-before" ? { preAttemptPolicy: () => "Operator approval required" } : {}),
  })

  let result: WorkflowVmHostRunResult
  if (scenario.action === "abort") {
    let started = false
    const host = makeHost("launch", {
      run: async (input, { signal }) => {
        invocations.push(input.definitionId)
        started = true
        await aborted(signal)
        throw new Error("unreachable")
      },
    })
    const running = host.run()
    await waitFor(() => started)
    await host.abort("Operator abort")
    result = await running
  } else if (scenario.action === "crash-recover") {
    let secondStarted = false
    const interrupted = makeHost("launch", {
      run: async (input, active) => {
        invocations.push(input.definitionId)
        if (input.definitionId === "one") {
          const outcome = scenario.outcomes[outcomeIndex++]
          if (!outcome) throw new Error(`Scenario ${scenario.id} has no first outcome`)
          return attemptOutcome(outcome, input.attemptId, active.conversationId)
        }
        secondStarted = true
        await aborted(active.signal)
        throw new Error("unreachable")
      },
    })
    const running = interrupted.run()
    await waitFor(() => secondStarted)
    await interrupted.dispose()
    await running
    result = await makeHost("operator_resume").run()
  } else if (scenario.action === "abort-resume") {
    // The runtime's planned teardown is the one path that cuts a running
    // attempt from outside the host: ABORT, then the successor's RESUME.
    let started = false
    const first = makeHost("launch", {
      run: async (input, { signal }) => {
        invocations.push(input.definitionId)
        started = true
        await aborted(signal)
        throw new Error("unreachable")
      },
    })
    const running = first.run()
    await waitFor(() => started)
    await first.abort("Runtime shutdown")
    await running
    result = await makeHost("operator_resume").run()
  } else {
    const host = makeHost(scenario.action === "poison" ? "operator_resume" : "launch")
    result = await host.run()
  }

  const queue = result.view ?? await createWorkflowViewStore({ sessionId: scenario.id, reader }).loadQueue()
  if (!queue) throw new Error(`Scenario ${scenario.id} produced no queue`)
  return {
    invocations,
    invocationItems,
    status: queue.status,
    attempts: queue.attempts.map(({ definitionId, status }) => `${definitionId}:${status}`),
    completed: queue.attempts.filter(({ status }) => status === "completed").length,
    failed: queue.attempts.filter(({ status }) => status === "failed").length,
    events: store.events,
    batchEnds: store.batchEnds,
    committedEvents: store.events
      .filter(({ type }) => type === "workflow.control.committed")
      .flatMap(({ payload }) => {
        const event = payload.event
        return typeof event === "object" && event !== null && "type" in event && typeof event.type === "string"
          ? [event.type]
          : []
      }),
    attemptDetails: queue.attempts.map(({ definitionId, status, resumeRevertCount }) => ({ definitionId, status, resumeRevertCount })),
  }
}

/** The revision a scenario is pinned to. Its steps are inline and compose no
 *  package, so identity never depends on what the developer installed. */
function scenarioSkills(): ReturnType<typeof testSkillRevision> {
  return testSkillRevision([])
}

function createStore(scenario: CanonicalScenario): MemoryStore {
  const resolved = resolveWorkflowAgents(scenario.workflow)
  const compiled = compileWorkflowControl(
    scenario.workflow,
    resolved,
    {
      skills: scenarioSkills(),
    },
    scenario.guardrails,
  )
  const control = scenario.action === "poison" ? poison(compiled) : compiled
  const queue = flattenWorkflowView(control, resolved)
  const companions = [
    ...queueFactsForState(null, queue),
    buildContextInputSeededFact(scenario.workflow.id, scenario.enduringSemantics),
  ]
  const facts = [buildWorkflowControlInitializedFact({ ...control, aggregateSeq: companions.length }), ...companions]
    .map(parseWorkflowSessionFact)
  const events = facts.map((fact, index) => stored({
    aggregateId: `workflow:${scenario.id}`,
    sessionId: scenario.id,
    timestamp: 10,
    type: fact.type,
    version: fact.version,
    actor: fact.actor,
    payload: fact.payload,
  }, index, index + 1))
  const reader: EventReader = inMemoryEventReader(events)
  const batchEnds = [events.length]
  const appendBatch = async (appends: readonly EventStoreAppend[]): Promise<StoredFact[]> => {
    const aggregateId = appends[0]?.aggregateId
    const firstSeq = aggregateId ? reader.aggregateSeq(aggregateId) + 1 : 0
    const written = appends.map((append, index) => stored(append, firstSeq + index, events.length + index + 1))
    events.push(...written)
    batchEnds.push(events.length)
    return written
  }
  return {
    ...reader,
    events,
    batchEnds,
    append: async (append) => (await appendBatch([append]))[0] ?? Promise.reject(new Error("append returned no event")),
    appendBatch,
    appendGuarded: async (append) => ({ kind: "stored", events: await appendBatch([append]) }),
    appendBatchGuarded: async (appends: readonly GuardedEventStoreAppend[]) => ({ kind: "stored", events: await appendBatch(appends) }),
    pruneSupersededEvents: async () => 0,
  }
}

function poison(control: ReturnType<typeof compileWorkflowControl>): ReturnType<typeof compileWorkflowControl> {
  const attempt = control.attempts[0]
  const node = control.graph.nodes[0]
  if (!attempt || !node) throw new Error("Poison scenario requires one attempt")
  return {
    ...control,
    status: "executing",
    graph: { ...control.graph, nodes: [{ ...node, state: { _tag: "running" } }, ...control.graph.nodes.slice(1)] },
    attempts: [{ ...attempt, state: { _tag: "running" }, conversationId: "poison-conversation", resumeRevertCount: 3 }, ...control.attempts.slice(1)],
  }
}

function attemptOutcome(outcome: CanonicalOutcome, attemptId: string, conversationId: string): Awaited<ReturnType<WorkflowVmHostDeps["attemptRunner"]["run"]>> {
  if (outcome.kind === "success") return {
    kind: "success",
    attemptId,
    conversationId,
    handoff: outcome.handoff,
    reassessment: outcome.reassessment ?? null,
  }
  if (outcome.kind === "invalid_handoff") return {
    kind: outcome.kind,
    attemptId,
    conversationId,
    reason: outcome.reason,
    content: outcome.content ?? {},
    issues: [{ path: "summary", message: outcome.reason }],
  }
  return { kind: outcome.kind, attemptId, conversationId, reason: outcome.reason }
}

function stored(append: GuardedEventStoreAppend, seq: number, position: number): StoredFact {
  const { expectedSeq: _expectedSeq, ...event } = append
  return { ...event, id: `event-${position}`, seq, position }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20 && !predicate(); attempt += 1) await Bun.sleep(1)
  if (!predicate()) throw new Error("Condition was not reached")
}

async function aborted(signal: AbortSignal): Promise<never> {
  return await new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })
  })
}
