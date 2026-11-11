import { afterEach, describe, expect, it } from "bun:test"

import { EventBus } from "../../../../src/infra/event-bus"
import type { ConversationMessage, StreamOptions } from "../../../../src/orchestration/agent-runtime/llm/types"
import { createChatSession } from "../../../../src/orchestration/chat/session"
import type { ChatRunner } from "../../../../src/orchestration/chat/runner-types"
import type { ConversationTreeWriterController } from "../../../../src/orchestration/chat/tree-writer"
import type { ResolvedRoles } from "../../../../src/orchestration/config/roles"
import { newTestRunner } from "../../../helpers/agent-runner"
import { asModelClient } from "../agent-runtime/_model-client"
import { createTestChatSessionDeps, makeMemoryTreeWriter } from "./_chat-session-agent-runtime-fixtures"

function completedTree(
  onRecord?: (input: { tokensBefore: number; measureTokensAfter(messages: readonly ConversationMessage[]): number }) => void,
) {
  const base = makeMemoryTreeWriter()
  const buildOptions: Array<{ allowAssistantTail?: boolean } | undefined> = []
  const treeWriter: ConversationTreeWriterController = {
    ...base,
    async buildContext(options) {
      buildOptions.push(options)
      const context = await base.buildContext(options)
      if (context.messages.at(-1)?.kind === "assistant" && options?.allowAssistantTail !== true) {
        throw new Error("assistant tail requires preparatory context")
      }
      return context
    },
    async recordCompaction(input) {
      onRecord?.(input)
      return base.recordCompaction(input)
    },
  }
  return { treeWriter, buildOptions }
}

describe("idle chat compaction", () => {
  let session: ChatRunner | null = null

  afterEach(async () => {
    await session?.dispose()
    session = null
  })

  it("runs one checkpoint, resets context, and parks again", async () => {
    let record: { tokensBefore: number; measureTokensAfter(messages: readonly ConversationMessage[]): number } | undefined
    const { treeWriter, buildOptions } = completedTree((input) => { record = input })
    await treeWriter.commitUserTurn("finished request")
    treeWriter.beginTurn()
    treeWriter.recordCanonicalMessage({ kind: "assistant", content: "finished response" })
    await treeWriter.endTurn()

    const requests: Array<{ model: string; messages: ConversationMessage[] }> = []
    const createClient = async (model: string) => asModelClient({
      accessProvider: "anthropic_api",
      modelFamily: "anthropic",
      model,
      contextLimit: 100_000,
      outputLimit: 8_000,
      supportsReasoning: false,
      priceFor() { return { status: "unavailable", reason: "missing-rate-card" } as const },
      async *streamWithTools(options: StreamOptions) {
        requests.push({ model, messages: [...options.messages] })
        yield { kind: "tool_use", toolCall: { id: "save", name: "checkpoint_replace", input: { section: "currentState", value: "durable checkpoint" } } } as const
        yield { kind: "done", stopReason: "tool_use" } as const
      },
    })
    const roles: ResolvedRoles = new Map([
      ["chat", { roleId: "chat", model: "main-model", effort: "high" }],
    ])
    const eventBus = new EventBus()
    const events: string[] = []
    const errors: string[] = []
    const compactionStarted = Promise.withResolvers<void>()
    const compactedTurnParked = Promise.withResolvers<void>()
    const parkedBeforeCompaction = Promise.withResolvers<void>()
    const operationFailed = Promise.withResolvers<void>()
    const runnerEnded = Promise.withResolvers<Awaited<ReturnType<typeof newTestRunner>["done"]>>()
    let sawCompaction = false
    eventBus.subscribeToType("agent.compaction.started", () => {
      events.push("compaction")
      sawCompaction = true
      compactionStarted.resolve()
    })
    eventBus.subscribeToType("agent.turn.parked", () => {
      events.push("parked")
      if (sawCompaction) compactedTurnParked.resolve()
      else parkedBeforeCompaction.resolve()
    })

    session = await createChatSession({ onError: (error) => {
      errors.push(error)
      operationFailed.resolve()
    }, onEnded: () => {} }, createTestChatSessionDeps({
      sessionId: "idle-compact",
      treeWriter,
      eventBus,
      hasPriorBlocks: true,
      resolveRoles: async () => roles,
      createAgent: (options) => {
        const runner = newTestRunner(options, createClient)
        void runner.done.then(runnerEnded.resolve)
        return runner
      },
    }))

    expect(await session.compact()).toBe(true)
    const compactionResult = await Promise.race([
      compactionStarted.promise.then(() => "started" as const),
      operationFailed.promise.then(() => "failed" as const),
      parkedBeforeCompaction.promise.then(() => "parked-before-compaction" as const),
      runnerEnded.promise.then((result) => ({ kind: "runner-ended" as const, result })),
    ])
    if (compactionResult !== "started") {
      throw new Error(JSON.stringify({ compactionResult, events, errors, buildOptions, models: requests.map(({ model }) => model) }))
    }
    const parkResult = await Promise.race([
      compactedTurnParked.promise.then(() => "parked" as const),
      operationFailed.promise.then(() => "failed" as const),
    ])
    if (parkResult === "failed") {
      throw new Error(JSON.stringify({ events, errors, buildOptions, models: requests.map(({ model }) => model) }))
    }
    expect(errors).toEqual([])

    expect(requests.map(({ model }) => model)).toEqual(["main-model"])
    expect(requests[0]?.messages.at(-1)?.content).toContain("Save the checkpoint now:")
    expect(record?.tokensBefore).toBeGreaterThan(0)
    expect(record?.measureTokensAfter).toEqual(expect.any(Function))
    expect(buildOptions[0]).toEqual({ allowAssistantTail: true })
  })

  it("does not request a model for an empty session", async () => {
    let requests = 0
    session = await createChatSession({ onError: () => {}, onEnded: () => {} }, createTestChatSessionDeps({
      sessionId: "empty-idle-compact",
      createAgent: (options) => newTestRunner(options, async () => asModelClient({
        accessProvider: "anthropic_api",
        modelFamily: "anthropic",
        model: "test",
        contextLimit: 100_000,
        outputLimit: 8_000,
        supportsReasoning: false,
        priceFor() { return { status: "unavailable", reason: "missing-rate-card" } as const },
        async *streamWithTools() {
          requests += 1
          yield { kind: "done", stopReason: "end_turn" } as const
        },
      })),
    }))

    expect(await session.compact()).toBe(true)
    await Bun.sleep(20)
    expect(requests).toBe(0)
  })
})
