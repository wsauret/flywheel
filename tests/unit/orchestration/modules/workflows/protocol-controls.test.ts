import { describe, expect, test } from "bun:test"
import type { WorkflowController } from "../../../../../src/orchestration/workflow-host/lifecycle/controller.js"
import { WHOLE_WORKFLOW, type WorkflowDeliveryAddress } from "../../../../../src/orchestration/session/conversation/addressed-workflow-messages.js"
import { flattenWorkflowView } from "../../../../../src/workflows/vm/view/view-flatten.js"
import { queueFactsForState } from "../../../../../src/workflows/view/view-diff.js"
import { buildWorkflowControlInitializedFact } from "../../../../../src/workflows/vm/facts/session-facts.js"
import { createMemoryStore } from "../../../workflows/vm/host-test-support.js"
import { fourLaneControl, wideBindings } from "../../../workflows/vm/_tree-fixtures.js"
import { fakeManager, fakeSessionStore, runtimeSupervisor, workflowController, workflowProtocol } from "../../app-service/app-service-doubles.js"

type ControlOverrides = Partial<Pick<WorkflowController, "resumeWorkflow" | "restartWorkflow">>

/** The workflows module protocol with a fake controller and supervisor. */
function controls(options: { readonly controller?: ControlOverrides; readonly interrupt?: (sessionId: string, address?: WorkflowDeliveryAddress) => Promise<boolean>; readonly store?: ReturnType<typeof createMemoryStore> } = {}) {
  const fallback = workflowController(fakeSessionStore(new Map()), fakeManager())
  return workflowProtocol({
    controller: { ...fallback, resumeWorkflow: async (sessionId) => ({ kind: "resumed", sessionId }), restartWorkflow: async (sessionId) => ({ kind: "restarted", sessionId }), ...options.controller },
    supervisor: runtimeSupervisor({ interruptSession: async (sessionId, _by, address) => options.interrupt?.(sessionId, address) ?? true }),
    ...(options.store === undefined ? {} : { store: options.store }),
  })
}

function queueStore(queue: ReturnType<typeof flattenWorkflowView>, control: ReturnType<typeof fourLaneControl>) {
  return createMemoryStore([buildWorkflowControlInitializedFact(control), ...queueFactsForState(null, queue)].map((fact) => ({
    ...fact, aggregateId: "workflow:wf-targets", sessionId: "wf-targets", timestamp: 1,
  })))
}

describe("workflows module protocol controls", () => {
  test("resume and interrupt resolve targets once and refuse invalid targets before acting", async () => {
    const control = fourLaneControl()
    const queue = flattenWorkflowView(control, wideBindings)
    const resumed: WorkflowDeliveryAddress[] = []
    const interrupted: (WorkflowDeliveryAddress | undefined)[] = []
    const protocol = controls({
      store: queueStore(queue, control),
      controller: { resumeWorkflow: async (sessionId, address = WHOLE_WORKFLOW) => { resumed.push(address); return { kind: "resumed", sessionId } } },
      interrupt: async (_sessionId, address) => { interrupted.push(address); return true },
    })
    for (const targets of [["t2"], undefined, []]) {
      const addressed = targets === undefined ? {} : { targets }
      expect(await protocol.mutate({ type: "workflow.resume", workflowId: "wf-targets", ...addressed })).toEqual({ ok: true })
      expect(await protocol.mutate({ type: "workflow.interrupt", workflowId: "wf-targets", ...addressed })).toEqual({ kind: "interrupt", interrupted: true })
    }
    expect(resumed[0]).toEqual({ addressedTo: [{ _tag: "item", listNodeId: "input-mapped:node:1", itemNodeId: "input-mapped:node:1:item:2", key: "t2" }], label: "item t2" })
    expect(resumed.slice(1)).toEqual([WHOLE_WORKFLOW, WHOLE_WORKFLOW])
    expect(interrupted).toEqual(resumed)
    for (const target of ["unknown", "t1"]) {
      const resume = await protocol.mutate({ type: "workflow.resume", workflowId: "wf-targets", targets: [target] })
      const interrupt = await protocol.mutate({ type: "workflow.interrupt", workflowId: "wf-targets", targets: [target] })
      if (resume.ok || interrupt.interrupted) throw new Error("Invalid targets reached control")
      expect(interrupt.reason).toBe(resume.error)
      expect(interrupt.reason).toContain("- t2 |")
    }
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
    for (const [store, reason] of [[queueStore(duplicate, control), "more than one"], [createMemoryStore([]), "no workflow queue"]] as const) {
      const unavailable = controls({ store, controller: { resumeWorkflow: async () => { throw new Error("Unavailable targets reached resume") } }, interrupt: async () => { throw new Error("Unavailable targets reached interrupt") } })
      const resume = await unavailable.mutate({ type: "workflow.resume", workflowId: "wf-targets", targets: ["t2"] })
      const interrupt = await unavailable.mutate({ type: "workflow.interrupt", workflowId: "wf-targets", targets: ["t2"] })
      if (resume.ok || interrupt.interrupted) throw new Error("Unavailable targets reached control")
      expect(interrupt.reason).toBe(resume.error)
      expect(interrupt.reason).toContain(reason)
    }
    expect(resumed).toHaveLength(3)
    expect(interrupted).toHaveLength(3)
  })

  test("interrupt reports whether the supervisor interrupted the foreground session", async () => {
    expect(await controls({ interrupt: async () => true }).mutate({ type: "workflow.interrupt", workflowId: "wf-1" })).toEqual({ kind: "interrupt", interrupted: true })
    expect(await controls({ interrupt: async () => false }).mutate({ type: "workflow.interrupt", workflowId: "idle-flow" })).toEqual({ kind: "interrupt", interrupted: false })
  })

  test("resume continues a resumed or running workflow with no message, and reports every refusal in the controller's words", async () => {
    for (const kind of ["resumed", "already_running"] as const) {
      expect(await controls({ controller: { resumeWorkflow: async (sessionId) => ({ kind, sessionId }) } }).mutate({ type: "workflow.resume", workflowId: "wf-1" })).toEqual({ ok: true })
    }
    for (const refusal of [
      { kind: "recovery_required", message: "This workflow's saved progress has a damaged record. Restart runs it again from its recorded request." },
      { kind: "malformed_state", message: "This workflow's saved progress was written by a newer version of Flywheel. The workflow remains paused." },
      { kind: "unavailable", message: "resuming the debug workflow is unavailable: workflows is disabled" },
    ] as const) {
      expect(await controls({ controller: { resumeWorkflow: async () => refusal } }).mutate({ type: "workflow.resume", workflowId: "wf-1" })).toEqual({ ok: false, error: refusal.message })
    }
  })

  test("restart runs the workflow again, or reports why it cannot start again", async () => {
    const restarts: string[] = []
    expect(await controls({ controller: { restartWorkflow: async (sessionId) => { restarts.push(sessionId); return { kind: "restarted", sessionId } } } }).mutate({ type: "workflow.restart", workflowId: "wf-1" })).toEqual({ ok: true })
    expect(restarts).toEqual(["wf-1"])
    const message = "This workflow's saved progress has no starting record. The workflow remains paused because its committed work cannot be proved, so Restart cannot run it again."
    expect(await controls({ controller: { restartWorkflow: async () => ({ kind: "failed", message }) } }).mutate({ type: "workflow.restart", workflowId: "wf-1" })).toEqual({ ok: false, error: message })
  })
})
