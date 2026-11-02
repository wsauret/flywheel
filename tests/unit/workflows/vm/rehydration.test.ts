import { afterEach, describe, expect, it } from "bun:test"
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js"
import { parseWorkflowSessionFact } from "../../../../src/workflows/vm/session-facts.js"
import { SqliteVmDriver } from "./_sqlite-vm-driver.js"
import { Schema } from "effect"
import { WorkflowDefinitionSchema } from "../../../../src/workflows/workflow-schema.js"
import { testSkillRevision } from "../../../helpers/skill-fixtures.js"
import { attemptOf, inputMapWorkflow, inputStage, items, mapSkills } from "./_map-fixtures.js"
import type { WorkflowTransitionResult } from "../../../../src/workflows/vm/commands.js"
import { initializeWorkflow, transitionWorkflow } from "../../../../src/workflows/vm/transition.js"
import arms from "./golden/committed-v10-history-arms.json"
import { loadWorkflowFile } from "../../../../src/workflows/workflow-file.js"
import { resolveWorkflowAgents } from "../../../../src/workflows/agent-resolution.js"
import { createContextAccumulator } from "../../../../src/workflows/context-bundle/context.js"
import { makeEntry } from "../queue/_context-accumulator-fixtures.js"

const drivers: SqliteVmDriver[] = []

afterEach(() => {
  for (const vm of drivers.splice(0)) vm.close()
})

function driver(): SqliteVmDriver {
  const value = new SqliteVmDriver()
  drivers.push(value)
  return value
}


const record = (id: string) => ({ brief: `Do the ${id} work.`, name: id, writes: [] })

/** A workflow whose phase build has the named agents left and right, and
 *  whose phase ship runs after it. */
const phaseWorkflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
  id: "sqlite-phases",
  name: "SQLite phases",
  phases: [{ phase: "build", agents: [{ agent: "left", ...record("left") }, { agent: "right", ...record("right") }] }, { phase: "ship", ...record("ship") }],
})

