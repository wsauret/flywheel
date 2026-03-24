---
type: research
date: 2026-03-24
topic: "How does the dispatcher assemble prompts?"
status: complete
tags: [research, dispatcher, prompts, pipeline, architecture]
---

# Research: How Does the Dispatcher Assemble Prompts?

## Research Question

How does the dispatcher assemble prompts? Trace the full pipeline from raw plan/state inputs through system prompt construction, transport delivery, and final worker prompt composition.

## Summary

The dispatcher prompt assembly is a multi-layered pipeline with two distinct paths (work vs. non-work workflows) that converge in the `ExecutionLoop`. The dispatcher acts as a **context distiller** — crafting WHAT to do via `task_content` — while **prompt templates** provide behavioral instructions (HOW to behave: TDD cycle, verification protocol, scope discipline). A refactor documented in `docs/plans/refactor-dispatcher-prompt-composition.md` (status: READY) separated these concerns; previously a successful dispatcher replaced the entire prompt and templates only ran as fallback. The current implementation follows a 10-step per-phase pipeline in `ExecutionLoop.run()`, starting with context gathering and dispatcher invocation, flowing through template rendering and context inlining, and ending with completion marker wrapping before worker execution.

## Detailed Findings

### 1. The Per-Phase Assembly Pipeline

The core prompt assembly pipeline executes per phase inside `ExecutionLoop.run()` at `src/controller/execution-loop.ts:434-493`. The 10 steps are:

1. **Context gathering** — `contextIndexer.getRelevantContext()` queries for relevant conventions/standards/learnings (`:435`)
2. **Dispatcher invocation** — `getDispatcherDecision()` (`:448`) delegates to `DispatcherOrchestrator.getPhaseDecision()` at `src/controller/dispatcher-orchestrator.ts:62`
3. **Input assembly** — `assembleDispatcherInput()` at `src/dispatcher/assemble.ts:64` parses plan, state, and context files into a `DispatcherInput` JSON structure
4. **Transport delivery** — `transport.invoke(input)` sends a system prompt + user content to the dispatcher LLM
5. **Task content resolution** — `decision.task_content || phase.description` (`:461`) — dispatcher wins if non-empty
6. **Context building** — `WorkflowStepContext` assembled with resolved content + accumulated extra + relevantContext (`:466-478`)
7. **Template rendering** — `promptBuilder(phase, ctx)` **always** executes (`:481`) — no conditional branch
8. **Level 2 context inlining** — `enrichPromptWithContext()` prepends file contents from `decision.context_to_inline` with an 8KB budget (`src/controller/context-enrichment.ts:33`)
9. **Completion wrapping** — `wrapCompletionInstruction()` appends `<promise>COMPLETE</promise>` marker (`src/worker/completion.ts:73`)
10. **Worker execution** — final prompt sent to worker via `PhaseExecutor.execute()` (`:496-499`)

### 2. Dispatcher Input Assembly

The entry point is `assembleDispatcherInput()` at `src/dispatcher/assemble.ts:64-174`.

**Interface** (`AssemblerInput` at `:27-52`):
- Required: `planContent`, `stateContent`, `workflowContext`, `configContext`, `sessionBudget`, `availableContext`
- Optional: `contextContent`, `lastWorkerResult`

**Processing steps**:
- Calls `parsePlan()` at `:66` to parse plan markdown into structured phases
- Calls `parseStateFile()` at `:70` to parse state (or builds empty state)
- Walks `state.phases` to compute `completedPhases[]` and `currentPhaseIndex` at `:74-89`
- Parses context files via `parseContextFile()` at `:94`
- Maps phases to `planPhases` array with name + steps at `:98-101`
- Accepts `lastWorkerResult` as either structured `LastWorkerResult` objects or JSON strings; raw strings that fail parsing are dropped silently at `:110-122`
- Builds `WorkflowInfo` and `DispatcherConfig` at `:126-140`
- Assembles final `DispatcherInput` at `:143-158`

**Safety valve**: If `JSON.stringify(input)` exceeds 100KB (`BUDGET_TOTAL` at `:21`), `available_context` arrays are each sliced to 10 entries at `:161-167`.

**Output**: `AssembledInput` = `{ input: DispatcherInput, planTruncated, historyTruncated }`. Note: `planTruncated` and `historyTruncated` are initialized `false` at `:104-105` and never set to `true` in current code — the truncation note path in `system-prompt.ts:16` appears unreachable.

### 3. Plan Parsing

