import { tmpdir } from "node:os"
import { describe, expect, it } from "bun:test"
import { captureForkMessages, createLoopUserWriter, seedResumedTurn } from "../../../../src/orchestration/agent-runtime/agent-loop-history.js"
import { emitUser } from "../../../../src/orchestration/agent-runtime/emit.js"
import type { RuntimeEvent } from "../../../../src/infra/runtime-event-types.js"
import { runAgentLoop } from "../../../../src/orchestration/agent-runtime/agent-loop.js"
import { runWithResilience } from "../../../../src/orchestration/agent-runtime/agent-resilience.js"
import { QuotaExhaustedError } from "../../../../src/orchestration/agent-runtime/llm/errors.js"
import { normalizeProviderAttemptFailure } from "../../../../src/orchestration/agent-runtime/llm/provider-failure.js"
import { FUNCTION_TOOL_PRESENTATION, type ConversationMessage, type ProviderStreamEvent, type ServingAttempt } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import type { RuntimeTool } from "../../../../src/orchestration/agent-runtime/tools/types.js"
import type { SessionNoticeOperation } from "../../../../src/infra/session-notice.js"
import { withRequestAdmission, ownHistoryTarget } from "./_model-client.js"
import { fixedRequestToolSurface, RequestToolMap } from "../../../helpers/request-tool-surface.js"
import { chain, fakeAvailability, fakeClient, subscriptionCandidate } from "./llm/_provider-chain-harness.js"
import { Redacted } from "effect"
import { createAnthropicAdapter, type AnthropicOperations } from "../../../../src/orchestration/agent-runtime/llm/anthropic.js"
import type { RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages.js"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { createConversationTreeWriterController } from "../../../../src/orchestration/chat/tree-writer.js"
import { stableSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js"

describe("captureForkMessages", () => {
  it("prefers refreshed committed history over a stale live conversation", async () => {
    const stale: ConversationMessage[] = [
      { kind: "user", content: "launch the workflow" },
      { kind: "assistant", content: [{ type: "text", text: "workflow started" }] },
      { kind: "assistant", content: [{ type: "text", text: "workflow completed" }] },
    ]
    const committed: ConversationMessage[] = [
      { kind: "user", content: "launch the workflow" },
      { kind: "assistant", content: [{ type: "text", text: "workflow started" }] },
      { kind: "user", content: "workflow finished", origin: "system" },
      { kind: "assistant", content: [{ type: "text", text: "workflow completed" }] },
    ]

    expect(await captureForkMessages(stale, async () => committed)).toEqual(committed)
  })

  it("leaves out the conversation-tier entry, which names the source session, and keeps every other entry in order", async () => {
    const tier: ConversationMessage = { kind: "user", content: "Session: source", origin: "system", framing: "agent-host" }
    const kept: ConversationMessage[] = [
      { kind: "user", content: "engine text", origin: "system", framing: "claude" },
      { kind: "user", content: "the brief" },
      { kind: "assistant", content: [{ type: "text", text: "waiting" }] },
      { kind: "user", content: "<subagent_notifications/>", origin: "system", runtimeNotice: true },
    ]
    const history = [kept[0]!, tier, ...kept.slice(1)]
    expect(await captureForkMessages(history)).toEqual(kept)
    expect(await captureForkMessages([], async () => history)).toEqual(kept)
  })
})

describe("seedResumedTurn", () => {
  it("carries the recorded message's identities through the live user event, including seeded turns", async () => {
    const events: RuntimeEvent[] = []
    const observe = (content: Parameters<typeof emitUser>[1], origin: "user" | "system", identity?: { submissionIds?: readonly string[]; dispatchIds?: readonly string[] }) => emitUser((event) => events.push(event), content, origin, undefined, identity)
    const input: ConversationMessage = { kind: "user", content: "Work.", submissionIds: ["client"], dispatchIds: ["cell"] }
    const push = createLoopUserWriter(async () => input, observe)
    await push("Work.", true, { dispatchIds: ["cell"], origin: "human", submissionIds: ["client"] })
    seedResumedTurn([input], observe)
    expect(events.flatMap((event) => event.type === "model.user_message.recorded" ? [event.data.message] : [])).toEqual([
      { content: [{ type: "text", text: "Work." }], origin: "user", submissionIds: ["client"], dispatchIds: ["cell"] },
      { content: [{ type: "text", text: "Work." }], origin: "user", submissionIds: ["client"], dispatchIds: ["cell"] },
    ])
  })
  it("echoes a seeded trailing user turn so the opening message of a life is recorded", () => {
    const messages: ConversationMessage[] = [
      { kind: "assistant", content: [{ type: "text", text: "done" }] },
      { kind: "user", content: "reply with exactly: second life works", origin: "system" },
    ]
    const echoed: unknown[] = []
    seedResumedTurn(messages, (content, origin) => echoed.push({ content, origin }))
    expect(echoed).toEqual([{ content: "reply with exactly: second life works", origin: "system" }])
  })

  it("echoes the trailing user turn past transcript-only system notices", () => {
    const messages: ConversationMessage[] = [
      { kind: "user", content: "resume question" },
      { kind: "system", content: "learning reconciliation notice" },
    ]
    const echoed: unknown[] = []
    seedResumedTurn(messages, (content, origin) => echoed.push({ content, origin }))
    expect(echoed).toEqual([{ content: "resume question", origin: "user" }])
  })

  it("stays silent when the seeded conversation does not end in a user turn", () => {
    const messages: ConversationMessage[] = [
      { kind: "user", content: "hi" },
      { kind: "assistant", content: [{ type: "text", text: "hello" }] },
    ]
    const echoed: unknown[] = []
    seedResumedTurn(messages, (content) => echoed.push(content))
    expect(echoed).toEqual([])
    seedResumedTurn([], (content) => echoed.push(content))
    expect(echoed).toEqual([])
  })
})

describe("provider cap save point", () => {
  const attempt: ServingAttempt = {
    accessProvider: "anthropic_api", modelFamily: "anthropic", model: "test-model",
    toolPresentation: FUNCTION_TOOL_PRESENTATION,
    contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: true,
    promptNotes: { progress: "", modelNotes: "" }, priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" } as const),
  }

  it("retains text-only failure through real canonical writes, replacement, and the next user turn", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "assistant-attempt-history-"))
    const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
    const writer = createConversationTreeWriterController({
      conversationId: "conversation", sessionId: "session", projectRoot, store: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store),
    })
    try {
      await writer.commitUserTurn("work")
      const initial = await writer.buildContext()
      writer.beginTurn()
      const client = chain({
        candidates: [subscriptionCandidate("chatgpt"), subscriptionCandidate("github_copilot")],
        availability: fakeAvailability({}).availability,
        subscriptionAllowanceFor: () => ({ freshness: "fresh", allowance: "finite" }),
        build: async (provider) => ({
          ...fakeClient(provider, async function* () {}),
          async *streamWithTools(options) {
            if (provider === "chatgpt") {
              yield { kind: "text_delta" as const, text: "retained partial", blockKey: "text" }
              throw normalizeProviderAttemptFailure(new QuotaExhaustedError("cap"))
            }
            const rebuilt = await writer.buildContext()
            expect(options.messages).toEqual(rebuilt.messages)
            expect(rebuilt.messages).toContainEqual(expect.objectContaining({
              kind: "assistant", incomplete: true, content: [{ type: "text", text: "retained partial" }],
            }))
            yield { kind: "text_delta" as const, text: "finished", blockKey: "text" }
            yield { kind: "done" as const, stopReason: "end_turn" as const }
          },
        }),
      })
      const result = await runAgentLoop({
        client, tools: await fixedRequestToolSurface(new RequestToolMap()), systemPrompt: () => stableSystemPrompt("test"),
        instruction: null, executionCwd: projectRoot, userDataRoot: `${projectRoot}/.test-account`, projectRoot, providerSessionKey: "conversation", promptCacheKey: "conversation",
        artifactScopeId: "session", retrievalSessionId: "session",
        persistence: { history: { append: writer.recordCanonicalMessage } },
        seed: { kind: "resume", priorMessages: [...initial.messages] }, onEvent: () => {},
        flushCanonicalMessages: writer.flushSavePoint,
      })
      expect(result).toEqual({ kind: "completed" })
      await writer.endTurn()
      await writer.commitUserTurn("next question")
      const rebuilt = await writer.buildContext()
      expect(rebuilt.messages.filter((message) => message.kind === "user").map((message) => message.content)).toEqual(["work", "next question"])
      expect(rebuilt.messages).toContainEqual(expect.objectContaining({
        kind: "assistant", incomplete: true, content: [{ type: "text", text: "retained partial" }],
      }))
    } finally {
      await writer.dispose()
      store.close()
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  it.each(["handoff", "terminate", "suspend", "staged"] as const)("applies failed-provider %s batch policy once before replacement", async (mode) => {
    const history: ConversationMessage[] = []
    const requests: ConversationMessage[][] = []
    const builds: string[] = []
    let executions = 0
    const completed = Promise.withResolvers<void>()
    const name = mode === "handoff" ? "handoff" : "probe"
    const tool: RuntimeTool = {
      name, action: "ui_meta", description: name, inputSchema: { type: "object" }, isConcurrencySafe: true,
      execute: async () => {
        executions++
        completed.resolve()
        return {
          content: "actual result", outcome: "ok",
          ...(mode === "handoff" || mode === "terminate" ? { terminate: true } : {}),
          ...(mode === "suspend" ? { suspendTurn: true as const } : {}),
          ...(mode === "staged" ? { nextUserContent: [{ type: "text" as const, text: "staged context" }] } : {}),
        }
      },
    }
    const client = chain({
      candidates: [subscriptionCandidate("chatgpt"), subscriptionCandidate("github_copilot")],
      availability: fakeAvailability({}).availability,
      subscriptionAllowanceFor: () => ({ freshness: "fresh", allowance: "finite" }),
      build: async (provider) => {
        if (provider === "chatgpt") {
          const operations: AnthropicOperations = {
            isBadRequestError: () => false,
            createStream: async () => {
              builds.push(provider)
              requests.push([])
              return {
                response: new Response(),
                data: {
                  controller: new AbortController(),
                  async *[Symbol.asyncIterator](): AsyncGenerator<RawMessageStreamEvent> {
                    yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "", citations: null } }
                    yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } }
                    yield { type: "content_block_stop", index: 0 }
                    yield { type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "", signature: "" } }
                    yield { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "signed thought" } }
                    yield { type: "content_block_delta", index: 1, delta: { type: "signature_delta", signature: "signature" } }
                    yield { type: "content_block_stop", index: 1 }
                    yield { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "executed", name, input: {}, caller: { type: "direct" } } }
                    yield { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{}" } }
                    yield { type: "content_block_stop", index: 2 }
                    await completed.promise
                    throw new QuotaExhaustedError("cap")
                  },
                },
              }
            },
          }
          return createAnthropicAdapter(Redacted.make("test-fixture"), "claude-sonnet-4", {
            refresh: async () => {},
            getProviderCatalog: () => [{
              providerId: "anthropic",
              providerName: "Anthropic",
              wireModelId: "claude-sonnet-4",
              metadata: {
              provider: "anthropic", family: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4",
              reasoning: true, toolCall: true, attachment: false, temperature: true,
              contextLimit: 200_000, outputLimit: 64_000,
              openWeights: false, cost: { input: 0, output: 0 },
              pricing: { status: "unavailable", reason: "missing-rate-card" },
              modalities: { input: ["text"], output: ["text"] },
              },
              provenance: "bundled",
              canonical: { providerId: "anthropic", modelId: "claude-sonnet-4" },
              transport: null,
            }],
            getTokenizerIdentity: () => undefined,
          }, {
            accessProvider: provider,
            operations,
            resolvedModelMetadata: {
              provider: "anthropic", family: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4",
              reasoning: true, toolCall: true, attachment: false, temperature: true,
              contextLimit: 200_000, outputLimit: 64_000, openWeights: false, cost: { input: 0, output: 0 },
              pricing: { status: "unavailable", reason: "missing-rate-card" },
              modalities: { input: ["text"], output: ["text"] },
            },
          })
        }
        return {
          ...fakeClient(provider, async function* () {}),
          async *streamWithTools(options) {
            builds.push(provider)
            requests.push(structuredClone(options.messages))
            yield { kind: "text_delta" as const, text: "finished", blockKey: "text" }
            yield { kind: "done" as const, stopReason: "end_turn" as const }
          },
        }
      },
    })
    const result = await runAgentLoop({
      client, tools: await fixedRequestToolSurface(new RequestToolMap([[name, tool]])),
      systemPrompt: () => stableSystemPrompt("test"), instruction: "work", executionCwd: tmpdir(), userDataRoot: `${tmpdir()}/.test-account`, projectRoot: tmpdir(),
      providerSessionKey: "test", promptCacheKey: "test", artifactScopeId: "test", retrievalSessionId: "test",
      persistence: { history: { append: (message) => { history.push(message) } } },
      seed: { kind: "fresh" }, onEvent: () => {}, flushCanonicalMessages: async () => {},
      ...(mode === "handoff" ? { handoff: { onContent: () => {} } } : {}),
    })
    expect(result).toEqual({ kind: mode === "suspend" ? "aborted" : "completed" })
    expect(executions).toBe(1)
    expect(builds).toEqual(mode === "staged" ? ["chatgpt", "github_copilot"] : ["chatgpt"])
    if (mode === "staged") {
      expect(requests[1]).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "assistant", incomplete: true }),
        expect.objectContaining({ kind: "toolResult", toolUseId: "executed" }),
        expect.objectContaining({ kind: "user", content: [{ type: "text", text: "staged context" }] }),
      ]))
      expect(history.filter((message) => message.kind === "toolResult")).toHaveLength(1)
      expect(history.filter((message) => message.kind === "user")).toHaveLength(2)
      const partial = history.find((message) => message.kind === "assistant")
      expect(partial).toMatchObject({ content: expect.arrayContaining([{ type: "thinking", thinking: "signed thought", signature: "signature" }]) })
    }
  })

  it("commits all partial evidence before exact settlement without a synthetic continuation", async () => {
    const order: string[] = []
    const history: ConversationMessage[] = []
    const tool: RuntimeTool = {
      name: "probe", action: "ui_meta", description: "probe", inputSchema: { type: "object" }, isConcurrencySafe: true,
      execute: async () => ({ content: "completed result", outcome: "ok" }),
    }
    const events: ProviderStreamEvent[] = [
      { kind: "text_delta", text: "visible partial", blockKey: "text:0" },
      { kind: "thinking_complete", thinking: "provider thought", signature: "signature" },
      { kind: "reasoning", id: "reasoning-1", encryptedContent: "ciphertext", blockKey: "reasoning:1" },
      { kind: "tool_use", toolCall: { id: "tool-1", name: "probe", input: {} } },
    ]
    const availability = fakeAvailability({}).availability
    const client = chain({
      candidates: ["anthropic_api"],
      availability: { ...availability, markQuotaExhausted: (candidate, reset) => {
        order.push("settle")
        return availability.markQuotaExhausted(candidate, reset)
      } },
      build: async () => ({ historyTarget: ownHistoryTarget, ...attempt, async *streamWithTools() {
        for (const event of events) yield event
        throw normalizeProviderAttemptFailure(new QuotaExhaustedError("cap"))
      } }),
    })

    await expect(runAgentLoop({
      client, tools: await fixedRequestToolSurface(new RequestToolMap([["probe", tool]])),
      systemPrompt: () => stableSystemPrompt("test"), instruction: "work", executionCwd: tmpdir(), userDataRoot: `${tmpdir()}/.test-account`, projectRoot: tmpdir(), providerSessionKey: "test", promptCacheKey: "test", artifactScopeId: "test",
      retrievalSessionId: "test",
      persistence: { history: { append: (message) => { history.push(message) } } },
      seed: { kind: "fresh" }, onEvent: () => {},
      requestAudit: {
        recordRequest: () => ({ requestId: "request-1", turn: 1 }),
        recordResponse: () => { order.push("audit") }, recordUsage: () => {},
        recordStreamStarted: () => {}, recordStreamEvent: () => {}, recordStreamCompleted: () => {},
      },
      flushCanonicalMessages: async () => { order.push("flush") },
    })).rejects.toThrow()
    expect(history.filter((message) => message.kind === "assistant")).toHaveLength(1)
    const assistant = history.find((message) => message.kind === "assistant")
    expect(assistant).toMatchObject({ kind: "assistant", incomplete: true })
    if (assistant?.kind !== "assistant" || !Array.isArray(assistant.content)) throw new Error("expected assistant blocks")
    expect(assistant.content).toEqual([
      { type: "text", text: "visible partial" },
      { type: "thinking", thinking: "provider thought", signature: "signature" },
      { type: "reasoning", id: "reasoning-1", encrypted_content: "ciphertext" },
      { type: "tool_use", id: "tool-1", name: "probe", input: {}, registrationId: "probe" },
    ])
    expect(history.some((message) => message.kind === "toolResult" && message.toolUseId === "tool-1")).toBe(true)
    const continuations = history.filter((message) => message.kind === "user" && message.content === "Inspect the committed work, do not repeat completed actions, and finish the same logical turn.")
    expect(continuations).toEqual([])
    expect(order.slice(-3)).toEqual(["flush", "audit", "settle"])
    expect(order.filter((step) => step === "settle")).toEqual(["settle"])
  })

  it("continues on the next provider without publishing a failure notice", async () => {
    const chatGptAttempt = { ...attempt, accessProvider: "chatgpt" } satisfies ServingAttempt
    const apiAttempt = { ...attempt, accessProvider: "openai_api" } satisfies ServingAttempt
    const history: ConversationMessage[] = []
    const notices: SessionNoticeOperation[] = []
    const servedBy: string[] = []
    const client = chain({
      availability: fakeAvailability({}).availability,
      build: async (provider) => {
        const servingAttempt = provider === "chatgpt" ? chatGptAttempt : apiAttempt
        return { historyTarget: ownHistoryTarget, ...servingAttempt, async *streamWithTools() {
        servedBy.push(servingAttempt.accessProvider)
        if (servingAttempt.accessProvider === "chatgpt") {
          throw normalizeProviderAttemptFailure(new QuotaExhaustedError("usage limit reached"))
        }
        yield { kind: "text_delta", text: "completed on api", blockKey: "text:0" }
        yield { kind: "done", stopReason: "end_turn" }
        } }
      },
    })

    const result = await runWithResilience(
      async ({ isRetry }) => ({ servedRequests: 0,
        durationMs: 0,
        terminal: await runAgentLoop({
          client,
          tools: await fixedRequestToolSurface(new RequestToolMap()),
          systemPrompt: () => stableSystemPrompt("test"),
          instruction: "work",
          executionCwd: tmpdir(),
          userDataRoot: `${tmpdir()}/.test-account`, projectRoot: tmpdir(),
          providerSessionKey: "test", promptCacheKey: "test",
          artifactScopeId: "test",
          retrievalSessionId: "test",
          persistence: { history: { append: (message) => { history.push(message) } } },
          seed: isRetry ? { kind: "resume", priorMessages: history } : { kind: "fresh" },
          onEvent: () => {},
          requestAudit: {
            recordRequest: ({ requestId, turn }) => ({ requestId, turn }),
            recordResponse: () => {},
            recordUsage: () => {},
            recordStreamStarted: () => {},
            recordStreamEvent: () => {},
            recordStreamCompleted: () => {},
          },
          flushCanonicalMessages: async () => {},
        }),
      }),
      {
        setConnectionState: () => {},
        pushSystemMessage: () => {},
        onNotice: (operation) => { notices.push(operation) },
      },
    )

    expect(result.terminal).toEqual({ kind: "completed" })
    expect(servedBy).toEqual(["chatgpt", "openai_api"])
    expect(notices.filter((operation) => operation.type === "upsert")).toEqual([])
    expect(history.some((message) => message.kind === "assistant" && Array.isArray(message.content) && message.content.some((block) => block.type === "text" && block.text === "completed on api"))).toBe(true)
  })

  it("does not append a provider-cap continuation after restart", async () => {
    const continuation = "Inspect the committed work, do not repeat completed actions, and finish the same logical turn."
    const history: ConversationMessage[] = [
      { kind: "user", content: "work" },
      { kind: "assistant", content: [{ type: "text", text: "partial" }], incomplete: true },
      { kind: "user", origin: "system", content: continuation },
    ]
    const client = withRequestAdmission({
      ...attempt,
      plannedAttempt: async () => attempt,
      async *streamWithTools() {
        yield { kind: "text_delta", text: "more partial evidence", blockKey: "text:0" }
        throw new QuotaExhaustedError("cap")
      },
    })

    await expect(runAgentLoop({
      client, tools: await fixedRequestToolSurface(new RequestToolMap()),
      systemPrompt: () => stableSystemPrompt("test"), instruction: null, executionCwd: tmpdir(), userDataRoot: `${tmpdir()}/.test-account`, projectRoot: tmpdir(), providerSessionKey: "test", promptCacheKey: "test", artifactScopeId: "test",
      retrievalSessionId: "test",
      persistence: { history: { append: (message) => { history.push(message) } } },
      seed: { kind: "resume", priorMessages: history }, onEvent: () => {},
      flushCanonicalMessages: async () => {},
    })).rejects.toThrow()
    expect(history.filter((message) => message.kind === "user" && message.content === continuation)).toHaveLength(1)
  })

  it("does not redispatch a completed historical tool exchange after resume", async () => {
    let executions = 0
    let requested: ConversationMessage[] = []
    const tool: RuntimeTool = {
      name: "probe", action: "ui_meta", description: "probe", inputSchema: { type: "object" }, isConcurrencySafe: true,
      execute: async () => { executions += 1; return { content: "unexpected", outcome: "ok" } },
    }
    const history: ConversationMessage[] = [
      { kind: "user", content: "inspect the repository" },
      { kind: "assistant", content: [{ type: "tool_use", id: "historical-tool", name: "probe", input: {} }] },
      { kind: "toolResult", toolUseId: "historical-tool", content: [{ type: "text", text: "recorded result" }] },
      { kind: "user", content: "continue from the recorded result" },
    ]
    const client = withRequestAdmission({
      ...attempt,
      plannedAttempt: async () => attempt,
      async *streamWithTools(options) {
        requested = [...options.messages]
        throw new QuotaExhaustedError("cap")
      },
    })

    await expect(runAgentLoop({
      client, tools: await fixedRequestToolSurface(new RequestToolMap([["probe", tool]])),
      systemPrompt: () => stableSystemPrompt("test"), instruction: null, executionCwd: tmpdir(), userDataRoot: `${tmpdir()}/.test-account`, projectRoot: tmpdir(), providerSessionKey: "test", promptCacheKey: "test", artifactScopeId: "test",
      retrievalSessionId: "test",
      persistence: { history: { append: (message) => { history.push(message) } } },
      seed: { kind: "resume", priorMessages: history }, onEvent: () => {},
      flushCanonicalMessages: async () => {},
    })).rejects.toThrow()
    expect(executions).toBe(0)
    expect(requested).toEqual([
      { kind: "user", content: "inspect the repository" },
      {
        kind: "assistant",
        content: [{
          type: "text",
          text: "Earlier operation historical-tool: A prior operation used a tool contract that is not available in this request. The incompatible invocation is omitted.",
        }],
      },
      {
        kind: "user",
        origin: "system",
        content: [
          { type: "text", text: "Earlier operation historical-tool result:" },
          { type: "text", text: "recorded result" },
        ],
      },
      { kind: "user", content: "continue from the recorded result" },
    ])
  })
})
