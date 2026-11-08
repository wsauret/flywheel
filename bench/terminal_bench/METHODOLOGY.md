# Terminal-Bench 2.1 methodology

This document is the authority for interpreting Flywheel Terminal-Bench 2.1 campaigns. It describes configuration admission, trial evidence, outcome classification, and deadline handling. It does not define leaderboard submission mechanics.

## Effective configuration and campaign grades

All campaigns start through `bench/terminal_bench/run-terminal-bench.sh`. The launcher merges a named YAML profile with command-line overrides, builds and publishes the run's agent package, writes `generated.json`, and validates that effective JSON with Harbor's own config model before execution. Every trial, in local Docker or on Harbor Hub, runs Harbor's `acp` agent on that package, so one execution path produces the evidence below; only the place where the trial runs differs. The serving-model resolver selects the interaction profile for every model, including `gpt-6-luna`, the default requested model, and every profile exposes the native `bash` tool. Request audits that earlier builds wrote can name the retired `luna-shell-v1` and `luna-native-v1` profiles, and historical audit readers still decode them without changing the recorded bytes.

The launcher derives the expected profile and shell tool from the host checkout. The package is built from one exact commit, the profile's `headless.runtime_source_commit` or HEAD; a campaign pinned to another commit must use a runtime that selects the expected contract, because a source pin alone does not establish compatibility. No profile, argument, or arm selects an interaction profile; a profile that names `headless.interaction_profile` is refused. The generated config is the run input, and `run_manifest.json` records its exact Harbor command, resolved interaction-profile ID, profile SHA-256 digest, and runtime source identity. Each trial also records the effective profile through request audit and the exact source archive digest. A source profile, source commit, or archive digest alone is not proof of the other identities.

Every profile names a checked-in Flywheel config with `headless.flywheel_config`, and the agent package ships it. The launcher validates it on the host with Flywheel's own config schema before any trial, also in a dry run, and refuses the run on any decode error or warning, so a trial never runs on a config that Flywheel would ignore in part. The config pins the chat model and effort in `[profiles.benchmark.roles.chat]` and is their only source, and the trial runs under the neutral auth profile id `benchmark` with no model environment override. The config is also the only source of the trial's tools: an arm turns a tool off by disabling the module that contributes it in `disabled_modules`. `run_manifest.json` and `preparation-plan.json` record the config path, SHA-256 digest, and chat effort. The package builder refuses a commit whose config bytes do not match that digest. A paired comparison reports both arms' config digests; unequal digests mean the arms ran different configs, and a manifest from before every run named a config reports `null`.

Every trial runs `flywheel --headless --acp --unattended --allow-persistent-processes`. `--unattended` is a general ACP mode (PI-AGENT-121). It omits built-in chat review, publication, and communication guidance, and the skill tool, its catalog, and ask_user. The run returns its final reply after owned work settles. Earlier runs used the interactive chat prompt, so their prompts differ. The trial passes `--allow-persistent-processes`, and the checked-in arm configs also set `allow_persistent_processes = true`. Many tasks require a server that is still running when the verifier starts, and only a command launched with `persist_after_exit` outlives Flywheel's exit. A server that the agent starts without asking it to persist does not keep the run open: the prompt is answered when the agent's turn ends, and the server ends when Flywheel exits. A task that needs a running server therefore passes only when the agent asks for persistence, as PI-AGENT-047 requires. Terminal-Bench is the only caller that enables persistence.

A campaign uses the arm's agent package, an explicit bounded task list, and an exact expected denominator:

```text
expected trials = number of requested tasks * attempts per task
```

The default submission-shaped policy is `k=5`, concurrency `4`, timeout multipliers `1.0`, and no resource overrides. Its grade is `leaderboard_valid`. Explicit local admissions downgrade the grade:

- `--allow-low-k` permits `k < 5`.
- `--allow-timeout-multipliers` permits non-`1.0` timeout multipliers.
- `--allow-resource-overrides` permits environment resource overrides.

A one-attempt campaign is `debug_only`. Any other admitted non-submission campaign is `local_low_k`. An admission flag acknowledges an exception; it does not convert the result to leaderboard-valid evidence.

