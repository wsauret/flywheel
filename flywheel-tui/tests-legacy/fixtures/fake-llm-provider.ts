/**
 * FakeLLMProvider — test double implementing LLMProvider interface.
 *
 * Produces predetermined StreamEvent sequences for unit tests.
 * No mocks — real class, real interface contract.
 * Reusable across Phase 1-4 tests.
 */

import type {
  LLMProvider,
  StreamEvent,
  StreamOptions,
} from "../../src/harness";

export class FakeLLMProvider implements LLMProvider {
  /** Predetermined events to yield on each stream() call (FIFO). */
  private readonly eventQueues: StreamEvent[][] = [];

  /** Records every StreamOptions passed to stream(). */
  readonly calls: StreamOptions[] = [];

  /** Optional error to throw on stream() invocation. */
  private streamError: Error | null = null;

  /**
   * Enqueue a sequence of events for the next stream() call.
   * Multiple calls stack — first enqueue serves first stream().
   */
  enqueue(events: StreamEvent[]): void {
    this.eventQueues.push(events);
  }

  /**
   * Configure stream() to throw on invocation (before yielding events).
   */
  setError(error: Error): void {
    this.streamError = error;
  }

  async *stream(options: StreamOptions): AsyncIterable<StreamEvent> {
    this.calls.push(options);

    if (this.streamError) {
      throw this.streamError;
    }

    const events = this.eventQueues.shift();
    if (!events) {
      throw new Error("FakeLLMProvider: no events enqueued for this stream() call");
    }

    for (const event of events) {
      yield event;
    }
  }
}
