# Model benchmarks

The benchmarks measure how well a model, an effort level, and Flywheel's guidance do real coding work, so that the maintainer can select role defaults from evidence. A live run sends real model requests through a Flywheel auth profile, so it spends API money or subscription quota. You do not need to run a benchmark to contribute to Flywheel: the harness unit tests in `tests/unit/bench/` run with `bun run test`, and the commands in [Validation](#validation) check a harness change without spend. To run a benchmark, start with the [coding benchmark menu](#coding-benchmark-menu) and [`chat-ab/README.md`](chat-ab/README.md), or with [`harbor/README.md`](harbor/README.md) for Harbor Hub benchmarks such as Terminal-Bench. The rest of this page is the maintainer's record of methods and observed results.

This directory contains Flywheel's benchmark harnesses, fixtures, tasks, raw run artifacts, and the runtime/cost menu below. Detailed comparative findings live in `bench/findings/`. The coded role policy lives in `src/orchestration/config/role-model-defaults.ts`.

Every runnable fixture works in a public clone. A fixture depends only on content in the public repository: a commit in its history, files inside the task (a vendored `project/` folder), or an empty tree. A patch and setup commands can change any of these sources. `bun run lint:bench-pins`, a step of `bun run lint`, fails when a fixture names a commit that is not an ancestor of HEAD, and it fails in a shallow clone. Tasks that fetch a public upstream source download it at run time.

The measured menus on this page are results from the earlier fixtures, which pinned commits of the development repository from before the public history. The public fixtures restore the same defects on a public base or vendor the same files, but a model can see different surrounding code, so their numbers need a new baseline before you compare against them.

The doctrine: recorded findings establish performance only for the model, effort, task, and guidance that the campaign measured. Current role preferences are policy, not evidence of an unmeasured successor's performance.

## Coding benchmark menu

Use these observed ranges to budget a run, not as guaranteed completion times or prices. The Flywheel rows are results from the earlier fixtures and need a new baseline (refer to the start of this page). Measurements are from October 11–13, 2026, using **gpt-6.1-sol / high**, the maintainer's auth profile, and a 25-minute candidate budget. Observed serving was ChatGPT. Time covers candidate model and tool work, not provisioning, final grading, or judges. Cost is the estimated API-equivalent USD per candidate, not a subscription invoice. Fully accounted runs below recorded **$0 billed**; Rust and Scheme have incomplete accounting and no known full-run billed total.

Pass rate means the entire original task criterion passed, not the percentage of individual tests. Samples are small: a 2/2 result provides regression coverage, not proof that a task is easy for every model. A 0/2 result shows observed headroom for this seat, not a population failure rate.

New persona campaigns default to `claude-sonnet-5-5:medium` on the auth profile that you select (refer to `--auth-profile` below), with one repeat and four concurrent cells. The menu retains its measured model, effort, runtime, cost, and pass rate; those observations do not establish performance for the new default.

