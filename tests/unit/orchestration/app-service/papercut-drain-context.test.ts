import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { asAsyncEventReadSurface } from "../../../../src/infra/store/event-store-types.js"
import { createSqliteEventStore } from "../../../../src/infra/store/sqlite-event-store.js"
import { buildPapercutDrain } from "../../../../src/orchestration/modules/papercuts/drain.js"
import { temporaryDirectories } from "../../../helpers/directories.js"

import type { ProviderStreamEvent, StreamOptions } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import type { ConversationMessage } from "../../../../src/infra/llm/conversation/conversation-message.js"
import { runAgentLoop } from "../../../../src/orchestration/agent-runtime/loop/agent-loop.js"
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

/** A rebuilt runner of the same turn: it resumes the recorded history with the turn's context. */
type NextLife = { readonly priorMessages: ConversationMessage[]; readonly context: string }

async function run(mailbox: ChatTurnMailbox, client: ReturnType<typeof captureClient>, history: ConversationMessage[], signal?: AbortSignal, life?: NextLife): Promise<void> {
  await runAgentLoop({
    client,
    tools: new RequestToolMap(),
    systemPrompt: stableSystemPrompt("test"),
    instruction: life ? null : "survey the backlog",
    executionCwd: "/scratch",
    userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
    providerSessionKey: "papercut-drain-context", promptCacheKey: "papercut-drain-context",
    artifactScopeId: "papercut-drain-context",
    retrievalSessionId: "papercut-drain-context",
    inputSource: mailbox,
    completeOnIdle: {},
    signal,
    persistence: { history: { append: (message) => { history.push(JSON.parse(JSON.stringify(message))) } } },
    seed: life ? { kind: "resume", priorMessages: life.priorMessages } : { kind: "fresh" },
    ...(life ? { initialRequestContext: life.context } : {}),
    onEvent: () => {},
  })
}

function copiesOf(messages: readonly ConversationMessage[], text: string): ConversationMessage[] {
  return messages.filter((message) => message.kind === "user" && message.content === text)
}

function requestContains(messages: readonly ConversationMessage[], text: string): boolean {
  return copiesOf(messages, text).length > 0
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

  test("is recorded once as hidden turn context, sent in place, and neither copied by a rebuilt runner nor leaked to a later one", async () => {
    const mailbox = new ChatTurnMailbox()
    const history: ConversationMessage[] = []
    const firstRequests: ConversationMessage[][] = []
    mailbox.enqueueRequestWithContext({ text: "Run the project papercut campaign.", invocation: { label: "/papercuts" } }, drainContext)

    await run(mailbox, captureClient(firstRequests), history)

    const recorded: ConversationMessage = { kind: "user", content: drainContext, origin: "system", framing: "turn-context" }
    expect(firstRequests).toHaveLength(1)
    expect(copiesOf(history, drainContext)).toEqual([recorded])
    expect(copiesOf(firstRequests[0] ?? [], drainContext)).toEqual([recorded])
    expect(requestContains(history, "Run the project papercut campaign.")).toBe(true)

    // A rebuilt runner of the same turn resumes the recorded history with the same context and records no second copy.
    const rebuiltHistory: ConversationMessage[] = []
    const rebuiltRequests: ConversationMessage[][] = []
    await run(new ChatTurnMailbox(), captureClient(rebuiltRequests), rebuiltHistory, undefined, { priorMessages: [...history], context: drainContext })
    expect(rebuiltRequests.length).toBeGreaterThan(0)
    for (const request of rebuiltRequests) expect(copiesOf(request, drainContext)).toEqual([recorded])
    expect(copiesOf(rebuiltHistory, drainContext)).toEqual([])

    // A later runner of the drained mailbox starts without the context.
    const laterRequests: ConversationMessage[][] = []
    await run(mailbox, captureClient(laterRequests), [])
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
