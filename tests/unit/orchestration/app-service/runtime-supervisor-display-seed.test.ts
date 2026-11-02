import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { AnyBlock } from "../../../../src/infra/output-blocks.js"
import { FULL_RESYNC_OUTPUT_CHANGE_BATCH } from "../../../../src/infra/output/output-block-delta.js"
import { asAsyncEventReadSurface, type EventStoreAppend } from "../../../../src/infra/event-store-types.js"
import { createRuntimeSupervisor } from "../../../../src/orchestration/app-service/runtime-supervisor.js"
import { createTranscriptProjectionCache } from "../../../../src/orchestration/app-service/transcript-projection-cache.js"
import { mockRunner, createDeferred, createSupervisorTestContext, disposeSupervisorTestContext, supervisorBaseDeps, type SupervisorTestContext } from "../../../fixtures/runtime-supervisor-fixtures.js"

let ctx: SupervisorTestContext

beforeEach(() => {
  ctx = createSupervisorTestContext()
})

afterEach(async () => {
  await disposeSupervisorTestContext(ctx)
})

describe("runtime supervisor display seed", () => {
  test("a delayed cold commit stays visible and enters the final attach seed", async () => {
    const created = createDeferred<void>()
    const ready = createDeferred<ReturnType<typeof mockRunner>>()
    const writing = createDeferred<void>()
    const commit = createDeferred<void>()
    let holdWrites = false
    const beforeWrite = async (events: readonly EventStoreAppend[]): Promise<void> => {
      if (holdWrites && events.some((event) => event.type === "chat.entries.appended")) {
        writing.resolve()
        await commit.promise
      }
    }
    const seeds: string[][] = []
    const runner = mockRunner("pending", { seedDisplayBlocks: (blocks) => { seeds.push(userMessages(blocks)) } })
    const supervisor = createRuntimeSupervisor({
      ...supervisorBaseDeps(ctx, ctx.sessionStore, { createRunner: async () => { created.resolve(); return ready.promise } }),
      writer: {
        ...ctx.store,
        append: async (event) => { await beforeWrite([event]); return ctx.store.append(event) },
        appendBatch: async (events) => { await beforeWrite(events); return ctx.store.appendBatch(events) },
        appendGuarded: async (event) => { await beforeWrite([event]); return ctx.store.appendGuarded(event) },
        appendBatchGuarded: async (events) => { await beforeWrite(events); return ctx.store.appendBatchGuarded(events) },
      },
    })
    const sessionId = await supervisor.openSessionRuntime()
    const first = supervisor.sendChat(sessionId, "first")
    await created.promise
    holdWrites = true
    const second = supervisor.sendChat(sessionId, "second")
    await writing.promise
    ready.resolve(runner)
    try {
      // The writer yields to a later turn while startup becomes ready.
      await Bun.sleep(1)
      expect(userMessages(ctx.sessionStore.get(sessionId)?.outputBlocks() ?? [])).toEqual(["first", "second"])
      commit.resolve()
      await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }])
      expect(seeds).toEqual([["first", "second"]])
      expect(userMessages(ctx.sessionStore.get(sessionId)?.outputBlocks() ?? [])).toEqual(["first", "second"])
    } finally {
      commit.resolve()
      await Promise.allSettled([first, second])
      await supervisor.disposeAll()
    }
  })

  test("close invalidates a startup waiting in the display-read phase without a mailbox cycle", async () => {
    const reading = createDeferred<void>()
    const finishRead = createDeferred<void>()
    const reader = asAsyncEventReadSurface(ctx.store)
    const cache = createTranscriptProjectionCache({ sessionStore: ctx.sessionStore, reader, projectionReader: reader, projectRoot: ctx.baseDir })
    let seeds = 0
    const runner = mockRunner("late", { seedDisplayBlocks: () => { seeds++ } })
    const supervisor = createRuntimeSupervisor({
      ...supervisorBaseDeps(ctx, ctx.sessionStore, { createRunner: async () => runner }),
      transcriptCache: {
        ...cache,
        read: async (sessionId, conversationId, executionCwd) => {
          reading.resolve()
          await finishRead.promise
          return cache.read(sessionId, conversationId, executionCwd)
        },
      },
    })
    const sessionId = await supervisor.openSessionRuntime()
    const startup = supervisor.ensureChatRunner(sessionId)
    await reading.promise
    const closing = supervisor.closeChat(sessionId)
    finishRead.resolve()
    try {
      await expect(startup).rejects.toThrow("stale chat startup")
      await expect(closing).resolves.toBe(true)
      expect(runner.disposeCalls()).toBe(1)
      expect(seeds).toBe(0)
      expect(ctx.sessionStore.get(sessionId)).toBeUndefined()
    } finally {
      finishRead.resolve()
      await Promise.allSettled([startup, closing])
      await supervisor.disposeAll()
      await cache.dispose()
    }
  })

  test("derived display replacement refreshes the shell and its attach-time runner seed with one full resync", () => {
    const sessionId = "replace-derived-seed"
    ctx.sessionStore.openSessionRuntime({ sessionId, conversationId: "replace-derived-conversation" })
    const replacement = [{ kind: "text" as const, id: "durable-result", content: "Done", timestamp: 1 }]

    expect(ctx.sessionStore.replaceChatDisplaySeed(sessionId, replacement, 4, 2, 1)).toBe(true)

    let runnerSeed: readonly AnyBlock[] = []
    const runner = mockRunner(sessionId, { seedDisplayBlocks: (blocks) => { runnerSeed = blocks } })
    expect(ctx.sessionStore.attachChatRunner(sessionId, runner)).toBe(true)

    expect(ctx.sessionStore.get(sessionId)?.outputBlocks()).toEqual(replacement)
    expect(ctx.sessionStore.get(sessionId)?.outputSequenceStart).toBe(3)
    expect(ctx.sessionStore.get(sessionId)?.visibleMessageCountPrefix).toBe(2)
    expect(ctx.sessionStore.get(sessionId)?.visibleMessageCountSuffix).toBe(1)
    expect(runnerSeed).toEqual(replacement)
    expect(ctx.sessionStore.drainOutputChanges(sessionId)).toBe(FULL_RESYNC_OUTPUT_CHANGE_BATCH)
  })

  test("full resync updates blocks and visible suffix count together before observers", async () => {
    const sessionId = "replace-count"
    ctx.sessionStore.openSessionRuntime({ sessionId, conversationId: "replace-count-conversation" })
    let observed: { blocks: readonly AnyBlock[]; count: number } | undefined
    ctx.sessionStore.onChange(() => {
      const entry = ctx.sessionStore.get(sessionId)
      if (entry) observed = { blocks: entry.outputBlocks(), count: entry.visibleMessageCountSuffix }
    })

    ctx.sessionStore.replaceChatDisplaySeed(sessionId, [
      { kind: "text", id: "durable-result", content: "Done", timestamp: 1 },
    ], 4, 2, 1)
    await Promise.resolve()

    expect(observed).toEqual({
      blocks: [{ kind: "text", id: "durable-result", content: "Done", timestamp: 1 }],
      count: 1,
    })
  })
})

function userMessages(blocks: readonly AnyBlock[]): string[] {
  return blocks.flatMap((block) => block.kind === "userMessage" ? [block.content] : [])
}
