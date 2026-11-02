# Why this task exists

This task ports `bench/tasks/implement/metrics-resteer` into the chat A/B campaign. The source adapts the metrics-pipeline persona fixture into a store-backed refactor with four planted plan errors. The agent must inspect the working callback baseline, preserve behavior, and correct instructions when source evidence contradicts them.

## Provenance and sandbox

The sandbox archives only `.gitignore` from commit `64d9b75aeaa02fb5d00d2f75d01ea8a50df0d743`, following the debug-mutable-default precedent. The additive `sandbox.patch` reproduces all eight source `project/` files byte for byte. No dependency installation or setup command is needed. The sandbox contains no plan, manifest, qualification patches, or acceptance tests before capture.

All original hidden assertions are retained. The missing store import moves into each dependent test, with an asynchronous test body. The baseline intentionally has no store module: a static import prevents Bun from reporting individual test outcomes. Per-test imports produce nine ordinary failures while preserving the two passing percentile guards. The original visible sorted-input percentile assertion is frozen as the second guard. Callback-only visible tests are not frozen because this refactor explicitly removes that API; their collection and reporting behaviors remain covered through the requested store API.

The campaign copies frozen tests after capturing the agent's diff. It therefore does not score agent edits to acceptance tests. Current JUnit output defines the baseline, rather than the older source narrative's test count.

## What the checks prove

Nine fail-to-pass checks cover keyed storage, append order, independent metric keys, collector publication, metric-and-unit grouping, consumed windows, future samples, numeric percentiles, retention, newest-rollup selection, and report units and shape. Two pass-to-pass guards cover unsorted and sorted direct percentile inputs.

The original behavioral traps remain protected. The public drain operation must publish to the store without an invented duplicate flush method. Retention remains an inclusive 60,000-millisecond lower cutoff, including future-dated rollups. Unsorted values must produce numeric nearest-rank percentiles. Seconds convert to milliseconds while millisecond and count values remain unchanged, so removing live normalization behavior does not pass.

The suite accepts the source reference and its alternative store representation and latest-rollup algorithm. It does not pin a private reader signature, retention constant name, or normalizer helper. The five source mutants remain rejected: retention-60 fails four checks, unsorted-percentiles fails two, and no-consumption, insertion-newest, and future-bound-regression each fail one. Original orchestration judgments are not converted into source-text tests.

## Design variant

`message.md` requests the refactor without the plan. `design.md` reveals the three-phase store migration, percentile simplification, and unit cleanup, plus public API preservation and verification gates. It preserves the source plan's four planted claims as presented: stale flushWindow instructions, direct subtraction of retentionSeconds from a millisecond timestamp, the claimed ordering invariant, and the dead-normalizer claim. Later phases repeat the stale names and units, as in the source. The same message also retains the source's contradictory preservation criteria and evidence-over-plan instruction. The benchmark tests whether the agent corrects the claims; it does not present them as verified facts. It reveals no filenames, source code, reference implementation, or hidden test identifiers.

## Verification evidence

On 2026-10-22, a one-off verification script, run with `bun --env-file=.env.test`, ran the real `provisionSandbox` and `captureSandbox` functions. Every workspace was inside this repository's session scratch directory. The script checked exact source-project bytes and an empty baseline diff before acceptance.

The unfixed sandbox returned acceptance exit 1: nine failures from the missing store module and two passing percentile guards across 11 tests. Applying the original `qualification/reference.patch` returned exit 0: all 11 acceptance tests passed, with all three migrated visible tests passing separately. Applying the source alternative also passed all 11 acceptance tests and three visible tests. All five source mutants failed their expected behavioral checks. The verification script exited 0 and disposed every sandbox and command home.

The script recorded per-test outcomes, commands, and captured-diff metadata. The recorded capture confirms that frozen acceptance files are absent from the submitted diff. No reference solution ships in this task directory.
