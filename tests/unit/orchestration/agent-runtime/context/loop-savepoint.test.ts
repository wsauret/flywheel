import { describe, expect, test } from "bun:test";

import { runAgentLoop } from "../../../../../src/orchestration/agent-runtime/agent-loop.js";
import { createBackgroundExecutionOwner } from "../../../../../src/orchestration/agent-runtime/background-execution-owner.js";
import { createBackgroundWorkRegistry } from "../../../../../src/orchestration/agent-runtime/background-work.js";
import { SILENT_REPLY_NUDGE } from "../../../../../src/orchestration/agent-runtime/reply-nudge.js";
import { createProcessTool } from "../../../../../src/orchestration/agent-runtime/tools/process.js";
import type { RuntimeTool } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import type { ConversationMessage, ProviderStreamEvent } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { RequestToolMap } from "../../../../helpers/request-tool-surface.js";
import { makeCaptureClient } from "./_loop-fixtures.js";
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";

const echoTool: RuntimeTool = {
  name: "echo",
  action: "shell_exec",
  description: "echo tool",
  inputSchema: { type: "object" },
  isConcurrencySafe: false,
  execute: async () => ({ content: "echoed", outcome: "ok" }),
};

describe("agent loop durable turn save points", () => {
  const loopIdentity = {
    userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
    providerSessionKey: "loop-savepoint", promptCacheKey: "loop-savepoint",
    artifactScopeId: "loop-savepoint",
    retrievalSessionId: "loop-savepoint",
  };

  test("awaits each append before flush, fork capture, and terminal publication", async () => {
    const gates = Array.from({ length: 4 }, () => ({
      entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>(),
    }));
    const committed: ConversationMessage[] = [];
    const order: string[] = [];
    let appendIndex = 0;
    let pending = false;
    let ended = false;
    const fork: RuntimeTool = {
      ...echoTool,
      deferUntilAssistantCommitted: true,
      execute: async (_input, context) => {
        await context.snapshotConversation?.();
        return { content: "forked", outcome: "ok" };
      },
    };
    const { client, capturedMessages } = makeCaptureClient([
      { events: [
        { kind: "tool_use", toolCall: { id: "tc_1", name: "echo", input: {} } },
        { kind: "done", stopReason: "tool_use" },
      ] },
      { events: [
        { kind: "text_delta", text: "Done.", blockKey: "main" },
        { kind: "done", stopReason: "end_turn" },
      ] },
    ]);
    const running = runAgentLoop({
      tools: new RequestToolMap([[fork.name, fork]]), client, systemPrompt: stableSystemPrompt("test"),
      instruction: "fork", executionCwd: "/scratch", ...loopIdentity,
      seed: { kind: "fresh" }, completeOnIdle: {},
      persistence: {
        history: {
          append: async (message) => {
            const gate = gates[appendIndex++]!;
            pending = true;
            gate.entered.resolve();
            await gate.release.promise;
            committed.push(message);
            order.push(`append:${message.kind}`);
            pending = false;
          },
        },
        captureCommittedForkMessages: async () => {
          expect(pending).toBe(false);
          order.push("fork");
          return committed;
        },
      },
      flushCanonicalMessages: async () => { expect(pending).toBe(false); order.push("flush"); },
      onEvent: (event) => {
        if (event.kind === "done") { expect(pending).toBe(false); order.push("terminal"); }
      },
      lifecycle: { onTurnEnded: () => { ended = true; } },
    });
    for (const [index, gate] of gates.entries()) {
      await gate.entered.promise;
      const before = [...order];
      await Bun.sleep(1);
      expect(order).toEqual(before);
      expect(ended).toBe(false);
      if (index === 0) expect(capturedMessages).toHaveLength(0);
      if (index === 1) expect(order).not.toContain("fork");
      gate.release.resolve();
    }
    expect((await running).kind).toBe("completed");
    expect(order.indexOf("fork")).toBeGreaterThan(order.indexOf("append:assistant"));
    expect(order.indexOf("terminal")).toBeGreaterThan(order.indexOf("append:toolResult"));
    expect(ended).toBe(true);
  });

  test("awaits the host save point before each provider request", async () => {
    const firstFlush = Promise.withResolvers<void>();
    const flushStarted = Promise.withResolvers<void>();
    let flushCount = 0;
    const { client, capturedMessages } = makeCaptureClient([
      { events: [
        { kind: "tool_use", toolCall: { id: "tc_1", name: "echo", input: {} } },
        { kind: "done", stopReason: "tool_use" },
      ] },
      { events: [
        { kind: "text_delta", text: "Done.", blockKey: "main" },
        { kind: "done", stopReason: "end_turn" },
      ] },
    ]);

    const running = runAgentLoop({
      tools: new RequestToolMap([[echoTool.name, echoTool]]),
      client,
      systemPrompt: stableSystemPrompt("test"),
      instruction: "run something",
      executionCwd: "/scratch",
      ...loopIdentity,
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      completeOnIdle: {},
      onEvent: () => {},
      flushCanonicalMessages: async () => {
        flushCount += 1;
        if (flushCount === 2) {
          // The flush that authorizes the second request: hold it open to
          // prove the request waits on durability.
          flushStarted.resolve();
          await firstFlush.promise;
        }
      },
    });

    await flushStarted.promise;
    expect(capturedMessages).toHaveLength(1);
    firstFlush.resolve();
    expect((await running).kind).toBe("completed");
    expect(capturedMessages).toHaveLength(2);
  });

  test("commits normal conversation results with the exact finalized checkpoint", async () => {
    const checkpointRaw = new Map<string, string>();
    const history: unknown[] = [];
    let conversationAppended = false;
    let retiredRaw = "";
    const { client } = makeCaptureClient([
      { events: [
        { kind: "tool_use", toolCall: { id: "tc_1", name: "echo", input: {} } },
        { kind: "done", stopReason: "tool_use" },
      ] },
      { events: [
        { kind: "text_delta", text: "Done.", blockKey: "main" },
        { kind: "done", stopReason: "end_turn" },
      ] },
    ]);

    const result = await runAgentLoop({
      tools: new RequestToolMap([[echoTool.name, echoTool]]),
      client,
      systemPrompt: stableSystemPrompt("test"),
      instruction: "run something",
      executionCwd: "/scratch",
      ...loopIdentity,
      persistence: { history: { append: (message) => { history.push(message); } } },
      seed: { kind: "fresh" },
      completeOnIdle: {},
      onEvent: () => {},
      sessionEventWriter: {
        record: async () => null,
        recordBatch: async () => null,
        recordGuarded: async () => null,
        transaction: async (fn) => { fn(); },
        dispose: () => {},
        putInFlight: async (_kind, key, payload) => {
          checkpointRaw.set(key, JSON.stringify(payload));
        },
      },
      conversationId: "loop-savepoint",
      flushCanonicalMessages: async (_protectedToolUseIds, swaps = []) => {
        for (const swap of swaps) {
          if (checkpointRaw.get(swap.key) !== swap.expectedRaw) throw new Error("guarded checkpoint mismatch");
          retiredRaw = swap.expectedRaw;
          checkpointRaw.delete(swap.key);
          conversationAppended = true;
        }
      },
    });

    expect(result.kind).toBe("completed");
    expect(conversationAppended).toBe(true);
    expect(checkpointRaw.size).toBe(0);
    expect(retiredRaw).toStartWith('{"conversationId":"loop-savepoint","toolUseId":"tc_1","toolName":"echo","budgetExempt":false,"turnBudgetChars":120000,"registrationOrdinal":0,"content":');
    expect(history.some((message) => typeof message === "object"
      && message !== null
      && "kind" in message
      && message.kind === "toolResult")).toBe(true);
  });

  test("onTurnEnded fires only when the logical turn ends, not per tool batch", async () => {
    const { client } = makeCaptureClient([
      { events: [
        { kind: "tool_use", toolCall: { id: "tc_1", name: "echo", input: {} } },
        { kind: "done", stopReason: "tool_use" },
      ] },
      { events: [
        { kind: "tool_use", toolCall: { id: "tc_2", name: "echo", input: {} } },
        { kind: "done", stopReason: "tool_use" },
      ] },
      { events: [
        { kind: "text_delta", text: "Done.", blockKey: "main" },
        { kind: "done", stopReason: "end_turn" },
      ] },
    ]);
    const endedTurns: number[] = [];

    const result = await runAgentLoop({
      tools: new RequestToolMap([[echoTool.name, echoTool]]),
      client,
      systemPrompt: stableSystemPrompt("test"),
      instruction: "run something",
      executionCwd: "/scratch",
      ...loopIdentity,
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      completeOnIdle: {},
      onEvent: () => {},
      lifecycle: {
        onTurnEnded: ({ turnCount }) => {
          endedTurns.push(turnCount);
        },
      },
    });

    expect(result.kind).toBe("completed");
    // Two tool batches continued the logical turn; only the final text-only
    // model turn ended it. A mid-turn onTurnEnded would drop the session's
    // runnerState to idle while the loop is still working.
    expect(endedTurns).toEqual([3]);
  });

  // A turn that owes a person a reply and delivered no visible text gets a
  // reply nudge. The nudged request belongs to the same logical turn: the
  // chat runner maps onTurnEnded to `agent.logical_turn.ended`, so a hook
  // fired before the nudge would publish Idle while the model still replies.
  for (const finish of [
    { name: "a text-only turn", waits: false },
    { name: "a wait on a background command", waits: true },
  ]) {
    test(`onTurnEnded fires after the reply-nudge request that follows ${finish.name}, not before it`, async () => {
      const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} });
      if (finish.waits) registry.track({ done: new Promise<never>(() => {}), meta: { id: "bg_1", type: "command", description: "in flight" } });
      const silentEvents: ProviderStreamEvent[] = finish.waits
        ? [{ kind: "tool_use", toolCall: { id: "wait_1", name: "process", input: { action: "wait", soft_timeout: 30 } } }, { kind: "done", stopReason: "tool_use" }]
        : [{ kind: "done", stopReason: "end_turn" }];
      const { client, capturedMessages } = makeCaptureClient([
        { events: silentEvents },
        { events: [
          { kind: "text_delta", text: "Waiting on the command.", blockKey: "main" },
          ...(finish.waits ? [{ kind: "tool_use" as const, toolCall: { id: "wait_2", name: "process", input: { action: "wait", soft_timeout: 30 } } }] : []),
          { kind: "done", stopReason: finish.waits ? "tool_use" : "end_turn" },
        ] },
      ]);
      const requestsAtTurnEnd: number[] = [];

      const result = await runAgentLoop({
        tools: new RequestToolMap([["process", createProcessTool(registry)]]),
        client,
        systemPrompt: stableSystemPrompt("test"),
        instruction: "start the build",
        executionCwd: "/scratch",
        ...loopIdentity,
        persistence: { history: { append: () => {} } },
        seed: { kind: "fresh" },
        humanFacing: true,
        background: createBackgroundExecutionOwner(registry),
        inputSource: {
          drainPending: () => null,
          prepareWaitForInput: () => ({ commit: async () => null, cancel: async () => {} }),
        },
        onEvent: () => {},
        lifecycle: { onTurnEnded: () => { requestsAtTurnEnd.push(capturedMessages.length); } },
      });

      expect(result.kind).toBe("input_closed");
      expect(capturedMessages[1]?.at(-1)).toMatchObject({ kind: "user", content: SILENT_REPLY_NUDGE });
      expect(requestsAtTurnEnd).toEqual([2]);
    });
  }

  test("a save-point failure prevents the next provider request", async () => {
    const failure = new Error("save point failed");
    let flushCount = 0;
    const { client, capturedMessages } = makeCaptureClient([
      { events: [
        { kind: "tool_use", toolCall: { id: "tc_1", name: "echo", input: {} } },
        { kind: "done", stopReason: "tool_use" },
      ] },
      { events: [
        { kind: "text_delta", text: "Done.", blockKey: "main" },
        { kind: "done", stopReason: "end_turn" },
      ] },
    ]);

    const rejected = runAgentLoop({
      tools: new RequestToolMap([[echoTool.name, echoTool]]),
      client,
      systemPrompt: stableSystemPrompt("test"),
      instruction: "run something",
      executionCwd: "/scratch",
      ...loopIdentity,
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      onEvent: () => {},
      flushCanonicalMessages: async () => {
        flushCount += 1;
        if (flushCount === 2) throw failure;
      },
    });

    expect(await rejected.then(() => null, (error) => error)).toBe(failure);
    expect(capturedMessages).toHaveLength(1);
  });
});
