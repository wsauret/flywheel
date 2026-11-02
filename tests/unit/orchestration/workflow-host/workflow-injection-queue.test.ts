/**
 * Tests for WorkflowInjectionQueue — workflow message and control delivery.
 *
 * Observer nudges and accepted messages are enqueued and drained at
 * turn boundaries. No stdin or agent coupling.
 */

import { describe, test, expect } from "bun:test";
import { WorkflowInjectionQueue } from "../../../../src/orchestration/workflow-host/injection-queue";

describe("WorkflowInjectionQueue", () => {
  test("admitted handoff blocks every queued and later input kind while preserving unread human input for settlement", async () => {
    const queue = new WorkflowInjectionQueue();
    queue.enqueueMessage({ text: "unread", dispatchIds: ["human"] });
    queue.enqueue("already queued notice", { silent: true });
    queue.enqueueCompact();
    queue.enqueueResume();
    expect(queue.handoffStarted()).toBe(true);
    expect(queue.handoffStarted()).toBe(false);
    expect(queue.enqueue("later notice", { silent: true })).toBe(false);
    queue.enqueueMessage("later person");
    queue.enqueueAcceptedNotice("later return", "notice");
    queue.enqueueRuntimeNotice("wait expiry");
    queue.enqueueCompact();
    queue.enqueueResume();
    expect(queue.drain()).toBeNull();
    expect(queue.drainPending()).toBeNull();
    const signal = new AbortController();
    const waiting = queue.prepareWaitForInput(signal.signal).commit();
    signal.abort();
    expect(await waiting).toBeNull();
    expect(queue.withdrawHuman()?.input).toEqual({ text: "unread", dispatchIds: ["human"] });
    expect(queue.withdrawHuman()).toBeNull();
  });

  test("drain combines multiple queued items with double-newline separator", () => {
    const q = new WorkflowInjectionQueue();
    q.enqueue("first");
    q.enqueue("second");
    q.enqueue("third");
    const result = q.drain();
    expect(result).toMatchObject({ message: "first\n\nsecond\n\nthird" });
    q.enqueueMessage({ text: "first", dispatchIds: ["entry-1"] });
    q.enqueueMessage({ text: "second", dispatchIds: ["entry-2"] });
    expect(q.drainPending()).toMatchObject({ text: "first", dispatchIds: ["entry-1"] });
    expect(q.drainPending()).toMatchObject({ text: "second", dispatchIds: ["entry-2"] });
  });

  test("drain empties the queue", () => {
    const q = new WorkflowInjectionQueue();
    q.enqueue("hello");
    q.drain();
    expect(q.drain()).toBeNull();
  });

  test("takes back only the accepted message held under one cell, while the step has not read it", () => {
    const q = new WorkflowInjectionQueue();
    q.enqueue("system nudge");
    q.enqueueMessage({ text: "first user edit", dispatchIds: ["cell-1"] });
    q.enqueueMessage({ text: "second user edit", dispatchIds: ["cell-2"] });

    expect(q.holdsMessage("cell-2")).toBe(true);
    expect(q.takeMessage("cell-2")).toEqual({ text: "second user edit", dispatchIds: ["cell-2"] });
    expect(q.holdsMessage("cell-2")).toBe(false);
    expect(q.takeMessage("cell-2")).toBeNull();
    expect(q.drain()).toMatchObject({ message: "system nudge" });
    expect(q.drain()).toMatchObject({ message: "first user edit", origin: "human" });
    expect(q.takeMessage("cell-1")).toBeNull();
  });

  test("drain keeps a message of the person separate from system input", () => {
    const q = new WorkflowInjectionQueue();
    q.enqueue("system nudge");
    q.enqueueMessage("user steering");

    expect(q.drain()).toMatchObject({ message: "system nudge" });
    expect(q.drain()).toMatchObject({ message: "user steering", origin: "human" });
  });

  test("keeps messages from different session tool calls as separate canonical inputs with the session origin", () => {
    const queue = new WorkflowInjectionQueue();
    const producer = (toolUseId: string) => ({ kind: "session" as const, sessionId: "parent", conversationId: "conversation", toolUseId, hop: 0 });
    queue.enqueueMessage({ text: "first", dispatchIds: ["first-cell"], producer: producer("tool-1") });
    queue.enqueueMessage({ text: "second", dispatchIds: ["second-cell"], producer: producer("tool-2") });
    queue.enqueueMessage("from the person");

    expect(queue.drainPending()).toMatchObject({
      kind: "message",
      text: "first",
      origin: "session",
      dispatchIds: ["first-cell"],
      producer: { kind: "session", toolUseId: "tool-1" },
    });
    expect(queue.drainPending()).toMatchObject({
      kind: "message",
      text: "second",
      origin: "session",
      dispatchIds: ["second-cell"],
      producer: { kind: "session", toolUseId: "tool-2" },
    });
    expect(queue.drainPending()).toMatchObject({ kind: "message", text: "from the person", origin: "human" });
  });

  test("drain keeps silent input separate from visible input", () => {
    const q = new WorkflowInjectionQueue();
    q.enqueue("backend", { silent: true });
    q.enqueue("visible system nudge");

    expect(q.drain()).toMatchObject({ message: "backend", origin: "silent-system" });
    expect(q.drain()).toMatchObject({ message: "visible system nudge" });
  });

  test("discardPending removes stale workflow input before follow-up mode", () => {
    const q = new WorkflowInjectionQueue();
    q.enqueueMessage("stale steering");
    q.enqueueCompact();

    q.discardPending();

    expect(q.drainPending()).toBeNull();
  });

  test("drainPending preserves compact control ordering between text batches", () => {
    const q = new WorkflowInjectionQueue();
    q.enqueue("before");
    q.enqueueCompact();
    q.enqueue("after");

    expect(q.drainPending()).toEqual({ kind: "message", text: "before" });
    expect(q.drainPending()).toEqual({ kind: "compact" });
    expect(q.drainPending()).toEqual({ kind: "message", text: "after" });
    expect(q.drainPending()).toBeNull();
  });

  test("drainPending delivers a held notification alone under its hold key", () => {
    const q = new WorkflowInjectionQueue();
    q.enqueue("earlier", { silent: true });
    q.enqueue("<subagent_notifications>done</subagent_notifications>", {
      silent: true,
      backgroundNotificationId: "subagent-completions:run",
    });
    q.enqueue("later", { silent: true });

    expect(q.drainPending()).toEqual({ kind: "message", text: "earlier", origin: "silent-system" });
    expect(q.drainPending()).toEqual({
      kind: "message",
      text: "<subagent_notifications>done</subagent_notifications>",
      origin: "silent-system",
      backgroundNotificationIds: ["subagent-completions:run"],
    });
    expect(q.drainPending()).toEqual({ kind: "message", text: "later", origin: "silent-system" });
  });

  test("labels only runtime notices, and never merges a keyless notice with a keyless silent nudge", () => {
    const q = new WorkflowInjectionQueue();
    q.enqueue("silent nudge", { silent: true });
    q.enqueueRuntimeNotice("<wait_notification/>");
    q.enqueueRuntimeNotice("<subagent_notifications/>", "subagent-completions:run");
    q.enqueueMessage("from the person");
    q.enqueueAcceptedNotice("returned message", "notice");
    q.enqueueMessage({ text: "held peer", producer: { kind: "session", sessionId: "peer", conversationId: "c", toolUseId: "t", hop: 1 } }, { held: true });

    expect(q.drainPending()).toEqual({ kind: "message", text: "silent nudge", origin: "silent-system" });
    expect(q.drainPending()).toEqual({ kind: "message", text: "<wait_notification/>", origin: "silent-system", runtimeNotice: true });
    expect(q.drainPending()).toEqual({ kind: "message", text: "<subagent_notifications/>", origin: "silent-system", backgroundNotificationIds: ["subagent-completions:run"], runtimeNotice: true });
    for (const text of ["from the person", "returned message", "held peer"]) {
      const drained = q.drainPending();
      expect(drained).toMatchObject({ kind: "message", text });
      expect(drained).not.toHaveProperty("runtimeNotice");
    }
  });

  test("prepared input resolves when compact is enqueued", async () => {
    const q = new WorkflowInjectionQueue();
    const promise = q.prepareWaitForInput().commit();
    q.enqueueCompact();
    await expect(promise).resolves.toEqual({ kind: "compact" });
  });

  test("prepared input resolves null when the abort signal fires while parked", async () => {
    const q = new WorkflowInjectionQueue();
    const ac = new AbortController();
    const promise = q.prepareWaitForInput(ac.signal).commit();
    ac.abort();
    await expect(promise).resolves.toBeNull();
  });
});

