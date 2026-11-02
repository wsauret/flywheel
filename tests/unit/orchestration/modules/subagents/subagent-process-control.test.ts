import { describe, expect, test } from "bun:test"
import { composeModuleServices } from "../../../../../src/infra/module-service.js"
import { bindRetainedOperationHost, composeRetainedOperationHosts } from "../../../../../src/infra/retained-operation-hosts.js"
import type { AgentOptions, AgentRunResult } from "../../../../../src/orchestration/agent-runtime/types.js"
import { createProcessTool } from "../../../../../src/orchestration/agent-runtime/tools/process.js"
import { createChildSessionControl } from "../../../../../src/orchestration/session/child-session-control.js"
import { liveChildRun, registerLiveWorkflowControl } from "../../../../../src/orchestration/session/live-session-control.js"
import { createContinuationLanes } from "../../../../../src/orchestration/session/planned-session-continuation.js"
import { createSessionMessaging } from "../../../../../src/orchestration/session/session-messaging.js"
import { workflowLaunchHost, type WorkflowLaunchHost } from "../../../../../src/orchestration/workflow-host/launch-operation-contract.js"
import { interruptLiveChild } from "../../../../helpers/live-child-run.js"
import { repoDefinitions } from "../../../../helpers/project-definitions.js"
import { workflowParentBinding } from "../../../../helpers/workflow-parent.js"
import { makeContext as makeToolContext } from "../../agent-runtime/tools/_fixtures.js"
import { makeContext, TEST_RATIONALE } from "../../agent-runtime/subagent/_fixtures.js"
import { publishTestWorkflow } from "../../session/_session-manager-fixtures.js"
import { loadQueueSnapshotFromReader } from "../../../../../src/workflows/view/view-store.js"
import { queueFactsForState } from "../../../../../src/workflows/view/view-diff.js"
import { continuationService, createRoot, createUnstartedChild, runs, subagentChildHarnesses, type SubagentChildHarness } from "./_subagent-child-fixtures.js"
import type { WorkflowDeliveryAddress } from "../../../../../src/orchestration/session/conversation/addressed-workflow-messages.js"
import { fourLaneControl, wideBindings } from "../../../workflows/vm/_tree-fixtures.js"
import { flattenWorkflowView } from "../../../../../src/workflows/vm/view-flatten.js"
import { buildWorkflowControlInitializedFact } from "../../../../../src/workflows/vm/session-facts.js"
import { recordChildWorkflowStop } from "../../../../../src/orchestration/session/child-workflow-result.js"
import { workflowRunReader } from "../../../../../src/orchestration/module-catalog.js"
import { seedModelWorkflowCall } from "../../workflow-host/_workflow-progress-fixtures.js"
import { contentEvidence } from "../../../../../src/infra/content-evidence.js"
import { buildSubagentCompleted } from "../../../../../src/orchestration/modules/subagents/history/subagent-run-fact-writers.js"
import { prepareSessionFactAppend } from "../../../../../src/orchestration/session/session-fact-writer.js"
import { QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND } from "../../../../../src/orchestration/session/conversation/queued-background-notifications.js"

const createHarness = subagentChildHarnesses()

/** Completes the first step of a workflow's queue, as its run would, and
 *  answers that step. */
async function completeFirstStep(harness: SubagentChildHarness, sessionId: string) {
  const queue = await loadQueueSnapshotFromReader(harness.reader, sessionId)
  if (!queue) throw new Error("The workflow requires a queue")
  const first = queue.attempts[0]
  if (!first) throw new Error("The workflow requires an attempt")
  const step = { ...first, status: "completed" as const }
  const next = { ...queue, attempts: [step, ...queue.attempts.slice(1)], cursor: 1, tree: { nodes: queue.tree.nodes.map((node) => node.kind === "agent" && node.currentAttemptId === step.id ? { ...node, disposition: "completed" as const } : node) } }
  harness.store.appendBatch(queueFactsForState(queue, next).map((fact) => ({
    aggregateId: `workflow:${sessionId}`, sessionId, timestamp: Date.now(), type: fact.type, version: fact.version, actor: fact.actor, payload: fact.payload,
  })))
  return step
}

