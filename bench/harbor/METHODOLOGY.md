# Harbor Hub hill-climb methodology

This document is the authority for interpreting Flywheel runs on any benchmark that `bench/harbor/benchmarks.ts` registers. It states the measurement method that is the same on each benchmark: configuration admission and grades, trial evidence, outcome classification, round scoring, projection, and comparison with the board. Then it gives the entry of each benchmark: its splits, its exclusions, and what is special about its grader. It does not define leaderboard submission mechanics. [README.md](README.md) is the operating guide.

## The method

A hill-climb measures one arm, a Flywheel config, on fixed task splits of one benchmark or on the whole benchmark, and changes Flywheel between rounds. Each benchmark has one descriptor, and the launcher, the ledger, and the analysis read the facts of a benchmark only from it, from the pinned dataset, or from the board's data.

1. The board's data is fetched to a local cache, and the port of the board's scoring must reproduce every published cell of the benchmark before any score uses it.
2. Splits are chosen once per benchmark from the board's per-task results. The `subset` split projects to the full benchmark; holdout splits check that a change that helps the subset also helps tasks that it did not select. The analysis proposes splits, and the person picks them. A run can also take the whole benchmark: every task of the pinned dataset except the descriptor's exclusions, which is the reserved split `all`.
3. A round runs each split, or the whole benchmark, at the board's job settings, reruns the trials that infrastructure or a lost grader left unscored, reviews the passing trials that reached a published copy of the benchmark, and scores every scored attempt with the board's rules.
4. The subset score projects to the full benchmark through a fit over the board's own units. A round of the whole benchmark needs no projection. The round is compared task by task with each harness of the board's field at the same model and effort.

## Effective configuration and grades

All runs start through `bench/harbor/run-harbor.sh`. The launcher resolves the command line (benchmark, arm, task selection, attempts, and job settings) into one run, builds and publishes the run's agent package, writes `generated.json`, and validates that config with Harbor's own config model before execution. Every trial, in local Docker or on Harbor Hub, runs Harbor's `acp` agent on that package, so one execution path produces the evidence below; only the place where the trial runs is different. The serving-model resolver selects the interaction profile for every model, and every profile exposes the native `bash` tool. Request audits that earlier builds wrote can name the retired `luna-shell-v1` and `luna-native-v1` profiles, and historical audit readers still decode them without changing the recorded bytes.

The launcher derives the expected interaction profile and shell tool from the host checkout, and the package is built from HEAD of that checkout, so both come from one commit. No flag or arm selects an interaction profile. `run_manifest.json` records the exact Harbor command, the resolved interaction-profile ID, the run's `profile_sha256`, and the runtime source identity. `profile_sha256` is the digest of everything that states the run: the benchmark and its dataset, the arm path and digest, the tasks, the attempts, the concurrency, the timeout multipliers, and the resource overrides. Each trial also records the effective profile through request audit and the exact source archive digest. A profile digest, a source commit, or an archive digest alone is not proof of the other identities.

Every run names a checked-in Flywheel config with `--arm`, and the agent package ships it. The launcher validates it on the host with Flywheel's own config schema before any trial, also in a dry run, and refuses the run on any decode error or warning, so a trial never runs on a config that Flywheel would ignore in part. The config pins the chat model and effort in `[profiles.benchmark.roles.chat]` and is their only source, and the trial runs under the neutral auth profile id `benchmark` with no model environment override. The config is also the only source of the trial's tools: an arm turns a tool off by disabling the module that contributes it in `disabled_modules`. `run_manifest.json` and `preparation-plan.json` record the config path, SHA-256 digest, and chat effort. The package builder refuses a commit whose config bytes do not match that digest. A paired comparison reports both arms' config digests; unequal digests mean the arms ran different configs.

Every trial runs `flywheel --headless --acp --unattended --allow-persistent-processes`. `--unattended` is a general ACP mode (PI-AGENT-121). It omits built-in chat review, publication, and communication guidance, and the skill tool, its catalog, and ask_user. The run returns its final reply after owned work settles. The trial passes `--allow-persistent-processes`, and the checked-in arm configs also set `allow_persistent_processes = true`. Many tasks require a server that is still running when the verifier starts, and only a command launched with `persist_after_exit` outlives Flywheel's exit. A server that the agent starts without asking it to persist does not keep the run open: the prompt is answered when the agent's turn ends, and the server ends when Flywheel exits. A task that needs a running server therefore passes only when the agent asks for persistence, as PI-AGENT-047 requires.

