import { describe, expect, test } from "bun:test"
import { asAsyncEventReadSurface, type StoredFact } from "../../../../../src/infra/event-store-types.js"
import { InvariantViolation } from "../../../../../src/infra/invariant.js"
import { parseSubagentRunFact, type SubagentRunFact } from "../../../../../src/orchestration/modules/subagents/facts.js"
import { buildDurableSubagentCreated, buildSubagentCompleted, buildSubagentPaused, buildSubagentResumed } from "../../../../../src/orchestration/modules/subagents/history/subagent-run-fact-writers.js"
import { loadSubagentRunsFromEvents } from "../../../../../src/orchestration/modules/subagents/history/subagent-run-projection.js"
import { createSubagentToolSummaryReader } from "../../../../../src/orchestration/modules/subagents/history/tool-summary.js"
import { interruptedTurnEnd, interruptedTurnMessage, turnEndEntryId } from "../../../../../src/orchestration/session/conversation/turn-end-record.js"
import { inMemoryEventReader } from "../../../../helpers/in-memory-event-reader.js"

const CHILD = "child-1"
const PARENT = "parent-1"

function created(selection: { model?: string } = { model: "test-model" }): SubagentRunFact {
  return buildDurableSubagentCreated({
    childSessionId: CHILD,
    childRunId: "run-1",
    conversationId: "child-conversation",
    parentSessionId: PARENT,
    parentConversationId: "parent-conversation",
    parentToolCallId: "tool-1",
    persona: { name: "explorer", kind: "persona" },
    capabilityGrant: { operation: "subagent", required: [], capabilities: [], moduleIds: [], requireWorkflowConfirmation: false, workflowsMode: "off", identity: "grant" },
    admittedModuleIds: [],
    skillsRevision: 1,
    ...selection,
    tools: ["read"],
    executionCwd: "/work/app",
    budget: { maxTurns: 10, maxTokens: 0 },
    parentDepth: 0,
    description: "Fixture child",
  })
}

/** Facts stored on the child aggregate, in order, with the timestamps a fold reads. */
function stored(facts: readonly SubagentRunFact[], sessionId = CHILD): StoredFact[] {
  return facts.map((fact, index) => ({
    ...fact,
    id: `e-${index + 1}`,
    position: index + 1,
    seq: index,
    aggregateId: `session:${sessionId}`,
    sessionId,
    timestamp: 1000 + index,
  }))
}

describe("child_run.created", () => {
  // Runs recorded before 2026-10-09 name the retired Claude subscription
  // module, which the Agent SDK provider replaced. Remove after 2027-04-09
  // with the conversion.
  test("reads a run that names the retired Claude subscription module as one that names the Agent SDK provider once", () => {
    const fact = created()
    if (fact.type !== "child_run.created" || fact.version !== 3) throw new Error("Expected a current child run")
    const recorded = ["subagents", "provider-claude-subscription", "provider-claude-agent-sdk"]
    const [row] = stored([fact])
    const runs = loadSubagentRunsFromEvents([{
      ...row!,
      version: 2,
      payload: {
        ...fact.payload,
        capabilityGrant: { ...fact.payload.capabilityGrant, required: ["provider-claude-subscription"], capabilities: recorded, moduleIds: recorded },
        admittedModuleIds: ["provider-claude-subscription", "subagents"],
      },
    }])

    expect(runs).toHaveLength(1)
    expect(runs[0]?.capabilityGrant).toMatchObject({
      required: ["provider-claude-agent-sdk"],
      capabilities: ["provider-claude-agent-sdk", "subagents"],
      moduleIds: ["provider-claude-agent-sdk", "subagents"],
    })
    expect(runs[0]?.admittedModuleIds).toEqual(["provider-claude-agent-sdk", "subagents"])
  })

  // Remove with the retired module-id conversion after 2027-04-30.
  test.each([["adhoc-workflows"], ["adhoc-workflows", "workflows"]])("reads stored workflow module ids %j as Workflows once", (...recorded) => {
    const fact = created()
    if (fact.type !== "child_run.created" || fact.version !== 3) throw new Error("Expected a current child run")
    const [row] = stored([fact])
    const runs = loadSubagentRunsFromEvents([{
      ...row!,
      version: 2,
      payload: {
        ...fact.payload,
        capabilityGrant: { ...fact.payload.capabilityGrant, required: recorded, capabilities: recorded, moduleIds: recorded },
        admittedModuleIds: recorded,
      },
    }])
    expect(runs).toHaveLength(1)
    expect(runs[0]?.capabilityGrant).toMatchObject({ required: ["workflows"], capabilities: ["workflows"], moduleIds: ["workflows"] })
    expect(runs[0]?.admittedModuleIds).toEqual(["workflows"])
  })
})

