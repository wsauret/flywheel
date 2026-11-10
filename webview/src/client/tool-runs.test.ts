import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { FrontendOutputBlock, FrontendToolEntry } from "../../../src/protocol/app-service-types.js"
import { blockIdentity } from "../../../src/protocol/block-identity.js"
import { foldTranscript } from "../../../src/protocol/client/transcript-model.js"
import { blockEndTimes, createWebTranscript, presentWebTranscript, rowAtIndex, rowIdentity, rowIndex, runningTimeIds, toolGroupSummaryParts, toolWorkCounts } from "./tool-runs.js"
import { mutationEvidenceFixture } from "../../../tests/unit/tui/output-blocks/_mutation-evidence-fixture.js"

type Status = FrontendToolEntry["status"]

function script(id: string, timestamp: number, status: Status = "completed"): FrontendOutputBlock {
  return tool(id, "code", "Code", timestamp, status)
}

function call(id: string, timestamp: number, status: Status = "completed"): FrontendOutputBlock {
  return { ...tool(id, "mcp.query", "context7.query-docs", timestamp, status), runCategoryOverride: "execute" }
}

function read(id: string, timestamp: number, path: string, status: Status = "completed"): FrontendToolEntry {
  return { ...tool(id, "read", "Read", timestamp, status, path), action: "file_read", linkUri: `file://${path}` }
}

function search(id: string, timestamp: number, status: Status = "completed"): FrontendToolEntry {
  return { ...tool(id, "search", "Search", timestamp, status, "TODO in src"), action: "search" }
}

function bash(id: string, timestamp: number, status: Status = "completed"): FrontendToolEntry {
  return { ...tool(id, "bash", "Bash", timestamp, status, "ls"), action: "shell_exec" }
}

function tool(id: string, name: string, title: string, timestamp: number, status: Status, detail = ""): FrontendToolEntry {
  const base = { kind: "tool" as const, id, name, presentation: { name: title, detail }, timestamp }
  if (status === "error") return { ...base, status, errorMessage: "failed" }
  if (status === "blocked") return { ...base, status, statusMessage: "blocked" }
  return { ...base, status }
}

function text(id: string, timestamp: number): FrontendOutputBlock {
  return { kind: "text", id, content: "done", timestamp }
}

function thinking(id: string, timestamp: number): FrontendOutputBlock {
  return { kind: "thinking", id, content: "hmm", status: "completed", timestamp }
}

const present = (blocks: readonly FrontendOutputBlock[], showThinking = false) => presentWebTranscript(foldTranscript(blocks, showThinking))

test("durations end at the next wire block even when it is hidden, and the final row has no invented end", () => {
  const ends = blockEndTimes([bash("first", 1000), thinking("hidden", 5000), text("answer", 12000)])
  assert.equal(ends.get("tool:first"), 5000)
  assert.equal(ends.get("thinking:hidden"), 12000)
  assert.equal(ends.get("text:answer"), undefined)
  assert.equal(blockEndTimes([text("part", 1000), bash("call", 1000)]).get("text:part"), undefined)
})

test("a settled background command's row and group end when the command ended, not at the reply after its launch", () => {
  const blocks = [{ ...bash("perf", 1000), background: true, endedAt: 46_600 }, text("started", 1865)]
  assert.equal(blockEndTimes(blocks).get("tool:perf"), 46_600)
  const group = present(blocks).rows[0]
  assert.equal(group?.kind === "toolGroup" ? group.endTimestamp : undefined, 46_600)
})

