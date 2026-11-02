import assert from "node:assert/strict"
import { test } from "node:test"
import type { ProviderModelRow } from "../../../src/protocol/provider-model-preference-protocol-types.js"
import { loadSemanticRows } from "./semantic-rows-loader-fixture.js"
import { loadStabilityFixture } from "../modules/workflows/stability-fixture-loader.js"
import { fakePanelSettings } from "./client-context-fixture.js"
import { authView } from "../client/session-connection-fixture.js"
import { EMPTY_REMOTE_VIEW } from "../../../src/protocol/modules/remote.js"

const fixture = await loadStabilityFixture()
const semantic = await loadSemanticRows()

for (const inline of [true, false]) {
  test(`the ${inline ? "inline" : "full-size"} card patches its agent serving model without replacing nodes`, async () => {
    const mounted = fixture.mountWorkflowIdentity(inline)
    try {
      assert.match(mounted.text(), /worker-model high/)
      assert.doesNotMatch(mounted.text(), /wrong-chat/)
      const labels = mounted.modelNodes()
      mounted.changeModel()
      assert.match(mounted.text(), /edited-model medium/)
      assert.ok(labels.every(node => mounted.modelNodes().includes(node)))
      await mounted.refresh()
      assert.ok(labels.every(node => mounted.modelNodes().includes(node)))
    } finally { mounted.dispose() }
  })
}

test("intro module actions retain their node and focus while visible counts update", () => {
  const initial = { modules: { papercuts: { undisposedCount: 25 } }, settings: fakePanelSettings({ moduleIds: ["papercuts"] }) }
  const mounted = semantic.mountSemanticRows("intro", initial)
  try {
    const action = mounted.button("/papercuts")
    assert.ok(action)
    action.focus()
    mounted.publish(structuredClone(initial))
    assert.equal(mounted.button("/papercuts"), action)
    mounted.publish({ ...initial, modules: { papercuts: { undisposedCount: 30 } } })
    assert.equal(mounted.button("/papercuts"), action)
    assert.match(mounted.text(), /30 logged/)
  } finally { mounted.dispose() }
})

test("provider setup retains its focused button and reads the latest provider detail", () => {
  const initial = { providers: [{ id: "copilot", displayName: "Copilot", connected: false, expired: false, source: "unconfigured" as const, loginMethod: "device-code" as const }] }
  const mounted = semantic.mountSemanticRows("providers", initial)
  try {
    const button = mounted.button("Copilot")
    assert.ok(button)
    button.focus()
    mounted.publish(structuredClone(initial))
    assert.equal(mounted.button("Copilot"), button)
    mounted.publish({ providers: [{ ...initial.providers[0]!, source: "invalid" }] })
    assert.equal(mounted.button("Copilot"), button)
    assert.match(mounted.text(), /credential rejected/)
    const click = button.properties.onClick
    if (typeof click === "function") click()
    assert.deepEqual(mounted.calls(), [["providers", { kind: "connect-provider", providerId: "copilot" }]])
  } finally { mounted.dispose() }
})

test("command groups and rows update without replacing their search and action owners", () => {
  const initial = { builtInCommands: [{ id: "build", title: "Build", description: "First", aliases: [] }], commandUsage: [] }
  const mounted = semantic.mountSemanticRows("commands", initial)
  try {
    const button = mounted.button("/build")
    const search = mounted.elements().find(node => node.tag === "input")
    assert.ok(button)
    button.focus()
    mounted.publish(structuredClone(initial))
    assert.equal(mounted.button("/build"), button)
    mounted.publish({ ...initial, builtInCommands: [{ ...initial.builtInCommands[0]!, description: "Current description" }] })
    assert.equal(mounted.button("/build"), button)
    assert.equal(mounted.elements().find(node => node.tag === "input"), search)
    assert.match(mounted.text(), /Current description/)
    const click = button.properties.onClick
    assert.equal(typeof click, "function")
    if (typeof click === "function") click()
    assert.deepEqual(mounted.calls(), ["/build "])
  } finally { mounted.dispose() }
})

