import assert from "node:assert/strict"
import { test } from "node:test"

import type { FrontendMutation, FrontendOutputBlock } from "../../../src/protocol/app-service-types.js"
import { createRuntimeSession } from "./session.js"
import { settle } from "./session-connection-fixture.js"
import { createSessionNavigation, type SessionNavigationDeps } from "./session-navigation.js"
import { navigationConnection, type TailRead } from "./session-navigation-fixture.js"
import { createViewProjection } from "./view-state.js"
import { RuntimeLaneLost } from "../../../src/protocol/client/connection-failures.js"

/** A tap that leaves the open session moves to its destination at once, and
 *  the destination shows that it is opening until its content can show. */

/** The session activations and releases the page dispatched, in order. */
const claims = (dispatched: readonly FrontendMutation[]) => dispatched
  .filter((command) => command.type === "session.activate" || command.type === "session.release")
  .map(({ type, sessionId }) => `${type} ${sessionId}`)

type Send = Extract<FrontendMutation, { type: "session.send" }>
/** The words of a dispatched message, whichever input shape carries them. */
const sentText = (command: Send) => typeof command.input === "string" ? command.input : command.input.text

test("a tap on a child moves the selection at once and names the destination and its parent until its detail arrives", async () => {
  const gate = Promise.withResolvers<"row">()
  const runtime = navigationConnection({ detail: () => gate.promise })
  const session = createRuntimeSession({ connection: runtime.connection })
  const project = createViewProjection()
  try {
    await settle()
    const opening = session.select("child", { label: "Review agent", parentSessionId: "chat" })
    assert.equal(session.sessionId, "child")
    const frame = project(session)
    assert.deepEqual(frame.opening, {})
    assert.equal(frame.destinationName, "Review agent")
    // Back to the parent shows while the child loads: the tap knew it.
    assert.equal(frame.parentSessionId, "chat")
    gate.resolve("row")
    await opening
    assert.equal(session.opening, undefined)
    assert.equal(project(session).sessionId, "child")
  } finally { gate.resolve("row"); session.dispose() }
})

test("a child that cannot open says why in its pane, and the same tap tries again", async () => {
  let answers: ("fail" | "missing" | "row")[] = ["fail"]
  const runtime = navigationConnection({ async detail() {
    const next = answers.shift() ?? "row"
    if (next === "fail") throw new Error("the read timed out")
    return next
  } })
  const session = createRuntimeSession({ connection: runtime.connection })
  const project = createViewProjection()
  try {
    await settle()
    await session.select("child", { label: "Review agent" })
    assert.equal(session.sessionId, "child")
    assert.deepEqual(project(session).opening, { failure: "Flywheel could not open this session: the read timed out" })

    answers = ["missing"]
    await session.select("child", { label: "Review agent" })
    assert.deepEqual(project(session).opening, { failure: "Flywheel could not find this session." })

    answers = ["row"]
    await session.select("child", { label: "Review agent" })
    await settle()
    assert.equal(session.opening, undefined)
    assert.equal(session.sessionId, "child")
  } finally { session.dispose() }
})

test("a message sent into a child that is still opening waits for its detail and then reaches it", async () => {
  const gate = Promise.withResolvers<"row">()
  const runtime = navigationConnection({ detail: () => gate.promise })
  const session = createRuntimeSession({ connection: runtime.connection })
  try {
    await settle()
    void session.select("child", { label: "Review agent" })
    const sending = session.send("focus on tests")
    gate.resolve("row")
    await sending
    const [entry] = session.localSubmissions
    assert.notEqual(entry?.delivery.kind, "failed")
    assert.deepEqual(runtime.dispatched.filter((command) => command.type === "session.send"), [
      { type: "session.send", sessionId: "child", input: { text: "focus on tests", submissionIds: [entry?.id] } },
    ])
  } finally { gate.resolve("row"); session.dispose() }
})

