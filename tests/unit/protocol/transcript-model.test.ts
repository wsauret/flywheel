import { describe, expect, it } from "bun:test"
import type { FrontendOutputBlock, FrontendToolEntry } from "../../../src/protocol/app-service-types.js"
import type { ToolAction } from "../../../src/infra/workflow-types.js"
import { foldReadRuns } from "../../../src/protocol/client/tool-run-category.js"
import { closesToolStretch, foldTranscript, toolActivity, waitsForProcessor, type TranscriptModel } from "../../../src/protocol/client/transcript-model.js"

type Status = FrontendToolEntry["status"]

function tool(id: string, name: string, action: ToolAction | undefined, timestamp: number, status: Status = "completed", detail = name): FrontendToolEntry {
  const base = { kind: "tool" as const, id, name, presentation: { name, detail }, timestamp, ...(action === undefined ? {} : { action }) }
  if (status === "error") return { ...base, status, errorMessage: "failed" }
  if (status === "blocked") return { ...base, status, statusMessage: "blocked" }
  return { ...base, status }
}
const read = (id: string, ts: number, path = `/p/${id}.ts`, status: Status = "completed"): FrontendToolEntry => ({ ...tool(id, "read", "file_read", ts, status, path), linkUri: `file://${path}` })
const search = (id: string, ts: number, status: Status = "completed") => tool(id, "search", "search", ts, status, "TODO in src")
const bash = (id: string, ts: number, status: Status = "completed", detail = "ls") => tool(id, "bash", "shell_exec", ts, status, detail)
const text = (id: string, ts: number): FrontendOutputBlock => ({ kind: "text", id, content: id, timestamp: ts })
const user = (id: string, ts: number, pending = false, injected = false): Extract<FrontendOutputBlock, { kind: "userMessage" }> => ({ kind: "userMessage", id, content: id, timestamp: ts, pending, injected })
const thinking = (id: string, ts: number): FrontendOutputBlock => ({ kind: "thinking", id, content: "hmm", status: "completed", timestamp: ts })
const boundary = (id: string, ts: number): FrontendOutputBlock => ({ kind: "divider", id, label: "Review", timestamp: ts })
function agent(id: string, agentType: string, status: "active" | "completed" | "interrupted" | "error" = "completed"): FrontendOutputBlock {
  const base = { kind: "agentGroup" as const, containerKind: "subagent" as const, id, toolUseId: `tool-${id}`, label: agentType, description: id, agentType, children: [], totalToolCount: 0, timestamp: 1 }
  return status === "error" ? { ...base, status, failure: { title: "Subagent failed", message: "Request failed", guidance: "Retry." } } : { ...base, status }
}

/** The rows as a reader would list them: a stretch by its members' ids. */
function listing(model: TranscriptModel): string[] {
  return model.rows.map((row) => row.kind === "toolStretch" ? `stretch[${row.members.map((member) => member.kind === "tool" ? member.id : `~${member.id}`).join(",")}]` : `${row.kind}:${"id" in row ? row.id : ""}`)
}
const dividers = (model: TranscriptModel): number[] => model.boundaryBefore.flatMap((on, i) => (on ? [i] : []))

describe("toolActivity", () => {
  it("keeps a completed launch live only while its managed process is active, without moving narration dividers", () => {
    const entry = { ...bash("background", 1), background: true }
    expect(toolActivity(entry, { held: false, managed: true })).toEqual({ active: true, control: "stop" })
    const model = foldTranscript([entry, text("next", 2)], false)
    expect(model.rows[0]).toMatchObject({ kind: "toolStretch", status: "completed" })
    expect(dividers(model)).toEqual([1])
    expect(toolActivity(entry, { held: false, managed: false })).toEqual({ active: false, control: undefined })
  })

  it("keeps unfinished calls active but offers Detach only for an authoritative held shell command", () => {
    for (const status of ["pending", "streaming"] as const) {
      const entry = bash("held", 1, status)
      expect(toolActivity(entry, { held: false, managed: false })).toEqual({ active: true, control: undefined })
      expect(toolActivity(entry, { held: true, managed: false })).toEqual({ active: true, control: "detach" })
    }
    // The exec registration of the shell is held the same way.
    expect(toolActivity(tool("held", "exec", "shell_exec", 1, "streaming"), { held: true, managed: false })).toEqual({ active: true, control: "detach" })
  })

  it("shows a processor wait only on a held command that still runs, and keeps its activity and control", () => {
    const foreground = toolActivity(bash("foreground", 1, "pending"), { held: true, managed: false })
    const background = toolActivity(bash("background", 1), { held: false, managed: true })
    expect(waitsForProcessor(foreground, true)).toBe(true)
    expect(waitsForProcessor(background, true)).toBe(true)
    expect(foreground).toEqual({ active: true, control: "detach" })
    expect(background).toEqual({ active: true, control: "stop" })
    expect(waitsForProcessor(foreground, false)).toBe(false)
    // A finished command never waits, even before its status drops the id.
    expect(waitsForProcessor(toolActivity(bash("done", 1), { held: false, managed: false }), true)).toBe(false)
  })
})