test("the Commands sheet lists the built-in commands in command-menu order and no skill, with use counts that fold each alias into its command", () => {
  const builtInCommands = [
    { id: "fork", title: "Fork conversation", description: "Fork", aliases: [] },
    { id: "auth", title: "Authentication", description: "Sign in", aliases: ["login"], opens: "settings", target: { kind: "place" as const, place: "authentication" as const }, menu: { group: "top" as const, rank: 50 } },
    { id: "new", title: "New chat", description: "Start a chat", aliases: [], opens: "new-chat", menu: { group: "chat" as const, rank: 100 } },
    { id: "shortcuts", title: "Keyboard shortcuts", description: "Chords", aliases: [], opens: "keyboard-shortcuts", menu: { group: "top" as const, rank: 200 } },
    { id: "status", title: "Status", description: "Status", aliases: [], opens: "status", menu: { group: "top" as const, rank: 100 } },
  ]
  // The usage record keeps the tokens of skills that earlier releases ran.
  const mounted = semantic.mountSemanticRows("commands", { builtInCommands, commandUsage: [{ name: "build", count: 2 }, { name: "make", count: 1 }, { name: "auth", count: 4 }, { name: "login", count: 3 }, { name: "learned.conventions", count: 5 }] })
  try {
    const text = mounted.text()
    const sections = ["Common", "Chat", "More"].map((title) => text.indexOf(title))
    assert.ok(sections.every((index, at) => index >= 0 && index > (sections[at - 1] ?? -1)), text)
    // This host takes no chords, so the sheet names no Keyboard shortcuts.
    assert.ok(!text.includes("/shortcuts"), text)
    // No command list shows a skill or the uses recorded for its token.
    assert.ok(!text.includes("Skills") && !text.includes("/build") && !text.includes("/learned.conventions") && !/[235] uses/.test(text), text)
    const order = ["/status", "/new", "/fork"].map((name) => text.indexOf(name))
    assert.deepEqual(order, order.toSorted((a, b) => a - b))
    assert.ok(order.every((index) => index >= 0), text)
    // One row per command, with its uses summed and its alias as a hint.
    assert.deepEqual([/7 uses/.test(text), /Also \/login/.test(text), text.split("Authentication").length], [true, true, 2], text)
  } finally { mounted.dispose() }
})