## Seed, profile, and secret evidence

The manifest keeps dirty seed provenance separate for manual audit: exact Git revision, clean boolean, and dirty paths. Dirty provenance never blocks a campaign or changes its grade. The `runtime_source` record names the packaged Git commit with both the requested and canonically resolved SHA: the profile's pin, or HEAD without one. The runtime archive holds only allowed regular blobs from Git objects at that commit, requires both ripgrep addons, and ignores all worktree state. The manifest records the archive digest at build time, and every run summary must name it. Copy a profile before changing model, task, timeout, or policy so each campaign has a stable named input.

The launcher selects an explicit Flywheel auth profile and exports a snapshot of its access tokens for the arm's enabled credential providers. The snapshot reaches the trial only in the environment of the Harbor process: on Hub as a direct job secret, and in local Docker through a Compose overlay that names the variable without a value, so that Docker Compose copies it into the agent container. It never appears in Harbor configuration, the job directory, a command line, or a log, and Harbor sees no ambient provider variable. In a local trial the value stays in the container's environment for the container's life, which covers the setup, agent, and verifier phases and `/proc/1/environ`, and on the host anyone who can use the Docker daemon can read it with `docker inspect` until Harbor removes the container. In both modes it is a one-use snapshot of short-lived access tokens, and the shim removes it from its own environment before it starts Flywheel. The manifest records the selected auth profile for provenance. Secret values must not appear in a profile, manifest, metadata, ledger, log, or report. If Harbor version discovery fails, `harbor_version` is the empty string. Unknown is not replaced with a guessed version.

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
- the analyzed SQLite store's byte size and SHA-256 digest.

The shim copies pinned main, WAL, and SHM descriptors into a private directory, verifying source identity and content around the copy, and opens only that private copy for SQLite backup. The trial store analysis opens the private mode-0600, single-link SQLite file without following links, hashes the held descriptor, queries that same immutable descriptor, and verifies its identity did not change. It runs inside the sandbox and records the result in `agent/flywheel-store-analysis.json`: tool settlement counts, the request audit verdict, interaction profile ids, executable tool input counts, the outcome of the last provider response, the estimated cost of the priced usage entries, and the store's SHA-256 and size. The host analyzer reads only that record, refuses any record version other than the one it decodes, and requires the recorded store identity to match the run summary. A SIGTERM after Flywheel answered the prompt is Harbor's normal stop and is not recorded as a cancellation. Flywheel answers the ACP prompt only when its headless channel settles, that is when the turn and the work the chat owns, such as background commands, are no longer busy, so the shim reads settlement from the child's answer: a prompt result whose stop reason is not `cancelled`, or an error response. The shim holds a settled answer, lets Flywheel end, and writes the analysis and the run summary before it relays the answer, so a settled trial's export reads the store of an ended Flywheel and Harbor's stop sequence does not bound it.

After the analysis the shim publishes the trial's debug evidence into `agent/flywheel-evidence/`, in the layout of a project root that `flywheel events search --project-root` reads: the analyzed private store copy at `.flywheel/flywheel.sqlite`, so its SHA-256 equals the store identity of the analysis and the run summary, and every Flywheel diagnostic JSONL file that the trial wrote under the workspace's and the trial home's `.flywheel/log/`, at `.flywheel/log/`. Harbor scrubs secrets only in text files and a SQLite store is not one, so the shim enforces the boundary itself: it keeps the credential values of the auth snapshot in memory (each API key, OAuth access and refresh token, and token-login token of 12 or more characters; lineage ids, account identities, and labels are not credentials), scans the name and the bytes of each file for each value before it copies the file, and withholds a file that holds one; a file whose name holds one is listed under a numbered placeholder. The store holds the conversation content of that trial only, and the diagnostic logs hold no content by the repository's logging rule. Each copy is opened without following links, must be a regular, single-link file of its directory's owner that nobody else can write, and is written as a new mode-0600 file. The run summary's `debug_evidence` lists the published paths and names each withheld file with its reason, `credential:<field kind>` or `unsafe_source`, never a value. Each file replaces its earlier copy whole, a source that is withheld removes its earlier copy, and a missing source keeps it. After the copies, the shim examines every other entry of the tree again without following links, by name and bytes under the same credential rule, and removes each one that is not a clean regular file of its own user, listed as `credential:<field kind>` or `unsafe_entry`; a partial copy that a killed publication left is removed too. While Flywheel runs, the shim also publishes this tree about every 15 seconds, the interval counted from the end of the last snapshot, from a SQLite online backup of the live store, because Harbor collects the agent logs at its agent timeout while Flywheel still runs and sends the shim no signal first; such a snapshot is debug evidence only and never the store that an analysis judges, and a timed-out trial keeps the last successful one, which a failed snapshot can leave older than one interval. The final publication runs after the analysis in a process group of its own under the same SIGTERM deadline; a publication that ends at the deadline or fails leaves whole files of its own or of the last snapshot, records `{"failed": ...}`, and changes neither the analysis nor how finalization judges the trial. The host analyzer, the disclosure ledger, and the source-archive check read only the two JSON documents, so the directory does not change reconciliation.

