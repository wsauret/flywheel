# Architecture

Architectural decisions and patterns for the queue-based step execution engine.

**What belongs here:** Queue architecture decisions, step schema design, execution patterns, integration decisions.
**What does NOT belong here:** Service ports/commands (use `.factory/services.yaml`), environment details (use `environment.md`).

---

## Queue Architecture

- Queue is a mutable array of Steps, persisted as JSON companion file
- Steps execute sequentially (first pending step runs next)
- Mutations (insert, remove, skip, reorder, replace) are atomic and logged with provenance
- Queue persistence follows output-persistence.ts pattern (atomic writes, debounced flusher)
- Crash recovery: running step → failed on load, cursor resumes at first pending

## Step Schema

Each step has: id (UUID), type (StepType), title, status, and optional dependsOn/fulfills/milestone fields.
Step types: plan, work, review, ship, debug, research, verify, gate.
The `dependsOn` field exists for future DAG support but is not used in sequential execution.

## Workflow Templates

Named presets that generate initial queues: plan-only, plan-work, plan-work-review, full, sprint.
Replaces the old PipelineMode system.

## Proto-Step Pattern

Plan step outputs JSON proto-steps (title, description, acceptanceCriteria, milestone, fulfills).
Proto-steps are formalized into full Step definitions via deterministic template (no LLM call).
Future: dispatcher intelligence epic will upgrade to LLM-based formalization.

## Event System

Queue events: queue:initialized, queue:completed, queue:failed, queue:step-inserted, queue:step-removed
Step events: step:started, step:completed, step:failed (replace phase:* events)
Sprint events retained for backward compat or replaced by step events with sprint metadata.

## OpenTUI ScrollBox API

When using `<scrollbox>` components in OpenTUI:
- Type the ref as `ScrollBoxRenderable` from `@opentui/core`, not `any`
- Use `createSignal<ScrollBoxRenderable | undefined>()` for ref signals
- For scrolling: use `scrollBy(dx, dy)` or set `scrollTop` property — do NOT use `scrollTo(x, y)` (not part of the ScrollBoxRenderable API)
- Examples: `output-window.tsx` (scrollBy), `prompt/index.tsx` (scrollBy)
- Auto-scroll calculations should account for variable row heights (e.g., error messages adding extra lines)
