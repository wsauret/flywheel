import { describe, expect, it } from "bun:test"
import type { FrontendOutputBlock, FrontendToolEntry } from "../../../../src/protocol/app-service-types.js"
import type { ToolAction } from "../../../../src/infra/workflow-types.js"
import { foldTranscript, type TranscriptWindow } from "../../../../src/protocol/client/transcript-model.js"
import { presentTerminalTranscript, visibleBlockIdentity, type ToolRun, type VisibleBlock } from "../../../../src/tui/output-blocks/visible-output-blocks.js"
import { blockIdentity } from "../../../../src/protocol/block-identity.js"

/** The action the runtime puts on the wire for each fixture tool. */
function actionOf(name: string): ToolAction | undefined {
  switch (name) {
    case "read": case "skill": return "file_read"
    case "search": return "search"
    case "list": return "list"
    case "bash": return "shell_exec"
    case "message_session": case "papercut_log": return "ui_meta"
    case "Edit": return "file_write"
    default: return undefined
  }
}
const tool = (name: string, timestamp: number, over: Partial<Pick<FrontendToolEntry, "id" | "presentation" | "runCategoryOverride" | "invocationBody">> = {}): FrontendToolEntry => {
  const action = actionOf(name)
  return { kind: "tool", id: `${name}-${timestamp}`, name, presentation: { name, detail: name }, status: "completed", timestamp, ...(action === undefined ? {} : { action }), ...over }
}
const streaming = (name: string, timestamp: number, id: string, detail: string): FrontendToolEntry => ({ ...tool(name, timestamp, { id, presentation: { name, detail } }), status: "streaming" })
const text = (content: string, timestamp: number): FrontendOutputBlock => ({ kind: "text", id: `text:${timestamp}`, content, timestamp })
const thinking = (content: string, timestamp: number): FrontendOutputBlock => ({ kind: "thinking", id: `thinking:${timestamp}`, content, status: "completed", timestamp })

const window = (startBlockIndex: number, predecessorBlock: FrontendOutputBlock | null = null): TranscriptWindow => ({ startBlockIndex, predecessorBlock, predecessorRow: null })
const present = (blocks: readonly FrontendOutputBlock[], showThinking: boolean | undefined, at?: TranscriptWindow) => presentTerminalTranscript(foldTranscript(blocks, showThinking, at))
const rows = (blocks: readonly FrontendOutputBlock[], showThinking = false, at?: TranscriptWindow) => present(blocks, showThinking, at).timelineBlocks
function run(row: VisibleBlock | undefined): ToolRun {
  if (row?.kind !== "toolRun") throw new Error("expected a tool run")
  return row
}