describe("SQLite workflow VM replay", () => {
  it.each([false, true])("rehydrates a run paused inside an open phase and keeps its recorded shape (historical no-join: %s)", async (withoutJoin) => {
    const vm = new SqliteVmDriver({
      workflow: phaseWorkflow, skills: testSkillRevision([]),
      control: (control) => withoutJoin ? {
        ...control,
        graph: { ...control.graph, nodes: control.graph.nodes.map((node) => node.kind === "phase" ? { ...node, join: null } : node) },
      } : control,
    })
    drivers.push(vm)
    await vm.initialize()
    await vm.startAttempt("after", "conversation-left")
    await vm.completeAttempt("after")
    await vm.drive({ type: "PAUSE", reason: "operator" })

    const fresh = vm.freshViews().control
    expect(fresh.status).toBe("paused")
    expect(fresh.graph.nodes.map(({ id, state }) => [id, state._tag])).toEqual([
      ["sqlite-phases:node:1", "running"],
      ["sqlite-phases:node:1:node:1", "completed"],
      ["sqlite-phases:node:1:node:2", "ready"],
      ["sqlite-phases:node:2", "pending"],
    ])
    const resumed = await vm.freshReplay({ type: "RESUME", readers: {} })
    const pending = resumed.state.context.pending
    if (resumed.command.kind !== "commit" || !pending) throw new Error("Expected a resume proposal")
    expect(pending.proposedCommitted.graph).toEqual(fresh.graph)
    const started = await vm.drive({ type: "RESUME", readers: {} })
    expect(started.command).toMatchObject({ kind: "prepare_attempt", attempt: { attemptId: "sqlite-phases:node:1:node:2:attempt:1" } })
    await vm.drive({ type: "ATTEMPT_STARTED", attemptId: "sqlite-phases:node:1:node:2:attempt:1", conversationId: "conversation-right" })
    await vm.completeAttempt("after")
    await vm.startAttempt("after", "conversation-ship")
    await vm.completeAttempt("after")
    expect(vm.committed.status).toBe("completed")
    expect(vm.freshViews().control).toEqual(vm.committed)
    expect(vm.committed.graph.nodes.find((node) => node.kind === "phase")?.join === null).toBe(withoutJoin)
  })

  it("rehydrates a paused run over the launch input with its input, and reads a text-only seed as a launch without input", async () => {
    const input = { goal: "Ship.", items: items("a", "b") }
    const vm = new SqliteVmDriver({ workflow: inputMapWorkflow, skills: mapSkills, input })
    drivers.push(vm)
    await vm.initialize()
    await vm.startAttempt("after", "conversation-first")
    await vm.completeAttempt("after")
    await vm.drive({ type: "PAUSE", reason: "operator" })
    expect(vm.freshViews().control.attempts.find(({ id }) => id === attemptOf(inputStage(1, 1)))?.state._tag).toBe("completed")

    // The paused run resumes under the same definition identity, which pins
    // the input contract, and its next stage reads the recorded input.
    const resumed = await vm.freshReplay({ type: "RESUME", readers: {} })
    if (resumed.command.kind !== "commit") throw new Error("Expected a resume proposal")
    const started = await vm.drive({ type: "RESUME", readers: {} })
    expect(started.command).toMatchObject({ kind: "prepare_attempt", attempt: { attemptId: attemptOf(inputStage(1, 2)) } })
    expect((await vm.workflowStores().contextStore.getContext()).request).toEqual({ original: "SQLite VM acceptance", input, addenda: [] })
    expect(replayWorkflowControl(vm.events())).toEqual(vm.freshViews().control)

    // A launch without input keeps the version 1 seed bytes, and a version
    // 1 seed has no input.
    const plain = driver()
    await plain.initialize()
    expect(plain.events().find(({ type }) => type === "context.input.seeded")).toMatchObject({ version: 1, payload: { workflowDefinitionId: plain.workflow.id, userRequest: "SQLite VM acceptance" } })
    expect((await plain.workflowStores().contextStore.getContext()).request).toEqual({ original: "SQLite VM acceptance", addenda: [] })
  })

  it("competing writer causes expectedSeq conflict; stale machine is discarded and fresh state equals SQLite fold without stale pending context", async () => {
    const vm = driver()
    await vm.initialize()
    const attempt = vm.committed.attempts[0]
    if (!attempt) throw new Error("Fixture requires an attempt")
    const staleEvent = { type: "ATTEMPT_STARTED", attemptId: attempt.id, conversationId: "stale-conversation" } as const
    const staleProposal = vm.propose(staleEvent)
    if (staleProposal.command.kind !== "commit") throw new Error("Fixture requires a stale commit proposal")
    expect(staleProposal.state.context.pending).not.toBeNull()
    const batchesBefore = vm.batches.length

    await vm.commitCompeting({ type: "PAUSE", reason: "competing operator" })
    const resolved = await vm.commitProposal(staleEvent, staleProposal)
    const folded = replayWorkflowControl(vm.events())

    expect(resolved.state.context.committed).toEqual(folded)
    expect(resolved.state.context.pending).toBeNull()
    expect(resolved.state.lifecycle).toBe("paused")
    expect(resolved.command.kind).toBe("none")
    expect(folded.attempts[0]?.conversationId).toBeNull()
    expect(JSON.stringify(resolved)).not.toContain("stale-conversation")
    expect(vm.committed).toEqual(folded)
    expect(vm.queue()).toEqual(vm.freshViews().queue)
    expect(vm.batches).toHaveLength(batchesBefore)
    expect(vm.lastAppliedEvents.map(({ seq }) => seq)).toEqual(
      vm.events().slice(staleProposal.command.proposal.expectedSeq).map(({ seq }) => seq),
    )
  })

  it("does not conflict when concurrent session telemetry advances the noisy session aggregate", async () => {
    const vm = driver()
    await vm.initialize()
    const attempt = vm.committed.attempts[0]
    if (!attempt) throw new Error("Fixture requires an attempt")
    const event = { type: "ATTEMPT_STARTED", attemptId: attempt.id, conversationId: "telemetry-safe" } as const
    const proposal = vm.propose(event)
    if (proposal.command.kind !== "commit") throw new Error("Fixture requires a commit proposal")
    const { expectedSeq } = proposal.command.proposal

    const telemetry = await vm.appendSessionTelemetry()
    const resolved = await vm.commitProposal(event, proposal)

    expect(telemetry.aggregateId).toBe(vm.sessionAggregateId)
    expect(vm.events().every(({ aggregateId }) => aggregateId === vm.aggregateId)).toBe(true)
    expect(resolved.state.context.committed.attempts[0]?.conversationId).toBe("telemetry-safe")
    expect(vm.lastAppliedEvents.every(({ seq }) => seq >= expectedSeq)).toBe(true)
  })

  it("replays through a competing non-control fact and reevaluates at the current sequence", async () => {
    const vm = driver()
    await vm.initialize()
    const attempt = vm.committed.attempts[0]
    if (!attempt) throw new Error("Fixture requires an attempt")
    const committed = vm.committed
    const event = { type: "ATTEMPT_STARTED", attemptId: attempt.id, conversationId: "reevaluated-conversation" } as const
    const stale = vm.propose(event)
    if (stale.command.kind !== "commit") throw new Error("Fixture requires a stale commit proposal")
    const rowsBefore = vm.events().length

    await vm.appendCompetingFact(parseWorkflowSessionFact({
      type: "queue.deleted", version: 1, actor: "flywheel", payload: {},
    }))
    expect(vm.events()).toHaveLength(rowsBefore + 1)
    expect(vm.events().at(-1)?.type).toBe("queue.deleted")
    const currentSeq = vm.events().at(-1)?.seq
    if (currentSeq === undefined) throw new Error("Fixture requires stored facts")
    const expectedSeq = currentSeq + 1
    const resolved = await vm.commitProposal(event, stale)

    expect(resolved.state.context.committed).toEqual({ ...committed, aggregateSeq: expectedSeq })
    expect(resolved.state.context.pending?.previousCommitted).toEqual({ ...committed, aggregateSeq: expectedSeq })
    expect(resolved.state.context.pending).not.toBe(stale.state.context.pending)
    expect(resolved.command.kind).toBe("commit")
    if (resolved.command.kind !== "commit") throw new Error("Reevaluation must produce a commit proposal")
    expect(resolved.command.proposal.expectedSeq).toBe(expectedSeq)
    expect(resolved.command.proposal.expectedSeq).not.toBe(stale.command.proposal.expectedSeq)
  })

  it("interruption before attempt-start commit replays ready", async () => {
    const vm = driver()
    await vm.initialize()
    const proposed = await vm.startAttempt("before")

    expect(proposed.state.lifecycle).toBe("awaiting_commit")
    expect(proposed.state.context.pending?.proposedCommitted.attempts[0]?.state._tag).toBe("running")
    const fresh = vm.freshState()
    expect(fresh.lifecycle).toBe("ready")
    expect(fresh.context.committed.attempts[0]?.state._tag).toBe("pending")
    expect(vm.events().some(({ type }) => type === "attempt.started")).toBe(false)
  })

  it("interruption after attempt-start commit replays running with the same continuation and conversation identity", async () => {
    const vm = driver()
    await vm.initialize()
    const attemptId = vm.committed.attempts[0]?.id
    const committed = await vm.startAttempt("after", "conversation-committed")

    const fresh = vm.freshState()
    expect(fresh.lifecycle).toBe("executing")
    expect(fresh.context.committed.attempts[0]).toMatchObject({
      id: attemptId,
      conversationId: "conversation-committed",
      state: { _tag: "running" },
    })
    expect(vm.events().filter(({ type }) => type === "attempt.started")).toHaveLength(1)
    expect(committed.command).toMatchObject({
      kind: "run_attempts",
      attempts: [{ attemptId, conversationId: "conversation-committed" }],
    })
    if (committed.command.kind !== "run_attempts") throw new Error("Committed attempt start must run")
    expect(committed.command.attempts).toHaveLength(1)
  })

  it("interruption before completion commit remains running with no outcome", async () => {
    const vm = driver()
    await vm.initialize()
    await vm.startAttempt("after", "conversation-committed")
    const proposed = await vm.completeAttempt("before")

    expect(proposed.state.lifecycle).toBe("awaiting_commit")
    expect(proposed.state.context.pending?.proposedCommitted.attempts[0]?.state._tag).toBe("completed")
    const fresh = vm.freshState()
    expect(fresh.context.committed.attempts[0]?.state._tag).toBe("running")
    expect(fresh.context.committed.attempts[0]?.handoff).toBeNull()
    expect(vm.events().some(({ type }) => type === "attempt.succeeded")).toBe(false)
    expect(vm.handoffs()).toEqual([])
  })

  it("interruption after completion commit replays completed outcome and pending deterministic next work", async () => {
    const vm = driver()
    await vm.initialize()
    await vm.startAttempt("after", "conversation-committed")
    const committed = await vm.completeAttempt("after", { summary: "durable" })

    const fresh = vm.freshState()
    expect(fresh.context.committed.attempts[0]).toMatchObject({
      state: { _tag: "completed" },
      handoff: { summary: "durable" },
    })
    expect(fresh.context.committed.attempts[1]).toMatchObject({
      definitionId: "review",
      conversationId: null,
      state: { _tag: "pending" },
    })
    expect(committed.command).toMatchObject({
      kind: "prepare_attempt",
      attempt: { definitionId: "review", conversationId: null },
    })
  })

  it("post-start resume reuses committed continuation identity and does not mint or rerun the attempt", async () => {
    const vm = driver()
    await vm.initialize()
    await vm.startAttempt("after", "conversation-stable")
    const rowsBefore = vm.events()
    const started = vm.committed.attempts[0]

    const firstResume = vm.freshState()
    const secondResume = vm.freshState()

    expect(firstResume.context.committed.attempts[0]).toEqual(started)
    expect(secondResume.context.committed.attempts[0]).toEqual(started)
    expect(secondResume.context.committed.attempts[0]?.conversationId).toBe("conversation-stable")
    expect(vm.events()).toEqual(rowsBefore)
    expect(vm.events().filter(({ type }) => type === "attempt.started")).toHaveLength(1)
  })

  it("full resume reconstructs control, graph, queue, context, and handoff views from facts alone", async () => {
    const vm = driver()
    await vm.initialize()
    await vm.startAttempt("after")
    const prepared = await vm.completeAttempt("after", { summary: "facts only" })

    const fresh = vm.freshState()
    const views = vm.freshViews()
    const events = vm.events()
    expect(fresh.context.committed).toEqual(replayWorkflowControl(events))
    expect(fresh.context.pending).toBeNull()
    expect(views.control).toEqual(fresh.context.committed)
    expect(views.queue?.attempts[0]?.id).toBe(fresh.context.committed.attempts[0]?.id)
    expect(views.queue?.attempts.map(({ status }) => status)).toEqual(["completed", "pending"])
    expect(views.context?.entries[0]?.handoff).toEqual({ summary: "facts only" })
    expect(views.handoffs[0]?.validationStatus).toBe("passed")
    expect(views.lineage.compiledWorkflow?.workflowDefinitionId).toBe("sqlite-acceptance")
    expect(prepared.command).toMatchObject({
      kind: "prepare_attempt", attempt: { definitionId: "review", conversationId: null },
    })
  })
})

