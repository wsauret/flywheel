import { describe, expect, test } from "bun:test";
import { messageInput } from "../../../../src/infra/agent-loop-events.js";
import { consumeAgentLoopMessageInput } from "../../../../src/orchestration/agent-runtime/agent-loop-input.js";
import { agentLoopTransition, initialAgentLoopState } from "../../../../src/orchestration/agent-runtime/agent-loop-state.js";

import { attemptContextOverflowRecovery } from "../../../../src/orchestration/agent-runtime/compaction/triggers.js";
import { ApiError } from "../../../../src/orchestration/agent-runtime/errors.js";
import { ContextLengthExceededError, OutputLengthExceededError } from "../../../../src/orchestration/agent-runtime/llm/errors.js";
import { normalizeProviderAttemptFailure } from "../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import { runAgentLoop } from "../../../../src/orchestration/agent-runtime/agent-loop.js";
import type { AgentLoopOptions } from "../../../../src/orchestration/agent-runtime/agent-loop-types.js";
import type { ConversationMessage, ModelClient, ProviderStreamEvent, StreamOptions } from "../../../../src/orchestration/agent-runtime/llm/types.js";
import { stableSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { asModelClient } from "./_model-client.js";
import type { RuntimeTool } from "../../../../src/orchestration/agent-runtime/tools/types.js";
import { RequestToolMap, testBaseTools } from "../../../helpers/request-tool-surface.js";
import { withSessionNotes } from "./context/_loop-fixtures.js";
import { emptyConversationCheckpoint } from "../../../../src/orchestration/session/conversation-checkpoint.js";

/** A loop that runs `client` over `tools` and appends each recorded message to `history`. */
function loopOptions(client: ModelClient, tools: AgentLoopOptions["tools"], history: ConversationMessage[]): AgentLoopOptions {
  return {
    userDataRoot: "/scratch/.test-account", projectRoot: "/scratch", providerSessionKey: "output-overflow", promptCacheKey: "output-overflow", artifactScopeId: "output-overflow", retrievalSessionId: "output-overflow",
    tools,
    client,
    systemPrompt: stableSystemPrompt("test"),
    instruction: "write the report",
    executionCwd: "/scratch",
    seed: { kind: "fresh" },
    onEvent: () => {},
    persistence: { history: { append: (message) => { history.push(structuredClone(message)); } } },
  };
}

function recoverInput() {
  const messages: ConversationMessage[] = [
    { kind: "user", content: "original task" },
    { kind: "assistant", content: "partial answer" },
  ];
  return {
    messages,
    onEvent: () => {},
    contextLimit: 100_000,
    tokensBefore: 50,
    prepareCompactedHistory: () => ({ additions: [], measure: () => 0, install: async () => 0 }),
    after: "continue" as const,
    carryTurnEnd: false,
    emitContextUpdate: () => {},
    // Recovery reads only the persistence of these options, so the client never serves a request.
    options: loopOptions(scriptedOutputClient([]).client, new RequestToolMap(), []),
  };
}

describe("recoverFromContextOverflow guard", () => {
  test("a provider-reported overflow recovers once and terminates without the outer retry loop", async () => {
    let streamCalls = 0;
    const alwaysOverflows = asModelClient({
      accessProvider: "anthropic_api",
      modelFamily: "anthropic",
      model: "test-model",
      contextLimit: 100_000,
      outputLimit: 8_000,
      supportsReasoning: false,
      promptNotes: { progress: "", modelNotes: "" },
      async *streamWithTools(_options: StreamOptions): AsyncGenerator<ProviderStreamEvent> {
        streamCalls++;
        throw normalizeProviderAttemptFailure(new ContextLengthExceededError());
      },
      priceFor() { return { status: "unavailable", reason: "missing-rate-card" }; },
    });
    const { tools, checkpoint } = withSessionNotes(testBaseTools(), {
      read: async () => emptyConversationCheckpoint(),
      replace: async () => emptyConversationCheckpoint(),
      decide: async () => emptyConversationCheckpoint(),
    });
    const history: ConversationMessage[] = [];

    const run = runAgentLoop({ ...loopOptions(alwaysOverflows, tools, history), checkpoint, maxLLMCalls: 3 });

    // The overflow settles the attempt on its own candidate. The one-shot
    // recovery guard resets context once, then retries it once,
    // and a second overflow ends the loop as context_overflow.
    expect(await run).toEqual({ kind: "context_overflow" });
    expect(streamCalls).toBe(2);
    // An overflow reset has no save round, so its opening says the checkpoint may be stale.
    expect(JSON.stringify(history.at(-1))).toContain("This reset came before a checkpoint save, so the checkpoint above may not include the latest work.");
  });

  test("the recovery guard is one-shot and resets for a new logical turn", async () => {
    let state = initialAgentLoopState;
    const guard = {
      tryAcquire: () => {
        if (state.overflowRecoveryAttempted) return false;
        state = agentLoopTransition.overflowRecoveryStarted(state);
        return true;
      },
    };
    const effects = {
      clearRequestContext() {},
      logicalTurnStarted(origin: "user" | "background") { state = agentLoopTransition.logicalTurnStarted(state, origin); },
      pushUser() {},
      admit() {},
      userMessageReceived() {},
      visibleReplyRequired() {},
    };
    const input = {
      ...recoverInput(),
      guard,
      turnCount: 1,
    };

    expect((await attemptContextOverflowRecovery(input)).kind).toBe("recovered");
    expect(await attemptContextOverflowRecovery(input)).toEqual({ kind: "exhausted" });
    await consumeAgentLoopMessageInput(messageInput("continue"), false, false, effects);
    expect(state.overflowRecoveryAttempted).toBe(true);
    expect(await attemptContextOverflowRecovery(input)).toEqual({ kind: "exhausted" });
    await consumeAgentLoopMessageInput(messageInput("new task"), true, false, effects);
    expect(state.overflowRecoveryAttempted).toBe(false);
    expect((await attemptContextOverflowRecovery({ ...input, turnCount: 2 })).kind).toBe("recovered");
  });

  test("a served response restores the recovery, and an unserved one does not", async () => {
    let state = initialAgentLoopState;
    const input = {
      ...recoverInput(),
      guard: {
        tryAcquire: () => {
          if (state.overflowRecoveryAttempted) return false;
          state = agentLoopTransition.overflowRecoveryStarted(state);
          return true;
        },
      },
      turnCount: 1,
    };

    expect((await attemptContextOverflowRecovery(input)).kind).toBe("recovered");
    state = agentLoopTransition.responseSettled(state, { kind: "incomplete" });
    expect(await attemptContextOverflowRecovery(input)).toEqual({ kind: "exhausted" });
    state = agentLoopTransition.responseSettled(state, { kind: "ok", stopReason: "tool_use" });
    expect((await attemptContextOverflowRecovery(input)).kind).toBe("recovered");
  });
});

type ScriptedResponse = { kind: "overflow"; partial: string } | { kind: "complete"; events: ProviderStreamEvent[] };

/** Plays `script` one response per request. A request past the script fails
 *  with an ApiError, so an unbounded continuation loop ends instead of hanging. */
function scriptedOutputClient(script: readonly ScriptedResponse[]) {
  let requests = 0;
  const client = asModelClient({
    accessProvider: "anthropic_api",
    modelFamily: "anthropic",
    model: "test-model",
    contextLimit: 100_000,
    outputLimit: 8_000,
    supportsReasoning: false,
    promptNotes: { progress: "", modelNotes: "" },
    async *streamWithTools(): AsyncGenerator<ProviderStreamEvent> {
      const response = script[requests++];
      if (!response) throw new ApiError({ message: "request past the scripted responses", recovery: { kind: "none" } });
      if (response.kind === "complete") {
        yield* response.events;
        return;
      }
      yield { kind: "text_delta", text: response.partial, blockKey: "text" };
      throw normalizeProviderAttemptFailure(new OutputLengthExceededError());
    },
    priceFor() { return { status: "unavailable", reason: "missing-rate-card" }; },
  });
  return { client, requests: () => requests };
}

const echoTool: RuntimeTool = {
  name: "echo",
  action: "shell_exec",
  description: "echo tool",
  inputSchema: { type: "object" },
  isConcurrencySafe: true,
  execute: async () => ({ content: "echoed", outcome: "ok" }),
};

function runScripted(client: ReturnType<typeof scriptedOutputClient>["client"], history: ConversationMessage[], inputSource?: AgentLoopOptions["inputSource"], options: Pick<AgentLoopOptions, "signal" | "flushCanonicalMessages"> = {}) {
  return runAgentLoop({
    ...options,
    ...loopOptions(client, new RequestToolMap([[echoTool.name, echoTool]]), history),
    ...(inputSource ? { inputSource } : {}),
  });
}

const overflow = (partial: string): ScriptedResponse => ({ kind: "overflow", partial });
const finalText: ScriptedResponse = { kind: "complete", events: [{ kind: "text_delta", text: "Done.", blockKey: "text" }, { kind: "done", stopReason: "end_turn" }] };

describe("output overflow continuation", () => {
  test.each(["none", "silent-system", "wake"] as const)("two automatic continuations keep every partial, and a third overflow stops despite %s input", async (notification) => {
    const { client, requests } = scriptedOutputClient([overflow("part 1"), overflow("part 2"), overflow("part 3"), finalText]);
    const history: ConversationMessage[] = [];
    let delivered = 0;
    const inputSource: AgentLoopOptions["inputSource"] = {
      drainPending: () => {
        if (notification === "none" || requests() === 0 || requests() > 3 || delivered === requests()) return null;
        delivered = requests();
        return notification === "wake" ? { kind: "wake" } : messageInput("background update", { origin: "silent-system" });
      },
    };

    await expect(runScripted(client, history, inputSource)).rejects.toMatchObject({ _tag: "OutputOverflow" });

    expect(requests()).toBe(3);
    expect(delivered).toBe(notification === "none" ? 0 : 3);
    expect(history.flatMap((message) => message.kind === "assistant" ? [{ content: message.content, incomplete: message.incomplete }] : []))
      .toEqual(["part 1", "part 2", "part 3"].map((text) => ({ content: [{ type: "text", text }], incomplete: true })));
    // Background messages replace the resume prompt, but cannot extend the allowance.
    expect(history.filter((message) => message.kind === "user")).toHaveLength(notification === "none" ? 3 : notification === "silent-system" ? 4 : 1);
  });

  test("a successful response restores the continuation allowance", async () => {
    const toolCall: ScriptedResponse = { kind: "complete", events: [{ kind: "tool_use", toolCall: { id: "tc_1", name: "echo", input: {} } }, { kind: "done", stopReason: "tool_use" }] };
    const { client, requests } = scriptedOutputClient([overflow("a"), overflow("b"), toolCall, overflow("c"), overflow("d"), finalText]);

    expect(await runScripted(client, [])).toEqual({ kind: "completed" });
    expect(requests()).toBe(6);
  });

  test("cancellation at the third overflow settlement takes priority over the cap", async () => {
    const { client, requests } = scriptedOutputClient([overflow("a"), overflow("b"), overflow("c"), finalText]);
    const controller = new AbortController();
    const history: ConversationMessage[] = [];

    expect(await runScripted(client, history, undefined, {
      signal: controller.signal,
      flushCanonicalMessages: async () => { if (requests() === 3) controller.abort(); },
    })).toEqual({ kind: "aborted" });
    expect(requests()).toBe(3);
    expect(history.filter((message) => message.kind === "assistant")).toHaveLength(3);
  });

  test("a new user request restores the continuation allowance", async () => {
    const { client, requests } = scriptedOutputClient([overflow("a"), overflow("b"), overflow("c"), overflow("d"), finalText]);
    let delivered = false;
    const inputSource = {
      drainPending: () => {
        if (delivered || requests() !== 2) return null;
        delivered = true;
        return messageInput("new request");
      },
    };

    expect(await runScripted(client, [], inputSource)).toEqual({ kind: "completed" });
    expect(requests()).toBe(5);
  });
});