/** A runner whose every run works until it is aborted. */
function heldRunner() {
  const options: AgentOptions[] = []
  const createAgent = (input: AgentOptions) => {
    options.push(input)
    const done = Promise.withResolvers<AgentRunResult>()
    return { send() {}, end() {}, abort() { done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } }) }, done: done.promise }
  }
  return { options, createAgent }
}

/** The parent's `process` controls over a real subagent child, and a
 *  workflow child whose launch host records the controls it receives. */
async function parentWithChildren(harness: SubagentChildHarness, createAgent: ReturnType<typeof heldRunner>["createAgent"]) {
  const root = await createRoot(harness.manager)
  const dispatchContext = makeContext({ projectRoot: harness.projectRoot, executionCwd: harness.projectRoot, conversationId: root.conversationId, availableTools: new Set(["read"]) })
  const launch = await harness.tool(root.sessionId, { agentRegistry: repoDefinitions().personas() })
    .execute({ persona: "general", prompt: "Inspect the saved assignment.", rationale: TEST_RATIONALE }, dispatchContext)
  const subagent: string = JSON.parse(launch.content).session_id
  const workflowBinding = await workflowParentBinding(harness.manager, { workflowDefinitionId: "fixture-workflow", parentSessionId: root.sessionId })
  await seedModelWorkflowCall({ eventWriter: harness.writer }, root.sessionId, workflowBinding.toolUseId, "Review")
  const workflow = await publishTestWorkflow(harness.manager, {
    name: "Review",
    launchedFrom: workflowBinding,
  })
  const other = await harness.manager.createChat({ name: "Other" })
  const workflowControls: string[] = []
  const addresses: { action: string; address: WorkflowDeliveryAddress | undefined }[] = []
  const host: WorkflowLaunchHost = {
    restoreLaunchTracking: async () => { throw new Error("This fixture restores no workflow tracking") },
    commitLaunch: async () => { throw new Error("This fixture launches no workflow") },
    stopLaunch: async (sessionId, by) => {
      workflowControls.push(`stop ${sessionId} ${by}`)
      const run = await workflowRunReader(harness.reader).read(sessionId)
      if (!run) throw new Error("Expected the launched workflow")
      await recordChildWorkflowStop({
        reader: harness.reader, writer: harness.writer, childSessionId: sessionId,
        parentSessionId: run.launchedFrom.parentSessionId, toolUseId: run.launchedFrom.toolUseId,
        workflowDefinitionId: run.workflowDefinitionId, stoppedBy: by,
      })
    },
    launchCut: async () => ({ kind: "interrupt", by: "agent" }),
    resumeLaunch: async (sessionId, address) => {
      addresses.push({ action: "resume", address })
      workflowControls.push(`resume ${sessionId}`)
      return { ok: true }
    },
  }
  const continuation = continuationService(harness, createAgent)
  const lanes = createContinuationLanes()
  const evidence = { reader: harness.reader, projectionReader: harness.reader, writer: harness.writer, manager: harness.manager, lanes }
  const children = createChildSessionControl({
    manager: harness.manager, reader: harness.reader, projectionReader: harness.reader, writer: harness.writer, projectRoot: harness.projectRoot,
    modules: composeModuleServices([["subagents", continuation.service]]),
    deliverNotification: async () => false,
    hosts: () => composeRetainedOperationHosts([bindRetainedOperationHost(workflowLaunchHost, host)]),
    interrupt: async (sessionId, address) => {
      addresses.push({ action: "interrupt", address })
      return sessionId === workflow ? false : interruptLiveChild(evidence, "agent")(sessionId)
    },
  })
  const context = (toolUseId: string) => makeToolContext({ sessionId: root.sessionId, conversationId: root.conversationId, toolUseId, backgroundTasks: harness.backgroundTasks })
  return {
    root, subagent, workflow, other, children, context, workflowControls, continuation, addresses,
    personInterrupt: interruptLiveChild(evidence, "person"),
    process: createProcessTool(harness.backgroundTasks, children),
    messaging: createSessionMessaging({ manager: harness.manager, projectionReader: harness.reader, eventWriter: harness.writer }, children),
  }
}

