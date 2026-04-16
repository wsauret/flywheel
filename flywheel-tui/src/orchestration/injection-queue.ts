/**
 * Queue for messages injected into a runner at turn boundaries.
 *
 * Observer nudges and self-review prompts are enqueued mid-turn as they're
 * generated, then drained and delivered via `runner.send()` when the turn
 * completes. User-steering messages from the TUI also flow through this queue
 * — they're tagged so the caller can decide whether to emit a "system injection"
 * event (user messages are already visible in the TUI and don't need re-echoing).
 *
 * Pure data structure — no engine or stdin coupling.
 */

interface QueueItem {
  text: string;
  userSteering: boolean;
}

export interface DrainResult {
  message: string;
  userSteering: boolean;
}

export class InjectionQueue {
  private readonly queue: QueueItem[] = [];

  enqueue(text: string, userSteering = false): void {
    this.queue.push({ text, userSteering });
  }

  /** Combine all queued messages into one delivery. Returns null if queue is empty. */
  drain(): DrainResult | null {
    if (this.queue.length === 0) return null;
    const items = this.queue.splice(0, this.queue.length);
    const message = items.map((i) => i.text).join("\n\n");
    const userSteering = items.some((i) => i.userSteering);
    return { message, userSteering };
  }
}
