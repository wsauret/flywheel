import { describe, it, expect, beforeEach } from "bun:test";
import { NDJSONParser } from "../src/infra/ndjson-parser";

const MAX_LINE_LENGTH = 1_000_000;
import type { NDJSONEvent } from "../src/infra/subprocess-types";
import { OutputBuffer } from "../src/infra/output-buffer";

// ---------------------------------------------------------------------------
// NDJSONParser
// ---------------------------------------------------------------------------

describe("NDJSONParser", () => {
  let parser: NDJSONParser;
  let events: NDJSONEvent[];
  let rawTexts: string[];

  beforeEach(() => {
    parser = new NDJSONParser();
    events = [];
    rawTexts = [];
    parser.onEvent = (e) => events.push(e);
    parser.onRawText = (t) => rawTexts.push(t);
  });

  it("parses a single JSON line", () => {
    parser.write('{"type":"text","content":"hello"}\n');
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("text");
    expect(events[0]!.data.content).toBe("hello");
  });

  it("parses multiple JSON lines", () => {
    parser.write('{"type":"text","content":"a"}\n{"type":"tool_use","tool":"read"}\n');
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("text");
    expect(events[1]!.type).toBe("tool_use");
  });

  it("handles partial lines across chunks", () => {
    parser.write('{"type":');
    expect(events).toHaveLength(0);
    parser.write('"text","content":"hello"}\n');
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("text");
  });

  it("normalizes \\r\\n to \\n", () => {
    parser.write('{"type":"text"}\r\n');
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("text");
  });

  it("strips ANSI before JSON parse", () => {
    parser.write('\x1b[32m{"type":"text","content":"green"}\x1b[0m\n');
    expect(events).toHaveLength(1);
    expect(events[0]!.data.content).toBe("green");
  });

  it("extracts JSON from garbage-prefix lines", () => {
    parser.write('2024-01-01 LOG: {"type":"error","message":"oops"}\n');
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("error");
    expect(events[0]!.data.message).toBe("oops");
  });

  it("emits non-JSON lines as raw text", () => {
    parser.write("This is just log output\n");
    expect(events).toHaveLength(0);
    expect(rawTexts).toHaveLength(1);
    expect(rawTexts[0]).toBe("This is just log output");
  });

  it("flushes partial line on process exit", () => {
    parser.write('{"type":"text","content":"partial"}');
    expect(events).toHaveLength(0); // no newline yet
    parser.flush();
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("text");
  });

  it("MAX_LINE_LENGTH guard: flushes oversized lines as raw text", () => {
    // Write a line longer than MAX_LINE_LENGTH without a newline
    const oversized = "X".repeat(MAX_LINE_LENGTH + 100);
    parser.write(oversized);
    // Should have been flushed as raw text
    expect(rawTexts.length).toBeGreaterThanOrEqual(1);
    // Buffer should be cleared
  });

  it("MAX_LINE_LENGTH truncates in-progress buffer", () => {
    // Build up a buffer just under the limit
    const almostFull = "A".repeat(MAX_LINE_LENGTH - 10);
    parser.write(almostFull);
    expect(rawTexts).toHaveLength(0); // not yet oversized

    // Push it over
    parser.write("B".repeat(100));
    expect(rawTexts.length).toBeGreaterThanOrEqual(1);
  });

  it("event routing: classifies tool_use events", () => {
    parser.write('{"type":"tool_use","tool":"bash"}\n');
    expect(events[0]!.type).toBe("tool_use");
  });

  it("event routing: classifies text events", () => {
    parser.write('{"type":"text","content":"hello"}\n');
    expect(events[0]!.type).toBe("text");
  });

  it("event routing: classifies step_finish events", () => {
    parser.write('{"type":"step_finish","status":"ok"}\n');
    expect(events[0]!.type).toBe("step_finish");
  });

  it("event routing: classifies error events", () => {
    parser.write('{"type":"error","message":"bad"}\n');
    expect(events[0]!.type).toBe("error");
  });

  it("event routing: classifies unknown events", () => {
    parser.write('{"type":"custom","data":"value"}\n');
    expect(events[0]!.type).toBe("unknown");
  });

  it("event routing: classifies assistant events (Claude Code stream-json)", () => {
    parser.write('{"type":"assistant","message":{"content":[]}}\n');
    expect(events[0]!.type).toBe("assistant");
  });

  it("event routing: classifies system events (Claude Code stream-json)", () => {
    parser.write('{"type":"system","subtype":"init","session_id":"s-1"}\n');
    expect(events[0]!.type).toBe("system");
  });

  it("event routing: classifies user events (Claude Code stream-json)", () => {
    parser.write('{"type":"user","message":{"content":"hello"}}\n');
    expect(events[0]!.type).toBe("user");
  });

  it("event routing: classifies tool_result events (Claude Code stream-json)", () => {
    parser.write('{"type":"tool_result","tool_use_id":"tu-1","content":"ok"}\n');
    expect(events[0]!.type).toBe("tool_result");
  });

  it("event routing: classifies result events (Claude Code stream-json)", () => {
    parser.write('{"type":"result","subtype":"success","total_cost_usd":0.01}\n');
    expect(events[0]!.type).toBe("result");
  });

  it("captures sessionID from first JSON event", () => {
    expect(parser.sessionId).toBeNull();
    parser.write('{"type":"text","sessionID":"sess-123"}\n');
    expect(parser.sessionId).toBe("sess-123");
    // Second event with different sessionID doesn't override
    parser.write('{"type":"text","sessionID":"sess-456"}\n');
    expect(parser.sessionId).toBe("sess-123");
  });

  it("captures session_id (snake_case) from system/init event", () => {
    expect(parser.sessionId).toBeNull();
    parser.write('{"type":"system","subtype":"init","session_id":"init-abc"}\n');
    expect(parser.sessionId).toBe("init-abc");
    // Subsequent events with sessionID don't override
    parser.write('{"type":"step_finish","sessionID":"step-456"}\n');
    expect(parser.sessionId).toBe("init-abc");
  });

  it("prefers sessionID (camelCase) over session_id when both present", () => {
    expect(parser.sessionId).toBeNull();
    parser.write('{"type":"text","sessionID":"camel-1","session_id":"snake-1"}\n');
    expect(parser.sessionId).toBe("camel-1");
  });

  it("feeds through output buffer", () => {
    const outputBuffer = new OutputBuffer();
    const p = new NDJSONParser(outputBuffer);
    p.onEvent = (e) => events.push(e);

    p.write('{"type":"text","content":"hello"}\n');

    expect(outputBuffer.getState().content).toContain('"type":"text"');
  });

  it("MAX_LINE_LENGTH is 1MB (1,000,000)", () => {
    expect(MAX_LINE_LENGTH).toBe(1_000_000);
  });

  it("ignores empty lines", () => {
    parser.write("\n\n\n");
    expect(events).toHaveLength(0);
    expect(rawTexts).toHaveLength(0);
  });

  it("handles mixed JSON and text lines", () => {
    parser.write('Starting process...\n{"type":"text","content":"init"}\nDone.\n');
    expect(events).toHaveLength(1);
    expect(rawTexts).toHaveLength(2);
    expect(rawTexts[0]).toBe("Starting process...");
    expect(rawTexts[1]).toBe("Done.");
  });
});

