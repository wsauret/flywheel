import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { messageInput } from "../../../../../src/infra/agent-loop-events.js";
import { runAgentLoop } from "../../../../../src/orchestration/agent-runtime/agent-loop.js";
import type { RuntimeTool } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import type { StreamEvent } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import { RequestToolMap, testBaseTools } from "../../../../helpers/request-tool-surface.js";
import { makeCaptureClient, withSessionNotes } from "./_loop-fixtures.js";
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";

describe("implicit todo prompting", () => {
  test("emits context_update immediately after proactive compaction", async () => {
    const events: StreamEvent[] = [];
    const { client } = makeCaptureClient(
      [
        { events: [
          { kind: "text_delta", text: "Checkpoint saved.", blockKey: "checkpoint" },
          { kind: "done", stopReason: "end_turn" },
        ] },
        { events: [
          { kind: "text_delta", text: "Done.", blockKey: "text" },
          { kind: "done", stopReason: "end_turn" },
        ] },
      ],
      { contextLimit: 100_000 },
    );

    await runAgentLoop({
      client,
      ...withSessionNotes(),
      systemPrompt: stableSystemPrompt("test"),
      instruction: "work",
      executionCwd: "/scratch",
      userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: "tool-behavior", promptCacheKey: "tool-behavior", artifactScopeId: "tool-behavior", retrievalSessionId: "tool-behavior",
      persistence: { history: { append: () => {} } },
      seed: {
        kind: "resume",
        priorMessages: [
          { kind: "user", content: "x".repeat(340_000) },
          { kind: "assistant", content: "older answer" },
          { kind: "user", content: "newer request" },
          { kind: "assistant", content: "newer answer" },
          { kind: "user", content: "work" },
        ],
      },
      onEvent: (event) => events.push(event),
    });

    const doneIndex = events.findIndex((event) => event.kind === "compaction_done" && event.success);
    const contextIndex = events.findIndex((event, index) => index > doneIndex && event.kind === "context_update");
    const checkpointIndex = events.findIndex((event) => event.kind === "text_delta" && event.text === "Checkpoint saved.");
    const textIndex = events.findIndex((event) => event.kind === "text_delta" && event.text === "Done.");

    expect(doneIndex).toBeGreaterThanOrEqual(0);
    expect(checkpointIndex).toBeLessThan(doneIndex);
    expect(contextIndex).toBeGreaterThan(doneIndex);
    expect(contextIndex).toBeLessThan(textIndex);

    const update = events[contextIndex];
    if (update?.kind !== "context_update") throw new Error("expected context_update");
    expect(update.contextWindow).toBe(100_000);
    expect(update.promptTokens).toBeGreaterThan(0);
    expect(update.promptTokens).toBeLessThan(100_000);
  });

});

