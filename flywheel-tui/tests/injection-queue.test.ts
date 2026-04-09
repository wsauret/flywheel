/**
 * Tests for InjectionQueue — replaces the manual pendingInjection + stdinHandleRef pattern.
 *
 * InjectionQueue encapsulates:
 * - FIFO queue of pending messages
 * - Bound stdin handle (set when subprocess starts, cleared when it exits)
 * - Formatter function (engine-specific stdin formatting)
 * - deliverOrEnqueue(text): try write to stdin, queue if not available
 * - drainAtTurnBoundary(): drain queue items to stdin at turn boundaries
 * - bindStdin(handle): bind/unbind the stdin handle
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { InjectionQueue } from "../src/orchestration/engines/subprocess/injection-queue";

// ---------------------------------------------------------------------------
// Mock StdinHandle
// ---------------------------------------------------------------------------

interface MockStdinHandle {
  isOpen: boolean;
  written: string[];
  write(data: string): boolean;
  close(): void;
}

function createMockStdinHandle(open = true): MockStdinHandle {
  const handle: MockStdinHandle = {
    isOpen: open,
    written: [],
    write(data: string): boolean {
      if (!handle.isOpen) return false;
      handle.written.push(data);
      return true;
    },
    close() {
      handle.isOpen = false;
    },
  };
  return handle;
}

// Simple identity formatter for tests
const identityFormatter = (text: string) => `[formatted:${text}]`;

// ---------------------------------------------------------------------------
// FIFO ordering
// ---------------------------------------------------------------------------

describe("InjectionQueue — FIFO ordering", () => {
  it("enqueue preserves insertion order", () => {
    const q = new InjectionQueue(identityFormatter);
    q.enqueue("first");
    q.enqueue("second");
    q.enqueue("third");

    // Bind a handle so drain works — one item per drain call
    const handle = createMockStdinHandle();
    q.bindStdin(handle);
    q.drainAtTurnBoundary();
    q.drainAtTurnBoundary();
    q.drainAtTurnBoundary();

    expect(handle.written).toEqual([
      "[formatted:first]",
      "[formatted:second]",
      "[formatted:third]",
    ]);
  });

  it("enqueue after partial drain maintains order", () => {
    const q = new InjectionQueue(identityFormatter);
    q.enqueue("a");
    q.enqueue("b");

    const handle = createMockStdinHandle();
    q.bindStdin(handle);

    // Drain only delivers one per call (turn boundary = one message)
    q.drainAtTurnBoundary();
    expect(handle.written).toEqual(["[formatted:a]"]);

    // Enqueue more
    q.enqueue("c");

    // Next drain delivers next in FIFO
    q.drainAtTurnBoundary();
    expect(handle.written).toEqual(["[formatted:a]", "[formatted:b]"]);

    q.drainAtTurnBoundary();
    expect(handle.written).toEqual(["[formatted:a]", "[formatted:b]", "[formatted:c]"]);
  });
});

// ---------------------------------------------------------------------------
// deliverOrEnqueue
// ---------------------------------------------------------------------------

describe("InjectionQueue — deliverOrEnqueue", () => {
  it("delivers directly when stdin handle is bound and open", () => {
    const q = new InjectionQueue(identityFormatter);
    const handle = createMockStdinHandle();
    q.bindStdin(handle);

    const result = q.deliverOrEnqueue("hello");

    expect(result).toBe(true);
    expect(handle.written).toEqual(["[formatted:hello]"]);
  });

  it("enqueues when no stdin handle is bound", () => {
    const q = new InjectionQueue(identityFormatter);

    const result = q.deliverOrEnqueue("hello");

    expect(result).toBe(true);

    // Now bind and drain to verify it was queued
    const handle = createMockStdinHandle();
    q.bindStdin(handle);
    q.drainAtTurnBoundary();

    expect(handle.written).toEqual(["[formatted:hello]"]);
  });

  it("enqueues when stdin handle is closed", () => {
    const q = new InjectionQueue(identityFormatter);
    const handle = createMockStdinHandle(false); // closed
    q.bindStdin(handle);

    const result = q.deliverOrEnqueue("hello");

    expect(result).toBe(true);

    // Re-bind with open handle and drain
    const openHandle = createMockStdinHandle();
    q.bindStdin(openHandle);
    q.drainAtTurnBoundary();

    expect(openHandle.written).toEqual(["[formatted:hello]"]);
  });

  it("enqueues when write throws", () => {
    const q = new InjectionQueue(identityFormatter);
    const handle = createMockStdinHandle();
    handle.write = () => { throw new Error("pipe broken"); };
    q.bindStdin(handle);

    const result = q.deliverOrEnqueue("hello");

    expect(result).toBe(true);

    // Re-bind with working handle and drain
    const goodHandle = createMockStdinHandle();
    q.bindStdin(goodHandle);
    q.drainAtTurnBoundary();

    expect(goodHandle.written).toEqual(["[formatted:hello]"]);
  });
});

// ---------------------------------------------------------------------------
// bindStdin lifecycle
// ---------------------------------------------------------------------------

describe("InjectionQueue — bindStdin lifecycle", () => {
  it("bindStdin(null) unbinds the handle", () => {
    const q = new InjectionQueue(identityFormatter);
    const handle = createMockStdinHandle();
    q.bindStdin(handle);
    q.bindStdin(null);

    // deliverOrEnqueue should now queue since no handle
    q.deliverOrEnqueue("msg");

    expect(handle.written).toEqual([]);
  });

  it("bindStdin replaces the previous handle", () => {
    const q = new InjectionQueue(identityFormatter);
    const handle1 = createMockStdinHandle();
    const handle2 = createMockStdinHandle();

    q.bindStdin(handle1);
    q.bindStdin(handle2);

    q.deliverOrEnqueue("msg");

    expect(handle1.written).toEqual([]);
    expect(handle2.written).toEqual(["[formatted:msg]"]);
  });

  it("drain does nothing with no bound handle", () => {
    const q = new InjectionQueue(identityFormatter);
    q.enqueue("a");
    q.enqueue("b");

    // No handle bound — drain should be a no-op (returns false or does nothing)
    q.drainAtTurnBoundary();

    // Items should still be queued
    const handle = createMockStdinHandle();
    q.bindStdin(handle);
    q.drainAtTurnBoundary();
    q.drainAtTurnBoundary();

    expect(handle.written).toEqual(["[formatted:a]", "[formatted:b]"]);
  });

  it("drain closes handle when queue is empty", () => {
    const q = new InjectionQueue(identityFormatter);
    const handle = createMockStdinHandle();
    q.bindStdin(handle);

    // Queue is empty — drain should close the handle
    q.drainAtTurnBoundary();

    expect(handle.isOpen).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Concurrent enqueue + drain
// ---------------------------------------------------------------------------

describe("InjectionQueue — concurrent enqueue + drain", () => {
  it("interleaved enqueue and drain preserves all messages", () => {
    const q = new InjectionQueue(identityFormatter);
    const handle = createMockStdinHandle();
    q.bindStdin(handle);

    q.enqueue("1");
    q.drainAtTurnBoundary(); // delivers "1"

    q.enqueue("2");
    q.enqueue("3");
    q.drainAtTurnBoundary(); // delivers "2"
    q.drainAtTurnBoundary(); // delivers "3"

    expect(handle.written).toEqual([
      "[formatted:1]",
      "[formatted:2]",
      "[formatted:3]",
    ]);
  });

  it("deliverOrEnqueue works correctly between drain calls", () => {
    const q = new InjectionQueue(identityFormatter);
    const handle = createMockStdinHandle();
    q.bindStdin(handle);

    q.enqueue("queued-1");
    q.deliverOrEnqueue("direct-1"); // should deliver directly
    q.drainAtTurnBoundary();        // should deliver "queued-1"

    expect(handle.written).toEqual([
      "[formatted:direct-1]",
      "[formatted:queued-1]",
    ]);
  });

  it("handles rapid enqueue then full drain", () => {
    const q = new InjectionQueue(identityFormatter);
    const handle = createMockStdinHandle();
    q.bindStdin(handle);

    for (let i = 0; i < 5; i++) {
      q.enqueue(`msg-${i}`);
    }

    // Drain all 5
    for (let i = 0; i < 5; i++) {
      q.drainAtTurnBoundary();
    }

    expect(handle.written).toHaveLength(5);
    expect(handle.written[0]).toBe("[formatted:msg-0]");
    expect(handle.written[4]).toBe("[formatted:msg-4]");
  });
});
