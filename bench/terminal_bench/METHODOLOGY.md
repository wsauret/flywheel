# Terminal-Bench 2.1 methodology

This document is the authority for interpreting Flywheel Terminal-Bench 2.1 campaigns. It describes configuration admission, trial evidence, outcome classification, and deadline handling. It does not define leaderboard submission mechanics.

## Effective configuration and campaign grades

All campaigns start through `bench/terminal_bench/run-terminal-bench.sh`. The launcher merges a named YAML profile with command-line overrides, writes `generated.json`, and validates that effective JSON with Harbor's `JobConfig` before execution. The serving-model resolver selects the interaction profile for every model, including `gpt-6-luna`, the default requested model, and every profile exposes the native `bash` tool. Request audits that earlier builds wrote can name the retired `luna-shell-v1` and `luna-native-v1` profiles, and historical audit readers still decode them without changing the recorded bytes.

The launcher derives the expected profile and shell tool from the host checkout. A campaign pinned with `headless.runtime_source_commit` must use a runtime that selects the expected contract; a source pin alone does not establish compatibility. No profile, argument, or arm selects an interaction profile; a profile that names `headless.interaction_profile` is refused. The generated config is the run input, and `run_manifest.json` records its exact Harbor command, resolved interaction-profile ID, profile SHA-256 digest, and runtime source identity. Each trial also records the effective profile through request audit and the exact source archive digest. A source profile, source commit, or archive digest alone is not proof of the other identities.

Every trial runs headless Flywheel with `--allow-persistent-processes`. Many tasks require a server that is still running when the verifier starts, and only a command launched with `persist_after_exit` outlives Flywheel's exit. Terminal-Bench is the only caller that enables persistence.

A campaign uses the named `FlywheelHeadless` agent, an explicit bounded task list, and an exact expected denominator:

```text
expected trials = number of requested tasks * attempts per task
```

The default submission-shaped policy is `k=5`, concurrency `4`, timeout multipliers `1.0`, and no resource overrides. Its grade is `leaderboard_valid`. Explicit local admissions downgrade the grade:

- `--allow-low-k` permits `k < 5`.
- `--allow-timeout-multipliers` permits non-`1.0` timeout multipliers.
- `--allow-resource-overrides` permits environment resource overrides.

A one-attempt campaign is `debug_only`. Any other admitted non-submission campaign is `local_low_k`. An admission flag acknowledges an exception; it does not convert the result to leaderboard-valid evidence.

## Seed, profile, and secret evidence

The manifest keeps dirty seed provenance separate for manual audit: exact Git revision, clean boolean, and dirty paths. Dirty provenance never blocks a campaign or changes its grade. The `runtime_source` record identifies either worktree mode or pinned Git commit mode with both the requested and canonically resolved SHA. Pinned mode reads only allowed regular blobs from Git objects at that commit, requires both ripgrep addons, and ignores all worktree state. Unpinned mode retains the existing behavior: safe untracked runtime files under the allowed source roots and file list are included automatically, while unsafe paths and secret names or suffixes are excluded. Each trial's source archive digest sidecar identifies the exact archive bytes. Copy a profile before changing model, task, timeout, or policy so each campaign has a stable named input.

The launcher selects an explicit Flywheel auth profile. The trusted adapter exports a host-owned snapshot of that complete profile and transports the private snapshot to each trial without exposing credentials to Harbor configuration or ambient provider environment variables. The manifest records the selected auth profile for provenance. Secret values must not appear in a profile, manifest, metadata, ledger, log, or report. If Harbor version discovery fails, `harbor_version` is the empty string. Unknown is not replaced with a guessed version.

## Trial evidence contract

The disclosure ledger is derived from trial outputs. It is not inferred from launcher intent or aggregate Harbor console output.

Harbor `result.json` supplies:

- `task_name` and `trial_name`, which identify the trial;
- the exact verifier reward, including `0`, positive numeric values, or `null`;
- Harbor exception information;
- Harbor agent cost when present.

The adjacent `agent/flywheel-run-summary.json` sidecar is versioned with `version: 2` and supplies:

- adapter settlement;
- `captured_after_cancellation` evidence;
- deadline authority provenance, exact task digest, and cap;
- Flywheel's versioned `termination` object when the runtime emitted one;
- usage evidence when available;
- the exported SQLite byte size and SHA-256 digest.

The trial's `agent/state/.flywheel/flywheel.sqlite` retains the underlying Flywheel event history. The adapter creates this export by copying pinned main, WAL, and SHM descriptors into a private root-owned directory, verifying source identity and content around the copy, and opening only that private copy for SQLite backup. The analyzer opens the private mode-0600, single-link SQLite file without following links, hashes the held descriptor, queries that same immutable descriptor, and verifies its identity did not change.

A trial is accepted only when both JSON documents are present and valid, identity fields are nonempty, and the reward field is an exact supported value. Trial names must be unique. Tasks must belong to the requested set. Every requested task must have exactly `k` accepted trials. The ledger denominator is the requested task count multiplied by `k`; it never shrinks to the accepted row count. The accepted row count must equal that denominator or reconciliation fails closed. JSON artifact presence is not sufficient for reconciliation. The current analyzer must also validate the held SQLite evidence for the exact finalized trial set.