test("a message the runtime took while the person was in another chat and the lane broke is not queued when they come back", async () => {
  let tail: TailRead = { blocks: [], hasBefore: false }
  const runtime = navigationConnection({ rows: ["chat", "other"], tail: (sessionId) => sessionId === "chat" ? tail : { blocks: [], hasBefore: false } })
  const session = createRuntimeSession({ connection: runtime.connection })
  try {
    await settle()
    await session.select("chat")
    await session.send("also update docs")
    assert.equal(session.localSubmissions.length, 1, "an accepted dispatch alone does not prove the transcript holds the message")
    await session.select("other")
    // The agent took the message and wrote a whole tail window after it
    // while the lane was down, so the page heard none of it.
    const later = Date.now() + 1_000
    tail = { blocks: [{ kind: "text", id: "work", content: "Done", timestamp: later }], hasBefore: true }
    runtime.reattach()
    await settle()
    await session.select("chat")
    await settle()
    assert.deepEqual(session.transcript?.view.blocks.map((block) => block.kind), ["text"])
    assert.deepEqual(session.localSubmissions, [])
  } finally { session.dispose() }
})

test("a reloaded child address opens the child, serves its root chat, and names the parent Back returns to", async () => {
  const runtime = navigationConnection({})
  const session = createRuntimeSession({ connection: runtime.connection, initialSessionId: "child" })
  const project = createViewProjection()
  try {
    await settle()
    await settle()
    assert.equal(session.sessionId, "child")
    assert.equal(session.opening, undefined)
    assert.equal(project(session).parentSessionId, "chat")
    assert.deepEqual(claims(runtime.dispatched), ["session.activate chat"])
  } finally { session.dispose() }
})

test("a reloaded child address stays on the child when the executor's invalidation arrives during its detail read", async () => {
  const gate = Promise.withResolvers<"row">()
  const runtime = navigationConnection({ detail: () => gate.promise })
  const session = createRuntimeSession({ connection: runtime.connection, initialSessionId: "child" })
  try {
    await settle()
    // A cold project attaches its executor after the page's first reads, and
    // the runtime's invalidation then reads every held detail again.
    runtime.invalidate()
    await settle()
    gate.resolve("row")
    await settle()
    await settle()
    assert.equal(session.sessionId, "child")
    assert.equal(session.opening, undefined)
    assert.deepEqual(claims(runtime.dispatched), ["session.activate chat"])
  } finally { gate.resolve("row"); session.dispose() }
})

test("a reloaded child address that cannot open says why in its pane instead of opening another session", async () => {
  let answers: ("fail" | "missing" | "row")[] = ["fail"]
  const runtime = navigationConnection({ async detail() {
    const next = answers.shift() ?? "row"
    if (next === "fail") throw new Error("the read timed out")
    return next
  } })
  const session = createRuntimeSession({ connection: runtime.connection, initialSessionId: "child" })
  const project = createViewProjection()
  try {
    await settle()
    await settle()
    assert.equal(session.sessionId, "child")
    assert.deepEqual(project(session).opening, { failure: "Flywheel could not open this session: the read timed out" })
    assert.deepEqual(claims(runtime.dispatched), [])

    answers = ["row"]
    await session.select("child")
    await settle()
    assert.equal(session.opening, undefined)
    assert.equal(session.sessionId, "child")
    assert.deepEqual(claims(runtime.dispatched), ["session.activate chat"])
  } finally { session.dispose() }
})

test("a reloaded address the runtime no longer has opens the default chat and says so", async () => {
  const runtime = navigationConnection({ detail: async () => "missing" })
  const session = createRuntimeSession({ connection: runtime.connection, initialSessionId: "child" })
  try {
    await settle()
    await settle()
    assert.equal(session.sessionId, "chat")
    assert.equal(session.opening, undefined)
    assert.deepEqual(session.notices.map(({ title, message }) => ({ title, message })), [
      { title: "Session not found", message: "Flywheel could not find that session, so it opened another chat." },
    ])
  } finally { session.dispose() }
})

test("a chat another client deletes moves the pane to the next chat and says so until dismissed", async () => {
  const runtime = navigationConnection({ rows: ["chat", "second"] })
  const session = createRuntimeSession({ connection: runtime.connection })
  try {
    await settle()
    assert.equal(session.sessionId, "chat")
    runtime.deletedElsewhere("chat")
    await settle()
    assert.equal(session.sessionId, "second")
    assert.deepEqual(session.notices.map(({ title, message }) => ({ title, message })), [
      { title: "Session deleted", message: "The session you had open was deleted, so Flywheel opened another chat." },
    ])
    const [notice] = session.notices
    await session.dismissNotice("second", notice?.scope ?? "")
    assert.deepEqual(session.notices, [])
    assert.equal(runtime.dispatched.some((command) => command.type === "session.dismiss_notice"), false)
  } finally { session.dispose() }
})

