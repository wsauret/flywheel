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
