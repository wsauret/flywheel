# Task Queue Library

A minimal TypeScript task queue library for testing research workflows.

## Architecture

- `src/core/` — Core task queue engine and scheduler
- `src/utils/` — Shared utilities (logger, retry, events)
- `src/index.ts` — Public API entry point

## Key Concepts

- **TaskQueue** (`src/core/queue.ts`) — FIFO queue with priority support
- **Scheduler** (`src/core/scheduler.ts`) — Schedules tasks with concurrency limits
- **EventBus** (`src/core/events.ts`) — Typed event emitter for task lifecycle
- **RetryPolicy** (`src/utils/retry.ts`) — Exponential backoff retry logic
- **Logger** (`src/utils/logger.ts`) — Structured logging utility

## Usage

```ts
import { createTaskQueue } from "./src";

const queue = createTaskQueue({ concurrency: 3 });
queue.on("task:completed", (result) => console.log(result));
queue.enqueue({ name: "build", handler: async () => "done" });
await queue.start();
```