test("the last chat another client deletes leaves the pane on a new chat and says that no other chat remains", async () => {
  const runtime = navigationConnection({})
  const session = createRuntimeSession({ connection: runtime.connection })
  try {
    await settle()
    assert.equal(session.sessionId, "chat")
    runtime.deletedElsewhere("chat")
    await settle()
    assert.equal(session.sessionId, undefined)
    assert.deepEqual(session.notices.map(({ message }) => message), ["The session you had open was deleted, and this project has no other chat."])
  } finally { session.dispose() }
})

test("a reloaded address the runtime no longer has, in a project with no chat, says that no other chat exists", async () => {
  const runtime = navigationConnection({ rows: [], detail: async () => "missing" })
  const session = createRuntimeSession({ connection: runtime.connection, initialSessionId: "child" })
  try {
    await settle()
    await settle()
    assert.equal(session.sessionId, undefined)
    assert.deepEqual(session.notices.map(({ message }) => message), ["Flywheel could not find that session, and this project has no other chat."])
  } finally { session.dispose() }
})

test("a chat whose catalog metadata cannot be read stays open, because a catalog error is not a delete", async () => {
  const runtime = navigationConnection({ rows: ["chat", "second"] })
  const session = createRuntimeSession({ connection: runtime.connection })
  try {
    await settle()
    assert.equal(session.sessionId, "chat")
    runtime.metadataFails("chat")
    runtime.invalidate()
    await settle()
    assert.deepEqual(session.sessionErrors.map(({ sessionId }) => sessionId), ["chat"])
    assert.equal(session.sessionId, "chat")
    assert.deepEqual(session.notices, [])
  } finally { session.dispose() }
})

test("a chat whose detail never read still leaves the pane when another client deletes it", async () => {
  const runtime = navigationConnection({ rows: ["chat", "second"], unreadable: ["chat"] })
  const session = createRuntimeSession({ connection: runtime.connection })
  try {
    await settle()
    assert.equal(session.sessionId, "chat")
    runtime.deletedElsewhere("chat")
    await settle()
    assert.equal(session.sessionId, "second")
    assert.deepEqual(session.notices.map(({ message }) => message), ["The session you had open was deleted, so Flywheel opened another chat."])
  } finally { session.dispose() }
})

test("a child another client deletes returns the pane to its parent, which stays served, and says so", async () => {
  const runtime = navigationConnection({})
  const session = createRuntimeSession({ connection: runtime.connection })
  try {
    await settle()
    await session.select("child", { label: "Review agent", parentSessionId: "chat" })
    await settle()
    assert.equal(session.sessionId, "child")
    runtime.deletedElsewhere("child")
    await settle()
    assert.equal(session.sessionId, "chat")
    assert.deepEqual(session.notices.map(({ message }) => message), ["The session you had open was deleted, so Flywheel opened its parent."])
    assert.deepEqual(claims(runtime.dispatched), ["session.activate chat"])
  } finally { session.dispose() }
})

test("a delete made here moves the pane without a notice, even when the runtime's removal arrives first", async () => {
  const gate = Promise.withResolvers<void>()
  const runtime = navigationConnection({ rows: ["chat", "second"], remove: () => gate.promise })
  const session = createRuntimeSession({ connection: runtime.connection })
  try {
    await settle()
    const removing = session.remove("chat")
    runtime.deletedElsewhere("chat")
    gate.resolve()
    await removing
    assert.equal(session.sessionId, "second")
    assert.deepEqual(session.notices, [])
  } finally { gate.resolve(); session.dispose() }
})

test("Close chat on an empty chat in view moves the pane to the next chat without a notice", async () => {
  const runtime = navigationConnection({ rows: ["chat", "second"] })
  const session = createRuntimeSession({ connection: runtime.connection })
  try {
    await settle()
    await session.close("chat")
    await settle()
    assert.equal(session.sessionId, "second")
    assert.deepEqual(session.notices, [])
  } finally { session.dispose() }
})