type RecordedRun = (typeof arms)[keyof typeof arms]
type RecordedProvenance = { readonly _tag: string; readonly ordinal?: number; readonly itemIndex?: number }

// The node kinds and attempt provenance of control version 10, as version
// 11 reads them.
const NODE_KINDS = new Map([["step", "agent"], ["group", "list"], ["branch", "item"], ["rounds", "repeat"], ["phase", "phase"], ["while", "while"], ["for", "for"]])

function provenanceOf({ provenance, iteration }: { readonly provenance: RecordedProvenance; readonly iteration: number }) {
  switch (provenance._tag) {
    case "while": return { _tag: "round", index: iteration }
    case "for": return { _tag: "round", index: (provenance.itemIndex ?? 0) + 1 }
    case "then": return { _tag: "followUpV10" }
    case "branch": return { _tag: "item", ordinal: provenance.ordinal }
    default: return provenance
  }
}

/** The id that the current build gives a node or an attempt that the base
 *  build named. A list of version 10 that expands after the upgrade names
 *  its items and their phases as every list does. */
function currentId(id: string): string {
  return id.replace(/:branch:(\d+):stage:(\d+)/g, ":item:$1:phase:$2").replace(/:branch:(\d+)/g, ":item:$1")
}

/** Run a recorded root of the base build to completion with the base
 *  build's handoffs, and compare each attempt that the run prepared, and
 *  the final control, with what the base build recorded. */