A run uses the arm's agent package, an exact bounded task list, and an exact expected denominator. The task list is a split of the descriptor, the names of `--task-names`, or, when the run gives neither, every task of the pinned dataset except the descriptor's exclusions. Harbor lists the dataset's tasks without a download, and the launcher refuses the run when the dataset does not hold an excluded task, because the run would then not be the board's whole benchmark. A run of every task measures the reserved split `all`.

```text
expected trials = number of requested tasks * attempts per task
```

The defaults are the job settings of the harness leaderboard: 3 attempts per task, a timeout multiplier of 1, agent setup and environment build timeout multipliers of 3 (setup time is not agent time), and no resource overrides. The default concurrency is 4. A run at these settings has the grade `leaderboard_valid`. Explicit local admissions lower the grade:

- `--allow-low-k` permits fewer than 3 attempts.
- `--allow-timeout-multipliers` permits any timeout multiplier other than the defaults.
- `--allow-resource-overrides` permits environment resource overrides in a local run.

A one-attempt run is `debug_only`. Any other admitted departure is `local_low_k`. An admission flag acknowledges an exception; it does not convert the result to leaderboard-valid evidence. A rerun below 3 attempts admits low k, because it fills open slots of the round rather than measuring at the board's attempt count.

When the agent phase of a selected task has no public network, the generated config allows the API hosts that the arm's enabled provider modules declare and `models.dev`, from which Flywheel reads model metadata. Harbor's ACP agent adds no model host itself. The launcher refuses the run when an enabled provider module declares no API hosts, because its requests would fail. The manifest records the allowed hosts.

## Seed, source, and secret evidence

The manifest keeps dirty seed provenance separate for manual audit: exact Git revision, clean boolean, and dirty paths. Dirty provenance never blocks a run or changes its grade. The `runtime_source` record names the packaged Git commit, HEAD of the checkout, with both the requested and the resolved SHA. The runtime archive holds the compiled linux-x64 executable that the commit's own build script makes from its Git blobs and its `bun.lock`, and ignores all worktree state. The manifest records the archive digest at build time, and every run summary must name it. The archive leaves out the Claude engine, which is too large for Harbor's package limit: the shim's `uv.lock` pins by hash the PyPI wheel of `claude-agent-sdk` that bundles the same engine, the package builder refuses a commit whose Agent SDK engine (linux-x64 SHA-256 of its `bun.lock` manifest) differs from the wheel's, `BUILD.json` records both under `claude_engine`, and the shim refuses a trial whose installed engine differs.

The launcher selects an explicit Flywheel auth profile and exports a snapshot of its access tokens for the arm's enabled credential providers. The snapshot reaches the trial only in the environment of the Harbor process: on Hub as a direct job secret, and in local Docker through a Compose overlay that names the variable without a value, so that Docker Compose copies it into the agent container. It never appears in Harbor configuration, the job directory, a command line, or a log, and Harbor sees no ambient provider variable. In a local trial the value stays in the container's environment for the container's life, which covers the setup, agent, and verifier phases and `/proc/1/environ`, and on the host anyone who can use the Docker daemon can read it with `docker inspect` until Harbor removes the container. In both modes it is a one-use snapshot of short-lived access tokens, and the shim removes it from its own environment before it starts Flywheel. The manifest records the selected auth profile for provenance. Secret values must not appear in an arm config, manifest, metadata, ledger, log, or report. If Harbor version discovery fails, `harbor_version` is the empty string. Unknown is not replaced with a guessed version.

## Trial evidence contract

The disclosure ledger is derived from trial outputs. It is not inferred from launcher intent or aggregate Harbor console output.

Harbor `result.json` supplies:

- `task_name` and `trial_name`, which identify the trial;
- the exact verifier reward, including `0`, negative and positive numeric values, or `null`;
- Harbor exception information;
- Harbor agent cost when present.

The adjacent `agent/flywheel-run-summary.json` sidecar is versioned with `version: 2` and supplies:

- adapter settlement;
- `captured_after_cancellation` evidence;
- deadline authority provenance, exact task digest, and cap;
- the analyzed SQLite store's byte size and SHA-256 digest.

