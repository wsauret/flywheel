import assert from "node:assert/strict"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { importBuiltModule } from "../test-support/import-built-module.js"
import { loadSolidFixture } from "../test-support/solid-transform.js"
import { IN_PLACE_SETTING_ROWS, settingGroupHead, shownOn } from "../../../src/protocol/setting-catalog.js"
import { MODULE_SETTING_GROUPS } from "../../../src/protocol/module-protocol-types.js"
import { WRITE_SYNTAX_THEME_OPTIONS } from "../../../src/protocol/write-syntax-theme.js"

const build = await Bun.build({
  entrypoints: [fileURLToPath(new URL("command-panel-controls-fixture.tsx", import.meta.url))],
  target: "bun",
  conditions: ["browser"],
  format: "esm",
  plugins: [{
    name: "command-panel-memory-host",
    setup(builder) {
      builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }))
      builder.onLoad({ filter: /\.tsx$/ }, loadSolidFixture("memory-host"))
    },
  }],
})
if (!build.success) throw new Error(build.logs.map(String).join("\n"))
const output = build.outputs.find((candidate) => candidate.kind === "entry-point")
if (!output) throw new Error("Command panel fixture build produced no JavaScript")
const fixture: typeof import("./command-panel-controls-fixture.js") =
  await importBuiltModule(output)

test("a running child's panel offers Interrupt and Stop, and no Pause", async () => {
  const mounted = await fixture.mountChildCommandPanel()
  try {
    const labels = mounted.labels()
    assert.ok(labels.includes("Interrupt"), labels.join(", "))
    assert.ok(labels.includes("Stop"), labels.join(", "))
    assert.ok(!labels.some((label) => /pause/i.test(label)), labels.join(", "))

    const beforePress = mounted.dispatched.length
    assert.equal(mounted.press("Interrupt", "onPointerDown"), true)
    assert.equal(mounted.press("Interrupt", "onMouseDown"), true)
    assert.equal(mounted.dispatched.length, beforePress)
    await mounted.pick("Interrupt")
    assert.deepEqual(mounted.dispatched.at(-1), { type: "subagent.interrupt", sessionId: "child" })
  } finally {
    mounted.dispose()
  }
})

test("a child parked on its own background work still offers Interrupt", async () => {
  const mounted = await fixture.mountChildCommandPanel({ status: { activity: "idle", waitingOnBackgroundWork: true, replyWaits: [] } })
  try {
    assert.ok(mounted.labels().includes("Interrupt"), mounted.labels().join(", "))
    await mounted.pick("Interrupt")
    assert.deepEqual(mounted.dispatched.at(-1), { type: "subagent.interrupt", sessionId: "child" })
  } finally {
    mounted.dispose()
  }
})

test("a child's Stop terminates the parent's tool call instead of interrupting the child", async () => {
  const mounted = await fixture.mountChildCommandPanel()
  try {
    await mounted.pick("Stop")
    assert.deepEqual(mounted.dispatched.at(-1), { type: "background.terminate", sessionId: "parent-chat", toolUseId: "tu-explorer" })
    assert.deepEqual(mounted.reports, [])
  } finally {
    mounted.dispose()
  }
})

test("a workflow agent's panel names it by its kind, not a subagent, in Delete and Copy session ID", async () => {
  for (const [query, label, description] of [
    ["delete", "Delete workflow-agent", "Remove this workflow-agent permanently"],
    ["copy session", "Copy session ID", "Copy this workflow-agent's full debugging identifier"],
  ] as const) {
    const mounted = await fixture.mountChildCommandPanel({ kind: "workflow-agent", query })
    try {
      assert.ok(mounted.labels().includes(label), mounted.labels().join(", "))
      assert.equal(mounted.description(label), description)
    } finally {
      mounted.dispose()
    }
  }
})

test("the catalog footer counts the commands the Commands sheet lists on this host, is a button, so it shows the press state, and a tap opens the Commands sheet", async () => {
  const fork = { id: "fork", title: "Fork conversation", description: "Fork", aliases: [] }
  // This host takes no chords, so the sheet omits Keyboard shortcuts.
  const shortcuts = { id: "shortcuts", title: "Keyboard shortcuts", description: "Chords", aliases: [], opens: "keyboard-shortcuts" }
  const mounted = await fixture.mountChildCommandPanel({ builtInCommands: [fork, shortcuts] })
  try {
    const footer = mounted.footer()
    assert.ok(footer, "a catalog shows its footer")
    assert.equal(footer.text, "Type to search 1 command")
    assert.equal(footer.role, "button")
    footer.tap()
    assert.deepEqual(mounted.sheets, ["commands"])
  } finally {
    mounted.dispose()
  }
})

