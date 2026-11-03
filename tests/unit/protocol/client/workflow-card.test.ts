import { describe, expect, it } from "bun:test"
import type { AgentGroupBlock, WorkflowCard } from "../../../../src/infra/output-blocks.js"
import { workflowCard, workflowCardBar, workflowCardDisplayState, workflowCardHeaderParts, workflowCardLines, workflowCardTime, workflowPlanAbsence, workflowViewCardStatus, type WorkflowCardChoices, type WorkflowCardLine } from "../../../../src/protocol/client/workflow-card.js"
import { workflowOutline } from "../../../../src/protocol/client/workflow-outline.js"
import type { LoadedWorkflowView, WorkflowAgentLive, WorkflowTreeNode } from "../../../../src/protocol/workflow-view-protocol-types.js"
import { FANOUT, FANOUT_COMPLETED, FANOUT_FAILED, fanoutView, REVIEW_KEYS, type FanoutFixture } from "./_workflow-card-fixtures.js"

type Status = AgentGroupBlock["status"]

const choose = (phases: readonly (readonly [string, "expanded" | "folded"])[], all: readonly string[] = []): WorkflowCardChoices => ({ phases: new Map(phases), all: new Set(all) })

const card = (view: LoadedWorkflowView, options: { readonly settled?: boolean; readonly cut?: string; readonly choices?: WorkflowCardChoices } = {}) =>
  workflowCard(workflowOutline(view, options.cut), { settled: options.settled ?? false, ...(options.choices === undefined ? {} : { choices: options.choices }) })

/** Each line as one readable string. */
function lineText(line: WorkflowCardLine): string {
  switch (line.kind) {
    case "notice": return `"${line.text}"`
    case "fold": return line.text
    case "phase": return [`${line.state} ${line.title}`, line.count, line.detail?.text ?? line.agentNames?.join(" · "), line.choice].filter((part) => part !== undefined).join(" | ")
    case "agent": return `  ${line.last ? "└" : "├"} ${line.state} ${line.label}${line.detail === undefined ? "" : ` | ${line.detail.text}`}`
    case "counted": return `  └ ${line.text}`
    case "bar": return `bar ${line.label.map(({ text }) => text).join(" · ")}`
    case "followUp": return "follow-up"
  }
}

const lines = (outline: WorkflowCard, status: Status = "active", options: { readonly choices?: WorkflowCardChoices } = {}) =>
  workflowCardLines(outline, { status, live: [], ...(options.choices === undefined ? {} : { choices: options.choices }) }).map(lineText)

const fanout = (fixture: FanoutFixture, options: Parameters<typeof card>[1] = {}) => card(fanoutView(fixture), options)

/** A plan of `count` single phases, the phase at `runningAt` running. */
function phasesView(count: number, runningAt: number): LoadedWorkflowView {
  const nodes = Array.from({ length: count }, (_, index): WorkflowTreeNode[] => {
    const id = `s${index + 1}`
    const disposition = index < runningAt ? "completed" : index === runningAt ? "running" : "pending"
    return [
      { id: `${id}:phase`, kind: "phase", form: "single", phaseId: id, label: `S${index + 1}`, parentId: null, disposition },
      { id, kind: "agent", definitionId: id, label: `S${index + 1}`, parentId: `${id}:phase`, attempts: 0, disposition },
    ]
  }).flat()
  return { attemptsStatus: "loaded", attempts: [], tree: { nodes } }
}

/** A plan of list phases that run at once, each with `agents` running
 *  agents over the items `f1`, `f2`, and so on. */
function listsView(agents: readonly number[]): LoadedWorkflowView {
  const nodes = agents.flatMap((count, position): WorkflowTreeNode[] => {
    const phaseId = `p${position + 1}`
    return [
      { id: `${phaseId}:phase`, kind: "phase", form: "list", phaseId, label: phaseId, parentId: null, disposition: "running", list: { id: phaseId, expanded: true } },
      ...Array.from({ length: count }, (_, index): WorkflowTreeNode => ({
        id: `${phaseId}:${index + 1}`, kind: "agent", definitionId: phaseId, label: phaseId, parentId: `${phaseId}:phase`, disposition: "running", attempts: 0,
        item: { nodeId: `${phaseId}:item:${index + 1}`, key: `f${index + 1}`, label: `f${index + 1}`, ordinal: index + 1, text: `f${index + 1}` },
      })),
    ]
  })
  return { attemptsStatus: "loaded", attempts: [], tree: { nodes } }
}

const agentLines = (outline: WorkflowCard) => outline.phases.map(({ agents }) => agents?.length ?? 0)