The shim copies pinned main, WAL, and SHM descriptors into a private directory, verifying source identity and content around the copy, and opens only that private copy for SQLite backup. The trial store analysis opens the private mode-0600, single-link SQLite file without following links, hashes the held descriptor, queries that same immutable descriptor, and verifies its identity did not change. It runs inside the sandbox, with the package's `flywheel-bin` and `BUN_BE_BUN=1`, and records the result in `agent/flywheel-store-analysis.json`: tool settlement counts, the request audit verdict, interaction profile ids, executable tool input counts, the outcome of the last provider response, the estimated cost of the priced usage entries, and the store's SHA-256 and size. The host analyzer reads only that record, refuses any record version other than the one it decodes, and requires the recorded store identity to match the run summary. A SIGTERM after Flywheel answered the prompt is Harbor's normal stop and is not recorded as a cancellation. Flywheel answers the ACP prompt only when its headless channel settles, that is when the turn and the work the chat owns, such as background commands, are no longer busy, so the shim reads settlement from the child's answer: a prompt result whose stop reason is not `cancelled`, or an error response. The shim holds a settled answer, lets Flywheel end, and writes the analysis and the run summary before it relays the answer, so a settled trial's export reads the store of an ended Flywheel and Harbor's stop sequence does not bound it.

After the analysis the shim publishes the trial's debug evidence into `agent/flywheel-evidence/`, in the layout of a project root that `flywheel events search --project-root` reads: the analyzed private store copy at `.flywheel/flywheel.sqlite`, so its SHA-256 equals the store identity of the analysis and the run summary, and every Flywheel diagnostic JSONL file that the trial wrote under the workspace's and the trial home's `.flywheel/log/`, at `.flywheel/log/`. Harbor scrubs secrets only in text files and a SQLite store is not one, so the shim enforces the boundary itself: it keeps the credential values of the auth snapshot in memory (each API key, OAuth access and refresh token, and token-login token of 12 or more characters; lineage ids, account identities, and labels are not credentials), scans the name and the bytes of each file for each value before it copies the file, and withholds a file that holds one; a file whose name holds one is listed under a numbered placeholder. The store holds the conversation content of that trial only, and the diagnostic logs hold no content by the repository's logging rule. Each copy is opened without following links, must be a regular, single-link file of its directory's owner that nobody else can write, and is written as a new mode-0600 file. The run summary's `debug_evidence` lists the published paths and names each withheld file with its reason, `credential:<field kind>` or `unsafe_source`, never a value. Each file replaces its earlier copy whole, a source that is withheld removes its earlier copy, and a missing source keeps it. After the copies, the shim examines every other entry of the tree again without following links, by name and bytes under the same credential rule, and removes each one that is not a clean regular file of its own user, listed as `credential:<field kind>` or `unsafe_entry`; a partial copy that a killed publication left is removed too. While Flywheel runs, the shim also publishes this tree about every 15 seconds, the interval counted from the end of the last snapshot, from a SQLite online backup of the live store, because Harbor collects the agent logs at its agent timeout while Flywheel still runs and sends the shim no signal first; such a snapshot is debug evidence only and never the store that an analysis judges, and a timed-out trial keeps the last successful one, which a failed snapshot can leave older than one interval. The final publication runs after the analysis in a process group of its own under the same SIGTERM deadline; a publication that ends at the deadline or fails leaves whole files of its own or of the last snapshot, records `{"failed": ...}`, and changes neither the analysis nor how finalization judges the trial. The host analyzer, the disclosure ledger, and the source-archive check read only the two JSON documents, so the directory does not change reconciliation.

A trial is accepted only when both JSON documents are present and valid, identity fields are nonempty, and the reward field is an exact supported value. Trial names must be unique. Tasks must belong to the requested set. Every requested task must have exactly `k` accepted trials. The ledger denominator is the requested task count multiplied by `k`; it never shrinks to the accepted row count. The accepted row count must equal that denominator or reconciliation fails closed. JSON artifact presence is not sufficient for reconciliation. The current analyzer must also validate the recorded store analysis for the exact finalized trial set.

The run manifest owns an exact ordered row set and a versioned executable-command expectation. The analyzer rejects empty task sets, nonpositive attempts or denominators, duplicate tasks, replaced or missing expected rows, and invalid minimum command cardinality. Request audits must attest the profile that the serving-model resolver selects for the run's model, and the command expectation is native `bash` evidence. The analyzer uses the production audit decoder for supported recorded versions; decoding an earlier profile ID does not manufacture missing evidence. Tool evidence accepts one or more exact expected executable invocations only from current `tool.input.completed` v2 agent facts whose canonical tool-use ID, provider call ID, provider tool name, executable tool name, and model request ID are nonempty. Each tool input must name a request audited in its own session, and its provider tool name and executable tool name must both equal the `executableId` of one tool in that request's audited surface. The join uses the `executableId`, not the surface `name`, because the surface `name` is the tool's wire form, which a route can rename (the Claude engine presents `bash` as `mcp__runtime__bash`), and the provider adapter maps a call back to the canonical name before Flywheel records it. A call that the dispatcher repaired from another name does not join. Each tool request must resolve to one complete current request-audit tuple, and each result must preserve both tool-use and model-request identity. Historical facts are not upgraded or inferred. A provider can refuse the task content before the model calls any tool, so a final request that the provider refused must also resolve to one complete request-audit tuple, and such a trial with no positive reward is the scored failure class `provider_refusal` in place of a failed command expectation. Every other trial keeps the command expectation.

