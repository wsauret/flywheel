import { describe, expect, it, jest } from "bun:test";
import { createBackgroundWorkRegistry, type BackgroundWorkResult } from "../../../../src/orchestration/agent-runtime/background-work.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("background task stall watchdog", () => {
  it("waits for actual inactivity before firing the stall watchdog", async () => {
    let aborted = false;
    let idle = false;
    const notification = Promise.withResolvers<string>();
    const registry = createBackgroundWorkRegistry({
      kind: "chat",
      enqueueNotification: (text) => { notification.resolve(text); },
    });
    const done = deferred<BackgroundWorkResult>();

    registry.track({
      done: done.promise,
      meta: { id: "t1", type: "subagent", description: "Slow task" },
      stall: { isIdle: () => idle, abort: () => { aborted = true; }, timeoutMs: 5 },
    });

    try {
      await delay(20);
      expect(aborted).toBe(false);
      idle = true;
      await delay(20);
      expect(aborted).toBe(true);
      done.reject(new DOMException("aborted", "AbortError"));
      const note = await notification.promise;
      expect(note).toContain("<status>failed</status>");
      expect(note).toContain("stall watchdog");
    } finally {
      done.resolve({ status: "completed", content: "done" });
      await registry.terminateAll();
    }
  });

  it("bumping the handle delays the stall watchdog past its original deadline", async () => {
    jest.useFakeTimers();
    let aborted = false;
    const registry = createBackgroundWorkRegistry({
      kind: "chat",
      enqueueNotification: () => {},
    });
    const done = deferred<BackgroundWorkResult>();

    const handle = registry.track({
      done: done.promise,
      meta: { id: "t1", type: "subagent", description: "Long task" },
      stall: { isIdle: () => true, abort: () => { aborted = true; }, timeoutMs: 30 },
    });

    try {
      jest.advanceTimersByTime(15); handle.bump();
      jest.advanceTimersByTime(15); handle.bump();
      jest.advanceTimersByTime(15); handle.bump();
      expect(aborted).toBe(false);

      jest.advanceTimersByTime(29);
      expect(aborted).toBe(false);
      jest.advanceTimersByTime(1);
      expect(aborted).toBe(true);
    } finally {
      done.resolve({ status: "completed", content: "ok" });
      await done.promise;
      registry.flushSettledNotifications();
      jest.useRealTimers();
    }
  });

  it("bumping after the watchdog has fired is a no-op", async () => {
    let abortCount = 0;
    const registry = createBackgroundWorkRegistry({
      kind: "chat",
      enqueueNotification: () => {},
    });
    const done = deferred<BackgroundWorkResult>();

    const handle = registry.track({
      done: done.promise,
      meta: { id: "t1", type: "subagent", description: "Doomed task" },
      stall: { isIdle: () => true, abort: () => { abortCount++; }, timeoutMs: 20 },
    });

    await delay(40);
    expect(abortCount).toBe(1);

    handle.bump();
    await delay(40);
    expect(abortCount).toBe(1);

    done.reject(new DOMException("aborted", "AbortError"));
    await delay(5);
  });
});
