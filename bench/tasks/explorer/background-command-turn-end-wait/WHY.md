# Why this task exists

This question restores the behavior of fix afa11881c (keep a session working while a background command runs) together with the one-hour wait ceiling. The answer spans the agent loop, the pending-work nudge, the wait settlement, background-work readiness, and the process tool, and the tool's own schema maximum suggests a refusal that never happens. The answer key lives only in `manifest.json` and this file, which the trial cannot read: its corpus is the pin, restricted to `src, AGENTS.md, docs/architecture.md, docs/architecture-intent, docs/product-intent, docs/terminology.md`.

## Verification at the pinned tree

Every reference below is `path:line` at commit `74d097f9c661f2e3b1e01c1731d69b6aa8dc2039`, with a snippet that occurs on that line or range. The snippets were checked mechanically against the pinned extract.

### Fact `nudge-then-default-wait`

At a turn end with live background work and no wait call, the runtime sends one reminder and then opens a 240 second wait on the agent's behalf; the default wait repeats at later turn ends until a wait call or a person's message resets the nudge.

- `src/orchestration/agent-runtime/agent-loop.ts:199`: `if (!state.wait && hasLiveBackgroundWork`
- `src/orchestration/agent-runtime/agent-loop.ts:202`: `openWaitFor(runtimeWaitSeconds)`
- `src/orchestration/agent-runtime/pending-work-nudge.ts:40`: `await pushUser(PENDING_WORK_NUDGE);`
- `src/orchestration/agent-runtime/pending-work-nudge.ts:47`: `return DEFAULT_WAIT_SECONDS;`
- `src/orchestration/agent-runtime/tools/process.ts:16`: `export const DEFAULT_WAIT_SECONDS = 240;`

### Fact `expiry-notice-not-stop`

The parked wait arms an expiry timer only while it waits on background work; expiry re-enters the loop with a wait-expired notice and does not stop the command.

- `src/orchestration/agent-runtime/agent-loop-input-consumer.ts:217`: `if (waitsOnBackgroundWork && waitExpiry !== undefined`
- `src/orchestration/agent-runtime/agent-loop-input-consumer.ts:237`: `const raw = committed ?? (expired ? waitExpiredInput`
- `src/orchestration/agent-runtime/tools/process.ts:304`: `It bounds only this wait, not the work.`

### Fact `what-ends-wait`

An open wait ends on a background notification, the wait-expired notice, a person's message, or a Resume that does not continue the wait; other inputs, such as runtime notices, do not end it.

- `src/orchestration/agent-runtime/agent-loop-wait.ts:44`: `export function endsOpenWait`
- `src/orchestration/agent-runtime/agent-loop-wait.ts:45`: `if (input.kind === "resume") return !input.continuesWait;`
- `src/orchestration/agent-runtime/agent-loop-wait.ts:46`: `isWaitExpiredNotice(input.content)) return true;`

### Fact `awaited-work-only`

Live work counts only awaited tasks: running tasks that the agent or the runtime did not interrupt, plus pending deliveries; when none remain the wait closes and the loop does not park.

- `src/orchestration/agent-runtime/background-work.ts:814`: `work.live.filter(awaits).length + work.pending.length`
- `src/orchestration/agent-runtime/background-work-readiness.ts:21`: `return by === undefined || by === "person"`
- `src/orchestration/agent-runtime/agent-loop.ts:238`: `if (state.wait && !hasLiveBackgroundWork`

### Fact `over-hour-capped`

A soft_timeout above one hour is accepted and capped at 3600 seconds, not refused: the tool validates its own input, so the schema maximum is never enforced as a refusal.

- `src/orchestration/agent-runtime/tools/process.ts:33`: `Math.min(seconds, WAIT_CEILING_SECONDS)`
- `src/orchestration/agent-runtime/tools/process.ts:272`: `validatesOwnInput: true`
- `src/orchestration/agent-runtime/tools/tool-dispatch.ts:270`: `tool.validatesOwnInput ? [] : validateToolInput`

### Fact `noop-wait`

A wait with nothing pending does not park the turn; it returns at once with a no-op notice.

- `src/orchestration/agent-runtime/agent-loop-wait.ts:97`: `enqueueRuntimeNotice?.(formatWaitNoopNotification());`

### Trap `over-hour-refused`

Wrong answer: A wait longer than one hour is refused with a validation error.

Why a shallow trace reaches it: The tool's input schema declares the one-hour ceiling as its maximum.

Misleading evidence:

- `src/orchestration/agent-runtime/tools/process.ts:20`: `maximum: WAIT_CEILING_SECONDS`

Refuted by:

- `src/orchestration/agent-runtime/tools/tool-dispatch.ts:270`: `tool.validatesOwnInput ? [] : validateToolInput`
- `src/orchestration/agent-runtime/tools/process.ts:33`: `Math.min(seconds, WAIT_CEILING_SECONDS)`

### Trap `turn-goes-idle`

Wrong answer: When the turn ends over a running command with no wait call, the turn completes and the agent stays idle until the person writes.

Why a shallow trace reaches it: A turn end with no tool call normally completes the turn.

Refuted by:

- `src/orchestration/agent-runtime/agent-loop.ts:199`: `if (!state.wait && hasLiveBackgroundWork`
- `src/orchestration/agent-runtime/pending-work-nudge.ts:47`: `return DEFAULT_WAIT_SECONDS;`