Finalization calls the analyzer as a typed module function, requires `infrastructureValid: true`, and stores the analyzer contract version, result version, exact result SHA-256 digest, denominator, and failure-count summary in `run_manifest.json`. A run with missing, stale, or invalid analyzer evidence is refused rather than finalized. Comparison requires this exact valid analyzer record from both arms before it applies source, interaction-profile, profile-digest, and fixed-control checks.

The ledger preserves exact grades. It does not convert `null` to zero, estimate a reward, infer a pass from agent behavior, or remove infrastructure failures from the denominator. It reports reward distribution, task pass rates, exception histogram, cost, categories, and row-level trial evidence.

## Trial-derived outcomes and fail-closed reconciliation

The run outcome is derived after Harbor settles:

1. A nonzero Harbor exit produces `harness_nonzero_exit` and preserves Harbor's exit code. A hosted job that does not settle in the worst-case job length, or whose download fails, counts as a nonzero exit.
2. A zero Harbor exit with missing, malformed, duplicate, unexpected, or denominator-mismatched evidence produces `trials_unverified` and exit code `1`.
3. Fully reconciled evidence with no numeric scored trial produces `no_scored_trials` and exit code `1`.
4. Only fully reconciled evidence with at least one numeric score produces `completed` and exit code `0`.

`trials_unverified` is fail-closed. A Harbor success status cannot override incomplete evidence. One shape is not missing evidence: Harbor collects the agent logs at its timeout while Flywheel still runs, before the shim can write its run summary, so a trial whose `result.json` names `AgentTimeoutError` and whose summary file is absent is accepted as a `cancelled` trial; its `agent/flywheel-evidence/` holds the shim's last snapshot of the store and logs. The analyzer records it as `agent_timeout`, and its source archive digest is the agent package's. A malformed summary and an absent summary with any other exception stay fail-closed. Reports must distinguish the run outcome from individual trial rewards and categories. A run that finalizes has the manifest state `finalized`; a run whose evidence does not reconcile has `refused`.

## Failure categories and precedence

A positive numeric reward has no failure category. Other trials use the following precedence:

1. `verifier_infra` for a negative reward: a grader writes a reward below 0 when it crashed, so nothing graded the trial. This holds on every benchmark.
2. `provider_refusal`: a last provider response with outcome `refused`, which the store analysis records for a stream error that the provider's refusal of the conversation content ended, such as the ChatGPT backend's `cyber_policy`, and for a final response that the provider's content filter stopped, as Anthropic stops one, when Flywheel's retries ran out on it. A trial that ends while a retry is still owed is not a refusal. The agent answers such a prompt with the ACP stop reason `refusal`, and any other failed turn with a JSON-RPC error, never `end_turn`.
3. `provider_infra`: a non-timeout Harbor exception, or a last provider response with outcome `stream_error` or `fatal_error`.
4. `verifier_infra` for a lost GitHub download, only on a benchmark whose descriptor sets `verifierDownloadsFromGithub`: `verifier/test-stdout.txt` shows a failed download from `https://github.com/` (of uv by its installer, or of a Python by uv) or `uvx: command not found`, and holds no pytest summary line. A failed download followed by a pytest summary means the tests still ran, so the trial keeps its other category.
5. `cancelled`: a timeout exception, post-cancellation capture, or a last provider response with outcome `aborted`. A verifier timeout leaves no reward; the ledger scores it 0, because the board scores it a fail: the agent's change, such as one that leaves the tests hanging, kept the grader from finishing.
6. `cost_truncated`: a last provider response with outcome `context_overflow` or `output_overflow`.
7. `genuine`: an exact zero reward with complete settled runtime and verifier evidence that is not classified above.
8. `other`: remaining unscored or uncategorized failure evidence.

A `provider_refusal` is a scored failure of the arm: the provider refuses the same content on every attempt, so it is a result of the model and provider under test, never infrastructure noise. `genuine` is reserved for a verifier-confirmed zero after the other causes are excluded. This order is intentional: provider infrastructure evidence takes precedence over simultaneous cancellation evidence, a grader that could not start takes precedence over cancellation because a timed-out agent can still have left its deliverable, and cancellation evidence takes precedence over a cost-truncation terminal. All categories remain in the fixed denominator of the ledger, and reports show them separately. The round score below decides which categories count as scored attempts.

## Deadline authority

