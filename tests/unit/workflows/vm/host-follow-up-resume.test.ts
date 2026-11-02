import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { WorkflowProposalEventV4Schema } from "../../../../src/workflows/vm/historical-codecs.js"
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js"
import { loadQueueFromEvents } from "../../../../src/workflows/view/view-projection.js"
import { parseWorkflowSessionFact } from "../../../../src/workflows/vm/session-facts.js"
import {
  proposeFollowUpTransfer,
  replayDecodedWorkflow,
  transitionDecodedWorkflow,
} from "../../../../src/workflows/vm/transition.js"
import { createMemoryStore, initialFacts, recordHistoricalFollowUp, testHost } from "./host-test-support.js"

const transferDestination = {
  parentSessionId: "parent-session",
  parentConversationId: "parent-conversation",
  inputEntryId: "parent-input",
  turnEndEntryId: "parent-turn-end",
} as const

const queuedMappings = [
  { sourceKey: "queued:first", destinationEntryId: "parent-queued-first" },
  { sourceKey: "queued:second", destinationEntryId: "parent-queued-second" },
] as const

async function completedFollowUp() {
  const store = createMemoryStore(initialFacts())
  const host = testHost(store, {
    attemptRunner: {
      run: async (input, active) => ({
        kind: "success", attemptId: input.attemptId, conversationId: active.conversationId,
        handoff: { summary: "done" }, reassessment: null,
      }),
    },
  })
  expect((await host.run()).kind).toBe("completed")
  await host.dispose()
  await recordHistoricalFollowUp(store, { identity: { kind: "identified", inputID: "previous" }, input: { text: "previous request" } }, { settled: true })
  // A host reads the history it starts from, so the one that stands in for
  // the session's next run starts after the recorded follow-up.
  return { store, host: testHost(store, { startMode: "operator_resume" }) }
}

