import assert from "node:assert/strict"
import { test } from "node:test"
import type { FrontendOutputBlock, FrontendToolEntry } from "../../../src/protocol/app-service-types.js"
import { mountToolGroup } from "./render-ownership-loader-fixture.js"
import { mutationEvidenceFixture } from "../../../tests/unit/tui/output-blocks/_mutation-evidence-fixture.js"

const call = (id: string, status: "streaming" | "completed"): FrontendToolEntry => ({
  kind: "tool", id, name: "bash", action: "shell_exec", status, timestamp: 0,
  presentation: { name: "Bash", detail: id }, content: "running output",
})
const boundary: FrontendOutputBlock = { kind: "text", id: "boundary", timestamp: 2000, content: "Next step" }

for (const mode of ["foreground", "background"] as const) {
  test(`an active one-call stretch keeps its ${mode} command control`, () => {
    const entry = { ...call("command", "streaming"), background: mode === "background" }
    const mounted = mountToolGroup([entry])
    try {
      mounted.publish({ processStatus: { activeForegroundBashToolCallIds: mode === "foreground" ? [entry.id] : [], processorHeldToolCallIds: [],
        activeBackgroundCommands: mode === "background" ? [{ id: "process", toolUseId: entry.id, description: "Shell", startedAtMs: 0 }] : [] } })
      mounted.toggle()
      mounted.publish({ blocks: [{ ...entry, status: "completed" }] })
      const action = mounted.elements().find(node => node.tag === "button" && node.properties.class === "tool-action")
      assert.ok(action, "the running command exposes its control")
      const click = action.properties.onClick
      assert.equal(typeof click, "function")
      if (typeof click === "function") click()
      assert.deepEqual(mode === "foreground" ? mounted.detached() : mounted.terminated(), [entry.id])
      mounted.publish({ blocks: [{ ...entry, status: "completed" }, call("second", "streaming")] })
      const retained = mounted.elements().find(node => node.tag === "button" && node.properties.class === "tool-action")
      assert.ok(retained, "the first command still exposes its control after growth")
      const activate = retained.properties.onClick
      if (typeof activate !== "function") throw new Error("Missing command action")
      activate()
      assert.deepEqual(mode === "foreground" ? mounted.detached() : mounted.terminated(), [entry.id, entry.id])
    } finally { mounted.dispose() }
  })
}

test("a settled background command keeps its time node and states how long it ran, never its launch", () => {
  const launched: FrontendToolEntry = { ...call("perf", "completed"), timestamp: 1000, background: true }
  const reply: FrontendOutputBlock = { ...boundary, timestamp: 1865 }
  const running = { activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [], activeBackgroundCommands: [{ id: "process", toolUseId: launched.id, description: "Shell", startedAtMs: 1010 }] }
  const mounted = mountToolGroup([launched, reply])
  const time = () => mounted.elements().find(node => node.properties.class === "row-duration")
  try {
    mounted.publish({ processStatus: running })
    const node = time()
    assert.ok(node, "the running command shows its live time")
    // The runtime publishes the command's end before the status that drops it.
    mounted.publish({ blocks: [{ ...launched, endedAt: 46_600 }, reply] })
    assert.doesNotMatch(mounted.text(), / · 0s/, "never the launch latency")
    mounted.publish({ processStatus: { ...running, activeBackgroundCommands: [] } })
    assert.equal(time(), node, "settling updates the time in place")
    assert.match(mounted.text(), /12:00 AM · 45s/)
    assert.doesNotMatch(mounted.text(), / · 0s/, "never the launch latency")
  } finally { mounted.dispose() }
})

test("an explicitly opened first call keeps its body when the stretch grows", () => {
  const mounted = mountToolGroup([call("first", "streaming")])
  try {
    mounted.toggle()
    const header = mounted.header()
    header?.focus()
    const body = mounted.elements().find(node => node.properties.class === "tool-body")
    assert.ok(body)
    mounted.publish({ blocks: [call("first", "completed")], activity: "thinking" })
    mounted.publish({ blocks: [call("first", "completed"), call("second", "streaming")] })
    assert.ok(mounted.elements().includes(body), "the opened first-call body stays mounted")
    assert.equal(mounted.header(), header)
    assert.equal(header?.ownerDocument.activeElement, header)
    assert.ok(mounted.elements().some(node => String(node.properties.innerHTML).includes("running")))
    assert.deepEqual(mounted.reading()?.open, ["toolGroup:tool:first"])
    mounted.toggle()
    assert.equal(mounted.elements().includes(body), false)
    mounted.toggle()
    assert.ok(mounted.elements().some(node => node.properties.class === "tool-body"))
  } finally { mounted.dispose() }
})

