import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { rendered } from "./blocks-render-loader-fixture.js"
import { mountToolGroup } from "./render-ownership-loader-fixture.js"

const { renderGroup, tool } = rendered
const textOf = (html: string) => html.replace(/<!--[\s\S]*?-->|<[^>]*>/g, "")

describe("tool groups", () => {
  test("narration growth retains focused read links while repeated paths keep separate call identities", async () => {
    const reads = ["one", "two"].map(id => tool({ id, name: "read", action: "file_read", presentation: { name: "Read", detail: "src/file.ts" }, linkUri: "file:///repo/src/file.ts", status: "pending", fileChangeKind: undefined }))
    const mounted = mountToolGroup(reads, undefined, false, true)
    try {
      const links = mounted.fileLinks()
      assert.equal(links.length, 2)
      assert.notEqual(links[0], links[1])
      links[0]?.focus()
      mounted.publish({ blocks: [...structuredClone(reads), { kind: "text", id: "narration", content: "Still reading", timestamp: 2 }] })
      assert.equal(mounted.fileLinks()[0], links[0])
      assert.equal(mounted.fileLinks()[1], links[1])
      const click = links[0]?.properties.onClick
      if (typeof click === "function") click()
      assert.deepEqual(mounted.openedFiles(), ["/repo/src/file.ts"])
    } finally { mounted.dispose() }
  })
  const bash = (id: string, status: "pending" | "completed" | "error" = "completed") =>
    tool(status === "error"
      ? { id, name: "bash", action: "shell_exec", presentation: { name: "Bash", detail: `${id} --flag` }, status: "completed", fileChangeKind: undefined }
      : { id, name: "bash", action: "shell_exec", presentation: { name: "Bash", detail: `${id} --flag` }, status, fileChangeKind: undefined })

  test("received messages count inside one command group and disclose in their original order", () => {
    const incoming = { kind: "userMessage" as const, id: "received", content: "Use main.ts", timestamp: 2, pending: false, injected: false,
      from: { sessionId: "sender", name: "Sender", relation: "sibling" as const, personWords: "Keep tests green" } }
    const children = [bash("before"), incoming, { ...incoming, id: "second", content: "Then check types", timestamp: 3 }, bash("after")]
    const closed = renderGroup(children)
    assert.match(closed, />Ran 2 commands, used 2 tools</)
    assert.doesNotMatch(closed, /Use main.ts/)
    const open = renderGroup(children, { reopened: true })
    assert.ok(open.indexOf("before --flag") < open.indexOf("Use main.ts"), open)
    assert.ok(open.indexOf("Use main.ts") < open.indexOf("Then check types"), open)
    assert.ok(open.indexOf("Then check types") < open.indexOf("after --flag"), open)
    assert.match(open, /Keep tests green/)
    const collapsedMessages = renderGroup(children, { reopened: true, collapsed: true })
    assert.match(collapsedMessages, /Message from/)
    assert.doesNotMatch(collapsedMessages, /Use main.ts/)
    const preview = renderGroup(children, { tailCanGrow: true, collapsed: true })
    assert.match(preview, /Message from/)
    assert.doesNotMatch(preview, /Use main.ts/)
    const alone = renderGroup([incoming], { collapsed: true })
    assert.match(alone, /Message from/)
    assert.doesNotMatch(alone, /tool-group-head/)
  })

  test("a stretch of one call renders that call's own row, with no group header", () => {
    const html = renderGroup([bash("bun-test")])
    assert.doesNotMatch(html, /tool-group-head/)
    assert.match(html, /class="tool-title">Bash</)
    assert.match(html, /bun-test --flag/)
  })

  test("a stretch of one read names its file by basename, as its compact row would", () => {
    const html = renderGroup([tool({ id: "read-1", name: "read", action: "file_read", presentation: { name: "Read", detail: "src/orchestration/agent-runtime/agent.ts" }, linkUri: "file:///repo/src/orchestration/agent-runtime/agent.ts", status: "completed", fileChangeKind: undefined })])
    assert.doesNotMatch(html, /tool-group-head/)
    assert.match(html, /class="tool-title">Read</)
    assert.match(html, /class="tool-detail">agent\.ts</)
    assert.doesNotMatch(html, /agent-runtime\/agent/)
  })

  test("two or more calls collapse under a counting header", () => {
    const html = renderGroup([bash("one"), bash("two"), tool({ id: "r", name: "read", action: "file_read", presentation: { name: "Read", detail: "a.ts" }, status: "completed", fileChangeKind: undefined })])
    assert.match(html, /tool-group-head/)
    assert.match(html, />Ran 2 commands, used a tool</)
    assert.match(html, /aria-expanded="false"/)
    assert.doesNotMatch(html, /one --flag/)
    assert.match(html, /<svg[^>]*class="icon"/)
    assert.equal((html.match(/<svg/g) ?? []).length, 1)
    assert.match(html, /d="M3 4l4 4-4 4M9 12h4"/)
    const read = tool({ id: "r", name: "read", action: "file_read", fileChangeKind: undefined })
    assert.match(renderGroup([bash("one"), read]), /d="M3 4l4 4-4 4M9 12h4"/)
    assert.match(renderGroup([bash("one"), read, { ...read, id: "r2" }]), /d="M3 4.5h10M3 8h10M3 11.5h10"/)
  })

  test("a failed count keeps its error colour inside the quiet heading", () => {
    const html = renderGroup([{ ...bash("one"), status: "error", errorMessage: "Failed" }, bash("two")])
    assert.match(html, /class="tool-group-failed">1 failed<\/span>/)
    assert.equal(textOf(html.slice(html.indexOf("<button"), html.indexOf("</button>"))), "▸Ran 2 commands (1 failed)")
  })

  test("a group with a running member pulses its marker", () => {
    const html = renderGroup([bash("one"), bash("two", "pending")])
    assert.match(html, /marker-dot live/)
    const children = [bash("one"), { ...bash("two"), background: true }]
    const active = renderGroup(children, {
      processStatus: { activeBackgroundCommands: [{ id: "process-2", toolUseId: "two", description: "Shell", startedAtMs: 0 }], activeForegroundBashToolCallIds: [] },
    })
    assert.match(active, /marker-dot live/)
    assert.match(active, /aria-expanded="false"/)
    assert.match(active, /two --flag/)
    assert.doesNotMatch(renderGroup(children), /marker-dot live/)
  })
})

