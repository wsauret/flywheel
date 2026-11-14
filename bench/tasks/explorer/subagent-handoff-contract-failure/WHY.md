# Why this task exists

This question restores the behavior of fix c712ee9e2 (a handoff that fails its contract is delivered, not lost) and contrasts the subagent and workflow-agent paths, which use different correction mechanisms. A failed-result branch and a reminder limit nearby make the shallow answer wrong. The answer key lives only in `manifest.json` and this file, which the trial cannot read: its corpus is the pin, restricted to `src, AGENTS.md, docs/architecture.md, docs/architecture-intent, docs/product-intent, docs/terminology.md`.

## Verification at the pinned tree

Every reference below is `path:line` at commit `74d097f9c661f2e3b1e01c1731d69b6aa8dc2039`, with a snippet that occurs on that line or range. The snippets were checked mechanically against the pinned extract.

### Fact `tracker-three`

Each consecutive refused handoff counts; at 3 the handoff tracker throws HandoffCorrectionExhausted, and every agent loop, subagents included, gets this tracker.

- `src/orchestration/agent-runtime/agent-loop-handoff.ts:26`: `const MAX_CONSECUTIVE_FAILURES = 3;`
- `src/orchestration/agent-runtime/agent-loop-handoff.ts:101`: `if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {`
- `src/orchestration/agent-runtime/agent-loop.ts:99`: `createHandoffTracker({ background: options.background?.tasks`

### Fact `subagent-schema-only`

A subagent's handoff contract is only its input schema (summary required); no accept step runs, so the refused submission recorded is the raw submission with its problems.

- `src/orchestration/modules/subagents/execution/prompts.ts:153`: `export const SUBAGENT_HANDOFF_SCHEMA: HandoffToolSchema = {`
- `src/orchestration/agent-runtime/tools/handoff-tool.ts:242`: `if (schema?.accept) {`
- `src/orchestration/agent-runtime/tools/handoff-tool.ts:270`: `handoff.onRejected?.({ ...(repaired === undefined`

### Fact `subagent-delivered-completed`

When correction runs out after a refusal, the parent receives the last refused submission as a completed result, led by a note that lists the remaining problems.

- `src/orchestration/modules/subagents/execution/child-execution.ts:570`: `const delivered = err instanceof HandoffCorrectionExhausted`
- `src/orchestration/modules/subagents/execution/child-execution.ts:628`: `return deliveredHandoffResult(delivered, resultContext());`
- `src/orchestration/modules/subagents/execution/result-resolver.ts:239`: `return { status: "completed", content: `${note}`

### Fact `no-handoff-failed`

By contrast, a subagent run that fails without any handoff gives the parent a failed result.

- `src/orchestration/modules/subagents/execution/result-resolver.ts:252`: `status: "failed", content: await boundText(content, ctx.budget)`
- `src/orchestration/modules/subagents/execution/result-resolver.ts:226`: `completed without producing text output or a handoff`

### Fact `workflow-delivered`

A workflow agent with the same exhaustion also gets its last refusal delivered as its outcome, and the issues travel into the attempt result; it fails with an invalid handoff only when no refusal was recorded.

- `src/orchestration/workflow-host/agent-callback.ts:674`: `const delivered = refused.delivered()`
- `src/orchestration/workflow-host/agent-callback.ts:675`: `if (delivered !== undefined) return delivered`
- `src/workflows/vm/attempt-runner.ts:369`: `handoff delivered after its correction ran out`

### Fact `workflow-reminder-limit`

A workflow agent has a second exhaustion that a subagent lacks: its handoff observer sets a reminder limit of 2 and throws HandoffCorrectionExhausted when the agent keeps ending without a handoff; the subagent observer passes no reminder limit.

- `src/orchestration/workflow-host/loop-observers.ts:33`: `const HANDOFF_REMINDER_LIMIT = 2;`
- `src/orchestration/workflow-host/loop-observers.ts:70`: `reminderLimit: HANDOFF_REMINDER_LIMIT`
- `src/orchestration/modules/subagents/execution/child-execution.ts:310`: `createHandoffObserver({ injectionQueue, parentChannel`

### Trap `reported-failed`

Wrong answer: A subagent whose handoff keeps failing its contract is reported to its parent as failed.

Why a shallow trace reaches it: The result resolver's failure branch is the visible end of a run that did not hand off cleanly.

Misleading evidence:

- `src/orchestration/modules/subagents/execution/result-resolver.ts:252`: `status: "failed", content: await boundText(content, ctx.budget)`

Refuted by:

- `src/orchestration/modules/subagents/execution/result-resolver.ts:239`: `return { status: "completed", content: `${note}`
- `src/orchestration/modules/subagents/execution/child-execution.ts:628`: `return deliveredHandoffResult(delivered, resultContext());`

### Trap `workflow-attempt-fails`

Wrong answer: A workflow agent's refused handoffs are discarded and its attempt fails with an invalid-handoff error.

Why a shallow trace reaches it: The workflow callback throws an invalid-handoff error right next to the delivery path.

Misleading evidence:

- `src/orchestration/workflow-host/agent-callback.ts:676`: `throw new HandoffInvalidError(attempt.id, error.message)`

Refuted by:

- `src/orchestration/workflow-host/agent-callback.ts:675`: `if (delivered !== undefined) return delivered`
- `src/workflows/vm/attempt-runner.ts:369`: `handoff delivered after its correction ran out`
