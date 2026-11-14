# Why this task exists

This question asks about the interaction of a person's Stop with the Claude subscription route's wait for a thinking block's signed row (fix 07ef8a320). The abort path looks immediate, but the row wait does not read the abort. The answer key lives only in `manifest.json` and this file, which the trial cannot read: its corpus is the pin, restricted to `src, AGENTS.md, docs/architecture.md, docs/architecture-intent, docs/product-intent, docs/terminology.md`.

## Verification at the pinned tree

Every reference below is `path:line` at commit `74d097f9c661f2e3b1e01c1731d69b6aa8dc2039`, with a snippet that occurs on that line or range. The snippets were checked mechanically against the pinned extract.

### Fact `close-awaits-signed`

The stream holds the response's last block open until its signed row is read: closing awaits the next signed block.

- `src/orchestration/modules/provider-claude-agent-sdk/agent-host/agent-stream.ts:71`: `const nextSigned = async (): Promise<SignedBlock> => {`
- `src/orchestration/modules/provider-claude-agent-sdk/agent-host/agent-stream.ts:105`: `const signed = await nextSigned();`

### Fact `polls-not-abort`

After the stop item, the row wait only polls the row file and no longer reads the step's events, so the abort does not wake it.

- `src/orchestration/modules/provider-claude-agent-sdk/agent-host/agent-stream.ts:88`: `await Bun.sleep(ROW_POLL_MS);`
- `src/orchestration/modules/provider-claude-agent-sdk/agent-host/agent-bridge.ts:316`: `Queue.failCauseUnsafe(events, Cause.fail(error));`

### Fact `ten-second-bound`

The only bound is 10 seconds from the first poll after the stop item; then the stream throws a transient error that the engine wrote no row for a signed block.

- `src/orchestration/modules/provider-claude-agent-sdk/agent-host/agent-stream.ts:15`: `const ROW_BOUND_MS = 10_000;`
- `src/orchestration/modules/provider-claude-agent-sdk/agent-host/agent-stream.ts:86`: `deadline ??= Date.now() + ROW_BOUND_MS;`
- `src/orchestration/modules/provider-claude-agent-sdk/agent-host/agent-stream.ts:87`: `wrote no row for a signed block of the response`

### Fact `abort-marks-gone`

The abort fails the step's event queue and marks the hosted agent's phase gone.

- `src/orchestration/modules/provider-claude-agent-sdk/agent-host/agent-bridge.ts:324`: `step.end(signal.reason instanceof Error`
- `src/orchestration/modules/provider-claude-agent-sdk/agent-host/agent-bridge.ts:314`: `target.phase = { kind: "gone" };`

### Fact `partial-not-copied`

The aborted response never enters the hosted agent's copy: the copy is set only in the answer callback, which runs when a response ends normally, and a gone phase reads as released.

- `src/orchestration/modules/provider-claude-agent-sdk/agent-host/agent-stream.ts:147`: `onAnswer({ message: { role: "assistant"`
- `src/orchestration/modules/provider-claude-agent-sdk/agent-host/agent-bridge.ts:403`: `current.copy = { identity: hosted.identity`
- `src/orchestration/modules/provider-claude-agent-sdk/agent-host/agent-bridge.ts:246`: `current.copy === undefined || current.phase.kind === "gone"`

### Fact `next-message-restarts`

The next message starts a new hosted agent, not a resume: a released state plans a start, and the old agent ends as restarted.

- `src/orchestration/modules/provider-claude-agent-sdk/request-plan.ts:114`: `state.kind === "released" && view.messages.length === 1`
- `src/orchestration/modules/provider-claude-agent-sdk/agent-host/agent-bridge.ts:352`: `if (resumed === undefined) endAgent(agent, "restarted");`

### Trap `stop-is-immediate`

Wrong answer: Stop releases the request at once, because the abort ends the step's event stream immediately.

Why a shallow trace reaches it: The abort handler ends the step and fails its event queue, which reads as an immediate cut.

Misleading evidence:

- `src/orchestration/modules/provider-claude-agent-sdk/agent-host/agent-bridge.ts:324`: `step.end(signal.reason instanceof Error`

Refuted by:

- `src/orchestration/modules/provider-claude-agent-sdk/agent-host/agent-stream.ts:88`: `await Bun.sleep(ROW_POLL_MS);`
- `src/orchestration/modules/provider-claude-agent-sdk/agent-host/agent-stream.ts:86`: `deadline ??= Date.now() + ROW_BOUND_MS;`

### Trap `resume-with-partial`

Wrong answer: The next message resumes the same hosted agent, and its partial reply is part of the resumed context.

Why a shallow trace reaches it: The bridge keeps a copy of each hosted agent's conversation for resume.

Misleading evidence:

- `src/orchestration/modules/provider-claude-agent-sdk/agent-host/agent-bridge.ts:403`: `current.copy = { identity: hosted.identity`

Refuted by:

- `src/orchestration/modules/provider-claude-agent-sdk/agent-host/agent-stream.ts:147`: `onAnswer({ message: { role: "assistant"`
- `src/orchestration/modules/provider-claude-agent-sdk/agent-host/agent-bridge.ts:352`: `if (resumed === undefined) endAgent(agent, "restarted");`
