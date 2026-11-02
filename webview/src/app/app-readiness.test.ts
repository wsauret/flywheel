import assert from "node:assert/strict"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { importBuiltModule } from "../test-support/import-built-module.js"
import { loadSolidFixture } from "../test-support/solid-transform.js"

const build = await Bun.build({
  entrypoints: [fileURLToPath(new URL("app-readiness-fixture.tsx", import.meta.url))],
  target: "bun", conditions: ["browser"],
  plugins: [{
    name: "app-readiness-memory",
    setup(builder) {
      builder.onLoad({ filter: /[\\/]focus-trap\.ts$/ }, () => ({ contents: "export function trapFocus() {}", loader: "js" }))
      builder.onLoad({ filter: /\.tsx$/ }, loadSolidFixture("memory-host"))
    },
  }],
})
if (!build.success) throw new Error(build.logs.map(String).join("\n"))
const output = build.outputs.find(candidate => candidate.kind === "entry-point")
if (!output) throw new Error("App fixture build produced no JavaScript")
const fixture: typeof import("./app-readiness-fixture.js") = await importBuiltModule(output)
type Mounted = ReturnType<typeof fixture.mountAppReadiness>
const find = (mounted: Mounted, name: string) => mounted.elements().find(node => String(node.properties.class).split(" ").includes(name))
const settle = async () => { for (let turn = 0; turn < 12; turn++) await Promise.resolve() }

test("App keeps the wide navigation and selected workspace through expiry of the last provider", async () => {
  const mounted = fixture.mountAppReadiness()
  try {
    await settle()
    mounted.layout()
    mounted.command({ type: "openSheet", sheet: "status" })
    await settle()
    const rail = find(mounted, "rail")
    const resizer = find(mounted, "rail-resizer")
    const panel = find(mounted, "workspace-panel")
    const panelScroller = find(mounted, "workspace-panel-body")
    const search = mounted.elements().find(node => node.tag === "input" && node.properties.type === "search")
    const scroller = find(mounted, "rail-list")
    const row = find(mounted, "session-row")
    assert.ok(rail && resizer && panel && panelScroller && search && scroller && row)
    search.focus()
    const input = search.properties.onInput
    if (typeof input === "function") input({ currentTarget: { value: "Chat" } })
    scroller.scrollTop = 91
    panelScroller.scrollTop = 127
    for (const setup of ["none", "usable"] as const) {
      mounted.publish(setup)
      await settle()
      assert.equal(find(mounted, "rail"), rail)
      assert.equal(find(mounted, "rail-resizer"), resizer)
      assert.equal(find(mounted, "workspace-panel"), panel)
      assert.equal(find(mounted, "workspace-panel-body"), panelScroller)
      assert.equal(panelScroller.scrollTop, 127)
      assert.ok(mounted.elements().includes(search))
      assert.equal(search.properties.value, "Chat")
      assert.equal(find(mounted, "session-row"), row)
      assert.equal(search.ownerDocument.activeElement, search)
      assert.equal(find(mounted, "rail-list"), scroller)
      assert.equal(scroller.scrollTop, 91)
    }
  } finally { mounted.dispose() }
})

test("App keeps the phone list, screen transform, filter and focus through offline, dormant and live presence", async () => {
  const mounted = fixture.mountAppReadiness({ phone: true, sessionCount: 30 })
  try {
    await settle()
    mounted.layout()
    const screen = find(mounted, "screen-sessions")
    const search = mounted.elements().find(node => node.tag === "input" && node.properties.type === "search")
    const scroller = find(mounted, "rail-list")
    const client = find(mounted, "client")
    const row = find(mounted, "session-row")
    const install = find(mounted, "install-guide")
    const heading = find(mounted, "toolbar-heading")
    assert.ok(screen && search && scroller && client && row && install && heading)
    const identity = mounted.textOf(heading)
    assert.equal(identity, "ProjectMachine")
    search.focus()
    const input = search.properties.onInput
    if (typeof input === "function") input({ currentTarget: { value: "Chat" } })
    scroller.scrollTop = 73
    const transform = client.properties.style
    for (const presence of ["offline", "dormant", "live"] as const) {
      mounted.presence(presence)
      await settle()
      assert.equal(find(mounted, "screen-sessions"), screen)
      assert.equal(find(mounted, "rail-list"), scroller)
      assert.ok(mounted.elements().includes(search))
      assert.equal(search.properties.value, "Chat")
      assert.equal(find(mounted, "session-row"), row)
      assert.equal(search.ownerDocument.activeElement, search)
      assert.equal(scroller.scrollTop, 73)
      assert.equal(find(mounted, "install-guide"), install)
      assert.equal(find(mounted, "toolbar-heading"), heading)
      assert.equal(mounted.textOf(heading), identity)
      assert.deepEqual(client.properties.style, transform)
    }
    // The project turned open after it was not: the connection hears once
    // that its runtime appeared, so a fault from the asleep time ends.
    assert.equal(mounted.appearances(), 1)
  } finally { mounted.dispose() }
})