Harbor's agent timeout is the only deadline of a trial. The shim records the deadline provenance `deadline-blind:harbor-timeout` with no task digest and no cap, and Flywheel receives no graceful deadline of its own. A trial that Harbor stops at its timeout is `cancelled` evidence, as the outcome rules above state.

## Round scoring

A round is the record `<jobs dir>/rounds/<name>.json` of every run whose scored attempts pool into one score. A run joins its round when it is prepared, as a measurement of one split or as a rerun: a run with `--split` or with no task selection is a measurement, and a run with `--task-names` is a rerun. A dry run joins no round. The round's first run records its identity: the benchmark, the packaged Flywheel commit, the arm path and SHA-256, and the chat model and effort. The launcher refuses, before any package build or publication, a run whose benchmark or identity differs, so the pooled score measures one commit and one arm, and a change to either starts a new round. A round recorded before rounds had an identity reads without one, and its next run sets it. The manifests of the round's measure runs decide which tasks each measured split has, so a rerun adds attempts to its tasks wherever they are, and a split that the round did not measure has no score. A run without a ledger has not finished and adds nothing.

Each trial of the round has one standing:

- `infra`: the ledger category is `provider_infra` or `other`. Infrastructure ended the trial before its work could be graded. It is not scored, and it is rerun.
- `grader_lost`: the ledger category is `verifier_infra`, the reward is below 0, or, on a benchmark whose grader downloads from GitHub, the verifier output shows the lost download. Nothing graded the trial. It is not scored, and it is rerun.
- `scored`: every other trial, which includes `genuine`, `cancelled`, `cost_truncated`, and `provider_refusal`. A downloaded trial that the ledger refused for missing evidence, but whose verifier gave a reward, is scored by that reward, as the board scores it.

The scoring rules:

- A scored trial passes if and only if its reward is at least 1 and no confirmed answer-key verdict names it. A confirmed answer-key verdict turns a pass into a fail.
- Every scored attempt of every run of the round pools into its task. A task's pass rate is its passes over its scored attempts.
- Each split that the round measured gets a score: the mean over the split's tasks of each task's pass rate. A task with no scored attempt counts 0.
- Each split score is also reported over the scored tasks only, which is the board's cell rule, and without the descriptor's hub-broken tasks. A hub-broken task stays in its split, as on the board.
- The report also counts grader-lost trials, infrastructure trials, answer-key fails, and the cost over every trial.

Reruns follow the board's retry rule. Each attempt slot that a measurement planned and no scored attempt fills can run again at most 2 times. A rerun of a task reruns its open slots with the fewest reruns, and its scored trials close those slots, so a filled slot never lends its unused rerun to another. A hub-broken task is not rerun, because no agent can pass it on Harbor Hub. The rerun plan refuses while any run of the round is `prepared` or `launched`; a `launched` hosted run is settled with `run-harbor.ts resume-hosted <run directory>`, which waits for its recorded Hub job, downloads it, and finalizes it. A launcher whose status call, wait, or download fails leaves its run `launched` for that command. A run that ended before Harbor ran any trial is `refused` with the outcome `snapshot_failed`, `hub_dry_run_refused`, or `hub_launch_refused`; it measured nothing, so it plans no attempt, and a fresh measure run of its split replaces it. A rerun runs at the round's own arm and commit.

## Board data

The board's data is the public Hugging Face bucket of the harness leaderboard (its run records, invalid lists, published `index/public.json`, and per-benchmark trial shards) and the registries of its Space at its current revision. `hill.ts board fetch` stores each file in `~/.cache/flywheel/harbor-board/objects/` under its content hash and writes `snapshots/<board key>.json` only after every download succeeded. A load reads only the objects that its snapshot names, so a later fetch never mixes newer inputs into an earlier snapshot.

`bench/harbor/analysis/board-scoring.ts` ports the board's scoring for one benchmark, with each rule cited by the board function that it ports. A received answer key fails a trial whatever else happened; a cancelled trial is not scored; a trial whose agent never started, that died before its first model call, whose last model call failed at the provider, whose sandbox broke, or whose grader reported a negative reward is infrastructure; otherwise a reward of at least 1 passes. The board scores the earliest 3 scored attempts of each task on its full stage, and after 6 provider failures of one task it fills the open attempts with fails. A cell rate is the mean over the cell's scored tasks of each task's pass rate. `hill.ts board verify` recomputes every public cell and compares it with `public.json` at the board's precision: counts exactly, and rates, intervals, and cost to 4 significant digits. It also compares the descriptor's exclusions with the board's and exits 1 when they differ, because the launcher reads the exclusions of a whole-benchmark run from the descriptor. A score uses board data only after this check reports no mismatch.

