import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { asAsyncEventReadSurface } from "../../../../src/infra/event-store-types.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { buildPapercutDrain } from "../../../../src/orchestration/modules/papercuts/drain.js"
import { temporaryDirectories } from "../../../helpers/directories.js"

import type { ConversationMessage, ProviderStreamEvent, StreamOptions } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import { runAgentLoop } from "../../../../src/orchestration/agent-runtime/agent-loop.js"
import { ChatTurnMailbox } from "../../../../src/orchestration/chat/turn-mailbox.js"
import { asModelClient } from "../agent-runtime/_model-client.js"
import { RequestToolMap } from "../../../helpers/request-tool-surface.js"
import { stableSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js"

const drainContext = "<papercut_backlog>one private drain item</papercut_backlog>"
const temporaryDirectory = temporaryDirectories()

function captureClient(requests: ConversationMessage[][], failure?: Error, abort?: AbortController) {
  return asModelClient({
    accessProvider: "anthropic_api",
    modelFamily: "anthropic",
    model: "test-model",
    contextLimit: 100_000,
    outputLimit: 8_000,
    supportsReasoning: false,
    priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" } as const),
    async *streamWithTools(options: StreamOptions): AsyncGenerator<ProviderStreamEvent> {
      requests.push(JSON.parse(JSON.stringify(options.messages)))
      abort?.abort()
      if (failure) throw failure
      yield { kind: "done", stopReason: "end_turn" }
    },
  })
}

async function run(mailbox: ChatTurnMailbox, client: ReturnType<typeof captureClient>, history: ConversationMessage[], signal?: AbortSignal): Promise<void> {
  await runAgentLoop({
    client,
    tools: new RequestToolMap(),
    systemPrompt: stableSystemPrompt("test"),
    instruction: "survey the backlog",
    executionCwd: "/scratch",
    userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
    providerSessionKey: "papercut-drain-context", promptCacheKey: "papercut-drain-context",
    artifactScopeId: "papercut-drain-context",
    retrievalSessionId: "papercut-drain-context",
    inputSource: mailbox,
    completeOnIdle: {},
    signal,
    persistence: { history: { append: (message) => { history.push(JSON.parse(JSON.stringify(message))) } } },
    seed: { kind: "fresh" },
    onEvent: () => {},
  })
}

function requestContains(messages: readonly ConversationMessage[], text: string): boolean {
  return messages.some((message) => message.kind === "user" && message.content === text)
}

describe("papercut drain request context", () => {
  test("excludes an append after the backlog ceiling is captured and includes it in the next drain", async () => {
    const store = createSqliteEventStore(join(temporaryDirectory("papercut-drain-"), "events.sqlite"))
    const record = (observation: string) => store.append({
      aggregateId: "session:owner", type: "papercut.recorded", version: 1,
      timestamp: 1, actor: "agent", sessionId: "owner",
      payload: { observation, conversationId: "conversation", modelRequestId: "request", toolUseId: "tool" },
    })
    try {
      for (let index = 0; index < 257; index++) record(`Captured observation ${index}`)
      const local = asAsyncEventReadSurface(store)
      let appended = false
      const reader = {
        ...local,
        readPage: async (...args: Parameters<typeof local.readPage>) => {
          const page = await local.readPage(...args)
          if (!appended) {
            appended = true
            record("Late observation")
          }
          return page
        },
      }
      const allOn = async () => () => true
      const first = await buildPapercutDrain(reader, "drain-session", allOn)
      expect(first.kind).toBe("ready")
      if (first.kind !== "ready") throw new Error("expected ready drain")
      expect(first.context).toContain("Captured observation 0")
      expect(first.context).toContain("Captured observation 256")
      expect(first.context).not.toContain("Late observation")
      const next = await buildPapercutDrain(reader, "drain-session", allOn)
      expect(next.kind).toBe("ready")
      if (next.kind !== "ready") throw new Error("expected ready drain")
      expect(next.context).toContain("Late observation")
    } finally {
      store.close()
    }
  })

  test("keeps the durable invocation and private context indivisible across drain and recall", () => {
    const mailbox = new ChatTurnMailbox()
    mailbox.enqueueRequestWithContext({ text: "Run the project papercut campaign.", invocation: { label: "/papercuts" } }, drainContext)

    expect(mailbox.hasPendingUserMessage).toBe(true)
    expect(mailbox.drainUserMessages()).toEqual([])
    expect(mailbox.withdrawHuman()).toBeNull()
    expect(mailbox.drainPending()).toEqual({
      kind: "request-context",
      text: drainContext,
      input: { kind: "message", text: "Run the project papercut campaign.", invocation: { label: "/papercuts" } },
    })
  })

  test("is sent once without a durable copy or rebuilt-runner leakage", async () => {
    const mailbox = new ChatTurnMailbox()
    const history: ConversationMessage[] = []
    const firstRequests: ConversationMessage[][] = []
    mailbox.enqueueRequestWithContext({ text: "Run the project papercut campaign.", invocation: { label: "/papercuts" } }, drainContext)

    await run(mailbox, captureClient(firstRequests), history)

    expect(firstRequests).toHaveLength(1)
    expect(requestContains(firstRequests[0] ?? [], drainContext)).toBe(true)
    expect(requestContains(history, drainContext)).toBe(false)
    expect(requestContains(history, "Run the project papercut campaign.")).toBe(true)

    const laterRequests: ConversationMessage[][] = []
    await run(mailbox, captureClient(laterRequests), history)
    expect(requestContains(laterRequests[0] ?? [], drainContext)).toBe(false)
  })

  test("does not retry request context after provider failure", async () => {
    const mailbox = new ChatTurnMailbox()
    const history: ConversationMessage[] = []
    const failedRequests: ConversationMessage[][] = []
    mailbox.enqueueRequestWithContext({ text: "Run the project papercut campaign.", invocation: { label: "/papercuts" } }, drainContext)

    await expect(run(mailbox, captureClient(failedRequests, new Error("provider failed")), history)).rejects.toThrow("provider failed")
    expect(requestContains(failedRequests[0] ?? [], drainContext)).toBe(true)

    const retryRequests: ConversationMessage[][] = []
    await run(mailbox, captureClient(retryRequests), history)
    expect(requestContains(retryRequests[0] ?? [], drainContext)).toBe(false)
  })

  test("does not retry request context after interruption", async () => {
    const mailbox = new ChatTurnMailbox()
    const history: ConversationMessage[] = []
    const interruptedRequests: ConversationMessage[][] = []
    const abort = new AbortController()
    mailbox.enqueueRequestWithContext({ text: "Run the project papercut campaign.", invocation: { label: "/papercuts" } }, drainContext)

    await run(mailbox, captureClient(interruptedRequests, undefined, abort), history, abort.signal)
    expect(requestContains(interruptedRequests[0] ?? [], drainContext)).toBe(true)

    const laterRequests: ConversationMessage[][] = []
    await run(mailbox, captureClient(laterRequests), history)
    expect(requestContains(laterRequests[0] ?? [], drainContext)).toBe(false)
  })
})
