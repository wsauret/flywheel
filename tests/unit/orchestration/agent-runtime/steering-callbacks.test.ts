import { describe, expect, test } from "bun:test";
import { type InputSource, messageInput } from "../../../../src/infra/agent-loop-events.js";
import { runAgentLoop } from "../../../../src/orchestration/agent-runtime/agent-loop.js";
import type { ConversationMessage, ModelClient, ProviderStreamEvent, StreamOptions } from "../../../../src/orchestration/agent-runtime/llm/types.js";
import { asModelClient } from "./_model-client.js";
import { testBaseTools } from "../../../helpers/request-tool-surface.js";
import { stableSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";

function makeFakeClient(streamFn: (options: StreamOptions) => AsyncGenerator<ProviderStreamEvent>): ModelClient {
  return asModelClient({
    accessProvider: "anthropic_api",
    modelFamily: "anthropic",
    model: "test",
    contextLimit: 100_000,
    outputLimit: 8_000,
    supportsReasoning: false,
    priceFor() { return { status: "unavailable", reason: "missing-rate-card" }; },
    streamWithTools: streamFn,
  });
}

/** Tiny queue that doubles as the loop's InputSource. No `prepareWaitForInput`;
 *  loop exits when the queue is empty. */
function queueSource(): InputSource & { enqueue(text: string): void } {
  const queue: string[] = [];
  return {
    enqueue(text) { queue.push(text); },
    drainPending() {
      if (queue.length === 0) return null;
      return messageInput(queue.splice(0).join("\n\n"));
    },
  };
}

describe("agent-loop input drain — pre-stream", () => {
  test("multiple enqueues land in order", async () => {
    const calls: ConversationMessage[][] = [];
    let turnIndex = 0;

    const inputSource = queueSource();
    const client = makeFakeClient(async function* (options) {
      calls.push([...options.messages]);
      turnIndex++;
      if (turnIndex === 1) {
        inputSource.enqueue("first steering");
        inputSource.enqueue("second steering");
        yield {
          kind: "tool_use",
          toolCall: { id: "t-1", name: "noop_tool", input: {} },
        } as const;
        yield { kind: "done", stopReason: "tool_use" } as const;
        return;
      }
      yield { kind: "text_delta", text: "second reply", blockKey: "text-0" } as const;
      yield { kind: "done", stopReason: "end_turn" } as const;
    });

    await runAgentLoop({
      tools: testBaseTools(),
      client,
      systemPrompt: stableSystemPrompt("test"),
      instruction: "go",
      executionCwd: "/scratch",
      projectRoot: "/scratch",
      userDataRoot: "/scratch/.test-account",
      providerSessionKey: "steering", promptCacheKey: "steering",
      artifactScopeId: "steering", retrievalSessionId: "steering",
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      onEvent: () => {},
      inputSource,
    });

    expect(calls).toHaveLength(2);
    const userMsgs = calls[1]!.filter((m) => m.kind === "user");
    const last = userMsgs[userMsgs.length - 1];
    expect(last?.content).toBe("first steering\n\nsecond steering");
  });
});

describe("agent-loop input drain — end-of-turn", () => {
  test("onTurnEnded observer that enqueues prevents premature exit", async () => {
    const calls: ConversationMessage[][] = [];
    let turnIndex = 0;

    const client = makeFakeClient(async function* (options) {
      calls.push([...options.messages]);
      turnIndex++;
      yield { kind: "text_delta", text: `reply ${turnIndex}`, blockKey: "text-0" } as const;
      yield { kind: "done", stopReason: "end_turn" } as const;
    });

    const inputSource = queueSource();
    let endTurnCalls = 0;
    const result = await runAgentLoop({
      tools: testBaseTools(),
      client,
      systemPrompt: stableSystemPrompt("test"),
      instruction: "go",
      executionCwd: "/scratch",
      projectRoot: "/scratch",
      userDataRoot: "/scratch/.test-account",
      providerSessionKey: "steering", promptCacheKey: "steering",
      artifactScopeId: "steering", retrievalSessionId: "steering",
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      onEvent: () => {},
      inputSource,
      lifecycle: {
        onTurnEnded: () => {
          endTurnCalls++;
          if (endTurnCalls === 1) inputSource.enqueue("follow-up task");
        },
      },
    });

    expect(result.kind).toBe("completed");
    expect(calls).toHaveLength(2);
    expect(endTurnCalls).toBe(2);
    const lastMsg = calls[1]![calls[1]!.length - 1];
    expect(lastMsg).toEqual({ kind: "user", content: "follow-up task" });
  });

});