test("a bare slash lists the top commands, every in-place setting in catalog order, the chat commands, then the more group, and offers an unpositioned command only to typing", async () => {
  const mounted = await fixture.mountChildCommandPanel({ builtInCommands: fixture.PUBLISHED_COMMANDS, settings: true, background: 1, keyboardShortcuts: true })
  try {
    const outline = mounted.outline()
    assert.deepEqual(outline.map((section) => section.section), ["Common", "Settings", "Chat", "More"])
    assert.deepEqual(outline[0]?.rows, ["Authentication", "Background work", "Keyboard shortcuts"])
    // A capability group's own rows show with that group's modules, and this runtime has none.
    const groupRows = new Set(MODULE_SETTING_GROUPS.flatMap((group) => settingGroupHead(group).map((row) => row.id)))
    // Each module's switch sits at its module's place: an ungrouped one under Agent capabilities, before Allow persistent processes.
    const catalogRows = IN_PLACE_SETTING_ROWS.filter((row) => shownOn(row, "browser") && !groupRows.has(row.id)).map((row) => row.label)
    const persistent = catalogRows.indexOf("Allow persistent processes")
    assert.deepEqual(outline[1]?.rows, [...catalogRows.slice(0, persistent), "Subagents", ...catalogRows.slice(persistent)])
    assert.deepEqual(outline[2]?.rows.slice(0, 2), ["New chat", "Compact conversation"])
    assert.deepEqual(outline[3]?.rows, ["Commands"])
  } finally { mounted.dispose() }
  const typed = await fixture.mountChildCommandPanel({ builtInCommands: fixture.PUBLISHED_COMMANDS, query: "fork" })
  try {
    assert.ok(typed.labels().includes("Fork conversation"), typed.labels().join(", "))
  } finally { typed.dispose() }
})

test("Close chat is one row, the catalog command that /close finds, which closes the chat now and is refused in an agent's view", async () => {
  const close = { id: "close", title: "Close chat", description: "End this chat's work now", aliases: [], opens: "close-chat", menu: { group: "chat", rank: 80 } } as const
  const closes = (dispatched: readonly unknown[]) => dispatched.filter((mutation) => typeof mutation === "object" && mutation !== null && "type" in mutation && mutation.type === "session.close")
  const chat = await fixture.mountChildCommandPanel({ builtInCommands: [close], chat: true, query: "close" })
  try {
    assert.equal(chat.labels().filter((label) => label === "Close chat").length, 1, chat.labels().join(", "))
    await chat.pick("Close chat")
    assert.deepEqual(chat.invoked, ["close"])
    await chat.openSurface("close-chat")
    assert.deepEqual(closes(chat.dispatched), [{ type: "session.close", sessionId: "parent-chat" }])
  } finally { chat.dispose() }
  const agent = await fixture.mountChildCommandPanel({ builtInCommands: [close], query: "close" })
  try {
    await agent.openSurface("close-chat")
    assert.deepEqual(closes(agent.dispatched), [])
    assert.deepEqual(agent.reports, ["/close works in a chat, not in this subagent"])
  } finally { agent.dispose() }
})

test("an in-place setting row shows its value and changes it from the keyboard without leaving the panel", async () => {
  const mounted = await fixture.mountChildCommandPanel({ settings: true })
  try {
    // A switch shows its state; right means on, so on an on switch it writes nothing, and left turns it off.
    assert.deepEqual(mounted.control("Show thinking"), { value: undefined, on: true })
    assert.equal(await mounted.key("Show thinking", "ArrowRight"), true)
    assert.deepEqual(mounted.settingWrites, [])
    await mounted.key("Show thinking", "ArrowLeft")
    assert.deepEqual(mounted.settingWrites, [{ kind: "set-show-thinking", on: false }])
    // A choice shows its value's name, and the arrows step through its values either way.
    assert.equal(mounted.control("Diff colours").value, "Theme")
    await mounted.key("Diff colours", "ArrowRight")
    const themes = WRITE_SYNTAX_THEME_OPTIONS.map((option) => option.value)
    await mounted.key("Write syntax theme", "ArrowLeft")
    assert.deepEqual(mounted.settingWrites.slice(1), [{ kind: "set-diff-colors", mode: "standard" }, { kind: "set-write-syntax-theme", theme: themes.at(themes.indexOf("nord") - 1) }])
    // A number is typed in Settings, so Enter opens it there.
    assert.equal(mounted.control("Auto compact at").value, "50,000")
    await mounted.key("Auto compact at", "Enter")
    assert.deepEqual(mounted.sheets, ["settings"])
  } finally { mounted.dispose() }
})

test("a command opens through the same invocation a typed token runs", async () => {
  const mounted = await fixture.mountChildCommandPanel({ builtInCommands: fixture.PUBLISHED_COMMANDS, settings: true })
  try {
    await mounted.pick("Authentication")
    assert.deepEqual(mounted.invoked, ["auth"])
  } finally { mounted.dispose() }
})

test("the panel lists Background work only while background work runs, and no command a host cannot open", async () => {
  const mounted = await fixture.mountChildCommandPanel({ builtInCommands: fixture.PUBLISHED_COMMANDS, background: 0 })
  try {
    const labels = mounted.labels()
    assert.ok(labels.includes("Authentication"), labels.join(", "))
    assert.ok(!labels.includes("Background work"), labels.join(", "))
    // Usage is a module surface this host has not mounted, and a phone takes no chords.
    assert.ok(!labels.includes("Usage"), labels.join(", "))
    assert.ok(!labels.includes("Keyboard shortcuts"), labels.join(", "))
  } finally { mounted.dispose() }
})