describe("web presentation: one group per stretch", () => {
  test("gathers every consecutive tool call under one group and keys it on the stretch", () => {
    const { rows } = present([
      read("r1", 100, "/p/a.ts"),
      search("s1", 110),
      bash("b1", 200),
      tool("e1", "edit", "Edit", 210, "completed"),
      text("t1", 300),
      bash("b2", 400),
    ])
    assert.deepEqual(rows.map((row) => row.kind), ["toolGroup", "text", "toolGroup"])
    const [group] = rows
    if (group?.kind !== "toolGroup") throw new Error("expected a group")
    assert.deepEqual(group.children.map((child) => child.id), ["r1", "s1", "b1", "e1"])
    assert.equal(rowIdentity(group), "toolGroup:tool:r1")
    assert.equal(group.status, "completed")
  })

  test("a group keeps the key it rendered under as older calls of its stretch arrive", () => {
    const transcript = createWebTranscript()
    const resident = [bash("b3", 300), bash("b4", 310), text("t1", 400)]
    assert.equal(rowIdentity(transcript(resident, false).rows[0]!), "toolGroup:tool:b3")
    const paged = transcript([text("t0", 100), bash("b1", 200), bash("b2", 210), ...resident, bash("b5", 500)], false).rows
    assert.deepEqual(paged.map(rowIdentity), ["text:t0", "toolGroup:tool:b3", "text:t1", "toolGroup:tool:b5"])
    assert.deepEqual(paged[1]?.kind === "toolGroup" ? paged[1].children.map((child) => child.id) : [], ["b1", "b2", "b3", "b4"])
    assert.equal(rowIdentity(createWebTranscript()([bash("b1", 200), ...resident], false).rows[0]!), "toolGroup:tool:b1", "a fresh window keys the stretch on its first call")
    const split = transcript([text("t0", 100), bash("b1", 200), bash("b2", 210), text("inserted", 250), ...resident], false).rows
    assert.deepEqual(split.map(rowIdentity), ["text:t0", "toolGroup:tool:b1", "text:inserted", "toolGroup:tool:b3", "text:t1"], "a stretch split by an inserted block keeps its key on the part that holds its call")
    const scripted = createWebTranscript()
    const edge = [script("s1", 300), call("c1", 310), text("t1", 400)]
    assert.equal(rowIdentity(scripted(edge, false).rows[0]!), "toolGroup:tool:s1", "a script at the window's edge opens the stretch")
    assert.equal(rowIdentity(scripted([bash("b1", 200), ...edge], false).rows[0]!), "toolGroup:tool:s1", "the group holds the script it is keyed on after an older call joins")
  })

  test("one session keeps its group keys through recovery independently of another session", () => {
    const transcript = createWebTranscript()
    const resident = [bash("b3", 300), text("t1", 400)]
    transcript(resident, false)
    const paged = [bash("b2", 200), ...resident]
    assert.equal(rowIdentity(transcript(paged, false).rows[0]!), "toolGroup:tool:b3")
    assert.equal(rowIdentity(transcript([...paged], false).rows[0]!), "toolGroup:tool:b3", "recovery patches the session's presentation")
    const other = createWebTranscript()
    assert.equal(rowIdentity(other(paged, false).rows[0]!), "toolGroup:tool:b2", "another session owns its own presentation")
    assert.equal(rowIdentity(transcript(paged, false).rows[0]!), "toolGroup:tool:b3", "returning to the resident session keeps its key")
  })

  test("a group is active while any member runs, and interrupted when one was cut short", () => {
    const active = present([read("r1", 100, "/p/a.ts"), bash("b1", 110, "pending")]).rows
    assert.equal(active[0]?.kind === "toolGroup" ? active[0].status : undefined, "active")
    const cut = present([bash("b1", 100), bash("b2", 110, "interrupted")]).rows
    assert.equal(cut[0]?.kind === "toolGroup" ? cut[0].status : undefined, "interrupted")
    const process = { activeBackgroundCommands: [{ id: "process", toolUseId: "b1", description: "Shell", startedAtMs: 100 }], activeForegroundBashToolCallIds: [] }
    const group: FrontendOutputBlock = { kind: "agentGroup", id: "agent", toolUseId: "agent", containerKind: "subagent", label: "Agent", description: "", status: "active", timestamp: 0, duration: 7000, activeStartedAt: 100, children: [bash("child", 100, "pending")], totalToolCount: 1 }
    assert.deepEqual([...runningTimeIds([bash("b1", 100), group], {}, process, false)], ["tool:b1", "tool:agent", "tool:child"])
    // A settled child call is not timed by its parent's processes, whatever ids they share.
    const settled: FrontendOutputBlock = { ...group, children: [bash("b1", 100)] }
    assert.deepEqual([...runningTimeIds([settled], {}, process, false)], ["tool:agent"])
    assert.deepEqual([...runningTimeIds([bash("b1", 100)], {}, undefined, false)], [])
  })

  test("hides script rows, folds their calls into the group around them, and carries a script's interruption", () => {
    const { rows } = present([read("r1", 100, "/p/a.ts"), script("s1", 200), call("c1", 210), read("r2", 300, "/p/b.ts"), text("t1", 400)])
    assert.deepEqual(rows.map((row) => row.kind), ["toolGroup", "text"])
    assert.deepEqual(rows[0]?.kind === "toolGroup" ? rows[0].children.map((child) => child.id) : [], ["r1", "c1", "r2"])
    const cut = present([script("s1", 100, "interrupted"), call("c1", 110)]).rows
    assert.equal(cut[0]?.kind === "toolGroup" ? cut[0].status : undefined, "interrupted")
    assert.deepEqual(cut[0]?.kind === "toolGroup" ? cut[0].members.map((member) => member.kind === "tool" ? member.id : "") : [], ["c1"])
    const bare = present([script("s1", 100, "interrupted"), text("t1", 200)]).rows
    assert.deepEqual(bare.map((row) => row.kind), ["toolGroup", "text"])
    assert.equal(rowIdentity(bare[0] ?? text("x", 0)), "toolGroup:tool:s1")
    assert.equal(bare[0]?.kind === "toolGroup" ? bare[0].endTimestamp : undefined, 200)
  })

  test("the stretch end does not depend on whether its last thought is visible", () => {
    const blocks = [bash("b1", 1000), thinking("thought", 5000), text("answer", 12000)]
    for (const show of [false, true]) {
      const group = present(blocks, show).rows[0]
      assert.equal(group?.kind === "toolGroup" ? group.endTimestamp : undefined, 12000)
    }
  })

  test("a settled script with no calls leaves nothing behind", () => {
    assert.deepEqual(present([script("s1", 100), text("t1", 200)]).rows.map((row) => row.kind), ["text"])
  })

  test("queued messages stay in place at the tail", () => {
    const view = present([text("t1", 100), { kind: "userMessage", id: "q", content: "next", timestamp: 200, pending: true, injected: false }])
    assert.deepEqual(view.rows.map((row) => row.kind), ["text", "userMessage"])
    assert.deepEqual(view.boundaryBefore, [false, false])
  })
})

