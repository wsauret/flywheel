import { describe, expect, it, spyOn } from "bun:test"
import * as committedControl from "../../../../src/workflows/vm/committed-control.js"
import { asAsyncEventReadSurface, CorruptEventRowError, type StoredFact } from "../../../../src/infra/event-store-types.js"
import { buildContextInputSeededFact } from "../../../../src/workflows/context-bundle/context-facts.js"
import { buildDefinitionDriftRejectedFact } from "../../../../src/workflows/definition-provenance-fact-writers.js"
import { resolveWorkflowAgents } from "../../../../src/workflows/agent-resolution.js"
import { buildAttemptRecoveredFact } from "../../../../src/workflows/vm/fact-drafts.js"
import { advanceWorkflowRecoveryFold, classifyWorkflowHistory, classifyWorkflowRecoveryFold, readWorkflowControl, readWorkflowRecoveryEvidence, seedWorkflowRecoveryFold } from "../../../../src/workflows/vm/recovery-fold.js"
import { readWorkflowControlStatuses } from "../../../../src/workflows/vm/control-status.js"
import { graphTopology, type GraphTopology } from "../../../../src/workflows/vm/graph-topology.js"
import { parseWorkflowSessionFact } from "../../../../src/workflows/vm/session-facts.js"
import { commitWorkflowRecovery } from "../../../../src/orchestration/workflow-host/recovery-commit.js"
import { inMemoryEventReader } from "../../../helpers/in-memory-event-reader.js"
import { countStateRequests } from "../../../helpers/state-requests.js"
import { controlBeforePhases } from "../../../helpers/control-before-phases.js"
import { initializedWorkflowRoot, recoveredWorkflowRoot, storedWorkflowFacts } from "../../../helpers/workflow-root-fixtures.js"
import { canonicalScenarios } from "./golden/_canonical-scenarios.js"
import { runCanonicalScenario } from "./golden/_golden-harness.js"
import { createMemoryStore, initialFacts, recordProposal, testHost, workflow } from "./host-test-support.js"
import repeatBoundHistory from "./golden/committed-v10-repeat-bound.json"
import thenHistories from "../../orchestration/session/golden/then-continuation-histories.json"

type Row = StoredFact | CorruptEventRowError

/** Folds the history the way its held reader does: it advances by the facts
 *  committed since the last read, and seeds again from the whole prefix when
 *  the fold cannot answer or a damaged row arrives. The answer at each read
 *  must equal the validators' answer for that whole prefix. By default the
 *  reader reads after every fact, which also covers prefixes inside a batch. */
function expectFoldMatchesValidators(facts: readonly Row[], readsAfter: readonly number[] = facts.map((_, index) => index + 1)) {
  let fold = seedWorkflowRecoveryFold([])
  let seeded = 0
  let read = 0
  for (const end of readsAfter) {
    const prefix = facts.slice(0, end)
    let damaged = false
    for (const fact of facts.slice(read, end)) {
      if (fact instanceof CorruptEventRowError) damaged = true
      else fold = advanceWorkflowRecoveryFold(fold, fact)
    }
    read = end
    let classification = damaged ? null : classifyWorkflowRecoveryFold(fold)
    if (!classification) {
      seeded += 1
      fold = seedWorkflowRecoveryFold(prefix)
      classification = classifyWorkflowRecoveryFold(fold)
    }
    expect({ end, classification }).toEqual({ end, classification: classifyWorkflowHistory(prefix) })
  }
  return { seeded }
}

/** One aggregate's history with contiguous sequences and positions. */
function restamped(facts: readonly Row[]): Row[] {
  return facts.map((fact, seq) => {
    const position = seq + 1
    if (fact instanceof CorruptEventRowError) return new CorruptEventRowError({ ...fact.row, aggregateId: "workflow:session", sessionId: "session", seq, position }, "Payload is not JSON")
    return { ...fact, aggregateId: "workflow:session", sessionId: "session", id: `event-${position}`, seq, position }
  })
}

function corrupted(fact: StoredFact): CorruptEventRowError {
  return new CorruptEventRowError({
    aggregateId: fact.aggregateId, seq: fact.seq, position: fact.position, type: fact.type, version: fact.version,
    timestamp: fact.timestamp, actor: fact.actor, sessionId: fact.sessionId, eventId: fact.id, rawPayload: "not-json",
  }, "Payload is not JSON")
}

