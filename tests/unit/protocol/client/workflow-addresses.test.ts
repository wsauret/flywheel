import { describe, expect, it } from "bun:test"
import { resolveWorkflowTargets, workflowAddresses, workflowAgentAddress, workflowAddressLines, workflowTargetRefusal } from "../../../../src/protocol/client/workflow-addresses.js"
import { workflowAgentModel } from "../../../../src/protocol/client/workflow-agent.js"
import type { LoadedWorkflowView, WorkflowTreeNode } from "../../../../src/protocol/workflow-view-protocol-types.js"
import { fourLaneControl, frontendView, interrupt, mapBindings, mapControl, phaseBindings, phaseControl, startNext, wideBindings } from "../../workflows/vm/_tree-fixtures.js"

const WIDE_GROUP = "input-mapped:node:1"
const wideStage = (ordinal: number, position: number) => `${WIDE_GROUP}:item:${ordinal}:phase:${position}`

/** Four items of a stream of two phases: t1 finished both, t2 runs its
 *  first, and t3 and t4 have not started. */
const fourItems = () => frontendView(fourLaneControl(), wideBindings)

/** The four items after another list over the same item keys. */
function afterEarlierList(view: LoadedWorkflowView, finished = true): LoadedWorkflowView {
  const tree = view.tree
  const renamed = (id: string) => id.replace(WIDE_GROUP, "earlier")
  const earlier = tree.nodes
    .filter(({ id }) => id.startsWith(WIDE_GROUP))
    .map((node): WorkflowTreeNode => {
      const disposition = finished ? "completed" as const : node.disposition
      const parentId = node.parentId === null ? null : renamed(node.parentId)
      if (node.kind === "phase") return { ...node, id: renamed(node.id), parentId, disposition, ...(node.list === undefined ? {} : { list: { ...node.list, id: renamed(node.list.id) } }) }
      if (node.kind === "agent") return { ...node, id: renamed(node.id), parentId, disposition, ...(node.item === undefined ? {} : { item: { ...node.item, nodeId: renamed(node.item.nodeId) } }) }
      return { ...node, id: renamed(node.id), parentId, disposition }
    })
  return { ...view, tree: { ...tree, nodes: [...earlier, ...tree.nodes] } }
}

/** The four items with a handoff summary of 240 characters on every agent,
 *  after every agent finished. */
function finishedItems(view: LoadedWorkflowView): LoadedWorkflowView {
  const tree = view.tree
  return {
    ...view,
    tree: {
      ...tree,
      nodes: tree.nodes.map((node): WorkflowTreeNode => node.kind === "agent"
        ? { ...node, disposition: "completed", evidence: { summary: "s".repeat(240) } }
        : { ...node, disposition: "completed" }),
    },
  }
}