describe("terminal presentation: runs by category", () => {
  it("groups sent and received messages between shell calls under Ran without losing disclosure identity", () => {
    const incoming: FrontendOutputBlock = { kind: "userMessage", id: "received", content: "Use main.ts", timestamp: 2, pending: false, injected: false, from: { sessionId: "sender", name: "Sender", relation: "sibling" } }
    const result = present([tool("bash", 1), incoming, tool("message_session", 3), tool("bash", 4)], false)
    expect(result.timelineBlocks).toHaveLength(1)
    expect(run(result.timelineBlocks[0]).category).toBe("exec")
    expect(run(result.timelineBlocks[0]).children.map(child => child.id)).toEqual(["bash-1", "received", "message_session-3", "bash-4"])
    expect(run(result.timelineBlocks[0]).children[1]?.disclosureId).toBe("userMessage:received")
    expect(result.hasBoundaryBefore).toEqual([false])
    expect(result.timelineBlockIndices).toEqual([0])
    expect(result.zeroHeightBlockIndices).toEqual([1, 2, 3])
  })
  it("splits a stretch into Explored and Ran runs and leaves other calls as rows of their own", () => {
    expect(rows([tool("read", 1), tool("search", 2), tool("Edit", 3), tool("bash", 4), tool("bash", 5)]).map((row) => row.kind === "toolRun" ? `${row.category}:${row.children.length}` : row.kind)).toEqual(["explore:2", "tool", "exec:2"])
  })

  it("yields the same grouping and group ids on a window as on the sliced full transcript", () => {
    const blocks = [tool("read", 10), tool("search", 11), text("done one", 20), tool("bash", 30), tool("bash", 31), text("done two", 40)]
    const full = rows(blocks)
    const fullExec = full.find((row) => row.kind === "toolRun" && row.category === "exec")
    const windowed = rows(blocks.slice(3, 6), false, window(3, blocks[2] ?? null))
    expect(windowed.map((row) => row.kind)).toEqual(["toolRun", "text"])
    expect(run(windowed[0]).id).toBe(run(fullExec).id)
    const rebased = rows(blocks.slice(3, 6), false, window(50, blocks[2] ?? null))
    expect(run(rebased[0]).id).toBe(run(fullExec).id)
  })

  it("gives disjoint windows with the same firstTimestamp distinct group ids", () => {
    const a = run(rows([tool("read", 100), tool("search", 100)], false, window(0))[0])
    const b = run(rows([tool("read", 100, { id: "another-read" }), tool("search", 100, { id: "another-search" })], false, window(50))[0])
    expect(a.id).not.toBe(b.id)
  })

  it("continues a run that opens before the window through the predecessor", () => {
    const windowed = rows([tool("search", 6), tool("list", 7), text("done", 10)], false, window(1, tool("read", 5)))
    expect(windowed.map((row) => row.kind)).toEqual(["toolRun", "text"])
    expect(run(windowed[0]).children.map((child) => child.name)).toEqual(["search", "list"])
  })

  it("waits to show an exec run until its first command is renderable, and keeps a visible run active while its next command starts", () => {
    const waiting = present([streaming("bash", 1, "bash-1", "")], false)
    expect(waiting.timelineBlocks).toEqual([])
    expect(waiting.zeroHeightBlockIndices).toEqual([0])
    const ready = present([streaming("bash", 1, "bash-1", "bun run test")], false)
    expect(ready.timelineBlocks).toMatchObject([{ kind: "toolRun", category: "exec", children: [{ id: "bash-1" }] }])
    expect(ready.zeroHeightBlockIndices).toEqual([])
    const continued = present([tool("bash", 1, { id: "bash-1", presentation: { name: "Bash", detail: "bun run test" } }), streaming("bash", 2, "bash-2", "")], false)
    expect(continued.timelineBlocks).toMatchObject([{ kind: "toolRun", category: "exec", status: "active", children: [{ id: "bash-1" }, { id: "bash-2" }] }])
    expect(continued.zeroHeightBlockIndices).toEqual([1])
  })

  it("hides code rows and folds their nested rows into one Executed run", () => {
    const nested = tool("linear.get_issue", 2, { runCategoryOverride: "execute" })
    const projected = present([tool("code", 1), nested, tool("code", 3), tool("read", 4, { runCategoryOverride: "execute" })], false)
    expect(projected.timelineBlocks).toHaveLength(1)
    expect(run(projected.timelineBlocks[0]).category).toBe("execute")
    expect(run(projected.timelineBlocks[0]).children.map((child) => child.name)).toEqual(["linear.get_issue", "read"])
    expect(projected.zeroHeightBlockIndices).toEqual([0, 2, 3])
  })

  it("hides a failed script entirely; the error lives in the durable fact, not the transcript", () => {
    const failed: FrontendToolEntry = { ...tool("code", 3), status: "error", errorMessage: "script failed" }
    const projected = present([tool("read", 2, { runCategoryOverride: "execute" }), failed], false)
    expect(run(projected.timelineBlocks[0]).children.map((child) => [child.name, child.status])).toEqual([["read", "completed"]])
    expect(projected.zeroHeightBlockIndices).toEqual([1])
  })

  it("groups a papercut row under Ran with the shell calls around it", () => {
    const papercut = tool("papercut_log", 2, { presentation: { name: "Papercut", detail: "The compact observation" }, invocationBody: { content: "The compact observation", filetype: "text", presentation: "disclosure" } })
    expect(rows([tool("bash", 1), papercut, tool("bash", 3)], undefined)).toMatchObject([{ kind: "toolRun", category: "exec", children: [{ id: "bash-1" }, papercut, { id: "bash-3" }] }])
  })

  it("trails an interrupted script's blank carrier after the nested rows it produced and reads the run as Interrupted", () => {
    const interrupted: FrontendToolEntry = { ...tool("code", 1), status: "interrupted" }
    const projected = rows([interrupted, tool("read", 2, { runCategoryOverride: "execute" })])
    expect(run(projected[0]).children.map((child) => [child.name, child.status, child.presentation.detail])).toEqual([["read", "completed", "read"], ["code", "interrupted", ""]])
    expect(run(rows([interrupted])[0])).toMatchObject({ category: "execute", status: "paused" })
  })

})