test("App holds a known project's focused composer through runtime takeover", async () => {
  const mounted = fixture.mountAppReadiness({ phone: true, chat: true })
  try {
    await settle()
    mounted.layout()
    const editor = mounted.elements().find(node => node.tag === "textarea")
    const resident = find(mounted, "pane-resident")
    const send = find(mounted, "composer-send")
    assert.ok(editor && resident && send)
    const input = editor.properties.onInput
    assert.equal(typeof input, "function")
    if (typeof input === "function") input({ currentTarget: { value: "Keep this draft", selectionStart: 15, style: {}, scrollHeight: 20 } })
    assert.equal(editor.properties.value, "Keep this draft")
    assert.equal(find(mounted, "pane")?.properties.inert, false)
    editor.focus()
    mounted.presence("offline")
    await settle()
    assert.ok(mounted.elements().includes(editor))
    assert.equal(resident.properties.inert, false)
    assert.equal(find(mounted, "pane")?.properties.inert, false)
    assert.equal(editor.ownerDocument.activeElement, editor)
    assert.equal(find(mounted, "composer-send"), send)
    assert.equal(send.properties["aria-disabled"], true)
    const click = send.properties.onClick
    if (typeof click === "function") click()
    const keydown = editor.properties.onKeyDown
    if (typeof keydown === "function") keydown({ key: "Enter", preventDefault() {}, isComposing: false })
    assert.equal(editor.properties.value, "Keep this draft")
    assert.deepEqual(mounted.sent(), [])
    mounted.presence("live")
    await settle()
    assert.notEqual(send.properties["aria-disabled"], true)
    if (typeof click === "function") click()
    await settle()
    assert.deepEqual(mounted.sent(), ["Keep this draft"])
    assert.equal(editor.properties.value, "")
  } finally { mounted.dispose() }
})

// A short freeze of the machine, such as a suspended runtime, makes the relay
// report it offline for a few seconds while the lane is still within its
// fault window. The chat stays as it was and the machine list stays away;
// the list comes beside the fault notice only once the connection says
// that the runtime does not answer.
test("App shows a known project's machine list only with the connection's fault, never for a presence report alone", async () => {
  const mounted = fixture.mountAppReadiness({ phone: true, chat: true })
  try {
    await settle()
    mounted.layout()
    const resident = find(mounted, "pane-resident")
    assert.ok(resident)
    mounted.presence("offline")
    await settle()
    assert.equal(find(mounted, "pane-advisory"), undefined)
    assert.doesNotMatch(mounted.text(), /Choose a project/)
    mounted.health({ kind: "faulted", since: 1 })
    await settle()
    assert.ok(find(mounted, "pane-advisory"))
    assert.match(mounted.text(), /Choose a project/)
    mounted.presence("live")
    mounted.health({ kind: "healthy" })
    await settle()
    assert.equal(find(mounted, "pane-advisory"), undefined)
    assert.equal(find(mounted, "pane-resident"), resident)
  } finally { mounted.dispose() }
})

// A reload or a reopened tab hands its waiting messages to the new page,
// which shows their chat with them queued while it attaches, however long
// the connection stays down, instead of the cold loading screen. Sending
// stays held until the project answers.
test("App shows the chat of restored waiting messages before the project's first snapshot, with sending held", async () => {
  const mounted = fixture.mountAppReadiness({ cold: true, chat: true, waiting: ["Still on its way"] })
  try {
    await settle()
    mounted.layout()
    assert.ok(find(mounted, "pane-resident"))
    assert.match(mounted.text(), /Still on its way/)
    assert.match(mounted.text(), /Queued/)
    assert.doesNotMatch(mounted.text(), /Opening this project/)
    assert.equal(find(mounted, "composer-send")?.properties["aria-disabled"], true)
  } finally { mounted.dispose() }
})

test("App keeps cold loading without a project but mounts navigation for a known project without a provider", async () => {
  for (const cold of [true, false]) {
    const mounted = fixture.mountAppReadiness({ cold, noProvider: true })
    try {
      await settle()
      mounted.layout()
      assert.equal(find(mounted, "rail") !== undefined, !cold)
      assert.equal(find(mounted, "pane-resident") !== undefined, !cold)
      assert.match(mounted.text(), cold ? /Opening this project/ : /Connect a model provider/)
    } finally { mounted.dispose() }
  }
})

test("App opens the asking chat from a question notice over its full-size workflow card, and Back returns to the card", async () => {
  const card = { flywheelScreen: "chat", flywheelSession: "chat", flywheelPlace: { kind: "card", workflowId: "run", chatSessionId: "chat" } }
  const mounted = fixture.mountAppReadiness({ chat: true, moduleIds: ["workflows"], historyState: card })
  /** Whether the card covers the chat: its screen shows and the transcript hides. */
  const covered = () => {
    const classList = find(mounted, "transcript-slot")?.properties.classList
    const hidden = classList instanceof Object && "hidden-for-workflow" in classList && classList["hidden-for-workflow"] === true
    assert.equal(find(mounted, "workflow-card-screen") !== undefined, hidden)
    return hidden
  }
  try {
    await settle()
    mounted.layout()
    assert.equal(covered(), true, "the card covers the chat's conversation")
    mounted.openNotice("chat")
    await settle()
    assert.equal(covered(), false, "the notice shows the conversation that asks")
    globalThis.history.back()
    await settle()
    assert.equal(covered(), true, "Back returns to the card")
  } finally { mounted.dispose() }
})