describe("terminate flag on tool result", () => {
  const handoffDirectory = temporaryDirectories();

  function makeTerminateTool(opts: { name?: string; outcome?: "ok" | "error"; terminate?: boolean } = {}): RuntimeTool {
    const name = opts.name ?? "finisher";
    return {
      name,
      action: "ui_meta",
      isConcurrencySafe: false,
      description: `${name} tool`,
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({
        content: "done",
        outcome: opts.outcome ?? "ok",
        terminate: opts.terminate ?? true,
      }),
    };
  }

  test("exits the loop after a unanimous-terminate batch with no second LLM call", async () => {
    const { client, capturedMessages } = makeCaptureClient([
      {
        events: [
          { kind: "tool_use", toolCall: { id: "tc_1", name: "finisher", input: {} } },
          { kind: "done", stopReason: "tool_use" },
        ],
      },
    ]);

    const result = await runAgentLoop({
      client,
      systemPrompt: stableSystemPrompt("test"),
      instruction: "finish up",
      executionCwd: "/scratch",
      userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: "tool-behavior", promptCacheKey: "tool-behavior", artifactScopeId: "tool-behavior", retrievalSessionId: "tool-behavior",
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      onEvent: () => {},
      tools: new RequestToolMap([["finisher", makeTerminateTool()]]),
    });

    expect(result.kind).toBe("completed");
    // Only one LLM call — terminate short-circuits the second turn.
    expect(capturedMessages.length).toBe(1);
  });

  test("errored terminate result does NOT terminate", async () => {
    const { client, capturedMessages } = makeCaptureClient([
      {
        events: [
          { kind: "tool_use", toolCall: { id: "tc_1", name: "finisher", input: {} } },
          { kind: "done", stopReason: "tool_use" },
        ],
      },
      {
        events: [
          { kind: "text_delta", text: "recovering", blockKey: "text" },
          { kind: "done", stopReason: "end_turn" },
        ],
      },
    ]);

    const events: StreamEvent[] = [];
    const result = await runAgentLoop({
      client,
      systemPrompt: stableSystemPrompt("test"),
      instruction: "try to finish",
      executionCwd: "/scratch",
      userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: "tool-behavior", promptCacheKey: "tool-behavior", artifactScopeId: "tool-behavior", retrievalSessionId: "tool-behavior",
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      onEvent: (event) => events.push(event),
      tools: new RequestToolMap([["finisher", makeTerminateTool({ outcome: "error" })]]),
    });

    expect(result.kind).toBe("completed");
    // Two calls — errored terminate is not a clean exit.
    expect(capturedMessages.length).toBe(2);
    const toolResult = events.find((event) => event.kind === "tool_result");
    expect(toolResult).toMatchObject({ kind: "tool_result", outcome: "error" });
  });

  test("input enqueued during the tool batch overrides terminate (double-confirm wins)", async () => {
    const { client, capturedMessages } = makeCaptureClient([
      {
        events: [
          { kind: "tool_use", toolCall: { id: "tc_1", name: "finisher", input: {} } },
          { kind: "done", stopReason: "tool_use" },
        ],
      },
      {
        events: [
          { kind: "text_delta", text: "reviewed", blockKey: "text" },
          { kind: "done", stopReason: "end_turn" },
        ],
      },
    ]);

    const pending: string[] = [];
    // The terminating tool itself enqueues (like a background-work settle
    // notification landing during the batch): the post-tool drain must win
    // over the terminate signal.
    const enqueueingFinisher: RuntimeTool = {
      name: "finisher",
      action: "ui_meta",
      isConcurrencySafe: false,
      description: "finisher tool",
      inputSchema: { type: "object", properties: {} },
      execute: async () => {
        pending.push("please double-check before exiting");
        return { content: "done", outcome: "ok", terminate: true };
      },
    };
    const result = await runAgentLoop({
      client,
      systemPrompt: stableSystemPrompt("test"),
      instruction: "finish but review",
      executionCwd: "/scratch",
      userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: "tool-behavior", promptCacheKey: "tool-behavior", artifactScopeId: "tool-behavior", retrievalSessionId: "tool-behavior",
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      onEvent: () => {},
      tools: new RequestToolMap([["finisher", enqueueingFinisher]]),
      inputSource: {
        drainPending: () => {
          if (pending.length === 0) return null;
          return messageInput(pending.splice(0).join("\n\n"));
        },
      },
    });

    expect(result.kind).toBe("completed");
    // Two calls — the injection forced one more turn.
    expect(capturedMessages.length).toBe(2);
    const secondCall = capturedMessages[1]!;
    const lastUser = secondCall[secondCall.length - 1]!;
    expect(lastUser.kind).toBe("user");
    expect(typeof lastUser.content).toBe("string");
    expect(lastUser.content).toContain("please double-check");
  });

  test("mixed batch (terminate + non-terminate) does NOT terminate", async () => {
    const { client, capturedMessages } = makeCaptureClient([
      {
        events: [
          { kind: "tool_use", toolCall: { id: "tc_1", name: "finisher", input: {} } },
          { kind: "tool_use", toolCall: { id: "tc_2", name: "keep_going", input: {} } },
          { kind: "done", stopReason: "tool_use" },
        ],
      },
      {
        events: [
          { kind: "text_delta", text: "continuing", blockKey: "text" },
          { kind: "done", stopReason: "end_turn" },
        ],
      },
    ]);

    const result = await runAgentLoop({
      client,
      systemPrompt: stableSystemPrompt("test"),
      instruction: "do both",
      executionCwd: "/scratch",
      userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: "tool-behavior", promptCacheKey: "tool-behavior", artifactScopeId: "tool-behavior", retrievalSessionId: "tool-behavior",
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      onEvent: () => {},
      tools: new RequestToolMap([
        ["finisher", makeTerminateTool()],
        ["keep_going", makeTerminateTool({ name: "keep_going", terminate: false })],
      ]),
    });

    expect(result.kind).toBe("completed");
    expect(capturedMessages.length).toBe(2);
  });

  test("successful handoff terminates even when batched with non-terminating tools", async () => {
    const handoffPath = join(handoffDirectory("flywheel-handoff-"), "handoff.json");
    const { client, capturedMessages } = makeCaptureClient([
      {
        events: [
          { kind: "tool_use", toolCall: { id: "tc_1", name: "handoff", input: { summary: "done" } } },
          { kind: "tool_use", toolCall: { id: "tc_2", name: "keep_going", input: {} } },
          { kind: "done", stopReason: "tool_use" },
        ],
      },
    ]);

    const result = await runAgentLoop({
      client,
      systemPrompt: stableSystemPrompt("test"),
      instruction: "write and finish",
      executionCwd: "/scratch",
      userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: "tool-behavior", promptCacheKey: "tool-behavior", artifactScopeId: "tool-behavior", retrievalSessionId: "tool-behavior",
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      handoff: { onContent: (content) => { writeFileSync(handoffPath, JSON.stringify(content, null, 2)); } },
      onEvent: () => {},
      tools: new RequestToolMap([
        ["handoff", testBaseTools().get("handoff")!],
        ["keep_going", makeTerminateTool({ name: "keep_going", terminate: false })],
      ]),
    });

    expect(result.kind).toBe("completed");
    expect(capturedMessages.length).toBe(1);
  });
});