test("a script stretch with a visible thought keeps its shell when its first call arrives", () => {
  const script: FrontendToolEntry = { ...call("script", "streaming"), name: "code", action: undefined }
  const thought: FrontendOutputBlock = { kind: "thinking", id: "thought", content: "Inspecting", timestamp: 1, status: "completed" }
  const mounted = mountToolGroup([script, thought], undefined, true)
  try {
    const wrapper = mounted.wrapper()
    const header = mounted.header()
    assert.ok(wrapper)
    assert.ok(header)
    header.focus()
    mounted.publish({ blocks: [script, thought, call("first", "streaming")] })
    assert.equal(mounted.wrapper(), wrapper)
    assert.equal(mounted.header(), header)
    assert.equal(header.ownerDocument.activeElement, header)
    assert.match(mounted.text(), /first/)
  } finally { mounted.dispose() }
})

test("a growing tool stretch retains its wrapper and preview nodes through completed-call gaps", () => {
  const mounted = mountToolGroup([call("first", "streaming")])
  try {
    const wrapper = mounted.wrapper()
    const preview = mounted.preview()
    const first = mounted.details()[0]
    assert.ok(wrapper)
    assert.ok(preview)
    assert.ok(first)
    assert.equal(mounted.liveMarkers(), 2)
    mounted.publish({ blocks: [call("first", "completed")], activity: "thinking" })
    assert.equal(mounted.wrapper(), wrapper)
    assert.equal(mounted.preview(), preview)
    assert.equal(mounted.details()[0], first)
    assert.equal(mounted.liveMarkers(), 0)
    mounted.publish({ blocks: [call("first", "completed"), call("second", "streaming")], activity: "executing_tools" })
    assert.equal(mounted.wrapper(), wrapper)
    assert.equal(mounted.preview(), preview)
    assert.equal(mounted.details()[0], first)
    assert.equal(mounted.liveMarkers(), 2)
    const completed = [call("first", "completed"), call("second", "completed")]
    mounted.publish({ blocks: completed, activity: "thinking" })
    assert.equal(mounted.preview(), preview)
    mounted.toggle()
    mounted.publish({ blocks: completed.map(block => ({ ...block })) })
    assert.equal(mounted.preview(), undefined)
    assert.match(mounted.text(), /first.*second/)
    mounted.toggle()
    const manualPreview = mounted.preview()
    assert.ok(manualPreview)
    mounted.publish({ activity: "idle", interruptible: false, settledOutputPosition: 3, appliedOutputPosition: 2 })
    assert.equal(mounted.wrapper(), wrapper)
    assert.equal(mounted.preview(), manualPreview)
    mounted.publish({ appliedOutputPosition: 3 })
    assert.equal(mounted.preview(), undefined)
    mounted.publish({ activity: "thinking", interruptible: true, blocks: completed })
    mounted.publish({ blocks: [...completed, boundary] })
    assert.equal(mounted.wrapper(), wrapper)
    assert.equal(mounted.preview(), undefined)
  } finally { mounted.dispose() }
})

for (const choice of ["open", "closed", "untouched"] as const) {
  test(`a one-call stretch retains its header and ${choice} choice when it settles`, () => {
    const running = call("bun run check", "streaming")
    const mounted = mountToolGroup([running])
    try {
      const wrapper = mounted.wrapper()
      const header = mounted.header()
      assert.ok(wrapper)
      assert.ok(header)
      header.focus()
      if (choice !== "untouched") mounted.toggle()
      if (choice === "closed") mounted.toggle()
      const body = mounted.elements().find(node => node.properties.class === "tool-body")
      if (choice === "open") assert.ok(body)
      const completed: FrontendToolEntry = { ...running, status: "completed", content: "settled output" }
      mounted.publish({ blocks: [completed], activity: "thinking" })
      mounted.publish({ blocks: [completed, boundary] })
      assert.equal(mounted.wrapper(), wrapper)
      assert.equal(mounted.header(), header, "the original header survives flattening")
      assert.equal(header.ownerDocument.activeElement, header)
      assert.equal(header.properties["aria-expanded"], choice === "open")
      assert.match(mounted.text(), /Bash.*bun run check/)
      assert.doesNotMatch(mounted.text(), /Ran a command/)
      assert.equal(mounted.preview(), undefined)
      if (choice === "open") {
        assert.ok(body)
        assert.ok(mounted.elements().includes(body), "opened output stays mounted")
        assert.ok(mounted.elements().some(node => String(node.properties.innerHTML).includes("settled")))
      }
      mounted.toggle()
      assert.equal(header.properties["aria-expanded"], choice !== "open")
      mounted.toggle()
      assert.equal(header.properties["aria-expanded"], choice === "open")
      const reading = mounted.reading()
      assert.ok(reading)
      assert.deepEqual(reading.open, choice === "open" ? ["toolGroup:tool:bun run check"] : [])
      assert.deepEqual(reading.closed ?? [], choice === "open" ? [] : ["toolGroup:tool:bun run check"])
    } finally { mounted.dispose() }
  })
}

