import { describe, expect, test } from "bun:test";

import { createHandoffTracker } from "../../../../src/orchestration/agent-runtime/agent-loop-handoff.js";
import type { ToolResultEntry } from "../../../../src/orchestration/agent-runtime/agent-state.js";
import { HandoffCorrectionExhausted } from "../../../../src/orchestration/agent-runtime/errors.js";
import type { ToolCall } from "../../../../src/orchestration/agent-runtime/llm/types.js";
import { toTextParts } from "../../../../src/infra/llm/tool-output-part-schema.js";

let nextId = 0;

function handoffCall(): ToolCall {
  return { id: `tc_${nextId++}`, name: "handoff", input: { summary: "x" } };
}

function batch(outcome: ToolResultEntry["outcome"], errorText = "schema mismatch") {
  const call = handoffCall();
  return {
    toolCalls: [call],
    toolResults: [{ toolUseId: call.id, content: toTextParts(outcome === "ok" ? "written" : errorText), outcome }],
  };
}

describe("createHandoffTracker", () => {
  test("decides each handoff once at stream start and admits only a later response's correction after closing", () => {
    let block = true, reads = 0, admissions = 0;
    const tracker = createHandoffTracker({
      background: {
        assertHandoffReady() { reads++; return block ? { active: 1, pending: 0, services: 0, activeDescriptions: ["review"], pendingDescriptions: [], serviceDescriptions: [] } : null; },
        stopAdmission() {},
      },
      onStarted() { admissions++; },
    });
    const request = tracker.request();
    const refused = handoffCall();
    request.start(refused);
    block = false;
    request.start(refused);
    expect(request.refuse(refused)).toMatchObject({ outcome: "blocked", content: expect.stringContaining("review") });
    expect(tracker.isHandingOff).toBe(false);
    expect(request.refuse({ id: "read", name: "read", input: {} })).toBeUndefined();
    const admitted = handoffCall();
    request.start(admitted);
    block = true;
    request.start(admitted);
    expect(request.refuse(admitted)).toBeUndefined();
    expect([reads, admissions]).toEqual([2, 1]);
    expect(request.refuse(handoffCall())).toMatchObject({ outcome: "blocked", content: expect.stringContaining("session ended") });
    expect(request.refuse({ id: "read", name: "read", input: {} })).toMatchObject({ outcome: "blocked" });
    expect(tracker.request().refuse(handoffCall())).toBeUndefined();
    expect([reads, admissions]).toEqual([2, 1]);
  });

  test("the exhaustion message includes the last handoff error text", () => {
    const tracker = createHandoffTracker();
    for (let i = 0; i < 2; i++) {
      const b = batch("error");
      tracker.recordBatch(b.toolCalls, b.toolResults, "ok");
    }
    const last = batch("error", "required field `summary` is missing");
    expect(() => tracker.recordBatch(last.toolCalls, last.toolResults, "ok")).toThrow(
      /3 consecutive attempts.*required field `summary` is missing/,
    );
  });

  test("handoff errors in a response the provider did not serve consume no correction attempt", () => {
    const tracker = createHandoffTracker();
    for (let i = 0; i < 3; i++) {
      const b = batch("error");
      expect(tracker.recordBatch(b.toolCalls, b.toolResults, "stream_error")).toBe(false);
    }
    for (let i = 0; i < 2; i++) {
      const b = batch("error");
      tracker.recordBatch(b.toolCalls, b.toolResults, "ok");
    }
    const last = batch("error");
    expect(() => tracker.recordBatch(last.toolCalls, last.toolResults, "ok")).toThrow(HandoffCorrectionExhausted);
  });

  test("interrupted and blocked handoffs neither count nor reset", () => {
    const tracker = createHandoffTracker();
    const e1 = batch("error");
    tracker.recordBatch(e1.toolCalls, e1.toolResults, "ok");
    const interrupted = batch("interrupted");
    expect(tracker.recordBatch(interrupted.toolCalls, interrupted.toolResults, "ok")).toBe(false);
    const blocked = batch("blocked");
    expect(tracker.recordBatch(blocked.toolCalls, blocked.toolResults, "ok")).toBe(false);
    const e2 = batch("error");
    tracker.recordBatch(e2.toolCalls, e2.toolResults, "ok");
    const e3 = batch("error");
    expect(() => tracker.recordBatch(e3.toolCalls, e3.toolResults, "ok")).toThrow(HandoffCorrectionExhausted);
  });

  test("batches without a handoff call are ignored", () => {
    const tracker = createHandoffTracker();
    const call: ToolCall = { id: "tc_read", name: "read", input: { path: "/scratch/x" } };
    const written = tracker.recordBatch(
      [call],
      [{ toolUseId: call.id, content: toTextParts("nope"), outcome: "error" }],
      "ok",
    );
    expect(written).toBe(false);
  });

  test("long error text is excerpted in the exhaustion message", () => {
    const tracker = createHandoffTracker();
    const longError = "e".repeat(1000);
    for (let i = 0; i < 2; i++) {
      const b = batch("error", longError);
      tracker.recordBatch(b.toolCalls, b.toolResults, "ok");
    }
    const last = batch("error", longError);
    let message = "";
    try {
      tracker.recordBatch(last.toolCalls, last.toolResults, "ok");
    } catch (err) {
      if (!(err instanceof HandoffCorrectionExhausted)) throw err;
      message = err.message;
    }
    expect(message).toContain("…");
    expect(message.length).toBeLessThan(600);
  });
});
