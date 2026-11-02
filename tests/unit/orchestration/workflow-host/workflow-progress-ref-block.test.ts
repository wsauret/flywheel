import { afterEach, describe, expect, it } from "bun:test"
import { contentEvidence } from "../../../../src/infra/content-evidence.js"
import { createWorkflowController } from "../../../../src/orchestration/workflow-host/controller.js"
import { cleanupProjectRoots, createDeps, fixtureSource, seedWorkflowQueue } from "./_workflow-controller-fixtures.js"
import { createMockWorkflowHosts } from "./_workflow-host-fixtures.js"
import { modelWorkflowLaunchOrigin } from "../../../../src/orchestration/workflow-host/launch-origin.js"
import { fullAuthority } from "../../../helpers/launch-authority.js"
import { completedSurveyFacts, stoppedStepLoopFacts } from "../../workflows/vm/_tree-fixtures.js"
import { initialFacts, sequentialWorkflow } from "../../workflows/vm/host-test-support.js"
import { loadQueueFromEvents } from "../../../../src/workflows/view/view-projection.js"
import { queueFactsForState } from "../../../../src/workflows/view/view-diff.js"
import { createWorkflowRunReader } from "../../../../src/orchestration/modules/workflows/run-record.js"

afterEach(() => {
  cleanupProjectRoots()
})

function modelOrigin() {
  return modelWorkflowLaunchOrigin("chat-1", { conversationId: "conv-chat-1", toolUseId: "tool-1", confirmation: { kind: "absent" }, authority: fullAuthority() })
}

async function fixture() {
  const hosts = createMockWorkflowHosts()
  const deps = createDeps({
    workflowHosts: hosts,
    reconcileChildSessionCompletions: async parentId => ({
      reconciledCount: 1, workflowAggregateReads: 0,
      durableTerminalChildSessionIds: (await createWorkflowRunReader(deps.projectionReader).listForParent(parentId)).map(run => run.workflowId),
    }),
  })
  await deps.manager.createChat({ id: "chat-1", conversationId: "conv-chat-1", name: "Parent" })
  return { deps, hosts }
}