describe("the addresses of a workflow", () => {
  it("lists one address per item with the agent that runs it now and its state, reaching its agent in every phase of its stream, and the agent of a phase of one agent by its record id", () => {
    const view = fourItems()
    expect(workflowAddresses(view).map(({ target, kind, agent, state, finished }) => `${target} ${kind} ${agent} ${state}${finished ? " finished" : ""}`)).toEqual([
      "t1 item Review done finished",
      "t2 item Implement running",
      "t3 item Implement queued",
      "t4 item Implement queued",
      "tail agent Tail queued",
    ])
    expect(workflowAddresses(view)[1]).toMatchObject({ nodeId: `${WIDE_GROUP}:item:2`, groupId: WIDE_GROUP, agentNodeIds: [wideStage(2, 1), wideStage(2, 2)] })
    expect(workflowAddresses(frontendView(phaseControl(false), phaseBindings(false))).map(({ target, kind }) => `${target} ${kind}`)).toEqual(["implement agent", "review agent", "tail agent"])
  })

  it("resolves two of four items and refuses a finished item or an unknown key with every key that takes a message and its state", () => {
    const view = fourItems()
    const resolved = resolveWorkflowTargets(view, ["t3", "t4", "t3"])
    expect(resolved.ok && resolved.addresses.map(({ nodeId }) => nodeId)).toEqual([`${WIDE_GROUP}:item:3`, `${WIDE_GROUP}:item:4`])
    const finished = resolveWorkflowTargets(view, ["t2", "t1"])
    expect(finished).toMatchObject({ ok: false, reason: "finished", target: "t1" })
    const unknown = resolveWorkflowTargets(view, ["json"])
    if (unknown.ok) throw new Error("an unknown key resolved")
    expect(unknown.reason).toBe("unknown")
    const refusal = workflowTargetRefusal(unknown)
    expect(refusal).toStartWith('no item or agent of this workflow has the target "json".')
    expect(refusal).toContain("- t2 | {\"id\":\"t2\",\"title\":\"Target 2 of the survey with a deliberat… | Implement | running | working")
    expect(refusal).toContain("- t3 | ")
    expect(refusal).toContain("| Implement | queued | queued")
    expect(resolveWorkflowTargets(frontendView(phaseControl(false), phaseBindings(false)), ["implement"])).toMatchObject({ ok: true, addresses: [{ target: "implement", kind: "agent" }] })
  })

  it("resolves a key that a finished list shares to the item that has not finished", () => {
    const view = afterEarlierList(fourItems())
    const resolved = resolveWorkflowTargets(view, ["t2"])
    expect(resolved.ok && resolved.addresses.map(({ nodeId }) => nodeId)).toEqual([`${WIDE_GROUP}:item:2`])
    expect(workflowAgentAddress(view, workflowAgentModel(view, { agentNodeId: wideStage(2, 1), follow: false })!)).toEqual({ target: "t2", label: "item t2", placeholder: "Message item t2" })
    // Every item with key t1 finished, so t1 is finished, not ambiguous.
    expect(resolveWorkflowTargets(view, ["t1"])).toMatchObject({ ok: false, reason: "finished" })
    const ambiguous = resolveWorkflowTargets(afterEarlierList(fourItems(), false), ["t2"])
    expect(ambiguous).toMatchObject({ ok: false, reason: "ambiguous", target: "t2" })
    if (ambiguous.ok) throw new Error("A shared unfinished key resolved")
    expect(workflowTargetRefusal(ambiguous)).toContain("more than one")
  })

  it("lists only the targets that take a message in a refusal, and says why a workflow takes none", () => {
    const finished = resolveWorkflowTargets(fourItems(), ["t1"])
    if (finished.ok) throw new Error("a finished item resolved")
    const refusal = workflowTargetRefusal(finished)
    expect(refusal).not.toContain("- t1 | ")
    expect(refusal).toContain("- t2 | ")
    const done = resolveWorkflowTargets(finishedItems(fourItems()), ["t2"])
    if (done.ok) throw new Error("a finished item resolved")
    expect(workflowTargetRefusal(done)).toBe('"t2" has finished and reads no more messages.\nNo item or agent of this workflow takes a message now. Send the message without targets to reach the whole workflow.')
    const unexpanded = resolveWorkflowTargets(frontendView(mapControl(), mapBindings), ["t1"])
    if (unexpanded.ok) throw new Error("a list that has not read its items resolved")
    expect(workflowTargetRefusal(unexpanded)).toContain("- plan | Plan | queued | queued")
    const none = resolveWorkflowTargets(finishedItems(fourItems()), ["json"])
    if (none.ok) throw new Error("a finished workflow resolved")
    expect(workflowTargetRefusal(none)).toBe("this workflow has no item or agent that takes a message now: a list gets its items when it reads them, and a finished item or agent takes none.\nSend the message without targets to reach the whole workflow.")
  })

  it("addresses a named agent of a parallel phase by its record id, and an agent of control from before phases by its control node", () => {
    const view = frontendView(startNext(phaseControl(true)), phaseBindings(true))
    expect(workflowAddresses(view).map(({ target, kind, state }) => `${target} ${kind} ${state}`)).toEqual(["implement agent running", "review agent queued", "tail agent queued"])
    expect(resolveWorkflowTargets(view, ["review"])).toMatchObject({ ok: true, addresses: [{ target: "review", kind: "agent" }] })
    // The `debug` chain of a parallel phase from before phases runs both agents.
    const history: LoadedWorkflowView = {
      attemptsStatus: "loaded",
      attempts: [{ id: "investigate-1", definitionId: "investigate", briefId: "investigate", name: "Investigate", status: "completed", history: [], startedAt: 1, completedAt: 2 }],
      tree: { nodes: [
        { id: "work", kind: "phase", form: "parallel", phaseId: "work", label: "Work", parentId: null, disposition: "running" },
        { id: "debug:1", kind: "agent", definitionId: "investigate", label: "Investigate", parentId: "work", disposition: "completed", attempts: 1, currentAttemptId: "investigate-1", evidence: { summary: "No fix is needed" }, nodeId: "debug" },
        { id: "debug:2", kind: "agent", definitionId: "fix", label: "Fix", parentId: "work", disposition: "pending", attempts: 0, nodeId: "debug" },
      ] },
    }
    expect(workflowAddresses(history).map(({ target, nodeId, state, detail, finished }) => ({ target, nodeId, state, detail, finished }))).toEqual([
      { target: "investigate", nodeId: "debug", state: "done", detail: '"No fix is needed"', finished: true },
      { target: "fix", nodeId: "debug", state: "queued", detail: "queued", finished: false },
    ])
    expect(resolveWorkflowTargets(history, ["fix"])).toMatchObject({ ok: true, addresses: [{ nodeId: "debug" }] })
  })

  it("reads as message targets of one line per item for the parent agent", () => {
    expect(workflowAddressLines(fourItems())).toEqual([
      "message targets (name these item keys or agent ids in targets for message_session and process interrupt/resume; omit targets only for the whole workflow):",
      "phase Implement: 4 items, one line per item",
      "- t1 | {\"id\":\"t1\",\"title\":\"Target 1 of the survey with a deliberat… | Review | done | \"done\"",
      "- t2 | {\"id\":\"t2\",\"title\":\"Target 2 of the survey with a deliberat… | Implement | running | working",
      "- t3 | {\"id\":\"t3\",\"title\":\"Target 3 of the survey with a deliberat… | Implement | queued | queued",
      "- t4 | {\"id\":\"t4\",\"title\":\"Target 4 of the survey with a deliberat… | Implement | queued | queued",
      "phase Tail: one agent",
      "- tail | Tail | queued | queued",
    ])
    // An interrupt returns t2's started attempt to pending, and its row keeps the time it first ran. Only the cut word tells it from an agent that never started.
    const interruptedView = frontendView(interrupt(fourLaneControl()), wideBindings)
    const held = { ...interruptedView, attempts: interruptedView.attempts.map((attempt) => attempt.agentNodeId === wideStage(2, 1) ? { ...attempt, startedAt: 1 } : attempt) }
    const line = (lines: readonly string[], key: string) => lines.find((text) => text.startsWith(`- ${key} | `))
    const interrupted = workflowAddressLines(held, "interrupted")
    expect(line(interrupted, "t2")).toContain("| Implement | interrupted |")
    expect(line(interrupted, "t3")).toContain("| Implement | queued |")
    expect(line(workflowAddressLines(held), "t2")).toContain("| Implement | queued |")
  })

  it("reads a list whose items all finished as one line, so a finished workflow's targets stay short", () => {
    expect(workflowAddressLines(finishedItems(fourItems()))).toEqual(["phase Implement: 4 items, all finished", "phase Tail: one agent, finished"])
  })

  it("gives the composer of a running or waiting agent its item, and none to an agent of a finished item", () => {
    const view = fourItems()
    const address = (agentNodeId: string) => workflowAgentAddress(view, workflowAgentModel(view, { agentNodeId, follow: false })!)
    expect(address(wideStage(2, 1))).toEqual({ target: "t2", label: "item t2", placeholder: "Message item t2" })
    expect(address(wideStage(3, 2))).toEqual({ target: "t3", label: "item t3", placeholder: "Message item t3" })
    expect(address(wideStage(1, 2))).toBeUndefined()
    const phase = frontendView(startNext(phaseControl(true)), phaseBindings(true))
    const review = phase.tree.nodes.filter(({ kind }) => kind === "agent")[1]!.id
    expect(workflowAgentAddress(phase, workflowAgentModel(phase, { agentNodeId: review, follow: false })!)).toEqual({ target: "review", label: "agent review", placeholder: "Message agent review" })
  })
})