test("profile candidates and provider setup actions retain their current subjects", async () => {
  const initial = { authStatus: { snapshotPosition: 1, auth: { ...authView([]), profile: { id: "one", displayName: "One", source: "default" as const, availableProfiles: [{ id: "one", displayName: "One" }, { id: "two", displayName: "Two" }] } } } }
  const mounted = semantic.mountSemanticRows("profiles", initial, { queries: { authProfileDeletionPreview: ({ id }) => ({ kind: "choose", source: { id, displayName: "Two" }, candidates: [{ id: "one", displayName: "One" }, { id: "three", displayName: "Successor" }] }) }, mutations: { "auth.profile.select": ({ id }) => ({ id }), "auth.profile.delete": ({ id }) => ({ id }) } })
  try {
    const row = mounted.button("Two")
    assert.ok(row)
    row.focus()
    const next = structuredClone(initial)
    next.authStatus.auth.profile.availableProfiles[1]!.displayName = "Renamed"
    mounted.publish(next)
    assert.equal(mounted.button("Renamed"), row)
    assert.equal(row.ownerDocument.activeElement, row)
    const click = row.properties.onClick
    if (typeof click === "function") click()
    await Promise.resolve()
    assert.deepEqual(mounted.calls(), [{ type: "auth.profile.select", scope: { kind: "defaults" }, id: "two" }])
    const deleteMode = mounted.button("Delete a profile")?.properties.onClick
    assert.equal(typeof deleteMode, "function")
    if (typeof deleteMode === "function") deleteMode()
    const deleting = mounted.button("Renamed")
    assert.ok(deleting)
    deleting.focus()
    const latest = structuredClone(next)
    latest.authStatus.auth.profile.availableProfiles[1]!.displayName = "Latest name"
    mounted.publish(latest)
    assert.equal(mounted.button("Latest name"), deleting)
    assert.equal(deleting.ownerDocument.activeElement, deleting)
    const remove = deleting.properties.onClick
    assert.equal(typeof remove, "function")
    if (typeof remove === "function") remove()
    for (let turn = 0; turn < 10; turn++) await Promise.resolve()
    const successor = mounted.elements().find(node => node.tag === "select")
    const option = mounted.elements().find(node => node.tag === "option" && node.properties.value === "three")
    assert.ok(successor && option)
    successor.focus()
    const choose = successor.properties.onChange
    assert.equal(typeof choose, "function")
    if (typeof choose === "function") choose({ currentTarget: { value: "three" } })
    mounted.publish(structuredClone(latest))
    assert.ok(mounted.elements().includes(option))
    assert.ok(mounted.elements().includes(successor))
    assert.equal(successor.properties.value, "three")
    assert.equal(successor.ownerDocument.activeElement, successor)
    const confirm = mounted.button("Delete")?.properties.onClick
    assert.equal(typeof confirm, "function")
    if (typeof confirm === "function") confirm()
    for (let turn = 0; turn < 10; turn++) await Promise.resolve()
    assert.deepEqual(mounted.calls().at(-1), { type: "auth.profile.delete", scope: { kind: "defaults" }, id: "two", successorId: "three" })
    assert.ok(mounted.button("New profile"))
  } finally { mounted.dispose() }
  const providers = { providers: [{ id: "openai", displayName: "OpenAI", connected: false, expired: false, source: "unconfigured" as const, loginMethod: "api-key" as const }] }
  const setup = semantic.mountSemanticRows("providers", providers)
  try {
    const row = setup.button("OpenAI")
    assert.ok(row)
    setup.publish({ providers: [{ ...providers.providers[0]!, displayName: "Current provider" }] })
    assert.equal(setup.button("Current provider"), row)
    const click = row.properties.onClick
    if (typeof click === "function") click()
    assert.deepEqual(setup.calls(), [["providers", { kind: "connect-provider", providerId: "openai" }]])
  } finally { setup.dispose() }
})

test("Provider Models reacts only to semantic auth revisions and explicit mutation", async () => {
  const mounted = fixture.mountProviderModels()
  try {
    assert.equal(mounted.queryCount(), 1)
    mounted.resolve()
    await mounted.ready()
    assert.match(mounted.text(), /model-1/)
    const row = mounted.row()
    const body = mounted.body()
    assert.ok(row)
    assert.ok(body)
    row.focus()
    body.scrollTop = 91
    await mounted.equivalent()
    assert.equal(mounted.queryCount(), 1)
    await mounted.authRevision(false)
    assert.equal(mounted.queryCount(), 1)
    await mounted.authRevision()
    assert.equal(mounted.queryCount(), 2)
    assert.match(mounted.text(), /model-1/)
    assert.equal(row.properties["aria-disabled"], undefined)
    assert.equal(mounted.mutate(), true)
    assert.equal(mounted.dispatchCount(), 0)
    assert.equal(mounted.mutate(), true)
    assert.equal(mounted.dispatchCount(), 0)
    mounted.resolve("model-1", false)
    await mounted.ready()
    assert.deepEqual(mounted.mutations(), [{
      type: "provider_model.set",
      queriedProfileId: "personal",
      queriedEligibilityRevision: 2,
      target: { kind: "singleton", providerId: "openai" },
      modelId: "model-1",
      checked: false,
    }])
    assert.equal(mounted.row(), row)
    assert.equal(row.properties.focused, true)
    assert.equal(mounted.body(), body)
    assert.equal(body.scrollTop, 91)
    assert.deepEqual(mounted.refreshes(), [{ type: "auth.catalog.refresh", scope: { kind: "profile", profileId: "personal" } }])
    mounted.settleDispatch()
    await mounted.ready()
    mounted.resolve("model-1")
    await mounted.ready()
    assert.equal(mounted.mutate(), true)
    await mounted.ready()
    assert.equal(mounted.dispatchCount(), 2)
    mounted.settleDispatch()
    await mounted.ready()
    mounted.resolve("model-1")
    await mounted.ready()
    await mounted.switchTarget()
    assert.equal(mounted.queryCount(), 5)
    assert.match(mounted.text(), /Reading/)
    assert.doesNotMatch(mounted.text(), /model-2/)
    mounted.resolve()
    await mounted.ready()
    assert.match(mounted.text(), /model-5/)
    assert.equal(mounted.mutate(), true)
    assert.equal(mounted.mutate(), true)
    await mounted.ready()
    assert.equal(mounted.dispatchCount(), 3)
    mounted.settleDispatch()
    await mounted.ready()
    assert.equal(mounted.queryCount(), 6)
    assert.match(mounted.text(), /model-5/)
    mounted.resolve()
    await mounted.ready()
  } finally {
    mounted.dispose()
  }
})

