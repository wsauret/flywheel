// The open display of a chat whose question waits (PI-INTERACTION-185,
// ARCH-SESSIONS-050) stays the same through a refresh, and keeps the newest
// stored content when two refreshes of the chat overlap.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import type { AnyBlock } from "../../../../src/infra/substrate/events/output-blocks.js"
import { asAsyncEventReadSurface } from "../../../../src/infra/substrate/store/event-store-types.js"
import { createConversationTreeWriterController } from "../../../../src/orchestration/chat/tree-writer.js"
import { createTranscriptProjectionCache } from "../../../../src/orchestration/app-service/projections/output/transcript-projection-cache.js"
import { refreshOpenChatDisplay } from "../../../../src/orchestration/app-service/supervisor/actor/session-reactivation.js"
import { testDirectories } from "../../../helpers/directories.js"
import { ask, reply, until, quiesce, settle, questionAtRest, expectHeld, expectContinued, displayedRows, storedRows, displayedBlocks, storedBlocks, questionHoldChats } from "./_question-hold-fixtures.js"

const withChat = questionHoldChats()

setDefaultTimeout(30_000)

describe("the open display of a chat", () => {
  test("a second activation keeps the dividers of held skill invocations with their queued row, and the answer shows each once as stored", async () => {
    await withChat([ask, reply("done")], async (chat) => {
      await questionAtRest(chat, { attach: true })
      const mark = chat.model.requests.length
      expect(await chat.supervisor.sendChat(chat.sessionId, { text: "Expanded finalize prompt.", invocation: { label: "/experiment finalize" }, submissionIds: ["finalize"] })).toMatchObject({ ok: true })
      expect(await chat.supervisor.sendChat(chat.sessionId, { text: "Expanded design prompt.", invocation: { label: "/experiment design", args: "my goal" }, submissionIds: ["design"] })).toMatchObject({ ok: true })
      await expectHeld(chat, mark)
      const held = ["question", "divider(/experiment finalize)", "divider(/experiment design)", "queued#person:design(my goal)"]
      expect(displayedRows(chat)).toEqual(held)
      expect(await chat.supervisor.activateSession(chat.sessionId, { shown: true })).toBe(true)
      expect(displayedRows(chat)).toEqual(held)
      expect(await settle(chat)).toEqual({ ok: true })
      await expectContinued(chat, mark, ["Expanded finalize prompt.", "Expanded design prompt."])
      expect(displayedRows(chat)).toEqual(["question", "divider(/experiment finalize)", "divider(/experiment design)", "sent#person:design(my goal)", "text(done)"])
      const landed = (blocks: readonly AnyBlock[]) => blocks.filter((block) => block.kind !== "text")
      expect(landed(displayedBlocks(chat))).toEqual(landed(await storedBlocks(chat)))
      expect(displayedRows(chat)).toEqual(await storedRows(chat))
    })
  })

  test("of two overlapping refreshes, the display keeps the content of the later read", async () => {
    await withChat([], async (chat) => {
      const reader = asAsyncEventReadSurface(chat.ctx.store)
      const writer = createConversationTreeWriterController({ conversationId: chat.conversationId, sessionId: chat.sessionId, projectRoot: chat.ctx.baseDir, store: reader, projectionReader: reader, writer: chat.writer })
      const cache = createTranscriptProjectionCache({ sessionStore: chat.ctx.sessionStore, reader, projectionReader: reader, projectRoot: chat.ctx.baseDir })
      const released = Promise.withResolvers<void>()
      let reads = 0
      const deps = {
        sessionStore: chat.ctx.sessionStore,
        manager: chat.ctx.manager,
        directories: testDirectories(chat.ctx.baseDir),
        projectionReader: reader,
        transcriptCache: {
          // The first read takes the stored blocks at once and answers only
          // when the test releases it, after a later commit.
          async read(sessionId: string, conversationId: string, executionCwd: string) {
            const history = await cache.read(sessionId, conversationId, executionCwd)
            if (reads++ > 0 || !history) return history
            const blocks = await Promise.all(Array.from({ length: history.blockCount }, (_, index) => history.readBlock(index)))
            await released.promise
            return { ...history, readBlock: async (index: number) => blocks[index] ?? history.readBlock(index) }
          },
        },
      }
      const messages = () => (chat.ctx.sessionStore.get(chat.sessionId)?.outputBlocks() ?? []).flatMap((block) => block.kind === "userMessage" ? [block.content] : [])
      try {
        await writer.commitUserTurn("older", "older")
        const first = refreshOpenChatDisplay(deps, chat.sessionId)
        await until("the first read", () => reads === 1)
        await writer.commitUserTurn("newer", "newer")
        const second = refreshOpenChatDisplay(deps, chat.sessionId)
        // Unordered, the later refresh writes first; ordered, it waits.
        await Promise.race([second, quiesce()])
        released.resolve()
        await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
        expect(messages()).toEqual(["older", "newer"])
      } finally {
        released.resolve()
        await writer.dispose()
        await cache.dispose()
      }
    })
  })
})