describe("subagent.paused", () => {
  test("round-trips through the fact schema with who paused it", () => {
    const fact = buildSubagentPaused({ childRunId: "run-1", pausedBy: "person" })
    expect(parseSubagentRunFact(fact)).toEqual({ type: "subagent.paused", version: 1, actor: "flywheel", payload: { childRunId: "run-1", pausedBy: "person" } })
    expect(() => parseSubagentRunFact({ ...fact, payload: { childRunId: "run-1", pausedBy: "nobody" } })).toThrow()
  })

  test.each([true, false])("a created run keeps its binding across pause and resume, with or without a model preview: %s", (selected) => {
    const start = selected ? created() : created({})
    const paused = loadSubagentRunsFromEvents(stored([start, buildSubagentPaused({ childRunId: "run-1", pausedBy: "runtime" })]))
    expect(paused).toHaveLength(1)
    expect(paused[0]).toMatchObject({ status: "paused", pausedBy: "runtime", pausedAt: 1001, pauseEventId: "e-2", parentToolCallId: "tool-1" })
    expect(paused[0]?.model).toBe(selected ? "test-model" : undefined)

    const resumed = loadSubagentRunsFromEvents(stored([
      start,
      buildSubagentPaused({ childRunId: "run-1", pausedBy: "person" }),
      buildSubagentResumed({ childRunId: "run-1", authorizationId: "explicit:tool-1", continuation: 1 }),
    ]))
    expect(resumed[0]).toMatchObject({ status: "created", continuationCount: 1 })
    expect(resumed[0]?.model).toBe(selected ? "test-model" : undefined)
    expect(resumed[0]?.pausedBy).toBeUndefined()
    expect(resumed[0]?.pausedAt).toBeUndefined()
  })

  test("a Stop ends a paused run: the run is stopped and no longer reads as paused", () => {
    const runs = loadSubagentRunsFromEvents(stored([
      created(),
      buildSubagentPaused({ childRunId: "run-1", pausedBy: "person" }),
      buildSubagentCompleted({ childRunId: "run-1", status: "stopped", isError: true, content: "Subagent 'explorer' (Fixture child) was stopped by the user.", durationMs: 0 }),
    ]))
    expect(runs[0]).toMatchObject({ status: "stopped", completedAt: 1002 })
    expect(runs[0]?.pausedBy).toBeUndefined()
    expect(runs[0]?.pausedAt).toBeUndefined()
  })

  test("only a running run can be paused", () => {
    const twice = stored([
      created(),
      buildSubagentPaused({ childRunId: "run-1", pausedBy: "person" }),
      buildSubagentPaused({ childRunId: "run-1", pausedBy: "person" }),
    ])
    expect(() => loadSubagentRunsFromEvents(twice)).toThrow(InvariantViolation)
  })

  test("the parent's card summary says who paused the child and reads a created run as active", async () => {
    const linked: StoredFact = {
      id: "p-1", position: 1, seq: 0, aggregateId: `session:${PARENT}`, sessionId: PARENT, timestamp: 999, actor: "flywheel",
      type: "session.child.linked", version: 1,
      payload: { childSessionId: CHILD, lastUpdated: "2026-09-21T00:00:00.000Z" },
    }
    const runFacts = stored([created(), buildSubagentPaused({ childRunId: "run-1", pausedBy: "person" })]).map((fact) => ({ ...fact, position: fact.position + 1 }))
    const paused = (await createSubagentToolSummaryReader(asAsyncEventReadSurface(inMemoryEventReader([linked, ...runFacts])), PARENT).replay()).summaries.get("tool-1")
    expect(paused).toMatchObject({ status: "paused", pausedBy: "person", ownsSettlement: true, linkUri: `flywheel://session/${CHILD}` })

    // A created run is owned by a live child: a crash converts it to interrupted
    // and a shutdown to paused before any fold reads it, so a client that attaches
    // while the child runs sees the same active card as the client that was there.
    const running = (await createSubagentToolSummaryReader(asAsyncEventReadSurface(inMemoryEventReader([linked, ...runFacts.slice(0, 1)])), PARENT).replay()).summaries.get("tool-1")
    expect(running).toMatchObject({ status: "active" })
  })

  test("a planned replacement's cut, which the child's own turn end records, keeps the parent's card active", async () => {
    const linked: StoredFact = {
      id: "p-1", position: 1, seq: 0, aggregateId: `session:${PARENT}`, sessionId: PARENT, timestamp: 999, actor: "flywheel",
      type: "session.child.linked", version: 1,
      payload: { childSessionId: CHILD, lastUpdated: "2026-09-21T00:00:00.000Z" },
    }
    const [createdFact, pausedFact] = stored([created(), buildSubagentPaused({ childRunId: "run-1", pausedBy: "runtime" })])
    const timestamp = "2026-09-25T00:00:00.000Z"
    const plannedTurnEnd: StoredFact = {
      id: "c-1", position: 3, seq: 0, aggregateId: "conversation:child-conversation", sessionId: CHILD, timestamp: 1001, actor: "flywheel",
      type: "chat.entries.appended", version: 1,
      payload: { conversationId: "child-conversation", entries: [
        { kind: "message", id: "u-1", parentId: null, timestamp, message: { kind: "user", content: "investigate" } },
        { kind: "message", id: turnEndEntryId(interruptedTurnEnd("replacement"), "k"), parentId: "u-1", timestamp, message: { kind: "user", content: interruptedTurnMessage("runtime", true), origin: "system" } },
      ] },
    }
    const facts: StoredFact[] = [linked, { ...createdFact!, position: 2 }, plannedTurnEnd, { ...pausedFact!, position: 4 }]
    const reader = createSubagentToolSummaryReader(asAsyncEventReadSurface(inMemoryEventReader(facts)), PARENT)
    const summary = (await reader.replay()).summaries.get("tool-1")
    expect(summary).toMatchObject({ status: "active" })

    // A person's interrupt of the waiting child records their turn end over
    // the cut, and the card says the person interrupted it.
    const personTurnEnd: StoredFact = {
      id: "c-2", position: 5, seq: 1, aggregateId: "conversation:child-conversation", sessionId: CHILD, timestamp: 1002, actor: "flywheel",
      type: "chat.entries.appended", version: 1,
      payload: { conversationId: "child-conversation", entries: [
        { kind: "message", id: turnEndEntryId(interruptedTurnEnd("person"), "k2"), parentId: turnEndEntryId(interruptedTurnEnd("replacement"), "k"), timestamp, message: { kind: "user", content: interruptedTurnMessage("person", false), origin: "system" } },
      ] },
    }
    facts.push(personTurnEnd)
    const interrupted = (await reader.replay()).summaries.get("tool-1")
    expect(interrupted).toMatchObject({ status: "paused", pausedBy: "person" })
  })
})
