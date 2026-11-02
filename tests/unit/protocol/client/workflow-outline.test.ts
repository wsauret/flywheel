import { describe, expect, it } from "bun:test"
import { workflowAgentPlace, workflowOutline, workflowPhaseTitle, type WorkflowOutline } from "../../../../src/protocol/client/workflow-outline.js"
import type { LoadedWorkflowView } from "../../../../src/protocol/workflow-view-protocol-types.js"
import { FINDINGS_CHECKS, FINDINGS_REVIEWS, INPUT_GROUP, MAP_GROUP, attemptOf, dryRound, inputStage, stage } from "../../workflows/vm/_map-fixtures.js"
import { debugBindings, debugControl, drive, dryBindings, dryControl, failedBranch, findingsBindings, findingsControl, frontendView, interrupt, mapBindings, mapControl, phaseBindings, phaseControl, startNext, wideBindings, wideControl } from "../../workflows/vm/_tree-fixtures.js"

/** Each phase as `form title state done/total`, and each agent as
 *  `label state: definitionId`. */
const outlineLines = (outline: WorkflowOutline) => outline.phases.map((phase) => ({
  phase: `${phase.form} ${workflowPhaseTitle(phase)} ${phase.state} ${phase.done}/${phase.total}${phase.failed > 0 ? ` ${phase.failed} failed` : ""}${phase.running > 0 ? ` ${phase.running} running` : ""}`,
  agents: phase.agents.map((agent) => `${agent.label} ${agent.state}: ${agent.definitionId}`),
}))

/** A parallel phase of control from before phases, whose `debug` chain ran
 *  its first agent and waits to know whether it needs the second. Its tree
 *  was written when the summary was the handoff's first line, which can be
 *  a heading; the agent's line reads it without its `#` marks. */
const historyView = {
  attemptsStatus: "loaded",
  attempts: [{ id: "investigate-1", history: [], definitionId: "investigate", briefId: "investigate", name: "Investigate", status: "completed", startedAt: 10, completedAt: 20, toolUses: 4 }],
  tree: { nodes: [
    { id: "build", kind: "phase", form: "parallel", phaseId: "build", label: "Build", parentId: null, disposition: "running" },
    { id: "debug:1", kind: "agent", definitionId: "investigate", label: "Investigate", parentId: "build", disposition: "completed", attempts: 1, currentAttemptId: "investigate-1", evidence: { summary: "## Found it." }, nodeId: "debug" },
    { id: "debug:2", kind: "agent", definitionId: "fix", label: "Fix", parentId: "build", disposition: "conditional", attempts: 0, nodeId: "debug" },
  ] },
} satisfies LoadedWorkflowView

const running = () => frontendView(startNext(startNext(wideControl(3))), wideBindings)
const parked = () => frontendView(interrupt(startNext(wideControl(3))), wideBindings)

const fixtures: readonly (readonly [string, () => LoadedWorkflowView, string | undefined])[] = [
  ["single phases", () => frontendView(phaseControl(false), phaseBindings(false)), undefined],
  ["a parallel phase", () => frontendView(phaseControl(true), phaseBindings(true)), undefined],
  ["a list that has not read its items", () => frontendView(mapControl(), mapBindings), undefined],
  ["a stream with a failed item", failedBranch, undefined],
  ["an empty list", () => frontendView(wideControl(0), wideBindings), undefined],
  ["running agents of a list", running, undefined],
  ["parked agents of a list", parked, "interrupted"],
  ["a repeat over a list", () => frontendView(dryControl(), dryBindings), undefined],
  ["a list and a voting list", () => frontendView(findingsControl(), findingsBindings), undefined],
  ["phases that run if needed", () => frontendView(debugControl(), debugBindings), undefined],
  ["settled phases that run if needed", () => frontendView(drive(debugControl(), () => ({ handoff: { summary: "" } })), debugBindings), undefined],
  ["a parallel phase from before phases", () => historyView, undefined],
]