test("Provider Models rechecks access explicitly and moves focus to the nearest surviving row", async () => {
  const mounted = fixture.mountProviderModels()
  try {
    mounted.resolveRows([
      { modelId: "alpha", checked: false, optInAvailable: true, configured: true, accessState: "verified" },
      { modelId: "beta", checked: false, optInAvailable: true, configured: true, accessState: "pending" },
      { modelId: "gamma", checked: false, optInAvailable: true, configured: true, accessState: "pending" },
    ], { remaining: 2, refused: 0 })
    await mounted.ready()
    assert.match(mounted.text(), /beta.*Access pending/)
    assert.match(mounted.text(), /2 access checks pending/)
    assert.equal(mounted.dispatchCount(), 0)
    const beta = mounted.rowNamed("beta")
    const gamma = mounted.rowNamed("gamma")
    assert.ok(beta)
    assert.ok(gamma)
    beta.dispatch("focus")
    assert.equal(mounted.press("Recheck access"), true)
    await mounted.ready()
    assert.deepEqual(mounted.mutations(), [{
      type: "provider_models.recheck",
      queriedProfileId: "personal",
      queriedEligibilityRevision: 1,
      target: { kind: "singleton", providerId: "openai" },
    }])
    mounted.settleDispatch()
    await mounted.ready()
    mounted.resolveRows([
      { modelId: "alpha", checked: false, optInAvailable: true, configured: true, accessState: "verified" },
      { modelId: "gamma", checked: false, optInAvailable: true, configured: true, accessState: "verified" },
    ], { remaining: 1, refused: 1 })
    await mounted.ready()
    assert.equal(mounted.rowNamed("beta"), undefined)
    assert.equal(mounted.rowNamed("gamma"), gamma)
    assert.equal(gamma.properties.focused, true)
    assert.doesNotMatch(mounted.text(), /Access pending/)
    assert.match(mounted.text(), /1 access check pending/)
    gamma.dispatch("focus")
    await mounted.authRevision()
    mounted.resolveRows([], { remaining: 0, refused: 3 })
    await mounted.ready()
    assert.match(mounted.text(), /No models are currently available for this account/)
    assert.equal(mounted.rowNamed("Recheck access")?.properties.focused, true)
  } finally {
    mounted.dispose()
  }
})

test("Provider Models runs a model tapped during another write after it, with the revision that write left, and shows each tapped row working", async () => {
  const mounted = fixture.mountProviderModels()
  try {
    const rows = (checked: boolean): readonly ProviderModelRow[] => [
      { modelId: "alpha", checked, optInAvailable: true, configured: true },
      { modelId: "beta", checked: false, optInAvailable: true, configured: true },
    ]
    mounted.resolveRows(rows(false))
    await mounted.ready()
    assert.equal(mounted.press("alpha"), true)
    await mounted.ready()
    assert.equal(mounted.press("beta"), true)
    mounted.press("Recheck access")
    await mounted.ready()
    assert.equal(mounted.dispatchCount(), 1)
    assert.equal(mounted.working("alpha"), true)
    assert.equal(mounted.working("beta"), true)
    assert.equal(mounted.working("Recheck access"), true)
    mounted.settleDispatch()
    await mounted.ready()
    mounted.resolveRows(rows(true))
    await mounted.ready()
    assert.equal(mounted.dispatchCount(), 2)
    mounted.settleDispatch()
    await mounted.ready()
    mounted.resolveRows(rows(true))
    await mounted.ready()
    await mounted.ready()
    const target = { kind: "singleton", providerId: "openai" }
    assert.deepEqual(mounted.mutations(), [
      { type: "provider_model.set", queriedProfileId: "personal", queriedEligibilityRevision: 1, target, modelId: "alpha", checked: true },
      { type: "provider_model.set", queriedProfileId: "personal", queriedEligibilityRevision: 2, target, modelId: "beta", checked: true },
      { type: "provider_models.recheck", queriedProfileId: "personal", queriedEligibilityRevision: 3, target },
    ])
    mounted.settleDispatch()
    await mounted.ready()
    mounted.resolveRows(rows(true))
    await mounted.ready()
    assert.equal(mounted.working("beta"), false)
    assert.deepEqual(mounted.reports(), [])
  } finally {
    mounted.dispose()
  }
})

