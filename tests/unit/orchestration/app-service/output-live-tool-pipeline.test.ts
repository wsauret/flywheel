import { describe, expect, it } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { blockIdentity } from "../../../../src/protocol/block-identity.js"
import { createSessionDetailProjection } from "../../../../src/orchestration/app-service/session-detail-projection.js"
import { createOutputSession } from "../../../../src/orchestration/runner/output-session.js"
import { createConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle.js"
import { createThinkingAccumulator, emitTurnAssistant } from "../../../../src/orchestration/agent-runtime/emit.js"
import { emitAgentStreamEvent } from "../../../../src/orchestration/agent-runtime/runner-stream-events.js"
import { createTurnUsageTracker } from "../../../../src/orchestration/agent-runtime/turn-usage-tracker.js"
import type { AgentOptions } from "../../../../src/orchestration/agent-runtime/types.js"
import { RequestToolMap } from "../../../helpers/request-tool-surface.js"
import { unusedSessionMessaging } from "../../../helpers/child-session-control.js"
import { observeSessionRun } from "../../../../src/orchestration/agent-runtime/session-run-observation.js"
import { tailRequest } from "./_output-projection-fixtures.js"

describe("live/derived tool pipeline equivalence", () => {
  it("keeps one settled tool row between text runs when the canonical assistant is published", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "flywheel-tool-output-equivalence-"))
    const store = createSqliteEventStore(join(tmpDir, "flywheel.sqlite"))
    const sessionId = "tool-pipeline-session"
    const conversationId = "tool-pipeline-conversation"
    const live = createOutputSession({ updateEntry: () => {}, sessionId, executionCwd: realpathSync(tmpDir) })
    try {
      const tree = await createConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
      const entryId = await tree.getStorage().allocateId()
      const resultEntryId = await tree.getStorage().allocateId()
      const afterEntryId = await tree.getStorage().allocateId()
      const onEvent: AgentOptions["onEvent"] = event => { live.dispatchRuntimeEvent(event) }
      const costTracker = createTurnUsageTracker({ emit: onEvent, budgetStreamId: "test" })
      const context: Parameters<typeof emitAgentStreamEvent>[1] = {
        options: { onEvent },
        tools: new RequestToolMap(),
        costTracker,
        thinking: createThinkingAccumulator(),
        parentToolUseId: undefined,
        contextWindow: 200_000,
        providerSessionKey: "test",
      }
      const toolCall = { id: "list-1", name: "list", input: { path: "." } }
      const content = [
        { type: "text" as const, text: "BEFORE" },
        { type: "tool_use" as const, ...toolCall },
      ]
      emitAgentStreamEvent({ kind: "provider_response_started" }, context)
      emitAgentStreamEvent({ kind: "text_delta", text: "BEFORE", blockKey: `${entryId}:0` }, context)
      emitAgentStreamEvent({ kind: "text_complete", blockKey: `${entryId}:0` }, context)
      emitAgentStreamEvent({ kind: "tool_input_start", toolUseId: toolCall.id, name: toolCall.name }, context)
      emitAgentStreamEvent({ kind: "tool_input_delta", toolUseId: toolCall.id, partialJson: JSON.stringify(toolCall.input) }, context)
      emitAgentStreamEvent({ kind: "tool_use", toolCall, outputIdentity: { entryId, blockKey: `${entryId}:1` } }, context)
      emitAgentStreamEvent({ kind: "tool_result_available", toolUseId: toolCall.id, content: [{ type: "text", text: "src/\ntests/" }], outcome: "ok" }, context)
      const toolBeforeFinal = live.getBlocks().find(block => block.kind === "tool")
      const observed = await observeSessionRun({
        sessionId,
        onTurnAssistantMessage: (parts, id) => emitTurnAssistant(onEvent, parts, costTracker, undefined, id),
      }, { kind: "interactive-chat" }, {
        ...unusedSessionMessaging(),
        observeRun: async () => ({ resumed: () => {}, yielded: async () => {}, changed: async () => {} }),
      })
      observed.loopOptions.onTurnAssistantMessage?.(content, entryId)
      expect(live.getBlocks().find(block => block.kind === "tool")).toEqual(toolBeforeFinal)
      emitAgentStreamEvent({ kind: "tool_result", toolUseId: toolCall.id, content: [{ type: "text", text: "src/\ntests/" }], outcome: "ok" }, context)
      emitAgentStreamEvent({ kind: "provider_response_started" }, context)
      emitAgentStreamEvent({ kind: "text_delta", text: "AFTER", blockKey: `${afterEntryId}:0` }, context)
      emitAgentStreamEvent({ kind: "text_complete", blockKey: `${afterEntryId}:0` }, context)
      observed.loopOptions.onTurnAssistantMessage?.([{ type: "text", text: "AFTER" }], afterEntryId)
      live.endTurn("completed")
      live.flush()
      expect(live.getBlocks().filter(block => block.kind === "tool").map(block => block.id)).toEqual([toolCall.id])
      expect(live.getBlocks().find(block => block.kind === "tool")).toEqual(toolBeforeFinal)

      await tree.appendMessages([
        { kind: "assistant", content },
        { kind: "toolResult", toolUseId: toolCall.id, content: [{ type: "text", text: "src/\ntests/" }] },
        { kind: "assistant", content: [{ type: "text", text: "AFTER" }] },
      ], [entryId, resultEntryId, afterEntryId])
      tree.getStorage().dispose()
      const projection = createSessionDetailProjection({
        projectRoot: tmpDir,
        sessionStore: { get: () => undefined },
        manager: { read: async () => ({ label: "Pipeline", lastUpdated: "2026-01-01T00:00:00.000Z", lifecycleState: "inactive" as const, name: "Pipeline", kind: "chat" as const, command: "chat" as const, conversationId, executionCwd: tmpDir }) },
        reader: asAsyncEventReadSurface(store),
        projectionReader: asAsyncEventReadSurface(store),
      })
      const durable = await projection.outputRange(sessionId, tailRequest)
      if (durable.kind !== "ok") throw new Error("expected durable tool pipeline range")
      expect(live.getBlocks().map(blockIdentity)).toEqual(durable.blocks.map(blockIdentity))
      expect(durable.blocks.filter(block => block.kind === "tool")).toMatchObject([{ id: toolCall.id, name: "list", status: "completed" }])
      expect(live.getBlocks().filter(block => block.kind === "text").map(block => block.content))
        .toEqual(durable.blocks.filter(block => block.kind === "text").map(block => block.content))
    } finally {
      store.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