describe("web presentation preserves the shared model", () => {
  const user = (id: string, timestamp: number, pending = false): FrontendOutputBlock => ({ kind: "userMessage", id, content: id, timestamp, pending, injected: false })
  const agent = (id: string): FrontendOutputBlock => ({ kind: "agentGroup", containerKind: "subagent", id, toolUseId: `tool-${id}`, label: "implementer", description: id, agentType: "implementer", children: [], totalToolCount: 0, timestamp: 11, status: "completed" })
  const blocks: FrontendOutputBlock[] = [
    user("ask", 1), thinking("th0", 2), read("r1", 3, "/p/a.ts"), read("r2", 4, "/p/b.ts"), search("s1", 5), bash("b1", 6), tool("e1", "edit", "Edit", 7, "completed"),
    thinking("th1", 8), bash("b2", 9), text("t1", 10), agent("first"), script("sc", 11, "interrupted"), call("c1", 12), agent("next"), text("done", 13), user("follow-up", 14), user("q", 15, true),
  ]
  for (const showThinking of [false, true]) {
    test(`shows every row and call of the model in order, with the same dividers (thinking ${showThinking ? "shown" : "hidden"})`, () => {
      const model = foldTranscript(blocks, showThinking)
      const view = present(blocks, showThinking)
      // The carrier of an interrupted script is the one member the web leaves out; the group's status carries it.
      const modelContent = model.rows.flatMap((row) => row.kind === "toolStretch" ? row.members.filter((member) => member.kind !== "tool" || member.name !== "code").map(blockIdentity) : [blockIdentity(row)])
      const webContent = view.rows.filter((row) => !(row.kind === "userMessage" && row.pending)).flatMap((row) => row.kind === "toolGroup" ? row.members.map(blockIdentity) : [blockIdentity(row)])
      assert.deepEqual(webContent, modelContent)
      assert.deepEqual(view.rows.at(-1), user("q", 15, true))
      const modelDividers = model.rows.filter((_, i) => model.boundaryBefore[i]).map((row) => (row.kind === "toolStretch" ? row.id : blockIdentity(row)))
      const webDividers = view.rows.filter((_, i) => view.boundaryBefore[i]).map(rowIdentity)
      assert.deepEqual(webDividers, modelDividers)
      assert.deepEqual(webDividers, ["text:t1", "text:done"])
    })
  }
})