async function scenarioHistory(id: string): Promise<readonly StoredFact[]> {
  const scenario = canonicalScenarios.find((candidate) => candidate.id === id)
  if (!scenario) throw new Error(`Scenario ${id} is missing`)
  return (await runCanonicalScenario(scenario)).events
}

/** A completed run whose queue was lost, then repaired by a committed recovery root. */
async function recoveredHistory(): Promise<readonly StoredFact[]> {
  const store = createMemoryStore(initialFacts())
  const host = testHost(store, { attemptRunner: { run: async (input, owner) => ({
    kind: "success", attemptId: input.attemptId, conversationId: owner.conversationId,
    handoff: { summary: "complete" }, reassessment: null,
  }) } })
  expect((await host.run()).kind).toBe("completed")
  await host.dispose()
  store.events.splice(store.events.findIndex(({ type }) => type === "queue.created"), 1)
  const result = await commitWorkflowRecovery({
    sessionId: "session", reader: asAsyncEventReadSurface(inMemoryEventReader(store.events)), writer: store,
    timestamp: new Date(2).toISOString(),
    runtimeIdentity: async () => ({ version: "test", buildId: "test" }),
    prepare: async (basis) => {
      if (!basis) throw new Error("A completed run keeps its recovery basis")
      return { control: basis, resolvedAgents: resolveWorkflowAgents(workflow) }
    },
  })
  expect(result.kind).toBe("committed")
  return store.events.filter(({ aggregateId }) => aggregateId === "workflow:session")
}