describe("a parent's process control of its own children", () => {
  test("Stop reports an already completed child and reconciles its owed result once", async () => {
    const harness = createHarness(heldRunner().createAgent)
    const { parentSessionId, parentConversationId, childSessionId } = await createUnstartedChild(harness.manager, harness.projectRoot)
    const input = { persona: "explorer", prompt: "inspect" }
    const evidence = contentEvidence(JSON.stringify(input))
    try {
      harness.store.append(prepareSessionFactAppend(parentSessionId, {
        type: "tool.input.completed", version: 2, actor: "agent",
        payload: {
          toolUseId: "dispatch-tool", providerCallId: "dispatch-tool", providerToolName: "subagent", toolName: "subagent",
          modelRequestId: "request", input, inputBytes: evidence.bytes, inputSha256: evidence.sha256, inputPreview: evidence.preview,
          executionMode: "background", traceKind: "subagent", childHasOwnViewport: true,
        },
      }))
      // A host can stop after recording completion and before reconciling its parent.
      harness.store.append(prepareSessionFactAppend(childSessionId, buildSubagentCompleted({
        childRunId: "run-1", status: "completed", isError: false, content: "saved result", durationMs: 1,
      })))
      const notifications: string[] = []
      const children = createChildSessionControl({
        manager: harness.manager, reader: harness.reader, projectionReader: harness.reader, writer: harness.writer,
        projectRoot: harness.projectRoot, modules: composeModuleServices([]), hosts: () => composeRetainedOperationHosts([]),
        interrupt: async () => false,
        deliverNotification: async (_parent, notification) => { notifications.push(notification.text); return false },
      })
      const context = makeToolContext({ sessionId: parentSessionId, conversationId: parentConversationId })
      const stopped = await createProcessTool(harness.backgroundTasks, children).execute({ action: "stop", process_id: childSessionId }, context)
      expect(stopped.outcome).toBe("ok")
      expect(stopped.content).toContain("already completed")
      expect(stopped.content).not.toContain("Canceled")
      expect(runs(harness.store, childSessionId).at(-1)?.status).toBe("completed")
      const results = harness.store.read({ aggregateId: `session:${parentSessionId}`, types: ["tool.result.recorded"] })
      expect(results.filter((fact) => fact.payload.toolUseId === "dispatch-tool")).toHaveLength(1)
      expect(notifications.some((text) => text.includes("saved result"))).toBe(true)
      expect(harness.store.readInFlight(parentSessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).toHaveLength(1)
    } finally {
      await harness.close()
    }
  })

  test("keeps a handing-off child visible to the process tool", async () => {
    const runner = heldRunner()
    const harness = createHarness(runner.createAgent)
    const parent = await parentWithChildren(harness, runner.createAgent)
    try {
      const options = runner.options[0]
      if (options?.lifecycle?.kind !== "parkable") throw new Error("Expected the child's parkable lifecycle")
      options.lifecycle.onHandoffStarted?.()
      const tool = parent.process
      const status = await tool.execute({ action: "status", process_id: parent.subagent }, parent.context("status-handoff"))
      expect(status.outcome).toBe("ok")
      expect(status.content).toContain(`${parent.subagent} | handing_off | subagent |`)
      const listed = await tool.execute({ action: "list" }, parent.context("list-handoff"))
      expect(listed.content).toContain(parent.subagent)
      expect(listed.content).toContain("handing_off")
    } finally {
      await parent.continuation.close()
      await harness.close()
    }
  })

  test("resolves named child controls and preserves a direction's address at the workflow delivery boundary", async () => {
    const runner = heldRunner()
    const harness = createHarness(runner.createAgent)
    const parent = await parentWithChildren(harness, runner.createAgent)
    const control = fourLaneControl()
    harness.store.appendBatch([buildWorkflowControlInitializedFact(control), ...queueFactsForState(null, flattenWorkflowView(control, wideBindings))].map((fact) => ({
      ...fact, aggregateId: `workflow:${parent.workflow}`, sessionId: parent.workflow, timestamp: Date.now(),
    })))
    const deliveredAddresses: (WorkflowDeliveryAddress | undefined)[] = []
    const off = registerLiveWorkflowControl(harness.reader, {
      kind: "workflow", workflowId: parent.workflow, handBackMember: async (continueMember) => continueMember(), memberHost: async () => undefined, state: async () => "interrupted",
      deliver: async (_input, decide, address) => { deliveredAddresses.push(address); return decide("running") }, notify: async () => false,
    })
    try {
      const interrupted = await parent.children.interrupt(parent.root.sessionId, parent.workflow, ["t2"])
      expect(interrupted).toMatchObject({ ok: false })
      expect(!interrupted.ok && interrupted.error).toContain("item t2")
      expect(await parent.children.resume(parent.root.sessionId, parent.workflow, ["t2"])).toEqual({ ok: true })
      expect(parent.addresses).toEqual([
        { action: "interrupt", address: { addressedTo: [{ _tag: "item", listNodeId: "input-mapped:node:1", itemNodeId: "input-mapped:node:1:item:2", key: "t2" }], label: "item t2" } },
        { action: "resume", address: { addressedTo: [{ _tag: "item", listNodeId: "input-mapped:node:1", itemNodeId: "input-mapped:node:1:item:2", key: "t2" }], label: "item t2" } },
      ])
      const tool = parent.process
      const beforeQueuedInterrupt = parent.addresses.length
      for (const targets of [["t3"], ["t2", "t3"]]) {
        const refused = await tool.execute({ action: "interrupt", process_id: parent.workflow, targets }, parent.context("queued-interrupt"))
        expect(refused.outcome).toBe("error")
        expect(refused.content).toContain("t3 has not started")
        expect(refused.content).toContain("interrupt the whole workflow")
        expect(parent.addresses).toHaveLength(beforeQueuedInterrupt)
      }
      await tool.execute({ action: "interrupt", process_id: parent.workflow, targets: [" t2 "] }, parent.context("scoped-interrupt"))
      expect(parent.addresses.at(-1)).toMatchObject({ action: "interrupt", address: { label: "item t2" } })
      expect(await tool.execute({ action: "resume", process_id: parent.workflow, targets: [" t3 "] }, parent.context("scoped-resume"))).toMatchObject({ outcome: "ok" })
      expect(parent.addresses.at(-1)).toMatchObject({ action: "resume", address: { label: "item t3" } })
      expect(await tool.execute({ action: "resume", process_id: parent.workflow, targets: [] }, parent.context("whole-resume"))).toMatchObject({ outcome: "ok" })
      expect(parent.addresses.at(-1)).toMatchObject({ action: "resume", address: { addressedTo: [{ _tag: "workflow" }] } })
      const accepted = parent.addresses.length
      for (const input of [
        { action: "resume", targets: [" "] },
        { action: "interrupt", targets: "t2" },
        { action: "status", targets: ["t2"] },
        { action: "stop", targets: [] },
      ]) {
        expect(await tool.execute({ ...input, process_id: parent.workflow }, parent.context("invalid-targets"))).toMatchObject({ outcome: "error" })
      }
      expect(parent.addresses).toHaveLength(accepted)
      const before = parent.addresses.length
      const unknown = await parent.children.resume(parent.root.sessionId, parent.workflow, ["missing"])
      expect(!unknown.ok && unknown.error).toContain("Valid targets")
      expect(await parent.children.interrupt(parent.root.sessionId, parent.subagent, ["t2"])).toMatchObject({ ok: false, error: expect.stringContaining("not a workflow") })
      expect(parent.addresses).toHaveLength(before)
      expect(await parent.messaging.send({
        target: "workflow",
        sender: { sessionId: parent.root.sessionId, conversationId: parent.root.conversationId, toolUseId: "addressed-hand-back", hop: 0 },
        to: parent.workflow, targets: ["t4"], text: "Continue this lane.", handBack: true, personWords: () => undefined,
      })).toMatchObject({ status: "delivered" })
      expect(deliveredAddresses.at(-1)).toEqual({
        addressedTo: [{ _tag: "item", listNodeId: "input-mapped:node:1", itemNodeId: "input-mapped:node:1:item:4", key: "t4" }], label: "item t4",
      })
    } finally {
      off()
      await parent.continuation.close()
      await harness.close()
    }
  })

  test("lists each child with its id and type, gives its progress, and interrupts, resumes, and stops only its own children", async () => {
    const runner = heldRunner()
    const harness = createHarness(runner.createAgent)
    const parent = await parentWithChildren(harness, runner.createAgent)
    try {
      const list = await parent.process.execute({ action: "list" }, parent.context("list"))
      expect(list.content).toContain("Work that you started (subagent session ids and workflow ids):")
      expect(list.content).toContain(`${parent.subagent} | running | subagent |`)
      expect(list.content).toContain(`${parent.workflow} |`)
      expect(list.content).toContain("| workflow | Review")
      expect(list.content).not.toContain(parent.other)
      expect(list.content).toContain("Other sessions of this project are in list_sessions.")

      const status = await parent.process.execute({ action: "status", process_id: parent.subagent }, parent.context("status"))
      expect(status).toMatchObject({ outcome: "ok" })
      expect(status.content).toContain("progress: attempt 1")
      const workflowStatus = await parent.process.execute({ action: "status", process_id: parent.workflow }, parent.context("workflow-status"))
      expect(workflowStatus.content).toContain("progress: 0/1 done")
      expect(workflowStatus.content).toMatch(/current agent: \S+ \(Fixture step\), pending/)
      expect(workflowStatus.content).not.toContain("completed agents:")
      const completed = await completeFirstStep(harness, parent.workflow)
      const progressed = await parent.process.execute({ action: "status", process_id: parent.workflow }, parent.context("workflow-progressed"))
      expect(progressed.content).toContain("progress: 1/1 done")
      expect(progressed.content).toContain(`completed agents: ${completed.id} (Fixture step)`)
      expect(progressed.content).not.toContain("current agent:")
      // Model-facing status uses the same aggregate and keeps conditional work visible.
      const queue = await loadQueueSnapshotFromReader(harness.reader, parent.workflow)
      if (!queue) throw new Error("The workflow requires a queue")
      const itemAgent = (ordinal: number, disposition: "running" | "completed") => ({
        id: `map:item:${ordinal}:phase:1`, kind: "agent", definitionId: "draft", label: "Draft", parentId: "map:phase:1", disposition, attempts: 1, currentAttemptId: `draft-${ordinal}`,
        item: { nodeId: `map:item:${ordinal}`, key: String(ordinal), label: `Item ${ordinal}`, ordinal, text: `Item ${ordinal}` },
      }) as const
      harness.store.appendBatch(queueFactsForState(queue, { ...queue, attempts: [
        ...queue.attempts,
        { ...completed, id: "draft-1", definitionId: "draft", name: "Draft", status: "completed" },
        { ...completed, id: "draft-2", definitionId: "draft", name: "Draft", status: "running" },
      ], tree: { nodes: [
        { id: "plan:phase", kind: "phase", form: "single", phaseId: "plan", label: "Fixture step", parentId: null, disposition: "completed" },
        { id: "plan", kind: "agent", definitionId: "plan", label: "Fixture step", parentId: "plan:phase", disposition: "completed", attempts: 1, currentAttemptId: completed.id },
        { id: "map:phase:1", kind: "phase", form: "list", phaseId: "draft", label: "Draft", parentId: null, disposition: "running", list: { id: "map", expanded: true }, join: { reducer: "collect@1", state: "pending", slots: 2, completed: 1, failed: 0, pending: 1, missing: 0 } },
        itemAgent(1, "completed"), itemAgent(2, "running"),
        { id: "verify:phase", kind: "phase", form: "single", phaseId: "verify", label: "Verify", parentId: null, disposition: "conditional" },
        { id: "verify", kind: "agent", definitionId: "verify", label: "Verify", parentId: "verify:phase", disposition: "conditional", attempts: 0 },
      ], currentAgentNodeId: "map:item:2:phase:1" } }).map((fact) => ({
        aggregateId: `workflow:${parent.workflow}`, sessionId: parent.workflow, timestamp: Date.now(), type: fact.type, version: fact.version, actor: fact.actor, payload: fact.payload,
      })))
      const tree = await parent.process.execute({ action: "status", process_id: parent.workflow }, parent.context("workflow-tree"))
      expect(tree.content).toContain("progress: 2/4 done · Draft: 1/2 agents, join pending, 1 run only if needed")
      expect(tree.content).toContain(`completed agents: ${completed.id} (Fixture step)`)
      // Both the status and the list give the roster of the fan-out, one
      // line per item, with the key that message_session takes in targets.
      const roster = ["phase Draft: 2 items, one line per item", "- 1 | Item 1 | Draft | done | ", "- 2 | Item 2 | Draft | running | working"]
      for (const line of roster) expect(tree.content).toContain(line)
      const listed = await parent.process.execute({ action: "list" }, parent.context("list-tree"))
      for (const line of roster) expect(listed.content).toContain(`  ${line}`)

      // An interrupt and a resume act only on the caller's own children.
      for (const action of ["interrupt", "resume"] as const) {
        const refused = await parent.process.execute({ action, process_id: parent.other }, parent.context(`other-${action}`))
        expect(refused).toMatchObject({ outcome: "error" })
        expect(refused.content).toContain("is not a child that you started")
      }

      expect(harness.backgroundTasks.awaitedTaskCount()).toBe(1)
      // A wait of the parent on its child ends at once when the parent
      // interrupts that child.
      expect(await parent.messaging.send({
        target: "session",
        sender: { sessionId: parent.root.sessionId, conversationId: parent.root.conversationId, toolUseId: "wait-on-child", hop: 0 },
        to: parent.subagent, wait: harness.backgroundTasks, personWords: () => undefined,
      })).toMatchObject({ waiting: true })
      expect(harness.backgroundTasks.holdsWait("wait-on-child")).toBe(true)
      const interrupted = await parent.process.execute({ action: "interrupt", process_id: parent.subagent }, parent.context("interrupt"))
      expect(interrupted).toMatchObject({ outcome: "ok" })
      expect(harness.backgroundTasks.holdsWait("wait-on-child")).toBe(false)
      // An interrupted child is not active work: nothing waits on it.
      expect(harness.backgroundTasks.awaitedTaskCount()).toBe(0)
      // An interrupted child never blocks a handoff.
      expect(harness.backgroundTasks.kind === "workflow" && harness.backgroundTasks.assertHandoffReady()).toBeNull()
      // The turn end of the child names the parent as its interrupter.
      expect(runs(harness.store, parent.subagent).at(-1)).toMatchObject({ status: "paused" })
      const after = await parent.process.execute({ action: "status", process_id: parent.subagent }, parent.context("status-after"))
      expect(after.content).toContain(`${parent.subagent} | interrupted | subagent |`)
      expect(after.content).toContain("interrupted by: you")

      const resumed = await parent.process.execute({ action: "resume", process_id: parent.subagent }, parent.context("resume"))
      expect(resumed).toMatchObject({ outcome: "ok" })
      expect(runner.options).toHaveLength(2)
      expect(liveChildRun(harness.reader, parent.subagent)).toBeDefined()

      const stopped = await parent.process.execute({ action: "stop", process_id: parent.subagent }, parent.context("stop"))
      expect(stopped).toMatchObject({ outcome: "ok" })
      expect(stopped.content).toContain("Canceled")
      expect(await parent.process.execute({ action: "resume", process_id: parent.workflow }, parent.context("workflow-resume"))).toMatchObject({ outcome: "ok" })
      const workflowStop = await parent.process.execute({ action: "stop", process_id: parent.workflow }, parent.context("workflow-stop"))
      expect(workflowStop).toMatchObject({ outcome: "ok" })
      expect(workflowStop.content).toContain("Canceled")
      expect(parent.workflowControls).toEqual([`resume ${parent.workflow}`, `stop ${parent.workflow} agent`])
    } finally {
      await parent.continuation.close()
      await harness.close()
    }
  })

  test("a parent's message continues a child that the parent interrupted, and a person's interrupt holds both the parent's resume and its message", async () => {
    const runner = heldRunner()
    const harness = createHarness(runner.createAgent)
    const parent = await parentWithChildren(harness, runner.createAgent)
    const send = (toolUseId: string, text: string) => parent.messaging.send({
      target: "session",
      sender: { sessionId: parent.root.sessionId, conversationId: parent.root.conversationId, toolUseId, hop: 0 },
      to: parent.subagent, text, handBack: true, personWords: () => undefined,
    })
    try {
      expect(await parent.process.execute({ action: "interrupt", process_id: parent.subagent }, parent.context("interrupt"))).toMatchObject({ outcome: "ok" })
      expect(await send("continue", "Also check the tests.")).toMatchObject({ status: "delivered" })
      expect(runner.options).toHaveLength(2)

      expect(await parent.personInterrupt(parent.subagent)).toBe(true)
      const status = await parent.process.execute({ action: "status", process_id: parent.subagent }, parent.context("status"))
      expect(status.content).toContain("interrupted by: a person")
      expect(status.content).toContain("only a person continues it")
      const refused = await parent.process.execute({ action: "resume", process_id: parent.subagent }, parent.context("resume"))
      expect(refused).toMatchObject({ outcome: "error" })
      expect(refused.content).toContain("A person interrupted this child, so only a person can continue it")
      expect(await send("held", "Check the docs too.")).toMatchObject({ status: "held", reason: "interrupted" })
      expect(runner.options).toHaveLength(2)
    } finally {
      await parent.continuation.close()
      await harness.close()
    }
  })

  test("a parent resumes a child that it stopped, and a person's stop holds the parent's resume", async () => {
    const runner = heldRunner()
    const harness = createHarness(runner.createAgent)
    const parent = await parentWithChildren(harness, runner.createAgent)
    try {
      const canceled = await parent.process.execute({ action: "stop", process_id: parent.subagent }, parent.context("stop"))
      expect(canceled.content).toContain("Canceled")
      expect(runs(harness.store, parent.subagent).at(-1)).toMatchObject({ status: "cancelled" })
      expect(await parent.process.execute({ action: "resume", process_id: parent.subagent }, parent.context("resume"))).toMatchObject({ outcome: "ok" })
      expect(runner.options).toHaveLength(2)

      const run = liveChildRun(harness.reader, parent.subagent)
      run?.child.stop("person")
      await run?.settled
      expect(runs(harness.store, parent.subagent).at(-1)).toMatchObject({ status: "stopped" })
      const refused = await parent.process.execute({ action: "resume", process_id: parent.subagent }, parent.context("resume-after-person"))
      expect(refused).toMatchObject({ outcome: "error" })
      expect(refused.content).toContain("A person stopped this child, so only a person can resume it.")
      expect(runner.options).toHaveLength(2)
    } finally {
      await parent.continuation.close()
      await harness.close()
    }
  })

})