`parsePlan()` at `src/controller/plan-parser.ts:63-118` splits plan markdown on `### Phase N: Title` headings (regex at `:40`). It extracts top-level `- [ ]` checklist items as steps (`:43`), skips indented sub-items (`:46`), and cross-references status from an optional `ParsedStateFile`. `finalizePhase()` at `:194` joins description lines and calls `resolveStatus()` at `:220` which matches by index first, then title.

### 4. System Prompt Construction

`buildDispatcherSystemPrompt()` at `src/dispatcher/system-prompt.ts:37-127` is a **pure function** (no arguments) returning a static string. This design enables prompt caching — the stable prefix can be cached while per-call variable content goes in the user segment.

The system prompt instructs the dispatcher LLM on its role as a "prompt engineering specialist," defines the input JSON format (plan, state, context, workflow, config, budget, available_context), specifies the output JSON schema (`DispatcherDecision`), and provides rules: `task_content` describes WHAT not HOW, include file paths in `context_files`, output valid JSON only.

`buildTruncationNotes()` at `:16-35` returns a markdown warning block when `plan_truncated` or `history_truncated` flags are true, or empty string otherwise.

### 5. Transport Layer

The `DispatcherTransport` interface at `src/dispatcher/transport.ts:9` defines a single method: `invoke(input: DispatcherInput): Promise<DispatcherDecision>`.

**SDK Transport** (`src/dispatcher/sdk-transport.ts:116-201`):
- OpenCode-only (guard at `:123`)
- Creates a session via `client.session.create()` at `:161`
- Separates stable system prompt into `body.system` for prompt caching, sends user content in `parts[0].text` at `:174-178`
- User content: `${truncationNotes}${JSON.stringify(input)}` at `:152`
- 120s timeout at `:58`
- Parses response via `extractTextFromResponse()` at `:208` → regex `{...}` matching at `:235` → `DispatcherDecisionSchema.safeParse()` at `:247`

**Subprocess Transport** (`src/dispatcher/subprocess-transport.ts:45-163`):
- Engine-aware via registry at `:57`
- User content: `${truncationNotes}Here is the dispatcher input:\n\n${JSON.stringify(input)}\n\nRespond with valid JSON only.` at `:72`
- For Claude: system prompt via `--system-prompt` CLI flag (engine handles this)
- For OpenCode stdin path: system and user content concatenated with `---` separator at `:101`
- 60s timeout at `:30`, 1 retry with error feedback appended at `:77-79`
- OpenCode NDJSON parsed via `extractTextFromNDJSON()` at `:137`; Claude plain text at `:141`

### 6. Orchestration and Retry

`DispatcherOrchestrator.getPhaseDecision()` at `src/controller/dispatcher-orchestrator.ts:62-127` wraps assembly + transport in a **3-attempt retry loop** (2 retries, 1s exponential backoff at `:115`). It emits `dispatcher:invoked` at `:71`, `dispatcher:completed` at `:103`, or `dispatcher:failed` at `:120`. Returns `null` on final failure — the caller falls through to its own prompt builder (graceful degradation).

### 7. Prompt Builder Wiring (Two Paths)

`createStageLoop()` at `src/controller/stage-loop-factory.ts:99` is the single entry point for stage execution. It branches into two paths:

