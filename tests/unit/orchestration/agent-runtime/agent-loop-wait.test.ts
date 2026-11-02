import { describe, expect, test } from "bun:test";
import { createWaitToolPolicy } from "../../../../src/orchestration/agent-runtime/agent-loop-wait.js";
import type { ToolCall } from "../../../../src/orchestration/agent-runtime/llm/types.js";
import { PROCESS_TOOL_NAME } from "../../../../src/orchestration/agent-runtime/tools/process.js";
import { ChatTurnMailbox } from "../../../../src/orchestration/chat/turn-mailbox.js";

const waitCall: ToolCall = { id: "t1", name: PROCESS_TOOL_NAME, input: { action: "wait" } };

describe("wait tool policy delivery", () => {
  test("the no-work wait notification reaches a class-backed input source", () => {
    // The agent loop wires the enqueue as an arrow, never as a detached method
    // reference: every InputSource implementation is a class whose enqueue
    // methods read `this`, and a detached reference crashes with
    // "undefined is not an object (evaluating 'this.enqueue')".
    const mailbox = new ChatTurnMailbox();
    const policy = createWaitToolPolicy(
      () => false,
      () => { throw new Error("no background work is live, so the wait must not park"); },
      (text) => mailbox.enqueueRuntimeNotice(text),
    );

    expect(policy.isWaitCall(waitCall)).toBe(true);
    // A named wait parks, because the native tool ignores the id.
    const native = { registrationId: "process.native" };
    expect(policy.isWaitCall({ id: "t5", name: PROCESS_TOOL_NAME, ...native, input: { action: "wait", process_id: "process-1" } })).toBe(true);
    expect(policy.isWaitCall({ id: "t6", name: PROCESS_TOOL_NAME, input: { action: "wait", process_id: "process-1" } })).toBe(true);
    policy.settleWaitCalls([waitCall]);
    expect(mailbox.drainPending()).toMatchObject({ kind: "message", origin: "silent-system", runtimeNotice: true, text: expect.stringContaining("<wait_notification>") });
  });

  test("a wait with live background work marks the turn and enqueues nothing", () => {
    const mailbox = new ChatTurnMailbox();
    let waitRequested = false;
    const policy = createWaitToolPolicy(
      () => true,
      () => { waitRequested = true; },
      (text) => mailbox.enqueueSilentSystem(text),
    );

    policy.settleWaitCalls([waitCall]);
    expect(waitRequested).toBe(true);
    expect(mailbox.hasPending).toBe(false);
  });

  test("native waits carry a fresh estimate, default to four minutes, and reject invalid durations", () => {
    const durations: (number | undefined)[] = [];
    const policy = createWaitToolPolicy(() => true, (seconds) => { durations.push(seconds); });
    policy.settleWaitCalls([{ ...waitCall, input: { action: "wait", soft_timeout: 7200 } }]);
    policy.settleWaitCalls([waitCall]);
    expect(durations).toEqual([7200, 240]);
    for (const soft_timeout of [0, -1, Infinity, Number.NaN, 2147483.648, "7200"]) {
      expect(policy.isWaitCall({ ...waitCall, input: { action: "wait", soft_timeout } })).toBe(false);
    }
  });

  test("reply-owned waits carry no expiry, while a mixed batch carries the explicit process estimate", () => {
    const durations: (number | undefined)[] = [];
    const reply: ToolCall = { id: "reply", name: "message_session", input: { wait: true } };
    const policy = createWaitToolPolicy(() => true, (seconds) => { durations.push(seconds); }, undefined, (id) => id === reply.id);
    expect(policy.isWaitCall(reply)).toBe(true);
    policy.settleWaitCalls([reply]);
    policy.settleWaitCalls([reply, { ...waitCall, input: { action: "wait", soft_timeout: 7200 } }]);
    expect(durations).toEqual([undefined, 7200]);
  });
});