describe("workflow VM host historical follow-up", () => {
  // Follow-up input belongs to the parent chat. The startup migration moves
  // what history left pending there; one it could not move stays in the
  // workflow's control, and the workflow never runs it as its own turn.
  it.each(["follow_up", "paused"] as const)("refuses to run a follow-up that history left pending in %s control", async (status) => {
    const { store, host } = await completedFollowUp()
    await recordHistoricalFollowUp(
      store,
      { identity: { kind: "identified", inputID: "pending" }, input: { text: "Exact pending prompt" } },
      status === "paused" ? { pausedReason: "operator stopped pending follow-up" } : {},
    )
    await host.dispose()
    const before = replayWorkflowControl(store.events)
    expect(before.status).toBe(status)
    const start = store.events.length
    let workers = 0
    const resumed = testHost(store, {
      startMode: "operator_resume",
      attemptRunner: { run: async () => { workers += 1; throw new Error("must not run") } },
    })
    try {
      const result = await resumed.run()
      expect(result).toMatchObject({ kind: "failed", failure: { kind: "follow_up", conversationId: "conversation-1" } })
      if (result.kind === "failed") expect(result.failure.message).toContain("parent chat")
      expect(workers).toBe(0)
      // The refusal comes before any commit, so a refused Resume of paused
      // control leaves the row paused and resumable, not completed.
      expect(store.events.slice(start)).toEqual([])
      expect(replayWorkflowControl(store.events)).toEqual(before)
    } finally {
      await resumed.dispose()
    }
  })

  it("does not rerun a completed follow-up after abort and operator resume", async () => {
    const { store, host } = await completedFollowUp()
    const completed = replayWorkflowControl(store.events)
    expect(completed.followUp?.pendingInput).toBeNull()
    expect(await host.abort("close completed follow-up")).toBe(true)
    await host.dispose()
    const start = store.events.length
    const resumed = testHost(store, { startMode: "operator_resume" })
    try {
      expect((await resumed.run()).kind).toBe("completed")
      expect(replayWorkflowControl(store.events).followUp).toEqual(completed.followUp)
      expect(replayWorkflowControl(store.events).attempts).toEqual(completed.attempts)
      expect(store.events.slice(start).filter(({ type }) => type.startsWith("follow_up."))).toHaveLength(0)
    } finally {
      await resumed.dispose()
    }
  })

  // v0.0.12 wrote every commit at version 4, and a candidate build before
  // 2026-10-03 wrote every commit at version 5. Both encode the same events as
  // version 6 with the inert outcome evidence and a version 1 success fact.
  it("commits every event at version 14 and replays the same history encoded at versions 4 and 5", async () => {
    const { store, host } = await completedFollowUp()
    try {
      await recordHistoricalFollowUp(
        store,
        { identity: { kind: "identified", inputID: "pending" }, input: { text: "pending" } },
        { pausedReason: "operator stopped pending follow-up" },
      )
      const committed = store.events.filter((fact) => fact.type === "workflow.control.committed")
      expect(committed.length).toBeGreaterThan(3)
      expect(new Set(committed.map((fact) => fact.version))).toEqual(new Set([14]))
      expect(committed.some((fact) => fact.payload.event !== null && typeof fact.payload.event === "object" && "type" in fact.payload.event && fact.payload.event.type === "ATTEMPT_SUCCEEDED")).toBe(true)
      for (const version of [4, 5]) {
        const earlier = store.events.map((fact) => {
          if (fact.type === "attempt.succeeded") return { ...fact, version: 1, payload: { ...fact.payload, evidence: [] } }
          if (fact.type !== "workflow.control.committed") return fact
          const event: unknown = fact.payload.event
          const encoded = event !== null && typeof event === "object" && "type" in event && event.type === "ATTEMPT_SUCCEEDED" && "outcome" in event && event.outcome !== null && typeof event.outcome === "object"
            ? { ...event, outcome: { ...event.outcome, evidence: [] } }
            : event
          return { ...fact, version, payload: { ...fact.payload, event: encoded } }
        })
        expect(earlier.some((fact) => fact.type === "attempt.succeeded" && fact.version === 1)).toBe(true)
        expect(replayWorkflowControl(earlier)).toEqual(replayWorkflowControl(store.events))
      }
    } finally {
      await host.dispose()
    }
  })

  // A version 4 commit stays readable by v0.0.12 only while the union it
  // encodes is the one v0.0.12 declares. The pin is the sha256 of the JSON
  // Schema document of v0.0.12's `WorkflowProposalEventSchema`, made with
  // this repository's Effect from `git archive v0.0.12 src`. An Effect
  // upgrade can change the document: regenerate the pin from that source
  // then, never from this tree.
  it("keeps the version 4 event union identical to the one v0.0.12 reads", () => {
    const document = JSON.stringify(Schema.toJsonSchemaDocument(WorkflowProposalEventV4Schema))
    expect(new Bun.CryptoHasher("sha256").update(document).digest("hex")).toBe("72c9be6e84621e631fca285d0a8ee9cd862b86f9e2da5708206d324c1bb61277")
  })

  it.each(["follow_up", "paused"] as const)("proposes transfer from a pending %s control without executing work", async (status) => {
    const { store, host } = await completedFollowUp()
    try {
      await recordHistoricalFollowUp(store, {
        identity: { kind: "identified", inputID: "pending-transfer" },
        input: { text: "Move this accepted input" },
      }, status === "paused" ? { pausedReason: "migration transfer" } : {})

      const before = replayWorkflowControl(store.events)
      expect(before.status).toBe(status)
      const beforeFollowUp = before.followUp
      if (!beforeFollowUp) throw new Error("Expected pending follow-up control")
      const source = {
        conversationId: "conversation-1",
        requestSequence: 2,
        identity: { kind: "identified", inputID: "pending-transfer" },
      } as const
      const queue = loadQueueFromEvents(store.events)
      const transfer = proposeFollowUpTransfer(before, queue, {
        source,
        destination: transferDestination,
        queuedMappings,
      })

      expect(transfer.event).toEqual({
        type: "FOLLOW_UP_TRANSFERRED",
        source,
        destination: transferDestination,
        queuedMappings,
      })
      // The proposal carries the queue view restated from control, as every
      // control commit does. Only the paused queue differs from completed.
      const restated: [string, number][] = status === "paused" ? [["queue.state.changed", 2]] : []
      expect(transfer.proposal.facts.map(({ type, version }): [string, number] => [type, version])).toEqual([
        ...restated,
        ["follow_up.transferred", 1],
        ["workflow.control.committed", 14],
      ])
      expect(queue?.status).toBe(status === "paused" ? "paused" : "completed")
      expect(parseWorkflowSessionFact(transfer.proposal.facts[restated.length])).toEqual({
        type: "follow_up.transferred",
        version: 1,
        actor: "flywheel",
        payload: { source, destination: transferDestination, queuedMappings },
      })
      expect(transfer.proposedControl).toEqual({
        ...before,
        status: "completed",
        followUp: { ...beforeFollowUp, pendingInput: null },
        aggregateSeq: before.aggregateSeq + 2 + restated.length,
      })

      const historicalFacts = store.events.map(({ type, version, actor, payload }) => ({ type, version, actor, payload }))
      const replayed = replayWorkflowControl([...historicalFacts, ...transfer.proposal.facts])
      expect(replayed).toEqual(transfer.proposedControl)
      expect(replayed.attempts).toEqual(before.attempts)
      expect(replayed.followUp).toEqual({
        conversationId: "conversation-1",
        requestSequence: 2,
        identity: { kind: "identified", inputID: "pending-transfer" },
        pendingInput: null,
      })
      const { aggregateId, sessionId } = store.events[0] ?? {}
      if (!aggregateId || !sessionId) throw new Error("Expected workflow facts")
      await store.appendBatch(transfer.proposal.facts.map((fact) => ({ ...fact, aggregateId, sessionId, timestamp: Date.now() })))
      expect(loadQueueFromEvents(store.events)).toMatchObject({ status: "completed", followUpConversationId: "conversation-1" })
    } finally {
      await host.dispose()
    }
  })

  it("rejects a mismatched source identity and a repeated transfer", async () => {
    const { store, host } = await completedFollowUp()
    try {
      await recordHistoricalFollowUp(store, {
        identity: { kind: "identified", inputID: "pending-transfer" },
        input: { text: "Move this accepted input" },
      })
      const before = replayWorkflowControl(store.events)
      const input = {
        source: {
          conversationId: "conversation-1",
          requestSequence: 2,
          identity: { kind: "identified", inputID: "pending-transfer" },
        },
        destination: transferDestination,
        queuedMappings,
      } as const

      for (const source of [
        { ...input.source, conversationId: "other-conversation" },
        { ...input.source, requestSequence: 1 },
        { ...input.source, identity: { kind: "identified" as const, inputID: "other-input" } },
      ]) {
        expect(() => proposeFollowUpTransfer(before, loadQueueFromEvents(store.events), { ...input, source })).toThrow("source does not match")
      }

      const transferred = proposeFollowUpTransfer(before, loadQueueFromEvents(store.events), input)
      expect(() => proposeFollowUpTransfer(transferred.proposedControl, null, input)).toThrow("pending follow-up")
      const committed = transferred.proposal.facts.at(-1)
      if (!committed || committed.type !== "workflow.control.committed") throw new Error("Expected terminal workflow control fact")
      expect(() => parseWorkflowSessionFact({ ...committed, version: 4 })).toThrow()
      expect(() => parseWorkflowSessionFact({
        ...transferred.proposal.facts[0],
        payload: { ...transferred.event, type: undefined },
      })).toThrow()
    } finally {
      await host.dispose()
    }
  })

  it("replays a historical pending request followed by its transfer", async () => {
    const { store, host } = await completedFollowUp()
    await host.dispose()
    const completed = replayWorkflowControl(store.events)
    const requested = transitionDecodedWorkflow(replayDecodedWorkflow(completed), {
      type: "FOLLOW_UP_REQUESTED",
      input: { text: "Historical accepted input" },
      identity: { kind: "historical" },
      conversationId: "conversation-1",
      requestSequence: 2,
    }, 2)
    if (requested.command.kind !== "commit") throw new Error("Expected historical follow-up proposal")
    expect(requested.command.proposal.facts.map(({ type, version }) => [type, version])).toEqual([
      ["follow_up.requested", 1],
      ["workflow.control.committed", 2],
    ])
    const facts = [
      ...store.events.map(({ type, version, actor, payload }) => ({ type, version, actor, payload })),
      ...requested.command.proposal.facts,
    ]
    const before = replayWorkflowControl(facts)
    const transfer = proposeFollowUpTransfer(before, null, {
      source: {
        conversationId: "conversation-1",
        requestSequence: 2,
        identity: { kind: "historical" },
      },
      destination: transferDestination,
      queuedMappings,
    })
    const replayed = replayWorkflowControl([...facts, ...transfer.proposal.facts])

    expect(replayed.status).toBe("completed")
    expect(replayed.followUp).toEqual({
      conversationId: "conversation-1",
      requestSequence: 2,
      identity: { kind: "historical" },
      pendingInput: null,
    })
    expect(replayed.attempts).toEqual(before.attempts)
  })
})