A trial is accepted only when both JSON documents are present and valid, identity fields are nonempty, and the reward field is an exact supported value. Trial names must be unique. Tasks must belong to the requested set. Every requested task must have exactly `k` accepted trials. The ledger denominator is the requested task count multiplied by `k`; it never shrinks to the accepted row count. The accepted row count must equal that denominator or reconciliation fails closed. JSON artifact presence is not sufficient for reconciliation. The current analyzer must also validate the recorded store analysis for the exact finalized trial set.

The run manifest owns an exact ordered row set and a versioned executable-command expectation. The analyzer rejects empty task sets, nonpositive attempts or denominators, duplicate tasks, replaced or missing expected rows, and invalid minimum command cardinality. Request audits must attest the profile that the serving-model resolver selects for the run's model, and the command expectation is native `bash` evidence. The analyzer uses the production audit decoder for supported recorded versions; decoding an earlier profile ID does not manufacture missing evidence. Tool evidence accepts one or more exact expected executable invocations only from current `tool.input.completed` v2 agent facts whose canonical tool-use ID, provider call ID, provider tool name, executable tool name, and model request ID are nonempty. Each tool input must name a request audited in its own session, and its provider tool name and executable tool name must both equal the `executableId` of one tool in that request's audited surface. The join uses the `executableId`, not the surface `name`, because the surface `name` is the tool's wire form, which a route can rename (the Claude engine presents `bash` as `mcp__runtime__bash`), and the provider adapter maps a call back to the canonical name before Flywheel records it. A call that the dispatcher repaired from another name does not join. Each tool request must resolve to one complete current request-audit tuple, and each result must preserve both tool-use and model-request identity. Historical facts are not upgraded or inferred. A provider can refuse the task content before the model calls any tool, so a final request that the provider refused must also resolve to one complete request-audit tuple, and such a trial with no positive reward is the scored failure class `provider_refusal` in place of a failed command expectation. Every other trial keeps the command expectation.

Finalization calls the analyzer as a typed module function, requires `infrastructureValid: true`, and stores the analyzer contract version, result version, exact result SHA-256 digest, denominator, and failure-count summary in `run_manifest.json`. A run with missing, stale, or invalid analyzer evidence is refused rather than finalized. Comparison requires this exact valid analyzer record from both arms before it applies source, interaction-profile, profile-digest, and fixed-control checks.

The ledger preserves exact grades. It does not convert `null` to zero, estimate a reward, infer a pass from agent behavior, or remove infrastructure failures from the denominator. It reports reward distribution, task pass rates, exception histogram, cost, categories, and row-level trial evidence.

## Trial-derived outcomes and fail-closed reconciliation

The run outcome is derived after Harbor settles:

1. A nonzero Harbor exit produces `harness_nonzero_exit` and preserves Harbor's exit code.
2. A zero Harbor exit with missing, malformed, duplicate, unexpected, or denominator-mismatched evidence produces `trials_unverified` and exit code `1`.
3. Fully reconciled evidence with no numeric scored trial produces `no_scored_trials` and exit code `1`.
4. Only fully reconciled evidence with at least one numeric score produces `completed` and exit code `0`.

