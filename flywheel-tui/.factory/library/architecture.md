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
8.5. Evaluator transport failure → graceful degradation (continue, log warning)
9. Revision loop (if evaluator fails with genuine passed:false verdict)
9.5. **Issue gating** (after evaluator accepts):
   - Blocking issues → halt pipeline, surface via approval gate (`requestIssueApproval`)
   - Non-blocking issues → accumulate in StageContext `cumulative_issues`
   - Independent of pass/fail: passed:true + blocking issues still halts
10. Chain result: build previousResult and _lastWorkerResult from handoff
10.5. Accumulate phase handoff into StageContext (decisions, warnings, artifacts, issues, skill_feedback) and persist to `.flywheel/stage-context.json`
11. Call onStepComplete hook
12. Update state, emit events

### Issue Gating Details

Issue gating is additive to existing evaluator pass/fail behavior. The evaluator's `issues` array (from `EvaluatorVerdictSchema`) is inspected after evaluation:
- `severity: "blocking"` → pipeline halts, surfaces via `ApprovalHandler.requestIssueApproval()`
- `severity: "non_blocking"` → appended to `StageContext.cumulative_issues`, pipeline continues
- Empty issues array or undefined → no gating, normal continuation

The `ApprovalHandler` interface has an optional `requestIssueApproval(phaseIndex, title, issues)` method. `UIApprovalHandler` implements it by formatting blocking issue descriptions and delegating to the standard approval UI. If no approval handler is present, blocking issues always halt.

Stage context now feeds the evaluator: `EvaluatorInput.stage_context` carries cumulative context from phases 1..N-1 so the evaluator for phase N can reference prior decisions and warnings.

Evaluator transport failures (timeout, connection errors) are handled with graceful degradation via `EvaluationResult.transportError`. When set, the execution loop skips the evaluation entirely and continues.

## Boundaries Config -> Prompt Injection

Boundaries flow: `flywheel.toml [boundaries]` -> `FlywheelConfigSchema` (Zod parse) -> `execution-loop.ts ctx.extra.boundaries` -> `buildBoundariesSection()` in `phase-prompt.ts`. Key files: `src/config/loader.ts` (schema), `src/prompts/work/phase-prompt.ts` (rendering).

## Plan File Format

Plans are markdown with `### Phase N: Title` headings and `- [ ]` checklists.
State tracked in `.state.md` files with YAML frontmatter and `## Progress` section.
Phase statuses: `[x]` completed, `[ ]` pending, `[~]` in_progress.

## Validation Contract and State

The plan workflow generates a `validation-contract.md` file alongside the plan. The naming convention is:
- Contract file: `${DEFAULT_PLANS_DIR}/validation-contract.md` (set in consolidate prompt, `src/prompts/plan/consolidate.ts`)
- Validation state: `validation-state.json` in the project root (read/write via `src/controller/validation-state.ts`)

Validation state uses a wrapped schema: `{ assertions: { [id]: { status, lastChecked?, evidence? } } }` (defined in `src/schemas/validation.ts`). Status values: `pending | passed | failed | blocked`.

### Plan Workflow Lifecycle (Draft → Review → Consolidate)

The plan workflow has a three-step process:
1. **Draft** (`src/prompts/plan/draft.ts`) — AI generates plan content and validation contract format specification. No file paths are specified; this is content generation only.
2. **Review** (`src/prompts/plan/review.ts`) — Plan is assessed for quality. Currently does not validate contract or fulfills completeness.
3. **Consolidate** (`src/prompts/plan/consolidate.ts`) — Writes the final plan and contract to disk with explicit file paths. Adds milestone markers, fulfills annotations, and quality checks.

This lifecycle means content and file writing are separated: draft describes *what*, consolidate specifies *where*.

### Milestone and Fulfills Annotations