test("New chat opens a pending destination at once and the created chat shows its intro under the New chat name", async () => {
  const gate = Promise.withResolvers<void>()
  const listed = Promise.withResolvers<void>()
  const runtime = navigationConnection({ open: () => gate.promise, created: () => listed.promise })
  const session = createRuntimeSession({ connection: runtime.connection })
  const project = createViewProjection()
  try {
    await settle()
    assert.equal(session.sessionId, "chat")
    const opening = session.openNew()
    assert.equal(session.sessionId, undefined)
    assert.deepEqual(project(session).opening, {})
    assert.equal(project(session).destinationName, "New chat")
    // The catalog moving while the chat is created does not open another one.
    runtime.publishCatalog()
    assert.equal(session.sessionId, undefined)

    gate.resolve()
    await opening
    assert.equal(session.sessionId, "new-1")
    // The created chat is empty, so it shows its intro without a read, and
    // it keeps the New chat name until its catalog row names it.
    const created = project(session)
    assert.equal(session.transcript?.status, "ready")
    assert.equal(created.opening, undefined)
    assert.equal(created.destinationName, "New chat")

    listed.resolve()
    await settle()
    assert.equal(project(session).destinationName, "Named chat")
  } finally { gate.resolve(); listed.resolve(); session.dispose() }
})

test("a New chat tap after leaving a pending New chat moves back to it, and the one creation settles there", async () => {
  const gate = Promise.withResolvers<void>()
  const runtime = navigationConnection({ open: () => gate.promise })
  const session = createRuntimeSession({ connection: runtime.connection })
  const project = createViewProjection()
  try {
    await settle()
    const first = session.openNew()
    await session.select("chat")
    assert.equal(session.sessionId, "chat")
    const second = session.openNew()
    assert.equal(session.sessionId, undefined)
    assert.equal(project(session).destinationName, "New chat")

    gate.resolve()
    await Promise.all([first, second])
    assert.deepEqual(runtime.opened, ["new-1"])
    assert.equal(session.sessionId, "new-1")
  } finally { gate.resolve(); session.dispose() }
})

test("a New chat that fails says so in its pane, and a tap elsewhere leaves it", async () => {
  const runtime = navigationConnection({ open: () => Promise.reject(new Error("the runtime refused")) })
  const session = createRuntimeSession({ connection: runtime.connection })
  const project = createViewProjection()
  try {
    await settle()
    await session.openNew()
    assert.deepEqual(project(session).opening, { failure: "Flywheel could not start a new chat: the runtime refused" })
    assert.equal(project(session).destinationName, "New chat")
    await session.select("chat")
    assert.equal(project(session).opening?.failure, undefined)
    assert.equal(session.sessionId, "chat")
  } finally { session.dispose() }
})

// The open names its chat, so the open that goes out again on the next lane
// opens the chat the lost one may have opened, never a second one.
test("a New chat lost with its lane opens its one chat once the next lane opens, and shows no failure", async () => {
  let attempts = 0
  const runtime = navigationConnection({ open: async () => { if (++attempts === 1) throw new RuntimeLaneLost(new Error("the lane the call ran on ended")) } })
  const session = createRuntimeSession({ connection: runtime.connection })
  const project = createViewProjection()
  try {
    await settle()
    const opened = session.openNew()
    await settle()
    assert.deepEqual(project(session).opening, {})
    runtime.reattach()
    await opened
    await settle()
    assert.equal(session.sessionId, "new-1")
    assert.equal(project(session).opening?.failure, undefined)
    const opens = runtime.dispatched.filter((command) => command.type === "chat.open")
    assert.equal(opens.length, 2)
    assert.match(opens[0]?.sessionId ?? "", /^[0-9a-f]{12}$/)
    assert.equal(opens[1]?.sessionId, opens[0]?.sessionId)
  } finally { session.dispose() }
})

test("a first message whose new chat is lost with its lane stays queued and lands in that chat once the next lane opens", async () => {
  let attempts = 0
  const runtime = navigationConnection({ rows: [], open: async () => { if (++attempts === 1) throw new RuntimeLaneLost(new Error("the lane the call ran on ended")) } })
  const session = createRuntimeSession({ connection: runtime.connection })
  const project = createViewProjection()
  try {
    await settle()
    const sent = session.send("hello")
    await settle()
    assert.deepEqual(project(session).localSubmissions.map((entry) => entry.delivery.kind), ["sending"])
    runtime.reattach()
    await sent
    await settle()
    assert.equal(session.sessionId, "new-1")
    assert.deepEqual(runtime.dispatched.filter((command) => command.type === "session.send").map((command) => [command.sessionId, sentText(command)]), [["new-1", "hello"]])
  } finally { session.dispose() }
})

