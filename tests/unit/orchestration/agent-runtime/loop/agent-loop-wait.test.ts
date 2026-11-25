import { describe, expect, test } from "bun:test";
import { createSettledBatchObservation, createWaitToolPolicy } from "../../../../../src/orchestration/agent-runtime/loop/agent-loop-wait.js";
import type { ToolCall } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { processToolDefinition } from "../../../../../src/orchestration/agent-runtime/tools/sessions/process.js";
import { ChatTurnMailbox } from "../../../../../src/orchestration/chat/turn-mailbox.js";

/** The name a model calls the process tool by. */
const PROCESS_TOOL_NAME = processToolDefinition(false, true).name;
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

  test("native waits carry a fresh estimate up to one hour, default to four minutes, and reject invalid durations", () => {
    const durations: (number | undefined)[] = [];
    const policy = createWaitToolPolicy(() => true, (seconds) => { durations.push(seconds); });
    policy.settleWaitCalls([{ ...waitCall, input: { action: "wait", soft_timeout: 600 } }]);
    policy.settleWaitCalls([{ ...waitCall, input: { action: "wait", soft_timeout: 7200 } }]);
    policy.settleWaitCalls([waitCall]);
    expect(durations).toEqual([600, 3600, 240]);
    for (const soft_timeout of [0, -1, Infinity, Number.NaN, "7200"]) {
      expect(policy.isWaitCall({ ...waitCall, input: { action: "wait", soft_timeout } })).toBe(false);
    }
  });

  test("reply-owned waits carry no expiry, while a mixed batch carries the explicit process estimate", () => {
    const durations: (number | undefined)[] = [];
    const reply: ToolCall = { id: "reply", name: "message_session", input: { wait: true } };
    const policy = createWaitToolPolicy(() => true, (seconds) => { durations.push(seconds); }, undefined, (id) => id === reply.id);
    expect(policy.isWaitCall(reply)).toBe(true);
    policy.settleWaitCalls([reply]);
    policy.settleWaitCalls([reply, { ...waitCall, input: { action: "wait", soft_timeout: 600 } }]);
    expect(durations).toEqual([undefined, 600]);
  });
});

describe("settled wait batches", () => {
  test("a batch of native waits reads the live background work once, whatever its size", async () => {
    // The read scans the session's background work, so it must not run once per call.
    for (const size of [1, 32]) {
      let reads = 0;
      const policy = createWaitToolPolicy(() => { reads += 1; return true; }, () => undefined);
      const observation = createSettledBatchObservation(policy, () => undefined, () => undefined);
      const calls = Array.from({ length: size }, (_, index): ToolCall => ({ ...waitCall, id: `w${index}` }));
      expect(await observation.observe(calls, calls.map((call) => ({ toolUseId: call.id, outcome: "ok" as const })), "ok")).toBe(true);
      expect({ size, reads }).toEqual({ size, reads: 1 });
    }
  });
});

describe("yield placeholder calls", () => {
  const bash = (command: string): ToolCall => ({ id: "tc", name: "bash", input: { command } });
  // A yield placeholder is a wait call; no reply wait is open, so nothing else makes a bash call one.
  const isYieldPlaceholderToolCall = (call: ToolCall, pending: boolean) => createWaitToolPolicy(() => pending, () => undefined).isWaitCall(call);

  test("never drops anything without pending background work -- there is nothing to wake the loop", () => {
    for (const command of ["true", ":", "true; true", "echo waiting", "sleep 1", `printf "standing by"`, "echo waiting; sleep 1", ":  # idle"]) {
      expect(isYieldPlaceholderToolCall(bash(command), false)).toBe(false);
    }
  });

  test("with pending background work, matches pure no-op commands that express wait/yield intent", () => {
    for (const command of ["echo waiting", `echo "I'll wait for the subagent"`, "echo yielding turn", "echo waiting; sleep 1", `printf "standing by"`, "sleep 5 # waiting", ":  # idle"]) {
      expect(isYieldPlaceholderToolCall(bash(command), true)).toBe(true);
    }
  });

  test("with pending background work, matches bare true/colon/sleep ticks without any wait-intent text", () => {
    for (const command of ["true", "true # tick", ":", "true; true", "true && :", "sleep 1", "sleep 0.5", "sleep 5s # tick", "sleep 1; sleep 2", "sleep 1 && true"]) {
      expect(isYieldPlaceholderToolCall(bash(command), true)).toBe(true);
    }
  });

  test("does not treat true with arguments or trailing real work as a tick", () => {
    for (const command of ["true foo", "true && bun run build", "truecmd"]) {
      expect(isYieldPlaceholderToolCall(bash(command), true)).toBe(false);
    }
  });

  test("does not treat sleep with trailing real work as a tick", () => {
    for (const command of ["sleep 1 && curl localhost:3000", "sleep 2; bun run test", "sleep"]) {
      expect(isYieldPlaceholderToolCall(bash(command), true)).toBe(false);
    }
  });

  test("leaves harmless or real commands alone even with pending background work", () => {
    for (const command of ["echo hello world", "echo bg-test", "echo done", "bun run test"]) {
      expect(isYieldPlaceholderToolCall(bash(command), true)).toBe(false);
    }
  });

  test("applies to the bash tool, including a recorded exec call, and to no other tool", () => {
    expect(isYieldPlaceholderToolCall({ id: "tc", name: "exec", input: { command: "echo waiting" } }, true)).toBe(true);
    expect(isYieldPlaceholderToolCall({ id: "tc", name: "read", input: { command: "echo waiting" } }, true)).toBe(false);
    expect(isYieldPlaceholderToolCall({ id: "tc", name: "bash", input: {} }, true)).toBe(false);
  });

  test("with pending background work, a leading no-op + wait intent is enough even with junk trailing", () => {
    for (const command of ["echo waiting is not allowed; yielding", "echo standing by && some-junk", "sleep 1 # holding; foo"]) {
      expect(isYieldPlaceholderToolCall(bash(command), true)).toBe(true);
      // Without pending background work the trailing non-no-op must run.
      expect(isYieldPlaceholderToolCall(bash(command), false)).toBe(false);
    }
  });

  test("does not relax for a leading real command even with pending background work", () => {
    // Leading segment is real work; never a yield regardless of background work.
    expect(isYieldPlaceholderToolCall(bash("bun run build # waiting"), true)).toBe(false);
    // No wait intent: a leading no-op alone is not a yield.
    expect(isYieldPlaceholderToolCall(bash("echo hi; some-junk"), true)).toBe(false);
  });

  test("never treats a background launch as a yield: it starts the work that the turn then owes", () => {
    for (const command of ["printf ok > /scratch/idle-background-1.marker; sleep 30", "echo waiting", "sleep 5", "true"]) {
      expect(isYieldPlaceholderToolCall({ id: "tc", name: "bash", input: { command, background: true } }, true)).toBe(false);
    }
  });

  test("reads wait intent only in the leading no-op, and a leading write is not a no-op", () => {
    for (const command of ["printf ok > /scratch/idle.marker; bun run serve", "echo started >> pending.log", "sleep 1; cat pending.log"]) {
      expect(isYieldPlaceholderToolCall(bash(command), true)).toBe(false);
    }
  });
});
