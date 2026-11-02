import { describe, expect, test } from "bun:test"
import { handleWorkflowMutation, handleWorkflowOperation, type WorkflowMutationDeps, type WorkflowOperationDeps } from "../../../../src/orchestration/app-service/workflow-mutations.js"
import { asAsyncEventReadSurface } from "../../../../src/infra/event-store-types.js"
import { createMemoryStore } from "../../workflows/vm/host-test-support.js"
import { fourLaneControl, wideBindings } from "../../workflows/vm/_tree-fixtures.js"
import { flattenWorkflowView } from "../../../../src/workflows/vm/view-flatten.js"
import { queueFactsForState } from "../../../../src/workflows/view/view-diff.js"
import { buildWorkflowControlInitializedFact } from "../../../../src/workflows/vm/session-facts.js"
import { WHOLE_WORKFLOW, type WorkflowDeliveryAddress } from "../../../../src/orchestration/session/conversation/addressed-workflow-messages.js"

const projectionReader = asAsyncEventReadSurface(createMemoryStore([]))

type FakeControllerOverrides = Partial<WorkflowMutationDeps["controller"]>

function fakeController(overrides: FakeControllerOverrides = {}): WorkflowMutationDeps["controller"] & {
  readonly resumes: string[]
} {
  const resumes: string[] = []
  return {
    resumes,
    resumeWorkflow: async (sessionId) => {
      resumes.push(sessionId)
      return { kind: "resumed", sessionId }
    },
    restartWorkflow: async (sessionId) => ({ kind: "restarted", sessionId }),
    ...overrides,
  }
}