test("Provider Models renders initial failure and retains rows after refresh failure", async () => {
  const initial = fixture.mountProviderModels()
  try {
    initial.reject("offline")
    await initial.ready()
    assert.match(initial.text(), /Could not read the catalog: offline/)
  } finally {
    initial.dispose()
  }

  const refresh = fixture.mountProviderModels()
  try {
    refresh.resolve()
    await refresh.ready()
    await refresh.authRevision()
    refresh.reject("refresh failed")
    await refresh.ready()
    assert.match(refresh.text(), /model-1/)
    assert.match(refresh.reports().at(-1) ?? "", /refresh failed/)
  } finally {
    refresh.dispose()
  }
})

test("Provider Models cancels a queued toggle on navigation or disposal and reports a missing model", async () => {
  for (const boundary of ["navigation", "disposal", "missing", "failure", "superseded"] as const) {
    const mounted = fixture.mountProviderModels()
    try {
      mounted.resolve()
      await mounted.ready()
      await mounted.authRevision()
      mounted.mutate()
      assert.equal(mounted.dispatchCount(), 0)
      if (boundary === "navigation") await mounted.switchTarget()
      if (boundary === "disposal") mounted.dispose()
      if (boundary === "superseded") await mounted.authRevision()
      if (boundary === "failure") mounted.reject("offline")
      else mounted.resolve(boundary === "missing" ? "model-other" : "model-1")
      await mounted.ready()
      assert.equal(mounted.dispatchCount(), 0)
      if (boundary === "missing") assert.match(mounted.reports().at(-1) ?? "", /model-1 is not available/)
      if (boundary === "failure") assert.match(mounted.reports().at(-1) ?? "", /offline/)
      if (boundary === "superseded") {
        mounted.resolve("model-1")
        await mounted.ready()
        assert.deepEqual(mounted.mutations(), [{
          type: "provider_model.set", queriedProfileId: "personal", queriedEligibilityRevision: 3,
          target: { kind: "singleton", providerId: "openai" }, modelId: "model-1", checked: false,
        }])
      }
    } finally {
      mounted.dispose()
    }
  }
})

test("QuestionPanel draft ownership follows toolUseId", async () => {
  const mounted = fixture.mountQuestionOwnership()
  try {
    mounted.type("draft")
    assert.equal(mounted.answerDisabled(), false)
    await mounted.refresh()
    assert.equal(mounted.answerDisabled(), false)
    await mounted.replace("question-b")
    assert.equal(mounted.answerDisabled(), true)
  } finally {
    mounted.dispose()
  }
})

test("the full-size card's phases and agents keep DOM identity across equal replacements", async () => {
  const mounted = fixture.mountWorkflowIdentity()
  try {
    const before = mounted.row()
    const cells = mounted.cells()
    assert.equal(cells.length, 2)
    await mounted.refresh()
    assert.equal(mounted.row(), before)
    assert.equal(mounted.cells()[0], cells[0])
    await mounted.completeCell()
    assert.equal(mounted.cells()[0], cells[0])
    assert.match(String(mounted.cells()[0]?.properties.class), /^workflow-card-agent state-done/)
  } finally {
    mounted.dispose()
  }
})