`trials_unverified` is fail-closed. A Harbor success status cannot override incomplete evidence. One shape is not missing evidence: Harbor collects the agent logs at its timeout while Flywheel still runs, before the shim can write its run summary, so a trial whose `result.json` names `AgentTimeoutError` and whose summary file is absent is accepted as a `cancelled` trial; its `agent/flywheel-evidence/` holds the shim's last snapshot of the store and logs. The analyzer records it as `agent_timeout`, and its source archive digest is the agent package's. A malformed summary and an absent summary with any other exception stay fail-closed. Reports must distinguish the run outcome from individual trial rewards and categories.

## Failure categories and precedence

A positive numeric reward has no failure category. Other trials use the following precedence:

1. `provider_refusal`: a last provider response with outcome `refused`, which the store analysis records for a stream error that the provider's refusal of the conversation content ended, such as the ChatGPT backend's `cyber_policy`, and for a final response that the provider's content filter stopped, as Anthropic stops one, when Flywheel's retries ran out on it. A trial that ends while a retry is still owed is not a refusal. The agent answers such a prompt with the ACP stop reason `refusal`, and any other failed turn with a JSON-RPC error, never `end_turn`.
2. `provider_infra`: a non-timeout Harbor exception, or a last provider response with outcome `stream_error` or `fatal_error`.
3. `cancelled`: a timeout exception, post-cancellation capture, or a last provider response with outcome `aborted`.
4. `cost_truncated`: a last provider response with outcome `context_overflow` or `output_overflow`.
5. `genuine`: an exact zero reward with complete settled runtime and verifier evidence that is not classified above.
6. `other`: remaining unscored or uncategorized failure evidence.

A `provider_refusal` is a scored failure of the arm: the provider refuses the same content on every attempt, so it is a result of the model and provider under test, never infrastructure noise. The next three categories are infrastructure or execution-limit failures, not evidence that the attempted solution was genuinely incorrect. `genuine` is reserved for a verifier-confirmed zero after those causes are excluded. This order is intentional: provider infrastructure evidence takes precedence over simultaneous cancellation evidence, and cancellation evidence takes precedence over a cost-truncation terminal. All categories remain in the fixed denominator and reports show them separately.

## Deadline authority

Harbor's agent timeout is the only deadline of a trial. The shim records the deadline provenance `deadline-blind:harbor-timeout` with no task digest and no cap, and Flywheel receives no graceful deadline of its own. A trial that Harbor stops at its timeout is `cancelled` evidence, as the outcome rules above state.

## Removed capabilities

The removed `--headless --task` installed-agent adapter carried two trial inputs that the agent package does not, and the launcher refuses both:

- A system-prompt variant (`headless.system_prompt`), which replaced Flywheel's production system prompt for a campaign. Every trial now runs the production prompt of its packaged commit.
- The graceful deadline from the executed task's `task.toml`: the adapter read the task's timeout through the trial's `lock.json` digest and gave Flywheel the remaining allowance minus a 105-second margin. Harbor's agent timeout now ends the trial instead.

The removed adapter also recorded Flywheel's `--task` termination object, whose terminal kind named budget exhaustion, a model that no provider offers, and Flywheel's own deadline. The ACP prompt result carries no such object, so the trial store analysis records the outcome of the last provider response instead. The arm configs set no budget and pin a model that the snapshot serves, and the trial has no Flywheel deadline, so no checked-in arm can reach the kinds that this drops.

A per-trial tool list (`headless.disabled_tools`) is now the arm config's `disabled_modules`, and the chat model (`headless.model`, `--model`) is now the arm config's pinned chat role.

## Benchmark rules

Each trial home carries a benchmark-only `~/.agents/AGENTS.md`, from `harbor_agent/flywheel_harbor_agent/benchmark-rules.md`, that states the harness leaderboard's answer-key rule: a trial must not use the task's reference solution, hidden tests, expected output, or another agent's transcript of the same task from any copy of the benchmark. Flywheel loads it as user-global instructions. Flywheel's product prompt does not contain this rule. Runs before this change did not have it.

## Task subset