The run manifest owns an exact ordered row set and a versioned executable-command expectation. The analyzer rejects empty task sets, nonpositive attempts or denominators, duplicate tasks, replaced or missing expected rows, and invalid minimum command cardinality. Request audits must attest the profile that the serving-model resolver selects for the run's model, and the command expectation is native `bash` evidence. The analyzer uses the production audit decoder for supported recorded versions; decoding an earlier profile ID does not manufacture missing evidence. Tool evidence accepts one or more exact expected executable invocations only from current `tool.input.completed` v2 agent facts whose provider tool identity is `shell` and whose canonical tool-use ID, provider call ID, executable tool name, and model request ID are nonempty. Each tool request must resolve to one complete current request-audit tuple, and each result must preserve both tool-use and model-request identity. Historical facts are not upgraded or inferred.

Finalization calls the analyzer as a typed module function, requires `infrastructureValid: true`, and stores the analyzer contract version, result version, exact result SHA-256 digest, denominator, and failure-count summary in `run_manifest.json`. A run with missing, stale, or invalid analyzer evidence is refused rather than finalized. Comparison requires this exact valid analyzer record from both arms before it applies source, interaction-profile, profile-digest, and fixed-control checks.

The ledger preserves exact grades. It does not convert `null` to zero, estimate a reward, infer a pass from agent behavior, or remove infrastructure failures from the denominator. It reports reward distribution, task pass rates, exception histogram, cost, categories, and row-level trial evidence.

## Trial-derived outcomes and fail-closed reconciliation

The run outcome is derived after Harbor settles:

1. A nonzero Harbor exit produces `harness_nonzero_exit` and preserves Harbor's exit code.
2. A zero Harbor exit with missing, malformed, duplicate, unexpected, or denominator-mismatched evidence produces `trials_unverified` and exit code `1`.
3. Fully reconciled evidence with no numeric scored trial produces `no_scored_trials` and exit code `1`.
4. Only fully reconciled evidence with at least one numeric score produces `completed` and exit code `0`.

`trials_unverified` is fail-closed. A Harbor success status cannot override incomplete evidence. Reports must distinguish the run outcome from individual trial rewards and categories.

## Failure categories and precedence

A positive numeric reward has no failure category. Other trials use the following precedence:

1. `provider_infra`: a non-timeout Harbor exception, or Flywheel terminal kind `api_error`, `model_unavailable`, `transient_disconnect`, or `api_overloaded`. `model_unavailable` means that no configured provider offers the requested model, so the run never reached a model.
2. `cancelled`: a timeout exception, post-cancellation capture, expired deadline, or terminal kind `aborted` or `interrupted`.
3. `cost_truncated`: terminal kind `budget_exhausted`, `context_overflow`, or `output_overflow`.
4. `genuine`: an exact zero reward with complete settled runtime and verifier evidence that is not classified above.
5. `other`: remaining unscored or uncategorized failure evidence.

The first three categories are infrastructure or execution-limit failures, not evidence that the attempted solution was genuinely incorrect. `genuine` is reserved for a verifier-confirmed zero after those causes are excluded. This order is intentional: provider infrastructure evidence takes precedence over simultaneous cancellation evidence, and cancellation evidence takes precedence over a cost-truncation terminal. All categories remain in the fixed denominator and reports show them separately.

## Deadline authority and cancellation margin

The adapter does not trust a task name or an arbitrary cached `task.toml` by itself. It reads the executed trial's `lock.json`, requires an exact `sha256:<64 lowercase hex characters>` task digest, and requires the locked organization to equal the configured dataset organization. The locked task name must also equal the task component encoded in the trial directory. It then reads the timeout only from the cache path selected by that exact organization, task name, and digest. Valid evidence records provenance `executed-task-digest`, the digest, and the timeout cap.

If dataset identity, trial identity, lock data, organization authority, digest, task metadata, or timeout is unavailable or invalid, the adapter records deadline-blind provenance and does not invent a cap.

For an authoritative cap, Flywheel receives a graceful deadline equal to the remaining task allowance minus 105 seconds, with a minimum of one second. This 105-second margin reserves time for interruption, process settlement, Harbor collection, verifier work, and evidence publication before the outer task deadline. The adapter records whether evidence was captured after cancellation. Cancellation evidence is a trial fact, not a substitute for a verifier grade.

## Operating interpretation

Campaign execution follows one sequence. First run `--dry-run` for each named arm and inspect its generated config, manifest, grade, source identity, interaction-profile ID, profile digest, task set, denominator, and warnings. Next run one paid `k=1` smoke against the candidate from the same source identity to verify Docker, Harbor, auth snapshot transport, task-workspace mapping, headless settlement, verifier execution, and post-settlement evidence export. Only after the smoke reconciles may the paired control and candidate campaigns run with identical source archive bytes, model, tasks, attempts, concurrency, timeout policy, resource policy, and disabled tools. Finalization binds each run manifest to the single source archive digest proven by all trial summaries and to the current valid analyzer result over the finalized trial set. Comparison accepts only finalized manifests carrying both records; command-line assertions have no authority. The profile bytes, proven by distinct profile digests, are the sole intended arm difference; neither arm selects an interaction profile, because the serving-model resolver owns that choice.

Both dry-run and execution paths use `run-terminal-bench.sh`; a direct `harbor run` bypasses effective-config validation, local admission policy, wheelhouse preparation, manifest finalization, and fail-closed reconciliation. A live `k=1` smoke requires Docker, Harbor, and a selected Flywheel auth profile with suitable credentials, incurs spend, and is always `debug_only`. It proves integration plumbing only. It cannot support comparative or leaderboard claims. The required paid sequence describes the admission standard for future evidence; this document does not claim that the campaign has run or that either arm has parity or promotion evidence.
