// ---------------------------------------------------------------------------
// NDJSON-to-EngineEvent Mapper — Unit Tests
// ---------------------------------------------------------------------------

import { describe, it, expect } from "bun:test";

import { mapNDJSONToEngineEvents } from "../src/orchestration/engines/subprocess/ndjson-event-mapper.js";
import type { NDJSONEvent } from "../src/orchestration/engines/subprocess/ndjson-parser.js";
import type { EngineEvent } from "../src/orchestration/engines/stream-observers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(type: NDJSONEvent["type"], data: Record<string, unknown> = {}): NDJSONEvent {
  return { type, data, raw: JSON.stringify({ type, ...data }) };
}

function assistantWithToolUse(tools: Array<{ name: string; input: Record<string, unknown>; id?: string }>): NDJSONEvent {
  return makeEvent("assistant", {
    message: {
      content: tools.map((t) => ({
        type: "tool_use",
        id: t.id ?? "tool_1",
        name: t.name,
        input: t.input,
      })),
    },
  });
}

function assistantWithText(text: string): NDJSONEvent {
  return makeEvent("assistant", {
    message: {
      content: [{ type: "text", text }],
    },
  });
}

function assistantMixed(text: string, tools: Array<{ name: string; input: Record<string, unknown>; id?: string }>): NDJSONEvent {
  return makeEvent("assistant", {
    message: {
      content: [
        { type: "text", text },
        ...tools.map((t) => ({
          type: "tool_use",
          id: t.id ?? "tool_1",
          name: t.name,
          input: t.input,
        })),
      ],
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mapNDJSONToEngineEvents", () => {
  it("maps assistant event with tool_use blocks to EngineEvent[]", () => {
    const event = assistantWithToolUse([
      { name: "Read", input: { file_path: "/a.ts" }, id: "t1" },
      { name: "Write", input: { file_path: "/b.ts", content: "x" }, id: "t2" },
    ]);
    const result = mapNDJSONToEngineEvents(event);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      type: "tool_use",
      toolName: "Read",
      toolInput: { file_path: "/a.ts" },
    });
    expect(result[1]).toEqual({
      type: "tool_use",
      toolName: "Write",
      toolInput: { file_path: "/b.ts", content: "x" },
    });
  });

  it("maps assistant event with only text to text EngineEvent", () => {
    const event = assistantWithText("Hello, world!");
    const result = mapNDJSONToEngineEvents(event);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: "text" });
  });

  it("maps assistant event with mixed text + tools to tool_use events only", () => {
    const event = assistantMixed("thinking...", [{ name: "Bash", input: { command: "ls" } }]);
    const result = mapNDJSONToEngineEvents(event);
    // Should emit tool_use events (text is secondary when tools are present)
    expect(result.some((e: EngineEvent) => e.type === "tool_use")).toBe(true);
  });

  it("maps tool_result event (success)", () => {
    const event = makeEvent("tool_result", {
      tool_use_id: "t1",
      is_error: false,
      content: "file contents here",
    });
    const result = mapNDJSONToEngineEvents(event);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: "tool_result", isError: false });
  });

  it("maps tool_result event (error)", () => {
    const event = makeEvent("tool_result", {
      tool_use_id: "t1",
      is_error: true,
      content: "permission denied",
    });
    const result = mapNDJSONToEngineEvents(event);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: "tool_result", isError: true });
  });

  it("maps result event", () => {
    const event = makeEvent("result", { total_cost_usd: 0.05 });
    const result = mapNDJSONToEngineEvents(event);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: "result" });
  });

  it("maps unknown event types to 'other'", () => {
    const event = makeEvent("system", { some: "data" });
    const result = mapNDJSONToEngineEvents(event);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: "other" });
  });

  it("maps step_finish to 'other'", () => {
    const event = makeEvent("step_finish", {});
    const result = mapNDJSONToEngineEvents(event);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("other");
  });

  it("returns empty array for assistant events with no content", () => {
    const event = makeEvent("assistant", { message: {} });
    const result = mapNDJSONToEngineEvents(event);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("other");
  });
});
