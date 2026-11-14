# Why this task exists

The question needs a trace across several files of the pinned tree. It restores the behavior of fix acaf2c41b, which is in the public history before the pin, and its trap is the behavior before that fix or a shallow reading of it. The answer key lives only in `manifest.json` and this file, which the trial cannot read: its corpus is the pin, restricted to `src, AGENTS.md, docs/architecture.md, docs/architecture-intent, docs/product-intent, docs/terminology.md`.

## Verification at the pinned tree

Every reference below is `path:line` at commit `b5833f6a4e4458a80e02612cfb5c0729aaaaf267`, with a snippet that occurs on that line or range. The snippets were checked mechanically against the pinned extract.

### Fact `one-slot-cut-state`

An agent input slot keeps its cut and its opening action in one state value, unread until it reads the attempt's durable turn end, and one transition function produces every next value.

- `src/orchestration/workflow-host/agent-inputs.ts:153-155`: `"unread"`
- `src/orchestration/workflow-host/agent-inputs.ts:165-167`: `function advanceCut(`

### Fact `unread-keeps-address`

A Resume or message that lands while the slot is unread keeps its address instead of being dropped.

- `src/orchestration/workflow-host/agent-inputs.ts:171`: `case "authorize": return { kind: "unread", handedBack: [...state.handedBack, event.address] }`

### Fact `initialize-drops-durable-cut`

When the slot initializes, it restores the durable interrupt only when no kept address reaches the agent, so a person's input during opening clears it.

- `src/orchestration/workflow-host/agent-inputs.ts:170`: `reaches(address, event.agent)) ? undefined : event.restored`

### Fact `resume-reads-same-cut`

The runner's Resume reads the same cut a person's message meets, including the durable one, so a Resume during opening continues the agent instead of answering that it is not parked.

- `src/orchestration/workflow-host/runner.ts:448-451`: `await resume(address)`
- `src/orchestration/workflow-host/runner.ts:98-100`: `attempt.turnEnd?.end.reason`

### Trap `durable-interrupt-wins`

Wrong answer: The durable interrupt overrides the person's input during opening: the agent opens interrupted and the Resume answers that it is already running.

Why a shallow trace reaches it: The durable turn end is applied when the agent opens, so it looks like the last word; this was the behavior before fix acaf2c41b.

Refuted by:

- `src/orchestration/workflow-host/agent-inputs.ts:170`: `reaches(address, event.agent)) ? undefined : event.restored`
