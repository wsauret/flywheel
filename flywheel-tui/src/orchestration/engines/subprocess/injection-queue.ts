/**
 * InjectionQueue — encapsulates pending message injection + stdin handle binding.
 *
 * Replaces the manual `pendingInjection: { queue: string[] }` + `stdinHandleRef: { current: StdinHandle | null }`
 * ref-bag pattern with a single cohesive object.
 *
 * Queue depth is typically 3-5 items (observer messages, self-review checklist).
 * Plain Array with shift() is sub-microsecond at this scale — no ring buffer needed.
 */

import type { StdinHandle } from "./spawner.js";

interface QueueItem {
  text: string;
  userSteering: boolean;
}

interface DrainResult {
  message: string;
  userSteering: boolean;
}

export class InjectionQueue {
  private readonly queue: QueueItem[] = [];
  private readonly formatter: (raw: string) => string;
  private handle: StdinHandle | null = null;

  constructor(formatter: (raw: string) => string) {
    this.formatter = formatter;
  }

  /** Add a raw message to the back of the queue. */
  enqueue(text: string): void {
    this.queue.push({ text, userSteering: false });
  }

  /**
   * Try to deliver a message directly to stdin. If the handle is unavailable
   * or the write fails, enqueue for later delivery at a turn boundary.
   * Always returns true (message is either delivered or queued).
   *
   * @param userSteering — true for user-initiated mid-turn messages. Queued
   *   user-steering items are skipped by `subprocess:injected` at the turn
   *   boundary because they already have a pending block in the UI.
   */
  deliverOrEnqueue(text: string, userSteering = false): boolean {
    if (this.handle?.isOpen) {
      try {
        const written = this.handle.write(this.formatter(text));
        if (written) return true;
      } catch {
        // Fall through to queuing
      }
    }
    this.queue.push({ text, userSteering });
    return true;
  }

  /**
   * Drain one item from the queue at a turn boundary. If the queue is empty,
   * closes the stdin handle (signaling the subprocess to advance).
   *
   * Called by the turn-complete callback — one message per turn boundary
   * matches the existing injection semantics.
   *
   * Returns the message text and its origin, or null if nothing was sent.
   */
  drainAtTurnBoundary(): DrainResult | null {
    if (!this.handle?.isOpen) return null;

    if (this.queue.length > 0) {
      const item = this.queue.shift()!;
      try {
        this.handle.write(this.formatter(item.text));
        return { message: item.text, userSteering: item.userSteering };
      } catch {
        // Put it back at front if write fails
        this.queue.unshift(item);
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
