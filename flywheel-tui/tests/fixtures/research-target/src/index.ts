/**
 * Task Queue Library — Public API
 *
 * Re-exports core types and factory functions for creating
 * and managing task queues with scheduling and event handling.
 */

export { TaskQueue, createTaskQueue } from "./core/queue";
export type { Task, TaskOptions, TaskResult, TaskStatus } from "./core/types";
export { Scheduler } from "./core/scheduler";
export { EventBus } from "./core/events";
export type { TaskEvent, TaskEventType } from "./core/events";
export { RetryPolicy, DEFAULT_RETRY_OPTIONS } from "./utils/retry";
export type { RetryOptions } from "./utils/retry";
export { Logger, createLogger } from "./utils/logger";
