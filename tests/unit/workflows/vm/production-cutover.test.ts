import { afterEach, describe, expect, it } from "bun:test"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { createWorkflowContextStore } from "../../../../src/workflows/context-bundle/context-store.js"
import { createWorkflowViewStore } from "../../../../src/workflows/view/view-store.js"
import { testSkillRevision } from "../../../helpers/skill-fixtures.js"
import type { WorkflowDefinition } from "../../../../src/workflows/workflow-schema.js"
import { createAttemptExecutor } from "../../../../src/workflows/vm/attempt-runner.js"
import { createWorkflowVmHost } from "../../../../src/workflows/vm/host.js"
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js"
import { SqliteVmDriver } from "./_sqlite-vm-driver.js"

const drivers: SqliteVmDriver[] = []

afterEach(() => {
  for (const driver of drivers.splice(0)) driver.close()
})

function workflowStores(vm: SqliteVmDriver) {
  const reader = asAsyncEventReadSurface(vm.store)
  return {
    queueStore: createWorkflowViewStore({ sessionId: vm.sessionId, reader }),
    contextStore: createWorkflowContextStore({ sessionId: vm.sessionId, reader }),
  }
}

describe("workflow VM production cutover", () => {
  it("runs confirmed and adjusted reassessment of a repeat's items through the production host", async () => {
    const workflow: WorkflowDefinition = {
      id: "production-reassessment",
      name: "Production reassessment",
      phases: [
        { phase: "source", brief: "Do the source work.", name: "source", output: { summary: "The plan.", fields: { milestones: { type: "list", description: "The milestones.", max: 5, unique: "id", of: milestoneItem() } } }, writes: [] },
        {
          repeat: { each: "source.milestones", reassess: "reassess" },
          phases: [
            { phase: "implement", brief: "Do the implement work.", name: "implement", writes: [] },
            { phase: "reassess", brief: "Do the reassess work.", name: "reassess", writes: [] },
          ],
        },
        { phase: "tail", brief: "Do the tail work.", name: "tail", writes: [] },
      ],
    }
    const vm = new SqliteVmDriver({
      workflow,
      skills: testSkillRevision([]),
    })
    drivers.push(vm)
    await vm.initialize()
    const milestones = [milestone("m-1"), milestone("m-2"), milestone("m-3")]
    const stores = workflowStores(vm)
    const executed: string[] = []
    let reassessments = 0
    const runner = createAttemptExecutor({
      earlierCheckpoint: async () => null,
      resolvedAgents: vm.bindings,
      skills: vm.skills,
      context: stores.contextStore,
      worker: async (step) => {
        const itemId = step.item && typeof step.item === "object" && !Array.isArray(step.item) && "id" in step.item
          ? step.item.id
          : null
        executed.push(itemId !== null && step.definitionId === "implement" ? `${step.definitionId}:${String(itemId)}` : step.definitionId)
        if (step.definitionId === "source") {
          return { output: "completed", handoffContent: { milestones }, durationMs: 1 }
        }
        if (step.definitionId !== "reassess") {
          return { output: "completed", handoffContent: { summary: "done" }, durationMs: 1 }
        }
        reassessments += 1
        const handoffContent = reassessments === 1
          ? {
              summary: "Replace milestone 2 and add milestone 3b.",
              changes: [
                { action: "replace", item_id: "m-2", item: milestone("m-2-revised") },
                { action: "insert", item_id: "m-1", item: milestone("m-3b") },
              ],
            }
          : reassessments === 2
            ? {
                summary: "Milestone 3 is no longer required.",
                changes: [{ action: "drop", item_id: "m-3" }],
              }
            : {
                summary: "The remaining work is correct.",
                changes: [],
              }
        return { output: "completed", handoffContent, durationMs: 1 }
      },
      recordInvocation: async () => {},
    })
    const host = createWorkflowVmHost({
      servedConversations: async () => new Set(),
      requestAddenda: async () => [],
      startMode: "launch",
      sessionId: vm.sessionId,
      reader: asAsyncEventReadSurface(vm.store),
      writer: asAsyncEventWriter(vm.store),
      ...stores,
      definitionRevision: vm.definitionRevision,
      workflow,
      conversationId: (input) => `conversation-${input?.attemptId ?? "follow-up"}`,
      attemptRunner: runner,
      emit: () => {},
    })

    const result = await host.run()

    expect(result.kind, result.kind === "failed" ? result.failure.message : "").toBe("completed")
    expect(executed).toEqual([
      "source",
      "implement:m-1",
      "reassess",
      "implement:m-3b",
      "reassess",
      "implement:m-2-revised",
      "reassess",
      "tail",
    ])
    const repeat = replayWorkflowControl(vm.events()).graph.nodes.find(({ kind }) => kind === "repeat")
    expect(repeat?.kind === "repeat" && repeat.loop._tag === "each" ? repeat.loop.items?.map((item) => item !== null && typeof item === "object" && !Array.isArray(item) && "id" in item ? item.id : null) : null)
      .toEqual(["m-1", "m-3b", "m-2-revised"])
    expect(vm.events().filter(({ type }) => type === "workflow.reassessed")).toHaveLength(2)
  })
})

/** The item type of the source phase's milestones, the shape `milestone` builds. */
function milestoneItem() {
  const text = (description: string) => ({ type: "string", description }) as const
  const texts = (description: string) => ({ type: "list", description, of: { type: "string" } }) as const
  return {
    type: "object",
    fields: {
      id: text("The milestone id."),
      goal: text("What the milestone delivers."),
      files: texts("Files the milestone touches."),
      verification: text("How the milestone is verified."),
    },
  } as const
}

function milestone(id: string) {
  return { id, goal: `Implement ${id}`, files: ["src/x.ts"], verification: "bun run test" }
}
