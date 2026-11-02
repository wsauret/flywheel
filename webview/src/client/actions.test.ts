import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createMemo, createRoot } from "solid-js"

import type { FrontendMutation } from "../../../src/protocol/app-service-types.js"
import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import { actionKey, controlActionKey } from "./action-key.js"
import { createClientActions } from "./actions.js"
import { createCommandRoster } from "./command-choices.js"
import type { RuntimeSession } from "./session.js"
import { fakePanelSettings, fakeRuntimeSession } from "../app/client-context-fixture.js"
import { fakeRuntimeConnection } from "./runtime-connection-fixture.js"
import { settingKeys } from "./settings-actions.js"
import { createSurfaceOpener, type CaptureSurfaceOpener } from "../../../src/protocol/client/surface-presentation.js"
import type { CommandOutcome } from "../../../src/protocol/command-catalog-protocol-types.js"
import { createWorkspaceNavigation } from "../app/workspace-navigation.js"

/** The actions layer owns every running action: a person who taps a control
 *  sees that it works until the result arrives, and a second tap joins the
 *  first instead of repeating it. */

function deferred() {
  let resolve!: () => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

/** An idle real session with `members` in place of its own, open on
 *  `chat-1` unless `members` names another. Its session id reads through to
 *  `members`, so a test that moves `members` to another session after the
 *  actions start moves the session. */
function liveSession(members: Partial<RuntimeSession>): RuntimeSession {
  return Object.defineProperty(fakeRuntimeSession(members), "sessionId", { configurable: true, get: () => "sessionId" in members ? members.sessionId : "chat-1" })
}

function actionsFixture(session: Partial<RuntimeSession> = {}, connection: RuntimeConnection = fakeRuntimeConnection(), captureSurfaceOpener: CaptureSurfaceOpener = () => () => {}) {
  const reports: string[] = []
  // A session always holds a roster, here one that has arrived empty. Added
  // in place: tests move the session they pass.
  if (!("commands" in session)) {
    const commands = createCommandRoster()
    commands.accept({ revision: 1, builtInCommands: [], offCommands: [] })
    Object.assign(session, { commands })
  }
  const actions = createClientActions({
    session: liveSession(session),
    connection,
    capabilities: {},
    report: (_severity, message) => reports.push(message),
    captureSurfaceOpener,
  })
  return { actions, reports }
}

const flush = async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve() }

