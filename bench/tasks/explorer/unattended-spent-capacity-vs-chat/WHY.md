# Why this task exists

This question restores the behavior of fix 6962916c4 (fail an unattended run at once when its capacity is spent) and contrasts it with the interactive chat's capacity wait. The answer is a condition on another candidate's self-clearing hold, which spans the recovery policy, the provider error copy, and the chat capacity wait, and a nearby attempt limit suggests retries that a chat never takes. The answer key lives only in `manifest.json` and this file, which the trial cannot read: its corpus is the pin, restricted to `src, AGENTS.md, docs/architecture.md, docs/architecture-intent, docs/product-intent, docs/terminology.md`.

## Verification at the pinned tree

Every reference below is `path:line` at commit `74d097f9c661f2e3b1e01c1731d69b6aa8dc2039`, with a snippet that occurs on that line or range. The snippets were checked mechanically against the pinned extract.

### Fact `chat-capacity-only`

For a chat, a failure with a capacity reset enters the capacity wait and every other failure stands; a chat never reaches the unattended six-attempt retry policy.

- `src/orchestration/agent-runtime/unattended-recovery.ts:317`: `if (deps.caller === "chat") return`
- `src/orchestration/agent-runtime/unattended-recovery.ts:68`: `const UNATTENDED_ATTEMPT_LIMIT = 6`

### Fact `unattended-flag`

A chat is unattended when its root completion is unattended, which sets the chat's request purpose.

- `src/orchestration/chat/chat-request-options.ts:47`: `purpose: { kind: deps.rootChatCompletion?.unattended`

### Fact `unattended-self-clearing`

For an unattended run with a usage-limit hold, the wait uses the earliest self-clearing reset of another candidate, not the usage limit's own reset.

- `src/orchestration/agent-runtime/unattended-recovery.ts:275`: `const reset = deps.unattendedRun === true`

### Fact `self-clearing-non-usage`

A self-clearing reset exists only when another candidate's hold is not a usage limit.

- `src/infra/llm/provider-error-copy.ts:129`: `const hold = earliest.find((held) => held.kind !== "usage_limit")`

### Fact `unattended-fails`

When no such self-clearing candidate exists, the unattended run's failure stands at once, with no wait.

- `src/orchestration/agent-runtime/unattended-recovery.ts:276`: `if (reset === undefined) {`

### Fact `interactive-waits-reset`

The interactive chat waits until the stated usage-limit reset and then continues on its own.

- `src/orchestration/agent-runtime/unattended-recovery.ts:275`: `const reset = deps.unattendedRun === true`
- `src/orchestration/chat/chat-capacity-wait.ts:36`: `const [owed] = await capacityContinuations`

### Trap `six-retries`

Wrong answer: The unattended chat retries up to six times with growing pauses.

Why a shallow trace reaches it: The recovery module defines a six-attempt limit for every agent of an unattended client.

Misleading evidence:

- `src/orchestration/agent-runtime/unattended-recovery.ts:68`: `const UNATTENDED_ATTEMPT_LIMIT = 6`

Refuted by:

- `src/orchestration/agent-runtime/unattended-recovery.ts:317`: `if (deps.caller === "chat") return`

### Trap `unattended-waits-reset`

Wrong answer: The unattended run waits for the usage limit's stated reset, like the interactive chat.

Why a shallow trace reaches it: Both versions share the same recovery and wait-record path.

Refuted by:

- `src/orchestration/agent-runtime/unattended-recovery.ts:275`: `const reset = deps.unattendedRun === true`
- `src/orchestration/agent-runtime/unattended-recovery.ts:276`: `if (reset === undefined) {`

### Trap `interactive-stops`

Wrong answer: The interactive chat stops and waits for the person to send again.

Why a shallow trace reaches it: The chat capacity wait's comment says other failures stand and the person decides whether to send again.

Refuted by:

- `src/orchestration/chat/chat-capacity-wait.ts:36`: `const [owed] = await capacityContinuations`