describe("WorkflowInjectionQueue.waitForMessage", () => {
  test("resolves immediately when queue already has items", async () => {
    const q = new WorkflowInjectionQueue();
    q.enqueue("already here");
    const result = await q.waitForMessage();
    expect(result).toMatchObject({ message: "already here" });
  });

  test("blocks until enqueue is called, then resolves with the drained result", async () => {
    const q = new WorkflowInjectionQueue();
    const promise = q.waitForMessage();
    q.enqueue("late arrival");
    const result = await promise;
    expect(result).toMatchObject({ message: "late arrival" });
  });

  test("abort while parked does not consume messages enqueued after cancellation", async () => {
    const q = new WorkflowInjectionQueue();
    const ac = new AbortController();
    const promise = q.waitForMessage(ac.signal);
    ac.abort();
    q.enqueue("arrived after abort");

    await expect(promise).resolves.toBeNull();
    expect(q.drain()).toMatchObject({ message: "arrived after abort" });
  });

  test("multiple enqueues before waitForMessage resolves are joined into a single drained result", async () => {
    const q = new WorkflowInjectionQueue();
    const promise = q.waitForMessage();
    q.enqueue("one");
    q.enqueue("two");
    // The first enqueue resolves the waiter; it drains everything available at that point.
    // But the second enqueue happens synchronously before the microtask resolves,
    // so drain() sees both items.
    const result = await promise;
    expect(result).toMatchObject({ message: "one\n\ntwo" });
  });

  test("throws when called concurrently", async () => {
    const q = new WorkflowInjectionQueue();
    // First call blocks (queue is empty, no signal)
    const first = q.waitForMessage();
    // Second call while first is still waiting must throw
    expect(() => q.waitForMessage()).toThrow(
      "WorkflowInjectionQueue: concurrent waitForMessage calls are not supported",
    );
    // Clean up: resolve the first waiter
    q.enqueue("cleanup");
    await first;
  });

  test("returns null immediately when signal is already aborted", async () => {
    const q = new WorkflowInjectionQueue();
    const ac = new AbortController();
    ac.abort();
    const result = await q.waitForMessage(ac.signal);
    expect(result).toBeNull();
  });

  test("drains pending items even when signal is already aborted", async () => {
    const q = new WorkflowInjectionQueue();
    q.enqueue("pending");
    const ac = new AbortController();
    ac.abort();
    // drain fast-path fires before the aborted check
    const result = await q.waitForMessage(ac.signal);
    expect(result).toMatchObject({ message: "pending" });
  });

});