describe("tool group summary", () => {
  test("counts commands and tools the way the examples read", async () => {
    assert.equal(toolGroupSummaryParts([bash("b1", 1), read("r1", 2, "/p/a.ts")]).heading, "Ran a command, used a tool")
    assert.equal(toolGroupSummaryParts([bash("b1", 1), bash("b2", 2), read("r1", 3, "/p/a.ts"), search("s1", 4)]).heading, "Ran 2 commands, used 2 tools")
    assert.equal(toolGroupSummaryParts([bash("b1", 1), bash("b2", 2), bash("b3", 3), bash("b4", 4)]).heading, "Ran 4 commands")
    // A shell mutation reads as an edit, so it counts as a tool.
    const shellMutation = { ...bash("b2", 2), declaresMutation: true as const }
    assert.equal(toolGroupSummaryParts([bash("b1", 1), shellMutation]).heading, "Ran a command, used a tool")
    const fixture = await mutationEvidenceFixture({ version: 1, files: [{ path: "a.ts", change: "modified", unifiedDiff: "" }], omissions: [{ path: "b.ts", reason: "sensitive" }] })
    const handle = fixture.reader.open("summary", fixture.evidence.manifest)
    try {
      await handle.loadFiles()
      const mutationEvidence = fixture.evidence
      const metadata = new Map([["b2", handle.files], ["again", handle.files], ["r", handle.files]])
      assert.equal(toolWorkCounts([{ ...shellMutation, mutationEvidence }, { ...shellMutation, id: "again", mutationEvidence }], metadata).editedFiles, 2)
      assert.equal(toolWorkCounts([{ ...read("r", 2, "notes"), mutationEvidence }], metadata).editedFiles, 0)
    } finally { fixture.reader.dispose() }
    assert.equal(toolGroupSummaryParts([read("r1", 1, "/p/a.ts"), read("r2", 2, "/p/b.ts"), search("s1", 3)]).heading, "Used 3 tools")
  })

  test("counts failures and interruptions after the tally", () => {
    assert.equal(toolGroupSummaryParts([read("r1", 1, "/p/a.ts", "error"), read("r2", 2, "/p/b.ts"), search("s1", 3)]).failed, 1)
    // A call whose work waits, such as a held message, did not fail.
    assert.deepEqual(toolGroupSummaryParts([bash("b1", 1, "error"), bash("b2", 2, "interrupted"), tool("k1", "mcp", "MCP", 3, "blocked")]), { heading: "Ran 2 commands, used a tool", commands: 2, tools: 1, failed: 1, interrupted: 1 })
    assert.equal(toolWorkCounts([{ ...bash("b1", 1), exitCode: 1 }, bash("b2", 2)]).failed, 1)
  })
})

describe("a row's place by absolute block index", () => {
  // A resident window that starts at absolute index 40: a text row, a group
  // of two calls, and another text row.
  const blocks = [text("t1", 1), call("c1", 2), call("c2", 3), text("t2", 4)]
  const { rows } = present(blocks)
  const group = rows.find((row) => row.kind === "toolGroup")
  if (group === undefined) throw new Error("expected a tool group")

  test("a row's index is its first block's absolute index", () => {
    assert.equal(rowIndex(rows, blocks, 40, rowIdentity(blocks[0]!)), 40)
    assert.equal(rowIndex(rows, blocks, 40, rowIdentity(group)), 41)
    assert.equal(rowIndex(rows, blocks, 40, rowIdentity(blocks[3]!)), 43)
    assert.equal(rowIndex(rows, blocks, 40, "missing"), undefined)
    assert.equal(rowIndex(rows, blocks, null, rowIdentity(blocks[0]!)), undefined)
  })

  test("an index names the row that holds it, whichever id the block carries now", () => {
    assert.equal(rowAtIndex(rows, blocks, 40, 40), rowIdentity(blocks[0]!))
    assert.equal(rowAtIndex(rows, blocks, 40, 42), rowIdentity(group))
    assert.equal(rowAtIndex(rows, blocks, 40, 43), rowIdentity(blocks[3]!))
    // Past the resident end the last row is the nearest place; before its
    // start nothing resident holds the index yet.
    assert.equal(rowAtIndex(rows, blocks, 40, 90), rowIdentity(blocks[3]!))
    assert.equal(rowAtIndex(rows, blocks, 40, 39), undefined)
    assert.equal(rowAtIndex(rows, blocks, null, 40), undefined)
  })
})
