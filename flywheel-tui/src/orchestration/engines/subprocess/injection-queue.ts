/**
 * InjectionQueue — encapsulates pending message injection + stdin handle binding.
 *
 * Replaces the manual `pendingInjection: { queue: string[] }` + `stdinHandleRef: { current: StdinHandle | null }`
 * ref-bag pattern with a single cohesive object.
 *
 * Queue depth is typically 3-5 items (observer messages, self-review checklist).
 * Plain Array with shift() is sub-microsecond at this scale — no ring buffer needed.
 */

import type { StdinHandle } from "./spawner";

export class InjectionQueue {
  private readonly queue: string[] = [];
  private readonly formatter: (raw: string) => string;
  private handle: StdinHandle | null = null;

  constructor(formatter: (raw: string) => string) {
    this.formatter = formatter;
  }

  /** Add a raw message to the back of the queue. */
  enqueue(text: string): void {
    this.queue.push(text);
  }

  /**
   * Try to deliver a message directly to stdin. If the handle is unavailable
   * or the write fails, enqueue for later delivery at a turn boundary.
   * Always returns true (message is either delivered or queued).
   */
  deliverOrEnqueue(text: string): boolean {
    if (this.handle?.isOpen) {
      try {
        const written = this.handle.write(this.formatter(text));
        if (written) return true;
      } catch {
        // Fall through to queuing
      }
    }
    this.queue.push(text);
    return true;
  }

  /**
   * Drain one item from the queue at a turn boundary. If the queue is empty,
   * closes the stdin handle (signaling the subprocess to advance).
   *
   * Called by the turn-complete callback — one message per turn boundary
   * matches the existing injection semantics.
   *
   * Returns the raw message text that was delivered, or null if nothing was sent.
   */
  drainAtTurnBoundary(): string | null {
    if (!this.handle?.isOpen) return null;

    if (this.queue.length > 0) {
      const text = this.queue.shift()!;
      try {
        this.handle.write(this.formatter(text));
        return text;
      } catch {
        // Put it back at front if write fails
        this.queue.unshift(text);
        return null;
      }
    }

    // Queue empty — close stdin to let subprocess advance
    this.handle.close();
    return null;
  }

  /** Bind or unbind the stdin handle. Called when a subprocess starts/exits. */
  bindStdin(handle: StdinHandle | null): void {
    this.handle = handle;
  }
}
