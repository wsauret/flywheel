import { describe, expect, it } from "bun:test"
import type { FrontendOutputBlock } from "../../../../src/protocol/app-service-types.js"
import { workflowAgentFigures } from "../../../../src/protocol/client/workflow-card.js"
import { workflowAgentBand, workflowAgentHeaderDrops, workflowAgentLine, workflowAgentModel, workflowAgentMove, workflowAgentOpenTarget, workflowAgentTitle, workflowBackLabel, workflowBriefLine, workflowNextAgentLabel, workflowSeatRoleText, type WorkflowAgentModel } from "../../../../src/protocol/client/workflow-agent.js"
import { workflowOutline } from "../../../../src/protocol/client/workflow-outline.js"
import { attemptOf, inputStage as wideStage, stage } from "../../workflows/vm/_map-fixtures.js"
import { completeAttempt } from "../../../../src/workflows/vm/attempt-transitions.js"
import { drive, failedBranch, findingsBindings, findingsControl, frontendView, interrupt, phaseBindings, phaseControl, startNext, wideBindings, wideControl } from "../../workflows/vm/_tree-fixtures.js"

const pinned = (agentNodeId: string) => ({ agentNodeId, follow: false })

describe("the agent view of one agent", () => {
  it("moves agent by agent through every phase in run order, from the agent the workflow's control acts on, and wraps", () => {
    const failed = failedBranch()
    const walk = (view: typeof failed, steps: number, direction: 1 | -1 = 1) => {
      const seen: string[] = []
      let open: WorkflowAgentModel | undefined
      for (let step = 0; step < steps; step++) {
        const target = workflowAgentMove(view, open, direction)
        expect(target?.follow).toBe(false)
        open = workflowAgentModel(view, target!)
        seen.push(`${open?.phaseId} ${open?.label}`)
      }
      return seen
    }
    // The control acts on item c's implement agent, which has not started,
    // so Tab starts at the first agent that started and visits only those,
    // the agent of the phase of one agent among them.
    expect(walk(failed, 5)).toEqual(["plan plan", "implement a", "implement b", "review a", "plan plan"])
    expect(walk(failed, 2, -1)).toEqual(["review a", "implement b"])
    // From the end of one phase into the next, and around.
    const findings = frontendView(findingsControl(), findingsBindings)
    expect(walk(findings, 6)).toEqual(["reviews b.ts", "reviews a.ts", "reviews c.ts", "checks F1", "checks F2", "report report"])
    // The agent of a phase of one agent opens too, once it started; before
    // any agent starts, the keys open nothing.
    const single = frontendView(startNext(phaseControl(false)), phaseBindings(false))
    const first = workflowAgentMove(single, undefined, 1)
    expect(first).toBeDefined()
    expect(workflowAgentModel(single, first!)).toMatchObject({ kind: "single", state: "running" })
    expect(workflowAgentModel(single, first!)?.position).toBeUndefined()
    expect(workflowNextAgentLabel(workflowAgentModel(single, first!))).toBe("Next agent")
    expect(workflowAgentMove(frontendView(phaseControl(false), phaseBindings(false)), undefined, 1)).toBeUndefined()
  })

  it("follows an item to its next phase once that agent runs, and stays on a pinned agent or a settled one", () => {
    const first = startNext(wideControl(1))
    const running = frontendView(first, wideBindings)
    expect(workflowAgentModel(running, { agentNodeId: wideStage(1, 1), follow: true })).toMatchObject({ agentNodeId: wideStage(1, 1), follow: true, state: "running" })
    const attemptId = attemptOf(wideStage(1, 1))
    const finished = completeAttempt(first, { type: "ATTEMPT_SUCCEEDED", outcome: { attemptId, conversationId: `conversation-${attemptId}`, handoff: { summary: "done" }, reassessment: null } }).committed
    const successor = startNext(finished)
    const moved = frontendView(successor, wideBindings)
    expect(workflowAgentModel(moved, { agentNodeId: wideStage(1, 1), follow: true })).toMatchObject({ agentNodeId: wideStage(1, 2), definitionId: "review", state: "running" })
    const settled = frontendView(completeAttempt(successor, { type: "ATTEMPT_SUCCEEDED", outcome: { attemptId: attemptOf(wideStage(1, 2)), conversationId: `conversation-${attemptOf(wideStage(1, 2))}`, handoff: { summary: "reviewed" }, reassessment: null } }).committed, wideBindings)
    expect(workflowAgentModel(settled, { agentNodeId: wideStage(1, 1), follow: true })).toMatchObject({ agentNodeId: wideStage(1, 2), state: "done" })
    expect(workflowAgentModel(settled, pinned(wideStage(1, 1)))).toMatchObject({ agentNodeId: wideStage(1, 1), follow: false, state: "done" })
    const skipped = frontendView(drive(wideControl(1), () => ({ fail: "implementation failed" })), wideBindings)
    expect(workflowAgentModel(skipped, { agentNodeId: wideStage(1, 1), follow: true })).toMatchObject({ agentNodeId: wideStage(1, 1), state: "failed" })
    expect(workflowAgentModel(moved, pinned(wideStage(1, 1)))).toMatchObject({ agentNodeId: wideStage(1, 1), follow: false, definitionId: "implement", state: "done" })
    // A settled agent whose item runs nowhere stays shown, and the view never moves back to an earlier phase.
    expect(workflowAgentModel(frontendView(finished, wideBindings), { agentNodeId: wideStage(1, 1), follow: true })).toMatchObject({ agentNodeId: wideStage(1, 1), state: "done" })
    expect(workflowAgentModel(running, { agentNodeId: wideStage(1, 2), follow: true })).toMatchObject({ agentNodeId: wideStage(1, 2), state: "waiting" })
  })

  it("places the open agent among the agents of its phase on the control that opens the next one", () => {
    const view = frontendView(wideControl(14), wideBindings)
    const model = workflowAgentModel(view, pinned(wideStage(7, 1)))!
    expect(model.position).toBe("7/14")
    expect(workflowNextAgentLabel(model)).toBe("Next agent 7/14")
  })

  it("names the phase by its id, the agent by its item key, and the phase whose handoff its brief carries, with the agent's name for hover", () => {
    const view = failedBranch()
    const model = workflowAgentModel(view, pinned(stage(1, 2)))!
    expect(model).toMatchObject({
      kind: "list",
      phaseId: "review",
      label: "a",
      definitionId: "review",
      name: "Review",
      from: "implement",
      state: "done",
      running: false,
      current: false,
    })
  })

  it("opens a running or interrupted agent following its item, and a settled agent pinned", () => {
    expect(workflowAgentOpenTarget({ agentNodeId: "a", state: "running" })).toEqual({ agentNodeId: "a", follow: true })
    expect(workflowAgentOpenTarget({ agentNodeId: "a", state: "parked" })).toEqual({ agentNodeId: "a", follow: true })
    expect(workflowAgentOpenTarget({ agentNodeId: "a", state: "done" })).toEqual({ agentNodeId: "a", follow: false })
    expect(workflowAgentOpenTarget({ agentNodeId: "a", state: "failed" })).toEqual({ agentNodeId: "a", follow: false })
  })

  it("names the way back by the place that the view opened from, the workflow apart from it every time, and the whole workflow's progress in the words of its plan bar", () => {
    const names = { chat: "Fanout-fail", workflow: "Fanout Ui" }
    expect(workflowBackLabel("chat", names)).toBe("Fanout-fail")
    expect(workflowBackLabel("card", names)).toBe("All agents")
    const view = failedBranch()
    // From the full-size card the way back names the card, so the
    // workflow's name stands apart from it, as it does from the chat.
    expect(workflowAgentBand("card", names, workflowOutline(view))).toEqual({
      back: "All agents",
      name: "Fanout Ui",
      progress: { word: "workflow", counts: { done: 4, failed: 1, running: 0, parked: 0, total: 8 }, label: [
        { text: "4/8 done", short: "4/8", tone: "plain" },
        { text: "1 failed", short: "1 failed", tone: "failed" },
      ] },
    })
    expect(workflowAgentBand("chat", names, workflowOutline(view))).toMatchObject({ back: "Fanout-fail", name: "Fanout Ui" })
    // A chat titled as its workflow still shows the workflow's name.
    expect(workflowAgentBand("chat", { chat: "Fanout Ui", workflow: "Fanout Ui" }, undefined)).toEqual({ back: "Fanout Ui", name: "Fanout Ui" })
  })

  it("draws the agent line as its phase, its own name, its persona, brief, and model, and at the right its state, time, and operations", () => {
    const model = workflowAgentModel(failedBranch(), pinned(stage(1, 2)))!
    // An agent of a list is its item, never the record id that every agent of its phase shares.
    expect(workflowAgentLine(model, "opus-5.5 high", 0)).toEqual({
      phase: "review",
      name: "a",
      how: [{ kind: "model", text: "opus-5.5 high" }],
      facts: [{ kind: "state", text: "done" }],
    })
    // The agent's session takes the same words as its title.
    expect(workflowAgentTitle(failedBranch(), stage(1, 2))).toBe("review › a")
    const parked: WorkflowAgentModel = { ...model, state: "parked", stateText: "interrupted", operations: 1, activeMs: 47_000 }
    expect(workflowAgentLine(parked, undefined, 99_000)).toMatchObject({
      facts: [{ kind: "state", text: "interrupted" }, { kind: "time", text: "47s" }, { kind: "operations", text: "1 op" }],
    })
    // A named agent is its agent id. The persona reads as its id, and the
    // brief shows only when it is not named after the agent's record.
    const named = workflowAgentModel(frontendView(startNext(startNext(phaseControl(true))), phaseBindings(true)), pinned("side-by-side:node:1:node:2"))!
    expect(named).toMatchObject({ kind: "parallel", label: "review" })
    expect(workflowAgentLine(named, "opus-5.5 high", 0)).toMatchObject({ name: "review", how: [{ kind: "model", text: "opus-5.5 high" }] })
    expect(workflowAgentTitle(frontendView(startNext(startNext(phaseControl(true))), phaseBindings(true)), "side-by-side:node:1:node:2")).toMatch(/ › review$/)
    const security: WorkflowAgentModel = { ...named, label: "security", definitionId: "security", seat: { briefId: "mapped.review", definitionId: "security", persona: { id: "reviewer-code-security", roles: ["reviewer-security"] } } }
    expect(workflowAgentLine(security, "opus-5.5 high", 0).how).toEqual([{ kind: "persona", text: "reviewer-code-security" }, { kind: "brief", text: "brief review" }, { kind: "model", text: "opus-5.5 high" }])
    // The full-size card names the persona and the brief in the same words.
    expect(workflowSeatRoleText(security.seat)).toBe("reviewer-code-security · brief review")
    // The agent of a phase of one agent shows only its phase.
    const single = frontendView(startNext(phaseControl(false)), phaseBindings(false))
    const only = workflowAgentModel(single, workflowAgentMove(single, undefined, 1)!)!
    expect(workflowAgentLine(only, undefined, 0)).toEqual({ phase: only.phaseId, how: [], facts: [{ kind: "state", text: "running" }] })
    // The follow-up conversation is no agent.
    expect(workflowAgentLine(undefined, undefined, 0)).toEqual({ name: "follow-up", how: [], facts: [] })
  })

  it("drops the parts of a narrow line in its order, and keeps every dropped part that fits once a later part is gone", () => {
    // Each line: the columns that its kept text takes, and the columns of each part it can drop.
    const lines = {
      band: { base: 40, parts: { workflowWord: 10, chits: 24, countWords: 8 } },
      agent: { base: 30, parts: { operations: 7, model: 24, persona: 22, brief: 12, time: 6 } },
    } as const
    const drops = (line: keyof typeof lines, room: number) => {
      const { base, parts } = lines[line]
      const width = (dropped: ReadonlySet<string>) => base + Object.entries(parts).reduce((sum, [part, columns]) => sum + (dropped.has(part) ? 0 : columns), 0)
      return [...workflowAgentHeaderDrops(line, (dropped) => width(dropped) <= room)].sort()
    }
    expect(drops("band", 82)).toEqual([])
    expect(drops("band", 81)).toEqual(["workflowWord"])
    // Once the chits are gone, the word fits again and stays.
    expect(drops("band", 58)).toEqual(["chits"])
    expect(drops("band", 57)).toEqual(["chits", "workflowWord"])
    // The count reads its short words only once the word and the chits are gone.
    expect(drops("band", 47)).toEqual(["chits", "countWords", "workflowWord"])
    expect(drops("agent", 101)).toEqual([])
    expect(drops("agent", 100)).toEqual(["operations"])
    // The model must go, and then the operations fit again.
    expect(drops("agent", 77)).toEqual(["model"])
    expect(drops("agent", 76)).toEqual(["model", "operations"])
    // A line that does not fit with every part gone drops them all.
    expect(drops("agent", 0)).toEqual(["brief", "model", "operations", "persona", "time"])
  })

  it("names the brief an agent received by its item, the phase whose handoff it carries, and its lines", () => {
    const prompt = (content: string): Extract<FrontendOutputBlock, { readonly kind: "userMessage" }> => ({ kind: "userMessage", id: "prompt", content, timestamp: 0, pending: false, injected: false })
    const view = failedBranch()
    expect(workflowBriefLine(workflowAgentModel(view, pinned(stage(1, 2)))!, prompt("one\ntwo\nthree"))).toBe("Brief · item a · from implement · 3 lines")
    expect(workflowBriefLine(workflowAgentModel(view, pinned(stage(1, 1)))!, prompt("one"))).toBe("Brief · item a · 1 line")
    expect(workflowBriefLine({ ...workflowAgentModel(view, pinned(stage(1, 1)))!, kind: "parallel", definitionId: "typecheck" }, prompt("a\nb"))).toBe("Brief · agent typecheck · 2 lines")
    expect(workflowBriefLine({ ...workflowAgentModel(view, pinned(stage(1, 1)))!, kind: "single", definitionId: "fix", from: "investigate" }, prompt("a"))).toBe("Brief · from investigate · 1 line")
  })

  it("marks the interrupted current agent from its attempt carrier, in the words its roster row uses", () => {
    const paused = frontendView(interrupt(startNext(wideControl(3))), wideBindings)
    expect(workflowAgentModel(paused, pinned(wideStage(1, 1)), "interrupted", [{ attemptId: attemptOf(wideStage(1, 1)), sessionId: "member-1", operations: 0, interruptedAt: 1, duration: 0, revision: 0 }])).toMatchObject({ state: "parked", stateText: "interrupted", current: true, running: false })
    expect(workflowAgentModel(paused, pinned(wideStage(2, 1)), "interrupted")).toMatchObject({ state: "queued", stateText: "queued", emptyText: "This agent has not started.", current: false })
    expect(workflowAgentModel(paused, pinned(wideStage(2, 2)), "interrupted")).toMatchObject({ state: "waiting", stateText: "waiting for its implement" })
  })

  it("says that a running agent with no transcript yet has not written anything, not that it has not started", () => {
    const running = frontendView(startNext(wideControl(3)), wideBindings)
    expect(workflowAgentModel(running, pinned(wideStage(1, 1)))).toMatchObject({ state: "running", stateText: "running", emptyText: "This agent has not written anything yet." })
  })

  it("reads an agent's time from its session's clock, so an interrupt and the wait before a resume add none", () => {
    expect(workflowAgentFigures({ activeMs: 38_000 }, 99_000)).toBe("38s")
    expect(workflowAgentFigures({ activeMs: 0, activeStartedAt: 1_000 }, 53_000)).toBe("52s")
    expect(workflowAgentFigures({}, 53_000)).toBe("")
    const view = frontendView(startNext(startNext(wideControl(2))), wideBindings)
    const attemptId = attemptOf(wideStage(1, 1))
    // Interrupted after 38s of work: the time holds while the agent waits.
    const live = [{ attemptId, sessionId: "member-1", operations: 4, interruptedAt: 39_000, duration: 38_000, revision: 0 }]
    const model = workflowAgentModel(view, pinned(wideStage(1, 1)), undefined, live)!
    expect(model).toMatchObject({ state: "parked", stateText: "interrupted", running: false, activeMs: 38_000 })
    expect(workflowAgentFigures(model, 99_000)).toBe("38s")
    expect(workflowAgentFigures(model, 199_000)).toBe("38s")
    // Resumed an hour later: its time goes on from 38s, not from its first start.
    const resumed = workflowAgentModel(view, pinned(wideStage(1, 1)), undefined, [{ attemptId, sessionId: "member-1", operations: 4, duration: 38_000, activeStartedAt: 3_639_000, revision: 0 }])!
    expect(resumed).toMatchObject({ state: "running", activeMs: 38_000, activeStartedAt: 3_639_000 })
    expect(workflowAgentFigures(resumed, 3_649_000)).toBe("48s")
    expect(workflowAgentLine(resumed, undefined, 3_649_000).facts).toContainEqual({ kind: "time", text: "48s" })
    const pending = { ...view, tree: { ...view.tree, nodes: view.tree.nodes.map((node) => node.disposition === "running" && node.kind === "agent" ? { ...node, disposition: "pending" as const } : node) } }
    expect(workflowAgentModel(pending, pinned(wideStage(1, 1)), undefined, live)).toMatchObject({ state: "parked", operations: 4 })
  })
})
