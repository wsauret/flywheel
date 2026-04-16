import { describe, it, expect, afterEach } from "bun:test";

import {
  createDebouncedWriter,
  type DebouncedWriter,
} from "../src/infra/debounced-writer";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wait for a given number of milliseconds. */
function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Create a spy write function that records calls and optionally delays. */
function createWriteSpy(delayMs = 0) {
  const calls: { data: unknown; time: number }[] = [];
  let inFlight = 0;
  let maxConcurrent = 0;

  const write = async (data: unknown): Promise<void> => {
    inFlight++;
    if (inFlight > maxConcurrent) maxConcurrent = inFlight;
    calls.push({ data, time: Date.now() });
    if (delayMs > 0) {
      await wait(delayMs);
    }
    inFlight--;
  };

  return {
    write,
    calls,
    get maxConcurrent() {
      return maxConcurrent;
    },
    get inFlight() {
      return inFlight;
    },
  };
}

// ---------------------------------------------------------------------------
// Basic scheduling
// ---------------------------------------------------------------------------

describe("createDebouncedWriter — basic scheduling", () => {
  it("does not write immediately on schedule()", async () => {
    const spy = createWriteSpy();
    const writer = createDebouncedWriter(spy.write, { intervalMs: 10 });

    writer.schedule("data-1");
    expect(spy.calls).toHaveLength(0);

    writer.dispose();
  });

  it("writes after the interval elapses", async () => {
    const spy = createWriteSpy();
    const writer = createDebouncedWriter(spy.write, { intervalMs: 5 });

    writer.schedule("data-1");
    await wait(15);

    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].data).toBe("data-1");

    writer.dispose();
  });

  it("coalesces multiple schedule() calls into one write", async () => {
    const spy = createWriteSpy();
    const writer = createDebouncedWriter(spy.write, { intervalMs: 10 });

    writer.schedule("data-1");
    writer.schedule("data-2");
    writer.schedule("data-3");

    await wait(25);

    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].data).toBe("data-3");

    writer.dispose();
  });

  it("resets the debounce timer on each schedule()", async () => {
    const spy = createWriteSpy();
    const writer = createDebouncedWriter(spy.write, { intervalMs: 15 });

    writer.schedule("data-1");
    await wait(8);
    writer.schedule("data-2"); // resets timer
    await wait(8);

    // Timer hasn't fired yet (reset at t=8, now at t=16, needs t=23)
    expect(spy.calls).toHaveLength(0);

    await wait(15);

    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].data).toBe("data-2");

    writer.dispose();
  });
});

// ---------------------------------------------------------------------------
// flush()
// ---------------------------------------------------------------------------

describe("createDebouncedWriter — flush()", () => {
  it("immediately writes pending data", async () => {
    const spy = createWriteSpy();
    const writer = createDebouncedWriter(spy.write, { intervalMs: 5000 });

    writer.schedule("flush-me");
    await writer.flush();

    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].data).toBe("flush-me");

    writer.dispose();
  });

  it("is a no-op when nothing is scheduled", async () => {
    const spy = createWriteSpy();
    const writer = createDebouncedWriter(spy.write, { intervalMs: 5000 });

    await writer.flush();
    expect(spy.calls).toHaveLength(0);

    writer.dispose();
  });

  it("cancels the pending debounce timer", async () => {
    const spy = createWriteSpy();
    const writer = createDebouncedWriter(spy.write, { intervalMs: 10 });

    writer.schedule("data");
    await writer.flush();

    // Wait for original timer to elapse — should NOT double-write
    await wait(25);

    expect(spy.calls).toHaveLength(1);

    writer.dispose();
  });
});

// ---------------------------------------------------------------------------
// In-flight write guard (serialization)
// ---------------------------------------------------------------------------

describe("createDebouncedWriter — write serialization", () => {
  it("queues next write while one is in-flight", async () => {
    const spy = createWriteSpy(20); // 20ms write delay
    const writer = createDebouncedWriter(spy.write, { intervalMs: 5 });

    writer.schedule("write-1");
    await wait(10); // debounce fires, write starts

    writer.schedule("write-2");
    await wait(10); // debounce fires for write-2, but should queue

    expect(spy.inFlight).toBeLessThanOrEqual(1);

    await wait(60);

    expect(spy.calls.length).toBeGreaterThanOrEqual(2);
    expect(spy.maxConcurrent).toBe(1);

    writer.dispose();
  });

  it("flush waits for in-flight write to complete", async () => {
    const spy = createWriteSpy(20); // 20ms write delay
    const writer = createDebouncedWriter(spy.write, { intervalMs: 5 });

    writer.schedule("data-1");
    await wait(10); // debounce fires, write-1 starts

    writer.schedule("data-2");

    await writer.flush();

    expect(spy.inFlight).toBe(0);

    writer.dispose();
  });
});

// ---------------------------------------------------------------------------
// dispose()
// ---------------------------------------------------------------------------

describe("createDebouncedWriter — dispose()", () => {
  it("cancels pending timer", async () => {
    const spy = createWriteSpy();
    const writer = createDebouncedWriter(spy.write, { intervalMs: 10 });

    writer.schedule("data");
    writer.dispose();

    await wait(25);

    expect(spy.calls).toHaveLength(0);
  });

  it("schedule() is a no-op after dispose", async () => {
    const spy = createWriteSpy();
    const writer = createDebouncedWriter(spy.write, { intervalMs: 5 });

    writer.dispose();
    writer.schedule("data");

    await wait(15);

    expect(spy.calls).toHaveLength(0);
  });

  it("dispose is safe to call multiple times", () => {
    const spy = createWriteSpy();
    const writer = createDebouncedWriter(spy.write, { intervalMs: 5 });

    writer.dispose();
    writer.dispose(); // should not throw
  });
});
