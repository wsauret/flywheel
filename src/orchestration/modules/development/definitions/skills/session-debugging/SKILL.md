---
description: Use when debugging a Flywheel session from its durable facts and diagnostic records.
related: systematic-debugging, flywheel-uat
---

# Session Debugging

Input: a session id, a project root, or a symptom, and the question to answer about what the runtime did.

Read evidence; never change it. A diagnostic record holds ids, sizes, hashes, and kinds, never content (ARCH-RUNTIME-075), so read the content a record names from the durable fact it points at. The storage layout, the diagnostics tiers, and the logging mechanics are in `docs/architecture.md`, "Session Artifacts" and its "Diagnostics" part.

## Sources

`flywheel events search` (in the source tree, `bun run events:search`) reads two sources as one timestamp-merged timeline:

- Durable facts in `.flywheel/flywheel.sqlite`. They answer replay and projection questions. Provider request audit facts (`prompt.assembled`, `tool_surface.selected`, `model.requested`, `model.request.dispatched`, `model.response_received`, `model.usage.recorded`, `context.application.recorded`, `context.transformer.applied`, `model.stream.summary.recorded`) are durable. `model.stream.summary.recorded` keeps the aggregate timing and thinking-stall evidence.
- Diagnostic records in the current `.flywheel/log/*.jsonl` files, including `Log.*` calls as `log.<level>` records. They answer "what did the runtime observe" within log retention. Raw stream telemetry is in `model.stream.*` records: provider-wire observations (`source=provider`, including Anthropic `ping` heartbeats), watchdog stalls and timeouts (`source=watchdog`), and normalized milestones (`source=normalized`).

The account service writes its own log under `~/.flywheel/log/`, not the project's. Search both directories when a question crosses the account and a project, such as a launch, an executor exit, or a web client report.

## Method

1. Find the vocabulary: `--list-types` lists the types of both sources.
2. Find failures: `--errors --latest`. `--errors` matches error-shaped facts plus `log.error` and `log.warn` records.
3. Inspect causality: `--around <position> -C <radius>` around the interesting position interleaves facts and records by timestamp. Narrow a broad window with `--type model.response_received` or `--regex "prompt\.assembled|model\.requested|model\.response_received"`.
4. Match the symptom to its records in `references/records.md` and read the fields that the reference names.
5. When a family you need is DEBUG or notable, reproduce with `FLYWHEEL_LOG_LEVEL=DEBUG`, which turns on `log.debug` and every DEBUG-tier and notable-tier family at once.
6. When the records do not explain the cause, add a targeted diagnostic at that boundary that follows `docs/architecture.md`, "Diagnostics", and continue with `systematic-debugging`.

```bash
bun run events:search --session <sessionId> --errors
bun run events:search --type model.response_received --latest --limit 20
bun run events:search --session <sessionId> --type model.stream ping
bun run events:search --session <sessionId> --type model.stream.event_observed thinking_delta
bun run events:search --session <sessionId> --around <position> -C 20
bun run events:search --list-types
```

The command also takes `--json`, `--case-sensitive`, repeated `--type`, `--actor`, `--after`, `--context`, and `--project-root`.

Facts to search by intent:

- `conversation.checkpoint.updated`: the current and earlier checkpoints of a conversation, with its intent and decisions.
- `handoff.written` and `handoff.validated`: the handoffs of the agents of a workflow.

Broad searches skip cache-shaped historical `output.*` facts so that duplicated transcript text does not hide the source fact. Name an output type only to inspect old data. Rendered transcripts are derived at read time from `conversation:<conversationId>` trees and `workflow:<workflowId>` facts; no rendered-output cache facts exist.

## Startup timing

Every instrumented startup owner records `startup.started` at DEBUG and one `startup.finished` summary at INFO, so a timeline writes at most two records. `flywheel events search --regex 'startup\.' --latest` reads the current project's records; the account service's records are under `~/.flywheel/log/`.

- The summary names its owner and process, with project or account context. Client, account service, project runtime, catalog, and summary index have separate lifetimes and clocks, and a warm client launch reuses existing owners. Compare records by context and timestamp; never add their elapsed times.
- `foregroundReadyMs` is the first-frame checkpoint when the owner reached it. It does not mean that session totals or background warmup finished; read those owners' completion records.
- Each stage holds its first start offset, last end offset, completed invocation count, summed duration, longest invocation, outcome, and work counts, rounded to a tenth of a millisecond. Durations include waits and can overlap within and between stages; they are not CPU time.
- A final `ready` means the initial work settled, not that every attempt succeeded: a stage can keep `failed` after recovery. Shutdown before settlement records `incomplete`, and a stage that never began stays `pending`.
- A summary names the slow boundary. When it does not explain the cause, add a targeted diagnostic at that boundary.