describe("foldTranscript: stretches of tool work", () => {
  it("keeps received session messages in command activity with their native indices and no redirect", () => {
    for (const relation of ["child", "sibling", "other"] as const) {
      const incoming = { ...user("received", 2), from: { sessionId: "sender", name: "Sender", relation } }
      const next = { ...incoming, id: "next", timestamp: 3 }
      const model = foldTranscript([bash("before", 1), incoming, next, bash("after", 4)], false)
      expect(model.rows).toHaveLength(1)
      const stretch = model.rows[0]
      expect(stretch?.kind === "toolStretch" ? stretch.members : []).toEqual([bash("before", 1), incoming, next, bash("after", 4)])
      expect(stretch?.kind === "toolStretch" ? stretch.memberBlockIndices : []).toEqual([0, 1, 2, 3])
      expect(dividers(model)).toEqual([])
      expect(closesToolStretch(incoming)).toBe(false)
      expect(dividers(foldTranscript([incoming, text("done", 4)], false))).toEqual([])
      const queued = { ...incoming, pending: true }
      expect(foldTranscript([bash("before", 1), queued, bash("after", 4)], false).pendingBlocks).toEqual([queued])
    }
    for (const control of [user("human", 2), { ...user("parent", 2), from: { sessionId: "parent", name: "Parent", relation: "parent" as const } }]) {
      const model = foldTranscript([bash("before", 1), control, bash("after", 3)], false)
      expect(model.rows.map(row => row.kind)).toEqual(["toolStretch", "userMessage", "toolStretch"])
      expect(dividers(model)).toEqual([])
      expect(closesToolStretch(control)).toBe(true)
    }
  })
  it("keeps a hidden thought out of the transcript without splitting the stretch around it", () => {
    const model = foldTranscript([read("r1", 1), thinking("th", 2), search("s1", 3)], false)
    expect(listing(model)).toEqual(["stretch[r1,s1]"])
    expect(model.zeroHeightBlockIndices).toEqual([1])
  })

  it("rides a visible thought inside the stretch and makes one before any call its own row", () => {
    expect(listing(foldTranscript([read("r1", 1), thinking("th", 2), search("s1", 3)], true))).toEqual(["stretch[r1,~th,s1]"])
    expect(listing(foldTranscript([thinking("th", 1), read("r1", 2)], true))).toEqual(["thinking:th", "stretch[r1]"])
  })

  it("shows a shell call once its command text arrives, unless it continues a run of shell calls", () => {
    const waiting = foldTranscript([bash("b1", 1, "streaming", "")], false)
    expect(waiting.rows).toEqual([])
    expect(waiting.zeroHeightBlockIndices).toEqual([0])
    expect(listing(foldTranscript([bash("b1", 1, "streaming", "bun run test")], false))).toEqual(["stretch[b1]"])
    expect(listing(foldTranscript([bash("b1", 1), bash("b2", 2, "streaming", "")], false))).toEqual(["stretch[b1,b2]"])
    const afterRead = foldTranscript([read("r1", 1), bash("b2", 2, "streaming", "")], false)
    expect(listing(afterRead)).toEqual(["stretch[r1]"])
    expect(afterRead.zeroHeightBlockIndices).toEqual([1])
    const continued = foldTranscript([bash("b2", 2, "streaming", "")], false, { startBlockIndex: 1, predecessorBlock: bash("b1", 1), predecessorRow: null })
    expect(listing(continued)).toEqual(["stretch[b2]"])
  })

  it("lists queued messages apart from the rows and lets tool work continue past them", () => {
    const model = foldTranscript([read("r1", 1), user("q1", 2, true), search("s1", 3)], false)
    expect(listing(model)).toEqual(["stretch[r1,s1]"])
    expect(model.pendingBlocks.map((block) => block.id)).toEqual(["q1"])
    expect(model.zeroHeightBlockIndices).toEqual([1])
  })

  it("reports absolute source indices from the window origin", () => {
    const model = foldTranscript([read("r1", 1), search("s1", 2), thinking("th", 3), text("t1", 4)], false, { startBlockIndex: 20, predecessorBlock: null, predecessorRow: null })
    expect(model.sourceBlockIndices).toEqual([20, 23])
    expect(model.rows[0]?.kind === "toolStretch" ? model.rows[0].memberBlockIndices : []).toEqual([20, 21])
    expect(model.zeroHeightBlockIndices).toEqual([22])
  })

  it("folds a prefix and a suffix cut after a closing block exactly as the whole", () => {
    const blocks = [agent("phase-1", "implementer"), read("r1", 1), text("t1", 2), bash("b1", 3), thinking("th", 4), agent("phase-2", "implementer", "active"), text("t2", 5), read("r2", 6)]
    const whole = foldTranscript(blocks, true)
    for (const [index, block] of blocks.entries()) {
      if (!closesToolStretch(block)) continue
      const seam = index + 1
      const prefix = foldTranscript(blocks.slice(0, seam), true)
      const suffix = foldTranscript(blocks.slice(seam), true, { startBlockIndex: seam, predecessorBlock: block, predecessorRow: prefix.rows.at(-1) ?? null })
      expect([...listing(prefix), ...listing(suffix)]).toEqual(listing(whole))
      expect([...prefix.boundaryBefore, ...suffix.boundaryBefore]).toEqual([...whole.boundaryBefore])
      expect([...prefix.sourceBlockIndices, ...suffix.sourceBlockIndices]).toEqual([...whole.sourceBlockIndices])
    }
  })
})

