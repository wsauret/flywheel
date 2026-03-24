---
type: plan-research
date: "2026-03-20"
status: complete
tags: [research, event-bus, architecture]
---

# Research: Event Bus Architecture

## Codebase Map

The event bus implementation lives in `src/events/`. The system uses a synchronous publish-subscribe pattern with typed event channels.

Directory structure:
- `src/events/event-bus.ts:1` — Core EventBus class and FlywheelEmitter facade
- `src/events/types.ts:1` — 29 event type definitions across namespaces
- `src/controller/work.ts:45` — WorkController subscribes to workflow events
- `src/tui/adapters/base.ts:22` — BaseUIAdapter listens for output events

## Relevant Code

The `EventBus` class at `src/events/event-bus.ts:15` implements a channel-based pub/sub system. Subscribers register via `bus.on(eventType, handler)` and receive synchronous callbacks when `bus.emit(eventType, payload)` is called.

`FlywheelEmitter` at `src/events/event-bus.ts:89` provides a typed facade with named methods such as `workflowStarted()`, `phaseStarted()`, and `workerOutput()`. Each method wraps a call to `bus.emit()` with the correct event type.

Event namespaces are defined in `src/events/types.ts:5`:
- `workflow:*` — lifecycle events (started, completed, failed)
- `phase:*` — phase-level events (started, completed, skipped)
- `worker:*` — worker output and status events
- `dispatcher:*` — dispatcher invocation events

## Patterns to Follow

The codebase uses a single `EventBus` instance per session runtime, created in `src/tui/components/session-runtime.ts:34`. All components within a session share the same bus instance via dependency injection.

Event handlers are registered in component initialization and cleaned up on disposal. The pattern at `src/tui/adapters/base.ts:55` shows the standard subscribe-and-cleanup approach using returned unsubscribe functions.

## Constraints

- Events are synchronous — handlers execute in registration order within the same tick
- No event persistence — events are fire-and-forget with no replay capability
- Bus instances are scoped to sessions — cross-session communication is not supported
- The `FlywheelEmitter` facade is the only sanctioned way to emit events from controllers

## Open Questions

- Whether async event handlers would improve TUI responsiveness during heavy output
- How the event bus could support cross-session event forwarding for multi-session views