- Milestone markers: `## Milestone: <name>` (H2 header, strict format) parsed by `src/controller/plan-parser.ts`
- Fulfills annotations: `<!-- fulfills: VAL-AUTH-001, VAL-AUTH-002 -->` HTML comments parsed by `src/controller/plan-parser.ts`
- State file annotations: `(milestone=name)` key-value pairs in parentheses, handled by generic `ANNOTATION_RE` in `src/state/reader.ts` (line 52)

**Important:** Plan content parsing lives in `src/controller/plan-parser.ts`, NOT `src/state/reader.ts`. The state reader handles `.state.md` files, not plan markdown.

## Evaluator/Dispatcher Prompt Alignment

**Critical pattern:** The dispatcher generates `validation_criteria` that the evaluator uses to judge worker output. These criteria must be:
1. **Achievable** by the worker given its tools and permissions
2. **Verifiable** from the worker's text output alone (the evaluator cannot inspect the filesystem)
3. **Aligned** with the worker's prompt instructions on output paths and deliverables

**Common failure mode:** The dispatcher generates criteria referencing specific file paths (e.g., "created file at X"), but the worker writes to a different path. Or criteria require filesystem inspection (file existence checks) that the evaluator can't perform. This triggers expensive evaluator revision loops.

**Fix pattern:** The dispatcher system prompt (in `src/dispatcher/assemble.ts`) includes rule 4: "validation_criteria must be ACHIEVABLE and VERIFIABLE from the worker's output alone." Workflow definitions in `stage-loop-factory.ts` include `dispatcherHint` and `validationCriteria` to give the dispatcher accurate context.

**Write tool scoping gotcha:** Workers need the Write tool to create handoff JSON files. If `toolScoping.write: false`, the worker can't write handoffs. The Claude engine provider (`src/engines/providers/claude/index.ts`) always injects Write into scoping to prevent this.

## Sprint Mode Architecture

Sprint mode is a new WorkflowType that provides fast iteration without planning overhead.

### Sprint Execution Flow
```
Task description + ContextIndexer context
  → Sprint worker prompt (iteration 1: explore + implement + write verify script)
    → Worker spawns via PhaseExecutor
      → Worker writes code + verification script to .flywheel/verify/
      → Worker writes handoff JSON with verification_script_path
    → Verification runner spawns script, captures output
    → Adversarial evaluator reviews implementation + script quality
      → Pass → Done
      → Fail → Retry with cumulative context (all previous feedback)
    → Hard cap reached → Escalate to full pipeline (carry forward)
```

### Key Components
- `src/sprint/sprint-loop.ts` — Core iterate-verify-escalate loop
- `src/sprint/verification-runner.ts` — Spawns verification scripts, captures output
- `src/prompts/sprint/phase-prompt.ts` — Worker prompt (iteration 1 + retry)
- `src/prompts/sprint/evaluator-prompt.ts` — Adversarial evaluator prompt
- `src/workflows/sprint.ts` — Sprint workflow definition
- `src/handoff/field-specs.ts` — SPRINT_FIELDS array

### Sprint Evaluator vs Standard Evaluator
The standard evaluator (`SubprocessEvaluatorTransport`) has a "Bias Toward Passing" system prompt. Sprint needs an adversarial evaluator that:
- Reviews BOTH implementation quality AND script quality
- Detects script weakening across iterations
- Provides dual-channel feedback (implementation + script)
- Does NOT bias toward passing

### Verification Script Runner
- Spawns .ts via `bun run`, .sh via `bash`
- Captures stdout/stderr/exit code
- Enforces timeout from `sprint.verification_timeout_ms`
- Path security: scripts must be within project boundary
- Scripts persist in `.flywheel/verify/` for regression

## Transport Interface Pattern

Both dispatcher and evaluator follow:
- Interface (DI contract)
- SubprocessTransport (spawns engine CLI)
- SdkTransport (dispatcher only, uses OpenCode SDK)
- autoDetectTransport() (selects best available)
