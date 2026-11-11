import { describe, expect, it } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { Redacted } from "effect";
import type { ModelInfo } from "../../../../../src/infra/llm/models.js";
import { createAnthropicAdapter, operationsFromAnthropicClient } from "../../../../../src/orchestration/agent-runtime/llm/anthropic.js";
import { FUNCTION_TOOL_PRESENTATION, type ProviderStreamEvent, type ToolCall, type ToolPresentation } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { wireResponse } from "./_wire-fixtures.js";

const info: ModelInfo = {
  provider: "anthropic", family: "anthropic", id: "claude-sonnet-5-5", name: "Sonnet",
  reasoning: true, toolCall: true, attachment: false, temperature: false, openWeights: false,
  cost: { input: 0, output: 0 }, pricing: { status: "unavailable", reason: "missing-rate-card" },
  modalities: { input: ["text"], output: ["text"] }, contextLimit: 1_000_000, outputLimit: 128_000,
};
const handoff = {
  name: "handoff",
  description: "Finish the step.",
  input_schema: {
    type: "object",
    properties: {
      summary: { type: "string" },
      hypothesis: { type: ["string", "null"] },
      evidence: { type: "array", items: { type: "string" }, minItems: 1 },
    },
    required: ["summary", "hypothesis", "evidence"],
  },
};

/** Streams one `handoff` tool_use whose input text is `raw`, split into two deltas, through the real adapter. The
 *  block names the tool `blockName`, and the adapter presents the tools with `toolPresentation`. */
async function streamedToolCall(raw: string, blockName = "handoff", toolPresentation: ToolPresentation = FUNCTION_TOOL_PRESENTATION): Promise<ToolCall> {
  const operations = operationsFromAnthropicClient(new Anthropic({
    apiKey: "test-key", maxRetries: 0,
    fetch: async () => wireResponse([
      { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_1", name: blockName, input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: raw.slice(0, 40) } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: raw.slice(40) } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } },
      { type: "message_stop" },
    ]),
  }));
  const adapter = await createAnthropicAdapter(Redacted.make("test-key"), info.id, info, { operations, toolPresentation });
  const events: ProviderStreamEvent[] = [];
  for await (const event of adapter.streamWithTools({ messages: [{ kind: "user", content: "Investigate." }], tools: [handoff], systemPrompt: { stable: "test", session: "", conversation: "" } })) events.push(event);
  const call = events.find((event) => event.kind === "tool_use");
  if (call?.kind !== "tool_use") throw new Error("the stream yielded no tool_use");
  return call.toolCall;
}

// The model writes a list parameter as the same parameter repeated, one item each. Anthropic serializes each
// repetition as its own member, so one key appears several times in one object. These texts are the shapes the
// live API streamed for that call on 2026-10-09 (claude-sonnet-5-5), shortened.
describe("Anthropic tool input with a repeated list parameter", () => {
  it("keeps every item when eager input streaming sends the items as unquoted text", async () => {
    const raw = '{"summary": "Cut calls run.", "hypothesis": "The flush loop ignores \\"length\\".", "evidence": src/llm/openai-completions.ts:145: `case "length": return "max_tokens";` maps the cut late., "evidence": Test run printed "1 fail: expected inputParseError, received undefined".}';
    const call = await streamedToolCall(raw);
    expect(call.inputParseError).toBeUndefined();
    expect(call.input).toEqual({
      summary: "Cut calls run.",
      hypothesis: 'The flush loop ignores "length".',
      evidence: [
        'src/llm/openai-completions.ts:145: `case "length": return "max_tokens";` maps the cut late.',
        'Test run printed "1 fail: expected inputParseError, received undefined".',
      ],
    });
  });

  it("keeps every item when buffered streaming sends the items as quoted strings under one repeated key", async () => {
    const call = await streamedToolCall('{"summary": "s", "hypothesis": null, "evidence": "first, with a comma", "evidence": "second", "evidence": ["third", "fourth"]}');
    expect(call.inputParseError).toBeUndefined();
    expect(call.input).toEqual({ summary: "s", hypothesis: null, evidence: ["first, with a comma", "second", "third", "fourth"] });
  });

  // The claude-agent-sdk route presents each tool under an MCP prefix, and its engine also takes a call by the
  // tool's own name (its tool alias), which the model uses because Flywheel's text names the tools that way.
  it("keeps every item when the model calls a renamed tool by its own name", async () => {
    const renamed: ToolPresentation = { ...FUNCTION_TOOL_PRESENTATION, wireName: (name) => `mcp__runtime__${name}` };
    const call = await streamedToolCall('{"summary": "s", "hypothesis": null, "evidence": "first", "evidence": second item}', "handoff", renamed);
    expect(call.inputParseError).toBeUndefined();
    expect(call).toMatchObject({ name: "handoff", input: { summary: "s", hypothesis: null, evidence: ["first", "second item"] } });
  });

  // A model can invent a tool under the wire prefix (observed 2026-10-21: `mcp__runtime__note_edit_placeholder`).
  // The call keeps the canonical name space, so its transcript row and refusal never show the wire prefix.
  it("names a call to an undeclared tool through the presentation's canonical name", async () => {
    const renamed: ToolPresentation = { ...FUNCTION_TOOL_PRESENTATION, wireName: (name) => `wire.${name}`, canonicalName: (name) => `canonical(${name})` };
    const call = await streamedToolCall("{}", "wire.invented", renamed);
    expect(call.name).toBe("canonical(wire.invented)");
  });

  it("refuses a repeated parameter whose schema is not a list, naming the parameter", async () => {
    const call = await streamedToolCall('{"summary": "one", "summary": "two", "hypothesis": null, "evidence": ["e"]}');
    expect(call.input).toEqual({});
    expect(call.inputParseError).toContain('"summary"');
  });

  it("refuses a cut text instead of completing it", async () => {
    const call = await streamedToolCall('{"summary": "s", "hypothesis": null, "evidence": first item, "evidence": second it');
    expect(call.input).toEqual({});
    expect(call.inputParseError).toContain("incomplete JSON");
  });
});