function replayRecordedRun(recorded: RecordedRun): readonly PreparedAttempt[] {
  const root = parseWorkflowSessionFact(recorded.root)
  const facts = [root]
  const commit = (result: WorkflowTransitionResult): WorkflowTransitionResult => {
    const pending = result.state.context.pending
    if (!pending) return result
    facts.push(...pending.facts)
    return transitionWorkflow(result.state, { type: "COMMIT_SUCCEEDED", proposalId: pending.proposalId, aggregateSeq: pending.proposedCommitted.aggregateSeq })
  }
  const expected = recorded.run.map(({ attemptId, logicalNodeId, scope, ...rest }) => ({
    ...rest, attemptId: currentId(attemptId), logicalNodeId: currentId(logicalNodeId), scope: { sharedEntryIds: scope.sharedEntryIds.map(currentId) },
  }))
  const prepared: PreparedAttempt[] = []
  const running: string[] = []
  const finished = new Set<string>()
  let state = commit(transitionWorkflow(initializeWorkflow(replayWorkflowControl([root])).state, { type: "START" }))
  for (let guard = 0; guard < 500; guard += 1) {
    const command = state.command
    if (command.kind === "prepare_attempt") {
      const { attemptId, definitionId, logicalNodeId, scope, item } = command.attempt
      prepared.push({ attemptId, definitionId, logicalNodeId, sharedEntryIds: scope.sharedEntryIds ?? [], item })
      state = commit(transitionWorkflow(state.state, { type: "ATTEMPT_STARTED", attemptId, conversationId: attemptId }))
      continue
    }
    if (command.kind === "run_attempts") {
      for (const { attemptId } of command.attempts) if (!finished.has(attemptId) && !running.includes(attemptId)) running.push(attemptId)
    }
    const next = running.shift()
    if (next === undefined) break
    finished.add(next)
    const handoff = expected.find(({ attemptId }) => attemptId === next)?.handoff
    if (!handoff) throw new Error(`The base build recorded no handoff for "${next}"`)
    state = commit(transitionWorkflow(state.state, { type: "ATTEMPT_SUCCEEDED", outcome: { attemptId: next, conversationId: next, handoff, reassessment: null } }))
  }
  expect(prepared).toEqual(expected.map(({ attemptId, definitionId, logicalNodeId, scope, item }) => ({ attemptId, definitionId, logicalNodeId, sharedEntryIds: scope.sharedEntryIds, item })))
  const control = state.state.context.committed
  expect<string>(control.status).toBe(recorded.status)
  expect<unknown>(control.attempts.map(({ id, definitionId, provenance, parentAttemptId, item, iteration, state: { _tag } }) => ({ id, definitionId, provenance, parentAttemptId, item, iteration, state: _tag })))
    .toEqual(recorded.attempts.map((attempt) => ({
      ...attempt, id: currentId(attempt.id), parentAttemptId: attempt.parentAttemptId === null ? null : currentId(attempt.parentAttemptId), provenance: provenanceOf(attempt),
    })))
  expect<unknown>(control.graph.nodes.map(({ id, kind, state: { _tag } }) => ({ id, kind, state: _tag })))
    .toEqual(recorded.nodes.map((node) => ({ ...node, id: currentId(node.id), kind: NODE_KINDS.get(node.kind) })))
  expect(replayWorkflowControl(facts)).toEqual(control)
  return prepared
}