describe("the outline of a workflow", () => {
  it.each(fixtures)("counts %s in the units of the workflow's progress", (_, view, phase) => {
    const outline = workflowOutline(view(), phase)
    const sum = (field: "done" | "total" | "failed" | "running") => outline.phases.reduce((total, each) => total + each[field], 0)
    expect({ done: sum("done"), total: sum("total"), failed: sum("failed"), running: sum("running") }).toEqual({
      done: outline.progress.done, total: outline.progress.total, failed: outline.progress.failed, running: outline.progress.running,
    })
  })

  it("shows each single phase as its own phase, and a parallel phase as one phase that lists its agents", () => {
    expect(outlineLines(workflowOutline(frontendView(phaseControl(false), phaseBindings(false))))).toEqual([
      { phase: "single implement queued 0/1", agents: ["implement queued: implement"] },
      { phase: "single review queued 0/1", agents: ["review queued: review"] },
      { phase: "single tail queued 0/1", agents: ["tail queued: tail"] },
    ])
    expect(outlineLines(workflowOutline(frontendView(phaseControl(true), phaseBindings(true))))).toEqual([
      { phase: "parallel build queued 0/2", agents: ["implement queued: implement", "review queued: review"] },
      { phase: "single tail queued 0/1", agents: ["tail queued: tail"] },
    ])
  })

  it("folds a stream of two phases over three items into two phases of three agents each, with no agents until the list reads its items", () => {
    const unexpanded = workflowOutline(frontendView(mapControl(), mapBindings)).phases.slice(1, 3)
    expect(unexpanded).toMatchObject([
      { key: `${MAP_GROUP}:phase:1`, form: "list", phaseId: "implement", agents: [], expanded: false, state: "queued", done: 0, total: 1 },
      { key: `${MAP_GROUP}:phase:2`, form: "list", phaseId: "review", agents: [], expanded: false, state: "queued", done: 0, total: 1 },
    ])
    const outline = workflowOutline(failedBranch())
    expect(outlineLines(outline).slice(1, 3)).toEqual([
      { phase: "list implement running 2/3 1 failed", agents: ["a done: implement", "b failed: implement", "c queued: implement"] },
      { phase: "list review running 2/3", agents: ["a done: review", "b skipped: review", "c waiting: review"] },
    ])
    expect(outline.phases[1]!.agents[0]).toMatchObject({ agentNodeId: stage(1, 1), detail: "done" })
    expect(outline.phases[2]!.agents.map(({ detail }) => detail)).toEqual(["done", "A required dependency cannot complete", "waiting for its implement"])
    const empty = workflowOutline(frontendView(wideControl(0), wideBindings))
    expect(outlineLines(empty).slice(0, 2)).toEqual([{ phase: "list implement queued 0/0", agents: [] }, { phase: "list review queued 0/0", agents: [] }])
    expect(empty.phases[0]?.expanded).toBe(true)
  })

  it("reads the agents that run, and parks the agent that an interrupt cut while the rest read as not started", () => {
    expect(outlineLines(workflowOutline(running())).slice(0, 2)).toEqual([
      { phase: "list implement running 0/3 2 running", agents: ["t1 running: implement", "t2 running: implement", "t3 queued: implement"] },
      { phase: "list review queued 0/3", agents: ["t1 waiting: review", "t2 waiting: review", "t3 waiting: review"] },
    ])
    expect(outlineLines(workflowOutline(parked(), "interrupted", [{ attemptId: attemptOf(inputStage(1, 1)), sessionId: "member-1", operations: 0, interruptedAt: 1, duration: 0, revision: 0 }]))[0]).toEqual({
      phase: "list implement parked 0/3",
      agents: ["t1 parked: implement", "t2 queued: implement", "t3 queued: implement"],
    })
    expect(workflowOutline(parked(), "interrupted").cut).toBe("interrupted")
  })

  it("reuses the fold until its attempt carriers change, and keeps running while a sibling is parked", () => {
    const view = running()
    const live = [{ attemptId: attemptOf(inputStage(1, 1)), sessionId: "member-1", operations: 4, interruptedAt: 39_000, duration: 0, revision: 0 }]
    const outline = workflowOutline(view, undefined, live)
    expect(workflowOutline(view, undefined, live)).toBe(outline)
    expect(outline.phases[0]).toMatchObject({ state: "running", agents: [{ state: "parked", operations: 4 }, { state: "running" }, { state: "queued" }] })
    expect(workflowOutline(view).phases[0]?.agents[0]?.state).toBe("running")
  })

  it("reads each agent's live value once per fold, however many agents the run keeps", () => {
    /** The reads of live entries' attempt ids that one fold of `count` targets makes,
     *  with a live value for every attempt. */
    const reads = (count: number) => {
      const view = frontendView(startNext(wideControl(count)), wideBindings)
      let read = 0
      const entries = view.attemptsStatus === "loaded" ? view.attempts.map(({ id }, index) => ({
        get attemptId() {
          read += 1
          return id
        },
        sessionId: `member-${index}`,
        duration: 0,
        revision: 0,
      })) : []
      workflowOutline(view, undefined, entries)
      return { read, entries: entries.length }
    }
    for (const count of [3, 30]) {
      const { read, entries } = reads(count)
      expect(read).toBe(entries)
    }
  })

  it("makes each round of a repeat over a list phase its own phase, which carries its round, is named by the repeat, and is closed by its join", () => {
    const outline = workflowOutline(frontendView(dryControl(), dryBindings))
    expect(outline.phases.map(({ key, phaseId, round, name, state, join }) => [key, phaseId, round, name, state, join?.text])).toEqual([
      [`${dryRound(1)}:phase:1`, "finds", 1, "Hunt · round 1", "done", "Round 1 · Removed duplicates: kept 2, dropped 1"],
      [`${dryRound(2)}:phase:1`, "finds", 2, "Hunt · round 2", "done", "Round 2 · Removed duplicates: kept 1, dropped 2"],
      [`${dryRound(3)}:phase:1`, "finds", 3, "Hunt · round 3", "done", "Round 3 · Removed duplicates: kept 0, dropped 2 · dry"],
      ["dry:node:2:phase", "report", undefined, "Report", "done", undefined],
    ])
    expect(workflowPhaseTitle(outline.phases[1]!)).toBe("finds · round 2")
  })

  it("gives a voting list one row per vote, and reads a list with a failed item as failed once it settled", () => {
    const outline = workflowOutline(frontendView(findingsControl(), findingsBindings))
    const phase = (key: string) => outline.phases.find((candidate) => candidate.key === key)
    expect(phase(`${FINDINGS_REVIEWS}:phase:1`)).toMatchObject({ phaseId: "reviews", state: "failed", done: 3, total: 3, failed: 1, join: { text: "Removed duplicates: kept 2, dropped 1, 1 failed", tone: "done" } })
    expect(outlineLines(outline).find(({ phase: line }) => line.startsWith("list checks"))?.agents).toEqual(["F1 done: checks", "F2 done: checks"])
    expect(phase(`${FINDINGS_CHECKS}:phase:1`)?.join?.text).toBe("Voted: passed 1 of 2")
  })

  it("reads a phase that runs only if needed as conditional, and as skipped once the run settled without it", () => {
    expect(outlineLines(workflowOutline(frontendView(debugControl(), debugBindings))).map(({ phase }) => phase)).toEqual(["single investigate queued 0/1", "single fix conditional 0/1", "single verify conditional 0/1"])
    expect(outlineLines(workflowOutline(frontendView(drive(debugControl(), () => ({ handoff: { summary: "" } })), debugBindings))).map(({ phase }) => phase)).toEqual(["single investigate done 1/1", "single fix skipped 1/1", "single verify skipped 1/1"])
  })

  it("shows each agent of a parallel phase from before phases as its own agent, with its settled work", () => {
    const outline = workflowOutline(historyView)
    expect(outlineLines(outline)).toEqual([{ phase: "parallel build done 1/2", agents: ["investigate done: investigate", "fix conditional: fix"] }])
    expect(outline.phases[0]?.agents[0]).toEqual({ agentNodeId: "debug:1", label: "investigate", attemptId: "investigate-1", history: [], definitionId: "investigate", state: "done", operations: 4, seat: { briefId: "investigate", definitionId: "investigate" }, startedAt: 10, completedAt: 20, detail: "Found it" })
  })

  it("gives each agent of a phase the brief and persona of its own attempt", () => {
    const security = { id: "reviewer-code-security", roles: ["reviewer-security", "reviewer"] }
    const view = {
      attemptsStatus: "loaded",
      attempts: [
        { id: "lint-1", history: [], definitionId: "lint", briefId: "lint", name: "Lint", status: "completed", startedAt: 1, completedAt: 2 },
        { id: "security-1", history: [], definitionId: "security", briefId: "review", persona: security, name: "Security", status: "running", startedAt: 1 },
      ],
      tree: { nodes: [
        { id: "gates", kind: "phase", form: "parallel", phaseId: "gates", label: "Gates", parentId: null, disposition: "running" },
        { id: "gates:lint", kind: "agent", definitionId: "lint", label: "Lint", parentId: "gates", disposition: "completed", attempts: 1, currentAttemptId: "lint-1" },
        { id: "gates:security", kind: "agent", definitionId: "security", label: "Security", parentId: "gates", disposition: "running", attempts: 1, currentAttemptId: "security-1" },
      ] },
    } satisfies LoadedWorkflowView
    expect(workflowOutline(view).phases[0]?.agents.map(({ seat }) => seat)).toEqual([
      { briefId: "lint", definitionId: "lint" },
      { briefId: "review", definitionId: "security", persona: security },
    ])
  })

  it("times a phase from the first start of its agents, and ends it only once every agent settled", () => {
    const view = failedBranch()
    const timed = { ...view, attempts: view.attempts.map((row, at) => ({ ...row, startedAt: 1_000 * (at + 1), ...(row.status === "completed" || row.status === "failed" ? { completedAt: 1_000 * (at + 1) + 500 } : {}) })) }
    const [plan, implement] = workflowOutline(timed).phases
    expect(plan).toMatchObject({ startedAt: 1_000, completedAt: 1_500 })
    const starts = implement!.agents.flatMap(({ startedAt }) => startedAt ?? [])
    expect(implement?.startedAt).toBe(Math.min(...starts))
    expect(implement).not.toHaveProperty("completedAt")
    const done = frontendView(dryControl(), dryBindings)
    const settled = { ...done, attempts: done.attempts.map((row, at) => ({ ...row, startedAt: at, completedAt: 100 + at })) }
    const [round] = workflowOutline(settled).phases
    const ends = round!.agents.flatMap(({ completedAt }) => completedAt ?? [])
    expect(round?.completedAt).toBe(Math.max(...ends))
  })
})

describe("a place in the outline", () => {
  it("finds the phase and the agent of an agent, the latest agent of a history control node, and nothing for a node that is no agent", () => {
    const view = failedBranch()
    const outline = workflowOutline(view)
    expect(workflowAgentPlace(view.tree, outline, stage(3, 2))).toMatchObject({ phase: { key: `${MAP_GROUP}:phase:2` }, agent: { agentNodeId: stage(3, 2) }, index: 2 })
    expect(workflowAgentPlace(view.tree, outline, "mapped:node:1")).toMatchObject({ phase: { form: "single", phaseId: "plan" }, index: 0 })
    expect(workflowAgentPlace(view.tree, outline, `${MAP_GROUP}:phase:1`)).toBeUndefined()
    expect(workflowAgentPlace(view.tree, outline, "missing")).toBeUndefined()
    const agents = running()
    expect(workflowAgentPlace(agents.tree, workflowOutline(agents), inputStage(2, 1))).toMatchObject({ phase: { key: `${INPUT_GROUP}:phase:1` }, index: 1 })
    expect(workflowAgentPlace(historyView.tree, workflowOutline(historyView), "debug")).toMatchObject({ agent: { agentNodeId: "debug:2" }, index: 1 })
  })
})