describe("foldTranscript: dividers", () => {
  const at = (blocks: FrontendOutputBlock[], showThinking = false) => dividers(foldTranscript(blocks, showThinking))

  it("divides when narration resumes after finalized tool work", () => {
    expect(at([read("r1", 1), search("s1", 2), text("t1", 3)])).toEqual([1])
    expect(at([bash("b1", 1, "error"), text("t1", 2)])).toEqual([1])
  })
  it("does not divide while the tool work is still in flight", () => {
    expect(at([bash("b1", 1, "pending"), text("t1", 2)])).toEqual([])
  })
  it("does not divide between narration, after a user message, at the top, or before tool work", () => {
    expect(at([text("a", 1), text("b", 2)])).toEqual([])
    expect(at([user("hi", 1), text("on it", 2)])).toEqual([])
    expect(at([text("hello", 1)])).toEqual([])
    expect(at([text("a", 1), read("r1", 2)])).toEqual([])
  })
  it("does not divide before a delivered message, a queued message, an injection, or the first message", () => {
    expect(at([text("before", 1), user("redirect", 2)])).toEqual([])
    expect(at([read("r1", 1), user("redirect", 2), read("r2", 3), text("done", 4)])).toEqual([3])
    expect(at([text("before", 1), user("queued", 2, true)])).toEqual([])
    expect(at([text("before", 1), user("system", 2, false, true)])).toEqual([])
    expect(at([user("initial", 1)])).toEqual([])
  })
  it("does not divide before an implementer dispatch after parent work", () => {
    expect(at([agent("phase-1", "implementer"), read("r1", 1), agent("phase-2", "implementer", "active")])).toEqual([])
    expect(at([agent("phase-1", "implementer"), read("r1", 1), user("redirect", 2), agent("phase-2", "implementer", "active")])).toEqual([])
    expect(at([agent("phase-1", "implementer"), user("redirect", 1), agent("phase-2", "implementer", "active")])).toEqual([])
    expect(at([agent("parallel-1", "implementer"), agent("parallel-2", "implementer")])).toEqual([])
    expect(at([agent("phase-1", "implementer"), read("r1", 1), agent("review", "reviewer-code-quality")])).toEqual([])
    for (const status of ["active", "interrupted", "error"] as const) {
      expect(at([agent("phase-1", "implementer", status), read("r1", 1), agent("phase-2", "implementer")])).toEqual([])
    }
  })
  it("keeps narration dividers and explicit labeled divider rows", () => {
    expect(at([agent("phase-1", "implementer"), read("r1", 1), text("narration", 2), agent("phase-2", "implementer")])).toEqual([2])
    const model = foldTranscript([agent("phase-1", "implementer"), read("r1", 1), boundary("b", 2), agent("phase-2", "implementer")], false)
    expect(dividers(model)).toEqual([])
    expect(model.rows[2]).toMatchObject({ kind: "divider", id: "b", label: "Review" })
  })
  it("divides each step across a multi-step turn", () => {
    expect(at([text("one", 1), read("r1", 2), text("two", 3), read("r2", 4), text("done", 5)])).toEqual([2, 4])
  })
  it("does not divide across a visible thought", () => {
    expect(at([read("r1", 1), thinking("th", 2), text("done", 3)], true)).toEqual([])
    expect(at([thinking("th", 1), text("hi", 2)], true)).toEqual([])
    expect(at([read("r1", 1), thinking("th", 2), text("done", 3)], false)).toEqual([1])
    expect(at([agent("settled", "implementer"), text("done", 2)])).toEqual([1])
    expect(at([agent("settled", "implementer"), thinking("th", 2), text("done", 3)], true)).toEqual([])
    expect(at([agent("running", "implementer", "active"), text("done", 2)])).toEqual([])
  })
})

