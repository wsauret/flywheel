import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { createStatusProjection } from "../../../../src/orchestration/app-service/status-projection.js"
import { replyWaitLabel } from "../../../../src/protocol/client/session-controls.js"
import { countStateRequests } from "../../../helpers/state-requests.js"
import { onReplyWaitsChanged, readReplyWaitViews } from "../../../../src/orchestration/session/reply-waits.js"
import { dropReplyWait, holdReplyWait, REPLY_WAIT_IN_FLIGHT_KIND, replyWaitNoticeKey } from "../../../../src/orchestration/session/conversation/reply-wait-cells.js"
import type { AsyncEventStateReadSurface } from "../../../../src/infra/event-store-types.js"
import { entry, flush, NOTHING_OWED, sink, store, until } from "./_status-projection-fixtures.js"
import { childWorkflow, cleanupReplyWaitTest, conversationOf, live, message, project } from "../session/_reply-wait-fixtures.js"

afterEach(cleanupReplyWaitTest)

/** The reply waits of a status as the runtime wires them, over `reader`. */
function storedReplyWaits(here: ReturnType<typeof project>, reader: AsyncEventStateReadSurface = here.reader) {
  return {
    addressees: (sessionId: string) => readReplyWaitViews(reader, here.manager.read, sessionId),
    onChange: (listener: (sessionId: string) => void) => onReplyWaitsChanged(here.reader, listener),
  }
}