describe("interrupt during tool execution", () => {
  test("consumes queued input after interrupt lands during tool execution", async () => {
    const { RunLifecycle } = await import("../../../../../src/orchestration/agent-runtime/run-lifecycle.js");
    const currentTurn = new RunLifecycle<void>();
    currentTurn.start((signal) => new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    }));

    const interrupterTool: RuntimeTool = {
      name: "interrupter",
      action: "ui_meta",
      isConcurrencySafe: false,
      description: "fires interrupt during execution",
      inputSchema: { type: "object", properties: {} },
      execute: async () => {
        currentTurn.interrupt();
        return { content: "tool ran", outcome: "ok" };
      },
    };

    const { client, capturedMessages } = makeCaptureClient([
      {
        events: [
          { kind: "tool_use", toolCall: { id: "tc_1", name: "interrupter", input: {} } },
          { kind: "done", stopReason: "tool_use" },
        ],
      },
      {
        events: [
          { kind: "text_delta", text: "responded to queued", blockKey: "text" },
          { kind: "done", stopReason: "end_turn" },
        ],
      },
    ]);

    let waitCalls = 0;
    const inputSource = {
      drainPending: () => null,
      prepareWaitForInput: () => ({
        commit: async () => {
          waitCalls++;
          return waitCalls === 1 ? messageInput("queued message", { origin: "human" }) : null;
        },
        cancel: async () => {},
      }),
    };

    try {
      await runAgentLoop({
        client,
        systemPrompt: stableSystemPrompt("test"),
        instruction: "do work",
        executionCwd: "/scratch",
        userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
        providerSessionKey: "tool-behavior", promptCacheKey: "tool-behavior", artifactScopeId: "tool-behavior", retrievalSessionId: "tool-behavior",
        persistence: { history: { append: () => {} } },
        seed: { kind: "fresh" },
        onEvent: () => {},
        currentTurn,
        inputSource,
        tools: new RequestToolMap([["interrupter", interrupterTool]]),
      });
    } finally {
      currentTurn.abort(undefined);
    }

    // Without the fix, the loop breaks at line 377 once the tool finishes
    // (interruptSignal aborted, no prepareWaitForInput call), leaving the queued
    // message stranded and producing only one LLM call.
    expect(capturedMessages.length).toBe(2);
    const secondCall = capturedMessages[1]!;
    const queuedUser = secondCall.find(
      (m) => m.kind === "user" && m.content === "queued message",
    );
    expect(queuedUser).toBeDefined();
  });
});
