import { describe, it, expect } from "bun:test";
import { createRuntimeEvent } from "../../../../../src/infra/runtime-event-factory.js";
import type { RuntimeEvent } from "../../../../../src/infra/runtime-event-types.js";
import {
  createFilteredSubagentStream,
  createSubagentStats,
  type SubagentTextState,
} from "../../../../../src/orchestration/modules/subagents/execution/stream-filter.js";

interface UnknownRecord { [key: string]: unknown }

// "Failing at the reader" (ARCH-BOUNDARIES-004): the filter reads subagent cost/token
// attribution off the typed `model.turn.completed` member of RuntimeEvent --
// the single source of truth -- rather than re-casting an ad-hoc shape and
// `?? 0`-zeroing fields. These tests prove the typed read survives a round trip
// through the schema-validated event factory.

function makeTextState(): SubagentTextState {
  return { finalAssistantText: "" };
}

type AssistantBlock = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: UnknownRecord } | { type: "thinking"; thinking: string };

function assistantMessage(content: AssistantBlock[]): RuntimeEvent {
  return createRuntimeEvent("model.assistant_message.recorded", { type: "model.assistant_message.recorded", message: { content } });
}

describe("createFilteredSubagentStream final assistant text", () => {
  function observe(messages: AssistantBlock[][]): string {
    const textState = makeTextState();
    const filtered = createFilteredSubagentStream({ onRenderEvent: () => {}, agentType: "test-agent", stats: createSubagentStats(), textState });
    for (const content of messages) filtered(assistantMessage(content));
    return textState.finalAssistantText;
  }

  it("clears narration when a later message calls tools without text", () => {
    expect(observe([
      [{ type: "text", text: "I will read the file." }, { type: "tool_use", id: "call_1", name: "read", input: {} }],
      [{ type: "tool_use", id: "call_2", name: "handoff", input: {} }],
    ])).toBe("");
  });

  it("keeps every text block of the final message", () => {
    expect(observe([[{ type: "text", text: "First part." }, { type: "text", text: "Second part." }]])).toBe("First part.\n\nSecond part.");
  });

  it("keeps the answer when a later message holds only thinking", () => {
    expect(observe([
      [{ type: "text", text: "The answer is 42." }],
      [{ type: "thinking", thinking: "nothing more to add" }],
    ])).toBe("The answer is 42.");
  });
});

describe("createFilteredSubagentStream result accounting", () => {
  it("reads cost and usage from the typed model.turn.completed union member", () => {
    const stats = createSubagentStats();
    const filtered = createFilteredSubagentStream({
      onRenderEvent: () => {},
      agentType: "test-agent",
      stats,
      textState: makeTextState(),
    });

    filtered(
      createRuntimeEvent("model.turn.completed", {
        type: "model.turn.completed",
        total_cost_usd: 0.4271,
        usage: {
          input_tokens: 1200,
          output_tokens: 340,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 64,
          reasoning_tokens: 16,
        },
      }),
    );

    expect(stats.totalCostUsd).toBe(0.4271);
    expect(stats.totalInputTokens).toBe(1200);
    expect(stats.totalOutputTokens).toBe(340);
    expect(stats.totalCacheReadTokens).toBe(800);
    expect(stats.totalCacheCreateTokens).toBe(64);
    expect(stats.totalReasoningTokens).toBe(16);
  });

  it("falls back to 0 only when the runtime fact genuinely omits the optional field", () => {
    const stats = createSubagentStats();
    const filtered = createFilteredSubagentStream({
      onRenderEvent: () => {},
      agentType: "test-agent",
      stats,
      textState: makeTextState(),
    });

    // total_cost_usd and usage are optionalKey on the runtime fact; a turn that
    // legitimately omits them yields 0, and the missing-cost warning fires.
    filtered(createRuntimeEvent("model.turn.completed", { type: "model.turn.completed" }));

    expect(stats.totalCostUsd).toBe(0);
    expect(stats.totalInputTokens).toBe(0);
  });
});

