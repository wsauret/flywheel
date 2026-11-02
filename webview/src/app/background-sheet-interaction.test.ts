import assert from "node:assert/strict"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import type { BackgroundWorkRow } from "../../../src/protocol/background-index-protocol-types.js"
import { importBuiltModule } from "../test-support/import-built-module.js"
import { loadSolidFixture } from "../test-support/solid-transform.js"

const build = await Bun.build({
  entrypoints: [fileURLToPath(new URL("background-sheet-interaction-fixture.ts", import.meta.url))],
  target: "bun",
  conditions: ["browser"],
  format: "esm",
  plugins: [{
    name: "background-sheet-memory-host",
    setup(builder) {
      builder.onLoad({ filter: /[\\/]focus-trap\.ts$/ }, () => ({ contents: "export function trapFocus() {}", loader: "js" }))
      builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }))
      builder.onLoad({ filter: /[\\/]client-context\.ts$/ }, () => ({
        contents: "export function useClient() { return Reflect.get(globalThis, '__flywheelBackgroundSheetTestClient') }",
        loader: "js",
      }))
      builder.onLoad({ filter: /\.tsx$/ }, loadSolidFixture("memory-host"))
    },
  }],
})
if (!build.success) throw new Error(build.logs.map(String).join("\n"))
const javascript = build.outputs.find((output) => output.kind === "entry-point")
if (!javascript) throw new Error("Background sheet fixture build produced no JavaScript")
const { mountBackgroundSheet }: typeof import("./background-sheet-interaction-fixture.js") = await importBuiltModule(javascript)

const ROWS: readonly BackgroundWorkRow[] = [
  { id: "toolu_server", kind: "command", title: "bun run dev", startedAtMs: 100, cardToolUseId: "toolu_server", status: "running", stop: { sessionId: "chat", toolUseId: "toolu_server" } },
  { id: "reviewer", kind: "subagent", title: "Reviewer", startedAtMs: 200, cardToolUseId: "toolu_reviewer", target: { kind: "session", sessionId: "reviewer" }, status: "running", stop: { sessionId: "chat", toolUseId: "toolu_reviewer" } },
  { id: "toolu_test", kind: "command", title: "bun test", startedAtMs: 300, cardToolUseId: "toolu_test", status: "failed", exitCode: 2, durationMs: 1_500 },
]

test("lists running work whose card is outside the loaded window, and a tap lands on the card through openAround", async () => {
  const mounted = mountBackgroundSheet(ROWS)
  try {
    await mounted.ready()
    assert.deepEqual(mounted.queries(), [{ type: "sessionBackgroundWork", sessionId: "chat" }])
    assert.match(mounted.text(), /bun run dev/)
    assert.match(mounted.text(), /Reviewer/)
    assert.doesNotMatch(mounted.text(), /bun test/)

    mounted.tap("bun run dev")
    await mounted.ready()
    assert.equal(mounted.closed(), 1)
    assert.deepEqual(mounted.landings(), [["chat", "toolu_server"]])
    assert.deepEqual(mounted.marked(), ["block-toolu_server"])
  } finally {
    mounted.dispose()
  }
})

test("a child opens from its Open control and from Enter, with the chat as the place Back returns to", async () => {
  const mounted = mountBackgroundSheet(ROWS)
  try {
    await mounted.ready()
    const row = mounted.row("Reviewer")
    const open = mounted.elements().find(node => node.tag === "button" && node.parent === row && node.properties.class === "tool-action")
    assert.ok(open)
    open.focus()
    const wrapper = row.parent
    assert.ok(wrapper)
    mounted.refresh([
      { id: "new-parent", kind: "subagent", title: "New parent", startedAtMs: 50, cardToolUseId: "new-parent", status: "running" },
      ...ROWS.map(entry => entry.id === "reviewer" ? { ...entry, parentRowId: "new-parent", title: "Current reviewer", status: "waiting_on_parent" as const, target: { kind: "session" as const, sessionId: "current-destination" } } : { ...entry }),
    ])
    await mounted.ready()
    assert.equal(mounted.row("Current reviewer"), row)
    assert.ok(mounted.elements().includes(open))
    assert.equal(open.ownerDocument.activeElement, open)
    assert.deepEqual(wrapper.properties.style, { "--background-depth": 1 })
    const ordered = mounted.elements().filter(node => node.properties.class === "background-row")
    assert.equal(ordered[0], mounted.row("New parent").parent)
    assert.equal(ordered[2], wrapper)
    assert.match(mounted.text(), /Waiting/)
    mounted.click("Open", "Current reviewer")
    mounted.enter("Current reviewer")
    const link = { label: "Current reviewer", parentSessionId: "chat" }
    assert.deepEqual(mounted.selected(), [["current-destination", link], ["current-destination", link]])
    assert.deepEqual(mounted.landings(), [])
  } finally {
    mounted.dispose()
  }
})

test("a workflow delegates its typed card target to its module, while an agent command opens the actual member session", async () => {
  const mounted = mountBackgroundSheet([
    { id: "workflow", kind: "workflow", title: "Implement", startedAtMs: 100, cardToolUseId: "toolu_workflow", target: { kind: "workflow", workflowId: "workflow" }, status: "running", stop: { sessionId: "chat", toolUseId: "toolu_workflow" } },
    { id: "toolu_agent_server", kind: "command", title: "agent server", startedAtMs: 200, cardToolUseId: "toolu_workflow", parentRowId: "member", target: { kind: "session", sessionId: "member" }, status: "running" },
  ])
  try {
    await mounted.ready()
    mounted.click("Open", "Implement")
    mounted.tap("agent server")
    const link = { label: "agent server", parentSessionId: "chat" }
    assert.deepEqual(mounted.selected(), [["member", link]])
    assert.deepEqual(mounted.openedTargets(), [{ kind: "workflow", workflowId: "workflow" }])
    assert.deepEqual(mounted.landings(), [])
  } finally {
    mounted.dispose()
  }
})

test("Stop asks first, then ends the row's launching call", async () => {
  const mounted = mountBackgroundSheet(ROWS)
  try {
    await mounted.ready()
    mounted.click("Stop", "Reviewer")
    await mounted.ready()
    assert.deepEqual(mounted.mutations(), [])
    mounted.settleConfirmation(true)
    await mounted.ready()
    assert.deepEqual(mounted.mutations(), [{ type: "background.terminate", sessionId: "chat", toolUseId: "toolu_reviewer" }])
  } finally {
    mounted.dispose()
  }
})

test("All shows finished work with its outcome and no Stop, and the choice is the next sheet's", async () => {
  const stored: { [key: string]: string } = {}
  const first = mountBackgroundSheet(ROWS, stored)
  try {
    await first.ready()
    first.click("All")
    assert.match(first.text(), /bun test/)
    assert.match(first.text(), /Failed · exit 2 · 1\.5s/)
    assert.throws(() => first.click("Stop", "bun test"))
  } finally {
    first.dispose()
  }
  const second = mountBackgroundSheet(ROWS, stored)
  try {
    await second.ready()
    assert.match(second.text(), /bun test/)
  } finally {
    second.dispose()
  }
})