describe("action owner", () => {
  test("delayed command surfaces retain their placement and yield to newer opening intent", async () => {
    for (const scenario of ["matching", "switch", "return", "sheet", "invocation", "global", "global-sheet", "mismatch"] as const) {
      const gate = Promise.withResolvers<CommandOutcome>()
      const opened: string[] = []
      const navigation = createWorkspaceNavigation(() => false)
      const session: Partial<RuntimeSession> = {
        sessionId: "chat-1", navigationVersion: 0,
        invokeCommand: () => gate.promise,
      }
      const captureSurfaceOpener = createSurfaceOpener({
        sessionId: () => session.sessionId, placement: () => session.navigationVersion ?? 0,
        surfaces: () => [navigation.sheet(), navigation.panel()],
        openSurface: (surface) => opened.push(surface),
      })
      const { actions } = actionsFixture(session, fakeRuntimeConnection(), captureSurfaceOpener)
      actions.invokeCommand("first")
      if (scenario === "switch" || scenario === "return" || scenario === "global") Object.assign(session, { sessionId: "chat-2", navigationVersion: 1 })
      if (scenario === "return") Object.assign(session, { sessionId: "chat-1", navigationVersion: 2 })
      if (scenario === "sheet" || scenario === "global-sheet") navigation.open("settings")
      if (scenario === "invocation") actions.invokeCommand("second")
      gate.resolve({ kind: "open", surface: "background", ...(scenario === "global" || scenario === "global-sheet" ? {} : { sessionId: scenario === "mismatch" ? "chat-2" : "chat-1" }) })
      await flush()
      assert.deepEqual(opened, scenario === "matching" || scenario === "global" || scenario === "invocation" ? ["background"] : [])
      actions.dispose()
    }
  })
  test("a repeated call under the same key joins the running work and the key reads working until it settles", async () => {
    const { actions } = actionsFixture()
    const gate = deferred()
    let starts = 0
    const key = actionKey("profile-select", "work")
    const work = () => { starts += 1; return gate.promise }
    const working = createRoot(() => createMemo(() => actions.working(key)))

    assert.equal(working(), false)
    const first = actions.run(key, work)
    const second = actions.run(key, work)
    assert.equal(starts, 1)
    assert.equal(working(), true)
    assert.equal(actions.working(actionKey("profile-select", "home")), false)

    gate.resolve()
    assert.deepEqual(await Promise.all([first, second]), [true, true])
    assert.equal(working(), false)
    // A later call starts the work again, because nothing is running.
    void actions.run(key, async () => { starts += 1 })
    await flush()
    assert.equal(starts, 2)
  })

  test("a failure clears the working state and is reported once to every joined caller", async () => {
    const { actions, reports } = actionsFixture()
    const gate = deferred()
    const key = actionKey("capability", "web")
    const first = actions.run(key, () => gate.promise)
    const second = actions.run(key, () => gate.promise)

    gate.reject(new Error("the runtime refused the change"))
    assert.deepEqual(await Promise.all([first, second]), [false, false])
    assert.equal(actions.working(key), false)
    assert.deepEqual(reports, ["Flywheel could not complete that action: the runtime refused the change"])
  })

  test("a surface's own words for a failure replace the generic report", async () => {
    const { actions, reports } = actionsFixture()
    const said: string[] = []
    const ok = await actions.run(actionKey("mcp.authenticate", "docs"), () => Promise.reject(new Error("token lapsed")), (cause) => said.push(String(cause)))
    assert.equal(ok, false)
    assert.deepEqual(said, ["Error: token lapsed"])
    assert.deepEqual(reports, [])
  })

  test("a session control keys itself by the session it acts on", async () => {
    const gate = deferred()
    const stopped: string[] = []
    const { actions } = actionsFixture({
      stop: (sessionId) => { stopped.push(sessionId); return gate.promise },
      interrupt: () => gate.promise,
    })

    actions.stop("child-1")
    actions.stop("child-1")
    actions.stop("child-2")
    actions.interrupt()
    assert.deepEqual(stopped, ["child-1", "child-2"])
    assert.equal(actions.working(actionKey("stop", "child-1")), true)
    assert.equal(actions.working(actionKey("interrupt", "chat-1")), true)
    gate.resolve()
    await flush()
    assert.equal(actions.working(actionKey("stop", "child-1")), false)
    assert.equal(actions.working(actionKey("interrupt", "chat-1")), false)
  })

  test("workflow controls join only the same target set and expose that scope as working", async () => {
    const gate = deferred()
    const interrupted: (readonly string[] | undefined)[] = []
    const resumed: (readonly string[] | undefined)[] = []
    const { actions } = actionsFixture({
      interrupt: (targets) => { interrupted.push(targets); return gate.promise },
      resume: (targets) => { resumed.push(targets); return gate.promise },
    })
    for (const control of ["interrupt", "resume"] as const) {
      actions[control](["json", "yaml"])
      actions[control](["yaml", "json", "json"])
      actions[control](["json"])
      actions[control]()
      assert.equal(actions.working(controlActionKey(control, "chat-1", ["yaml", "json"])), true)
      assert.equal(actions.working(controlActionKey(control, "chat-1", ["json"])), true)
      assert.equal(actions.working(actionKey(control, "chat-1")), true)
      assert.equal(actions.working(controlActionKey(control, "chat-1", ["other"])), false)
    }
    assert.deepEqual(interrupted, [["json", "yaml"], ["json"], undefined])
    assert.deepEqual(resumed, [["json", "yaml"], ["json"], undefined])
    gate.resolve()
    await flush()
    assert.equal(actions.working(controlActionKey("interrupt", "chat-1", ["json"])), false)
    assert.equal(actions.working(controlActionKey("resume", "chat-1", ["yaml", "json"])), false)
    actions.dispose()
  })

  test("every New chat tap reaches the session, which moves the pane and joins the one creation, and the control works until it ends", async () => {
    const gate = deferred()
    let taps = 0
    // The session answers every tap with the one running creation.
    const { actions, reports } = actionsFixture({ openNew: () => { taps += 1; return gate.promise } })

    for (let tap = 0; tap < 5; tap += 1) actions.newSession()
    assert.equal(taps, 5)
    assert.equal(actions.working(actionKey("new-chat")), true)
    gate.reject(new Error("the runtime refused"))
    await flush()
    assert.equal(actions.working(actionKey("new-chat")), false)
    assert.deepEqual(reports, ["Flywheel could not complete that action: the runtime refused"])
  })

  test("Reconnect works until the connection answers again", async () => {
    const listeners = new Set<(state: RuntimeConnection["state"]) => void>()
    let wakes = 0
    const { actions } = actionsFixture({}, fakeRuntimeConnection({}, {
      state: "connected",
      onStateChange: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
      reconnect: () => { wakes += 1 },
    }))
    const publish = (state: RuntimeConnection["state"]) => { for (const listener of listeners) listener(state) }

    actions.reconnect()
    actions.reconnect()
    assert.equal(wakes, 1)
    assert.equal(actions.working(actionKey("reconnect")), true)
    publish("recovering")
    assert.equal(actions.working(actionKey("reconnect")), true)
    publish("connected")
    await flush()
    assert.equal(actions.working(actionKey("reconnect")), false)
    assert.equal(listeners.size, 0)
  })

  test("a working reader wakes only when its own key starts or ends", async () => {
    const { actions } = actionsFixture()
    const gate = deferred()
    let reads = 0
    const working = createRoot(() => createMemo(() => { reads += 1; return actions.working(actionKey("compact", "chat-1")) }))
    assert.equal(working(), false)
    void actions.run(actionKey("stop", "child-1"), () => gate.promise)
    gate.resolve()
    await flush()
    assert.equal(reads, 1)
  })

  test("a direct set of another value runs after the running write, so the latest choice lands last", async () => {
    const writes: number[] = []
    const gates: (() => void)[] = []
    // The runtime refuses a write whose expected value is stale, so each
    // write must read the value the one before it left.
    let threshold = 50_000
    const { actions } = actionsFixture({
      get settings() { return fakePanelSettings({ compactionThreshold: threshold }) },
      refreshSettings: async () => { threshold = writes.at(-1) ?? threshold },
    }, fakeRuntimeConnection({
      onDispatch: async (mutation) => {
        if (mutation.type !== "config.mutate" || mutation.setting.id !== "proactiveCompactionThreshold") throw new Error("unexpected write")
        assert.deepEqual(mutation.setting.expected, { kind: "value", value: threshold })
        writes.push(Number(mutation.setting.desired))
        await new Promise<void>((resolve) => { gates.push(resolve) })
      },
      mutations: { "config.mutate": () => ({ kind: "committed", revision: writes.length }) },
    }))
    const set = (tokens: number) => ({ kind: "set-compaction-threshold", tokens }) as const

    void actions.applySetting(set(60_000))
    void actions.applySetting(set(70_000))
    // The value already running is chosen again after another one: it is
    // the latest choice, so it runs again last instead of joining.
    void actions.applySetting(set(60_000))
    // A repeat of the newest choice joins it.
    void actions.applySetting(set(60_000))
    await flush()
    assert.deepEqual(writes, [60_000])
    assert.equal(actions.working(settingKeys(set(70_000)).write), true)
    assert.equal(actions.working(settingKeys(set(80_000)).write), false)
    assert.equal(actions.working(settingKeys(set(80_000)).row), true)
    for (let index = 0; index < 3; index += 1) {
      gates.shift()?.()
      await flush()
    }
    assert.deepEqual(writes, [60_000, 70_000, 60_000])
    assert.equal(threshold, 60_000)
    assert.equal(actions.working(settingKeys(set(80_000)).row), false)
  })

  test("a toggle repeated while it runs joins it", async () => {
    const gate = deferred()
    const dispatched: FrontendMutation[] = []
    const { actions } = actionsFixture({
      settings: fakePanelSettings({ persistentProcesses: { persisted: false, effective: false, forcedByCli: false } }),
      refreshSettings: async () => {},
    }, fakeRuntimeConnection({
      onDispatch: async (mutation) => { dispatched.push(mutation); await gate.promise },
      mutations: { "settings.set_persistent_processes": () => ({ ok: true }) },
    }))
    void actions.applySetting({ kind: "toggle-persistent-processes" })
    void actions.applySetting({ kind: "toggle-persistent-processes" })
    await flush()
    assert.equal(dispatched.length, 1)
    gate.resolve()
    await flush()
  })

  test("a command and a notice dismissal act on the session they were tapped in", async () => {
    const gate = deferred()
    const invoked: string[] = []
    const dismissed: string[] = []
    const session: Partial<RuntimeSession> = { sessionId: "chat-1" }
    const { actions } = actionsFixture(Object.assign(session, {
      invokeCommand: async (sessionId: string, name: string) => { invoked.push(`${sessionId}:${name}`); await gate.promise; return undefined },
      dismissNotice: async (sessionId: string, scope: string) => { dismissed.push(`${sessionId}:${scope}`); await gate.promise },
    }))
    actions.invokeCommand("review")
    actions.dismissNotice("budget")
    Object.assign(session, { sessionId: "chat-2" })
    actions.invokeCommand("review")
    actions.dismissNotice("budget")
    await flush()
    assert.deepEqual(invoked, ["chat-1:review", "chat-2:review"])
    assert.deepEqual(dismissed, ["chat-1:budget", "chat-2:budget"])
    assert.equal(actions.working(actionKey("command", "chat-2", "review")), true)
    assert.equal(actions.working(actionKey("dismiss-notice", "chat-1", "budget")), true)
    gate.resolve()
    await flush()
    assert.equal(actions.working(actionKey("command", "chat-1", "review")), false)
  })

  test("a command whose descriptor publishes its surface opens it at once, with no chat and no runtime call", async () => {
    const opened: string[] = []
    const asked: string[] = []
    const commands = createCommandRoster()
    commands.accept({ revision: 3, offCommands: [], builtInCommands: [{ id: "remote", title: "Remote access", description: "Pair a phone", aliases: ["pair"], opens: "remote" }] })
    const session: Partial<RuntimeSession> = {
      sessionId: undefined,
      commands,
      newChat: async () => { asked.push("newChat"); throw new Error("An error occurred during Write: the channel closed") },
      invokeCommand: async () => { asked.push("invoke"); throw new Error("An error occurred during Write: the channel closed") },
    }
    const { actions, reports } = actionsFixture(session, fakeRuntimeConnection(), () => (surface) => { opened.push(surface) })
    actions.invokeCommand("pair")
    await flush()
    assert.deepEqual(opened, ["remote"])
    assert.deepEqual(asked, [])
    assert.deepEqual(reports, [])
  })

  test("a host command that arrives before the catalog waits for it, then opens its surface at its target", async () => {
    const opened: unknown[] = []
    const asked: string[] = []
    const commands = createCommandRoster()
    const session: Partial<RuntimeSession> = {
      sessionId: "chat-1",
      commands,
      invokeCommand: async () => { asked.push("invoke"); return { kind: "none" } },
    }
    const { actions } = actionsFixture(session, fakeRuntimeConnection(), () => (surface, _sessionId, opening) => { opened.push([surface, opening]) })
    actions.invokeCommand("auth")
    await flush()
    assert.deepEqual([opened, asked], [[], []])
    commands.accept({ revision: 1, offCommands: [], builtInCommands: [{ id: "auth", title: "Authentication", description: "Sign in", aliases: ["login"], opens: "settings", target: { kind: "place", place: "authentication" } }] })
    await flush()
    assert.deepEqual(opened, [["settings", { target: { kind: "place", place: "authentication" } }]])
    assert.deepEqual(asked, [])
  })

  test("a command with no chat open works under the new chat until the runtime creates it, then under the chat it runs in, where a repeat joins it", async () => {
    const created = Promise.withResolvers<string>()
    const gate = deferred()
    const invoked: string[] = []
    const session: Partial<RuntimeSession> = { sessionId: undefined }
    const { actions } = actionsFixture(Object.assign(session, {
      newChat: () => created.promise,
      invokeCommand: async (sessionId: string, name: string) => { invoked.push(`${sessionId}:${name}`); await gate.promise; return undefined },
    }))
    actions.invokeCommand("review")
    actions.invokeCommand("review")
    assert.equal(actions.commandWorking(undefined, "review"), true)
    // The pane moves to the created chat in the same step that answers its id.
    Object.assign(session, { sessionId: "created" })
    created.resolve("created")
    await flush()
    assert.equal(actions.commandWorking("created", "review"), true)
    assert.equal(actions.commandWorking("other", "review"), false)
    // The key of no session covers only the wait for the chat, so a tap on a
    // later New chat starts the command there.
    assert.equal(actions.commandWorking(undefined, "review"), false)
    actions.invokeCommand("review")
    await flush()
    assert.deepEqual(invoked, ["created:review"])
    gate.resolve()
    await flush()
    assert.equal(actions.commandWorking("created", "review"), false)
    assert.equal(actions.commandWorking(undefined, "review"), false)
  })

  test("a notice shown while no session is selected still dismisses", async () => {
    const dismissed: string[] = []
    const { actions } = actionsFixture({
      sessionId: undefined,
      dismissNotice: async (sessionId: string | undefined, scope: string) => { dismissed.push(`${sessionId ?? "none"}:${scope}`) },
    })
    actions.dismissNotice("client.pane-move")
    await flush()
    assert.deepEqual(dismissed, ["none:client.pane-move"])
  })

  test("a queued-message recall works until it answers, and a repeat joins", async () => {
    const recall = deferred()
    let recalls = 0
    const { actions } = actionsFixture({
      recallQueued: async () => { recalls += 1; await recall.promise; return "queued words" },
    })
    const recalled = [actions.recallQueued(), actions.recallQueued()]
    assert.equal(recalls, 1)
    assert.equal(actions.working(actionKey("recall-queued", "chat-1")), true)
    recall.resolve()
    assert.deepEqual(await Promise.all(recalled), ["queued words", "queued words"])
    assert.equal(actions.working(actionKey("recall-queued", "chat-1")), false)
  })

  test("a write in order waits for the running writes of its queue, and a failure does not stop the next", async () => {
    const { actions, reports } = actionsFixture()
    const first = deferred()
    const order: string[] = []
    const queue = actionKey("provider-models", "account")
    const one = actions.runInOrder(queue, actionKey("provider-model", "account", "a"), async () => { order.push("a"); await first.promise })
    const two = actions.runInOrder(queue, actionKey("provider-model", "account", "b"), async () => { order.push("b") })
    await flush()
    assert.deepEqual(order, ["a"])
    assert.equal(actions.working(queue), true)
    first.reject(new Error("stale"))
    assert.deepEqual(await Promise.all([one, two]), [false, true])
    assert.deepEqual(order, ["a", "b"])
    assert.deepEqual(reports, ["Flywheel could not complete that action: stale"])
  })

  test("a setting change before the settings are read says why and reads them, instead of doing nothing", async () => {
    let refreshes = 0
    const { actions, reports } = actionsFixture({ settings: undefined, refreshSettings: async () => { refreshes += 1 } })
    const outcome = await actions.applySetting({ kind: "set-workflow-mode", mode: "on" })
    const message = "Flywheel did not change that setting: it has not read the settings yet. Try again in a moment."
    assert.deepEqual(outcome, { kind: "notice", severity: "warning", message })
    assert.deepEqual(reports, [message])
    assert.equal(refreshes, 1)
  })

  test("Close, Delete, Rename, and Stop read working on the session they act on, whichever surface started them", async () => {
    const gate = deferred()
    const { actions } = actionsFixture({ remove: () => gate.promise, rename: () => gate.promise })
    const working = createRoot(() => createMemo(() => actions.sessionWorking("chat-1")))
    assert.equal(working(), false)
    actions.removeSession("chat-1")
    assert.equal(working(), true)
    assert.equal(actions.sessionWorking("chat-2"), false)
    gate.resolve()
    await flush()
    assert.equal(working(), false)
  })

  test("disposed actions wake no reader again", async () => {
    const gate = deferred()
    const { actions } = actionsFixture({ compact: () => gate.promise })
    const working = createRoot(() => createMemo(() => actions.working(actionKey("compact", "chat-1"))))
    actions.dispose()
    actions.compact()
    assert.equal(working(), false)
    gate.resolve()
    await flush()
  })
})