describe("the reply waits of a status", () => {
  test("a session's open reply waits publish with its status as each opens and ends, apart from any store change", async () => {
    const s = store({ "child-1": entry({ waitingOnBackgroundWork: true }), "chat-2": entry() })
    const out = sink()
    const open = new Map<string, { sessionId: string; name: string; openedAtMs: number; isParent: boolean }[]>()
    const listeners = new Set<(sessionId: string) => void>()
    const changed = (sessionId: string) => { for (const listener of listeners) listener(sessionId) }
    const projection = createStatusProjection({
      sessionStore: s.store, publish: out.publish, flushOutput: async () => {}, outputPosition: out.outputPosition, ...NOTHING_OWED,
      replyWaits: { ...NOTHING_OWED.replyWaits, addressees: async (sessionId) => open.get(sessionId) ?? [], onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } } },
    })
    expect(await projection.snapshot("child-1")).toMatchObject({ replyWaits: [] })

    open.set("child-1", [{ sessionId: "child", name: "Explorer", openedAtMs: 1000, isParent: false }, { sessionId: "parent", name: "Design chat", openedAtMs: 1234, isParent: true }])
    changed("child-1")
    await until("the open wait to publish", () => out.patches.length === 1)
    expect(out.patches[0]).toMatchObject({ cursor: { sessionId: "child-1" }, payload: { kind: "status.updated", status: { activityStartedAt: 1234 } } })
    expect(replyWaitLabel(await projection.snapshot("child-1") ?? undefined, "parent")).toBe("Waiting on parent")
    expect((await projection.snapshot("child-1"))?.activityStartedAt).toBe(1234)

    const clock = spyOn(Date, "now").mockReturnValue(2500)
    try {
      open.set("child-1", [open.get("child-1")![0]!])
      changed("child-1")
      await until("the remaining child wait to publish", () => out.patches.length === 2)
      expect(out.patches[1]).toMatchObject({ payload: { status: { activityStartedAt: 2500, replyWaits: [{ sessionId: "child" }] } } })
      expect((await projection.snapshot("child-1"))?.activityStartedAt).toBe(2500)

      clock.mockReturnValue(3000)
      open.delete("child-1")
      changed("child-1")
      await until("the ended wait to publish", () => out.patches.length === 3)
      expect(out.patches[2]).toMatchObject({ cursor: { sessionId: "child-1" }, payload: { kind: "status.updated", status: { activityStartedAt: 3000, replyWaits: [] } } })
      expect((await projection.snapshot("child-1"))?.activityStartedAt).toBe(3000)
    } finally {
      clock.mockRestore()
    }
    expect(await projection.snapshot("chat-2")).toMatchObject({ replyWaits: [] })
    projection.dispose()
    expect(listeners.size).toBe(0)
  })

  test("a streaming session's status changes read its stored reply waits only on the first view, and each word that they changed reads them once", async () => {
    const here = project()
    const counter = countStateRequests(here.reader)
    const replyWaitReads = () => counter.take().filter((request) => request.method === "readInFlight" && [request.args[1]].flat().includes(REPLY_WAIT_IN_FLIGHT_KIND)).length
    const streaming = (activeMs: number) => entry({ runnerState: "streaming", streamPhase: "thinking", accumulatedActiveMs: activeMs, activityStartedAt: 1000 })
    const s = store({ "streaming-waiter": streaming(0) })
    const out = sink()
    const listeners = new Set<(sessionId: string) => void>()
    const projection = createStatusProjection({
      sessionStore: s.store, publish: out.publish, flushOutput: async () => {}, outputPosition: out.outputPosition, ...NOTHING_OWED,
      replyWaits: { ...NOTHING_OWED.replyWaits, addressees: (sessionId) => readReplyWaitViews(counter.reader, async () => null, sessionId), onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } } },
    })
    try {
      expect(await projection.snapshot("streaming-waiter")).toMatchObject({ accumulatedActiveMs: 0, replyWaits: [] })
      expect(replyWaitReads()).toBe(1)
      const base = out.patches.length

      for (let activeMs = 1; activeMs <= 20; activeMs++) {
        s.set("streaming-waiter", streaming(activeMs))
        await until(`the status with ${activeMs} active milliseconds`, () => out.patches.length === base + activeMs)
      }
      expect(out.patches.at(-1)).toMatchObject({ payload: { status: { accumulatedActiveMs: 20, replyWaits: [] } } })
      expect(replyWaitReads()).toBe(0)

      await holdReplyWait(here.writer, "streaming-waiter", { addresseeSessionId: "addressee", toolUseId: "ask-1", openedAtMs: 900 })
      for (const listener of listeners) listener("streaming-waiter")
      await until("the opened wait to publish", () => out.patches.length === base + 21)
      expect(out.patches.at(-1)).toMatchObject({ payload: { status: { accumulatedActiveMs: 20, replyWaits: [{ sessionId: "addressee" }] } } })
      expect(replyWaitReads()).toBe(1)

      s.set("streaming-waiter", streaming(21))
      await until("the next streamed status", () => out.patches.length === base + 22)
      expect(out.patches.at(-1)).toMatchObject({ payload: { status: { accumulatedActiveMs: 21, replyWaits: [{ sessionId: "addressee" }] } } })
      expect(replyWaitReads()).toBe(0)
    } finally {
      projection.dispose()
      await dropReplyWait(here.writer, "streaming-waiter", { addresseeSessionId: "addressee", toolUseId: "ask-1" })
    }
  })

  test("a reply wait opened while the runner works starts counting only when the runner parks", async () => {
    const s = store({ "child-1": entry({ runnerState: "streaming", streamPhase: "thinking", activityStartedAt: 1000 }) })
    const out = sink()
    const projection = createStatusProjection({
      sessionStore: s.store, publish: out.publish, flushOutput: async () => {}, outputPosition: out.outputPosition, ...NOTHING_OWED,
      replyWaits: { ...NOTHING_OWED.replyWaits, addressees: async () => [{ sessionId: "parent", name: "Parent", openedAtMs: 1500, isParent: true }] },
    })
    try {
      expect((await projection.snapshot("child-1"))?.activityStartedAt).toBe(1000)
      s.set("child-1", entry({ waitingOnBackgroundWork: true, activityStartedAt: 2000 }))
      await flush()
      expect(await projection.snapshot("child-1")).toMatchObject({ activity: "idle", waitingOnBackgroundWork: true, activityStartedAt: 2000 })
    } finally {
      projection.dispose()
    }
  })

  // The commit of an end notice retires the notice and the cell of its wait
  // at once and tells no reader, so a status that read the cells before the
  // commit and the notices after it would keep the ended wait for good.
  test("an end notice that commits while the status reads the stored waits never keeps the ended wait listed", async () => {
    const here = project()
    const waiter = await here.manager.createChat({ name: "Waiter" })
    const addressee = await childWorkflow(here, waiter, "Spec review")
    const w = live(here, waiter)
    live(here, addressee)
    const conversation = await conversationOf(here, waiter)
    let commitAtRead: (() => Promise<void>) | undefined
    const reader: AsyncEventStateReadSurface = {
      ...here.reader,
      async readInFlight(sessionId, kind, keyPrefix) {
        const rows = await here.reader.readInFlight(sessionId, kind, keyPrefix)
        const commit = commitAtRead
        if (commit && [kind].flat().includes(REPLY_WAIT_IN_FLIGHT_KIND)) {
          commitAtRead = undefined
          await commit()
        }
        return rows
      },
    }
    const s = store({ [waiter]: entry({ waitingOnBackgroundWork: true }) })
    const out = sink()
    const projection = createStatusProjection({ sessionStore: s.store, publish: out.publish, flushOutput: async () => {}, outputPosition: out.outputPosition, ...NOTHING_OWED, replyWaits: storedReplyWaits(here, reader) })
    try {
      await message(here.messaging, { id: waiter, tasks: w.tasks }, "ask-1", { to: addressee, text: "Which file?", wait: true })
      expect(await projection.snapshot(waiter)).toMatchObject({ replyWaits: [{ sessionId: addressee }] })

      const held = Promise.withResolvers<NonNullable<Awaited<ReturnType<typeof conversation.holdBackgroundNotification>>>>()
      const committed = Promise.withResolvers<void>()
      commitAtRead = async () => {
        await conversation.commitBackgroundNotification(await held.promise)
        committed.resolve()
      }
      const notice = await conversation.holdBackgroundNotification("Spec review ended its turn without a reply.", replyWaitNoticeKey({ addresseeSessionId: addressee, toolUseId: "ask-1" }))
      held.resolve(notice!)
      await committed.promise
      expect(here.replyWaitCells(waiter)).toEqual([])

      for (let snapshot = 0; snapshot < 3; snapshot++) expect(await projection.snapshot(waiter)).toMatchObject({ replyWaits: [] })
    } finally {
      projection.dispose()
      await conversation.dispose()
    }
  })
})