| Fixture | What it exercises | Availability | Candidate time | Equivalent USD/run | Task passes |
|---|---|---|---|---|---|
| [Config first-write lock](tasks/coding-development/config-lock-first-write/) | Correct locking around the first configuration write | Runnable development fixture | 2.5–2.8 min | $0.173–0.174 | 2/2 |
| [Metrics resteer](tasks/implement/metrics-resteer/) | Correct a misleading metrics implementation plan | Runnable persona fixture | 3.4–3.9 min | $0.161–0.183 | 2/2 |
| [Multiphase templates](tasks/implement/template-multiphase/) | Implement template changes across multiple phases | Runnable persona fixture | 3.4–4.4 min | $0.167–0.241 | 2/2 |
| [Moto #7365](tasks/implement/getmoto__moto-7365/) | Repair DynamoDB update behavior for floating-point values | Runnable native development fixture (macOS arm64); [evidence](tasks/implement/getmoto__moto-7365/calibration.json) | 2.2–4.0 min | $0.154–0.315 | 2/2 |
| [HTTPX streaming JSON](tasks/implement/httpx-streaming-json-iteration/) | Add streaming JSON iteration while preserving existing behavior | Runnable native development fixture (macOS arm64); [evidence](tasks/implement/httpx-streaming-json-iteration/calibration.json) | 11.6–15.5 min | $0.599–0.763 | 2/2 |
| [Requests #6028](tasks/implement/psf__requests-6028/) | Preserve proxy credentials during URL normalization | Runnable native development fixture (macOS arm64); [evidence](tasks/implement/psf__requests-6028/calibration.json) | 2.6–3.1 min | $0.188–0.262 | 2/2 |
| [Rust React](tasks/implement/rust-react/) | Implement reactive cells and callback propagation | Runnable native development fixture; [evidence](tasks/implement/rust-react/calibration.json) | 3.8 min | Unknown; known subtotal $0.133 | 1/1 code; accounting incomplete |
| [Scheme interpreter](tasks/implement/scheme-metacircular/) | Implement a metacircular evaluator against original programs | Runnable native development fixture (macOS arm64); [evidence](tasks/implement/scheme-metacircular/calibration.json) | 25 min; timed out | Unknown; known subtotal $0.616 | Captured code passed; no completed run |
| [Regex chess](tasks/implement/regex-chess/) | Generate legal chess moves through regular-expression substitutions | Runnable native development fixture (macOS arm64); [evidence](tasks/implement/regex-chess/calibration.json) | 8.5 min | $0.213 | 1/1 |
| [DS-1000 #298](tasks/implement/ds1000-298/) | Solve the original NumPy array-manipulation task | Runnable native development fixture (macOS arm64); [evidence](tasks/implement/ds1000-298/calibration.json) | 44 sec | $0.048 | 1/1 |
| [Astropy FITS #14598](tasks/implement/astropy__astropy-14598/) | Preserve quoted string values through FITS card round trips | Runnable native development fixture (macOS arm64); [evidence](tasks/implement/astropy__astropy-14598/calibration.json) | 2.1–4.0 min | $0.157–0.226 | 0/2 |
| [Yup #2305](tasks/implement/jquense__yup-2305/) | Preserve nested array and tuple casting context | Runnable native development fixture (macOS arm64); [evidence](tasks/implement/jquense__yup-2305/calibration.json) | 3.3–3.9 min | $0.209–0.238 | 2/2 |
| [Redis #10068](tasks/implement/redis__redis-10068/) | Preserve stream entries above the trimming threshold | Runnable native development fixture (macOS arm64); [evidence](tasks/implement/redis__redis-10068/calibration.json) | 4.5–4.7 min | $0.273–0.279 | 2/2 |

All external native tasks in this menu are registered in the shared runnable corpus. Their linked calibration records distinguish historical model observations from tasks not yet measured; native qualification does not represent a new model run.

The October 13 Yup and Redis campaign used the ordinary implementer persona and the normal automatic provider failover of the maintainer's auth profile, with no benchmark-specific billing controls, provider filters, or utilization pauses. All four original task criteria passed, with complete accounting and no judge calls. Its estimated equivalent total was $0.999; recorded billed spend was $0. Both tasks remain regression coverage, but this sample showed no difficulty headroom for Sol high. The earlier scratch public-native pilots used different guidance and tools, so these observations are not a paired prompt comparison.

Rust React requires Bun, Git, and standalone Cargo, rustc, and rustdoc binaries on `PATH`. With rustup, select the installed toolchain before launching: `export PATH="$(dirname "$(rustup which cargo)"):$PATH"`. The fixture uses a credential-free workspace home, offline Cargo, and no external crates. Its task-owned adapter reuses Flywheel's repository-owned process supervisor. Native macOS arm64 qualification used Rust 1.94.0: preparation took 0.49–0.62 seconds, and capture plus grading took 1.73–1.81 seconds. The [control record](tasks/implement/rust-react/qualification-record.json) reports pristine rejection, reference success, and callback-fault rejection. A scratch-only two-second Cargo deadline returned a failed report in 2.56 seconds with the test child gone and output drained. Cargo retains its original 180-second limit; the outer adapter allows 210 seconds for setup and report settlement. These observations do not establish original compiler or cross-platform equivalence.

FITS requires Bun, Git, CPython 3.9 as `python3`, and clang on `PATH`, on the qualified macOS arm64 platform. Preparation checks these tools before model work. It downloads the pinned public source archive and 36 hash-verified PyPI wheels into each workspace, then creates a standard-library virtual environment with `--symlinks`. No system packages or private caches are required. The candidate interpreter is `.bench-home/python/bin/python`; this runtime location does not change the original task instructions. The [provenance](tasks/implement/astropy__astropy-14598/provenance.json) records source-specific rights, exact copied inputs, and native adaptations. The [control record](tasks/implement/astropy__astropy-14598/qualification-record.json) reproduces base 175/176, reference 176/176, and semantic fault 175/176 through the shared native loader, provisioner, and capturer. It verifies committed candidate capture, restoration of 683 original grading owners, all 176 selected statuses, and 33 ancillary public API observations. Fresh capture plus grading took 76.8–86.3 seconds per control, including public acquisition and the original isolated source build. The adapter uses the existing owned process supervisor, with 600-second build, 300-second test, and 1200-second outer limits. This is native qualification, not original Linux or leaderboard equivalence.

Scheme requires Bun, Git, and tar on macOS arm64. Each workspace downloads seven [public hash-pinned inputs](tasks/implement/scheme-metacircular/public-inputs.json), including standalone CPython 3.13.9 and pytest wheels. Standard-library venv and offline pip install them without system writes or private caches. The task's `native.path` puts `.bench-home/python/bin` first on the candidate's PATH. The original request stays unchanged. The [provenance](tasks/implement/scheme-metacircular/provenance.json) documents exact source copies and native path mappings. The [control record](tasks/implement/scheme-metacircular/qualification-record.json) reproduces base rejection, reference success, and lexical-scope fault rejection through shared native loading, provisioning, and capture. Each control retains 63 program statuses, 131 interpreter observations, and five metacircular cases. The original pytest status and reward own the single task criterion; shell exit zero does not mean success. Preparation took 5.5–6.3 seconds; capture plus fresh acquisition and grading took 10.7–62.6 seconds. Original interpreter limits remain 10 and 60 seconds, and the verifier retains 2400 seconds. The adapter allows 2700 seconds for separate acquisition and report settlement. These measurements establish native macOS arm64 behavior, not original-container or cross-platform equivalence.

Chess requires Bun, Git, and tar on macOS arm64. Each workspace acquires nine [public hash-pinned inputs](tasks/implement/regex-chess/public-inputs.json), including CPython 3.13.9, pytest wheels, chess 1.11.2 source, and its isolated setuptools build dependency. The separate native environment appendix maps the original `/app` path to the workspace and identifies `.bench-home/python/bin/python3`. The [control record](tasks/implement/regex-chess/qualification-record.json) retains all four original tests: the reference passes, the absent implementation fails all four, and the semantic fault fails three games while passing the size check. The reference visits 108 positions across three games. Original pytest status and reward own acceptance. Reference preparation took 7.9 seconds; capture plus fresh provisioning and grading took 4.9 minutes. The model budget is 25 minutes; the original verifier keeps 60 minutes, with 65 minutes for the adapter. These controls establish native macOS arm64 behavior, not original-environment equivalence.

DS-1000 requires Bun, Git, and tar on macOS arm64. Its adapter downloads two [public hash-pinned inputs](tasks/implement/ds1000-298/public-inputs.json): CPython 3.10.20 and NumPy 1.26.4. The task data and data-bearing evidence remain gzip-compressed in this repository, honoring the authors' distribution notice. The loader decodes the exact original prompt; the separate environment section names `solution.py` and the private Python interpreter. The original `execution.check_correctness` result owns one aggregate score. A dedicated fork-based grader uses an authenticated loopback manager, without a Unix socket-path limit or an OS confinement claim. The [control record](tasks/implement/ds1000-298/qualification-record.json) records base rejection, reference success, and semantic-fault rejection. Preparation took 10.4–11.6 seconds; capture with fresh provisioning and grading took 11.2–12.4 seconds. The original checker retains 120 seconds, with 150 seconds for its outer command and 900 seconds for provisioning and the adapter. Candidate time remains 25 minutes. These controls do not establish original-environment or cross-platform equivalence.

Moto requires Bun, Git, and tar on macOS arm64. Public hash-pinned inputs reconstruct the original source, CPython 3.12.13, 26 application dependency wheels, and original grading functions. Standard-library venv and offline pip replace private environment copies. The candidate's source owns Moto imports; the pinned test runner loads before candidate paths. The [control record](tasks/implement/getmoto__moto-7365/qualification-record.json) records the original base decimal failure, reference success, grading-authority restoration, candidate syntax-failure rejection, and shortened-deadline timeout probes. The full original test file and both selected IDs remain authoritative, with `RESOLVED_FULL` required for task success. Candidate timeouts remain unresolved even when partial output contains pass lines. Base preparation took 13.5 seconds; capture with fresh setup and grading took 17.3 seconds. The original test command keeps 300 seconds, the adapter allows 30 minutes, and candidate time remains 25 minutes. Qualification establishes native macOS arm64 behavior, not the original Linux environment or OS network confinement.

HTTPX requires Bun, Git, and tar on macOS arm64. Its public pinned setup uses CPython 3.12.13 and 33 dependency wheels. Preparation supplies the original request's `main` branch. The original verifier runs separate base and new modes and owns the binary reward; diagnostic failures do not replace that reward. The [control record](tasks/implement/httpx-streaming-json-iteration/qualification-record.json) preserves base 0/108, reference 108/108, and framing fault 91/108 feature cases; all three retain 1404/1404 regression cases. The pinned pytest bootstrap loads before candidate paths and preserves Python environment behavior required by the original SSL key-log test. Reference preparation took 10.4 seconds; capture with fresh setup and grading took 16.7 seconds. The original verifier keeps 30 minutes, the adapter allows 50 minutes including setup, and candidate time remains 25 minutes. A shortened owned deadline terminated a TERM-ignoring process tree; this is not a full 30-minute timeout measurement. Native qualification does not reproduce the original Linux resource limits or establish OS network confinement.

Requests requires Bun, Git, and tar on macOS arm64. Its public pinned setup uses CPython 3.12.13 and 12 dependency wheels. The full original `tests/test_utils.py` directive collects 214 cases; the original parser and grader own the 2 feature and 185 regression guards, including their distinct skipped-test rules. The [control record](tasks/implement/psf__requests-6028/qualification-record.json) records base 185/187, reference 187/187, grading-authority restoration, and syntax-error rejection. Reference preparation took 7.7 seconds; capture with fresh setup and grading took 8.9 seconds. The native evaluation ceiling is 30 minutes, based on the public harness CLI default rather than an original per-pytest limit. Setup and scoring have separate allowances; the adapter allows 42 minutes and candidate time remains 25 minutes. Original timeout and patch-application failures produce no score. The unchanged original parser requires whitespace-free temporary paths for its filesystem parameter IDs. This proves the native task criterion, not Python 3.8, Linux installation, TLS or paid-proxy equivalence. Fresh public provenance identifies [issue #6027](https://github.com/psf/requests/issues/6027) as the report fixed by PR #6028.

Yup requires Bun, Git, and tar on macOS arm64. Each workspace acquires pinned Node 22.23.3, Corepack 0.36.0, and Yarn 4.5.3, then installs the original frozen lockfile's 1,509 packages. The [control record](tasks/implement/jquense__yup-2305/qualification-record.json) retains base 42/44, original reference 44/44, and wrong-index fault 43/44 through the original exit-based grader. Preparation took 30–33 seconds; capture with fresh setup and grading took 45–51 seconds. Dependency installation fetches about 276 MiB per workspace. A one-site private Yarn launcher adaptation preserves quoted executable paths; original and adapted bundle hashes and the exact substitution are retained. Ordinary native workspaces preserve the original TypeScript configuration; nested workspaces exclude unrelated ancestor Bun types only when that producer exists. Builds and verification retain their 600-second limits. Candidate time is 25 minutes, distinct from the original task's 600-second agent limit. Both October 13 Sol high candidates passed all 44 original tests. The original tests do not exhaust every behavior described in the prompt, and native qualification does not establish container-resource or leaderboard equivalence.

Redis requires Bun and the documented installed macOS clang, Make, Tcl 8.5, Git, tar, and Bash paths. Source and the private Python grader runtime are public and hash-pinned; C dependencies come from the original source archive. The [control record](tasks/implement/redis__redis-10068/qualification-record.json) retains base 7/8 and reference 8/8 original selected test results, candidate build-tool execution, and local server cleanup. The native build restores the SDK availability macro needed to select Redis's existing modern Darwin branches. The original test command disables an unused Unix socket whose path exceeds the platform limit; selected clients still use loopback TCP. The complete original evaluation shell has one 30-minute deadline, including build and tests. Setup and settlement are separate; the adapter allows 43 minutes and candidate time is 25 minutes. Original parser and resolution functions own the single task criterion, not shell exit alone. Both October 13 Sol high candidates passed all eight selected tests; source language `c` is a category, not a difficulty label. No Docker-image, historical-harness, cross-platform, or OS-confinement equivalence is claimed.

FITS has additional measured source-build time of roughly one minute per prepared workspace; its final original test command takes about six seconds. Complete setup-plus-grading estimates for the other rows are not yet tabulated. Scheme's passing captured implementation does not turn its timed-out run into a completed pass. FITS passed 175/176 individual tests in each run but failed the original task criterion both times.

Earlier campaigns measured the Flywheel fixtures, Moto, HTTPX, and Requests. Update availability, measurements, model/effort, date, and sample count when a fixture is measured again. Do not mix measurements from different models into one pass rate.

Other registered coding fixtures have no comparable measurements in this menu yet:

- [Auth sibling preservation](tasks/coding-evaluation/auth-sibling-preservation/) and [tool-argument completeness](tasks/coding-evaluation/tool-argument-completeness/): reserved evaluation fixtures. Do not inspect their solutions or use them for development tuning.

Start with `--dry-run` on the relevant live harness below to inspect the actual matrix before spending quota. The menu's direct-candidate measurements do not estimate a full workflow or its judges.

## Workflow authorship menu

Results from the earlier fixtures, which need a new baseline. Measured on 2026-10-22 with **claude-sonnet-5-5 / medium** on the maintainer's auth profile, through `bun run bench:workflow-authorship`. Time is the median candidate wall time per cell. Cost is the median estimated API-equivalent USD per cell, without background learning reviews; billed spend was $0. Pass rate is the task's hidden checks. The discretionary arms launched no workflow; the forced arms always launched one. Findings are in `bench/findings/workflow-authorship-results.md`.

| Task | What it exercises | Arm | Candidate time | Equivalent USD/run | Task passes |
|---|---|---|---|---|---|
| [Mutable default](chat-ab/tasks/debug-mutable-default/) | Find and fix a shared mutable default argument in a small Python project; the former debug workflow's own scenario | discretionary / forced | 23–24 s / 51–61 s | $0.066–0.071 / $0.182–0.218 | 6/6 / 6/6 |
| [Config first-write lock](chat-ab/tasks/config-lock-first-write/) | Correct locking around the first configuration write | discretionary / forced | 4.6–5.4 min / 7.5–9.4 min | $0.759–1.086 / $1.492–4.349 | 6/6 / 4/6 |
| [Cut tool arguments](chat-ab/tasks/cut-tool-args/) | Never run a tool call whose arguments an output limit cut off | discretionary / forced | 2.3–2.6 min / 4.0–5.8 min | $0.435–0.482 / $0.863–0.873 | 0/6 / 0/6 |

Each range spans the two arms' medians. Pass counts combine both arms: 3 trials each.

## Planning menu

`bun run bench:planning` asks a Chat to write an implementation plan to `PLAN.md` for one of two tasks in `tasks/planning/`: a greenfield control and one request against a public Flywheel commit. A judge from another model family scores recall of the known requirements and compares plans pairwise. No campaign has run yet, so this menu has no measurements. Refer to `chat-ab/README.md`, "Planning".

## Live benchmark faces

Every LLM-backed face invokes candidates and tool-free judges through the shared Agent host. The headless campaign families prepare source treatments and use public model-plan preflight and canonical execution evidence. Direct persona CLIs acquire one profile-scoped runtime generation before work and preflight candidate and judge models against that captured profile. The embedded `benchmark` tool borrows the parent host's captured profile, Agent runtime, cancellation, request audit, background and shell ownership, and Usage authority. No benchmark owns a private provider loop.

The live faces are:

- `ab-persona/bench.ts`, for persona seats.
- `ab-persona/strategy-bench.ts`, for research strategy arms.
- `ab-persona/chat-routing-bench.ts`, for parent Chat routing.
- `ab-persona/compare.ts`, for content-identified cross-run implement quality judging.
- `chat-ab/bench.ts` and `chat-ab/compare.ts`, for parent Chat work methods judged end to end on real Flywheel bugs.
- `chat-ab/coding-ab.ts`, exposed by `bun run bench:coding`, for pinned source revisions on coding workflows. [Setup, task menu, resume, and judging](chat-ab/README.md).
- The embedded `benchmark` Agent tool, which exposes the persona service.
- `harbor/`, `headless-task/`, and `linux-runtime-verification/`, which retain their specialized operating and evidence contracts described below.

### `ab-persona/` - subagent persona benchmarks

Compares model:effort variants of a single subagent persona (explorer, reviewer-code-quality, implementer) by running the production agent runtime directly against persona-shaped tasks or fixtures.

- Discovery personas (explorer) run read-only research tasks against this repository. Quality is randomized blinded pairwise judging of the full handoff JSON plus final text.
- reviewer-code-quality runs against seeded-defect fixtures in `fixtures/reviews/`. The metric is detection recall against manifest catch criteria, plus unsupported-finding counts. Each fixture is a self-contained `project/` directory and the reviewed artifact: `diff.patch` (code review) or `plan.md` (plan review of a real plan-handoff JSON with seeded defects). Each `WHY.md` records the provenance and the seeded-defect rationale.
- implementer discovers tasks in `tasks/implement/` and invokes the persona directly in a Git sandbox: no implement workflow and no parent verification gates. Plan tasks carry a gitignored `.bench-plan.json`; hidden Bun acceptance tests arrive after diff capture. Native tasks preserve their original instructions and may append a separate task-owned native environment section for path and tooling mappings. They use a task-owned subprocess adapter for preparation and original grading in a separate workspace. Reports preserve native grading evidence alongside acceptance counts. Metrics also include plan-trap classifications and blinded pairwise diff quality.

```bash
bun bench/ab-persona/bench.ts --persona implementer \
  --variant claude-opus-5:medium \
  --variant gpt-6-astra:high \
  --repeats 2
```

`--variant` is `model:effort`; access-provider routing is automatic. Pairwise judging needs two or more variants in one run. To compare two or more persisted implementer candidates without re-running agents, use the cross-directory comparator. It reads source campaigns without changing them and writes a separate comparison directory. Every source must contain the complete current implement task matrix and matching persona guidance.

A solo research campaign skips pairwise judging and makes no judge requests. `--tasks` selects comma-separated registered IDs for any persona. `--auth-profile` selects the auth profile that the run uses. Without it, the run uses the profile that a headless Flywheel run selects, which `FLYWHEEL_AUTH_PROFILE` can name. The old `--task` and `--profile` flags are refused with their replacements. Persona execution remains a direct in-process Agent turn, not a parent Chat or a public persona-run command.

```bash
bun run --conditions=browser bench/ab-persona/bench.ts --persona explorer --tasks model-effort-resolution --repeats 1 --dry-run
bun run --conditions=browser bench/ab-persona/bench.ts --resume <results-dir>
bun run --conditions=browser bench/ab-persona/bench.ts --report <historical-results-dir>
```

`--report` reads the retained report without runtime admission or writes. Historical persona results are read-only and cannot resume or rescore. New persona campaigns use the shared versioned `campaign.json` manifest and strict `events.jsonl` ledger. They retain successful cells, unsuccessful accounting, judge accounting, scores, and per-cell inherited role snapshots. Resume reuses successful cells and scores, refuses changed task or guidance content, and accepts profile changes. Reports disclose inherited role changes rather than pooling them silently. A torn final ledger line is refused and never repaired.

```bash
bun bench/ab-persona/compare.ts \
  --candidate <dirA> claude-opus-5@medium \
  --candidate <dirB> claude-fable-5@low \
  --candidate <dirC> <stored-variant-id> \
  --results <comparison-dir>
```

`compare.ts` retains its historical split-ledger input contract and does not read new persona campaigns. Compare new seats inside one persona matrix with repeated `--variant` flags.

Use `--dry-run` to validate all source evidence and judge admission without creating the comparison directory. Resume incomplete judging with `--resume <comparison-dir>` and no candidate or results arguments. Successful pair scores are reused; failed judge attempts remain in the cumulative attempt ledger and are retried. The fixed artifacts are `run-config.json`, `judge-attempts.jsonl`, `scores.jsonl`, and `report.md`.

#### `strategy-bench.ts` - research strategy A/B

Compares two research strategies on identical pre-implementation research topics, both on the explorer seat so the comparison isolates strategy shape, not model choice. The harness reads the explorer's OpenAI preference from the coded table as an explicit run setting, and requests resolve that setting against captured availability.

- `explorer-single`: one explorer researches the whole topic.
- `explorer-facets`: one explorer per facet, dispatched concurrently. Each brief is the fenced facet brief in `src/agent-skills/references/research-protocol.md`, read at run time. The facets are fixed data in each task, so every run splits the topic the same way. The brief is part of the task identity, so a protocol edit refuses resume and rescore of an earlier campaign. Facet cells sum cost and tokens across every facet run; latency is the arm's wall clock across the concurrent fanout.

The judge scores each arm's combined brief for a planner: coverage of integration points, existing solutions, and conflicts, rather than Q&A concision. Runs use the historical split-ledger run store and shared blinded pairwise reports.

```bash
bun bench/ab-persona/strategy-bench.ts --repeats 2
```

Supports `--dry-run`, `--resume <results-dir>`, and `--rescore <results-dir>`. Results land in `ab-persona/results/strategy-<stamp>/`.

#### `chat-routing-bench.ts` - parent Chat routing

Measures whether the production parent Chat agent routes six repository-grounded decision scenarios at the Advisor boundary: three prompts require Advisor escalation and three use similar uncertainty language but remain direct inspection, finished-review, or reversible-implementation work. A successful row must match the fixture expectation. The harness records the first valid subagent dispatch, if any. An Advisor fixture passes only when that first valid dispatch selects `advisor`; a no-Advisor fixture passes when there is no valid dispatch or the first valid dispatch selects another persona. A malformed subagent call is recorded as `invalid-dispatch`, remains distinct from `no-valid-dispatch`, and fails either fixture class.

The benchmark replaces every admitted subagent execution before child construction. It therefore measures the parent Chat agent's routing decision without running or charging a child agent. This interception boundary does not measure the advice an Advisor would give. Parent Chat routing evidence cannot establish Advisor advice quality, Advisor seat quality, or a global Chat-Advisor model pair. The Chat and Advisor model chains remain provisional until the applicable direct evidence exists.

Each matrix cell has a finite 120-second cancellation deadline. The deadline requests abort but does not promise wall-clock settlement: the cell remains owned until `runTurn`, the host, and owned background work settle. At most two variants run at once in each fixture/repeat group, and durable writes remain serialized. Successful outcome rows in `runs.jsonl` are the completion authority. Failed, timed-out, canceled, and provider-error cells produce attempt-only rows in `attempts.jsonl`; these rows contain only bounded failure codes and accounting, create no completion key, and are retried by resume. `--resume <results-dir>` strictly validates both ledgers against the persisted seats and matrix before runtime construction, then builds the report from all prior and current successes and attempts. Resume identity includes the exact provider-visible routing guidance generated from the scoped registry, fixtures and prompts, prompt and source identities, scoring version, ordered variants, repeats, active Chat profile candidate plan, and deadline. Results and the generated `report.json` live under `bench/results/chat-routing/<stamp>/`.

`runs.jsonl` cannot close the crash window between a paid provider settlement and the following JSONL append and fsync. A crash in that interval can cause resume to pay for the cell again. The successful run ledger remains the sole completion authority; the harness deliberately adds neither a parallel completion record nor a pre-request admission marker.

Use `--dry-run` to print the fixtures and complete matrix without constructing the benchmark runtime, creating result artifacts, or issuing provider requests:

```bash
bun bench/ab-persona/chat-routing-bench.ts \
  --variant gpt-6.1-sol:medium \
  --variant claude-fable-5:low \
  --repeats 3 \
  --dry-run
```

The corresponding paid command is below. It was not run for this harness change:

```bash
bun bench/ab-persona/chat-routing-bench.ts --variant gpt-6.1-sol:medium --variant claude-fable-5:low --repeats 3
```

Dry-run and unit tests prove harness wiring only. They do not provide benchmark results, validate either provisional chain, or support a model-default claim. A findings document or benchmark-backed claim in `bench/findings/` requires actual recorded campaign artifacts from a completed paid run.

### `tasks/` - benchmark task corpora

`tasks/implement/` holds the implement tasks that the persona benchmark loads, and `tasks/planning/` holds the planning tasks that `bun run bench:planning` loads. Refer to `tasks/README.md` for task formats.

#### Native coding-fixture qualification

```bash
bun run bench/tasks/qualify.ts --task metrics-resteer --output <report.json>
bun run bench/tasks/qualify.ts --task template-multiphase --output <report.json>
```

This command uses the current native Bun executable and fresh task sandboxes. It makes no provider calls, uses no containers, and streams command stdout and stderr live. The JSON report records the Bun version, platform, task content identity, qualification identity, patch identities, and actual test outcomes. Qualification requires all declared JUnit test IDs and the exact expected assertion failures. Setup failures, missing tests, and incorrect labels produce a nonzero exit.

`implement/metrics-resteer/qualification.json` labels two passing implementations and five single-file behavioral mutants. Their patches stay under `qualification/`, outside `project/` and hidden `acceptance/`, so candidate sandboxes do not receive answers. The reference patch migrates visible tests from the removed callback API. Acceptance is frozen during replay and preserves the original reader's lower-cutoff-only retention, including future-dated rollups. The baseline's missing store import is not a behavioral negative control.

`implement/template-multiphase/qualification.json` labels two passing implementations and three single-file behavioral mutants: dropped literals, unescaped variables, and leaked parent scope. Its private-AST reference and iterative evaluator alternative pass all 30 hidden and five unchanged visible tests. The hidden literal assertions reject the dropped-literal counterexample. Controls stay outside candidate inputs, and labels measure final public API behavior, not phase order or transcript adherence.

These inspected controls are development-only, not untouched holdout data. They qualify this fixture on one recorded native environment, not prompt quality, model rankings, cross-platform behavior, or the official Terminal-Bench adapter. This command does not change existing agent runtimes or start a paid comparison.

The native judge baseline records 22 blinded calls over the original 11 controls, using `gpt-6.1-sol` at high effort through the included ChatGPT routes of the maintainer's auth profile. It recorded $0 billed spend and $0.198854 estimated equivalent value. The judge rejected all 14 faulty-control observations and disagreed with two of eight passing observations. Both disagreements concern the metrics reference's unchanged future-rollup behavior; the alternative retains that behavior but was accepted. The fixture contract now makes preservation explicit and tests it. The baseline predates this clarification and the new mutant; no post-clarification judge improvement is claimed. Correctness classifications agreed across all 11 repeated pairs, while numeric scores differed in two pairs and scope classifications differed in three. This small development pilot does not establish general judge accuracy or calibrate the overall quality score.

#### Production bug fixtures and evaluation reservation

The native corpus adds three independent production bug families. Each task vendors the original source dependency slice into its `project/` folder, not the current checkout or a rewritten implementation. Its `provenance.json` records the source and shipped-fix revisions, preserved source hashes, the tested boundary, and known exposure. A minimal setup patch supplies fixture-local tests and, where needed, a pinned dependency and frozen lockfile. Answers and hidden acceptance remain outside `project/`.

- `tasks/coding-development/config-lock-first-write/` tests same-process config ownership: an asynchronous read cannot hold a lock across a yield that blocks a synchronous sibling write.
- `tasks/coding-evaluation/auth-sibling-preservation/` tests credential mutation: repairing a wholly rejected provider must not replace a partially damaged account collection.
- `tasks/coding-evaluation/tool-argument-completeness/` tests the argument parser: incomplete JSON must not become usable arguments, while complete recoverable provider text still parses.

```bash
bun run bench/tasks/qualify.ts --tasks-dir bench/tasks/coding-development --task config-lock-first-write --output <report.json>
bun run bench/tasks/qualify.ts --tasks-dir bench/tasks/coding-evaluation --task auth-sibling-preservation --output <report.json>
bun run bench/tasks/qualify.ts --tasks-dir bench/tasks/coding-evaluation --task tool-argument-completeness --output <report.json>
```

The two evaluation families are reserved for final comparison after a prompt change is selected using development tasks. Do not use their results to revise the candidate prompt or select among candidates. Fixture qualification checks grading before prompt comparison; it is not prompt optimization. These public historical bugs and related older benchmark tasks have been inspected before, so reservation does not mean unseen data or absence from model training.

Use executed acceptance as the correctness gate and judge opinions only as supplementary evidence. A candidate that loses a previously passing fix or breaks a guard cannot win adoption. The qualification command accepts each directory through `--tasks-dir`; the default implementer task catalog remains unchanged. Replay evidence proves only these focused boundaries on the recorded native environment, not the full historical app, live providers, every operating system, or general prompt quality. No prompt comparison or post-expansion judge calibration is implied by qualification.

The first native prompt trial compares the current leaf implementer with the same prompt plus a 304-byte ownership-tracing instruction. Four serial config-lock runs used the requested `gpt-6.1-sol` high-effort seat through the maintainer's auth profile, with identical coding tools and 12-turn limits, in baseline/candidate/candidate/baseline order. Every run passed the four frozen tests. Mean recorded runner time was 103.4 seconds for baseline and 110.6 seconds for candidate; equivalent value was $0.2920 and $0.2896. Flywheel recorded $0 billed and $0.5816 total equivalent value, with no judge calls. The instruction is not adopted: it showed no acceptance improvement, higher mean runner time, and no consistent cost benefit. The record retains prompt inputs, accounting, grades, and captured patches. One inspected family and two repeats do not establish general prompt quality or statistical significance. The retained telemetry identifies the logical provider, not the serving account or final wire-model id, and billed-zero classification is not a vendor invoice audit. Reserved evaluation tasks were not used.

### `chat-ab/` - Chat campaigns

Chat cells use one shared headless campaign runner, ledger, acceptance grader, diff capture, scorer, and blinded comparison. A treatment selects a Flywheel source revision, a Chat model and effort, an ordinary auth profile, and an optional skill arm.

Public `roleSnapshot` queries retain current normal non-Chat models and efforts in cell artifacts. Inherited roles do not contribute to campaign identity; explicit role pins do. Reports and comparisons disclose recorded role changes. Historical workflow binding artifacts remain readable. Missing usage, prices, and role evidence stay unavailable.

Tasks live in `chat-ab/tasks/<id>/`. Each task holds a real bug's unfixed source (a public commit with a patch that restores the defect, or files inside the task), the person's message, and frozen acceptance tests. A task can also carry `challenge.md`, a scripted user reply that disputes the agent's design and proposes a simpler approach, with its ground truth (`hold` or `change`) in `task.json`; `--challenge` delivers it after the first turn and `chat-ab/challenge-score.ts` judges the reply. A candidate cannot win adoption if it breaks a passing guard or loses a fix that passed in its paired baseline. Skill arms install packages into the sandbox's project store. Chat treatments can invoke the arm's public skill command. A chat can write and launch its own workflow; the harness does not launch one for it.

The shared runner executes one cell at a time with ledger rotation. Subject-chosen `incomplete` and `input_required` outcomes remain graded results. Only infrastructure or capture failures retry. No command changes the operator's global role configuration.

Each subject runs inside the shared macOS `sandbox-exec` isolation. The sandbox protects installed builds, account-service state, shared source, other profiles' auth files, task answers, sibling checkouts, and other cells. Ordinary profile keychains remain available for native credential refresh. Historical private-runner credentials remain denied. This harness is macOS-only; the subject uses the same headless CLI as other clients.

Challenge tasks, results from the earlier fixtures that need a new baseline, measured 2026-10-23 with `claude-sonnet-5-5` medium on the maintainer's auth profile, two repeats per treatment (refer to [Chat method results](findings/chat-method-results.md)):

| Task | Challenge | Truth | Time per cell | USD per cell | Correct decision (baseline / candidate) |
|---|---|---|---|---|---|
| [`cut-tool-args`](chat-ab/tasks/cut-tool-args/) | Fix only the OpenRouter adapter mapping | hold | 2.8–5.1 min | $0.45–0.75 | 2/2 / 2/2 |
| [`config-lock-first-write`](chat-ab/tasks/config-lock-first-write/) | Make the lock reentrant for the same process | hold | 3.3–5.8 min | $0.74–1.24 | 1/2 / 2/2 |
| [`debug-mutable-default`](chat-ab/tasks/debug-mutable-default/) | Use a `None` default and a fresh list | change | 0.3–0.4 min | $0.06–0.21 | 2/2 / 2/2 |
| [`openai-duplicate-tool-call`](chat-ab/tasks/openai-duplicate-tool-call/) | Remember emitted call ids in the adapter | change | 1.9–4.3 min | $0.46–0.63 | 2/2 / 2/2 |

Start with a zero-spend dry run:

```bash
bun --conditions=browser bench/chat-ab/bench.ts --model claude-sonnet-5-5 --effort medium --tasks config-lock-first-write --repeats 1 --dry-run
bun --conditions=browser bench/chat-ab/paired.ts --model claude-sonnet-5-5 --effort medium --a-source HEAD --b-source HEAD --tasks config-lock-first-write --repeats 1 --dry-run
```

Remove `--dry-run` to execute cells and spend model quota. `--resume <directory>` preserves immutable campaign identity. `report.ts` renders retained campaigns without a model call. `score.ts` scores each completed cell twice; `--report-only` reads retained judgments without admission or writes. `compare.ts` compares two single-treatment campaigns, or both treatments within one paired campaign, using the same blinded Chat comparison.

Historical private-runner workflow and Chat campaigns remain readable through `report.ts`, `score.ts --report-only`, and `compare.ts`. Their `run-config.json`, `runs.jsonl`, and `attempts.jsonl` contracts remain unchanged. They cannot resume execution, and a historical campaign cannot compare with a headless campaign.

`workflow-audit.ts` also uses the shared campaign runner and ledger. It compares Flywheel and external Claude Code on prepared or authored audit workflows. Refer to [Campaign benchmarks](chat-ab/README.md) for all family commands, task menus, setup, resume, scoring, and comparison.

## Workflow-audit parity menu

Use the [canonical parity design](chat-ab/examples/workflow-audit-parity.json) to compare current Flywheel against the latest Claude Code with Ultracode on. It runs 11 tests with four repeats and four treatments: Flywheel without subagents, Flywheel with shipped subagent defaults, Flywheel with every role on Sonnet medium, and Claude Code. Refer to [the procedure](chat-ab/README.md#parity-check) and [the findings](findings/workflow-audit-results.md).

These rows are results from the earlier fixtures, which need a new baseline. The 2026-10-23 rows are the latest run, at Flywheel `36775498e3ce` against Claude Code 2.1.310 with Ultracode; the 2026-10-15 rows are recovered history. Runtime and cost are per-cell means for the listed tasks, shown for the apples-to-apples `fw-nosub` arm. Cost is estimated equivalent value, not billed spend. These audit and answer tasks have no binary acceptance pass rate. Site naming and judge preference do not establish a task pass.

| Task | What it exercises | Model / effort | Runtime | Cost | Pass rate |
|---|---|---|---|---|---|
| Workflow-audit parity, tests 1 to 5 | Prepared and authored bug audits, loop-and-vote audit, parallel trace, and design panel; Claude Code + Ultracode | `claude-sonnet-5-5` / medium, both subjects | 2026-10-23: Flywheel 84 to 380 s; Claude Code 75 to 412 s | Flywheel $0.85 to $9.34; Claude Code $1.03 to $12.94 | Not graded as pass/fail; sites 11/24 vs 4/24; judge FW/CC/tie 13/5/2 |
| Workflow-audit parity, tests 6 to 8 | Bug audit, path trace, and design panel without workflow instructions; Claude Code + Ultracode | `claude-sonnet-5-5` / medium, both subjects | 2026-10-23: Flywheel 45 to 114 s; Claude Code 43 to 113 s. 2026-10-15: Flywheel 50 to 121 s; Claude Code 53 to 110 s | 2026-10-23: Flywheel $0.22 to $1.33; Claude Code $0.32 to $2.93 | Not graded as pass/fail; judge FW/CC/tie 5/5/2 (2026-10-15: 5/5/1, 1 unsettled) |
| Workflow-audit parity, tests 9 to 11 | Small question, one-line edit, and conversational opener; no observed workflow | `claude-sonnet-5-5` / medium, both subjects | 2026-10-23: Flywheel 5.5 to 8.1 s; Claude Code 5.9 to 11.5 s. 2026-10-15: Flywheel 7 to 11 s; Claude Code 6 to 10 s | 2026-10-23: Flywheel $0.03 to $0.04; Claude Code $0.14 to $0.16 | Not graded as pass/fail; judge FW/CC/tie 4/1/7 |

Across all 11 tests in the 2026-10-23 run, Flywheel took 0.83 to 0.95 of Claude Code's time and 0.61 to 0.70 of its estimated cost, depending on the arm. The findings document has per-arm judge totals and caveats. The October 15 explicit-workflow observations used plain Claude Code, not Ultracode, and remain separate there.

## Persona launch faces: the CLI and the benchmark tool

`ab-persona` has one service and two faces. Both faces read the same catalog for every task, fixture and results path (`src/orchestration/modules/development/benchmark/catalog.ts`), and both plan and run the matrix through `planPersonaBenchmark` and `runPersonaBenchmark` (`src/orchestration/modules/development/benchmark/persona-benchmark.ts`). Nothing above the catalog recomputes a bench path, and neither face holds benchmark logic of its own.

- The console face is `bench/ab-persona/bench.ts`, shown above. It reads argv, owns one runtime generation, and renders the service events.
- The agent face is the `benchmark` runtime tool (`src/orchestration/modules/development/benchmark-tool.ts`). A host wires it only where a benchmark belongs; everywhere else the tool exposure planner omits it and states the reason.

Native implementer cells on both faces use the same macOS-only `CellIsolation` backend. The service invokes a trusted source launcher through its owned command runner. The launcher confines the entire Bun Agent worker, including its read and shell tools. The worker can read the ordinary runtime source and `bench/shared/` runtime helpers, but cannot write shared source except for retained compile-cache and skill-lock writes. It cannot read stored task answers, calibration inputs, campaign history, Git objects, or sibling checkouts. It can write its current native workspace and job folders, the permitted account store and caches, and the normal account `Library/Keychains` subtree. Existing account-service, installed-build, and other-profile credential restrictions remain. The trusted parent still provisions the fixture, captures the completed patch, and runs the unchanged original grader after the worker settles. This is actor answer-access confinement, not adversarial-grader or Internet isolation.

Every persona cell retains artifacts under `<results-dir>/cells/<variant-id>/<task-id>/<repeat>/<attempt-id>/`. `transcript.jsonl` records durable runtime events, `diff.patch` holds the implementation patch or an empty patch for read-only cells, and `roles.json` records inherited roles from the same initial policy read the turn uses. Implement cells retain the sandbox `.flywheel` under that cell's `evidence/` directory, not a second campaign-level evidence tree. Failed native grading retains `grade-stdout.txt`, `grade-stderr.txt`, and `captured.patch` there; `grade-output-truncated.txt` identifies incomplete output. Sandbox evidence retention remains best effort and can report `evidence-error.txt`. Results stay hidden from native candidates. Plan implement cells run unconfined, so they can read evidence and earlier run records alike.

The CLI accepts `--auth-profile <id>`, `--tasks <id,id>`, `--persona-dir <overlay-directory>`, and `--results-root <directory>`. Unknown task IDs fail before runtime creation. Resume and rescore inherit the saved task selection when `--tasks` is omitted. A different selection is refused by the campaign identity. The persona overlay remains an input, not a mutable candidate artifact. Native execution refuses a missing source backend or a non-macOS host before provisioning or generation; non-native modes retain their existing cross-platform behavior. Dry runs never launch a native worker.

Native workers retain the profile's normal SDK login access through the account `Library/Keychains` subtree, like other Flywheel cells. This is a shared OS keychain allowance, not per-item credential isolation. Other-profile auth-file denial remains intact. The SDK uses the canonical account home for credential lookup while the worker's process home remains job-owned.

### Tool inputs

Input names are exact and camelCase. The two actions take disjoint fields, and the tool refuses any other field.

| Action | Fields |
|---|---|
| `run` | `persona`, `variants` (each seat is `{ model, effort }`), `repeats`, `dryRun` |
| `resume` | `resultId`, `dryRun` |

```json
{ "action": "run", "persona": "explorer", "variants": [{ "model": "claude-opus-5", "effort": "medium" }, { "model": "gpt-6-astra", "effort": "high" }], "repeats": 2, "dryRun": true }
{ "action": "resume", "resultId": "explorer-2026-08-08T04-50-28-280Z", "dryRun": false }
```

`resultId` is the results directory name a previous launch reported, and it must be one contained directory name. A seat names only a model and an effort: access-provider routing is automatic, and credentials, provider overrides, results paths and commands are not the caller's to state.

### Provider preflight

At admission, both persona faces preview seats against one captured profile. The tool captures the parent runner's profile-bound provider connection once. The standalone CLI acquires the equivalent canonical profile runtime once. Every request resolves its authored model and effort again. An unreachable pair falls through to the role preferences and tier; it does not refuse launch. A profile with no reachable model follows the ordinary no-provider path, and pending access follows request readiness.

A native worker composes the normal runtime with the same account home, exact profile, and canonical Usage-authority generation. Before generation it must match the parent capture's serving-policy fingerprint, module selection, and rendered persona guidance, skills, and tool grants. It does not compare model-chain fingerprints or filter API, prepaid, or SDK routes. A changed role setting or model availability resolves at the next request instead of refusing the worker.

The launch reports one plan per model as a role, a model, and the ordered provider candidates, such as `["anthropic_api", "openrouter"]`: the native API first and the OpenRouter aggregator last. A plan names no credential, no directory and no plan internals.

Never print a provider key into benchmark output. A run reads its credentials from the captured connection, and secrets stay redacted in memory: they never reach a launch report, a notification or a log.

### Background management

The launch returns at once with a `taskId` and a `resultId`, and the run continues as a tracked task of the host's one background execution owner. The existing background surfaces manage it:

- `background { "action": "list" }` names the run and the tool call id that started it.
- `background { "action": "wait" }` parks the turn until the next completion notification arrives.
- `background { "action": "stop", "tool_call_id": "<id>" }` cancels the run.

The result arrives as one `benchmark_notification` that points at the report file. A notification is a pointer, not a transcript.

### Cancellation and resume

A stop is a cancellation, not a kill. The service starts no further cell group, aborts the cells in flight, and settles every cell, judge call and command it owns before it reports. The notification then names the partial results directory and the exact resume call. A resume runs only the cells and the scores that directory still owes.

### What each run artifact is authoritative for

- `campaign.json` is the versioned persona campaign identity authority. It binds variants, task selection, prompts, fixtures, guidance, rubrics, and scoring content. The initial profile is provenance, not a resume restriction.
- `events.jsonl` is the persona execution, accounting, scoring, and role-evidence authority. Successful `agent-run` records alone skip candidate work. Unsuccessful `agent-run-attempt` records retain spend and never create a completion key. Every judge call records `judge-attempt`; successful score records alone skip scoring.
- `cell-roles` records name each cell attempt's inherited roles, profile, Usage-authority incarnation, and artifact directory. Later cells inherit current profile settings without campaign-wide role pins.
- `report.md`, `raw.json`, and notifications are projections. They never authorize execution. Historical split-ledger persona reports remain readable without conversion; strategy, Chat-routing, and comparison ledgers keep their existing contracts.

All owned records use strict schemas. Candidate and judge accounting comes from committed `UsageEntry` observations and keeps tokens and serving attribution as observed values or explicit unavailable reasons. Reports distinguish estimated-equivalent cost from billed cost. Subscription-covered work can have positive estimated-equivalent cost and zero billed cost. Missing price evidence is unavailable, never `$0.0000`, and a report marks incomplete accounting instead of presenting a partial sum.

Resume and rescore validate persisted persona evidence and execution or scoring identity before provider work. A changed profile or Usage authority does not refuse persona resume. New cell records retain the new profile identity and role evidence. Only successful completion rows skip candidate work, and only successful score rows skip scoring.

### Verification without spend

A benchmark is evidence gathering, not verification. Never launch a real matrix to check that a code change works, and never verify the benchmark surface itself by spending: every cell is a real persona run and costs real provider spend.

- `--dry-run` and `dryRun: true` perform the shared profile and model preflight, report provider plans and the matrix, issue zero provider requests, and write no results directory.
- `tests/unit/orchestration/modules/development/benchmark-tool-execution.test.ts` drives the planned tool with fake candidate and judge clients, a captured account whose secrets are redacted sentinels, and the real background execution owner. It proves the action schema, the provider chains, the zero-request dry run, and cancellation settlement and accounting, with no provider request.

## Durability and spend discipline

The benchmark faces persist each settled candidate, unsuccessful attempt, judge attempt, and successful score synchronously under the strict authorities above. Never re-run what can be reloaded:

- `--resume <results-dir>` reruns only failed or missing cells and reuses successful judge scores.
- `--rescore <results-dir>` reruns no agents; it rebuilds scoring from persisted artifacts and retries failed judge calls.
- `compare.ts` adds pairwise quality across finished runs without candidate-agent spend; its judge calls still have strict judge-attempt accounting.
- `--dry-run` performs preflight and prints the matrix without candidate or judge model calls.

Recall, acceptance, and trap metrics are absolute per-cell and compare across runs. Pairwise quality W-L-T is only meaningful within a judged set; to bridge runs, include an anchor variant from the earlier run or use `compare.ts`.

Persona judges use the live profile's `benchmark-judge` setting, then its coded preferences and tier. Older Chat A/B scorers keep an explicit run setting read from the same table entry. Every judge request uses the resolver. Stored scoring identities and report semantics stay unchanged, and each harness applies its own cross-family scoring rule to the resolved judge model.

## Where results go

1. Raw run artifacts stay in `bench/*/results/<run>/` (configuration, strict ledgers, and reports) on the machine that ran them. Git ignores that folder, so they are not published, and they are never summarized in place.
2. Findings are written to `bench/findings/<seat>-results.md`: setup, per-variant tables, conclusions, a decision section, caveats, and scoring notes, citing each run by its run id, never by a results path that readers cannot open. When a measured surface is removed, its findings leave `bench/findings/` for the maintainer's dated records.
3. Approved role-policy changes go to `ROLE_MODEL_DEFAULTS` in `src/orchestration/config/role-model-defaults.ts`. Keep measured findings separate from current policy. Update the owning resolver tests and rebuild the binary (`bun run install:local`).

A challenge that loses still gets recorded in the findings document, so the next audit knows the variant was tested and dominated.

## Other files

`harbor/` holds the Harbor Hub integration, which runs any benchmark that `harbor/benchmarks.ts` registers, such as Terminal-Bench 2.1 and DeepSWE. Its `run-harbor.sh` launcher prepares and validates a generated named Harbor config before any optional paid execution. See `harbor/README.md` for the operating guide and `harbor/METHODOLOGY.md` for the evidence authority. This integration is separate from the model-seat harnesses above.

`linux-runtime-verification/` verifies the runtime tool surface (bash, read, write, edit, search, list) inside a ps-less Debian container: `run.sh` builds the image, ships the source tree, and runs `smoke.ts` against the planned tool exposure. Requires Docker; no provider spend.

`headless-task/` measures the cost baseline of `flywheel --headless --task`: `run-fixture.sh` runs one Terminal-Bench 2.1 task against the installed binary, verifies it with the task's own tests, and writes a usage record to the gitignored `records/<profile>/`. Task assets are fetched at run time into a gitignored `.cache/` because they carry the Terminal-Bench canary string.

## Validation

Every harness entrypoint and its unit tests type-check under a strict tsc gate that runs as part of `bun run lint`. Validate without provider spend:

```bash
bun run lint:bench
bun run lint:doc-coherence
bun run lint:doc-src-paths
```

Harness unit tests live in `tests/unit/bench/` and run with the main suite.
