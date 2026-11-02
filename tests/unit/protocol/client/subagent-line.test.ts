import { describe, expect, it } from "bun:test"
import type { AgentGroupBlock } from "../../../../src/infra/output-blocks.js"
import { subagentHeaderParts, subagentLine } from "../../../../src/protocol/client/subagent-line.js"
import { childCardStatus, subagentCardControls } from "../../../../src/protocol/client/session-controls.js"

const base: Omit<AgentGroupBlock, "status"> = {
  kind: "agentGroup", containerKind: "subagent", id: "child", toolUseId: "dispatch",
  label: "Explorer", description: "Trace the issue", model: "model high",
  children: [], totalToolCount: 3, totalTokens: 900, timestamp: 1, duration: 2000,
}

describe("subagent agent line", () => {
  it.each([
    ["active", "running", "●", "running", { kind: "activity", tool: "Read", text: "a.ts" }],
    ["pending", "running", "●", "running", { kind: "activity", tool: "Read", text: "a.ts" }],
    ["queued", "queued", "○", "muted", undefined],
    ["completed", "done", "✓", "done", { kind: "summary", text: "Fixed the issue" }],
    ["partial", "partial", "◐", "warning", { kind: "state", text: "Partial: Fixed the issue" }],
    ["interrupted", "parked", "‖", "warning", { kind: "state", text: "Interrupted" }],
    ["stopped", "skipped", "–", "muted", { kind: "reason", text: "Stopped" }],
    ["cancelled", "skipped", "–", "muted", { kind: "reason", text: "Canceled" }],
  ] as const)("maps %s with its elapsed time", (status, state, glyph, tone, detail) => {
    const line = subagentLine({ ...base, status, activity: { name: "Read", detail: "a.ts" }, summary: "Fixed the issue" }, undefined, 8000)
    expect(line).toEqual({ state, glyph, tone, time: "2s", ...(detail === undefined ? {} : { detail }) })
  })

  it.each([
    ["person", "Interrupted by you"], ["agent", "Interrupted by the parent"], ["runtime", "Interrupted by the runtime"],
  ] as const)("names the %s who interrupted the child", (pausedBy, text) => {
    expect(subagentLine({ ...base, status: "paused", pausedBy }, undefined, 8000)).toMatchObject({
      state: "parked", glyph: "‖", tone: "warning", detail: { kind: "state", text }, time: "2s",
    })
  })

  it("keeps the failure sentence separate from the quieter provider detail", () => {
    expect(subagentLine({ ...base, status: "error", failure: { title: "Failed", message: "Rate limited", guidance: "", detail: "429 quota exceeded" } }, undefined, 8000))
      .toEqual({ state: "failed", glyph: "✗", tone: "failed", detail: { kind: "reason", text: "Rate limited" }, failureDetail: "429 quota exceeded", time: "2s" })
  })

  it("prioritizes a reply wait over the newest call and advances only the child's active clock", () => {
    expect(subagentLine({ ...base, status: "active", activeStartedAt: 5000, activity: { name: "Read", detail: "old.ts" } },
      { waitingOn: "Waiting on parent" }, 8000))
      .toEqual({ state: "running", glyph: "●", tone: "warning", detail: { kind: "state", text: "Waiting on parent" }, time: "5s" })
  })

  it("leaves initializing and empty completion sentences empty, but names live work before the first call", () => {
    const initializing: AgentGroupBlock = { ...base, status: "pending", duration: 0, model: "" }
    expect(subagentLine(initializing, undefined, 8000)).toEqual({ state: "waiting", glyph: "○", tone: "muted", time: "0s" })
    expect(subagentLine({ ...base, status: "completed" }, undefined, 8000).detail).toBeUndefined()
    expect(subagentLine({ ...base, status: "active" }, undefined, 8000).detail).toEqual({ kind: "state", text: "Working" })
  })

  it.each([
    ["waiting", "Waiting"], ["thinking", "Thinking"], ["generating", "Generating"], ["executing_tools", "Executing"],
    ["idle", "Working"], ["absent", "Working"],
  ] as const)("shows %s before a call, then replaces it with the complete call", (activity, text) => {
    const child = childCardStatus({ activity, waitingOnBackgroundWork: false, replyWaits: [] }, "parent")
    const block = { ...base, status: "active" as const, totalToolCount: 0 }
    expect(subagentLine(block, child, 8000).detail).toEqual({ kind: "state", text })
    expect(subagentLine({ ...block, activity: { name: "Read", detail: "a.ts" } }, child, 8000).detail)
      .toEqual({ kind: "activity", tool: "Read", text: "a.ts" })
  })

  it("ranks operations below the goal, while preserving persona, model, and optional header time", () => {
    const parts = subagentHeaderParts({ ...base, status: "active" }, base.model, "2s")
    expect(parts.map(({ kind, text }) => [kind, text])).toEqual([
      ["persona", "Explorer"], ["goal", "Trace the issue"], ["model", "model high"], ["time", "2s"], ["operations", "3 operations"],
    ])
    expect(parts.toSorted((a, b) => a.rank - b.rank).map(({ kind }) => kind)).toEqual(["operations", "goal", "persona", "model", "time"])
    expect(subagentHeaderParts({ ...base, status: "active" }).map(({ kind }) => kind)).toEqual(["persona", "goal", "model", "operations"])
    expect(subagentHeaderParts({ ...base, status: "pending", model: "", duration: 0 })[1]?.text).toBe("Initializing...")
  })

  it("offers only the admitted primary control, including a person's Resume", () => {
    const row = { kind: "subagent" as const, admittedActions: ["subagent.interrupt", "subagent.resume"] as const }
    expect(subagentCardControls(row, true)).toEqual({ primary: "interrupt", stop: true })
    expect(subagentCardControls(row, false)).toEqual({ primary: "resume", stop: false })
    expect(subagentCardControls({ kind: "subagent", admittedActions: [] }, false)).toEqual({ primary: null, stop: false })
    expect(subagentCardControls(undefined, true)).toEqual({ primary: null, stop: true })
  })
})
