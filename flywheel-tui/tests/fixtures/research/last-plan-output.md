---
type: research
feature: event-bus
date: 2026-03-24
status: complete
---

# Event Bus — How It Works

## Codebase Map

```
src/events/
  event-bus.ts    — EventBus class, FlywheelEmitter facade, factory
  types.ts        — FlywheelEvent discriminated union (34 event types)
```

```
src/controller/
  work.ts                  — EventBus instantiation site
  stage-loop-factory.ts    — createFlywheelEmitter wrapping
  execution-loop.ts        — Primary emitter consumer (workflow lifecycle)
  dispatcher-orchestrator.ts — Dispatcher event emission
```

```
src/tui/
  adapters/base.ts       — BaseUIAdapter subscribe/unsubscribe lifecycle
  adapters/headless.ts   — Headless adapter (handleEvent impl)
  adapters/opentui.ts    — OpenTUI adapter (handleEvent impl)
  adapters/mock.ts       — Mock adapter for testing
  utils/question-wiring.ts — Typed subscriptions for question events
```

## Relevant Code

### Core Implementation

- `event-bus.ts:22-24` — `EventBus` class stores `catchAll: Set<Listener>` and `typed: Map<string, Set<Listener>>`
- `event-bus.ts:29` — `subscribe(listener)` adds to `catchAll`, returns `Unsubscribe` closure
- `event-bus.ts:39` — `subscribeToType(type, listener)` adds to per-type `Set` in `typed` map
- `event-bus.ts:59` — `once(listener)` wraps subscribe in self-removing closure
- `event-bus.ts:70` — `onceType(type, listener)` same one-shot pattern for typed subscriptions
- `event-bus.ts:85-103` — `emit(event)` iterates `catchAll` first, then `typed.get(event.type)`; each listener is individually try/caught — errors are logged but never propagate

### FlywheelEmitter Facade

- `event-bus.ts:112-138` — `FlywheelEmitter` interface with 26 named emit methods
- `event-bus.ts:144-197` — `createFlywheelEmitter(bus)` factory returns an object literal where each method constructs a typed event with `type` string + `timestamp` and calls `bus.emit()`
- `event-bus.ts:140` — `now()` helper produces ISO string timestamps via `new Date().toISOString()`

### Event Types

- `types.ts:11-45` — `FlywheelEvent` discriminated union across 10 namespaces, 34 members:

| Namespace     | Events                                                  |
|---------------|---------------------------------------------------------|
| `workflow:`   | `started`, `completed`, `failed`, `interrupted`         |
| `phase:`      | `started`, `completed`, `failed`                        |
| `step:`       | `started`, `completed`, `failed`                        |
| `dispatcher:` | `invoked`, `completed`, `failed`                        |
| `evaluator:`  | `invoked`, `completed`, `failed`, `revision-requested`  |
| `worker:`     | `spawned`, `completed`, `failed`, `retrying`, `output`, `injected` |
| `approval:`   | `requested`, `received`                                 |
| `question:`   | `asked`, `replied`, `rejected`                          |
| `pipeline:`   | `started`, `completed`, `failed`, `stage-transition`    |
| `budget:`     | `warning`, `exhausted`                                  |

- `types.ts:337` — `assertNever(event: never)` enables compile-time exhaustiveness checking

### Instantiation & Wiring

- `work.ts:67-73` — `WorkController` constructor creates `new EventBus()` (or accepts injected one), then calls `ui.connect(eventBus)` and `ui.start()`
- `stage-loop-factory.ts:119` — `createStageLoop()` wraps the bus: `const emitter = createFlywheelEmitter(eventBus)`, passes only the `emitter` (not the raw bus) to internal components
- `base.ts:21-36` — `BaseUIAdapter.connect(eventBus)` calls `eventBus.subscribe()` with catch-all handler, stores `Unsubscribe` token; `disconnect()` calls token and nulls refs; guards against double-connect
- `base.ts:58` — Subclasses implement `abstract handleEvent(event: FlywheelEvent)` as their single dispatch point
- `question-wiring.ts:36-69` — `createQuestionWiring()` uses `subscribeToType()` for `question:asked`, `question:replied`, `question:rejected`; returns idempotent `cleanup()` that unsubscribes all three and rejects pending questions

### Emission Lifecycle (Normal Flow)

1. `execution-loop.ts:337` — `emitter.workflowStarted(workflowId, label)`
2. Per phase:
   - `execution-loop.ts:428-432` — `emitter.phaseStarted(workflowId, index, title)`
   - `dispatcher-orchestrator.ts:71` — `emitter.dispatcherInvoked(workflowId, index, 0)`
   - `dispatcher-orchestrator.ts:103` — `emitter.dispatcherCompleted(workflowId, decision)`
   - `execution-loop.ts:835-836` — `emitter.workerOutput(workflowId, stream, chunk)` streamed during execution
   - `execution-loop.ts:568-574` — `emitter.evaluatorRevisionRequested(...)` if evaluator fails
   - `execution-loop.ts:684` — `emitter.phaseCompleted(workflowId, index)`
3. `execution-loop.ts:736` — `emitter.workflowCompleted(workflowId)`

Failure paths emit `phaseFailed` + one of `workflowFailed`, `workflowInterrupted`, or `workerFailed`.

## Patterns to Follow

- **Emit-only facade**: Internal components never receive `EventBus` directly — they get `FlywheelEmitter` which has no subscribe methods. Only the top-level controller and UI layer touch the raw `EventBus`.
- **Synchronous pub/sub**: No async channels. `emit()` calls listeners synchronously and in-order. Catch-all listeners fire before typed listeners.
- **Per-listener error isolation**: Each listener is try/caught individually in `emit()`. One listener throwing cannot break others.
- **Unsubscribe via closure**: All subscription methods return an `() => void` that removes the listener from its `Set`.
- **UI adapters use catch-all subscribe**: `BaseUIAdapter` subscribes once to all events and dispatches internally via `handleEvent()`.
- **Question wiring uses typed subscribe**: `createQuestionWiring()` subscribes to specific event types rather than catch-all.
- **Discriminated union + assertNever**: Event consumers use `switch (event.type)` with `assertNever` for exhaustiveness.

## Constraints

- The bus is **synchronous** — `emit()` blocks until all listeners complete. Long-running listeners will block the emitter.
- `FlywheelEmitter` facade covers 26 of the 34 event types. The remaining (`question:*`, `pipeline:*`, `budget:*`) must be emitted via raw `bus.emit()` with manually constructed event objects.
- `evaluatorRevisionRequested` at `event-bus.ts:179` uses `Date.now()` (numeric ms) instead of the ISO string `now()` helper used by all other events — `EvaluatorRevisionRequested.timestamp` is `number`, not `string`.
- UI adapters call `disconnect()` automatically on re-connect (double-connect guard at `base.ts:23-25`).

## Open Questions

- None — the event bus architecture is well-documented and straightforward.
