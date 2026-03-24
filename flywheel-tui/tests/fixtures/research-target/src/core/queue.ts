/**
 * TaskQueue — FIFO queue with priority support and concurrency control.
 *
 * Tasks are ordered by priority (lower number = higher priority),
 * then by insertion order (FIFO within same priority).
 *
 * Lifecycle: enqueue → schedule → execute → complete/fail
 */

import type { Task, TaskOptions, TaskResult, QueueConfig } from "./types";
import { Scheduler } from "./scheduler";
import { EventBus } from "./events";
import { generateId } from "../utils/id";
import { Logger } from "../utils/logger";

const log = new Logger("queue");

export class TaskQueue {
  private readonly queue: Task[] = [];
  private readonly scheduler: Scheduler;
  private readonly events: EventBus;
  private readonly config: QueueConfig;
  private running = false;

  constructor(config: QueueConfig, events?: EventBus) {
    this.config = config;
    this.events = events ?? new EventBus();
    this.scheduler = new Scheduler(config.concurrency, this.events);
  }

  /**
   * Add a task to the queue. Tasks are inserted in priority order.
   */
  enqueue<T>(options: TaskOptions & { handler: () => Promise<T> }): Task<T> {
    const task: Task<T> = {
      id: generateId(),
      options: {
        name: options.name,
        priority: options.priority ?? 10,
        timeoutMs: options.timeoutMs ?? this.config.defaultTimeoutMs ?? 30_000,
        retries: options.retries ?? 0,
        tags: options.tags ?? [],
      },
      handler: options.handler,
      status: "pending",
      createdAt: new Date(),
      attempts: 0,
    };

    // Insert in priority order (stable — FIFO within same priority)
    const insertIdx = this.queue.findIndex(
      (t) => (t.options.priority ?? 10) > (task.options.priority ?? 10),
    );
    if (insertIdx === -1) {
      this.queue.push(task);
    } else {
      this.queue.splice(insertIdx, 0, task);
    }

    this.events.emit("task:enqueued", { taskId: task.id, taskName: task.options.name });
    log.info("enqueued", { taskId: task.id, name: task.options.name, priority: task.options.priority });

    // If autoStart is enabled and we're running, try to process
    if (this.running) {
      this.processNext();
    }

    return task;
  }

  /**
   * Start processing the queue. Returns when all tasks are complete.
   */
  async start(): Promise<TaskResult[]> {
    this.running = true;
    this.events.emit("queue:started", { taskCount: this.queue.length });
    log.info("started", { taskCount: this.queue.length });

    const results: TaskResult[] = [];

    while (this.queue.length > 0 || this.scheduler.activeCount > 0) {
      await this.processNext();
      const completed = this.scheduler.drain();
      results.push(...completed);
    }

    this.running = false;
    this.events.emit("queue:completed", { resultCount: results.length });
    log.info("completed", { resultCount: results.length });

    return results;
  }

  /**
   * Stop processing (current tasks will finish, no new ones start).
   */
  stop(): void {
    this.running = false;
    this.events.emit("queue:stopped", {});
    log.info("stopped");
  }

  /**
   * Get the event bus for subscribing to task lifecycle events.
   */
  on(event: string, handler: (data: unknown) => void): void {
    this.events.on(event, handler);
  }

  /** Number of pending tasks in the queue */
  get pendingCount(): number {
    return this.queue.length;
  }

  /** Number of currently running tasks */
  get activeCount(): number {
    return this.scheduler.activeCount;
  }

  private processNext(): Promise<void> | void {
    if (!this.running) return;
    while (this.queue.length > 0 && this.scheduler.hasCapacity) {
      const task = this.queue.shift()!;
      this.scheduler.schedule(task);
    }
  }
}

/**
 * Factory function to create a new TaskQueue with sensible defaults.
 */
export function createTaskQueue(config?: Partial<QueueConfig>): TaskQueue {
  return new TaskQueue({
    concurrency: config?.concurrency ?? 1,
    autoStart: config?.autoStart ?? false,
    defaultTimeoutMs: config?.defaultTimeoutMs ?? 30_000,
  });
}