describe("createFilteredSubagentStream usage forwarding", () => {
  it("forwards live usage while suppressing the per-turn child result", () => {
    const stats = createSubagentStats();
    const forwarded: string[] = [];
    const filtered = createFilteredSubagentStream({
      onRenderEvent: (event) => forwarded.push(event.type),
      agentType: "test-agent",
      stats,
      textState: makeTextState(),
    });

    // The child's live cost readings must reach the parent's event path so
    // the session budget projection ticks during the subagent run...
    filtered(
      createRuntimeEvent("model.usage.measured", {
        usage_entry: { attemptId: "00000000-0000-4000-8000-000000000001", occurredAt: "2026-09-02T00:00:00.000Z", profileId: "test", attribution: { kind: "unattributed" }, spendMode: "direct_api", credentialLineage: "10000000-0000-4000-8000-000000000001", model: "test", tokens: { input: 100, output: 40, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, classification: "real_spend", price: { kind: "priced", estimatedUsd: 0.02, rateCard: {}, provenance: "test" }, currency: "USD", coverage: "complete" },
        parent_tool_use_id: "toolu_dispatch",
        budget_stream_id: "subagent:toolu_dispatch",
      }),
    );
    // The child's terminal result stays captured in stats, while its stream
    // completion reaches the budget projection so it can retire the baseline.
    filtered(
      createRuntimeEvent("model.turn.completed", {
        type: "model.turn.completed",
        total_cost_usd: 0.02,
        billed_cost_usd: 0.02,
        usage: { input_tokens: 100, output_tokens: 40 },
        parent_tool_use_id: "toolu_dispatch",
      }),
    );

    expect(forwarded).toContain("model.usage.measured");
    expect(forwarded).not.toContain("model.turn.completed");
    expect(stats.totalCostUsd).toBe(0.02);
  });
});

describe("createFilteredSubagentStream tool accounting", () => {
  it("passes typed tool input and result content to the observer without copying or serializing", () => {
    const stats = createSubagentStats();
    const toolInput = { path: "a.ts", unused: { nested: true } };
    const content = [{ type: "text" as const, text: "result" }];
    let observedInput: UnknownRecord | undefined;
    let observedContent: Extract<RuntimeEvent, { type: "tool.result.recorded" }>["data"]["content"];
    const filtered = createFilteredSubagentStream({
      onRenderEvent: () => {},
      agentType: "test-agent",
      stats,
      textState: makeTextState(),
      turnLog: {
        recordToolUse: (_id, _name, input) => {
          observedInput = input;
        },
        recordToolResult: (_id, result) => {
          observedContent = result;
        },
      },
    });
    const inputEvent = createRuntimeEvent("tool.input.completed", {
      type: "tool.input.completed",
      tool_use: { id: "call_1", name: "read", input: toolInput },
    });
    const resultEvent = createRuntimeEvent("tool.result.recorded", {
      type: "tool.result.recorded",
      tool_use_id: "call_1",
      content,
    });

    filtered(inputEvent);
    filtered(resultEvent);

    expect(observedInput).toBe(inputEvent.data.tool_use.input);
    expect(observedContent).toBe(resultEvent.data.content);
  });

  it("counts tool.input.completed, not assistant tool_use placeholders", () => {
    const stats = createSubagentStats();
    const uses: Array<{ id: string; name: string; input: UnknownRecord }> = [];
    const filtered = createFilteredSubagentStream({
      onRenderEvent: () => {},
      agentType: "test-agent",
      stats,
      textState: makeTextState(),
      turnLog: {
        recordToolUse: (id, name, input) => uses.push({ id, name, input }),
        recordToolResult: () => {},
      },
    });

    // A non-bash call streams a placeholder assistant message first...
    filtered(
      createRuntimeEvent("model.assistant_message.recorded", {
        type: "model.assistant_message.recorded",
        message: { content: [{ type: "tool_use", id: "call_1", name: "read", input: {} }] },
      }),
    );
    filtered(
      createRuntimeEvent("tool.input.completed", {
        type: "tool.input.completed",
        tool_use: { id: "call_1", name: "read", input: { path: "a.ts" } },
      }),
    );
    // ...and a second tool call counts off the same producer fact.
    filtered(
      createRuntimeEvent("tool.input.completed", {
        type: "tool.input.completed",
        tool_use: { id: "call_2", name: "bash", input: { command: "bun run test" } },
      }),
    );

    expect(stats.toolUseCount).toBe(2);
    expect(uses).toEqual([
      { id: "call_1", name: "read", input: { path: "a.ts" } },
      { id: "call_2", name: "bash", input: { command: "bun run test" } },
    ]);
  });

  it("counts a validation-failed call as one attempted operation", () => {
    // The historical group expansion folds one child per tool-use id from both
    // producer facts, and the settled group hydration asserts that fold against
    // this count, so a call rejected before execution must be counted too.
    const stats = createSubagentStats();
    const filtered = createFilteredSubagentStream({
      onRenderEvent: () => {},
      agentType: "test-agent",
      stats,
      textState: makeTextState(),
    });

    filtered(
      createRuntimeEvent("tool.input.completed", {
        type: "tool.input.completed",
        tool_use: { id: "call_ok", name: "read", input: { path: "a.ts" } },
      }),
    );
    filtered(
      createRuntimeEvent("tool.validation.failed", {
        type: "tool.validation.failed",
        tool_use_id: "call_rejected",
        tool_name: "memory",
        input: { action: "add" },
        reason: "content is required for add",
      }),
    );

    expect(stats.toolUseCount).toBe(2);
  });

  it("counts one operation per tool-use id when both producer facts name the same call", () => {
    const stats = createSubagentStats();
    const filtered = createFilteredSubagentStream({
      onRenderEvent: () => {},
      agentType: "test-agent",
      stats,
      textState: makeTextState(),
    });

    filtered(
      createRuntimeEvent("tool.input.completed", {
        type: "tool.input.completed",
        tool_use: { id: "call_1", name: "memory", input: { action: "add" } },
      }),
    );
    filtered(
      createRuntimeEvent("tool.validation.failed", {
        type: "tool.validation.failed",
        tool_use_id: "call_1",
        tool_name: "memory",
        input: { action: "add" },
        reason: "content is required for add",
      }),
    );

    expect(stats.toolUseCount).toBe(1);
  });
});