test("running stretches preview exactly their newest four calls, then hide all children once settled", () => {
  const calls = Array.from({ length: 6 }, (_, i) => tool({
    id: `preview-${i}`, name: "bash", fileChangeKind: undefined,
    presentation: { name: "Bash", detail: `unique-call-${i}` }, timestamp: 1000 + i * 1000,
    status: i === 5 ? "pending" : "completed",
  }))
  const live = renderGroup(calls, { now: 8000 })
  assert.doesNotMatch(live, /unique-call-[01]/)
  for (let i = 2; i < 6; i++) assert.ok(live.includes(`unique-call-${i}`))
  assert.match(textOf(live), / · 7s/)
  assert.equal((live.match(/<time/g) ?? []).length, 1)
  const settledCalls = calls.map(call => ({ ...call, status: "completed" as const }))
  const gap = renderGroup(settledCalls, { tailCanGrow: true, now: 8000 })
  assert.doesNotMatch(gap, /unique-call-[01]|marker-dot live| · 7s/)
  for (let i = 2; i < 6; i++) assert.ok(gap.includes(`unique-call-${i}`))
  const settled = renderGroup(settledCalls, { end: 9000 })
  assert.doesNotMatch(settled, /unique-call-/)
  assert.equal((settled.match(/<time/g) ?? []).length, 1)
  const open = renderGroup(settledCalls, { end: 9000, reopened: true })
  assert.ok(open.includes("unique-call-0"))
  assert.equal((open.match(/<time/g) ?? []).length, 7)
  const empty = renderGroup([tool({ name: "code", status: "interrupted", fileChangeKind: undefined })], { end: 5000 })
  assert.match(textOf(empty), / · 5s/)
})