test("attention ordering moves agent subjects in both directions without reassigning their nodes", async () => {
  const mounted = fixture.mountWorkflowIdentity(true)
  try {
    const [first, second] = mounted.cells()
    assert.ok(first)
    assert.ok(second)
    first.focus()
    await mounted.attention("leaf-2")
    assert.equal(mounted.cells()[0], second)
    assert.equal(mounted.cells()[1], first)
    assert.equal(first.ownerDocument.activeElement, first)
    assert.match(String(second.properties.class), /state-failed/)
    await mounted.attention("leaf")
    assert.equal(mounted.cells()[0], first)
    assert.equal(mounted.cells()[1], second)
    assert.equal(first.ownerDocument.activeElement, first)
    assert.match(String(first.properties.class), /state-failed/)
  } finally { mounted.dispose() }
})

test("toolbar badges keep DOM identity across equal client publishes and update in place", async () => {
  const mounted = fixture.mountToolbarIdentity("development")
  try {
    const before = mounted.row()
    assert.ok(before)
    await mounted.refresh()
    assert.equal(mounted.row(), before)
    await mounted.refresh(4)
    assert.equal(mounted.row(), before)
    assert.equal(before.properties["aria-label"], "4 benches")
  } finally {
    mounted.dispose()
  }
})

/** Remote contributes a Settings row and MCP a status row. */
const sheetModules = { ids: ["remote", "mcp"] as const, views: { mcp: [], remote: EMPTY_REMOTE_VIEW } }

test("provider numeric drafts belong to a profile and survive that profile's reread", async () => {
  const mounted = fixture.mountModuleSheetIdentity("settings", sheetModules)
  try {
    mounted.editProvider()
    await mounted.ready()
    const input = mounted.providerInput()
    assert.ok(input)
    const type = input.properties.onInput
    if (typeof type === "function") type({ currentTarget: { value: "125" } })
    await mounted.refresh()
    mounted.providerValue(200)
    assert.equal(mounted.providerInput(), input)
    assert.equal(input.properties.value, "125")
    assert.equal(input.properties.focused, true)
    const cancel = input.properties.onKeyDown
    if (typeof cancel === "function") cancel({ key: "Escape", preventDefault() {}, stopPropagation() {} })
    assert.deepEqual(mounted.writes(), [{ kind: "set-provider-setting", profileId: "default", setting: { providerId: "copilot", key: "limit", label: "Copilot limit", description: "Usage limit", min: 0, max: 1000, off: 0, value: 200 }, value: 125 }])
    await mounted.ready()
    mounted.editProvider()
    const oldInput = mounted.providerInput()
    assert.ok(oldInput)
    const change = oldInput.properties.onInput
    if (typeof change === "function") change({ currentTarget: { value: "300" } })
    mounted.providerValue(400, "other")
    assert.equal(mounted.providerInput(), undefined)
    const blur = oldInput.properties.onBlur
    if (typeof blur === "function") blur()
    assert.equal(mounted.writes().length, 2, "leaving the profile commits its pending edit once")
    const left = mounted.writes()[1]
    assert.ok(left?.kind === "set-provider-setting")
    assert.equal(left.profileId, "default")
  } finally { mounted.dispose() }
})

test("module settings keep their group, menu row, and typed draft across fresh client publishes", async () => {
  const mounted = fixture.mountModuleSheetIdentity("settings", sheetModules)
  try {
    await mounted.ready()
    const group = mounted.group()
    const menu = mounted.row("Remote access")
    assert.ok(group)
    assert.ok(menu)
    await mounted.edit()
    const input = mounted.input()
    assert.ok(input)
    await mounted.refresh()
    assert.equal(mounted.group(), group)
    assert.equal(mounted.row("Remote access"), menu)
    assert.equal(mounted.input(), input)
    assert.equal(input.properties.value, "1, 3, ")
    await mounted.changeValue()
    assert.equal(mounted.input(), input)
    assert.equal(input.properties.value, "1, 3, ")
    mounted.cancelEdit()
    assert.equal(mounted.field()?.properties["aria-label"], "Steps: 2, 4. Tap to change.")
  } finally {
    mounted.dispose()
  }
})