The board names harnesses in its data. The analysis treats each name as an opaque value and reads the leader from the published board.

## Projection

The projection estimates the full-benchmark score of a round from its `subset` score. Each public full-stage cell of the board is one calibration unit: one model, effort, and harness. A unit's subset score is the mean pass rate over the subset tasks that the cell scored, and its full score is the cell rate.

The fit is an ordinary least squares fit of full score on subset score over the units:

```text
full = a + b * subset
```

The 90% prediction interval of a new unit's full score from its subset score x is

```text
yhat +/- t90 * s * sqrt(1 + 1/n + (x - mean subset)^2 / Sxx)
```

where s is the residual standard deviation of the fit (the structural SD), n is the unit count, and t90 is the one-sided 0.95 quantile of Student's t with n - 2 degrees of freedom. The board's units carry the same attempt-sampling noise in their subset scores as a round does, so the residual SD already holds that noise. A leave-one-out check fits the line without each unit, projects that unit, and reports how many units fall inside their 90% interval and the RMSE of those projections. The fit needs at least 3 units. The projection does not depend on the model, so a round of a model that the board does not rank still gets one.

## Comparison with the board

`hill.ts score --board` reads the round's model and chat effort from the round's identity, or from `--model` and `--effort`. The board model is the model id whose last path segment equals the round's model, ignoring case. The command prints the board's field at that model and effort on the full stage: each harness with its rate and interval, best rate first, and the round's paired difference with that harness. It marks the published leader, the harness that the published board ranks first for that model, the full stage, and that effort. The board ranks over every benchmark it holds and puts complete harnesses first, so the leader need not have the best rate on the round's benchmark; the harness with the best rate is the first row. It prints the projection only when the round measured `subset`.

The paired comparison uses the board's own method. For each harness of the field, it takes the tasks that both the round and that harness's cell scored, over every task that the round measured, so a round of the whole Terminal-Bench 2.1 compares on all 87 tasks, and computes the round's pass rate minus the harness's for each task. The difference is the mean over those tasks. Its 95% interval comes from the board's paired bootstrap: 2000 resamples of the tasks with replacement, seeded with the board's seed, the board key, and the task count, as the board seeds them. The two are tied when the interval contains 0.

## Subset selection

`hill.ts subset propose` proposes a `subset` and holdout lists from the board's public full-stage cells. It follows the method of the earlier Terminal-Bench subset:

1. The pool is the board's full-stage tasks without the board's exclusions, without tasks that every unit scores the same, and without tasks that have no agent-time data.
2. The list size is split over the board's strata in proportion to their pool counts, the largest remainders taking the leftover slots.
3. Each stratum, sorted by the units' mean pass rate, is cut into one band per slot. Each band keeps its quieter half by run-to-run noise, the mean over units of sqrt(p (1 - p)).
4. A list takes one task from each band. Of the cheapest such list and 2000 seeded random draws, the lists whose mean absolute error against the units' full scores is within 1 point of the best count as equal fits, and the cheapest of them wins. A task's cost is its median agent time over the pool median plus its median cost over the pool median.
5. Each holdout repeats the method on the tasks that the earlier lists did not take.

For each list the command reports the mean absolute error and the maximum error against the units' full scores, the Pearson correlation, the share of 2000 random lists of the same size from the pool whose error is no lower, the projection fit, and its leave-one-out coverage. Every figure is in-sample: the same board cells chose the lists, so the figures are optimistic and are not independent validation. The person picks the splits.

## Answer-key rule and review

The harness leaderboard fails a trial that used the task's reference solution, hidden tests, expected output, or another agent's transcript of the same task from any copy of the benchmark. When a descriptor sets `answerKeyRule`, each trial home carries a benchmark-only `~/.agents/AGENTS.md`, from `harbor_agent/flywheel_harbor_agent/benchmark-rules.md`, that states this rule. Flywheel loads it as user-global instructions, and Flywheel's product prompt does not contain it. A benchmark whose agent phase has no network gets no rules file, because nothing that the rule forbids is reachable, and the file would be prompt text with no effect.

`hill.ts scan` lists each passing scored trial of a round whose tool calls reached a code host, a dataset hub, an archive, or a search engine, and marks it high when a URL also names one of the descriptor's `answerKeySources`. A candidate is for review, not a verdict. The workflow `bench/harbor/workflows/answer-key-review.workflow.yaml` judges each candidate against the rule: a reader decides `confirmed` or `cleared` from the trial's tool calls and their output, and a second agent checks that verdict independently. A trial is confirmed when any network request returned, for the same task, its reference solution, its hidden tests, a page that states the expected answer, a source file that the task withholds, or another agent's published transcript; use is not required. `hill.ts verdicts` records the verdicts in the round's answer-key record, and the score counts each confirmed trial as a fail.

