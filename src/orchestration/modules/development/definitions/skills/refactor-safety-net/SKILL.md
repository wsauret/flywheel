---
description: Use when a structural refactor in Flywheel must keep behavior unchanged across a seam.
related: flywheel-uat
---

# Refactor Safety Net

Input: a planned refactor that changes how behavior is produced and promises that the behavior itself does not change, its plan document, and the code it rewires.

Mandatory gates:

- The matrix, the corpus replay, and the equivalence check all pass against the unmodified code, and the corpus and its generator are committed, before the first refactor commit lands.
- During the refactor, a matrix or corpus diff that you cannot explain is the regression that the net exists to catch. Stop and revert. Do not update the test to make it pass.
- A deliberate behavior change updates the schema, the characterization test, and a written rationale in the same commit as the code. The diff between the old and new golden artifacts is the reviewable record of each behavior change.
- Run the net again after every rebase, because concurrent work on the same files changes the baseline.

## 1. Decide whether the net applies

Build the net when the refactor does one of these:

- collapses or moves a seam: two code paths that produce the same output, a coordinate translation layer, or a protocol boundary;
- keeps an observable contract that code you do not change consumes: a wire schema, a projection shape, or a client;
- touches a surface with a history of incidents, such as session loading or output hydration.

Skip it for pure renames, dead-code removal, and changes that wire-level tests already pin. The net costs a medium-sized phase, so spend it only where a silent regression costs more.

## 2. Write the contract inventory

Before any test exists, write each contract that the refactor can break into the plan document with a `file:line` citation. Sort each contract into one category:

| Category | Definition | Protection |
|---|---|---|
| A: untouched by design | Contracts keyed on stable identity and structurally outside the change, such as identity-keyed lazy tool-body expansion or per-kind wire shapes | Point characterization tests that pass unchanged before and after |
| B: implicit equivalence | Two code paths that must agree while nothing enforces it, such as a block rendered live and the same block replayed later | An executable equivalence check (step 5) |
| C: the change surface | Contracts keyed on the thing that the refactor changes: coordinates, offsets, routing decisions | The full characterization matrix (step 3) and the golden corpus (step 4) |

Write category C as a finite matrix, for example anchor kinds by serving sources by delta-signal variants. If you cannot write the matrix, you do not yet understand the change surface: map it first. Key the matrix on a discriminated union, so that exhaustiveness checking adds each new variant to the tests.

## 3. Characterize at the wire level

A characterization test asserts what the code does today, not what it should do.

- Assert the shapes that consumers see, such as `OutputDelta` and `HydratedOutputRange`, never internals. An internal assertion is rewritten with the code and protects nothing. Only a wire-level diff catches a coordinate defect that type-checks.
- Write one test per matrix cell and name it for the cell, so that a failure names the contract that broke.
- Pin the rejections too: schema rejections, unavailable states, budget floors. Refactors break error paths more often than success paths.

When a characterization test shows current behavior that looks wrong, record it and decide on purpose whether to pin the defect and fix it later, or to fix it now. Record the decision. Never correct behavior silently inside a characterization test.

## 4. Build a golden corpus from real recorded sessions

The matrix covers the cases you thought of; the corpus covers what real use exercised.

1. Select real sessions from a project event store (`.flywheel/flywheel.sqlite`) whose histories cover the failure modes with incident history. Map each case in a manifest to named coverage categories, and let a test assert that the corpus still covers every required category.
2. Extract the minimal fact set for each case, bounded by a recorded maximum fact position, so that regeneration stays stable as the source store grows.
3. Sanitize: alias session, conversation, and tool-use ids, and replace user text with placeholders. Commit an executable check that scans the serialized bytes for leaks. A sanitization convention decays; a sanitization assertion does not.
4. Replay through production code: the real event store, the real projections, the real output session, never test doubles. A corpus generated through mocks certifies the mocks.
5. Snapshot the wire artifacts (history, ranges, tool bodies, group children, live deltas, live signals) into one committed JSON file with `generatedAt: "deterministic"`, with no timestamps and no ordering nondeterminism. Prove determinism with a test that refreshes the artifacts and asserts byte-identical output.
6. Replay the committed corpus in an ordinary test: append the facts to a fresh temporary store, run the production projection stack, and compare with the committed artifacts.

Keep the corpus small and coverage-mapped. A manifest that states which contract each artifact witnesses makes the corpus reviewable; unmapped snapshots are noise.

## 5. Check implicit dual-path equivalence

For each category B contract, write the check that diffs the two paths before you refactor either of them. Drive the same input through both paths, project both to wire blocks, and diff them block for block.

- Expect the first run to fail. Each divergence is a pre-existing defect. Fix it before you snapshot the corpus, or the gate pins the defect.
- Make the failure message forensic: name the case, the block kind, the block identity, and the JSON path of the first differing field. Test the assertion itself with a deliberate perturbation.
- Remove fields that are legitimately unstable, such as ids and timestamps, through one explicit comparable projection. A normalization that drops fields quietly hides regressions in those fields.

## 6. Phase the refactor

Make each phase independently revertible, and start the next phase only when the previous phase is green. Change the server first while the client stays unchanged and accepts the old superset, then simplify the client.

## 7. Cover what the wire cannot see

Wire-level tests do not observe rendering, timing, or crash windows. Load `flywheel-uat` and run a matrix of the historical failure scenarios, not happy paths, against the installed binary: reopen and scroll a long session, press Escape during a stream, kill the process during a stream and relaunch, expand tool bodies in a reopened session, and send a burst while the client is in the background. When always-on telemetry detects the failure class, assert zero firings across the matrix run.

## Worked example

The output seam collapse used this method. Its artifacts remain:

- Contract inventory and coverage map: the per-case `coverage` entries in `tests/fixtures/output-seam-corpus/manifest.json`.
- Golden corpus: `tests/fixtures/output-seam-corpus/corpus.json` with its manifest.
- Generator, with extraction, sanitization (`assertCorpusSanitized`), and production replay: `scripts/regenerate-output-seam-corpus.ts`.
- Corpus replay, coverage, and determinism tests: `tests/integration/output-seam-corpus.test.ts`, which runs under `bun run test:integration:no-api`.
- Dual-path equivalence check with its forensic assertion and perturbation test: `tests/unit/orchestration/app-service/output-live-derived-equivalence.test.ts`.
- Matrix characterization tests, such as "joins a durable prefix to an unflushed runtime tail and resolves its identity anchor": `tests/unit/orchestration/app-service/transcript-protocol.test.ts`.

## Result

Return the contract inventory by category, the matrix with its test locations, the corpus cases with their coverage, the equivalence check, the green-on-current evidence, each enumerated intentional change with its rationale, and the UAT matrix result. If a gate fails, report the unexplained diff and the revert, not a fix-forward.