test("invalid Enter keeps the draft to fix, while leaving restores the saved value with a reason", async () => {
  const mounted = fixture.mountModuleSheetIdentity("settings", sheetModules)
  try {
    for (const finish of ["Escape", "blur", "Tab"] as const) {
      mounted.editProvider()
      await mounted.ready()
      const input = mounted.providerInput()
      assert.ok(input)
      const type = input.properties.onInput
      const handler = input.properties[finish === "blur" ? "onBlur" : "onKeyDown"]
      assert.equal(typeof type, "function")
      assert.equal(typeof handler, "function")
      if (typeof type === "function") type({ currentTarget: { value: "-1" } })
      const key = input.properties.onKeyDown
      if (typeof key === "function") key({ key: "Enter", preventDefault() {}, stopPropagation() {} })
      assert.equal(mounted.providerInput(), input)
      assert.equal(input.properties.value, "-1")
      assert.equal(input.properties["aria-invalid"], true)
      assert.match(mounted.text(), /whole number/)
      if (typeof handler === "function") handler({ key: finish, preventDefault() {}, stopPropagation() {} })
      if (finish === "Tab") {
        const blur = input.properties.onBlur
        if (typeof blur === "function") blur()
      }
      assert.equal(mounted.providerInput(), undefined)
      assert.deepEqual(mounted.writes(), [])
      assert.match(mounted.text(), /whole number/)
      assert.match(String(mounted.providerField()?.properties["aria-label"]), /100/)
    }
    mounted.editProvider()
    await mounted.ready()
    const changed = mounted.providerInput()?.properties.onInput
    if (typeof changed === "function") changed({ currentTarget: { value: "250" } })
  } finally { mounted.dispose() }
  assert.equal(mounted.writes().length, 1)
})

test("module status rows keep DOM identity across equal client publishes", async () => {
  const mounted = fixture.mountModuleSheetIdentity("status", sheetModules)
  try {
    await mounted.ready()
    const row = mounted.row("MCP servers")
    assert.ok(row)
    await mounted.refresh()
    assert.equal(mounted.row("MCP servers"), row)
  } finally {
    mounted.dispose()
  }
})

test("workflow header publications do not read or poll a second transcript", async () => {
  const mounted = fixture.mountWorkflowAgent()
  try {
    await mounted.ready()
    assert.equal(mounted.queries(), 0)
    assert.match(mounted.text(), /Map Run/)
    await mounted.publish()
    assert.equal(mounted.queries(), 0)
    assert.equal(mounted.refreshes(), 0)
    assert.equal(mounted.clocks(), 1)
    assert.match(mounted.text(), /Map Run/)
    await mounted.step()
    assert.equal(mounted.refreshes(), 0)
    await mounted.runRefreshes()
    assert.equal(mounted.queries(), 0)
    assert.match(mounted.text(), /Map Run/)
  } finally {
    mounted.dispose()
  }
})

test("the pane mounts lazily once and keeps its resident state through takeover", async () => {
  const mounted = fixture.mountPersistentPane()
  try {
    assert.equal(mounted.mounts(), 0)
    assert.equal(mounted.resident(), undefined)

    await mounted.activate()
    const resident = mounted.resident()
    assert.ok(resident)
    assert.equal(mounted.mounts(), 1)
    mounted.edit()
    assert.match(mounted.text(), /draft-1/)

    await mounted.takeOver()
    assert.equal(mounted.resident(), resident)
    assert.equal(mounted.inert(), true)
    assert.match(mounted.text(), /draft-1/)
    assert.equal(mounted.mounts(), 1)

    await mounted.activate()
    assert.equal(mounted.resident(), resident)
    assert.match(mounted.text(), /draft-1/)
    assert.equal(mounted.mounts(), 1)
  } finally {
    mounted.dispose()
  }
})

test("session notices keep DOM identity across equal frame replacements", async () => {
  const mounted = fixture.mountNoticeIdentity()
  try {
    const before = mounted.row()
    assert.ok(before)
    await mounted.refresh()
    assert.equal(mounted.row(), before)
  } finally {
    mounted.dispose()
  }
})