test("a message sent while a New chat is created lands in the created chat, even after a move elsewhere", async () => {
  const gate = Promise.withResolvers<void>()
  const runtime = navigationConnection({ open: () => gate.promise })
  const session = createRuntimeSession({ connection: runtime.connection })
  try {
    await settle()
    void session.openNew()
    const sending = session.send("hello")
    await session.select("chat")
    gate.resolve()
    await sending
    assert.deepEqual(runtime.dispatched.filter((command) => command.type === "session.send").map((command) => command.sessionId), ["new-1"])
  } finally { gate.resolve(); session.dispose() }
})

test("a slash command while a New chat is created joins that creation", async () => {
  const gate = Promise.withResolvers<void>()
  const runtime = navigationConnection({ open: () => gate.promise })
  const session = createRuntimeSession({ connection: runtime.connection })
  try {
    await settle()
    void session.openNew()
    const invoking = session.newChat().then((created) => session.invokeCommand(created, "review"))
    gate.resolve()
    await invoking
    assert.deepEqual(runtime.opened, ["new-1"])
    assert.deepEqual(runtime.dispatched.filter((command) => command.type === "command.invoke").map((command) => command.sessionId), ["new-1"])
  } finally { gate.resolve(); session.dispose() }
})

test("a first message with no chat open shows at once in a pending New chat and moves to the created chat", async () => {
  const gate = Promise.withResolvers<void>()
  const runtime = navigationConnection({ rows: [], open: () => gate.promise })
  const session = createRuntimeSession({ connection: runtime.connection })
  const project = createViewProjection()
  try {
    await settle()
    assert.equal(session.sessionId, undefined)
    const sending = session.send("hello")
    const pending = project(session)
    assert.deepEqual(pending.localSubmissions.map((entry) => entry.input.text), ["hello"])
    assert.equal(pending.destinationName, "New chat")
    // The words are the new chat's whole content, so they show, not a loading screen.
    assert.equal(pending.opening, undefined)

    gate.resolve()
    await sending
    const [entry] = session.localSubmissions
    assert.equal(session.sessionId, "new-1")
    assert.equal(entry?.input.text, "hello")
    assert.deepEqual(runtime.dispatched.map((command) => ({ type: command.type, sessionId: command.type === "chat.open" ? "named" : "sessionId" in command ? command.sessionId : undefined })), [
      { type: "chat.open", sessionId: "named" },
      { type: "session.activate", sessionId: "new-1" },
      { type: "session.send", sessionId: "new-1" },
    ])
    const sent = runtime.dispatched.at(-1)
    if (sent?.type !== "session.send") assert.fail("the last dispatch is not the message")
    assert.deepEqual(typeof sent.input === "string" ? undefined : sent.input.submissionIds, [entry?.id])
  } finally { gate.resolve(); session.dispose() }
})

test("two messages sent before the new chat exists both land in the one chat it creates", async () => {
  const gate = Promise.withResolvers<void>()
  const runtime = navigationConnection({ rows: [], open: () => gate.promise })
  const session = createRuntimeSession({ connection: runtime.connection })
  try {
    await settle()
    const first = session.send("one")
    const second = session.send("two")
    gate.resolve()
    await Promise.all([first, second])
    assert.deepEqual(runtime.opened, ["new-1"])
    assert.equal(session.sessionId, "new-1")
    assert.deepEqual(runtime.dispatched.filter((command) => command.type === "session.send").map((command) => `${command.sessionId} ${sentText(command)}`), ["new-1 one", "new-1 two"])
  } finally { gate.resolve(); session.dispose() }
})