**Work path** — `createWorkLoop()` at `:207`:
- Uses `buildWorkPhasePrompt` as `promptBuilder` at `:236-237`
- Overrides `ctx.planContent` with `phase.description` (the plan phase's raw markdown)
- Reads plan file, state file, context file from disk at `:215-234`
- Wires `PlanFileProvider`, `FileStatePersistence`, `UIApprovalHandler`

**Generic path** — `createGenericLoop()` at `:294`:
- Uses `buildWorkflowPrompt` as `promptBuilder` at `:304-312`
- Routes by workflow name + step index via `workflowPromptMap` at `src/workflows/prompt-builder.ts:71-77`
- Synthesizes `fullPlanContent` from workflow step descriptions at `:357-365` to give the dispatcher context
- Wires `WorkflowDefinitionProvider`, `onStepComplete` hooks, `shouldSkipPhase` hooks

### 8. Workflow Prompt Routing

`buildWorkflowPrompt()` at `src/workflows/prompt-builder.ts:94-142` maps `(stepIndex, workflow.name)` to a specific template function via `workflowPromptMap` at `:71-77`:

| Workflow | Steps | Template Functions |
|----------|-------|--------------------|
| plan | 4 | research, draft, review, consolidate |
| review | 4 | dispatch, dispatch, consolidate, fix |
| ship | 4 | ship, ship, ship, compound |
| debug | 3 | investigate ×3 |
| research | 3 | locate, analyze, persist |

All template functions receive a `WorkflowStepContext` (interface at `src/prompts/index.ts:10-23`): `planContent`, `keyDecisions`, `fileReferences`, `previousResult`, `projectCwd`, `extra`.

If no mapping exists for a step index, a generic markdown template is built from the step's description at `:119-141`.

### 9. Work Phase Template Composition

`buildWorkPhasePrompt()` at `src/prompts/work/phase-prompt.ts:19-108` composes the work prompt from:

- **Variable content**: `ctx.planContent` (task), previous phase result, key decisions, file references, working directory, project context section (conventions/standards/learnings via `buildProjectContextSection` from `src/prompts/conventions.ts:85`), optional iteration budget instruction
- **Behavioral constants** (from `src/prompts/conventions.ts`): `TDD_CYCLE` (`:12`), `SCOPE_DISCIPLINE` (`:41`), `UNDERSTAND_ACT_VERIFY` (`:59`), `VERIFICATION_BANNED_PHRASES` (`:69`), `THREE_STRIKE_PROTOCOL` (`:45`)
- **Inline instructions**: Verification Protocol with evidence requirements table (`:69-88`), Two-Stage Review (`:90-95`), Completion section (`:101-107`)

### 10. Context Enrichment (Level 2 Inlining)

`enrichPromptWithContext()` at `src/controller/context-enrichment.ts:33-87` reads files listed in `decision.context_to_inline` in dispatcher-priority order. It validates paths are within the project boundary via `isPathWithinBoundary()` at `:45`, accumulates file content up to `INLINE_CONTENT_BUDGET` (8192 bytes, `:17`), and prepends as a `## Relevant Context` block before the prompt at `:86`. If the first file alone exceeds the budget, it is truncated to fit via `truncateToByteLimit()` at `:93-98`.

### 11. Completion Wrapping

`wrapCompletionInstruction()` at `src/worker/completion.ts:73-75` appends `\n\nWhen you have finished, output the marker: <promise>COMPLETE</promise>` to the prompt. This is always the last transformation before the prompt is sent to the executor.

### 12. Schema Contracts

`DispatcherInputSchema` at `src/schemas/dispatcher.ts:49-66` defines: plan phases array, state (completed/current indices), context files, truncation booleans, workflow_id, workflow step info, last_worker_result (nullable), config, session_budget, available_context.

`DispatcherDecisionSchema` at `:73-88` defines: `schema_version: 1`, `phase_index`, `step_index`, `task_content` (required string), `context_files`, optional `context_to_inline`, `validation_criteria`, `reasoning`, `warnings`, `session_name`, `worker_config`.

### 13. Engine-Specific System Prompt Handling

Per `.factory/library/architecture.md:19-21`:
- **Claude Code**: System prompt is passed via `--system-prompt` CLI flag (enables prompt caching). The engine's `buildDispatcherCommand()` handles this.
- **OpenCode**: System prompt is NOT handled by `buildDispatcherCommand()` — it is silently ignored. The `SubprocessTransport` manually prepends the system prompt to stdin content at `subprocess-transport.ts:101`. This is by design since OpenCode lacks a separate system prompt CLI flag.

## Code References

| File | Lines | Description |
|------|-------|-------------|
| `src/dispatcher/assemble.ts` | 64-174 | Main assembly function — parses plan/state, builds DispatcherInput, applies 100KB safety valve |
| `src/dispatcher/system-prompt.ts` | 37-127 | Pure-function system prompt (cacheable); truncation notes builder at :16-35 |
| `src/dispatcher/sdk-transport.ts` | 143-201 | SDK transport — system/user split for prompt caching, 120s timeout |
| `src/dispatcher/subprocess-transport.ts` | 69-127 | Subprocess transport — engine-aware, 60s timeout, 1 retry |
| `src/dispatcher/transport.ts` | 9-11 | `DispatcherTransport` interface — single `invoke()` method |
| `src/controller/dispatcher-orchestrator.ts` | 62-127 | Orchestrator — 3-attempt retry with exponential backoff, null-on-failure |
| `src/controller/execution-loop.ts` | 434-493 | Per-phase prompt pipeline: context → dispatcher → resolve → template → enrich → wrap |
| `src/controller/execution-loop.ts` | 748-794 | `getDispatcherDecision()` — builds workflow/config/budget context for orchestrator |
| `src/controller/context-enrichment.ts` | 33-87 | Level 2 context inlining — reads files, 8KB budget, prepends to prompt |
| `src/controller/stage-loop-factory.ts` | 236-237 | Work path promptBuilder wiring — `buildWorkPhasePrompt` |
| `src/controller/stage-loop-factory.ts` | 304-312 | Generic path promptBuilder wiring — `buildWorkflowPrompt` |
| `src/controller/stage-loop-factory.ts` | 357-365 | Synthetic plan content for non-work dispatcher context |
| `src/workflows/prompt-builder.ts` | 71-77 | `workflowPromptMap` — step-index → template function routing |
| `src/workflows/prompt-builder.ts` | 94-142 | `buildWorkflowPrompt()` — builds WorkflowStepContext, dispatches to template |
| `src/prompts/index.ts` | 10-23 | `WorkflowStepContext` interface definition |
| `src/prompts/conventions.ts` | 6-73 | Shared behavioral constants (TDD_CYCLE, SCOPE_DISCIPLINE, etc.) |
| `src/prompts/conventions.ts` | 85-116 | `buildProjectContextSection()` — L1 context injection into templates |
| `src/prompts/work/phase-prompt.ts` | 19-108 | Work phase template — task + behavioral instructions + verification protocol |
| `src/worker/completion.ts` | 73-75 | `wrapCompletionInstruction()` — appends completion marker |
| `src/schemas/dispatcher.ts` | 49-88 | Zod schemas for DispatcherInput and DispatcherDecision |
| `src/controller/plan-parser.ts` | 63-118 | `parsePlan()` — markdown phase extraction consumed by assembler |

## Patterns Identified

- **System/User Prompt Split**: `sdk-transport.ts:150-152`, `subprocess-transport.ts:70-72` — Both transports implement the same two-segment pattern: stable system prompt (cacheable prefix) + variable user content (truncation notes + JSON input). SDK uses `body.system` field; subprocess uses `--system-prompt` flag (Claude) or stdin concatenation (OpenCode).

- **Dispatcher-Template Separation**: `execution-loop.ts:461-481` — The dispatcher provides WHAT (task_content) and the template provides HOW (behavioral instructions). Templates are oblivious to the dispatcher's existence; they receive resolved `planContent` regardless of source.

- **Graceful Degradation**: `dispatcher-orchestrator.ts:119-121`, `execution-loop.ts:461-463` — If the dispatcher fails after retries, it returns `null`. The execution loop falls back to `phase.description` as the template's `planContent`. The worker still gets a well-formed prompt with behavioral instructions.

- **Context Injection Levels**: Three levels traced across multiple files — **L1** (metadata): `available_context` in `DispatcherInput` for dispatcher awareness (`assemble.ts:157`). **L2** (inlined content): `enrichPromptWithContext()` reads files from `context_to_inline` with 8KB budget (`context-enrichment.ts:33`). **L3** (on-demand): `context_files` listed for worker to read during execution (`system-prompt.ts:56`).

- **Pure Function System Prompt**: `system-prompt.ts:37` — `buildDispatcherSystemPrompt()` takes no arguments and returns the same string every time. This enables prompt caching across invocations.

- **Safety Valve Truncation**: `assemble.ts:161-167` — Single 100KB cap on total serialized input. Only `available_context` arrays are truncated (to 10 entries each) as a last resort.

- **Workflow-to-Template Routing**: `prompt-builder.ts:71-77` — Static arrays map step indices to template functions per workflow type. Falls back to a generic markdown template for unmapped indices.

- **Two-Path PromptBuilder Wiring**: `stage-loop-factory.ts:236` vs `:304` — Work workflows use `buildWorkPhasePrompt` (rich behavioral instructions); non-work workflows use `buildWorkflowPrompt` (template routing by workflow name + step index).

- **Completion Marker Pattern**: `completion.ts:73-75`, `execution-loop.ts:493` — Always applied last in the pipeline. The `CompletionDetector` class at `:31-68` checks for this marker or NDJSON success events during streaming.

## Open Questions

- `planTruncated` and `historyTruncated` flags are initialized `false` at `assemble.ts:104-105` and never set to `true` in current code — is the truncation note path in `system-prompt.ts:16` intentionally unreachable, or is truncation logic incomplete?
- The refactor plan at `docs/plans/refactor-dispatcher-prompt-composition.md` has `status: READY` — the code at `execution-loop.ts:460-493` matches the refactored flow described in the plan (template always runs, task_content resolution, enrichment in loop). Is this plan already implemented, or does the READY status indicate it is approved but not yet started?
- `enrichPromptWithContext` at `context-enrichment.ts:67` stops reading files when the budget would be exceeded, but if the very first file exceeds 8KB it is truncated to fit. Is there a scenario where a single large file in `context_to_inline` provides insufficient context after truncation?
- The `SubprocessTransport` at `subprocess-transport.ts:101` concatenates system prompt and user content for OpenCode stdin delivery. Does the `---` separator between them risk being parsed as markdown by the LLM, potentially affecting prompt interpretation?
