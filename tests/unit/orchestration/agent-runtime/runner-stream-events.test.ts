import { describe, it, expect } from "bun:test";

import { emitAgentStreamEvent } from "../../../../src/orchestration/agent-runtime/runner-stream-events.js";
import { emitTurnAssistant } from "../../../../src/orchestration/agent-runtime/emit.js";
import { OutputProjector } from "../../../../src/infra/output/output-projector.js";
import { RuntimeEventProjector } from "../../../../src/infra/output/runtime-event-projector.js";
import { createTurnUsageTracker } from "../../../../src/orchestration/agent-runtime/turn-usage-tracker.js";
import { mapRuntimeEventToSessionRuntimeFacts } from "../../../../src/infra/runtime-fact-mapper.js";
import type { RuntimeEvent } from "../../../../src/infra/runtime-event-types.js";
import { RequestToolMap } from "../../../helpers/request-tool-surface.js";
import { handleStreamEvent, type AssistantTurnResult } from "../../../../src/orchestration/agent-runtime/assistant-turn-result.js";
import { branchBlocks } from "../../../helpers/branch-blocks.js";

function streamEventContext(onEvent: (event: RuntimeEvent) => void): Parameters<typeof emitAgentStreamEvent>[1] {
  return {
    options: { onEvent },
    contextWindow: 200_000,
    costTracker: createTurnUsageTracker({ emit: onEvent, budgetStreamId: "test" }),
    providerSessionKey: "test",
    parentToolUseId: undefined,
    thinking: { sawDelta: false },
    tools: new RequestToolMap(),
  };
}

// The turn coordinator publishes one call's execution-output tail and its
// terminal result as a single settled projection. Nothing may split that pair,
// because a later tail would render after the result it belongs to.
describe("per-call projection adjacency", () => {
  it("emits a call's execution-output tail immediately before its terminal result", () => {
    const emitted: RuntimeEvent[] = [];
    const context = streamEventContext(event => { emitted.push(event); });

    emitAgentStreamEvent({
      kind: "tool_result",
      toolUseId: "tool_1",
      content: [{ type: "text", text: "final" }],
      outcome: "ok",
      executionOutputTail: "last lines of output",
    }, context);

    expect(emitted.map((event) => event.type)).toEqual([
      "tool.execution_output.recorded",
      "tool.result.recorded",
    ]);
  });
});

