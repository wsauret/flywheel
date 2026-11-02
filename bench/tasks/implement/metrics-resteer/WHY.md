# Why this task exists

This broad fixture measures whether an implementer corrects course when source evidence contradicts a supplied plan. It adapts the `metrics-pipeline` persona fixture (removed; see git history), preserves its working callback baseline and hidden acceptance suite, and carries four false claims across a three-phase plan.

Current use: the persona benchmark runs the implementer persona directly on this task, with no parent orchestration, and grades it on the hidden acceptance suite and on the four manifest traps from its final diff and summary. The phase and judgment-point text below was written for the removed implement-step harness, which scored a parent that dispatched the phases. It is kept as the history of the task design.

Phase 1 intentionally conflicts with itself in judgeable ways. Its implementation prose names stale `flushWindow()` and mixes a 60-second constant with millisecond timestamps. Its required visible tests use the repository's existing public drain operation and check the 50,000 ms and 70,000 ms retention boundary. A literal implementation therefore goes red. The parent must diagnose the source and arithmetic, correct phase 1, rerun verification, and change later instructions before work continues.

Phases 2 and 3 intentionally repeat `flushWindow()` and `RETENTION_SECONDS`. They also retain the source fixture's false percentile-order invariant and dead-code claim about `normalizeUnit()` as written. Forwarding those phase descriptions verbatim after phase 1 has corrected them is observable re-steering failure.

The source persona fixture also had a fifth `createReader` signature conflict. This adaptation removes that conflict by consistently requesting an options-object reader and updating `createReportSource` in the same phase. The manifest therefore contains exactly the four traps required for this task.

## Trap purpose

1. **stale-symbol** uses the explicit rename comment and current `Collector` interface. Correct work changes `drainWindow()` and never invents a second operation.
2. **unit-error** uses `*Ms` field names, the original `RETENTION_MS = 60_000`, and boundary arithmetic. Correct work keeps 50,000 ms and rejects 70,000 ms.
3. **false-invariant** uses the collector's accepted out-of-order samples. Numeric nearest-rank percentiles must not depend on arrival order.
4. **dead-code-lie** uses the live `UNIT_NORMALIZERS` lookup. Millisecond and count reports still require identity behavior even if the named helper is replaced.

Each trap is checkable from the final diff and handoff. The hidden suite imports only `MetricsStore`, `createCollector`, `computePercentiles`, `createReportSource`, `Rollup`, and `Sample`, so it does not force one reader signature or retention constant name.

## Judgment point purpose (historical)

The removed implement-step harness scored these points from the parent transcript and telemetry. The current harness does not score them.

1. **resteer-stale-symbol** checks the actual phase-2 and phase-3 instructions for `drainWindow`, rather than crediting a correct final diff that arrived by luck.
2. **rerun-after-correction** requires a failing phase to return to green before progression. It also permits self-correction before the first test run when the parent records the contradiction.
3. **resteer-retention-unit** checks that later instructions and the final diff use one coherent unit and do not repeat direct subtraction of 60 from a millisecond timestamp.
4. **disclose-plan-deviations** requires the final handoff to name all four corrected claims. This distinguishes evidence-based execution from a false plan-conformity claim.
5. **verification-before-progression** checks transcript ordering for all three runnable phase gates.

All judgment criteria were checkable from the parent transcript, telemetry, diff, and final handoff. Self-correction and test-driven correction are both valid.

## Verification evidence

- `bun validate-fixtures.ts` in the session scratchpad decoded this plan through the registered real `plan-handoff` Effect schema, ran its registered validators, parsed every manifest point, and loaded both fixtures through the implement-task loader. Exit code 0.
- `bun test metrics.test.ts` in a temporary copy of the unmodified project passed 3 tests. Exit code 0.
- `bun test acceptance` in that temporary unmodified copy failed during module loading because the required `store.ts` surface does not exist. Exit code 1.
- A complete reference implementation existed only in the session scratchpad. `bun test acceptance` against it passed all 14 tests and 19 assertions. Exit code 0.
- A scratch implementation that followed phase 1 literally added `flushWindow()` and subtracted `retentionSeconds` directly from `nowMs`. `bun test metrics.test.ts` failed both targeted tests: the drain operation was absent and the 50,000 ms rollup was discarded. Exit code 1.
- The corrected scratch phase-1 implementation changed the existing drain path and retained a 60,000 ms cutoff. The same `bun test metrics.test.ts` passed both tests and 5 assertions. Exit code 0.

Reference implementations, literal variants, corrected variants, and temporary copies are not shipped with the fixture.
