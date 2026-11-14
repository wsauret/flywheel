# Why this task exists

This question tests whether the explorer reads the code past a stated rule: the repository instructions say a session no client shows stays paused until an explicit message, but a due capacity wait is continued by the account and project wake with no shown check. Attaching a client also looks like a start signal and is not. The answer key lives only in `manifest.json` and this file, which the trial cannot read: its corpus is the pin, restricted to `src, AGENTS.md, docs/architecture.md, docs/architecture-intent, docs/product-intent, docs/terminology.md`.

## Verification at the pinned tree

Every reference below is `path:line` at commit `74d097f9c661f2e3b1e01c1731d69b6aa8dc2039`, with a snippet that occurs on that line or range. The snippets were checked mechanically against the pinned extract.

### Fact `release-waits-turn`

When the last client releases a chat, its runner ends at once only if its turn is at rest; otherwise the running turn finishes first.

- `src/orchestration/app-service/session-runtime-actor.ts:275`: `No client shows the chat any more`
- `src/orchestration/app-service/session-runtime-actor.ts:281`: `async function runRelease(): Promise<void> {`

### Fact `attach-no-resume`

Attaching seeds and attaches the runner and marks it shown; it never starts or resumes a turn.

- `src/orchestration/app-service/session-runtime-actor.ts:134`: `if (!ctx.sessionStore.attachChatRunner(sessionId, runner))`
- `src/orchestration/app-service/session-runtime-actor.ts:136`: `if (ctx.isShown(sessionId)) runner.setShown(true)`

### Fact `detach-paused`

A turn end detaches the runner as completed or paused; failures and mid-turn kills detach as paused.

- `src/orchestration/chat/runner-lifecycle.ts:383`: `const detachStatus = (terminal: AgentRunTerminal): "completed" | "paused" =>`
- `src/orchestration/chat/runner-lifecycle.ts:455`: `state.detachRunner(session, "paused")`

### Fact `capacity-wait-continues`

A chat whose capacity wait is due is resumed by the account and project wake through a chat.resume mutation, with no check of whether a client shows it.

- `src/orchestration/app-service/capacity-wait-continuation.ts:88`: `const owed = unheld.filter(`
- `src/orchestration/app-service/capacity-wait-continuation.ts:179`: `return resultOk(await input.dispatch(resumeMutation(target)))`
- `src/orchestration/app-service/project-executor-main.ts:252`: `void runtime?.continueCapacityWaits()`

### Fact `resume-refusals`

chat.resume activates and resumes the chat, refusing only when a turn already runs or the last turn end is not resumable.

- `src/orchestration/app-service/session-continuation.ts:101`: `if (!isResumableTurnEnd(turnEnd)) return refused`
- `src/orchestration/app-service/session-continuation.ts:106`: `const started = continueCommitted((runner)`

### Fact `stall-needs-person`

A stalled wait resumes only on an explicit resume, unlike a due capacity wait.

- `src/orchestration/chat/runner-lifecycle.ts:630`: `wait.stalled && options?.explicit !== true`

### Trap `only-person-restarts`

Wrong answer: Nothing restarts the unshown chat: it stays paused until a person sends a message.

Why a shallow trace reaches it: The repository instructions state that a session no client shows stays paused and only an explicit user message restarts work.

Misleading evidence:

- `AGENTS.md:86`: `A session no client shows stays paused, only an explicit user message restarts work`

Refuted by:

- `src/orchestration/app-service/capacity-wait-continuation.ts:88`: `const owed = unheld.filter(`
- `src/orchestration/app-service/capacity-wait-continuation.ts:179`: `return resultOk(await input.dispatch(resumeMutation(target)))`

### Trap `attach-resumes`

Wrong answer: Attaching a client tab to the paused chat resumes its turn.

Why a shallow trace reaches it: The attach path marks the runner shown, which reads like a start signal.

Misleading evidence:

- `src/orchestration/app-service/session-runtime-actor.ts:136`: `if (ctx.isShown(sessionId)) runner.setShown(true)`

Refuted by:

- `src/orchestration/app-service/session-runtime-actor.ts:134`: `if (!ctx.sessionStore.attachChatRunner(sessionId, runner))`
