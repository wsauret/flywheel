import { describe, expect, test } from "bun:test";
import type { BetaRawMessageStreamEvent, BetaStopReason } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { createAssistantAssembler, type AssemblyStep } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/assistant-assembler.js";

/** Each name by which the CLI hands a call to a handler, with the tool's input schema. */
const DECLARED = new Map([["mcp__runtime__read", { type: "object", properties: { path: { type: "string" }, paths: { type: "array", items: { type: "string" } } } }]]);

const start: BetaRawMessageStreamEvent = { type: "message_start", message: {
  id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null,
  container: null, context_management: null, diagnostics: null, stop_details: null,
  usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 900, cache_creation_input_tokens: 40, cache_creation: null, inference_geo: null, iterations: null, server_tool_use: null, service_tier: null, speed: null },
} };
const textBlock = (index: number, text: string): BetaRawMessageStreamEvent[] => [
  { type: "content_block_start", index, content_block: { type: "text", text: "", citations: null } },
  { type: "content_block_delta", index, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index },
];
const toolBlock = (index: number, id: string, name: string, json: string[]): BetaRawMessageStreamEvent[] => [
  { type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } },
  ...json.map((partial_json): BetaRawMessageStreamEvent => ({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } })),
  { type: "content_block_stop", index },
];
const delta = (stop_reason: BetaStopReason | null, output_tokens = 25): BetaRawMessageStreamEvent => ({
  type: "message_delta", context_management: null,
  delta: { stop_reason, stop_sequence: null, container: null, stop_details: null },
  usage: { output_tokens, input_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null, iterations: null, server_tool_use: null },
});
const stop: BetaRawMessageStreamEvent = { type: "message_stop" };

function run(events: BetaRawMessageStreamEvent[], declared = DECLARED) {
  const assembler = createAssistantAssembler(declared);
  const steps = events.map((event) => assembler.add(event));
  return { assembler, steps, end: steps.find((step): step is Extract<AssemblyStep, { kind: "end" }> => step.kind === "end") };
}

