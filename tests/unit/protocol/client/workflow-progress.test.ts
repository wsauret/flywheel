import { describe, expect, test } from "bun:test"
import { workflowProgress, workflowProgressCount, workflowSummaryParts, workflowSummaryText } from "../../../../src/protocol/client/workflow-progress"
import { attemptOf, stage } from "../../workflows/vm/_map-fixtures.js"
import { stepLoopControl, stepLoopBindings, drive, eachBindings, eachControl, dryBindings, dryControl, findingsBindings, findingsControl, frontendView, interrupt, items, mapBindings, mapControl, mapOutcome, startNext, surveyBindings, surveyControl, wideBindings, wideControl } from "../../workflows/vm/_tree-fixtures.js"
import type { FrontendAttemptStatus, WorkflowTree, WorkflowTreeNode } from "../../../../src/protocol/workflow-view-protocol-types"

const attempt = (id: string, status: FrontendAttemptStatus) => ({ id, history: [], definitionId: "agent", briefId: id, name: `Agent ${id}`, status })
/** One single phase for each status, its agent's attempt named a, b, c, and so on. */
const phases = (statuses: readonly (FrontendAttemptStatus | "conditional")[]): WorkflowTree => ({
  nodes: statuses.flatMap((status, index): WorkflowTreeNode[] => {
    const disposition = status === "blocked" ? "skipped" : status
    return [
      { id: `${index}:phase`, kind: "phase", form: "single", phaseId: `${index}`, label: `Agent ${index}`, parentId: null, disposition },
      { id: `${index}`, kind: "agent", definitionId: `${index}`, label: `Agent ${index}`, parentId: `${index}:phase`, disposition, attempts: status === "conditional" ? 0 : 1, ...(status === "conditional" ? {} : { currentAttemptId: String.fromCharCode(97 + index) }) },
    ]
  }),
})

describe("workflow progress", () => {
  test("counts completed and skipped agents as done, and names the completed ones in run order", () => {
    const progress = workflowProgress({ attempts: [attempt("a", "completed"), attempt("b", "skipped"), attempt("c", "completed"), attempt("d", "running")], tree: phases(["completed", "skipped", "completed", "running", "conditional"]) })
    expect(progress).toMatchObject({ done: 3, total: 5, conditional: 1 })
    expect(progress.completed.map((completed) => completed.id)).toEqual(["a", "c"])
  })

  test("the current agent identifies runnable or interrupted work, with the failed execution retained after failure", () => {
    for (const status of ["pending", "running", "failed"] as const) {
      const tree = phases(["completed", "conditional", status, "pending"])
      expect(workflowProgress({ attempts: [attempt("a", "completed"), attempt("c", status), attempt("d", "pending")], tree: { ...tree, currentAgentNodeId: "2" } }).current?.id).toBe("c")
    }
    expect(workflowProgress({ attempts: [attempt("a", "completed"), attempt("b", "skipped")], tree: phases(["completed", "skipped", "conditional"]) }).current).toBeUndefined()
  })

  test("counts conditional phases, skipped phases, an agent of a list, and repeat stop state from the tree", () => {
    const tree = phases(["completed", "conditional", "conditional"])
    expect(workflowProgress({ attempts: [attempt("a", "completed")], tree })).toMatchObject({ done: 1, total: 3, conditional: 2 })
    expect(workflowSummaryText(workflowProgress({ attempts: [attempt("a", "completed")], tree: { nodes: tree.nodes.map((node) => node.disposition === "conditional" ? { ...node, disposition: "skipped" } : node) } }))).toBe("3/3 done")
    const list: WorkflowTree = { nodes: [
      { id: "targets:phase:1", kind: "phase", form: "list", phaseId: "debug", label: "Debug", parentId: null, disposition: "running", list: { id: "targets", expanded: true }, join: { reducer: "collect@1", state: "pending", slots: 1, completed: 0, failed: 0, pending: 1, missing: 0 } },
      { id: "targets:item:1:phase:1", kind: "agent", definitionId: "debug", label: "Debug", parentId: "targets:phase:1", disposition: "completed", attempts: 1, currentAttemptId: "a", item: { nodeId: "targets:item:1", key: "t1", label: "Target", ordinal: 1, text: "t1" } },
    ] }
    // A completed agent of a list is done, but only its join names its result.
    expect(workflowProgress({ attempts: [attempt("a", "completed")], tree: list })).toMatchObject({ done: 1, total: 1, completed: [] })
    for (const [outcome, iteration, words] of [["dry", 1, "dry"], ["bound", 5, "max 5 rounds"], ["stuck", 2, "stuck"]] as const) {
      const view = frontendView(drive(stepLoopControl(outcome === "stuck"), () => ({ handoff: { summary: "Result", findings: outcome === "dry" ? [] : ["the same defect"] } })), stepLoopBindings)
      expect(view.tree.nodes.find((node) => node.kind === "repeat")?.label).toBe("Investigate → Fix")
      expect(workflowSummaryText(workflowProgress(view))).toEndWith(`round ${iteration} of at most 5 · ${words}`)
      expect(workflowSummaryParts(workflowProgress(view)).at(-1)?.tone).toBe(outcome === "dry" ? "done" : "failed")
    }
    expect(workflowSummaryText(workflowProgress(frontendView(dryControl(), dryBindings)))).toContain("round 3 of at most 3 · dry")
  })
})

