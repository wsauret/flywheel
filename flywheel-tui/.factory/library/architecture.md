# Architecture

Architectural decisions, patterns discovered, and design notes.

**What belongs here:** Key architectural patterns, design decisions, component relationships.

---

## Engine -> Transport -> Command Flow

The engine system has three layers:
1. **Engine Registry** (`src/engines/core/registry.ts`) — looks up engines by name
2. **Engine Providers** (`src/engines/providers/{name}/index.ts`) — build CLI commands via `buildCommand(options)`
3. **Transports** (dispatcher + evaluator) — spawn subprocesses using engine-built commands

Both the dispatcher and evaluator transports use the engine registry to build commands. Both are wired into the production pipeline: dispatcher via `autoDetectTransport()`, evaluator via `createEvaluatorTransport()`.

## Handoff Data Flow

```
Worker writes JSON -> .flywheel/handoffs/<uuid>.json
  -> readHandoff() in execution-loop.ts (once, cached)
    -> EvaluatorHandoffData projection (src/handoff/consumers.ts)
    -> LastWorkerResult projection (src/handoff/consumers.ts)  
    -> previousResult markdown (src/handoff/consumers.ts)
    -> StageContext accumulation (src/controller/stage-context.ts)
      -> decisions, warnings, artifacts, skill_feedback extracted
      -> persisted to .flywheel/stage-context.json via atomicWrite
      -> fed to dispatcher via DispatcherInput.stage_context
```

Key files:
- `src/schemas/handoff.ts` — WorkerHandoffSchema, WorkerHandoffBaseSchema, EvaluatorVerdictSchema, DispatcherDecisionHandoffSchema, SkillFeedbackSchema, SkillDeviationSchema
- `src/schemas/evaluator.ts` — EvaluatorHandoffData, EvaluatorInput, EvaluatorResult
- `src/schemas/shared.ts` — LastWorkerResultSchema, ValidationCriteria
- `src/handoff/consumers.ts` — buildLastWorkerResult(), buildPreviousResultFromHandoff()
- `src/handoff/reader.ts` — readHandoff() generic reader
- `src/handoff/field-specs.ts` — field documentation
- `src/controller/stage-context.ts` — StageContext accumulator, persistence, schema

### WorkerHandoffBaseSchema / WorkerHandoffSchema Split

`WorkerHandoffBaseSchema` is the raw `z.object()` definition (without cross-field refinements). It's used for `.pick()` / `.omit()` projections (e.g., `EvaluatorHandoffDataSchema`). `WorkerHandoffSchema` extends the base with `.superRefine()` for cross-field validation (e.g., requiring `test_output_summary` when `tests_passed` is true). Always import `WorkerHandoffBaseSchema` when building projections.

## Execution Loop Phase Iteration

The execution loop in `src/controller/execution-loop.ts` iterates phases:
1. Check shutdown, budget
2. Skip completed phases
3. Resolve context from ContextIndexer
4. Get dispatcher decision (may be null)
5. Build prompt via promptBuilder
6. Execute phase via PhaseExecutor
7. Read worker handoff (once, best-effort)
8. Evaluator check (if transport + validation_criteria)
9. Revision loop (if evaluator fails)
10. Chain result: build previousResult and _lastWorkerResult from handoff
10.5. Accumulate phase handoff into StageContext (decisions, warnings, artifacts, skill_feedback) and persist to `.flywheel/stage-context.json`
11. Call onStepComplete hook
12. Update state, emit events

## Boundaries Config -> Prompt Injection

Boundaries flow: `flywheel.toml [boundaries]` -> `FlywheelConfigSchema` (Zod parse) -> `execution-loop.ts ctx.extra.boundaries` -> `buildBoundariesSection()` in `phase-prompt.ts`. Key files: `src/config/loader.ts` (schema), `src/prompts/work/phase-prompt.ts` (rendering).

## Plan File Format

Plans are markdown with `### Phase N: Title` headings and `- [ ]` checklists.
State tracked in `.state.md` files with YAML frontmatter and `## Progress` section.
Phase statuses: `[x]` completed, `[ ]` pending, `[~]` in_progress.

## Transport Interface Pattern

Both dispatcher and evaluator follow:
- Interface (DI contract)
- SubprocessTransport (spawns engine CLI)
- SdkTransport (dispatcher only, uses OpenCode SDK)
- autoDetectTransport() (selects best available)