describe("foldReadRuns", () => {
  it("merges two or more consecutive reads by one tool into a row naming each file by its basename", () => {
    const rows = foldReadRuns([read("r1", 100, "/p/a.ts"), read("r2", 110, "/p/b.ts"), search("s1", 120), read("r3", 130, "/p/c.ts")])
    expect(rows.map((row) => row.kind)).toEqual(["readRun", "tool", "tool"])
    const merged = rows[0]
    if (merged?.kind !== "readRun") throw new Error("expected a merged read run")
    expect(merged.presentation).toEqual({ name: "read", detail: "a.ts, b.ts" })
    expect(merged.status).toBe("completed")
    expect(merged.members.map((member) => member.id)).toEqual(["r1", "r2"])
    expect(merged.id).toBe("tool:r1")
  })
  it("keeps a resource read whole, merges only reads that name something, and never merges across tools", () => {
    const skill = { ...tool("k1", "skill", "file_read", 100, "completed", "ship") }
    const unnamed = { ...tool("k2", "skill", "file_read", 110, "completed", "") }
    const rows = foldReadRuns([skill, { ...skill, id: "k3", presentation: { name: "skill", detail: "uat" } }, unnamed, read("r1", 120, "/p/a.ts")])
    expect(rows.map((row) => row.kind)).toEqual(["readRun", "tool", "tool"])
    expect(rows[0]?.kind === "readRun" ? rows[0].presentation.detail : "").toBe("ship, uat")
  })
  it("is active while a member still runs and carries the first error", () => {
    const active = foldReadRuns([read("r1", 100, "/p/a.ts"), read("r2", 110, "/p/b.ts", "pending")])
    expect(active[0]?.kind === "readRun" ? active[0].status : undefined).toBe("active")
    const failed = foldReadRuns([read("r1", 100, "/p/a.ts", "error"), read("r2", 110, "/p/b.ts")])
    expect(failed[0]).toMatchObject({ kind: "readRun", status: "error", errorMessage: "failed" })
  })
  it("folds an eager read before its filename arrives", () => {
    const eager: FrontendToolEntry = { ...tool("r3", "read", "file_read", 120, "streaming", "") }
    const rows = foldReadRuns([read("r1", 100, "/p/a.ts"), read("r2", 110, "/p/b.ts"), eager])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: "readRun", status: "active", presentation: { detail: "a.ts, b.ts, " } })
  })
})