## Benchmark entries

### Terminal-Bench 2.1

Descriptor `terminal-bench-2.1`, board key `terminal-bench-2.1`. The descriptor excludes qemu-startup and qemu-alpine-ssh, as the board does, because their upstream images do not start on Harbor, so the whole benchmark is 87 of the dataset's 89 tasks. The agent phase has public network, so each trial home carries the answer-key rule file. The grader installs uv and a Python from GitHub before any test, so the GitHub-download rule of `verifier_infra` applies. A local run seals the verifier's Python dependencies into a read-only wheelhouse.

The `subset` split has 14 tasks of Terminal-Bench 2.1 that track the full benchmark score. It rebuilds the published terminal-bench-mini subset (huggingface.co/datasets/LocalLLaMA/terminal-bench-mini) with the same method: from the per-agent, per-task pass rates of the published leaderboard trials, drop tasks that every agent passes or fails, cut the rest into seven difficulty bands by field pass rate, and take tasks from the quieter half of each band by run-to-run noise.

The rebuild changes three things:

- It excludes 10 tasks. Eight are cyber tasks, including borderline ones: crack-7z-hash, vulnerable-secret, break-filter-js-from-html, model-extraction-relu-logits, feal-differential-cryptanalysis, feal-linear-cryptanalysis, password-recovery, and git-leak-recovery. Two cannot start: qemu-alpine-ssh and qemu-startup run Debian bullseye images, where Harbor's ACP bootstrap `apt-get install` fails with 404s because bullseye-security moved to archive.debian.org.
- It bands a task that changed in 2.1 by its 2.1 pass rate, and drops tasks with zero spread on 2.1.
- Inside the quieter half of a band, the shortest and cheapest task wins: its 2.1 median agent time and median cost, each over the pool median.

The subset, subset A, keeps the 11 usable tasks of the published subset and replaces qemu-alpine-ssh with sparql-university, crack-7z-hash with cobol-modernization, and vulnerable-secret with constraints-scheduling. Selection used Terminal-Bench 2.0 data (37 reference agents, 27,405 scored trials), and its check used Terminal-Bench 2.1 (22 leaderboard rows, 18 distinct harness and model pairs). The mean absolute error between subset score and full score is 3.8 points on the 22 rows of 2.1 (worst 8.8) and 2.9 points on the 18 pairs, against 6.3 and 4.4 for the published subset. That error beats 95% of random 14-task subsets of the eligible pool, but the subset orders close agents no better than a random subset does. One pass takes about 68 minutes of summed median agent time.

Over the board's 45 public full-stage units of Terminal-Bench 2.1, the projection fit of subset A is a = 0.01247, b = 0.89097, and s = 0.06594.

The `holdout` split (14 tasks) and the `holdout2` split (20 tasks) are disjoint from the subset and from each other. They check that a change that raises the subset score also raises the score of tasks that the subset did not select.

Two subset tasks are security-themed but defensive: filter-js-from-html asks for an XSS filter, and db-wal-recovery recovers an XOR-obfuscated SQLite log. If a provider refuses one of them, replace it with its fallback from the quieter half of its own band, chosen by the same cost rule:

| Task | Fallback | Next fallback | 2.1 error after the swap (22 rows / 18 pairs) |
|---|---|---|---|
| filter-js-from-html (band 0) | raman-fitting | sam-cell-seg | 3.4 / 3.3 points |
| db-wal-recovery (band 1) | gcode-to-text | gpt2-codegolf | 4.1 / 3.3 points |
| both | raman-fitting and gcode-to-text | | 3.0 / 2.8 points |

A swap changes the subset, so results before and after it are not comparable without a rerun of the same tasks. raman-fitting and gcode-to-text are now in the `holdout` split, so a swap to them also changes that split.

One subset task is hub-broken: Harbor's oracle agent failed custom-memory-heap-crash 8 of 8 times on Harbor Hub on 2026-11-07, and the failing trials fail only `test_no_memory_leaks_with_valgrind`. It stays in the subset, as on the board, and is not rerun, and each split score is also reported without it.

### DeepSWE v1.1

Descriptor `deep-swe-1.1`, board key `deep-swe`. The descriptor excludes two tasks, as the board does: helm-unified-manifest-stream, because its reference solution fails on the board's sandbox, and vulture-persistent-analysis-cache, because its grader fails correct solutions. So the whole benchmark is 111 of the dataset's 113 tasks. A run with no task selection runs all 111 tasks.

