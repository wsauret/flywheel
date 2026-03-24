---
type: plan-research
date: "2026-03-18"
status: complete
tags: [research, session]
---

# Research: Session Management

## Codebase Map

The session management system lives in `src/session/`. The state machine at `src/session/state-machine.ts:1` defines 11 lifecycle states and valid transitions between them.

The session manager at `src/session/manager.ts:10` handles creation, loading, and persistence of session records.

## Relevant Code

Sessions are persisted to disk via `src/session/persistence.ts:20`. Each session has a unique ID, creation timestamp, and lifecycle state.

The cost tracker at `src/session/cost-tracker.ts:8` monitors API invocations and token usage per session, emitting budget events when thresholds are crossed.

State transitions are validated by the state machine — invalid transitions throw errors with descriptive messages indicating the current state and attempted target.
