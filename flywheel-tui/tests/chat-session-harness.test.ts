import { afterEach, describe, expect, it } from "bun:test"
import type { NDJSONEvent } from "../src/infra/ndjson-event-types"
import type { AnyBlock } from "../src/infra/output-blocks"
import { EventBus } from "../src/infra/event-bus"
import { createChatSession, type ChatCallbacks, type ChatSession } from "../src/orchestration/chat-session"
import { HarnessRunner } from "../src/orchestration/engines/providers/harness/runner"
import type { Engine, RunnerOptions } from "../src/orchestration/engines/core/types"
import type { Message, LLMClient, StreamOptions } from "../src/orchestration/engines/providers/harness/llm/types"
import type { BudgetTracker } from "../src/orchestration/session/budget-tracker-types"
import type { SessionEntryBase } from "../src/orchestration/session-store-types"

function createBudgetTracker(): BudgetTracker {
  return {
    handleEvent: () => {},
    getTotalCost: () => 0,
    incrementInvocations: () => {},
    getInvocationsUsed: () => 0,
    getTokensUsed: () => 0,
    updateContextUtilization: () => {},
    getContextUtilization: () => ({ promptTokens: 0, contextWindow: 100_000, percent: 0 }),
    isExhausted: () => false,
    flush: () => {},
    dispose: () => {},
    onNewProcess: () => {},
  }
}

describe("chat session with harness engine", () => {
  let session: ChatSession | null = null

  afterEach(() => {
    session?.end()
    session = null
  })

  it("delivers a queued chat message after the current tool turn", async () => {
    const calls: Message[][] = []
    const events: NDJSONEvent[] = []
    const waitingStates: boolean[] = []
    const errors: string[] = []
    let turnIndex = 0
    let runner: HarnessRunner | null = null

    let resolveActive!: () => void
    let activeResolved = false
    const becameActive = new Promise<void>((resolve) => {
      resolveActive = () => {
        if (activeResolved) return
        activeResolved = true
        resolve()
      }
    })

    const createClient = (): LLMClient => ({
      provider: "anthropic",
      model: "test",
      contextLimit: 100_000,
      outputLimit: 8_000,
      supportsReasoning: false,
      costFor() { return 0 },
      async *streamWithTools(options: StreamOptions) {
        calls.push([...options.messages])
        if (turnIndex++ === 0) {
          yield {
            kind: "tool_use",
            toolCall: { id: "todo-1", name: "todo_list", input: { operation: "read" } },
          } as const
          yield { kind: "done", stopReason: "tool_use" } as const
          return
        }

        yield { kind: "text_delta", text: "handled follow up" } as const
        yield { kind: "done", stopReason: "end_turn" } as const
      },
      async complete() {
        return ""
      },
    })

    const engine: Engine = {
      metadata: {
        id: "harness",
        name: "Harness",
        defaultModel: "test",
        description: "test harness",
      },
      createRunner(options: RunnerOptions) {
        runner = new HarnessRunner(options, createClient)
        return runner
      },
    }

    const eventBus = new EventBus()
    eventBus.subscribeToType("engine:ndjson", (event) => {
      events.push(event.ndjsonEvent)
    })

    const callbacks: ChatCallbacks = {
      onWaiting: (waiting) => { waitingStates.push(waiting) },
      onError: (message) => { errors.push(message) },
      onEnded: () => {},
    }

    session = await createChatSession(callbacks, {
      projectCwd: "/tmp",
      engine,
      model: "test",
      infra: {
        budgetTracker: createBudgetTracker(),
        transcriptWriter: null,
        traceCollector: null,
      },
      eventBus,
      chatId: "chat-harness-test",
      updateEntry: (patch: Partial<SessionEntryBase>) => {
        if (patch.modelActivity && patch.modelActivity !== "idle") {
          resolveActive()
        }
      },
    }, "initial instruction")

    await Promise.race([
      becameActive,
      Bun.sleep(30).then(() => { throw new Error("chat never became active") }),
    ])

    session.send("follow up")

    const liveRunner = runner
    expect(liveRunner).not.toBeNull()

    await Promise.race([
      liveRunner!.done,
      Bun.sleep(30).then(() => { throw new Error("chat runner did not finish") }),
    ])
    await Promise.resolve()

    expect(errors).toEqual([])
    expect(calls).toHaveLength(2)
    expect(calls[1]![calls[1]!.length - 1]).toEqual({ role: "user", content: "follow up" })

    const echoedUser = events.find((event) => {
      if (event.type !== "user") return false
      const content = event.data.message?.content
      return Array.isArray(content) && content.some((item) => item.type === "text" && item.text === "follow up")
    })
    expect(echoedUser).toBeDefined()

    const blocks = session.outputSession.getBlocks()
    const userBlock = blocks.find(
      (block): block is Extract<AnyBlock, { kind: "userMessage" }> =>
        block.kind === "userMessage" && block.content === "follow up",
    )
    expect(userBlock).toBeDefined()
    expect(userBlock!.pending).toBe(false)

    const textBlock = blocks.find(
      (block): block is Extract<AnyBlock, { kind: "text" }> =>
        block.kind === "text" && block.content.includes("handled follow up"),
    )
    expect(textBlock).toBeDefined()
    expect(waitingStates).toContain(true)
    expect(waitingStates).toContain(false)
  })
})
