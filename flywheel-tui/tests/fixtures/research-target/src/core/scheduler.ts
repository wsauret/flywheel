/**
 * Scheduler — manages concurrent task execution with capacity limits.
 *
 * Tracks active tasks, enforces concurrency, and handles task completion
 * (success or failure) with proper cleanup.
 */

import type { Task, TaskResult } from "./types";
import type { EventBus } from "./events";
import { withTimeout } from "../utils/timeout";
import { RetryPolicy } from "../utils/retry";

export class Scheduler {
  private readonly maxConcurrent: number;
  private readonly events: EventBus;
  private active: Map<string, Promise<TaskResult>> = new Map();
  private completed: TaskResult[] = [];

  constructor(maxConcurrent: number, events: EventBus) {
    this.maxConcurrent = maxConcurrent;
    this.events = events;
  }

  /** Whether there's capacity to run another task */
  get hasCapacity(): boolean {
    return this.active.size < this.maxConcurrent;
  }

  /** Number of currently executing tasks */
  get activeCount(): number {
    return this.active.size;
  }

  /**
   * Schedule a task for execution. The task starts immediately
   * if there is available capacity.
   */
  schedule<T>(task: Task<T>): void {
    if (!this.hasCapacity) {
      throw new Error(`Scheduler at capacity (${this.maxConcurrent})`);
    }

    const promise = this.executeTask(task);
    this.active.set(task.id, promise);
  }

  /**
   * Wait for at least one active task to complete, then return all
   * completed results since last drain.
   */
  drain(): TaskResult[] {
    const results = [...this.completed];
    this.completed = [];
    return results;
  }

  private async executeTask<T>(task: Task<T>): Promise<TaskResult> {
    const startTime = Date.now();
    task.status = "running";
    task.startedAt = new Date();
    task.attempts++;

    this.events.emit("task:started", { taskId: task.id, taskName: task.options.name });

    const retryPolicy = new RetryPolicy({ maxRetries: task.options.retries ?? 0 });

    try {
      const result = await retryPolicy.execute(async () => {
        const timeoutMs = task.options.timeoutMs ?? 30_000;
        return withTimeout(task.handler(), timeoutMs);
      });

      task.status = "completed";
      task.completedAt = new Date();
      task.result = result as T;

      const taskResult: TaskResult<T> = {
        taskId: task.id,
        taskName: task.options.name,
        status: "completed",
        result: result as T,
        durationMs: Date.now() - startTime,
        attempts: task.attempts,
      };

      this.events.emit("task:completed", taskResult);
      this.completed.push(taskResult);
      this.active.delete(task.id);
      return taskResult;
    } catch (error) {
      task.status = "failed";
      task.completedAt = new Date();
      task.error = error instanceof Error ? error : new Error(String(error));

      const taskResult: TaskResult = {
        taskId: task.id,
        taskName: task.options.name,
        status: "failed",
        error: task.error,
        durationMs: Date.now() - startTime,
        attempts: task.attempts,
      };

      this.events.emit("task:failed", taskResult);
      this.completed.push(taskResult);
      this.active.delete(task.id);
      return taskResult;
    }
  }
}