describe("the workflow card", () => {
  it("shows every phase from launch, a phase of named agents with its count and its agents' names", () => {
    expect(lines(fanout(FANOUT.launched))).toEqual([
      "queued scout",
      "queued probe",
      "queued check",
      "queued review",
      "queued gates | 0/2 | lint · typecheck",
      "queued report",
      "bar 0/7 done",
    ])
  })

  it("uses the same newest-call sentence on a running agent and a phase of one agent", () => {
    const call = { name: "Searched", detail: "workflowSeatPair in src/tui" }
    const before: WorkflowAgentLive = { attemptId: "lanes:1:probe-1", sessionId: "probe-session", operations: 0, duration: 0, revision: 0, runtimeActivity: "thinking" }
    const thinking = workflowCardLines(fanout(FANOUT.lanes), { status: "active", live: [before] })
    expect(thinking.find((line) => line.kind === "agent" && line.agentNodeId === "lanes:1:probe")).toMatchObject({ detail: { kind: "state", text: "Thinking" } })
    const singleBefore = workflowCardLines(fanout(FANOUT.scout), { status: "active", live: [{ ...before, attemptId: "scout-1" }] })
    expect(singleBefore.find((line) => line.kind === "phase")).toMatchObject({ detail: { text: "Thinking", tone: "muted" } })
    const single = workflowCardLines(fanout(FANOUT.scout), { status: "active", live: [{ attemptId: "scout-1", sessionId: "scout-session", operations: 1, duration: 0, revision: 1, activity: call }] })
    expect(single.find((line) => line.kind === "phase")).toMatchObject({ activity: call })
    const parallel = workflowCardLines(fanout(FANOUT.lanes), { status: "active", live: [{ attemptId: "lanes:1:probe-1", sessionId: "probe-session", operations: 1, duration: 0, revision: 1, activity: call }] })
    expect(parallel.find((line) => line.kind === "agent" && line.agentNodeId === "lanes:1:probe")).toMatchObject({ detail: { kind: "activity", tool: "Searched", text: "workflowSeatPair in src/tui" } })
    const outline = workflowOutline(fanoutView(FANOUT.lanes))
    const full = workflowCardLines(workflowCard(outline, { settled: false, size: "full" }), { status: "active", outline, live: [] })
    expect(full.find((line) => line.kind === "phase" && line.title === "probe")).toMatchObject({ count: "2/3", detail: { text: "1 running", tone: "muted" } })
    const inlineWithSeats = workflowCardLines(workflowCard(outline, { settled: false }), { status: "active", outline, live: [] })
    expect(inlineWithSeats.find((line) => line.kind === "phase" && line.title === "probe")).toMatchObject({ count: "2/3", agentNames: ["api", "cli", "web"] })
  })

  it("keeps the full-size parallel phase's settled count instead of its join", () => {
    const outline = workflowOutline(fanoutView(FANOUT_COMPLETED))
    const phases = outline.phases.map((phase) => phase.phaseId === "gates" ? { ...phase, join: { text: "Collected 2 results", tone: "muted" as const } } : phase)
    const fullOutline = { ...outline, phases }
    const full = workflowCardLines(workflowCard(fullOutline, { settled: true, size: "full" }), { status: "completed", outline: fullOutline, live: [] })
    expect(full.find((line) => line.kind === "phase" && line.title === "gates")).toMatchObject({ detail: { text: "2/2 done", tone: "muted" } })
    const inline = workflowCardLines(workflowCard(fullOutline, { settled: true }), { status: "completed", outline: fullOutline, live: [] })
    expect(inline.find((line) => line.kind === "phase" && line.title === "gates")).toMatchObject({ count: "2/2", detail: { text: "Collected 2 results", tone: "muted" } })
  })

  it("shows each phase of a stream with its agents as a tree, running ones first, and the agent that waits says what for", () => {
    const outline = fanout(FANOUT.lanes)
    expect(lines(outline)).toEqual([
      "done scout | The wait command exited 0 after 3m 4s; gates/scout exists",
      "running probe | 2/3 | api · cli · web",
      "  ├ running api | Working",
      "  ├ done cli",
      "  └ done web",
      "running check | 0/3 | api · cli · web",
      "  ├ running cli | Working",
      "  ├ running web | Working",
      "  └ waiting api | waiting for its probe",
      "queued review",
      "queued gates | 0/2 | lint · typecheck",
      "queued report",
      "bar 3/11 done · 3 running",
    ])
  })

  it("shows at most six agent lines for a phase, then a counted line of the rest by state", () => {
    const outline = fanout(FANOUT.reviews)
    expect(lines(outline).slice(3, 11)).toEqual([
      `running review | 3/14 | ${REVIEW_KEYS.join(" · ")}`,
      ...REVIEW_KEYS.slice(3, 8).map((key) => `  ├ running ${key} | Working`),
      `  ├ running ${REVIEW_KEYS[8]} | Working`,
      "  └ +8 more · 3 done · 5 running",
    ])
    const bar = workflowCardBar(outline, "active")
    expect(bar.label.map(({ text }) => text)).toEqual(["10/24 done", "11 running"])
    // A narrow bar drops only the word `done`, so its words never mix short
    // and full forms.
    expect(bar.label.map(({ short }) => short)).toEqual(["10/24", "11 running"])
    expect(bar.counts).toEqual({ done: 10, failed: 0, running: 11, parked: 0, total: 24 })
  })

  it("shows at most ten agent lines in all, taking one from the phase with the most, the later on a tie, and never fewer than two", () => {
    expect(agentLines(card(listsView([30, 30])))).toEqual([5, 5])
    expect(agentLines(card(listsView([30, 30, 30])))).toEqual([4, 3, 3])
    expect(agentLines(card(listsView([8, 8, 8, 8, 8, 8])))).toEqual([2, 2, 2, 2, 2, 2])
    expect(agentLines(card(listsView([4, 4])))).toEqual([4, 4])
  })

  it("shows the agent a counted line would stand for, so a phase of two agents always shows both", () => {
    expect(agentLines(card(listsView([7])))).toEqual([7])
    expect(lines(fanout(FANOUT.gates)).slice(4, 7)).toEqual(["running gates | 1/2 | lint · typecheck", "  ├ running typecheck | Working", "  └ done lint"])
  })

  it("parks the agents an interrupt holds, in their lines and in the counted line, and the card's live status wins over the fold", () => {
    const interrupted = fanout(FANOUT.reviews, { cut: "interrupted" })
    expect(lines(interrupted, "paused").slice(3, 5)).toEqual([`parked review | 3/14 | ${REVIEW_KEYS.join(" · ")}`, `  ├ parked ${REVIEW_KEYS[3]} | interrupted`])
    expect(lines(interrupted, "paused")[10]).toBe("  └ +8 more · 3 done · 5 interrupted")
    expect(workflowCardBar(interrupted, "paused").label.map(({ text }) => text)).toEqual(["10/24 done", "11 interrupted"])
    // Once the cut settles, every agent it cut still reads parked.
    const settledCut = fanout(FANOUT.reviewsCut, { cut: "interrupted" })
    expect(lines(settledCut, "paused")[4]).toBe(`  ├ parked ${REVIEW_KEYS[3]} | interrupted`)
    // A resumed run reads running before its durable status catches up.
    expect(lines(interrupted, "active")[4]).toBe(`  ├ running ${REVIEW_KEYS[3]} | Working`)
    expect(workflowCardBar(interrupted, "active").counts).toMatchObject({ running: 11, parked: 0 })
    // In a run that goes on, an agent that its own interrupt holds counts
    // as interrupted on the bar, as on its phase line and in the agent
    // view's band, and the rest count as running.
    const held = { ...fanout(FANOUT.reviews), running: 10, parked: 1 }
    expect(workflowCardBar(held, "active").counts).toMatchObject({ running: 10, parked: 1 })
    expect(workflowCardBar(held, "active").label.map(({ text }) => text)).toEqual(["10/24 done", "10 running", "1 interrupted"])
    expect(workflowCardDisplayState("running", "paused")).toBe("parked")
    expect(workflowCardDisplayState("running", "active")).toBe("running")
    expect(workflowCardDisplayState("parked", "active")).toBe("running")
    // An agent that its own interrupt holds stays parked in a running card.
    expect(workflowCardDisplayState("parked", "active", true)).toBe("parked")
  })

  it("reads a run that a planned replacement paused as running while its successor owes the continuation, with every agent that the cut returned to pending running", () => {
    expect(workflowViewCardStatus("paused", { continuationOwed: true }, false)).toBe("active")
    expect(workflowViewCardStatus("paused", { continuationOwed: true }, true)).toBe("paused")
    expect(workflowViewCardStatus("paused", {}, false)).toBe("paused")
    expect(lines(fanout(FANOUT.reviewsCut), "active")[4]).toBe(`  ├ running ${REVIEW_KEYS[3]} | Working`)
  })

  it("counts a phase's time only while its run was active, so a resume hours later adds none of the wait", () => {
    // The run worked from launch until an interrupt at 600s and was resumed at 4000s.
    const timed = (streamingStartedAt: number | null) => workflowCard(workflowOutline(fanoutView(FANOUT.gates), undefined, undefined, { activeIntervals: [{ start: 0, end: 600_000 }], streamingStartedAt }), { settled: false })
    const phase = (outline: WorkflowCard, id: string) => workflowCardLines(outline, { status: "active", live: [] }).find((line): line is Extract<WorkflowCardLine, { readonly kind: "phase" }> => line.kind === "phase" && line.title === id)!
    // A settled phase counts its span: the scout ran from 0s to 184s.
    expect(workflowCardTime(phase(timed(null), "scout"), 9_000_000)).toBe("3m 4s")
    // The gates started at 580s, so 20s of their span fell before the
    // interrupt, and the wait adds nothing.
    expect(workflowCardTime(phase(timed(null), "gates"), 9_000_000)).toBe("20s")
    // While the interrupt holds the phase, its line shows the frozen time.
    expect(workflowCardTime({ ...phase(timed(null), "gates"), state: "parked" }, 9_000_000)).toBe("20s")
    // After the resume the time goes on from 20s.
    expect(workflowCardTime(phase(timed(4_000_000), "gates"), 4_010_000)).toBe("30s")
    // A phase with no run activity yet has no time.
    expect(workflowCardTime(phase(fanout(FANOUT.gates), "gates"), 4_010_000)).toBe("")
  })

  it("says what each phase did once the run settled, and keeps a failed agent's line under its phase", () => {
    const failed = fanout(FANOUT_FAILED, { settled: true })
    expect(lines(failed, "error")).toEqual([
      "done scout | The wait command exited 0 after 3m 4s; gates/scout exists",
      "done probe | 3/3 | api · cli · web",
      "done check | 3/3 | Collected 3 results",
      "failed review | 13/14 | Collected 13 results, 1 failed",
      "  └ failed db.ts | the step ended without a handoff",
      "skipped gates | 0/2 | skipped",
      "skipped report | skipped",
      "bar 23/24 done · 1 failed",
    ])
    // A failed agent is finished but not done, so the bar counts it failed.
    expect(workflowCardBar(failed, "error").counts).toEqual({ done: 23, failed: 1, running: 0, parked: 0, total: 24 })
    expect(lines(fanout(FANOUT_COMPLETED, { settled: true }), "completed").slice(4, 6)).toEqual(["done gates | 2/2 | lint · typecheck", "done report | The report gate file exists, so the wait exited 0"])
  })

  it("reads the work a Stop cut as skipped, and its phase counts the finished agents against the stopped ones", () => {
    const stopped = fanout(FANOUT.reviews, { settled: true, cut: "stopped" })
    expect(lines(stopped, "stopped").slice(3)).toEqual(["skipped review | 3/14 | 11 stopped", "skipped gates | 0/2 | not started", "skipped report | not started", "bar 10/24 done"])
    // A list's failed agent counts as finished, as its join counts it, and
    // its line stays under the phase (T12).
    const reviews = REVIEW_KEYS.map((key, index) => key === "db.ts" ? { disposition: "failed" as const, startedAt: 500, completedAt: 560, reason: "Type check failed" }
      : index < 9 ? { disposition: "completed" as const, startedAt: 500, completedAt: 569 } : { disposition: "running" as const, startedAt: 507 })
    expect(lines(fanout({ ...FANOUT.reviews, reviews }, { settled: true, cut: "stopped" }), "stopped").slice(3, 5)).toEqual(["skipped review | 8/14 | 5 stopped", "  └ failed db.ts | Type check failed"])
    expect(workflowCardDisplayState("running", "stopped")).toBe("skipped")
    expect(workflowCardDisplayState("waiting", "cancelled")).toBe("skipped")
    expect(workflowCardDisplayState("done", "stopped")).toBe("done")
  })

  it("holds a person's choice across progress, and lists an expanded settled phase in item order", () => {
    const folded = choose([["reviews:phase:1", "folded"]])
    expect(lines(fanout(FANOUT.reviews, { choices: folded }), "active", { choices: folded }).slice(3, 5)).toEqual([`running review | 3/14 | ${REVIEW_KEYS.join(" · ")} | folded`, "queued gates | 0/2 | lint · typecheck"])
    const expanded = choose([["reviews:phase:1", "expanded"]])
    const completed = lines(fanout(FANOUT_COMPLETED, { settled: true, choices: expanded }), "completed", { choices: expanded })
    expect(completed.slice(3, 11)).toEqual([
      "done review | 14/14 | Collected 14 results | expanded",
      ...REVIEW_KEYS.slice(0, 5).map((key) => `  ├ done ${key} | Reviewed ${key}`),
      `  ├ done ${REVIEW_KEYS[5]} | Reviewed ${REVIEW_KEYS[5]}`,
      "  └ +8 more · 8 done",
    ])
    // The phase stays expanded once its agents settle, while the run goes on.
    expect(lines(fanout(FANOUT.gates, { choices: expanded }), "active", { choices: expanded })[4]).toBe(`  ├ done ${REVIEW_KEYS[0]} | Reviewed ${REVIEW_KEYS[0]}`)
  })

  it("lists every agent of a phase whose counted line a person selected, outside the caps", () => {
    const all = choose([["reviews:phase:1", "expanded"]], ["reviews:phase:1"])
    const outline = fanout(FANOUT_COMPLETED, { settled: true, choices: all })
    expect(outline.phases[3]?.agents?.map(({ label }) => label)).toEqual([...REVIEW_KEYS])
    expect(outline.phases[3]?.agentsMore).toBeUndefined()
  })

  it("gives each agent of a phase the brief and persona of its own attempt", () => {
    const view = fanoutView(FANOUT.reviews)
    const attempts = view.attempts.map((attempt) => attempt.id === "reviews:4:review-1" ? { ...attempt, briefId: "review-strict", persona: { id: "skeptic", roles: ["skeptic", "reviewer"] } }
      : attempt.id === "reviews:5:review-1" ? { ...attempt, persona: { id: "pragmatist", roles: ["pragmatist"] } } : attempt)
    const agents = card({ ...view, attempts }).phases[3]?.agents ?? []
    expect(agents.slice(0, 3).map(({ label, briefId, persona }) => ({ label, briefId, persona }))).toEqual([
      { label: REVIEW_KEYS[3], briefId: "review-strict", persona: "skeptic" },
      { label: REVIEW_KEYS[4], briefId: undefined, persona: "pragmatist" },
      { label: REVIEW_KEYS[5], briefId: undefined, persona: undefined },
    ])
  })

  it("shows at most eight phase lines, keeping the running phase with the finished one before it and folding the rest", () => {
    expect(lines(card(phasesView(20, 10))).slice(0, -1)).toEqual(["✓ 9 done", "done s10", "running s11 | Working", "queued s12", "queued s13", "queued s14", "queued s15", "○ 5 more"])
    const settled = lines(card(phasesView(20, 20), { settled: true }), "completed").slice(0, -1)
    expect(settled).toHaveLength(8)
    expect(settled.at(-1)).toBe("done s20")
    expect(lines(card(phasesView(8, 2))).slice(0, -1)).toHaveLength(8)
  })
})