describe("workflow app-service commands", () => {
  test("both controls resolve targets once and refuse invalid targets before acting", async () => {
    const control = fourLaneControl()
    const queue = flattenWorkflowView(control, wideBindings)
    const root = buildWorkflowControlInitializedFact(control)
    const reader = asAsyncEventReadSurface(createMemoryStore([root, ...queueFactsForState(null, queue)].map((fact) => ({
      ...fact, aggregateId: "workflow:wf-targets", sessionId: "wf-targets", timestamp: 1,
    }))))
    const resumed: WorkflowDeliveryAddress[] = []
    const interrupted: { by: string; address: WorkflowDeliveryAddress | undefined }[] = []
    const controller = fakeController({ resumeWorkflow: async (sessionId, address = WHOLE_WORKFLOW) => {
      resumed.push(address)
      return { kind: "resumed", sessionId }
    } })
    const operationDeps = {
      projectionReader: reader,
      supervisor: { interruptSession: async (_id: string, by: "person" | "agent", address?: WorkflowDeliveryAddress) => {
        interrupted.push({ by, address })
        return true
      } },
    }
    for (const targets of [["t2"], undefined, []]) {
      expect(await handleWorkflowMutation({ type: "workflow.resume", workflowId: "wf-targets", ...(targets === undefined ? {} : { targets }) }, { controller, projectionReader: reader })).toMatchObject({ ok: true })
      expect(await handleWorkflowOperation({ type: "workflow.interrupt", workflowId: "wf-targets", ...(targets === undefined ? {} : { targets }) }, operationDeps)).toEqual({ kind: "interrupt", interrupted: true })
    }
    expect(resumed[0]).toEqual({ addressedTo: [{ _tag: "item", listNodeId: "input-mapped:node:1", itemNodeId: "input-mapped:node:1:item:2", key: "t2" }], label: "item t2" })
    expect(interrupted).toEqual(resumed.map((address) => ({ by: "person", address })))
    expect(resumed.slice(1)).toEqual([WHOLE_WORKFLOW, WHOLE_WORKFLOW])
    for (const target of ["unknown", "t1"]) {
      const resume = await handleWorkflowMutation({ type: "workflow.resume", workflowId: "wf-targets", targets: [target] }, { controller, projectionReader: reader })
      const interrupt = await handleWorkflowOperation({ type: "workflow.interrupt", workflowId: "wf-targets", targets: [target] }, operationDeps)
      expect(resume).toMatchObject({ ok: false })
      expect(interrupt).toMatchObject({ kind: "interrupt", interrupted: false })
      if (resume.ok || interrupt.kind !== "interrupt") throw new Error("Invalid targets reached control")
      expect(interrupt.reason).toBe(resume.error)
      expect(interrupt.reason).toContain("- t2 |")
    }
    expect(resumed).toHaveLength(3)
    expect(interrupted).toHaveLength(3)
    // A second list whose item has the same key makes the key ambiguous.
    const second = (id: string) => `second:${id}`
    const duplicate = { ...queue, tree: { ...queue.tree, nodes: [
      ...queue.tree.nodes,
      ...queue.tree.nodes.filter(({ id }) => id.startsWith("input-mapped:node:1")).map((node) => {
        const moved = { ...node, id: second(node.id), parentId: node.parentId === null ? null : second(node.parentId) }
        if (moved.kind === "phase" && moved.list !== undefined) return { ...moved, list: { ...moved.list, id: second(moved.list.id) } }
        if (moved.kind === "agent" && moved.item !== undefined) return { ...moved, item: { ...moved.item, nodeId: second(moved.item.nodeId) } }
        return moved
      }),
    ] } }
    const ambiguousReader = asAsyncEventReadSurface(createMemoryStore([root, ...queueFactsForState(null, duplicate)].map((fact) => ({
      ...fact, aggregateId: "workflow:wf-targets", sessionId: "wf-targets", timestamp: 1,
    }))))
    for (const [targetReader, reason] of [[ambiguousReader, "more than one"], [asAsyncEventReadSurface(createMemoryStore([])), "no workflow queue"]] as const) {
      const resume = await handleWorkflowMutation({ type: "workflow.resume", workflowId: "wf-targets", targets: ["t2"] }, { controller, projectionReader: targetReader })
      const interrupt = await handleWorkflowOperation({ type: "workflow.interrupt", workflowId: "wf-targets", targets: ["t2"] }, { ...operationDeps, projectionReader: targetReader })
      if (resume.ok || interrupt.kind !== "interrupt") throw new Error("Unavailable targets reached control")
      expect(interrupt.interrupted).toBe(false)
      expect(interrupt.reason).toBe(resume.error)
      expect(interrupt.reason).toContain(reason)
    }
    expect(resumed).toHaveLength(3)
    expect(interrupted).toHaveLength(3)
  })
  test("workflow.resume continues the workflow with no message, from an interrupted step, a runtime pause, or an unexpected exit", async () => {
    const controller = fakeController()

    const result = await handleWorkflowMutation({ type: "workflow.resume", workflowId: "wf-1" }, { controller, projectionReader })

    expect(result).toEqual({ ok: true })
    expect(controller.resumes).toEqual(["wf-1"])
  })

  test("workflow.resume names Restart when the durable state cannot execute, and workflow.restart runs it again", async () => {
    const message = "This workflow's saved progress has a damaged record. Restart runs it again from its recorded request."
    const restarts: string[] = []
    const controller = fakeController({
      resumeWorkflow: async () => ({ kind: "recovery_required", message }),
      restartWorkflow: async (sessionId) => {
        restarts.push(sessionId)
        return { kind: "restarted", sessionId }
      },
    })

    expect(await handleWorkflowMutation({ type: "workflow.resume", workflowId: "wf-1" }, { controller, projectionReader })).toEqual({ ok: false, error: message })
    expect(await handleWorkflowMutation({ type: "workflow.restart", workflowId: "wf-1" }, { controller, projectionReader })).toEqual({ ok: true })
    expect(restarts).toEqual(["wf-1"])
  })

  test("workflow.restart reports why the run cannot start again", async () => {
    const message = "This workflow's saved progress has no starting record. The workflow remains paused because its committed work cannot be proved, so Restart cannot run it again."
    const controller = fakeController({ restartWorkflow: async () => ({ kind: "failed", message }) })

    expect(await handleWorkflowMutation({ type: "workflow.restart", workflowId: "wf-1" }, { controller, projectionReader })).toEqual({ ok: false, error: message })
  })

  test("workflow.resume offers no Restart when recovery cannot prove the committed work", async () => {
    const message = "This workflow's saved progress was written by a newer version of Flywheel. The workflow remains paused."
    const controller = fakeController({ resumeWorkflow: async () => ({ kind: "malformed_state", message }) })

    const result = await handleWorkflowMutation({ type: "workflow.resume", workflowId: "wf-1" }, { controller, projectionReader })

    expect(result).toEqual({ ok: false, error: message })
  })

  test("workflow.resume reports any other refusal in the controller's words", async () => {
    const controller = fakeController({ resumeWorkflow: async () => ({ kind: "unavailable", message: "resuming the debug workflow is unavailable: workflows is disabled" }) })

    const result = await handleWorkflowMutation({ type: "workflow.resume", workflowId: "wf-1" }, { controller, projectionReader })

    expect(result).toEqual({ ok: false, error: "resuming the debug workflow is unavailable: workflows is disabled" })
  })


})

describe("workflow app-service operations (command-specific results)", () => {
  test("interrupt reports whether the supervisor interrupted the foreground session", async () => {
    const interrupted: string[] = []
    const deps: WorkflowOperationDeps = { projectionReader, supervisor: { interruptSession: async (sessionId: string) => { interrupted.push(sessionId); return true } } }

    await expect(handleWorkflowOperation({ type: "workflow.interrupt", workflowId: "wf-1" }, deps)).resolves.toEqual({ kind: "interrupt", interrupted: true })
    const idle = { ...deps, supervisor: { interruptSession: async () => false } }
    await expect(handleWorkflowOperation({ type: "workflow.interrupt", workflowId: "idle-flow" }, idle)).resolves.toEqual({ kind: "interrupt", interrupted: false })
    expect(interrupted).toEqual(["wf-1"])
  })

})
