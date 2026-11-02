import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Log } from "../../../../src/infra/log"
import { createBackgroundWorkRegistry } from "../../../../src/orchestration/agent-runtime/background-work"
import { readUnreadSessionMessages } from "../../../../src/orchestration/session/conversation/addressed-workflow-messages"
import { createOrderedLane } from "../../../../src/infra/ordered-lane"
import { createChatSessionControl } from "../../../../src/orchestration/app-service/chat-session-control"
import { interruptedTurnEnd, type TurnEnd } from "../../../../src/orchestration/session/conversation/turn-end-record"
import { onReplyWaitsChanged } from "../../../../src/orchestration/session/reply-waits"
import { holdReplyWait, readReplyWaits } from "../../../../src/orchestration/session/conversation/reply-wait-cells"
import { appendTurnEnd, createStoredChatSession } from "../chat/_chat-session-agent-runtime-fixtures"
import { REPLY_WAIT_KIND, unregisters, settle, anotherRuntimeReader, project, live, message, read, cleanupReplyWaitTest, childWorkflow } from "./_reply-wait-fixtures"

afterEach(cleanupReplyWaitTest)

describe("waits outlive the run", () => {
  test("after a stop, the next runtime registers the wait again, and a reply that arrived in the gap lands once", async () => {
    const here = project()
    // A workflow child waits on its parent chat.
    const addressee = await here.manager.createChat({ name: "Addressee" })
    const waiter = await childWorkflow(here, addressee, "Waiter")
    const w = live(here, waiter)
    live(here, addressee)
    await message(here.messaging, { id: waiter, tasks: w.tasks }, "ask-1", { to: addressee, text: "Which file?", wait: true })

    // The stop closes the waiter's background work: no notice, and the cell stays.
    await w.tasks.terminateAll()
    expect(w.notices).toEqual([])
    expect(here.replyWaitCells(waiter)).toHaveLength(1)

    // A successor runtime with no wait registered yet: the reply is held.
    const next = anotherRuntimeReader(here)
    const successor = here.runtime(next)
    await message(successor, { id: addressee }, "answer-1", { to: waiter, text: "main.ts" })
    const tasks = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => { throw new Error("no notice") } })
    await successor.observeRun({ sessionId: waiter, tasks })
    expect(tasks.activeTaskCount()).toBe(0)
    expect((await readUnreadSessionMessages(next, waiter)).map((cell) => cell.text)).toEqual(["main.ts"])
  })

  test("a restore that finds the reply of a wait whose cell a crash kept retires the cell, and readers of the waits hear of it", async () => {
    const here = project()
    const addressee = await here.manager.createChat({ name: "Addressee" })
    const waiter = await childWorkflow(here, addressee, "Waiter")
    const w = live(here, waiter)
    live(here, addressee)
    await message(here.messaging, { id: waiter, tasks: w.tasks }, "ask-1", { to: addressee, text: "Which file?", wait: true })
    const [cell] = await readReplyWaits(here.reader, waiter)
    if (!cell) throw new Error("Expected the held wait")
    await w.tasks.terminateAll()
    const next = anotherRuntimeReader(here)
    const successor = here.runtime(next)
    await message(successor, { id: addressee }, "answer-1", { to: waiter, text: "main.ts" })
    // The crash came after the reply landed and before its cell was retired.
    await holdReplyWait(here.writer, waiter, cell)

    const changed: string[] = []
    const stopListening = onReplyWaitsChanged(next, (sessionId) => { changed.push(sessionId) })
    try {
      await successor.observeRun({ sessionId: waiter, tasks: createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => { throw new Error("no notice") } }) })
    } finally { stopListening() }
    expect(here.replyWaitCells(waiter)).toEqual([])
    expect(changed).toEqual([waiter])
    expect((await readUnreadSessionMessages(next, waiter)).map((unread) => unread.text)).toEqual(["main.ts"])
  })

  test("after a stop with no reply, the next run registers the wait again and the end rules apply", async () => {
    const here = project()
    const addressee = await here.manager.createChat({ name: "Addressee" })
    const waiter = await childWorkflow(here, addressee, "Waiter")
    const w = live(here, waiter)
    live(here, addressee)
    await message(here.messaging, { id: waiter, tasks: w.tasks }, "ask-1", { to: addressee, text: "Which file?", wait: true })
    await w.tasks.terminateAll()

    // An interrupt cut the waiter's run; Resume starts a run that waits again.
    unregisters.splice(0, 1)[0]!()
    const resumed = live(here, waiter)
    await here.messaging.observeRun({ sessionId: waiter, tasks: resumed.tasks })
    expect(resumed.tasks.holdsWait("ask-1")).toBe(true)

    await message(here.messaging, { id: addressee }, "answer-1", { to: waiter, text: "main.ts" })
    expect(resumed.tasks.holdsWait("ask-1")).toBe(false)
    expect(resumed.notices).toEqual([])
  })

  // The successor resumes the waiter before the chat it waits on, and the
  // child's resume holds the chat's runner first. The hold runs no turn of
  // the chat, so the chat has not yielded.
  for (const [label, end] of [["a planned replacement cut", interruptedTurnEnd("replacement")], ["an unexpected exit ended", { reason: "crash" }]] as const satisfies readonly (readonly [string, TurnEnd])[]) {
    test(`a restored wait on a chat whose last turn ${label} after it read the message stays open while a hold parks the chat, and its reply ends the wait once`, async () => {
      const here = project()
      const addressee = await here.manager.createChat({ name: "Addressee" })
      const waiter = await childWorkflow(here, addressee, "Waiter")
      const w = live(here, waiter)
      live(here, addressee)
      await message(here.messaging, { id: waiter, tasks: w.tasks }, "ask-1", { to: addressee, text: "Which letter?", wait: true })
      await read(here, addressee, waiter, "ask-1")
      // The runtime stops: the wait stays held, and the turn of the chat ends at `end`.
      await w.tasks.terminateAll()
      const session = await here.manager.read(addressee)
      if (session?.kind !== "chat") throw new Error(`${addressee} is not a chat`)

      // The successor attaches the chat, and a hold parks its runner.
      const next = anotherRuntimeReader(here)
      const { chat, parked } = await createStoredChatSession({ sessionId: addressee, conversationId: session.conversationId, projectRoot: here.root, reader: next, writer: here.writer, seed: (tree) => appendTurnEnd(tree, end) })
      const control = createChatSessionControl({ store: next, sessionId: addressee, lane: createOrderedLane(), runner: () => chat })
      control.attach()
      try {
        await chat.hold()
        await parked(1)

        const notices: string[] = []
        const tasks = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: (text) => { notices.push(text) } })
        const successor = here.runtime(next)
        await successor.observeRun({ sessionId: waiter, tasks })
        await settle()
        expect(tasks.holdsWait("ask-1")).toBe(true)
        expect(notices).toEqual([])

        await message(successor, { id: addressee }, "answer-1", { to: waiter, text: "Q" })
        expect(tasks.holdsWait("ask-1")).toBe(false)
        expect(notices).toEqual([])
        expect((await readUnreadSessionMessages(next, waiter)).map((cell) => cell.text)).toEqual(["Q"])
      } finally {
        control.vacate()
        await chat.dispose()
      }
    })
  }

  test("a restored wait on an addressee that is gone ends at once", async () => {
    const here = project()
    const addressee = await here.manager.createChat({ name: "Addressee" })
    const waiter = await childWorkflow(here, addressee, "Waiter")
    const w = live(here, waiter)
    live(here, addressee)
    await message(here.messaging, { id: waiter, tasks: w.tasks }, "ask-1", { to: addressee, text: "Which file?", wait: true })
    await w.tasks.terminateAll()

    const next = anotherRuntimeReader(here)
    const notices: string[] = []
    const restored = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: (text) => { notices.push(text) } })
    // No control of the addressee is live in the successor: nothing runs it.
    await here.runtime(next).observeRun({ sessionId: waiter, tasks: restored })
    await settle()
    expect(restored.activeTaskCount()).toBe(0)
    expect(notices[0]).toContain("<status>unavailable</status>")
  })

  test("a held wait this build cannot read is named in a warning, keeps its bytes, and registers nothing", async () => {
    const here = project()
    const waiter = await here.manager.createChat({ name: "Waiter" })
    await here.writer.putInFlight?.(waiter, REPLY_WAIT_KIND, "addressee", { toolUseId: 7, openedAtMs: "later" })
    const warn = spyOn(Log.create({ service: "reply-wait-cells" }), "warn").mockImplementation(() => {})
    try {
      const tasks = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} })
      await here.messaging.observeRun({ sessionId: waiter, tasks })
      expect(tasks.activeTaskCount()).toBe(0)
      expect(warn).toHaveBeenCalledWith("unreadable reply wait skipped", { sessionId: waiter, key: "addressee" })
    } finally {
      warn.mockRestore()
    }
    expect(here.replyWaitCells(waiter).map((row) => row.payload)).toEqual([{ toolUseId: 7, openedAtMs: "later" }])
  })

  test("process stop ends the wait with no notice and retires its cell", async () => {
    const here = project()
    const addressee = await here.manager.createChat({ name: "Addressee" })
    const waiter = await childWorkflow(here, addressee, "Waiter")
    const w = live(here, waiter)
    live(here, addressee)
    await message(here.messaging, { id: waiter, tasks: w.tasks }, "ask-1", { to: addressee, text: "Which file?", wait: true })
    // The live list of commands, which replacement blockers read, never shows a wait.
    expect(w.tasks.activeBackgroundCommands()).toEqual([])

    expect(w.tasks.terminateProcess("reply-wait:ask-1", "agent")).toBe(true)
    await settle()
    expect(w.tasks.activeTaskCount()).toBe(0)
    expect(w.notices).toEqual([])
    expect(here.replyWaitCells(waiter)).toEqual([])
  })
})
