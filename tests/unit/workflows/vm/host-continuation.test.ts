import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { WorkflowDefinitionSchema } from "../../../../src/workflows/workflow-schema.js"
import {
  createMemoryStore,
  initialFacts,
  sequentialWorkflow,
  testHost,
  workflow as singleWorkflow,
} from "./host-test-support.js"

const retry = { max: 2, stuck: true }
const [work, review] = sequentialWorkflow.phases

describe("workflow VM host phases in order", () => {
  it.each(["context_overflow", "fatal"] as const)("reopens %s in a new conversation without a new charge", async (kind) => {
    const store = createMemoryStore(initialFacts(singleWorkflow))
    const starts: Array<{ attemptId: string; conversationId: string }> = []
    const first = testHost(store, { conversationId: (input) => `conversation-${input?.attemptId}`, attemptRunner: {
      run: async (input, active) => {
        starts.push({ attemptId: input.attemptId, conversationId: active.conversationId })
        return { kind, attemptId: input.attemptId, conversationId: active.conversationId, reason: "failed" }
      },
    } })
    expect((await first.run()).kind).toBe("failed")
    await first.dispose()
    const second = testHost(store, { startMode: "operator_resume", conversationId: (input) => `conversation-${input?.attemptId}`, attemptRunner: {
      run: async (input, active) => {
        starts.push({ attemptId: input.attemptId, conversationId: active.conversationId })
        return { kind: "success", attemptId: input.attemptId, conversationId: active.conversationId, handoff: { summary: "fixed" }, reassessment: null }
      },
    } })
    try {
      expect((await second.run()).kind).toBe("completed")
      expect(starts).toHaveLength(2)
      expect(starts[1]?.attemptId).not.toBe(starts[0]?.attemptId)
      expect(starts[1]?.conversationId).not.toBe(starts[0]?.conversationId)
    } finally { await second.dispose() }
  })
  it.each<{ name: string; repeated: boolean; failures: number[]; expected: string[] }>([
    { name: "phases", repeated: false, failures: [], expected: ["work", "review"] },
    { name: "phases after a retry of the first", repeated: false, failures: [0], expected: ["work", "work", "review"] },
    { name: "phases that run one brief twice", repeated: true, failures: [], expected: ["work", "work-2", "review", "review-2"] },
    { name: "retries of phases that run one brief twice", repeated: true, failures: [0, 2, 5], expected: ["work", "work", "work-2", "work-2", "review", "review-2", "review-2"] },
  ])("completes only after its $name", async ({ repeated, failures, expected }) => {
    const workflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
      ...sequentialWorkflow,
      phases: repeated
        ? [{ ...work, retry }, { phase: "work-2", runs: "work", name: "Work again", writes: [], retry }, { ...review, retry }, { phase: "review-2", runs: "review", name: "Review again", writes: [], retry }]
        : [{ ...work, retry }, { ...review, retry }],
    })
    const store = createMemoryStore(initialFacts(workflow))
    const calls: string[] = []
    const host = testHost(store, {
      workflow,
      conversationId: (input) => `conversation-${input?.attemptId}`,
      attemptRunner: {
        run: async (input, active) => {
          expect(store.events.some(({ type }) => type === "workflow.completed")).toBe(false)
          const call = calls.length
          calls.push(input.definitionId)
          if (failures.includes(call)) {
            return { kind: "handoff", attemptId: input.attemptId, conversationId: active.conversationId, reason: "Missing required evidence" }
          }
          return {
            kind: "success", attemptId: input.attemptId, conversationId: active.conversationId,
            handoff: { summary: input.definitionId }, reassessment: null,
          }
        },
      },
    })
    try {
      const result = await host.run()
      expect(calls).toEqual(expected)
      expect(result.kind).toBe("completed")
      expect(result.view?.attempts.map(({ definitionId, status }) => ({ definitionId, status }))).toEqual(
        expected.map((definitionId, index) => ({ definitionId, status: failures.includes(index) ? "failed" : "completed" })),
      )
      expect(store.events.filter(({ type }) => type === "workflow.completed")).toHaveLength(1)
    } finally {
      await host.dispose()
    }
  })
})