describe("the workflow card's header", () => {
  it("names only the state and the time", () => {
    const parts = (block: Parameters<typeof workflowCardHeaderParts>[0]) => workflowCardHeaderParts(block, 10_000).map(({ text }) => text)
    expect(parts({ status: "active", duration: 1000, activeStartedAt: 5000 })).toEqual(["6s"])
    expect(parts({ status: "paused", pausedBy: "person", duration: 571_000 })).toEqual(["Interrupted", "9m 31s"])
    expect(parts({ status: "error", duration: 662_000 })).toEqual(["Failed", "11m 2s"])
    expect(parts({ status: "completed", duration: 686_000 })).toEqual(["Completed", "11m 26s"])
  })
})

describe("workflowPlanAbsence", () => {
  const restart = { kind: "workflow" as const, admittedActions: ["workflow.restart", "session.delete"] }
  it("states in place of the plan why saved progress that cannot run waits, and what Restart does, before the run settles", () => {
    expect(workflowPlanAbsence(restart, { status: "pending" })).toEqual({ text: "This workflow's saved progress cannot run. Restart runs it again from its recorded request.", notice: true })
  })
  it("says that a settled run's plan is unavailable, and says nothing while a run that has no notice starts", () => {
    expect(workflowPlanAbsence(undefined, { status: "completed" })).toEqual({ text: "This workflow's plan is unavailable.", notice: false })
    expect(workflowPlanAbsence(undefined, { status: "active" })).toBeUndefined()
  })
  it("leaves a run with a plan, and a launch that failed before it ran, to their own lines", () => {
    expect(workflowPlanAbsence(restart, { status: "paused", card: workflowCard(workflowOutline(fanoutView(FANOUT.scout)), { settled: false }) })).toBeUndefined()
    expect(workflowPlanAbsence(restart, { status: "error", failure: { message: "Unknown source" } })).toBeUndefined()
  })
})
