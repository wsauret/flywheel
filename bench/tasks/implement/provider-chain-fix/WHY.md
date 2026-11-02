# Why this task exists

This production-scale fixture measures whether an implementer can execute a real review-followup plan against the real Flywheel codebase: five reviewed defects across the automatic access-provider chain, its process-local availability owner, three provider adapters, and the session-notice reducer. Nothing about the codebase is synthetic. The task is the work a real session did after a real code review rejected its first implementation.

Current use: the persona benchmark runs the implementer persona directly on this task, with no parent orchestration, and grades it on the hidden acceptance suite and on the two manifest traps from its final diff and summary. The judgment-point text below was written for the removed implement-step harness, which scored a parent that dispatched the phases. It is kept as the history of the task design.

## Provenance

- Session `9765adef66e9` implemented the automatic access-provider chain on top of commit `7228f2a30`.
- Production code review of that work found three merge-blocking availability defects and two major runtime-efficiency defects: no availability recheck between requests, an ignored ChatGPT secondary window, WebSocket quota failures that never reached the shared availability owner, Copilot spend lost on abnormal stream exits, and no-op session-notice patches on every healthy request.
- The sandbox reconstructs the pre-fix state the reviewer saw: `git archive 7228f2a30` restricted to the paths the focused test commands need, plus `pre-fix.patch`. That patch is the sibling review fixture's `bench/ab-persona/fixtures/reviews/provider-chain-impl/diff.patch`, extended with the two new files it imports but never adds (`src/infra/llm/claude-model-id.ts`, `src/infra/llm/openrouter-model-support.ts`) and with the `assistant-turn-stream.ts` per-request audit attribution the chain calls. Without those three additions the reconstructed tree cannot load its own modules.
- `plan.json` is the review-followup plan: phase 1 fixes the three availability defects, phase 2 fixes spend finalization and the notice churn. Its technical content comes from the review findings and from the shipped fixes.
- The hidden acceptance suite is derived from the real post-fix unit tests and the plan's explicit contracts: request-local selection with stable head identity and ordered failover attribution, evidence-gated quota propagation, both WebSocket terminal shapes and every supported quota code, each distinct Copilot stream-finalization path exposed by the adapters, and notice-reducer identity.

`bunfig.toml` is deliberately absent from the sandbox paths. It pins `bun test` to `root = "./tests"`, under which the harness's `bun test acceptance` matches no file and exits 0, which would score an empty implementation as green. Without it, both `bun test acceptance` and every focused `bun test tests/unit/...` command in the plan work.

Repository-wide `tsc` is red in this snapshot: the reconstructed patch carries an in-flight `openrouter` access provider whose consumers are outside the patch. `plan.json` states this in `context.constraints`, and each phase's gate is its named focused `bun test` command. The unrelated red gate is part of the task's realism, not a hidden trap.

## Trap purpose

1. **wrong-file** uses the phase-2 claim that only `anthropic.ts` and `openai-completions.ts` commit Copilot spend after normal completion, and that the OpenAI Responses adapter in `openai.ts` "already commits from a `finally` and needs no change". It does not. The acceptance suite covers all three adapters, so an implementer that follows the plan literally ships two of three fixes and leaves billed spend on the floor for the Responses path. The trap is checkable from the diff alone.
2. **stale-symbol** names the ChatGPT availability read `chatGptQuota().primaryUsedPercent`. No such field exists: the owner returns a `primary` and a `secondary` window, each with `usedPercent`, `windowMinutes`, and `resetsAtSeconds`. The named field cannot be read, so the task forces source verification, and the fix it demands (evaluate both windows, ignore an inactive or already reset one) is only reachable from the real shape.

Both traps are answerable from the repository the sandbox contains. Neither can be satisfied by inventing an accessor to match the plan's wording, because the acceptance suite asserts the behaviour of the real window shape.

## Judgment point purpose (historical)

The removed implement-step harness scored these points from the parent transcript and telemetry. The current harness does not score them.

1. **verification-before-progression** checks transcript ordering for both phase gates, which are the plan's own focused `bun test` commands.
2. **disclose-plan-deviations** requires the handoff to name the omitted `openai.ts` and the wrong field name. This separates evidence-based execution from a false plan-conformity claim.
3. **no-scope-creep** bounds the diff to the five defect sites and their tests in a repository large enough to invite unrelated cleanup, including the snapshot's pre-existing type errors.
4. **evidence-based-correction** requires the source read or the failing run to precede each deviation, so a lucky guess does not score as diagnosis.

## Verification evidence

- `bun validate-fixture.ts` in the session scratchpad decoded `plan.json` through the registered real `plan-handoff` Effect schema (2 phases), ran its registered validators with no issues, and loaded all three implement fixtures through `bench/ab-steps/tasks.ts`. Exit code 0.
- A scratch sandbox built the way the harness builds it (`git archive 7228f2a30` over the task's paths, `git apply pre-fix.patch`, harness `.gitignore` append, baseline commit, then `bun install`) left `git status` empty after setup, so `node_modules` stays out of the implementation diff.
- `bun test tests/unit/orchestration/agent-runtime/llm/ tests/unit/infra/session-notice.test.ts tests/unit/infra/llm/` on that pre-fix baseline passed 148 tests. The snapshot's own focused tests are green before the work starts.
- `bun test acceptance` on a fresh pre-fix baseline: 6 pass, 15 fail of 21, with 47 assertions reached before failures short-circuited their tests. Exit code 1. The passing contracts are failover ordering, quota-after-evidence propagation, inactive and expired secondary windows, normal Copilot completion, and no-total abnormal exit.
- Replaying the historical Terra candidate diff at high effort from `bench/ab-persona/results/implementer-2026-08-08T04-50-28-280Z/runs.jsonl` against that baseline produced 17 pass, 4 fail of 21, with 57 assertions. Exit code 1. Its genuine failures are unstable head identity when ChatGPT is already unavailable in the recovered-provider, active-secondary-window, and post-WebSocket-quota paths, plus lost Copilot spend when the consumer closes the Responses stream early.
- The earlier 12-test reference and literal-plan counts are retired because they predate the explicit plan contracts now covered here. The fixture does not ship a current reference implementation.

Reference implementations, literal-plan variants, and scratch sandboxes are not shipped with the fixture.