describe("the assistant assembler", () => {
  test("ends the request at the first stop reason and parks on declared tool calls", () => {
    const { assembler, steps, end } = run([start, ...textBlock(0, "Reading."), ...toolBlock(1, "toolu_1", "mcp__runtime__read", ['{"pa', 'th":"a"}']), delta("tool_use"), stop]);
    expect(end).toMatchObject({ kind: "end", settlement: "park", toolUseIds: ["toolu_1"], evidence: { rule: "tool-calls", stopReason: "tool_use" } });
    expect(steps.at(-1)).toEqual({ kind: "continue" });
    expect(steps.filter((step) => step.kind === "end")).toHaveLength(1);
    expect(assembler.message()).toEqual({ role: "assistant", content: [
      { type: "text", text: "Reading." }, { type: "tool_use", id: "toolu_1", name: "mcp__runtime__read", input: { path: "a" } },
    ] });
    expect(assembler.usage()).toEqual({ inputTokens: 10, outputTokens: 25, cacheReadTokens: 900, cacheCreationTokens: 40 });
  });

  test("keeps signed thinking byte for byte", () => {
    const thinking: BetaRawMessageStreamEvent[] = [
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Step one.\n", estimated_tokens: null } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: " Step two.", estimated_tokens: null } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "Eo8BCkYI+/=" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "opaque==" } },
      { type: "content_block_stop", index: 1 },
    ];
    const { assembler, end } = run([start, ...thinking, ...textBlock(2, "Done."), delta("end_turn"), stop]);
    expect(end?.settlement).toBe("idle");
    expect(assembler.message().content).toEqual([
      { type: "thinking", thinking: "Step one.\n Step two.", signature: "Eo8BCkYI+/=" },
      { type: "redacted_thinking", data: "opaque==" },
      { type: "text", text: "Done." },
    ]);
  });

  test("stops the query on every reply that makes the CLI send a request of its own, and names the rule that decided", () => {
    const decided = (events: BetaRawMessageStreamEvent[]) => {
      const end = run([start, ...events, stop]).end;
      return [end?.settlement, end?.evidence.rule];
    };
    expect(decided([...textBlock(0, "Done."), delta("stop_sequence")])).toEqual(["idle", "visible-answer"]);
    expect(decided([delta("end_turn")])).toEqual(["stop", "blank-answer"]);
    expect(decided([...textBlock(0, "  \n"), delta("end_turn")])).toEqual(["stop", "blank-answer"]);
    expect(decided([...textBlock(0, "Partial"), delta("max_tokens")])).toEqual(["stop", "other-stop-reason"]);
    expect(decided([...textBlock(0, "No."), delta("refusal")])).toEqual(["stop", "other-stop-reason"]);
    expect(decided([...textBlock(0, "Calling."), delta("tool_use")])).toEqual(["stop", "tool-use-without-calls"]);
    expect(decided([...toolBlock(0, "toolu_1", "Bash", ["{}"]), delta("tool_use")])).toEqual(["stop", "undeclared-tool"]);
    expect(decided([...toolBlock(0, "toolu_1", "mcp__runtime__read", ['["a"]']), delta("tool_use")])).toEqual(["stop", "tool-input-not-object"]);
    expect(decided([...toolBlock(0, "toolu_1", "mcp__runtime__read", ['{"path":']), delta("tool_use")])).toEqual(["stop", "tool-input-not-json"]);
    expect(decided([...toolBlock(0, "toolu_1", "mcp__runtime__read", []), delta("tool_use")])).toEqual(["park", "tool-calls"]);
    expect(decided([...textBlock(0, "Done."), ...toolBlock(1, "toolu_1", "mcp__runtime__read", ["{}"]), delta("end_turn")])).toEqual(["stop", "end-with-calls"]);
    const serverTool: BetaRawMessageStreamEvent[] = [
      { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} } },
      { type: "content_block_stop", index: 0 },
    ];
    expect(decided([...serverTool, delta("end_turn")])).toEqual(["stop", "unread-block"]);
  });

  test("states the kinds and counts that the settlement read, and how many rejected tool inputs Flywheel's own reader reads against the tool's schema", () => {
    const { end } = run([start, ...textBlock(0, "Waiting."),
      ...toolBlock(1, "toolu_1", "mcp__runtime__read", ['{"path":"a"}']),
      ...toolBlock(2, "toolu_2", "process", ['{"action":"wait"}']),
      // A raw line break inside a string: strict JSON rejects it, and Flywheel's parser repairs it.
      ...toolBlock(3, "toolu_3", "mcp__runtime__read", ['{"path":"a\nb"}']),
      ...toolBlock(4, "toolu_4", "mcp__runtime__read", ["[1]"]),
      // A list parameter repeated as unquoted items, as eager input streaming sends it: the shared Anthropic reader
      // gathers the items against the schema.
      ...toolBlock(5, "toolu_5", "mcp__runtime__read", ['{"paths": src/a.ts, "paths": src/b.ts}']),
      delta("tool_use"), stop]);
    expect(end?.evidence).toEqual({
      rule: "undeclared-tool", stopReason: "tool_use",
      blocks: { text: 1, visibleText: 1, thinking: 0, redacted: 0, toolUse: 5, unread: 0 },
      toolUses: { declared: 4, undeclared: 1, objectInput: 2, inputNotJson: 2, inputNotObject: 1, inputRepairable: 2 },
    });
  });

  test("reports the CLI's synthetic tail after an idle timeout as a cut", () => {
    // A5: the CLI ends a stalled stream with a stop reason of null and then message_stop.
    const { steps, end } = run([start, ...textBlock(0, "Half"), delta(null, 0), stop]);
    expect(end).toBeUndefined();
    expect(steps.at(-1)).toEqual({ kind: "cut" });
  });

  test("reports a request that stopped before any content as a cut", () => {
    // A10: a request whose first event never came ends with only the synthetic message_stop.
    expect(run([stop]).steps).toEqual([{ kind: "cut" }]);
  });
});
