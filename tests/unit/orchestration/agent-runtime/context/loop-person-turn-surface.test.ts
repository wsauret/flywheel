import { describe, expect, it } from "bun:test"

import { compactInput, messageInput, type AgentLoopInput } from "../../../../../src/infra/agent-loop-events.js"
import { runAgentLoop } from "../../../../../src/orchestration/agent-runtime/agent-loop.js"
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js"
import type { RuntimeTool } from "../../../../../src/orchestration/agent-runtime/tools/types.js"
import { RequestToolMap } from "../../../../helpers/request-tool-surface.js"
import { makeCaptureClient, withSessionNotes } from "./_loop-fixtures.js"
describe("a person turn after a compaction", () => {
  it("discards the compaction's admitted surface, so the person's first request reads what changed", async () => {
    const recall: RuntimeTool = {
      name: "recall",
      description: "Reads recorded history",
      action: "file_read",
      isConcurrencySafe: true,
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({ content: "recalled", outcome: "ok", terminate: false }),
    }
    const withoutRecall = withSessionNotes()
    const withRecall = withSessionNotes(new RequestToolMap([["recall", recall]]))
    let selected = withoutRecall.tools
    let pinned = selected
    const tools = {
      resolve: () => { pinned = selected; return pinned.resolve() },
      current: () => pinned.current(),
    }
    const advertised: string[][] = []
    const { client } = makeCaptureClient([
      { events: [{ kind: "text_delta", text: "Ready.", blockKey: "text-0" }, { kind: "done", stopReason: "end_turn" }] },
      { events: [{ kind: "text_delta", text: "Checkpoint saved.", blockKey: "text-1" }, { kind: "done", stopReason: "end_turn" }] },
      { events: [{ kind: "text_delta", text: "Second.", blockKey: "text-2" }, { kind: "done", stopReason: "end_turn" }] },
    ], { onRequest: (options) => advertised.push(options.tools.map((tool) => tool.name)) })
    const waits: Array<() => AgentLoopInput> = [() => { selected = withRecall.tools; return compactInput() }]
    let compacted = false
    let messageDelivered = false
    const result = await runAgentLoop({
      client,
      tools,
      checkpoint: withoutRecall.checkpoint,
      systemPrompt: stableSystemPrompt("test"),
      instruction: "do it",
      executionCwd: "/scratch",
      userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: "compaction-person-turn", promptCacheKey: "compaction-person-turn",
      artifactScopeId: "compaction-person-turn",
      retrievalSessionId: "compaction-person-turn",
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      onEvent: () => {},
      inputSource: {
        // The person's message was queued while the compaction ran: the loop
        // drains it without a park in between.
        drainPending: () => {
          if (!compacted || messageDelivered) return null
          messageDelivered = true
          selected = withoutRecall.tools
          return messageInput("second")
        },
        prepareWaitForInput: () => ({
          commit: async () => {
            const input = waits.shift()?.() ?? null
            if (input?.kind === "compact") compacted = true
            return input
          },
          cancel: async () => {},
        }),
      },
    })

    expect(result.kind).toBe("input_closed")
    expect(advertised).toHaveLength(3)
    expect(advertised[1]).toContain("recall")
    expect(advertised[2]).not.toContain("recall")
  })
})
