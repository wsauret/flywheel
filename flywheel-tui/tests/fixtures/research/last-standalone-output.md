---
type: research
date: 2026-03-24
topic: "How does the dispatcher assemble prompts?"
status: complete
tags: [research, dispatcher, prompts, architecture, execution-loop]
---

# Research: How Does the Dispatcher Assemble Prompts?

## Research Question

How does the dispatcher assemble prompts? Trace the full pipeline from raw plan/state inputs through dispatcher invocation, template rendering, context inlining, and final worker-facing prompt construction.

## Summary

The dispatcher assembles prompts through a multi-layered pipeline that separates **what to do** (dispatcher's `task_content`) from **how to behave** (prompt templates from `src/prompts/`). Per phase, the execution loop follows a strict 7-step sequence: resolve L1 context metadata, invoke the dispatcher for a `DispatcherDecision`, resolve task content (dispatcher wins if non-empty, else fall back to `phase.description`), construct a `WorkflowStepContext`, render the prompt template unconditionally, optionally inline L2 file contents (8KB cap), and wrap with a completion marker. The dispatcher itself receives a structured `DispatcherInput` JSON (assembled from plan, state, context, config, and budget data) and returns a decision via one of two transports: an OpenCode SDK session or a subprocess CLI invocation.

## Detailed Findings

### 1. Per-Phase Prompt Assembly Sequence (Execution Loop)

The core assembly pipeline lives in `src/controller/execution-loop.ts:434-493`. For each pending phase, the loop executes these steps in order:

1. **L1 Context Resolution** (`:435-438`) — `contextIndexer.getRelevantContext()` gathers conventions, standards, and learnings metadata. The result is cached once per phase and reused for both the dispatcher's `availableContext` input and the template's `ctx.extra`.

2. **Dispatcher Invocation** (`:448`) — `getDispatcherDecision()` calls the `DispatcherOrchestrator`, which may return `null` on failure or when no dispatcher is configured.

3. **Session Name Extraction** (`:451-458`) — First dispatcher response's `session_name` is emitted once via `onSessionName` callback (fire-once guard at `:452`).

4. **Task Content Resolution** (`:461-463`) — `decision.task_content` wins if non-empty after trimming; otherwise `phase.description` is used. This resolved value becomes `planContent` in the context object.

5. **Context Object Construction** (`:466-478`) — A `WorkflowStepContext` is built with `planContent`, `keyDecisions`, `fileReferences`, `previousResult`, `projectCwd`, and an `extra` record merging the accumulated hook data with L1 context entries.

6. **Template Rendering** (`:481`) — `promptBuilder(phase, ctx)` always runs unconditionally. The template is never bypassed by a successful dispatcher response.

7. **L2 Context Inlining** (`:484-490`) — When `decision.context_to_inline` has entries, `enrichPromptWithContext()` prepends file contents to the composed prompt.

8. **Completion Wrapping** (`:493`) — `wrapCompletionInstruction()` appends the completion marker.

The loop then passes the fully assembled prompt to `executor.execute()` at `:499`.

### 2. Dispatcher Input Assembly

`assembleDispatcherInput()` at `src/dispatcher/assemble.ts:64-174` transforms raw content into a structured `DispatcherInput` JSON object.

**Input shape** (`AssemblerInput` at `:27-52`):
- `planContent: string` — raw markdown plan
- `stateContent: string` — raw state file content
- `contextContent?: string` — optional `.context.md` content
- `lastWorkerResult?: string | LastWorkerResult | null` — previous step output
- `workflowContext` — workflow ID, name, step number, total steps, step description
- `configContext` — max eval cycles, worktree path, project CWD, worker/dispatcher models
- `sessionBudget: SessionBudgetStatus` — remaining invocations, tokens, wall clock
- `availableContext: AvailableContext` — conventions, standards, learnings arrays

**Processing** (`:66-167`):
- Plan parsed via `parsePlan()` (`:66`)
- State parsed via `parseStateFile()` with graceful empty fallback (`:69-71`)
- Completed phases and current phase index derived from state phase statuses (`:74-90`)
- Context files extracted via `parseContextFile()` (`:93-95`)
- `lastWorkerResult` accepts structured objects or attempts JSON parse of legacy strings (`:108-123`)
- `WorkflowInfo` and `DispatcherConfig` structs built (`:126-140`)
- Final `DispatcherInput` assembled (`:143-158`)

**Safety valve** (`:161-167`): If total JSON byte length exceeds `BUDGET_TOTAL` (100KB, defined at `:21`), `available_context` arrays are sliced to 10 entries each.

### 3. Dispatcher System Prompt

`buildDispatcherSystemPrompt()` at `src/dispatcher/system-prompt.ts:37-127` is a pure function returning the same string every call, enabling prompt caching. The stable prefix describes:

- The dispatcher's role as a "prompt engineering specialist" (`:38`)
- Input schema: `plan.phases[]`, `state`, `context.files[]`, `workflow`, `config`, `session_budget`, `available_context` (`:42-52`)
- Three-level context injection rules (`:54-56`): L1 metadata in `available_context`, L2 targeted inline via `context_to_inline` (8KB cap, controller-injected), L3 on-demand via `context_files` (worker reads)
- Output schema requiring `task_content`, `context_files`, `context_to_inline`, `validation_criteria`, plus optional `reasoning`, `warnings`, `session_name`, `worker_config` (`:62-90`)
- Rules: `task_content` describes WHAT not HOW; behavioral instructions come from system templates (`:94`)

`buildTruncationNotes()` at `:16-35` produces an optional `## Truncation Warnings` block when `plan_truncated` or `history_truncated` are true.

### 4. Transports — Two Delivery Paths

**`DispatcherTransport` interface** at `src/dispatcher/transport.ts:9-11` — a single `invoke(input: DispatcherInput): Promise<DispatcherDecision>` method.

**SDK Transport** (`src/dispatcher/sdk-transport.ts:143-201`):
- Prompt segments constructed at `:150-152`: `systemPrompt = buildDispatcherSystemPrompt()`, `truncationNotes = buildTruncationNotes(input)`, `userContent = truncationNotes + JSON.stringify(input)`
- Delivered as `{ system: systemPrompt, model: modelSpec, parts: [{ type: "text", text: userContent }] }` at `:174-178` — system/user separation enables prompt caching
- Response parsed via `extractTextFromResponse()` at `:208-231` (handles OpenCode SDK shape: `{ parts: [{ type: "text", text: "..." }] }`)
- Decision validated via `DispatcherDecisionSchema.safeParse()` at `:247`
- 120s timeout (`:58`); OpenCode-only guard (`:123-128`)

**Subprocess Transport** (`src/dispatcher/subprocess-transport.ts:69-127`):
- Same prompt construction at `:70-72`, with added `"Respond with valid JSON only."` suffix
- Engine-specific command built via `engine.buildDispatcherCommand()` at `:82-86`
- OpenCode stdin path (`:100-101`): `systemPrompt + "\n\n---\n\n" + userContent`
- Claude Code `--print` path: system prompt passed as `--system-prompt` CLI arg; user content via `-p`
- Output parsing at `:129-162`: OpenCode uses `extractTextFromNDJSON()`, Claude Code uses plain text; both extract JSON via regex `/{[\s\S]*}/`
- 60s timeout (`:30`); one retry on parse failure (`:31`)
- Environment sanitized via `createEnvFilter()` at `:47`

### 5. Orchestration Bridge

`DispatcherOrchestrator.getPhaseDecision()` at `src/controller/dispatcher-orchestrator.ts:62-127`:
- Emits `dispatcher:invoked` at `:71`
- Calls `assembleDispatcherInput()` at `:79-88`
- Invokes `transport.invoke(assembled.input)` at `:91`
- Retries up to 2 times with linear backoff (1s, 2s) at `:115`
- On final failure: emits `dispatcher:failed` and returns `null` at `:120-121`
- On success: emits `dispatcher:completed` at `:103`, returns the decision

The execution loop calls this via its private `getDispatcherDecision()` helper at `src/controller/execution-loop.ts:748-795`, which also reads fresh state content, resolves context, and builds the `PhasePromptOptions` payload.

### 6. Workflow Prompt Template Selection

**`buildWorkflowPrompt()`** at `src/workflows/prompt-builder.ts:94-142` maps `(workflowType, stepIndex)` to a `PromptFn` via `workflowPromptMap` (`:71-77`):

| Workflow | Steps | Template Functions |
|----------|-------|--------------------|
| `plan` | 4 | `buildPlanResearchPrompt` → `buildPlanDraftPrompt` → `buildPlanReviewPrompt` → `buildPlanConsolidatePrompt` |
| `review` | 4 | `buildReviewDispatchPrompt` (×2) → `buildReviewConsolidatePrompt` → `buildReviewFixPrompt` |
| `ship` | 4 | `buildShipPrompt` (×3) → `buildShipCompoundPrompt` |
| `debug` | 3 | `buildDebugPrompt` (×3) |
| `research` | 3 | `buildResearchLocatePrompt` → `buildResearchAnalyzePrompt` → `buildResearchPersistPrompt` |

Each template is a pure function `(ctx: WorkflowStepContext) => string`. The `WorkflowStepContext` interface at `src/prompts/index.ts:10-23` provides: `planContent`, `keyDecisions`, `fileReferences`, `previousResult`, `projectCwd`, `extra`.

Fallback generic prompt at `:119-141` constructs markdown from `step.description`, `step.dispatcherHint`, and `step.validationCriteria`.

### 7. L2 Context Inlining

`enrichPromptWithContext()` at `src/controller/context-enrichment.ts:33-87`:
- Reads files from `contextToInline` in dispatcher priority order (most critical first)
- Greedy 8KB cap (`INLINE_CONTENT_BUDGET = 8192` at `:17`)
- Path boundary validation via `isPathWithinBoundary()` at `:45`
- If the first file alone exceeds the budget, it is truncated to fit via `truncateToByteLimit()` at `:70-71`
- Subsequent files are skipped once budget is exceeded (`:75`)
- Output format: `## Relevant Context (from project standards and learnings)\n\n### {filePath}\n{content}\n\n---\n\n{original prompt}`

### 8. Shared Prompt Conventions

`src/prompts/conventions.ts` exports composable string fragments used by domain-specific templates:
- `SEVERITY_DEFINITIONS` (`:6-10`) — P1/P2/P3 severity levels
- `TDD_CYCLE` (`:12-21`) — Red/Green/Refactor cycle instructions
- `UNDERSTAND_ACT_VERIFY` (`:59-67`) — Three-step implementation loop
- `SCOPE_DISCIPLINE` (`:41-43`) — YAGNI guidance
- `THREE_STRIKE_PROTOCOL` (`:45-50`) — Escalation protocol
- `VERIFICATION_BANNED_PHRASES` (`:69-73`) — Banned claim-without-evidence phrases

`buildProjectContextSection()` at `:85-116` formats L1 context entries (conventions, standards, learnings) as a Markdown section for templates.

`buildIterationBudgetInstruction()` at `:122-129` creates an iteration budget message; throws on invalid budget.

### 9. Stage Loop Factory Wiring

`createStageLoop()` at `src/controller/stage-loop-factory.ts:99-185` wires the full pipeline:

**Dispatcher orchestrator** (`:132-141`): Instantiated when `dispatcherTransport` is provided.

**Work path** (`createWorkLoop` at `:207-269`):
- Reads plan file (`:224`), derives state/context paths (`:218-219`)
- Loads `.context.md` via `readCachedFile()` + `parseContextFile()` (`:233-234`)
- `promptBuilder` wraps `buildWorkPhasePrompt()` (`:236-237`)
- Passes `planContent`, `statePath`, `contextPath` to `ExecutionLoop` (`:253-255`)

**Generic workflow path** (`createGenericLoop` at `:294-393`):
- Synthesizes `planContent` from `workflowDef.steps` at `:357-365` so the dispatcher has context
- Includes user's `description/topic` in the plan content at `:362-365`
- `promptBuilder` wraps `buildWorkflowPrompt()` (`:304-312`)
- Passes synthetic `planContent` to `ExecutionLoop` at `:380`

### 10. Schema Definitions

`src/schemas/dispatcher.ts` defines the Zod schemas:

**`DispatcherInputSchema`** (`:49-66`): `plan`, `state`, `context`, `plan_truncated`, `history_truncated`, `workflow_id`, `workflow`, `last_worker_result`, `config`, `session_budget`, `available_context`

**`DispatcherDecisionSchema`** (`:73-88`): `schema_version: 1`, `phase_index`, `step_index`, `task_content`, `context_files`, `context_to_inline?`, `validation_criteria`, `reasoning?`, `warnings?`, `worker_config?`, `session_name?`

### 11. File Caching and Context Parsing

`src/controller/templates.ts:26-74`:
- `readCachedFile()` (`:26-41`): mtime-keyed in-memory `Map<string, CachedFile>`. Returns `null` on missing file. Re-reads on mtime change. Module-level cache with no TTL eviction.
- `parseContextFile()` (`:58-74`): Extracts bullet lines (`- path`) stripping optional backtick wrapping. Returns `string[]` of file reference paths.

## Code References

| File | Lines | Description |
|------|-------|-------------|
| `src/controller/execution-loop.ts` | 434-493 | Per-phase prompt assembly sequence (7 steps) |
| `src/controller/execution-loop.ts` | 748-795 | `getDispatcherDecision()` helper — reads state, resolves context, calls orchestrator |
| `src/dispatcher/assemble.ts` | 64-174 | `assembleDispatcherInput()` — transforms raw content into `DispatcherInput` JSON |
| `src/dispatcher/assemble.ts` | 161-167 | Safety valve: truncates `available_context` when total exceeds 100KB |
| `src/dispatcher/system-prompt.ts` | 37-127 | `buildDispatcherSystemPrompt()` — static, cacheable system prompt |
| `src/dispatcher/system-prompt.ts` | 16-35 | `buildTruncationNotes()` — optional truncation warnings |
| `src/dispatcher/sdk-transport.ts` | 143-201 | `SdkTransport.invoke()` — OpenCode SDK delivery path |
| `src/dispatcher/sdk-transport.ts` | 150-152 | Prompt segment construction (system/user split) |
| `src/dispatcher/subprocess-transport.ts` | 69-127 | `SubprocessTransport.invoke()` — CLI delivery path |
| `src/dispatcher/subprocess-transport.ts` | 100-101 | OpenCode stdin prompt construction |
| `src/controller/dispatcher-orchestrator.ts` | 62-127 | `getPhaseDecision()` — retry logic, event emission, null fallback |
| `src/workflows/prompt-builder.ts` | 71-77 | `workflowPromptMap` — step→template registry |
| `src/workflows/prompt-builder.ts` | 94-142 | `buildWorkflowPrompt()` — template dispatch with fallback |
| `src/controller/context-enrichment.ts` | 33-87 | `enrichPromptWithContext()` — L2 file content inlining (8KB cap) |
| `src/controller/context-enrichment.ts` | 17 | `INLINE_CONTENT_BUDGET = 8192` constant |
| `src/prompts/conventions.ts` | 85-116 | `buildProjectContextSection()` — L1 context entry formatter |
| `src/prompts/index.ts` | 10-23 | `WorkflowStepContext` interface definition |
| `src/schemas/dispatcher.ts` | 49-66 | `DispatcherInputSchema` — Zod schema for dispatcher input |
| `src/schemas/dispatcher.ts` | 73-88 | `DispatcherDecisionSchema` — Zod schema for dispatcher output |
| `src/controller/stage-loop-factory.ts` | 132-141 | Dispatcher orchestrator wiring |
| `src/controller/stage-loop-factory.ts` | 354-365 | Synthetic plan content for non-work workflows |
| `src/controller/templates.ts` | 26-41 | `readCachedFile()` — mtime-based file cache |
| `src/controller/templates.ts` | 58-74 | `parseContextFile()` — bullet-line file reference extractor |
| `src/dispatcher/transport.ts` | 9-11 | `DispatcherTransport` interface |

## Patterns Identified

- **Dispatcher Augments, Never Replaces**: `execution-loop.ts:481` — The `promptBuilder(phase, ctx)` always runs unconditionally. The dispatcher's `task_content` feeds into `planContent` within the context object, which the template then renders. Templates are never bypassed by a successful dispatcher response.
- **Three-Level Context Disclosure**: `system-prompt.ts:54-56` — L1 metadata (dispatcher input's `available_context`), L2 targeted inline (`context_to_inline` → `enrichPromptWithContext`, 8KB cap), L3 on-demand file reads (`context_files` in decision).
- **Graceful Degradation on Dispatcher Failure**: `dispatcher-orchestrator.ts:106-121` — Two retries with linear backoff; on final failure returns `null`, and the execution loop falls through to `phase.description` as the task content.
- **System/User Prompt Splitting for Cache**: `sdk-transport.ts:168-178` — The static system prompt goes in the `system` field (cacheable); variable per-call content (truncation notes + input JSON) goes in `parts` as user text.
- **Safety Valve Budget Enforcement**: `assemble.ts:161-167` — Single 100KB cap on total input size; `available_context` arrays truncated to 10 entries as the overflow mitigation.
- **Template Registry Pattern**: `prompt-builder.ts:71-77` — Workflow names map to ordered `PromptFn[]` arrays, where array index equals step index. Each function is a pure `(ctx: WorkflowStepContext) => string`.
- **Composable Convention Fragments**: `conventions.ts:6-73` — Behavioral instruction strings (`TDD_CYCLE`, `UNDERSTAND_ACT_VERIFY`, etc.) are exported as constants, composed into domain-specific templates via import.
- **Task Content Resolution Precedence**: `execution-loop.ts:461-463` — `decision.task_content` (non-empty, trimmed) takes precedence over `phase.description`. Empty strings are treated as absent.
- **Synthetic Plan Content for Non-Work Workflows**: `stage-loop-factory.ts:357-365` — Non-work workflows synthesize `planContent` from `workflowDef.steps` descriptions so the dispatcher has context. Without this, the dispatcher is skipped (requires non-empty `planContent`).

## Open Questions

- What exact string does `wrapCompletionInstruction()` emit? The implementation lives in `src/worker/completion.ts` and was not analyzed.
- How does `contextIndexer.getRelevantContext()` rank and filter context entries? The algorithm lives in `src/memory/indexer.ts` and was not analyzed.
- Do `context_to_inline` paths in the dispatcher decision consistently use absolute or relative paths? The dispatcher LLM generates these from `available_context` metadata, and path resolution behavior depends on what `isPathWithinBoundary()` accepts.
- `readCachedFile()` at `templates.ts:26` uses a module-level `Map` with no TTL eviction — behavior across long-running sessions with file edits depends entirely on mtime accuracy and stat timing.
- The refactor plan at `docs/plans/refactor-dispatcher-prompt-composition.md` (status: READY, checklist unchecked as of 2026-03-23) documents the intended separation of `task_content` from `prompt` — but the current codebase already uses `task_content` in the schema and execution loop, indicating this refactor has been partially or fully applied.
