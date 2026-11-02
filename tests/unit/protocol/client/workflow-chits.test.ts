import { describe, expect, it } from "bun:test"
import { workflowChits } from "../../../../src/protocol/client/workflow-chits.js"

const sum = (segments: readonly { readonly chits: number }[]) => segments.reduce((total, { chits }) => total + chits, 0)
const bar = (segments: readonly { readonly tone: string; readonly chits: number }[]) => segments.map(({ tone, chits }) => `${tone}:${chits}`).join(" ")

describe("the chits of a workflow's progress", () => {
  it("draws one chit for each unit while the units fit the slots, in the order done, failed, running, parked, pending", () => {
    const segments = workflowChits({ done: 6, failed: 1, running: 11, parked: 0, total: 21 }, 30)
    expect(bar(segments)).toBe("done:6 failed:1 running:11 pending:3")
  })

  it.each([
    // A phase of 14 reviewer agents in 12 slots (T4) and in 8 slots (T6).
    [{ done: 2, failed: 1, running: 11, parked: 0, total: 14 }, 12, "done:2 failed:1 running:9"],
    [{ done: 2, failed: 1, running: 11, parked: 0, total: 14 }, 8, "done:1 failed:1 running:6"],
    // The plan bar of 21 units in 20 slots (T6) and in 12 slots (T7).
    [{ done: 6, failed: 1, running: 11, parked: 0, total: 21 }, 20, "done:6 failed:1 running:10 pending:3"],
    [{ done: 6, failed: 1, running: 11, parked: 0, total: 21 }, 12, "done:3 failed:1 running:6 pending:2"],
    // A phase of 30 agents (T15) and the plan bar of 32 units (T15).
    [{ done: 18, failed: 1, running: 6, parked: 1, total: 30 }, 12, "done:7 failed:1 running:2 parked:1 pending:1"],
    [{ done: 19, failed: 1, running: 6, parked: 1, total: 32 }, 30, "done:18 failed:1 running:5 parked:1 pending:5"],
  ])("shares %o out over exactly %i slots in proportion", (counts, slots, expected) => {
    const segments = workflowChits(counts, slots)
    expect(bar(segments)).toBe(expected)
    expect(sum(segments)).toBe(slots)
  })

  it("keeps one chit of its colour for one failed unit of 30", () => {
    const segments = workflowChits({ done: 29, failed: 1, running: 0, parked: 0, total: 30 }, 12)
    expect(bar(segments)).toBe("done:11 failed:1")
  })

  it("gives a spare chit by the share a state still lacks, so a forced chit never takes a second one", () => {
    // Shares of 10 slots: done 6.2 (6), failed 0.9 (forced to 1), pending
    // 2.9 (2). The spare chit goes to pending, whose share exceeds what it
    // holds by the most; the share minus its floor would give failed a second.
    const segments = workflowChits({ done: 62, failed: 9, running: 0, parked: 0, total: 100 }, 10)
    expect(bar(segments)).toBe("done:6 failed:1 pending:3")
  })

  it("draws no chit for a plan with no units", () => {
    expect(workflowChits({ done: 0, failed: 0, running: 0, parked: 0, total: 0 }, 12)).toEqual([])
  })
})