The `subset` split is the 16 tasks of the published deepswe-mini subset (huggingface.co/datasets/LocalLLaMA/deepswe-mini), which its authors chose by a hill-climbing search for the subset that orders 70 model configurations of the DeepSWE v1.1 leaderboard as the full benchmark does, and checked on configurations that played no part in the choice. Over the board's 45 public full-stage units of DeepSWE, its subset score correlates with the full score at r = 0.975 with a mean absolute error of 4.5 points, against r = 0.978 and 3.9 points for the 16 tasks that `hill.ts subset propose --size 16` picks in-sample from the same units. The subset scores run higher than the full benchmark, because the search favored tasks that separate models; the projection fit corrects for that.

The `holdout` split is the in-sample proposal of `hill.ts subset propose --benchmark deep-swe-1.1 --size 16` without prometheus-transactional-reload-status, which is also in the subset: 15 tasks, disjoint from the subset. It checks that a change that raises the subset score also raises the score of tasks that the subset did not select.

- The agent phase has no network. The trial reaches only the API hosts of the arm's enabled providers and `models.dev`, which the launcher allows. The agent package carries a compiled executable, and the setup phase, which has network, installs the Claude engine from the hash-pinned PyPI wheel, so the agent phase downloads nothing and every arm, including a Claude subscription arm (`api.anthropic.com`), can run.
- The verifier runs in a separate environment that also has no network, and it downloads nothing from GitHub, so the GitHub-download rule does not apply and a local run seals no wheelhouse.
- The grader writes a reward of -1 when it crashes. The ledger records that trial as `verifier_infra`, and the round counts it as grader-lost: not scored, and rerun.
- Only committed work is graded. The verifier grades the patch of `git diff` from the task's base commit to `HEAD` in the workspace, so a change that the agent does not commit is not graded.
- Each trial home carries no answer-key rule file. Nothing that the rule forbids is reachable from an agent phase without network.
- Most of the board's DeepSWE trials ran with network access. An offline Flywheel arm is therefore compared with a mostly online field, and a comparison with the board's field must state that difference.

## Removed capabilities

The removed `--headless --task` installed-agent adapter carried two trial inputs that the agent package does not have:

- A system-prompt variant, which replaced Flywheel's production system prompt for a campaign. Every trial now runs the production prompt of its packaged commit.
- The graceful deadline from the executed task's `task.toml`: the adapter read the task's timeout through the trial's `lock.json` digest and gave Flywheel the remaining allowance minus a 105-second margin. Harbor's agent timeout now ends the trial instead.

The removed adapter also recorded Flywheel's `--task` termination object, whose terminal kind named budget exhaustion, a model that no provider offers, and Flywheel's own deadline. The ACP prompt result carries no such object, so the trial store analysis records the outcome of the last provider response instead. The arm configs set no budget and pin a model that the snapshot serves, and the trial has no Flywheel deadline, so no checked-in arm can reach the kinds that this drops. A per-trial tool list is now the arm config's `disabled_modules`, and the chat model is now the arm config's pinned chat role. Results of the removed adapter are not comparable with runs of the agent package.

## Operating interpretation

A round follows one sequence. First run a dry run of each split and inspect its generated config, manifest, grade, source identity, interaction-profile ID, profile digest, task set, denominator, and warnings. Next run one paid one-attempt bring-up from the same source identity to verify Docker or Hub, Harbor, auth snapshot transport, task-workspace mapping, headless settlement, verifier execution, and post-settlement evidence export. Only after the bring-up reconciles may the measurement runs of the round run. Finalization binds each run manifest to the single source archive digest proven by all trial summaries and to the current valid analyzer result over the finalized trial set.

A paired comparison of two arms, `bun bench/harbor/run-harbor.ts compare <control manifest> <candidate manifest>`, accepts only finalized, completed manifests that carry both analyzer records. It requires one identical source archive digest and source commit, distinct profile digests, and the same benchmark, model, dataset and ref, tasks, attempts, concurrency, timeout multipliers, and resource overrides. Command-line assertions have no authority. Neither arm selects an interaction profile, because the serving-model resolver owns that choice.

Both dry-run and execution paths use `run-harbor.sh`; a direct `harbor run` bypasses effective-config validation, local admission policy, package publication, snapshot transport, wheelhouse preparation, round records, manifest finalization, and fail-closed reconciliation. A live one-attempt bring-up requires Harbor, Docker for a local run, and a selected Flywheel auth profile with suitable credentials, incurs spend, and is always `debug_only`. It proves integration plumbing only. It cannot support comparative or leaderboard claims.
