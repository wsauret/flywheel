/**
 * Tests for InjectionQueue — a pure queue for runner.send() message delivery.
 *
 * Observer nudges and user-steering messages are enqueued and drained at
 * turn boundaries. No stdin or engine coupling.
 */

import { describe, test, expect } from "bun:test";
import { InjectionQueue } from "../src/orchestration/injection-queue";

describe("InjectionQueue", () => {
  test("drain returns null when empty", () => {
    const q = new InjectionQueue();
    expect(q.drain()).toBeNull();
  });

  test("enqueue + drain returns the single queued item", () => {
    const q = new InjectionQueue();
    q.enqueue("hello");
    const result = q.drain();
    expect(result).toEqual({ message: "hello", userSteering: false });
  });

  test("drain combines multiple queued items with double-newline separator", () => {
    const q = new InjectionQueue();
    q.enqueue("first");
    q.enqueue("second");
    q.enqueue("third");
    const result = q.drain();
    expect(result).toEqual({ message: "first\n\nsecond\n\nthird", userSteering: false });
  });

  test("drain empties the queue", () => {
    const q = new InjectionQueue();
    q.enqueue("hello");
    q.drain();
    expect(q.drain()).toBeNull();
  });

  test("userSteering tag preserved when true", () => {
    const q = new InjectionQueue();
    q.enqueue("user message", true);
    const result = q.drain();
    expect(result).toEqual({ message: "user message", userSteering: true });
  });

  test("userSteering is true if ANY item in drain is user-steering", () => {
    const q = new InjectionQueue();
    q.enqueue("system nudge");
    q.enqueue("user steering", true);
    const result = q.drain();
    expect(result?.userSteering).toBe(true);
  });

  test("userSteering is false when all items are system messages", () => {
    const q = new InjectionQueue();
    q.enqueue("nudge 1");
    q.enqueue("nudge 2");
    const result = q.drain();
    expect(result?.userSteering).toBe(false);
  });

  test("FIFO ordering preserved in drain", () => {
    const q = new InjectionQueue();
    q.enqueue("a");
    q.enqueue("b");
    q.enqueue("c");
    expect(q.drain()?.message).toBe("a\n\nb\n\nc");
  });

  test("enqueue after drain works on fresh queue", () => {
    const q = new InjectionQueue();
    q.enqueue("first batch");
    q.drain();
    q.enqueue("second batch");
    expect(q.drain()?.message).toBe("second batch");
  });
});