describe("workflow recovery fold", () => {
  // One test per run, so no single test approaches the per-test time limit.
  for (const scenario of canonicalScenarios) {
    it(`answers as the validators do after every prefix of canonical run ${scenario.id}, and seeds only at its launch and its first proposal`, async () => {
      const { events, batchEnds } = await runCanonicalScenario(scenario)
      expectFoldMatchesValidators(events)
      expect(expectFoldMatchesValidators(events, batchEnds)).toEqual({ seeded: 2 })
    })
  }

  it("holds the fold, not the facts: commits after the seed advance with no full read", async () => {
    const scenario = canonicalScenarios.find(({ id }) => id === "linear-three-phase-completion")
    if (!scenario) throw new Error("The scenario is missing")
    const { events: history, batchEnds } = await runCanonicalScenario(scenario)
    const rows: StoredFact[] = []
    const counter = countStateRequests(asAsyncEventReadSurface(inMemoryEventReader(rows)))
    const firstProposal = history.findIndex(({ type }) => type === "workflow.control.committed")
    const [seedEnd = 0, ...laterEnds] = batchEnds.filter((end) => end > firstProposal)
    rows.push(...history.slice(0, seedEnd))
    await readWorkflowRecoveryEvidence(counter.reader, scenario.id)
    counter.take()
    // Each commit changes node states only, so every replayed control keeps
    // the one structure that the run built, through the strict decode.
    const topologies = new Set<GraphTopology>()
    for (const end of laterEnds) {
      rows.push(...history.slice(rows.length, end))
      const evidence = await readWorkflowRecoveryEvidence(counter.reader, scenario.id)
      expect(evidence.classification).toEqual(classifyWorkflowHistory(rows))
      expect(Object.keys(evidence).sort()).toEqual(["aggregateSeq", "assessmentIdentity", "classification"])
      const { plan } = evidence.classification
      if (plan.executable) topologies.add(graphTopology(plan.control.graph))
    }
    expect(topologies.size).toBe(1)
    const requests = counter.take()
    expect(requests.filter(({ method }) => method === "readSlice")).toEqual([])
    // Each catch-up seeks the workflow's own new rows, and a damaged row reseeds instead of failing the read.
    const pages = requests.filter(({ method }) => method === "readPage")
    expect(pages.length).toBe(laterEnds.length)
    for (const page of pages) {
      expect(page.query).toEqual({ aggregateId: `workflow:${scenario.id}` })
      expect(page.args[3]).toBe(true)
    }
  })

  it("decodes each committed proposal's control once for recovery, control, and admission readers together", async () => {
    const scenario = canonicalScenarios.find(({ id }) => id === "linear-three-phase-completion")
    if (!scenario) throw new Error("The scenario is missing")
    const { events: history, batchEnds } = await runCanonicalScenario(scenario)
    const rows: StoredFact[] = []
    const reader = asAsyncEventReadSurface(inMemoryEventReader(rows))
    const firstProposal = history.findIndex(({ type }) => type === "workflow.control.committed")
    const [seedEnd = 0, ...laterEnds] = batchEnds.filter((end) => end > firstProposal)
    rows.push(...history.slice(0, seedEnd))
    await readWorkflowRecoveryEvidence(reader, scenario.id)
    await readWorkflowControl(reader, scenario.id)
    await readWorkflowControlStatuses(reader, [scenario.id])
    const decodes = spyOn(committedControl, "parseCommittedWorkflowControl")
    try {
      let proposals = 0
      for (const end of laterEnds) {
        proposals += history.slice(rows.length, end).filter(({ type }) => type === "workflow.control.committed").length
        rows.push(...history.slice(rows.length, end))
        const [{ classification }, control, statuses] = await Promise.all([
          readWorkflowRecoveryEvidence(reader, scenario.id),
          readWorkflowControl(reader, scenario.id),
          readWorkflowControlStatuses(reader, [scenario.id]),
        ])
        expect(classification.plan.control).toEqual(control)
        expect(statuses.get(scenario.id)).toBe(control.status)
      }
      expect(proposals).toBeGreaterThan(1)
      expect(decodes).toHaveBeenCalledTimes(proposals)
    } finally {
      decodes.mockRestore()
    }
  })

  it("reads the same control after the pruner removes a proposal batch's leading replace-only companion", async () => {
    const resumedStore = async () => {
      const store = createMemoryStore(initialFacts())
      await recordProposal(store, { type: "START" })
      await recordProposal(store, { type: "PAUSE", reason: "person" })
      await recordProposal(store, { type: "RESUME", readers: {} })
      return store
    }
    const complete = await resumedStore()
    const pruned = await resumedStore()
    // The resume batch is queue.state.changed, workflow.resumed, then the
    // terminal commit. A later queue state supersedes the leading companion, so
    // the pruner removes it and the batch then starts with a control fact.
    const resumed = pruned.events.findIndex(({ type }) => type === "workflow.resumed")
    expect(pruned.events[resumed - 1]?.type).toBe("queue.state.changed")
    pruned.events.splice(resumed - 1, 1)

    const expected = await readWorkflowControl(asAsyncEventReadSurface(complete), "session")
    expect(expected.status).toBe("ready")
    expect(await readWorkflowControl(asAsyncEventReadSurface(pruned), "session")).toEqual(expected)
  })

  it("reads strict control of a run that recovery pauses for its context, and refuses a damaged row", async () => {
    const id = "linear-three-phase-completion"
    const healthy = await scenarioHistory(id)
    const index = healthy.findLastIndex(({ type }) => type === "context.accumulated")
    const paused = healthy.map((fact, position) => position === index ? { ...fact, payload: {} } : fact)
    expect(classifyWorkflowHistory(paused).plan.executable).toBe(false)
    expect((await readWorkflowControl(asAsyncEventReadSurface(inMemoryEventReader(paused)), id)).status).toBe("completed")
    const damaged = healthy.map((fact, position) => position === index ? corrupted(fact) : fact)
    const local = inMemoryEventReader(healthy)
    await expect(readWorkflowControl(asAsyncEventReadSurface({ ...local, readTolerant: () => damaged }), id)).rejects.toBeInstanceOf(CorruptEventRowError)
  })

  it("answers as the validators do after each proposal of a stored version 10 run", () => {
    const facts = storedWorkflowFacts(repeatBoundHistory.map(parseWorkflowSessionFact))
    const proposals = facts.flatMap(({ type }, index) => type === "workflow.control.committed" ? [index + 1] : [])
    // The first read follows the first proposal, so the fold seeds once and advances through the run.
    expect(expectFoldMatchesValidators(facts, [...proposals, facts.length]).seeded).toBe(1)
  })

  it("seeds again at a recovery root and advances the recovered run", async () => {
    const facts = await recoveredHistory()
    expect(facts.some(({ type }) => type === "workflow.control.recovered")).toBe(true)
    expectFoldMatchesValidators(facts)
  })

  it("seeds again at a newest root that this build cannot read, and at a root that replaces a healthy run", async () => {
    const healthy = await scenarioHistory("linear-three-phase-completion")
    const [root] = storedWorkflowFacts([initializedWorkflowRoot])
    if (!root) throw new Error("The root fixture is missing")
    expectFoldMatchesValidators(restamped([...healthy, { ...root, version: root.version + 1 }, ...healthy.slice(1)]))
    expectFoldMatchesValidators(restamped([...healthy, ...healthy]))
  })

  it("answers as the validators do for the historical contextless recovery root", () => {
    const root = recoveredWorkflowRoot(initializedWorkflowRoot.payload.control, 3)
    const identities = {
      ...root.payload.identities,
      attempt: { source: "recovered" as const, value: "attempt" },
      conversation: { source: "recovered" as const, value: "conversation" },
    }
    const recovered = parseWorkflowSessionFact({
      ...root, version: 1, payload: { ...root.payload, supersededThroughSeq: 0, identities, control: { ...controlBeforePhases(root.payload.control), issues: [], seals: [] } },
    })
    expectFoldMatchesValidators(storedWorkflowFacts([
      buildContextInputSeededFact("workflow", "Predecessor request"),
      recovered,
      buildAttemptRecoveredFact("attempt", "conversation"),
    ]))
  })

  it("answers as the validators do when a damaged queue or context row is committed mid-run", async () => {
    const healthy = await scenarioHistory("linear-three-phase-completion")
    for (const type of ["queue.state.changed", "step.status.changed", "context.accumulated"]) {
      const index = healthy.findIndex((fact, position) => position > healthy.length / 2 && fact.type === type)
      expect(index).toBeGreaterThan(0)
      expectFoldMatchesValidators(healthy.map((fact, position) => position === index ? corrupted(fact) : fact))
    }
  })

  it("settles on the validators' answer for stored runs whose tree predates version 4, including a refused insertion", () => {
    for (const history of Object.values(thenHistories)) {
      const facts = storedWorkflowFacts(history.map(parseWorkflowSessionFact))
      expectFoldMatchesValidators(facts)
    }
    const refused = storedWorkflowFacts(thenHistories.refusedContinuation.map(parseWorkflowSessionFact))
    expect(refused.map(({ type }) => type)).toContain("attempt.insertion_rejected")
    expect(classifyWorkflowHistory(refused).retry).toBe(false)
  })

  it("answers as the validators do after every prefix of a current run whose list expansion is refused", async () => {
    const scenario = canonicalScenarios.find(({ id }) => id === "each-three-items")
    const [source, ...rest] = scenario?.outcomes ?? []
    if (!scenario || source?.kind !== "success") throw new Error("The list scenario is missing")
    const tooMany = Array.from({ length: 6 }, (_, index) => ({ id: `item-${index}` }))
    const { events, batchEnds } = await runCanonicalScenario({ ...scenario, outcomes: [{ ...source, handoff: { ...source.handoff, items: tooMany } }, ...rest] })
    expect(events.map(({ type }) => type)).toContain("group.expansion_rejected")
    expectFoldMatchesValidators(events)
    expect(expectFoldMatchesValidators(events, batchEnds).seeded).toBe(2)
  })

  it("answers as the validators do when a readable context fact has a body this build rejects", async () => {
    const healthy = await scenarioHistory("linear-three-phase-completion")
    const index = healthy.findLastIndex(({ type }) => type === "context.accumulated")
    const facts = healthy.map((fact, position) => position === index ? { ...fact, payload: {} } : fact)
    expect(classifyWorkflowHistory(facts).plan.executable).toBe(false)
    expectFoldMatchesValidators(facts)
  })

  it("holds a definition drift rejection until control moves on", async () => {
    const healthy = await scenarioHistory("pause-before-worker")
    const rejection = buildDefinitionDriftRejectedFact({ workflowId: "pause-before-worker", latestSeq: healthy.length - 1, changes: [
      { component: "graph", definitionId: "pause-before-worker", recorded: "a".repeat(64), current: "b".repeat(64) },
    ] })
    const committed = healthy.findLast(({ type }) => type === "workflow.control.committed")
    if (!committed) throw new Error("The run committed no proposal")
    const facts = restamped([...healthy, { ...healthy[0]!, ...rejection }, { ...healthy[0]!, ...rejection }, committed])
    expectFoldMatchesValidators(facts)
    const rejected = classifyWorkflowHistory(facts.slice(0, healthy.length + 1)).rejection
    expect(rejected?.workflowId).toBe("pause-before-worker")
  })
})
