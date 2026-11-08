import { describe, expect, it } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { createSessionDetailProjection } from "../../../../src/orchestration/app-service/session-detail-projection.js"
import { createOutputSession } from "../../../../src/orchestration/runner/output-session.js"
import { createConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle.js"
import { tailRequest } from "./_output-projection-fixtures.js"
import { blockIdentity } from "../../../../src/protocol/block-identity.js"
import { handleStreamEvent, type AssistantTurnResult } from "../../../../src/orchestration/agent-runtime/assistant-turn-result.js"
import { emitAgentStreamEvent } from "../../../../src/orchestration/agent-runtime/runner-stream-events.js"
import { createThinkingAccumulator, emitTurnAssistant } from "../../../../src/orchestration/agent-runtime/emit.js"
import { createTurnUsageTracker } from "../../../../src/orchestration/agent-runtime/turn-usage-tracker.js"
import type { ProviderStreamEvent } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import type { RuntimeEvent } from "../../../../src/infra/runtime-event-types.js"
import { RequestToolMap } from "../../../helpers/request-tool-surface.js"

describe("live/derived output equivalence", () => {
  it("numbers a streamed turn with thinking, a progress update, and tools the same live and durable", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "flywheel-output-coordinates-"))
    const store = createSqliteEventStore(join(tmpDir, "flywheel.sqlite"))
    const sessionId = "coordinates-session"
    const conversationId = "coordinates-conversation"
    const live = createOutputSession({ updateEntry: () => {}, sessionId, executionCwd: realpathSync(tmpDir) })
    try {
      const tree = await createConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
      const allocate = () => tree.getStorage().allocateId()
      const [userId, firstId, readResultId, bashResultId, secondId] = [await allocate(), await allocate(), await allocate(), await allocate(), await allocate()]
      const delta = (blockKey: string, data: { type: string, thinking?: string, text?: string, presentation?: "progress", provisional_block_key?: string }) =>
        live.dispatchRuntimeEvent({ type: "model.content.delta", data: { delta: data, block_key: blockKey } })
      const firstStep = [
        { type: "thinking" as const, thinking: "Weigh the options.", signature: "c2lnLTE=" },
        { type: "thinking" as const, thinking: "Reading the config first.", signature: "c2lnLTI=", presentation: "progress" as const },
        { type: "text" as const, text: "Checking the file." },
        { type: "tool_use" as const, id: "read-1", name: "read", input: { path: "src/example.ts" } },
        { type: "tool_use" as const, id: "bash-1", name: "bash", input: { command: "bun test" } },
      ]
      const secondStep = [
        { type: "thinking" as const, thinking: "The tests pass.", signature: "c2lnLTM=" },
        { type: "text" as const, text: "Done." },
      ]
      // The events the runner emits for one provider stream: a thought streams
      // under its provisional key and settles under its canonical one, a
      // progress update streams as text, and public text streams canonically.
      live.pushUserMessage("check it", 1_000, { entryId: userId })
      live.dispatchRuntimeEvent({ type: "agent.provider_response.started", data: {} })
      delta("run-1:0", { type: "thinking_delta", thinking: "Weigh the " })
      delta("run-1:0", { type: "thinking_delta", thinking: "options." })
      delta(`${firstId}:0`, { type: "thinking_complete", thinking: "Weigh the options.", provisional_block_key: "run-1:0" })
      delta(`${firstId}:1`, { type: "thinking_delta", thinking: "Reading the config first.", presentation: "progress" })
      live.dispatchRuntimeEvent({ type: "model.text.completed", data: { block_key: `${firstId}:1` } })
      delta(`${firstId}:2`, { type: "text_delta", text: "Checking the file." })
      live.dispatchRuntimeEvent({ type: "tool.input.completed", data: { tool_use: { id: "read-1", name: "read", input: { path: "src/example.ts" } }, block_key: `${firstId}:3` } })
      live.dispatchRuntimeEvent({ type: "tool.input.completed", data: { tool_use: { id: "bash-1", name: "bash", input: { command: "bun test" } }, block_key: `${firstId}:4` } })
      live.dispatchRuntimeEvent({ type: "model.assistant_message.recorded", data: { entry_id: firstId, message: { content: firstStep } } })
      live.dispatchRuntimeEvent({ type: "tool.result.recorded", data: { tool_use_id: "read-1", content: [{ type: "text", text: "export const value = 1" }] } })
      live.dispatchRuntimeEvent({ type: "tool.result.recorded", data: { tool_use_id: "bash-1", content: [{ type: "text", text: "1 pass" }] } })
      live.dispatchRuntimeEvent({ type: "agent.provider_response.started", data: {} })
      delta("run-2:0", { type: "thinking_delta", thinking: "The tests pass." })
      delta(`${secondId}:0`, { type: "thinking_complete", thinking: "The tests pass.", provisional_block_key: "run-2:0" })
      delta(`${secondId}:1`, { type: "text_delta", text: "Done." })
      live.dispatchRuntimeEvent({ type: "model.assistant_message.recorded", data: { entry_id: secondId, message: { content: secondStep } } })
      live.endTurn("completed")
      live.flush()

      const appended = await tree.appendMessages([
        { kind: "user", content: "check it" },
        { kind: "assistant", content: firstStep },
        { kind: "toolResult", toolUseId: "read-1", content: [{ type: "text", text: "export const value = 1" }] },
        { kind: "toolResult", toolUseId: "bash-1", content: [{ type: "text", text: "1 pass" }] },
        { kind: "assistant", content: secondStep },
      ], [userId, firstId, readResultId, bashResultId, secondId])
      if (appended.kind !== "committed") throw new Error("expected durable coordinate messages")
      tree.getStorage().dispose()

      const projection = createSessionDetailProjection({
        projectRoot: tmpDir,
        sessionStore: { get: () => undefined },
        manager: { read: async () => ({ label: "Coordinates", lastUpdated: "2026-01-01T00:00:00.000Z", lifecycleState: "inactive" as const, name: "Coordinates", kind: "chat" as const, command: "chat" as const, conversationId, executionCwd: realpathSync(tmpDir) }) },
        reader: asAsyncEventReadSurface(store),
        projectionReader: asAsyncEventReadSurface(store),
      })
      const durable = await projection.outputRange(sessionId, tailRequest)
      if (durable.kind !== "ok") throw new Error("expected durable coordinate range")

      const liveIdentities = live.getBlocks().map(blockIdentity)
      expect(liveIdentities).toEqual([
        `userMessage:${userId}`, `thinking:${firstId}:0`, `text:${firstId}:1`, `text:${firstId}:2`, "tool:read-1", "tool:bash-1", `thinking:${secondId}:0`, `text:${secondId}:1`,
      ])
      expect(durable.blocks.map(blockIdentity)).toEqual(liveIdentities)
      expect(durable.blocks.filter((block) => block.kind === "thinking").map((block) => block.status)).toEqual(["completed", "completed"])
    } finally {
      live.dispose()
      store.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("numbers an OpenAI Responses turn with summarized, raw, unpersisted, interrupted, and failed reasoning the same live and durable", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "flywheel-output-reasoning-coordinates-"))
    const store = createSqliteEventStore(join(tmpDir, "flywheel.sqlite"))
    const sessionId = "reasoning-coordinates-session"
    const conversationId = "reasoning-coordinates-conversation"
    const live = createOutputSession({ updateEntry: () => {}, sessionId, executionCwd: realpathSync(tmpDir) })
    try {
      const tree = await createConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
      const allocate = () => tree.getStorage().allocateId()
      const [userId, summarizedId, resultId, rawId, nextUserId, unpersistedId, thinkOnlyUserId, interruptedUserId, failedUserId] = [await allocate(), await allocate(), await allocate(), await allocate(), await allocate(), await allocate(), await allocate(), await allocate(), await allocate()]
      const context = {
        options: { onEvent: (event: RuntimeEvent) => live.dispatchRuntimeEvent(event) },
        contextWindow: 200_000,
        costTracker: createTurnUsageTracker({ emit: () => {}, budgetStreamId: "reasoning-coordinates" }),
        providerSessionKey: "reasoning-coordinates",
        parentToolUseId: undefined,
        thinking: createThinkingAccumulator(),
        tools: new RequestToolMap(),
      }
      // One provider response as the Responses adapter yields it: the runner
      // reduces each event into the turn and emits its runtime events.
      const respond = (entryId: string, events: readonly ProviderStreamEvent[]) => {
        const turn: AssistantTurnResult = {
          entryId, outcome: { kind: "ok", stopReason: "unknown" }, assistantContent: [], toolCalls: [],
          assistantMetadata: undefined, lastAssistantMetadata: undefined, usageAnchor: undefined, terminalEvent: undefined, transportContext: undefined,
        }
        for (const event of events) {
          const published = handleStreamEvent(event, turn)
          // The turn reports its terminal event after settlement, and the
          // runtime assembly intercepts the retry and notice kinds.
          if (published.kind === "done" || published.kind === "stream_retry" || published.kind === "stream_resample" || published.kind === "stream_attempt_start" || published.kind === "provider_status") continue
          emitAgentStreamEvent(published, context)
        }
        emitTurnAssistant(context.options.onEvent, turn.assistantContent, context.costTracker, undefined, entryId)
        if (turn.terminalEvent) emitAgentStreamEvent(turn.terminalEvent, context)
        return turn.assistantContent
      }
      const reasoningItem = (runId: string, id: string, deltas: readonly string[], persisted: Omit<Extract<ProviderStreamEvent, { kind: "reasoning" }>, "kind" | "id" | "blockKey"> | undefined): ProviderStreamEvent[] => [
        { kind: "thinking_delta", text: "", blockKey: `${runId}:0` },
        ...deltas.map((text) => ({ kind: "thinking_delta" as const, text, blockKey: `${runId}:0` })),
        { kind: "thinking_complete", thinking: deltas.join(""), blockKey: `${runId}:0` },
        ...(persisted ? [{ kind: "reasoning" as const, id, blockKey: `${runId}:0`, ...persisted }] : []),
      ]
      const answer = (runId: string, text: string): ProviderStreamEvent[] => [
        { kind: "text_delta", text, blockKey: `${runId}:1` },
        { kind: "text_terminal", content: text, blockKey: `${runId}:1` },
        { kind: "text_complete", blockKey: `${runId}:1` },
      ]

      live.pushUserMessage("check it", 1_000, { entryId: userId })
      live.dispatchRuntimeEvent({ type: "agent.provider_response.started", data: {} })
      const summarized = respond(summarizedId, [
        { kind: "provider_response_started" },
        ...reasoningItem("run-1", "rs_1", ["Inspecting ", "events", "\n\n"], { encryptedContent: "ENC1", summary: [{ type: "summary_text", text: "Inspecting events" }] }),
        { kind: "tool_input_start", toolUseId: "read-1", name: "read" },
        { kind: "tool_use", toolCall: { id: "read-1", name: "read", input: { path: "src/example.ts" } } },
        { kind: "done", stopReason: "tool_use" },
      ])
      live.dispatchRuntimeEvent({ type: "tool.result.recorded", data: { tool_use_id: "read-1", content: [{ type: "text", text: "export const value = 1" }] } })
      // Raw reasoning text is shown while it streams but is not part of the
      // persisted item, and an item without encrypted content persists nothing.
      const raw = respond(rawId, [{ kind: "provider_response_started" }, ...reasoningItem("run-2", "rs_2", ["Raw chain"], { encryptedContent: "ENC2" }), ...answer("run-2", "Checked."), { kind: "done", stopReason: "end_turn" }])
      live.pushUserMessage("and again", 2_000, { entryId: nextUserId })
      const unpersisted = respond(unpersistedId, [{ kind: "provider_response_started" }, ...reasoningItem("run-3", "rs_3", ["Hidden chain"], undefined), ...answer("run-3", "Done."), { kind: "done", stopReason: "end_turn" }])
      // A response that persists no part records no assistant message, so its
      // terminal event is the one that ends it: completed with only
      // unpersisted reasoning, interrupted while the reasoning streams, or
      // failed with no other candidate to replace it. A tool call whose input
      // never completed persists no part either, so its preview row goes too.
      live.pushUserMessage("think only", 3_000, { entryId: thinkOnlyUserId })
      respond("empty-response", [{ kind: "provider_response_started" }, ...reasoningItem("run-4", "rs_4", ["Thinking only"], undefined), { kind: "done", stopReason: "end_turn" }])
      live.endTurn("completed")
      live.pushUserMessage("stop soon", 4_000, { entryId: interruptedUserId })
      respond("interrupted-response", [{ kind: "provider_response_started" }, { kind: "thinking_delta", text: "Half a ", blockKey: "run-5:0" }, { kind: "tool_input_start", toolUseId: "half-5", name: "read" }, { kind: "tool_input_delta", toolUseId: "half-5", partialJson: "{\"path\":" }])
      live.endTurn("paused")
      emitAgentStreamEvent({ kind: "stream_abandoned", reason: "interrupted" }, context)
      live.pushUserMessage("fail now", 5_000, { entryId: failedUserId })
      respond("failed-response", [{ kind: "provider_response_started" }, { kind: "thinking_delta", text: "Before the ", blockKey: "run-6:0" }, { kind: "thinking_complete", thinking: "Before the error", blockKey: "run-6:0" }, { kind: "tool_input_start", toolUseId: "half-6", name: "read" }, { kind: "tool_input_delta", toolUseId: "half-6", partialJson: "{\"path\":" }])
      emitAgentStreamEvent({ kind: "stream_abandoned", reason: "failed" }, context)
      live.endTurn("completed")
      live.flush()

      const appended = await tree.appendMessages([
        { kind: "user", content: "check it" },
        { kind: "assistant", content: summarized },
        { kind: "toolResult", toolUseId: "read-1", content: [{ type: "text", text: "export const value = 1" }] },
        { kind: "assistant", content: raw },
        { kind: "user", content: "and again" },
        { kind: "assistant", content: unpersisted },
        { kind: "user", content: "think only" },
        { kind: "user", content: "stop soon" },
        { kind: "user", content: "fail now" },
      ], [userId, summarizedId, resultId, rawId, nextUserId, unpersistedId, thinkOnlyUserId, interruptedUserId, failedUserId])
      if (appended.kind !== "committed") throw new Error("expected durable reasoning messages")
      tree.getStorage().dispose()

      const projection = createSessionDetailProjection({
        projectRoot: tmpDir,
        sessionStore: { get: () => undefined },
        manager: { read: async () => ({ label: "Reasoning", lastUpdated: "2026-01-01T00:00:00.000Z", lifecycleState: "inactive" as const, name: "Reasoning", kind: "chat" as const, command: "chat" as const, conversationId, executionCwd: realpathSync(tmpDir) }) },
        reader: asAsyncEventReadSurface(store),
        projectionReader: asAsyncEventReadSurface(store),
      })
      const durable = await projection.outputRange(sessionId, tailRequest)
      if (durable.kind !== "ok") throw new Error("expected durable reasoning range")

      const liveBlocks = live.getBlocks()
      expect(liveBlocks.map(blockIdentity)).toEqual([`userMessage:${userId}`, `thinking:${summarizedId}:0`, "tool:read-1", `text:${rawId}:1`, `userMessage:${nextUserId}`, `text:${unpersistedId}:0`, `userMessage:${thinkOnlyUserId}`, `userMessage:${interruptedUserId}`, `userMessage:${failedUserId}`])
      expect(durable.blocks.map(blockIdentity)).toEqual(liveBlocks.map(blockIdentity))
      const thought = (blocks: readonly { kind: string }[]) => blocks.flatMap((block) => "content" in block && block.kind === "thinking" ? [block.content] : [])
      expect(thought(liveBlocks)).toEqual(["Inspecting events"])
      expect(thought(durable.blocks)).toEqual(thought(liveBlocks))
    } finally {
      live.dispose()
      store.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
