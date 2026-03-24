---
type: research
feature: event-bus
date: 2026-03-24
status: complete
---

# Event Bus — Technical Research

## Codebase Map

```
src/events/
  event-bus.ts    — EventBus class, FlywheelEmitter interface/factory
  types.ts        — FlywheelEvent discriminated union (34 variants)
```

```
src/controller/
  stage-loop-factory.ts      — creates FlywheelEmitter from EventBus
  execution-loop.ts          — emits workflow/phase/worker lifecycle events
  dispatcher-orchestrator.ts — emits dispatcher lifecycle events
  question-service.ts        — emits question events on raw EventBus
```

```
src/tui/components/
  flywheel-shell.tsx          — subscribes to pipeline/phase/question events
src/tui/utils/
  question-wiring.ts          — encapsulates question event subscriptions
```

## Relevant Code

### Core Implementation

- `event-bus.ts:22-106` — `EventBus` class. Two subscriber tracks: `catchAll: Set<Listener>` (`:23`) and `typed: Map<FlywheelEvent["type"], Set<Listener>>` (`:24`).
- `event-bus.ts:29-34` — `subscribe(listener)` adds to `catchAll`, returns unsubscribe closure.
- `event-bus.ts:39-53` — `subscribeToType(type, listener)` lazily creates per-type Set in `typed` map.
- `event-bus.ts:59-65` — `once(listener)` wraps subscribe; auto-removes after first invocation.
- `event-bus.ts:85-105` — `emit(event)` iterates `catchAll` then matching `typed` set. Each listener invoked in `try/catch`; errors logged but never propagate. Delivery is synchronous.
- `event-bus.ts:112-138` — `FlywheelEmitter` interface: 25 named methods, one per event type.
- `event-bus.ts:144-197` — `createFlywheelEmitter(bus)` factory returns object literal where each method constructs a typed event payload and calls `bus.emit()`.

### Event Types

- `types.ts:11-45` — `FlywheelEvent` discriminated union. 34 variants grouped by namespace: `workflow` (4), `phase` (3), `step` (3), `dispatcher` (3), `evaluator` (4), `worker` (6), `approval` (2), `question` (3), `pipeline` (4), `budget` (2).
- All variants carry `timestamp: string` (ISO 8601) except `EvaluatorRevisionRequested` (`:184`) which uses `timestamp: number` (Unix ms).
- `types.ts:337-339` — `assertNever(event: never)` exhaustiveness helper for switch statements.

### Creation & Injection

- `stage-loop-factory.ts:63` — `StageLoopOptions.eventBus` receives the raw `EventBus` from upstream.
- `stage-loop-factory.ts:119` — `createFlywheelEmitter(eventBus)` wraps it into a typed facade.
- `stage-loop-factory.ts:123-140` — `emitter` injected into `PhaseExecutor`, `DispatcherOrchestrator`, and `ExecutionLoop`.

### Emission Sites

**ExecutionLoop** (`execution-loop.ts`):
- `:337` — `workflowStarted`
- `:346-356` — `workflowInterrupted` (shutdown)
- `:428-432` — `phaseStarted`
- `:567-574` — `evaluatorRevisionRequested`
- `:650-651` — `phaseFailed` + `workflowFailed` (evaluator rejection)
- `:684` — `phaseCompleted`
- `:700-724` — `phaseFailed` + `workflowFailed`/`workflowInterrupted` (errors)
- `:736` — `workflowCompleted`
- `:835-836` — `workerOutput` (stdout/stderr callbacks)

**DispatcherOrchestrator** (`dispatcher-orchestrator.ts`):
- `:71` — `dispatcherInvoked`
- `:103` — `dispatcherCompleted`
- `:120` — `dispatcherFailed`

**QuestionService** (`question-service.ts`) — uses raw `EventBus.emit()`:
- `:105-110` — `question:asked`
- `:123-128` — `question:replied`
- `:141-145` — `question:rejected`

### Subscription Sites (TUI)

`flywheel-shell.tsx:532-577` — subscribes via `session.eventBus.subscribeToType()`:

| Event | Handler Effect |
|---|---|
| `pipeline:started` | Sets `activePipelineInfo`, `activeWorkflowName` |
| `pipeline:stage-transition` | Increments stage counter, updates workflow name |
| `pipeline:completed` | Clears `activePipelineInfo`, flushes output |
| `pipeline:failed` | Clears `activePipelineInfo` |
| `phase:completed` | Schedules output persistence flush |

Question events routed through `createQuestionWiring()` at `:533-537` → sets `pendingQuestion` state → renders `<QuestionPrompt>`.

### Indirect Path: Worker Output → Store → TUI

Worker output does NOT flow through direct subscriptions. Instead:
1. `emitter.workerOutput()` → `EventBus.emit("worker:output")`
2. `BaseUIAdapter.handleEvent()` receives the event and mutates `session.store`
3. Store subscriber at `flywheel-shell.tsx:308-309` fires → `setWorkState(store.getState())` → SolidJS re-render

## Patterns to Follow

1. **Two-track dispatch**: `catchAll` for debugging/logging, `subscribeToType` for specific event handling.
2. **Emitter facade**: Controller code never calls `bus.emit()` directly (except `QuestionService`). It uses the typed `FlywheelEmitter` methods.
3. **Synchronous delivery**: All listeners run synchronously in emit order. No async, no queuing.
4. **Error isolation**: Listener errors are caught and logged; never propagate to emitter or block other listeners.
5. **Unsubscribe closures**: All subscribe methods return `() => void` closures. Cleaned up in `pipelineUnsubs` array.
6. **Namespace:verb naming**: Event types follow `namespace:verb` convention (e.g., `workflow:started`, `phase:completed`).

## Constraints

- **Synchronous only**: `emit()` blocks until all listeners complete. Long-running listeners would block the event loop.
- **No event history/replay**: EventBus has no memory of past events. Late subscribers miss earlier emissions.
- **Single bus per session**: The `EventBus` is created per workflow session and passed through `StageLoopOptions`.
- **Timestamp inconsistency**: `EvaluatorRevisionRequested` uses `number` timestamp while all others use `string` ISO 8601.
- **QuestionService bypasses facade**: Uses raw `bus.emit()` instead of `FlywheelEmitter` methods.

## Open Questions

1. Where exactly is the `EventBus` instance constructed upstream before being passed into `createStageLoop()`? Likely in session bootstrap but not traced in this research.
2. What is the full set of events `createQuestionWiring()` subscribes to? Only the callback interface was observed.
3. Is the `EvaluatorRevisionRequested` timestamp type (`number` vs `string`) intentional or a divergence?
4. Does `BaseUIAdapter.handleEvent()` subscribe to all worker events or only `worker:output`?