describe("provider progress presentation", () => {
  it("publishes question leading text under its canonical durable part identity", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const parser = new RuntimeEventProjector(projector);
    const context = streamEventContext(event => parser.dispatch(event, 1000));
    const turn: AssistantTurnResult = {
      entryId: "entry", outcome: { kind: "ok", stopReason: "unknown" }, assistantContent: [], toolCalls: [],
      assistantMetadata: undefined, lastAssistantMetadata: undefined, usageAnchor: undefined,
      terminalEvent: undefined, transportContext: undefined,
    };
    handleStreamEvent({ kind: "reasoning", id: "hidden", encryptedContent: "opaque", blockKey: "hidden" }, turn);
    emitAgentStreamEvent({ kind: "tool_input_start", toolUseId: "ask", name: "ask_user" }, context);
    const event = handleStreamEvent({ kind: "tool_use", toolCall: {
      id: "ask", name: "ask_user", input: { context: "Choose the next step.", question: "Which?", options: ["A", "B"] },
    } }, turn);
    if (event.kind !== "tool_use") throw new Error("expected canonical tool event");
    emitAgentStreamEvent(event, context);
    const live = projector.getBlocks().filter(block => block.kind === "text");
    const durable = branchBlocks([{
      id: "entry", parentId: null, kind: "message", timestamp: new Date(1000).toISOString(),
      message: { kind: "assistant", content: turn.assistantContent },
    }], { executionCwd: "/workspace" }).filter(block => block.kind === "text");
    expect(live).toEqual(durable);
    expect(live[0]).toMatchObject({ id: "entry:1:lead", content: "Choose the next step." });
    emitTurnAssistant(context.options.onEvent, turn.assistantContent, context.costTracker, undefined, "entry");
    expect(projector.getBlocks().filter(block => block.kind === "text")).toEqual(live);
  });

  it("publishes signed narration at completion once, without exposing ordinary reasoning", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const parser = new RuntimeEventProjector(projector);
    const emitted: RuntimeEvent[] = [];
    const context = streamEventContext(event => { emitted.push(event); parser.dispatch(event, 1000); });
    const turn: AssistantTurnResult = {
      entryId: "entry", outcome: { kind: "ok", stopReason: "unknown" }, assistantContent: [], toolCalls: [],
      assistantMetadata: undefined, lastAssistantMetadata: undefined, usageAnchor: undefined,
      terminalEvent: undefined, transportContext: undefined,
    };
    const publishThinking = (event: Extract<Parameters<typeof handleStreamEvent>[0], { kind: "thinking_delta" | "thinking_complete" }>) => {
      const canonical = handleStreamEvent(event, turn);
      if (canonical.kind !== "thinking_delta" && canonical.kind !== "thinking_complete") throw new Error("Expected a thinking event");
      emitAgentStreamEvent(canonical, context);
    };
    const thinking = { type: "thinking" as const, thinking: "private reasoning", signature: "EgwKCkIIdGhpbmtpbmc=" };
    const secret = "ghp_" + "a".repeat(36);
    const narration = { type: "thinking" as const, thinking: `The credential is ${secret}.`, signature: "Eg0KC0IJbmFycmF0aW9u" };
    const publicText = "The credential is [redacted secret].";
    publishThinking({ kind: "thinking_delta", text: thinking.thinking, blockKey: "reason" });
    publishThinking({ kind: "thinking_complete", ...thinking, blockKey: "reason" });
    publishThinking({ kind: "thinking_delta", text: narration.thinking, blockKey: "narration" });
    expect(projector.getBlocks().filter(block => block.kind === "text")).toHaveLength(0);
    publishThinking({ kind: "thinking_complete", ...narration, blockKey: "narration" });
    expect(projector.getBlocks().filter(block => block.kind === "text")).toMatchObject([{ id: "entry:1", content: publicText }]);
    expect(projector.snapshot().streamingOutputChars).toBe(thinking.thinking.length + publicText.length);
    emitTurnAssistant(context.options.onEvent, turn.assistantContent, context.costTracker, undefined, "entry");
    const published = emitted.find(event => event.type === "model.assistant_message.recorded");
    expect(JSON.stringify(published)).not.toContain(secret);
    expect(published).toMatchObject({ data: { entry_id: "entry", message: { content: [
      thinking,
      { type: "thinking", thinking: publicText, presentation: "progress" },
    ] } } });
    expect(turn.assistantContent).toEqual([thinking, narration]);
    expect(projector.getBlocks().filter(block => block.kind === "text")).toMatchObject([{ id: "entry:1", content: publicText }]);
    expect(projector.getBlocks().filter(block => block.kind === "thinking")).toMatchObject([{ content: thinking.thinking }]);
  });

  it("publishes only a redacted complete update when a secret spans provider deltas", () => {
    const emitted: RuntimeEvent[] = [];
    const context = streamEventContext(event => { emitted.push(event); });
    const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";

    emitAgentStreamEvent({
      kind: "thinking_delta",
      text: secret.slice(0, 18),
      blockKey: "progress",
      presentation: "progress",
    }, context);
    emitAgentStreamEvent({
      kind: "thinking_delta",
      text: secret.slice(18),
      blockKey: "progress",
      presentation: "progress",
    }, context);
    emitAgentStreamEvent({
      kind: "thinking_complete",
      thinking: secret,
      signature: "signed-progress",
      blockKey: "progress",
      presentation: "progress",
    }, context);

    expect(emitted).toHaveLength(2);
    expect(emitted[0]).toEqual({
      type: "model.content.delta",
      data: {
        delta: { type: "thinking_delta", thinking: "[redacted secret]", presentation: "progress" },
        block_key: "progress",
      },
    });
    expect(emitted[1]).toMatchObject({
      type: "model.text.completed",
      data: { block_key: "progress" },
    });
  });
});

describe("finalized result availability", () => {
  it("emits a live-only availability event", () => {
    const emitted: RuntimeEvent[] = [];
    const context = streamEventContext(event => { emitted.push(event); });

    emitAgentStreamEvent({
      kind: "tool_result_available",
      toolUseId: "tool_1",
      content: [{ type: "text", text: "final" }],
      outcome: "ok",
      details: { command: "printf final" },
      contentTruncated: true,
      originalContentBytes: 12,
      originalContentSha256: "abc123",
      fullContentPath: "/scratch/full-output",
      semanticOutputTruncated: false,
      byteOutputTruncated: true,
      executionOutputTail: "tail",
    }, context);

    expect(emitted).toEqual([{
      type: "tool.result.available",
      data: {
        tool_use_id: "tool_1",
        content: [{ type: "text", text: "final" }],
        outcome: "ok",
        details: { command: "printf final" },
        content_truncated: true,
        original_content_bytes: 12,
        original_content_sha256: "abc123",
        full_content_path: "/scratch/full-output",
        semantic_output_truncated: false,
        byte_output_truncated: true,
        execution_output_tail: "tail",
      },
    }]);
  });
});

describe("tool preview checks", () => {
  it("emits sanitized set and identity-preserving clear events without durable facts", () => {
    const emitted: RuntimeEvent[] = [];
    const context = streamEventContext(event => { emitted.push(event); });

    emitAgentStreamEvent({
      kind: "tool_preview_check",
      toolUseId: "tool_1",
      operation: { type: "set", advice: "\u001b[31mReview this\u001b[0m" },
    }, context);
    emitAgentStreamEvent({
      kind: "tool_preview_check",
      toolUseId: "tool_1",
      operation: { type: "clear" },
    }, context);

    expect(emitted).toEqual([
      {
        type: "tool.preview.check",
        data: {
          tool_use_id: "tool_1",
          operation: { type: "set", advice: "Review this" },
        },
      },
      {
        type: "tool.preview.check",
        data: {
          tool_use_id: "tool_1",
          operation: { type: "clear" },
        },
      },
    ]);
    expect(emitted.flatMap(mapRuntimeEventToSessionRuntimeFacts)).toEqual([]);
  });
});