describe("workflow progress ref block", () => {
  it("done promise resolves with completed status and each step's handoff on runner success", async () => {
    const { deps, hosts } = await fixture()
    const controller = createWorkflowController(deps)

    const result = await controller.startWorkflow({ source: fixtureSource(deps, "chat-1"), description: "Create a file", origin: modelOrigin() })
    if ("error" in result) throw new Error(result.error)
    const startCall = hosts._startCalls[0]
    if (!startCall?.onCoreCompleted) throw new Error("workflow start did not capture core-completion callback")

    // Each step's handoff is the parent's input for revising the draft, so it
    // rides in the result as a subagent's handoff does.
    const launched = initialFacts(sequentialWorkflow).map(fact => ({ ...fact, expectedSeq: undefined, aggregateId: `workflow:${result.workflowId}`, sessionId: result.workflowId }))
    const queue = loadQueueFromEvents(launched.map((fact, index) => ({ ...fact, id: `launched-${index}`, seq: index + 1, position: index + 1 })))
    const [work, review] = queue?.attempts ?? []
    if (!queue || !work || !review) throw new Error("the launched workflow has no steps")
    const settled = queueFactsForState(queue, { ...queue, attempts: [{ ...work, status: "completed" }, review],
      tree: { ...queue.tree, nodes: queue.tree.nodes.map((node) => node.kind === "agent" && node.currentAttemptId === work.id ? { ...node, disposition: "completed" } : node) },
    })
    for (const fact of [...launched, ...settled.map((draft) => ({ ...draft, aggregateId: `workflow:${result.workflowId}`, sessionId: result.workflowId, timestamp: 10 }))]) await deps.eventWriter.append(fact)
    const handoff = {
      summary: "Landed the change with focused tests.",
      decisions: ["Kept the store as the single owner instead of the planned adapter field"],
    }
    const evidence = contentEvidence(JSON.stringify(handoff))
    await deps.eventWriter.append({
      aggregateId: `workflow:${result.workflowId}`,
      sessionId: result.workflowId,
      timestamp: Date.now(),
      type: "handoff.written",
      version: 1,
      actor: "worker",
      payload: { stepId: work.id, stepName: "Work", definitionId: "work", workflowDefinitionId: "host-sequential", content: handoff, ...evidence },
    })

    await startCall.onCoreCompleted(result.workflowId, { completed: true, attemptsCompleted: 3, attemptsTotal: 3, cost: 0, tokens: 0 })
    await startCall.onRunnerDone?.(result.workflowId, { completed: true, attemptsCompleted: 3, attemptsTotal: 3, cost: 0, tokens: 0 })

    const doneResult = await result.done
    expect(doneResult.status).toBe("completed")
    expect(doneResult.content).toContain(`Workflow completed: "Repair" (workflow ${result.workflowId}). 1/2 agents finished.`)
    expect(doneResult.content).toContain("## work: completed\n\n### Summary\nLanded the change with focused tests.\n\n### Decisions\n- Kept the store as the single owner instead of the planned adapter field\n\n## review: did not run")
    expect(await deps.manager.read(result.workflowId)).toBeNull()
  })

  it("done promise names a survey's incomplete coverage beside the completed verdict", async () => {
    const { deps, hosts } = await fixture()
    const result = await createWorkflowController(deps).startWorkflow({ source: fixtureSource(deps, "chat-1"), description: "Survey", origin: modelOrigin() })
    if ("error" in result) throw new Error(result.error)
    const startCall = hosts._startCalls[0]
    if (!startCall?.onCoreCompleted) throw new Error("workflow start did not capture core-completion callback")
    // The run's tree carries the coverage its join folded.
    for (const fact of await completedSurveyFacts([{ id: "a", priority: "required", report: "surveyed" }, { id: "b", priority: "required", report: "inaccessible" }])) {
      await deps.eventWriter.append({ aggregateId: `workflow:${result.workflowId}`, sessionId: result.workflowId, timestamp: Date.now(), ...fact })
    }

    await startCall.onCoreCompleted(result.workflowId, { completed: true, attemptsCompleted: 6, attemptsTotal: 6, cost: 0, tokens: 0 })

    const doneResult = await result.done
    expect(doneResult.status).toBe("completed")
    expect(doneResult.content).toStartWith(`Workflow completed: "Repair" (workflow ${result.workflowId}). 6/6 agents finished. The survey reports coverage required 1 of 2, 1 unsurveyed. Review the agent results and continue the original request.\n\nAgent results, in the order of the workflow:\n\n## inventory: completed`)
    // Graph order: each phase's agents, the join after the last phase of the
    // stream it folds, then the agent that reads the join.
    const headings = [...doneResult.content.matchAll(/^## (.+)$/gmu)].map((match) => match[1])
    expect(headings).toEqual([
      "inventory: completed",
      "survey, item a: completed",
      "survey, item b: completed",
      "verify, item a: completed",
      "verify, item b: completed",
      "join of verify: completed",
      "synthesize: completed",
    ])
  })

  it.each([
    // The bound ends the loop on its check, so the count holds no fix after
    // it; a stuck stop skips the fix after its check, which the count holds.
    { detectStuck: false, count: 9, stop: 'The loop "Investigate → Fix" stopped at its bound of 5 rounds without a dry evaluation.' },
    { detectStuck: true, count: 4, stop: 'The loop "Investigate → Fix" stopped as stuck in round 2: its last evaluation found the same work as the one before.' },
  ])("done promise names a stopped loop beside the completed verdict (detectStuck $detectStuck)", async ({ detectStuck, count, stop }) => {
    const { deps, hosts } = await fixture()
    const result = await createWorkflowController(deps).startWorkflow({ source: fixtureSource(deps, "chat-1"), description: "Repair", origin: modelOrigin() })
    if ("error" in result) throw new Error(result.error)
    const startCall = hosts._startCalls[0]
    if (!startCall?.onCoreCompleted) throw new Error("workflow start did not capture core-completion callback")
    for (const fact of await stoppedStepLoopFacts(detectStuck)) {
      await deps.eventWriter.append({ aggregateId: `workflow:${result.workflowId}`, sessionId: result.workflowId, timestamp: Date.now(), ...fact })
    }

    await startCall.onCoreCompleted(result.workflowId, { completed: true, attemptsCompleted: count, attemptsTotal: count, cost: 0, tokens: 0 })

    const doneResult = await result.done
    expect(doneResult.status).toBe("completed")
    expect(doneResult.content.split("\n")[0]).toBe(`Workflow completed: "Repair" (workflow ${result.workflowId}). ${count}/${count} agents finished. ${stop} Review the agent results and continue the original request.`)
  })

  it("done promise carries the verdict and unrun step when no step handed off", async () => {
    const { deps, hosts } = await fixture()
    const controller = createWorkflowController(deps)

    const result = await controller.startWorkflow({ source: fixtureSource(deps, "chat-1"), description: "Create a file", origin: modelOrigin() })
    if ("error" in result) throw new Error(result.error)
    const startCall = hosts._startCalls[0]
    if (!startCall?.onCoreCompleted) throw new Error("workflow start did not capture core-completion callback")

    await seedWorkflowQueue(deps, result.workflowId)
    await startCall.onCoreCompleted(result.workflowId, { completed: false, attemptsCompleted: 1, attemptsTotal: 3, reason: "budget exhausted", cost: 0, tokens: 0 })

    const doneResult = await result.done
    expect(doneResult.status).toBe("failed")
    expect(doneResult.content).toBe(`Workflow failed: "Repair" (workflow ${result.workflowId}). 0/1 agents finished. Reason: budget exhausted. Review the agent results and continue the original request.\n\nAgent results, in the order of the workflow:\n\n## work: did not run`)
  })

  it("done promise resolves with failed status on runner error", async () => {
    const { deps, hosts } = await fixture()
    const controller = createWorkflowController(deps)

    const result = await controller.startWorkflow({ source: fixtureSource(deps, "chat-1"), description: "Create a file", origin: modelOrigin() })
    if ("error" in result) throw new Error(result.error)
    const startCall = hosts._startCalls[0]
    if (!startCall?.onRunnerError) throw new Error("workflow start did not capture error callback")

    await startCall.onRunnerError(result.workflowId, new Error("Budget exhausted"))

    const doneResult = await result.done
    expect(doneResult.status).toBe("failed")
    expect(doneResult.content).toContain("Budget exhausted")
  })
})