test("a settled read keeps its stretch header and ordinary file navigation", () => {
  const read: FrontendToolEntry = {
    ...call("read-one", "streaming"), name: "read", action: "file_read",
    presentation: { name: "Read", detail: "src/agent.ts" }, linkUri: "file:///repo/src/agent.ts",
  }
  const mounted = mountToolGroup([read], undefined, false, true)
  try {
    const header = mounted.header()
    mounted.toggle()
    mounted.publish({ blocks: [{ ...read, status: "completed" }, boundary] })
    assert.equal(mounted.header(), header)
    assert.match(mounted.text(), /Readagent\.ts/)
    assert.equal(header?.properties["aria-expanded"], true)
    assert.equal(mounted.elements().filter(node => node.properties.class === "tool-title").length, 1)
    const open = mounted.elements().find(node => node.properties.class === "tool-file-path")?.properties.onClick
    if (typeof open !== "function") throw new Error("Missing ordinary read file action")
    open()
    assert.deepEqual(mounted.openedFiles(), ["/repo/src/agent.ts"])
  } finally { mounted.dispose() }
})

test("a file-change stretch keeps its file choice under the restored stretch alias through settlement", async () => {
  const lines = Array.from({ length: 45 }, (_, index) => `source_line_${index}`)
  const stored = await mutationEvidenceFixture({
    version: 1, files: [{ path: "src/new.ts", change: "added", unifiedDiff: `@@ -0,0 +1,45 @@\n${lines.map(line => `+${line}`).join("\n")}\n` }], omissions: [],
  })
  const running: FrontendToolEntry = {
    ...call("write-one", "streaming"), name: "write", action: undefined, fileChangeKind: "create", content: undefined,
    presentation: { name: "Write", detail: "" },
    proposedDiff: { files: [{ id: "file-0", path: "src/new.ts", action: "add", hunks: [{
      id: "hunk-0", newStart: 1, omittedBefore: 0, omittedAfter: 0,
      lines: lines.map((text, index) => ({ id: `line-${index}`, kind: "add", text, partial: false })),
    }] }] },
  }
  const alias = "toolGroup:tool:write-one"
  const script: FrontendToolEntry = { ...call("script", "streaming"), name: "code", action: undefined }
  const mounted = mountToolGroup([script, running], { sessionId: "render-ownership", following: true, open: [alias] }, false, true, stored.reader)
  try {
    const wrapper = mounted.wrapper()
    const header = mounted.header()
    const body = mounted.elements().find(node => String(node.properties.class).split(" ").includes("tool-body"))
    assert.ok(body)
    assert.equal(wrapper?.properties["data-tool-stretch"], "toolGroup:tool:script")
    const expand = mounted.elements().find(node => node.tag === "button" && node.properties["aria-expanded"] === false)
    const click = expand?.properties.onClick
    assert.equal(typeof click, "function")
    if (typeof click === "function") click()
    const handle = stored.reader.open(running.id, stored.evidence.manifest)
    await handle.loadFiles()
    for (const entry of handle.files.files) await handle.patch(entry)?.continue(1000, 1000)
    mounted.publish({ blocks: [{ ...script, status: "completed" }, { ...running, status: "completed", mutationEvidence: stored.evidence }, boundary] })
    assert.equal(mounted.wrapper(), wrapper)
    assert.equal(mounted.header(), header)
    assert.ok(mounted.elements().includes(body))
    assert.match(mounted.text(), /Writesrc\/new\.ts/)
    assert.equal(mounted.elements().filter(node => node.properties.class === "tool-title").length, 1)
    assert.ok(mounted.elements().some(node => String(node.properties.innerHTML).includes("source_line_44")))
    assert.deepEqual(mounted.reading()?.open, [alias, `${alias}#diff:path:src/new.ts`])
    const path = mounted.elements().find(node => node.tag === "button" && node.properties.class === "diff-file-path")
    const open = path?.properties.onClick
    if (typeof open !== "function") throw new Error("Missing ordinary diff file action")
    open()
    assert.deepEqual(mounted.openedFiles(), ["src/new.ts"])
    mounted.publish({ blocks: [{ ...script, status: "completed" }, { ...running, status: "completed", mutationEvidence: stored.evidence }, call("second", "streaming")] })
    assert.ok(mounted.elements().includes(body), "file content survives a second call")
    assert.ok(mounted.elements().some(node => String(node.properties.innerHTML).includes("source_line_44")))
    assert.deepEqual(mounted.reading()?.open, [alias, `${alias}#diff:path:src/new.ts`])
  } finally { mounted.dispose(); stored.reader.dispose() }
})
