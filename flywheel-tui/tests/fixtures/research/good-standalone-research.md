---
type: standalone-research
date: "2026-03-21"
status: complete
tags: [research, dispatcher, prompts, architecture]
---

# Research: Dispatcher Prompt Assembly

## Research Question

How does the dispatcher assemble prompts from plan content, workflow context, and configuration to produce task_content for workers?

## Summary

The dispatcher pipeline transforms structured plan data into focused worker instructions through a three-stage process: input assembly collects plan, state, and config into a normalized schema; the dispatcher LLM receives this input along with a system prompt and produces a `DispatcherDecision` containing `task_content`; the execution loop then composes the final worker prompt by combining a workflow-specific template with the dispatcher's `task_content`. Context enrichment optionally prepends inline context files before the prompt reaches the worker.

## Detailed Findings

### Input Assembly

The `assembleDispatcherInput()` function at `src/dispatcher/assemble.ts:12` constructs the `DispatcherInput` object from five sources:

- Plan content is parsed into phases and steps at `src/dispatcher/assemble.ts:28`
- Execution state (current phase, completed steps) is read from `.state.md` at `src/dispatcher/assemble.ts:45`
- Workflow context (workflow type, step number) is passed from the execution loop at `src/controller/execution-loop.ts:78`
- Config context (models, timeouts, budget) is extracted from `FlywheelConfig` at `src/dispatcher/assemble.ts:62`
- Session budget (invocations remaining, wall clock deadline) is computed by the cost tracker at `src/session/cost-tracker.ts:33`

### Transport Layer

Two transport implementations exist at `src/dispatcher/`:

The `SubprocessTransport` at `src/dispatcher/subprocess-transport.ts:15` spawns the engine CLI with the dispatcher system prompt and input JSON. The engine processes the input and returns a `DispatcherDecision`.

The `SdkTransport` at `src/dispatcher/sdk-transport.ts:18` calls the OpenCode SDK directly via HTTP, bypassing CLI overhead. It sends the same input schema.

Both transports parse the raw LLM output into `DispatcherDecision` via Zod schema validation at `src/schemas/dispatcher.ts:8`.

### System Prompt Construction

The dispatcher system prompt is built by `buildDispatcherSystemPrompt()` at `src/dispatcher/system-prompt.ts:5`. It instructs the LLM to:

1. Analyze the plan phases and current execution state
2. Determine which acceptance criteria apply to the current phase
3. Produce a `task_content` string with focused worker instructions
4. Optionally select context files for inline enrichment

### Template Composition

After the dispatcher returns `task_content`, the execution loop at `src/controller/execution-loop.ts:142` composes the final prompt:

1. The workflow-specific template (e.g., `buildWorkPhasePrompt()` from `src/prompts/work/phase-prompt.ts:10`) renders behavioral instructions around the `task_content`
2. Context enrichment at `src/controller/context-enrichment.ts:15` prepends any inline context files selected by the dispatcher (up to 8KB budget)
3. The completion instruction wrapper at `src/worker/completion.ts:5` appends the `<promise>COMPLETE</promise>` sentinel

## Code References

| File | Lines | Description |
|------|-------|-------------|
| `src/dispatcher/assemble.ts` | 12-75 | Input assembly from plan, state, config |
| `src/dispatcher/subprocess-transport.ts` | 15-89 | CLI-based dispatcher transport |
| `src/dispatcher/sdk-transport.ts` | 18-72 | SDK-based dispatcher transport |
| `src/dispatcher/system-prompt.ts` | 5-120 | Dispatcher system prompt builder |
| `src/schemas/dispatcher.ts` | 8-45 | DispatcherDecision Zod schema |
| `src/controller/execution-loop.ts` | 78-160 | Workflow context passing and template composition |
| `src/controller/context-enrichment.ts` | 15-48 | Inline context file prepending |
| `src/prompts/work/phase-prompt.ts` | 10-85 | Work phase prompt template |
| `src/worker/completion.ts` | 5-18 | Completion instruction wrapper |

## Patterns Identified

- **Transport abstraction**: `src/dispatcher/subprocess-transport.ts:15` and `src/dispatcher/sdk-transport.ts:18` — both implement the same `DispatcherTransport` interface, allowing transport selection at runtime
- **Schema-first validation**: `src/schemas/dispatcher.ts:8` — all dispatcher responses pass through Zod `.safeParse()` before consumption
- **Template + content separation**: `src/controller/execution-loop.ts:142` — behavioral templates (HOW) are kept separate from dispatcher task_content (WHAT)
- **Progressive enrichment**: `src/controller/context-enrichment.ts:15` — context is layered onto the prompt in stages (metadata → inline → on-demand)

## Open Questions

- Whether the 8KB context enrichment budget is sufficient for large codebases
- How the dispatcher handles edge cases where plan content exceeds the LLM context window
- Whether SDK transport latency improvements could justify making it the default
