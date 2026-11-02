import { afterEach, describe, expect, test } from "bun:test"
import { onReplyWaitsChanged, readReplyWaitViews } from "../../../../src/orchestration/session/reply-waits"
import { replyWaitNoticeKey } from "../../../../src/orchestration/session/conversation/reply-wait-cells"
import { settle, project, deleteSession, live, message, conversationOf, cleanupReplyWaitTest, childWorkflow } from "./_reply-wait-fixtures"

afterEach(cleanupReplyWaitTest)

describe("the published addressees", () => {
  // A status names what a session waits on from the waits it stores, so a
  // wait lists while it is open and every change to it is readable.
  test("list each stored wait while it is open, also while no run holds it, and clear it at a reply, a stop, and an unavailable addressee", async () => {
    const here = project()
    const waiter = await here.manager.createChat({ name: "Waiter" })
    const first = await childWorkflow(here, waiter, "Spec review")
    const second = await childWorkflow(here, waiter, "Design chat")
    const w = live(here, waiter)
    live(here, first)
    live(here, second)
    const listed = (sessionId: string) => readReplyWaitViews(here.reader, here.manager.read, sessionId)
    const changed: string[] = []
    const stop = onReplyWaitsChanged(here.reader, (sessionId) => { changed.push(sessionId) })
    try {
      await message(here.messaging, { id: waiter, tasks: w.tasks }, "ask-1", { to: first, text: "Which file?", wait: true })
      const firstOpened = (await listed(waiter))[0]!.openedAtMs
      expect(here.replyWaitCells(waiter)[0]!.payload).toMatchObject({ openedAtMs: firstOpened })
      await message(here.messaging, { id: waiter, tasks: w.tasks }, "ask-2", { to: second, text: "Which color?", wait: true })
      const secondOpened = (await listed(waiter))[1]!.openedAtMs
      expect(await listed(waiter)).toEqual([{ sessionId: first, name: "Spec review", openedAtMs: firstOpened, isParent: false }, { sessionId: second, name: "Design chat", openedAtMs: secondOpened, isParent: false }])
      expect(new Set(changed)).toEqual(new Set([waiter]))
      expect(await listed(first)).toEqual([])

      // A reply ends one wait.
      changed.length = 0
      await message(here.messaging, { id: first }, "answer-1", { to: waiter, text: "main.ts" })
      expect(await listed(waiter)).toEqual([{ sessionId: second, name: "Design chat", openedAtMs: secondOpened, isParent: false }])
      expect(changed).toEqual([waiter])

      // The waiter's own stop ends the other.
      expect(w.tasks.terminate("ask-2")).toBe(true)
      await settle()
      expect(await listed(waiter)).toEqual([])
      expect(changed).toEqual([waiter, waiter])

      // An addressee that can no longer read ends the wait on it.
      await message(here.messaging, { id: waiter, tasks: w.tasks }, "ask-3", { to: second, text: "Still there?", wait: true })
      expect(await listed(waiter)).toEqual([{ sessionId: second, name: "Design chat", openedAtMs: expect.any(Number), isParent: false }])
      await deleteSession(here, second)
      await settle()
      expect(await listed(waiter)).toEqual([])

      // The host of the waiter closes, as a planned replacement does: the
      // wait stays stored for the next run, so it stays listed until then.
      await message(here.messaging, { id: waiter, tasks: w.tasks }, "ask-4", { to: first, text: "And the tests?", wait: true })
      const restoredOpened = (await listed(waiter))[0]!.openedAtMs
      await w.tasks.terminateAll()
      await settle()
      expect(await listed(waiter)).toEqual([{ sessionId: first, name: "Spec review", openedAtMs: restoredOpened, isParent: false }])
    } finally {
      stop()
    }
  })

  // A reader that keeps its last read of the stored waits reads them again
  // only when told, so every write that changes them tells it.
  test("an end notice that the waiter holds and a reply to a wait that no run holds each tell the readers once of what they hide or retire", async () => {
    const here = project()
    const waiter = await here.manager.createChat({ name: "Waiter" })
    const addressee = await childWorkflow(here, waiter, "Spec review")
    const w = live(here, waiter)
    live(here, addressee)
    const listed = (sessionId: string) => readReplyWaitViews(here.reader, here.manager.read, sessionId)
    const changed: string[] = []
    const stop = onReplyWaitsChanged(here.reader, (sessionId) => { changed.push(sessionId) })
    const conversation = await conversationOf(here, waiter)
    try {
      // The waiter's run holds the end notice of its wait as it takes it.
      await message(here.messaging, { id: waiter, tasks: w.tasks }, "ask-1", { to: addressee, text: "Which file?", wait: true })
      expect(await listed(waiter)).toHaveLength(1)
      changed.length = 0
      const notice = await conversation.holdBackgroundNotification("Spec review ended its turn without a reply.", replyWaitNoticeKey({ addresseeSessionId: addressee, toolUseId: "ask-1" }))
      expect(await listed(waiter)).toEqual([])
      expect(changed).toEqual([waiter])
      // Its commit retires the cell, which the readers already read as gone.
      await conversation.commitBackgroundNotification(notice!)
      expect(here.replyWaitCells(waiter)).toEqual([])
      expect(await listed(waiter)).toEqual([])

      // The host of the waiter closes: the wait stays stored for the next
      // run, and no run here holds it when its reply comes.
      await message(here.messaging, { id: waiter, tasks: w.tasks }, "ask-2", { to: addressee, text: "And the tests?", wait: true })
      await w.tasks.terminateAll()
      await settle()
      expect(await listed(waiter)).toHaveLength(1)
      changed.length = 0
      await message(here.messaging, { id: addressee }, "answer-2", { to: waiter, text: "They pass." })
      expect(await listed(waiter)).toEqual([])
      expect(changed).toEqual([waiter])
    } finally {
      stop()
      await conversation.dispose()
    }
  })
})
