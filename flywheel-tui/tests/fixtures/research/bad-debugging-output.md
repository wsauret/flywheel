---
type: plan-research
date: "2026-03-19"
status: complete
tags: [research, debugging, event-bus]
---

# Research: Event Bus Issues

## Codebase Map

The event bus is at `src/events/event-bus.ts:1`. The bug is in the emit method which fails when handlers throw exceptions. The root cause is that synchronous dispatch does not wrap handler calls in try-catch.

The fix involves adding error boundaries around handler invocations at `src/events/event-bus.ts:45`. The error occurs when a subscriber throws during the emit cycle, causing subsequent handlers to be skipped.

## Relevant Code

Looking at `src/events/event-bus.ts:45`, the emit loop iterates over handlers without protection. Stack trace analysis reveals that the exception propagates up through the call chain to the controller layer.

The bug manifests when the TUI adapter throws during a render cycle. The fix is straightforward — wrap each handler call in a try-catch block. Fails when multiple handlers are registered and an early one throws.

## Patterns to Follow

The event bus breaks because it does not follow defensive programming patterns. The error occurs at the transport boundary where the adapter receives events.

## Constraints

- The system fails when handlers throw — this is the root cause of dropped events
- Stack trace shows the propagation path through event-bus → adapter → render

## Open Questions

- Whether to fix this with try-catch or a more robust error boundary pattern