/** One attempt that the current build prepared from a recorded root. */
interface PreparedAttempt {
  readonly attemptId: string
  readonly definitionId: string
  readonly logicalNodeId: string
  readonly sharedEntryIds: readonly string[]
  readonly item: unknown
}

/** The step-grammar file of the stageReads root: a map whose second stage
 *  reads the first step. The base build recorded the root from it. */
const STAGE_READS = JSON.stringify({
  id: "reads",
  name: "Reads",
  steps: {
    scope: { name: "scope", instructions: "State the scope." },
    source: { name: "source", instructions: "List the items.", output: { fields: { items: { type: "list", max: 3, unique: "id", of: { type: "object", fields: { id: { type: "string", description: "The id." } } } } } } },
    review: { name: "review", instructions: "Review one item." },
    check: { name: "check", instructions: "Check the review against the scope.", reads: ["scope"] },
    report: { name: "report", instructions: "Report." },
  },
  flow: [{ step: "scope" }, { step: "source" }, { map: "source.items", id: "reviews", do: ["review", "check"], join: { reducer: "collect" } }, { step: "report" }],
})

describe("history arms of control version 10", () => {
  // Each root and run comes from the build before phases
  // (golden/committed-v10-history-arms.json). A run that it paused resumes
  // into these arms, so each must run to the same end.
  it.each(Object.entries(arms))("runs the %s root of the base build to the same end", (_name, arm) => {
    expect(replayRecordedRun(arm).length).toBeGreaterThan(0)
  })

  it("gives a stage of a list the output that it reads", () => {
    // The current build prepares each resumed check stage with the scope
    // output in its shared bundle.
    const check = replayRecordedRun(arms.stageReads).filter(({ definitionId }) => definitionId === "check")
    expect(check).toHaveLength(2)
    for (const { sharedEntryIds } of check) expect(sharedEntryIds).toContain("reads:node:1:attempt:1")

    // The converted definition gives the stage the read, and the context of
    // the resumed stage holds the scope handoff under it.
    const loaded = loadWorkflowFile({ file: "reads.workflow.yaml", content: STAGE_READS, location: undefined, provenance: { layer: "session", filePath: "reads.workflow.yaml" }, skills: testSkillRevision([]) })
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.diagnostics))
    const reads = resolveWorkflowAgents(loaded.workflow).get("check")?.reads ?? []
    const accumulator = createContextAccumulator()
    accumulator.seedInput({ workflowDefinitionId: "reads", userRequest: "Review.", timestamp: 1 })
    accumulator.accumulate(makeEntry({ entryId: "reads:node:1:attempt:1", agentName: "scope", definitionId: "scope", workflowDefinitionId: "reads", writes: [{ id: "scope", lifetime: "transient" }], handoff: { summary: "The scope." } }))
    for (const { attemptId, logicalNodeId, sharedEntryIds } of check) {
      const context = accumulator.getContext({ attemptId, nodeId: logicalNodeId, scope: { _tag: "item", listNodeId: "reads:node:3", itemNodeId: logicalNodeId.replace(/:phase:\d+$/, ""), key: "x", sharedEntryIds: [...sharedEntryIds], bundleOrder: true }, reads })
      expect(context.reads.map(({ id, entry }) => [id, entry.entryId, entry.handoff.summary])).toEqual([["scope", "reads:node:1:attempt:1", "The scope."]])
    }
  })
})
