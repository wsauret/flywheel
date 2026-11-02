import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { WorkflowDefinitionSchema } from "../../../../src/workflows/workflow-schema.js"
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js"
import { createMemoryStore, initialFacts, recordProposal, sequentialWorkflow, testHost } from "./host-test-support.js"

// A later step shows the file edits of an earlier attempt from every
// conversation that the attempt's tool calls ran in. The host names them from
// its own committed facts.
describe("workflow host attempt conversations", () => {
  it("names the first conversation of an attempt that a recorded run resumed after a context overflow", async () => {
    // A run of encoding 7 or earlier paused at a context overflow and cleared
    // the attempt's conversation, so its Resume opened a second one. From
    // encoding 8 the overflow fails the step, but stored runs keep the pause.
    const store = createMemoryStore(initialFacts())
    await recordProposal(store, { type: "START" })
    const attemptId = replayWorkflowControl(store.events).attempts[0]!.id
    await recordProposal(store, { type: "ATTEMPT_STARTED", attemptId, conversationId: "conversation-before-overflow" })
    await recordProposal(store, {
      type: "ATTEMPT_FAILED",
      failure: { attemptId, kind: "context_overflow", reason: "too large", conversationId: "conversation-before-overflow" },
    }, 7)
    expect(replayWorkflowControl(store.events)).toMatchObject({ status: "paused", attempts: [{ state: { _tag: "pending" }, conversationId: null }] })

    let named: readonly string[] = []
    const resumed = testHost(store, {
      startMode: "operator_resume",
      conversationId: () => "conversation-after-overflow",
      attemptRunner: {
        run: async (input, active) => {
          named = await active.conversationsOf(input.attemptId)
          return { kind: "success", attemptId: input.attemptId, conversationId: active.conversationId, handoff: { summary: "resumed" }, reassessment: null }
        },
      },
    })
    expect((await resumed.run()).kind).toBe("completed")
    expect(named).toEqual(["conversation-before-overflow", "conversation-after-overflow"])
    await resumed.dispose()
  })

  it("names the conversations of the attempts that a retry replaced, oldest first", async () => {
    const workflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
      ...sequentialWorkflow,
      phases: sequentialWorkflow.phases.map((phase) => "phase" in phase && phase.phase === "work" ? { ...phase, retry: { max: 2, stuck: false } } : phase),
    })
    const store = createMemoryStore(initialFacts(workflow))
    const workAttempts: string[] = []
    let named: readonly string[] = []
    const host = testHost(store, {
      workflow,
      conversationId: (input) => `conversation-${input?.attemptId}`,
      attemptRunner: {
        run: async (input, active) => {
          if (input.definitionId === "work") {
            workAttempts.push(input.attemptId)
            if (workAttempts.length === 1) return { kind: "handoff", attemptId: input.attemptId, conversationId: active.conversationId, reason: "Missing evidence" }
          } else {
            named = await active.conversationsOf(workAttempts.at(-1)!)
          }
          return { kind: "success", attemptId: input.attemptId, conversationId: active.conversationId, handoff: { summary: input.definitionId }, reassessment: null }
        },
      },
    })
    expect((await host.run()).kind).toBe("completed")
    expect(workAttempts).toHaveLength(2)
    expect(named).toEqual(workAttempts.map((attemptId) => `conversation-${attemptId}`))
    await host.dispose()
  })
})
