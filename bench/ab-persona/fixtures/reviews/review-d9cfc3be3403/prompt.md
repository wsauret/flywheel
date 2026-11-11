Review this revised, uncommitted change in . (`git diff HEAD -- <path>`; new file whole). Feature: commit window for the executor's storage client (approved design A, M1+M2). Files: src/orchestration/app-service/project-state-commit-window.ts (new), project-state-client.ts, project-state-worker.ts, project-state-protocol.ts, project-execution-state.ts, project-state-channel.ts; src/infra/event-store-types.ts, sqlite-event-store.ts, projection-registry.ts; docs/adrs/adr-007 (state-read paragraph only; the watch paragraph is from another, published unit); tests: project-state-commit-window.test.ts (new), project-state-client.test.ts, project-state-worker.test.ts, _project-state-worker-fixture.ts, event-read-surface-contract.test.ts, project-execution-state.test.ts, tests/integration/local/project-lane-failure-recovery.test.ts, tests/integration/local/executor-commit-stream-order.test.ts, _executor-commit-stream-probe.ts, and ~30 test doubles where a `deleteByAggregateTypeAndRequestId` property line was removed.

PREVIOUS FINDINGS AND CLAIMED FIXES (verify each with evidence; probes allowed in .flywheel/scratch; earlier probes: .flywheel/scratch and e4905cc0521c/scratch):
1. P1 memory: evicted payloads now released (entry.held = undefined), vacated index slots replaced with a shared VACATED entry, compaction floor 32. Re-run a retained-heap probe (e.g. 78k facts across 160 sessions, or 900 x 400 KB payloads) and report retained MB vs the 8 MiB budget.
2. P1 prune parity: facts of replace-latest / replace-latest-keyed families (factRetention) are indexed but never held, so any read meeting one goes remote. Re-run the prune-then-read probe (window vs SQL). Check that EVERY prunable family is covered, including keyed ones and families only pruned by offline maintenance, and that a read whose range contains a non-held fact never answers locally (pages, tail slices, the recency empty-page proof).
3. P2 closed transport: window closes on terminal onClose; observe() ignored after close; detach only unanchors. Re-run the native-channel close probe.
4. P2 exact predicates: mayAnswerPage/maySlice try the answer at `complete`; a cold-key tail slice costs exactly one request. Check the predicate is monotone (an answer available at `complete` is still correct after the barrier raises H, and never returns facts above H or misses facts in (complete, H]).
5. P3 worker: storedNotifications chain catches and reports through coalesceRepeats.
6. P3: the unused maintenance delete op was removed end to end; confirm no production or integration caller remained (grep src, scripts, tests/integration, tests/release) and that the event-read-surface contract test still protects row-count semantics.
7. Test split: commit-window tests moved into project-state-commit-window.test.ts unchanged in behavior.

Also report: which hot readers now go remote because of item 2 (implementer listed workflow view/recovery projections ~2/mr and tool-result-meta 1.05/mr as upper bounds) and whether that is a necessary consequence of exact parity.

DESIGN CONTEXT:
- Design intent (fixed): use the approved intent and decisions that the runtime carries from the parent's checkpoint (Round 3 design A, 8 MiB budget).
- recorded deviations: no separate availability check (closed window refuses local reads); degraded-fact test keeps capture+page because the read starts before the degraded notice arrives.

You may run once: `bun test tests/unit/orchestration/app-service/project-state-commit-window.test.ts tests/unit/orchestration/app-service/project-state-client.test.ts tests/unit/orchestration/app-service/project-state-worker.test.ts tests/unit/orchestration/app-service/project-state-channel.test.ts tests/unit/orchestration/app-service/event-read-surface-contract.test.ts tests/unit/orchestration/app-service/project-execution-state.test.ts tests/integration/local/executor-commit-stream-order.test.ts`. Do not write repository files. Return prose findings, one block each with Title, Severity, Location, Failure, Fix, or No findings.

Required output discipline:
1. Prose findings, one block per finding: Title, Severity, Location, Failure, Fix. No JSON. Flag ambiguity as `OPEN QUESTION:`.
2. Locations are always concrete: `path/to/file.ts:42-67`.
3. Format each Failure as four slots: `**Failure:** <Principle name>. <Intent>. <Observation>. <Reasoning>.` Keep the principle name the first token; if you cannot, mark it P3 or suppress it.
4. Each Fix proposes the elegant alternative concretely.
5. Preserve every runtime-behavior claim you tag `UNVERIFIED`.
6. The Design intent binds you; do not propose alternatives to it.
7. Hardening findings name their trigger; without one, cap at P3.