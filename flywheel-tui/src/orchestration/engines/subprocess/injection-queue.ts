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

  enqueue(text: string): void {
    this.queue.push({ text, userSteering: false });
  }

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

  bindStdin(handle: StdinHandle | null): void {
    this.handle = handle;
  }
}