The `tb-mini-*` profiles run 14 tasks of Terminal-Bench 2.1 that track the full benchmark score. They rebuild the published terminal-bench-mini subset (huggingface.co/datasets/LocalLLaMA/terminal-bench-mini) with the same method: from the per-agent, per-task pass rates of the published leaderboard trials, drop tasks that every agent passes or fails, cut the rest into seven difficulty bands by field pass rate, and take tasks from the quieter half of each band by run-to-run noise.

The rebuild changes three things:

- It excludes 10 tasks. Eight are cyber tasks, including borderline ones: crack-7z-hash, vulnerable-secret, break-filter-js-from-html, model-extraction-relu-logits, feal-differential-cryptanalysis, feal-linear-cryptanalysis, password-recovery, and git-leak-recovery. Two cannot start: qemu-alpine-ssh and qemu-startup run Debian bullseye images, where Harbor's ACP bootstrap `apt-get install` fails with 404s because bullseye-security moved to archive.debian.org.
- It bands a task that changed in 2.1 by its 2.1 pass rate, and drops tasks with zero spread on 2.1.
- Inside the quieter half of a band, the shortest and cheapest task wins: its 2.1 median agent time and median cost, each over the pool median.

The subset keeps the 11 usable tasks of the published subset and replaces qemu-alpine-ssh with sparql-university, crack-7z-hash with cobol-modernization, and vulnerable-secret with constraints-scheduling. Selection used Terminal-Bench 2.0 data (37 reference agents, 27,405 scored trials), and its check used Terminal-Bench 2.1 (22 leaderboard rows, 18 distinct harness and model pairs). The mean absolute error between subset score and full score is 3.8 points on the 22 rows of 2.1 (worst 8.8) and 2.9 points on the 18 pairs, against 6.3 and 4.4 for the published subset. That error beats 95% of random 14-task subsets of the eligible pool, but the subset orders close agents no better than a random subset does. One pass takes about 68 minutes of summed median agent time.

Two tasks are security-themed but defensive: filter-js-from-html asks for an XSS filter, and db-wal-recovery recovers an XOR-obfuscated SQLite log. If a provider refuses one of them, replace it with its fallback from the quieter half of its own band, chosen by the same cost rule:

| Task | Fallback | Next fallback | 2.1 error after the swap (22 rows / 18 pairs) |
|---|---|---|---|
| filter-js-from-html (band 0) | raman-fitting | sam-cell-seg | 3.4 / 3.3 points |
| db-wal-recovery (band 1) | gcode-to-text | gpt2-codegolf | 4.1 / 3.3 points |
| both | raman-fitting and gcode-to-text | | 3.0 / 2.8 points |

A swap changes the subset, so results before and after it are not comparable without a rerun of the same tasks.

## Operating interpretation

Campaign execution follows one sequence. First run `--dry-run` for each named arm and inspect its generated config, manifest, grade, source identity, interaction-profile ID, profile digest, task set, denominator, and warnings. Next run one paid `k=1` smoke against the candidate from the same source identity to verify Docker or Hub, Harbor, auth snapshot transport, task-workspace mapping, headless settlement, verifier execution, and post-settlement evidence export. Only after the smoke reconciles may the paired control and candidate campaigns run with identical source archive bytes, model, tasks, attempts, concurrency, timeout policy, and resource policy. Finalization binds each run manifest to the single source archive digest proven by all trial summaries and to the current valid analyzer result over the finalized trial set. Comparison accepts only finalized manifests carrying both records; command-line assertions have no authority. The profile bytes, proven by distinct profile digests, are the sole intended arm difference; neither arm selects an interaction profile, because the serving-model resolver owns that choice.

Both dry-run and execution paths use `run-terminal-bench.sh`; a direct `harbor run` bypasses effective-config validation, local admission policy, package publication, snapshot transport, wheelhouse preparation, manifest finalization, and fail-closed reconciliation. A live `k=1` smoke requires Docker, Harbor, and a selected Flywheel auth profile with suitable credentials, incurs spend, and is always `debug_only`. It proves integration plumbing only. It cannot support comparative or leaderboard claims. The required paid sequence describes the admission standard for future evidence; this document does not claim that the campaign has run or that either arm has parity or promotion evidence.
