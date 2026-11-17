import { describe, expect, it } from "bun:test"
import type { FrontendOutputBlock, FrontendToolEntry } from "../../../../src/protocol/app-service-types.js"
import { createTurnFolds, foldTurns, gatherCallStretches, rowIdentity, type CallStretch, type TurnFold } from "../../../../src/protocol/client/turn-folds.js"

const person: FrontendOutputBlock = { kind: "userMessage", id: "person", content: "Look into the flaky test", timestamp: 1000, pending: false, injected: false }
const route: FrontendToolEntry = { kind: "tool", id: "route", name: "route_request", action: "ui_meta", presentation: { name: "Route to new session", detail: "" }, status: "completed", timestamp: 2000 }
const answer: FrontendOutputBlock = { kind: "text", id: "a1", content: "A new chat investigates it.", timestamp: 3000 }
// A hidden notice woke the lead after its answer: the first row of the new turn carries the runtime's mark.
const progress: FrontendToolEntry = { kind: "tool", id: "progress", name: "chat_progress", action: "ui_meta", presentation: { name: "Session progress", detail: "" }, status: "completed", timestamp: 10_000, turnStart: true }
const comment: FrontendOutputBlock = { kind: "text", id: "a2", content: "That chat asks you a question.", timestamp: 12_000 }

const presented = (rows: readonly FrontendOutputBlock[]) => ({ rows, boundaryBefore: rows.map(() => false) })
const rowNames = (rows: readonly (FrontendOutputBlock | TurnFold<FrontendOutputBlock>)[]) => rows.map((row) => row.kind === "turnFold"
  ? `fold(${row.rows.map(rowIdentity).join(",")}; ${row.duration}ms)`
  : rowIdentity(row))

describe("the shared turn fold", () => {
  it("ends a turn where a turn that the runtime started begins, so the earlier answer stays in view and each turn folds alone", () => {
    expect(rowNames(foldTurns(presented([person, route, answer, progress, comment]), true).rows)).toEqual([
      "userMessage:person", "fold(tool:route; 2000ms)", "text:a1", "fold(tool:progress; 2000ms)", "text:a2",
    ])
  })

  it("keeps a settled fold folded while the turn that a notice started runs", () => {
    const fold = createTurnFolds()
    const settled = rowNames(fold(presented([person, route, answer]), true, () => undefined).rows)
    const running = rowNames(fold(presented([person, route, answer, { ...progress, status: "pending" }]), false, () => undefined).rows)
    expect(running).toEqual([...settled, "tool:progress"])
  })
})

const narration: FrontendOutputBlock = { kind: "text", id: "narration", content: "I will start a chat.", timestamp: 1500 }
const thought: FrontendOutputBlock = { kind: "thinking", id: "thought", content: "Which chat?", status: "completed", timestamp: 2500 }
const report: FrontendOutputBlock = {
  kind: "userMessage", id: "msg:done:lead-report:final", content: "The build passes.", timestamp: 60_000, pending: false, injected: false,
  from: { sessionId: "done", name: "DAG Failures", relation: "other" },
}
const stretchNames = (rows: readonly (FrontendOutputBlock | CallStretch<FrontendOutputBlock>)[]) => rows.map((row) => row.kind === "callStretch"
  ? `${row.open ? "open" : "closed"}(${row.rows.map(rowIdentity).join(",")}; ${row.duration}ms)`
  : rowIdentity(row))

describe("the stretches of calls under their headings", () => {
  it("gathers each run of calls and thoughts under one heading at its place, and never gathers words or other rows", () => {
    const second = { ...progress, id: "second", turnStart: undefined, timestamp: 20_000 }
    const rows = [person, narration, route, thought, answer, report, second]
    expect(stretchNames(gatherCallStretches(presented(rows), false).rows)).toEqual([
      "userMessage:person", "text:narration", "closed(tool:route,thinking:thought; 1000ms)", "text:a1",
      "userMessage:msg:done:lead-report:final", "closed(tool:second; 0ms)",
    ])
    // A run of thoughts with no call is no stretch of calls.
    expect(stretchNames(gatherCallStretches(presented([narration, thought, answer]), false).rows)).toEqual(["text:narration", "thinking:thought", "text:a1"])
    // A thought before the first call keeps its place; the stretch starts at the call.
    expect(stretchNames(gatherCallStretches(presented([narration, thought, route, answer]), false).rows)).toEqual(["text:narration", "thinking:thought", "closed(tool:route; 1000ms)", "text:a1"])
  })

  it("lasts from its first call to the last call that a run of calls holds", () => {
    const run = { kind: "toolRun" as const, id: "run", timestamp: 1000, children: [{ ...route, timestamp: 1000 }, { ...route, id: "again", timestamp: 61_000 }] }
    expect(gatherCallStretches({ rows: [narration, run], boundaryBefore: [false, false] }, false).rows.at(-1)).toMatchObject({ kind: "callStretch", duration: 60_000 })
  })

  it("measures calls that end their turn to when the last call returned, never to a report that arrives later", () => {
    const checked: FrontendToolEntry = { ...progress, id: "checked", turnStart: undefined, timestamp: 2200, settledAt: 2900 }
    const quiet = [person, narration, { ...route, settledAt: 2400 }, checked, report]
    expect(stretchNames(gatherCallStretches(presented(quiet), false).rows)).toEqual([
      "userMessage:person", "text:narration", "closed(tool:route,tool:checked; 900ms)", "userMessage:msg:done:lead-report:final",
    ])
  })

  it("opens the stretch that runs at the end of the transcript, and closes it once a row follows or the turn settles", () => {
    const pending: FrontendToolEntry = { ...route, status: "pending" }
    expect(stretchNames(gatherCallStretches(presented([person, narration, pending]), true).rows)).toEqual(["userMessage:person", "text:narration", "open(tool:route; 0ms)"])
    expect(stretchNames(gatherCallStretches(presented([person, narration, route, answer]), true).rows)).toEqual(["userMessage:person", "text:narration", "closed(tool:route; 1000ms)", "text:a1"])
    expect(stretchNames(gatherCallStretches(presented([person, narration, route]), false).rows)).toEqual(["userMessage:person", "text:narration", "closed(tool:route; 0ms)"])
  })

  it("lets the person's choice win under an id that holds while the stretch grows", () => {
    const later: FrontendToolEntry = { ...progress, id: "later", turnStart: undefined, timestamp: 2600, endedAt: 4000 }
    const first = gatherCallStretches(presented([narration, route]), true).rows.at(-1)
    const grown = gatherCallStretches(presented([narration, route, later]), true).rows.at(-1)
    if (first?.kind !== "callStretch" || grown?.kind !== "callStretch") throw new Error("the calls gathered under no heading")
    const id = grown.id
    expect(id).toBe(first.id)
    expect(stretchNames(gatherCallStretches(presented([narration, route, later]), true, (key) => key === id ? false : undefined).rows)).toEqual(["text:narration", "closed(tool:route,tool:later; 2000ms)"])
    expect(stretchNames(gatherCallStretches(presented([narration, route, later, answer]), false, (key) => key === id ? true : undefined).rows)).toEqual(["text:narration", "open(tool:route,tool:later; 2000ms)", "text:a1"])
  })

  it("keeps the divider before each row, so narration that resumes after the calls keeps its divider", () => {
    const view = { rows: [narration, route, answer], boundaryBefore: [true, false, true] }
    expect(gatherCallStretches(view, false).boundaryBefore).toEqual([true, false, true])
  })
})