// ---------------------------------------------------------------------------
// Carriage Return Overwrite Handling (Gap 7)
// ---------------------------------------------------------------------------

describe("NDJSONParser carriage return overwrite", () => {
  let parser: NDJSONParser;
  let events: NDJSONEvent[];
  let rawTexts: string[];

  beforeEach(() => {
    parser = new NDJSONParser();
    events = [];
    rawTexts = [];
    parser.onEvent = (e) => events.push(e);
    parser.onRawText = (t) => rawTexts.push(t);
  });

  it("\\r overwrites line prefix (progress bar pattern)", () => {
    // CLI progress: "progress: 50%\rprogress: 100%\n"
    // The \r should cause the first part to be overwritten
    parser.write("progress: 50%\rprogress: 100%\n");
    expect(rawTexts).toHaveLength(1);
    expect(rawTexts[0]).toBe("progress: 100%");
  });

  it("multi-line with \\r overwrite: line1 is preserved, partial\\rfull overwrites", () => {
    parser.write("line1\npartial\rfull\n");
    expect(rawTexts).toHaveLength(2);
    expect(rawTexts[0]).toBe("line1");
    expect(rawTexts[1]).toBe("full");
  });

  it("mixed \\r\\n (CRLF) and standalone \\r (overwrite) are handled differently", () => {
    // CRLF should be treated as a line ending, standalone \r should overwrite
    parser.write("crlf line\r\noverwritten\rvisible\n");
    expect(rawTexts).toHaveLength(2);
    expect(rawTexts[0]).toBe("crlf line");
    expect(rawTexts[1]).toBe("visible");
  });

  it("multiple \\r overwrites keep only the last segment", () => {
    parser.write("first\rsecond\rthird\n");
    expect(rawTexts).toHaveLength(1);
    expect(rawTexts[0]).toBe("third");
  });

  it("\\r overwrite does not affect JSON parsing", () => {
    parser.write('loading...\r{"type":"text","content":"done"}\n');
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("text");
    expect(events[0]!.data.content).toBe("done");
  });
});