test("a message typed into the chat New chat just created goes out before its detail answers", async () => {
  const detail = Promise.withResolvers<void>()
  const runtime = navigationConnection({ rows: [], created: () => detail.promise })
  const session = createRuntimeSession({ connection: runtime.connection })
  try {
    await settle()
    await session.newChat()
    assert.equal(session.sessionId, "new-1")
    const sending = session.send("hi")
    await settle()
    assert.deepEqual(runtime.dispatched.filter((command) => command.type === "session.send").map((command) => command.sessionId), ["new-1"])
    detail.resolve()
    await sending
  } finally { detail.resolve(); session.dispose() }
})

test("a first message whose new chat fails stays in view, says why, and can be taken back", async () => {
  const runtime = navigationConnection({ rows: [], open: () => Promise.reject(new Error("the runtime refused")) })
  const session = createRuntimeSession({ connection: runtime.connection })
  const project = createViewProjection()
  try {
    await settle()
    await assert.rejects(session.send("hello"), /could not start a new chat: the runtime refused/)
    const frame = project(session)
    assert.equal(frame.opening, undefined)
    assert.deepEqual(frame.localSubmissions.map((entry) => entry.delivery), [{ kind: "failed", error: "Flywheel could not start a new chat: the runtime refused" }])
    assert.deepEqual(session.recallLocal(), { kind: "input", input: { text: "hello" } })
  } finally { session.dispose() }
})

test("a delete the runtime refuses says why and leaves the pane and the session's detail alone", async () => {
  const runtime = navigationConnection({ remove: async () => ({ ok: false, error: "the session is still running" }) })
  const session = createRuntimeSession({ connection: runtime.connection })
  try {
    await settle()
    await session.select("child", { label: "Review agent", parentSessionId: "chat" })
    await assert.rejects(session.remove("child"), /the session is still running/)
    assert.equal(session.sessionId, "child")
    assert.deepEqual(session.children.map(({ id }) => id), ["child"])
  } finally { session.dispose() }
})

test("Delete moves away only when the deleted session is still the one shown", async () => {
  const gate = Promise.withResolvers<void>()
  const runtime = navigationConnection({ rows: ["chat", "second", "third"], remove: () => gate.promise })
  const session = createRuntimeSession({ connection: runtime.connection })
  try {
    await settle()
    assert.equal(session.sessionId, "chat")
    const removing = session.remove("chat")
    await session.select("third")
    gate.resolve()
    await removing
    assert.equal(session.sessionId, "third")
  } finally { gate.resolve(); session.dispose() }
})

/** Navigation over scripted deps, for the moves the session cannot reach fast. */
function navigationOver(overrides: Partial<SessionNavigationDeps>) {
  let selected: string | undefined = "chat"
  const shown: (string | undefined)[] = []
  const navigation = createSessionNavigation({
    show: (next) => { shown.push(next); selected = next; navigation.moved(next) },
    selected: () => selected,
    isListed: () => true,
    isHeld: () => true,
    hold: async () => ({ kind: "held" }),
    createChat: async () => "new-1",
    refreshCatalog: async () => {},
    transcript: () => undefined,
    fallback: () => undefined,
    emit: () => {},
    disposed: () => false,
    ...overrides,
  })
  return { navigation, shown }
}

/** A shown session's transcript whose first read failed, over `blocks`. */
const failedRead = (blocks: readonly FrontendOutputBlock[]) => ({
  status: "recovery-failed" as const,
  unavailable: { title: "Transcript could not be recovered", message: "Could not read this session's transcript.", diagnostic: "the read timed out" },
  view: { blocks },
})

test("a first transcript read that failed is the destination's failure, in words, and a read over a window already shown is not", () => {
  let transcript = failedRead([])
  const { navigation } = navigationOver({ transcript: () => transcript })
  assert.deepEqual(navigation.opening?.failure, "Flywheel could not read this session's transcript: the read timed out")
  // The same failure is the same opening, so the pane does not paint it again.
  assert.equal(navigation.opening, navigation.opening)
  transcript = failedRead([{ kind: "text", id: "earlier", content: "Earlier answer", timestamp: 0 }])
  assert.equal(navigation.opening, undefined)
})

test("a tap on the shown session reads it again when its transcript could not be read", async () => {
  let failed = false
  const { navigation, shown } = navigationOver({ transcript: () => (failed ? failedRead([]) : undefined) })
  await navigation.select("chat")
  assert.deepEqual(shown, [])
  failed = true
  await navigation.select("chat")
  assert.deepEqual(shown, ["chat"])
})