describe("tree workflow progress", () => {
  test("counts a list before it reads its items as one unit per phase of its stream, and one unit per agent after", () => {
    const launch = workflowProgress(frontendView(mapControl(), mapBindings))
    expect(launch).toMatchObject({ done: 0, total: 4, failed: 0 })
    expect(workflowSummaryText(launch)).toBe("0/4 done · Review: waiting for its items")

    const expanded = drive(mapControl(), mapOutcome(items("a", "b", "c")), (control) => control.graph.nodes.some(({ kind }) => kind === "item"))
    const progress = workflowProgress(frontendView(expanded, mapBindings))
    // Plan, two phases of a stream over three items, and the tail: an item
    // that moves through two phases is two units, one for each agent.
    expect(progress).toMatchObject({ done: 1, total: 8, failed: 0 })
    expect(progress.completed.map(({ name }) => name)).toEqual(["Plan"])
    expect(progress.current?.id).toBe(attemptOf(stage(1, 1)))
    expect(workflowSummaryText(progress)).toBe("1/8 done · Review: 0/3 agents, join pending")
  })

  test("counts a failed agent of a list as finished and failed, and a settled join that names every slot", () => {
    const failing = new Set([attemptOf(stage(2, 1))])
    const midway = drive(mapControl(), mapOutcome(items("a", "b", "c"), failing), (control) => control.attempts.some(({ state }) => state._tag === "failed"))
    expect(workflowSummaryText(workflowProgress(frontendView(midway, mapBindings)))).toBe("5/8 done, 1 failed · Review: 2/3 agents, 1 failed, join pending")

    const settled = workflowProgress(frontendView(drive(midway, mapOutcome(items("a", "b", "c"), failing)), mapBindings))
    expect(settled).toMatchObject({ done: 8, total: 8, failed: 1 })
    expect(settled.current).toBeUndefined()
    const parts = workflowSummaryParts(settled)
    expect(parts.map(({ text }) => text).join("")).toBe("8/8 done, 1 failed · Review: 3/3 agents, 1 failed, joined")
    expect(parts.find(({ text }) => text === ", 1 failed")?.tone).toBe("failed")
    expect(parts[0]?.tone).toBe("done")
  })

  test("counts the planned rounds of a repeat over items, one unit for each agent of each round", () => {
    const answer = (attemptId: string) => ({ handoff: attemptId.startsWith("each:node:1:") ? { summary: "The items.", items: [{ id: "a" }, { id: "b" }, { id: "c" }] } : { summary: "done" } })
    const opened = drive(eachControl(), answer, (control) => control.attempts.some(({ definitionId, state }) => definitionId === "source" && state._tag === "completed"))
    // The source, and one round of `work` for each of three items.
    expect(workflowProgress(frontendView(opened, eachBindings))).toMatchObject({ done: 1, total: 4 })
    expect(workflowProgress(frontendView(drive(opened, answer), eachBindings))).toMatchObject({ done: 4, total: 4 })
  })

  test("shows an empty list as zero targets, with no fraction and no item", () => {
    const progress = workflowProgress(frontendView(wideControl(0), wideBindings))
    expect(progress).toMatchObject({ done: 0, total: 1 })
    expect(workflowSummaryText(progress)).toBe("0/1 done · Review: 0 targets, join pending")
    expect(workflowSummaryText(progress)).not.toMatch(/%|0\/0/)
  })

  test("names how many agents run when several run at once, on the summary line and the card's count", () => {
    const one = workflowProgress(frontendView(startNext(wideControl(3)), wideBindings))
    expect(one.running).toBe(1)
    expect(workflowSummaryText(one)).toBe("0/7 done · Review: 0/3 agents, join pending")
    const three = workflowProgress(frontendView(startNext(startNext(startNext(wideControl(3)))), wideBindings))
    expect(three.running).toBe(3)
    expect(workflowSummaryText(three)).toBe("0/7 done, 3 running · Review: 0/3 agents, join pending")
    expect(workflowProgressCount(three)).toBe("0/7 done, 3 running")
  })

  test("leads about 85 items with one short aggregate line", () => {
    const progress = workflowProgress(frontendView(wideControl(85), wideBindings))
    expect(progress).toMatchObject({ done: 0, total: 171 })
    expect(workflowSummaryText(progress)).toBe("0/171 done · Review: 0/85 agents, join pending")
  })

  test("keeps the interrupted agent current and counts no unfinished agent as done", () => {
    const progress = workflowProgress(frontendView(interrupt(startNext(wideControl(3))), wideBindings))
    expect(progress).toMatchObject({ done: 0, total: 7, failed: 0 })
    expect(progress.current?.id).toBe("input-mapped:node:1:item:1:phase:1:attempt:1")
  })

  test("names what each selecting join kept and dropped beside it", () => {
    const progress = workflowProgress(frontendView(findingsControl(), findingsBindings))
    expect(workflowSummaryText(progress)).toBe("6/6 done, 1 failed · Review: 3/3 agents, 1 failed, joined, kept 2, dropped 1 · Verify: 2/2 agents, joined, passed 1 of 2")
  })

  test("names coverage beside the join, and incomplete coverage never reads as full", () => {
    const partial = workflowProgress(frontendView(surveyControl([
      { id: "a", priority: "required", report: "surveyed" },
      { id: "b", priority: "required", report: "inaccessible" },
      { id: "c", priority: "supporting", report: "fail" },
    ]), surveyBindings))
    expect(workflowSummaryText(partial)).toBe("8/8 done, 1 failed · Verify: 3/3 agents, 1 failed, joined, coverage required 1 of 2, 1 unsurveyed")
    expect(workflowSummaryParts(partial).find(({ text }) => text.includes("coverage"))?.tone).toBe("failed")
    expect(workflowProgressCount(partial)).toBe("8/8 done, 1 failed · coverage required 1 of 2, 1 unsurveyed")

    const full = workflowProgress(frontendView(surveyControl([
      { id: "a", priority: "required", report: "surveyed" },
      { id: "b", priority: "supporting", report: "inaccessible" },
    ]), surveyBindings))
    expect(workflowProgressCount(full)).toBe("6/6 done · coverage required 1 of 1")
    expect(workflowSummaryParts(full).find(({ text }) => text.includes("coverage"))?.tone).toBe("done")

    // A survey of supporting targets alone reached no required target, so
    // it never reads as done, even when every item it ran failed.
    const unrequired = workflowProgress(frontendView(surveyControl([
      { id: "a", priority: "supporting", report: "fail" },
      { id: "b", priority: "supporting", report: "fail" },
    ]), surveyBindings))
    expect(workflowProgressCount(unrequired)).toBe("6/6 done, 2 failed · coverage no required targets")
    expect(workflowSummaryParts(unrequired).find(({ text }) => text.includes("coverage"))?.tone).toBe("failed")

    // An empty manifest reads as zero targets, never as a full ratio.
    const empty = workflowProgress(frontendView(surveyControl([]), surveyBindings))
    expect(workflowSummaryText(empty)).toBe("2/2 done · Verify: 0 targets, joined")
    expect(workflowProgressCount(empty)).toBe("2/2 done")
  })
})