describe("terminal presentation: thoughts", () => {
  it("filters hidden thinking before deriving runs, and keeps visible thinking as a row that splits them", () => {
    expect(rows([tool("read", 1), thinking("reasoning", 2), tool("search", 3)], false)).toMatchObject([{ kind: "toolRun", children: [{ name: "read" }, { name: "search" }] }])
    const visible = rows([tool("read", 1), thinking("reasoning", 2), tool("search", 3)], true)
    expect(visible.map((row) => row.kind)).toEqual(["toolRun", "thinking", "toolRun"])
    expect(visible[0]).toMatchObject({ kind: "toolRun", children: [{ name: "read" }] })
    expect(visible[2]).toMatchObject({ kind: "toolRun", children: [{ name: "search" }] })
  })

  it("stamps a run's duration from the next visible transcript boundary", () => {
    const blocks = [tool("read", 10), thinking("reasoning", 20), text("done", 40)]
    expect(rows(blocks, false)[0]).toMatchObject({ kind: "toolRun", duration: 30 })
    expect(rows(blocks, true)[0]).toMatchObject({ kind: "toolRun", duration: 10 })
  })

})

describe("tool run identity across re-presentations", () => {
  it("reuses unchanged received messages but refreshes their changed content", () => {
    const incoming: FrontendOutputBlock = { kind: "userMessage", id: "received", content: "First", timestamp: 1, pending: false, injected: false, from: { sessionId: "sender", name: "Sender", relation: "sibling" } }
    const shell = tool("bash", 2)
    const first = rows([incoming, shell])[0]
    expect(rows([incoming, shell])[0]).toBe(first!)
    const changed = rows([{ ...incoming, content: "Second" }, shell])[0]
    expect(changed).not.toBe(first!)
    expect(run(changed).children[0]?.invocationBody?.content).toBe("Second")
  })
  it("returns the same run object when it is unchanged, so streaming flushes do not re-render headers", () => {
    const blocks = [tool("read", 10), tool("search", 11), text("after", 20)]
    const first = rows(blocks)[0]
    expect(first?.kind).toBe("toolRun")
    expect(rows(blocks)[0]).toBe(first!)
  })

  it("makes a fresh run when a child's status changes or the run grows", () => {
    const read = tool("read", 10)
    const running: FrontendToolEntry = { ...tool("search", 11), status: "streaming" }
    const before = run(rows([read, running])[0])
    expect(before.status).toBe("active")
    const settled = run(rows([read, tool("search", 11)])[0])
    expect(settled).not.toBe(before)
    expect(settled.status).toBe("completed")
    const grown = run(rows([read, tool("search", 11), tool("list", 12)])[0])
    expect(grown).not.toBe(settled)
    expect(grown.children).toHaveLength(3)
  })
})

describe("terminal presentation preserves the shared model", () => {
  const user = (id: string, ts: number, pending = false): FrontendOutputBlock => ({ kind: "userMessage", id, content: id, timestamp: ts, pending, injected: false })
  const agent = (id: string, status: "active" | "completed"): FrontendOutputBlock => ({ kind: "agentGroup", containerKind: "subagent", id, toolUseId: `tool-${id}`, label: "implementer", description: id, agentType: "implementer", children: [], totalToolCount: 0, timestamp: 1, status })
  const script: FrontendToolEntry = { ...tool("code", 15), status: "interrupted" }
  const blocks: FrontendOutputBlock[] = [
    user("ask", 1), thinking("th0", 2), tool("read", 3), tool("read", 4), tool("search", 5), tool("bash", 6), tool("Edit", 7),
    thinking("th1", 8), tool("bash", 9), text("t1", 10), agent("phase-1", "completed"), tool("bash", 12), text("t2", 13),
    agent("phase-2", "active"), script, tool("mcp.call", 16, { runCategoryOverride: "execute" }), text("done", 17), user("follow-up", 18), user("q", 19, true),
  ]
  for (const showThinking of [false, true]) {
    it(`shows every row and call of the model in order, with the same dividers (thinking ${showThinking ? "shown" : "hidden"})`, () => {
      const model = foldTranscript(blocks, showThinking)
      const terminal = presentTerminalTranscript(model)
      const modelContent = model.rows.flatMap((row) => row.kind === "toolStretch" ? row.members.map(blockIdentity) : [blockIdentity(row)])
      const terminalContent = terminal.timelineBlocks.flatMap((row) => row.kind === "toolRun" ? row.children.map(blockIdentity) : [visibleBlockIdentity(row)])
      expect(terminalContent).toEqual(modelContent)
      const modelDividers = model.rows.filter((_, i) => model.boundaryBefore[i]).map((row) => (row.kind === "toolStretch" ? row.id : blockIdentity(row)))
      const terminalDividers = terminal.timelineBlocks.filter((_, i) => terminal.hasBoundaryBefore[i]).map(visibleBlockIdentity)
      expect(terminalDividers).toEqual(modelDividers)
      expect(terminalDividers).toEqual(["text:text:10", "text:text:13", "text:text:17"])
      // Every block the model hid stays hidden, and every call a run absorbed is accounted for once.
      expect(terminal.zeroHeightBlockIndices.length + terminal.timelineBlocks.length).toBe(blocks.length)
    })
  }
})
