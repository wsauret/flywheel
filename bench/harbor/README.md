# Harbor Hub hill-climb

This directory holds Flywheel's system to hill-climb on a benchmark of Harbor Hub. A hill-climb runs Flywheel on fixed task splits of one benchmark, or on the whole benchmark, scores the runs with the rules of the [harness leaderboard](https://huggingface.co/spaces/joelniklaus/harness-leaderboard), projects a subset score to the full benchmark, and compares Flywheel with the board's field and with its leader task by task. The system works for each benchmark that `benchmarks.ts` registers. To add a benchmark, add one descriptor (see [Add a benchmark](#add-a-benchmark)).

The system has two entry points:

- `run-harbor.sh` prepares and runs every trial. Do not invoke Harbor directly. The launcher resolves the command line and each task, builds and publishes the agent package of the run, writes a generated Harbor job config, validates it with Harbor's own config model, and runs Harbor only after validation.
- `hill.ts` reads the board's data and the records of a round. It fetches and verifies the board, proposes splits, plans reruns, scans for answer-key use, records review verdicts, and scores a round.

There is one execution path. Every trial, in local Docker or on Harbor Hub, runs Harbor's `acp` agent on the same agent package. The package runs `flywheel --headless --acp --unattended` in the task workspace and records the same evidence. Only the place where the trial runs is different.

See [METHODOLOGY.md](METHODOLOGY.md) for the measurement rules, the evidence contracts, the scoring and projection method, and the entry of each benchmark.

## Registered benchmarks

| Benchmark id | Harbor dataset | Board key | Splits | Excluded tasks | Whole benchmark | Answer-key rule file |
|---|---|---|---|---|---|---|
| `terminal-bench-2.1` | `terminal-bench/terminal-bench-2-1` | `terminal-bench-2.1` | `subset` (14 tasks), `holdout` (14), `holdout2` (20) | qemu-startup, qemu-alpine-ssh | 87 of 89 tasks | yes |
| `deep-swe-1.1` | `datacurve/deep-swe-1-1` | `deep-swe` | `subset` (16 tasks), `holdout` (15) | helm-unified-manifest-stream, vulture-persistent-analysis-cache | 111 of 113 tasks | no |

Each descriptor pins the dataset to an exact `sha256:` ref and states the tasks that the board excludes, each with the board's reason. A run of a split that the descriptor does not have is refused. A run with no task selection runs the whole benchmark, so a DeepSWE run can start before the person picks its splits (see [Whole-benchmark run](#whole-benchmark-run)).

## Requirements

- The Harbor CLI, `harbor`, on `PATH`. The launcher uses Harbor's own Python for task resolution, config validation, and the package builder, so a dry run also needs it. A hosted run needs a Harbor Hub login and Harbor 0.25.1 or later (`0.25.1.dev202611090753` is the first build): from that version, Hub and the CLI read the secrets of an agent as selections with a name, a tag, and a variable name, and an earlier CLI refuses the generated job config at validation.
- Docker, for a local run only.
- Bun and Git. The package builder builds the Flywheel executable from the Git blobs of HEAD.
- A public GitHub agent repository that this host can push to. Name it with `--agent-repo <owner/repo>` or `FLYWHEEL_HARBOR_AGENT_REPO`. It has no default.
- Optionally, a Harbor Hub organization that owns hosted jobs: `--organization <name>` or `FLYWHEEL_HARBOR_HUB_ORG`. Without one, a job belongs to the signed-in Hub user.
- A Flywheel auth profile with credentials for the arm's providers, named with the required `--auth-profile <id>`. Harbor never sees an ambient provider credential or a provider selector: the one credential of a trial is the auth snapshot that the launcher exports.
- HTTPS access to `huggingface.co` for `hill.ts board fetch`. The board's bucket and Space are public, so the fetch needs no Hugging Face login and no Hugging Face CLI.

## Arms

An arm is a checked-in Flywheel config that the launcher takes with `--arm <path>`, a path relative to the repository root. The config sets the modules and settings of the trial, persistent processes included, and pins the chat model and effort in `[profiles.benchmark.roles.chat]`. It is the only source of the chat model and of the tools of the trial: an arm turns a tool off when it disables the module that contributes the tool in `disabled_modules`. The checked-in arms keep the Subagents module on and turn off the agent types that a run of one model cannot use with `[subagents] disabled_types = ["advisor", "reviewer", "ship"]`: the advisor and the reviewers give a second opinion from another model, and nothing in a trial publishes. The `general`, `explorer`, and `implementer` types stay, and each arm pins the `explorer`, `implementer`, and `subagent-summary` roles to its chat model, so no other model runs in a trial. Before any trial, also in a dry run, the launcher decodes the file with Flywheel's own config schema and refuses the run on any error or warning, with the file and the problem. An unknown key is a warning, so it refuses the run.

The package carries the config. The trial installs it as `$HOME/.flywheel/flywheel.toml` and runs Flywheel under the neutral auth profile id `benchmark`, so the config names no host profile.

The checked-in arms are in `configs/`:

- `tb-board-deepseek-low.toml` and `tb-board-deepseek-high.toml` match the settings of the harness leaderboard. They run the September release of DeepSeek-V4.1-Flash at reasoning effort low or high, on the person's OpenRouter API key. OpenRouter is restricted to DeepInfra's fp8 endpoint with no fallback, because the board serves that model from DeepInfra. Automatic titles use the same route, so no other model runs in a trial.
- `tb-mini-openai.toml` runs `gpt-6.1-terra` at medium effort.
- `tb-mini-claude.toml` runs Flywheel's Claude engine route on the person's Claude subscription. It runs on every registered benchmark, also where the agent phase is offline: Harbor installs the Claude engine in the setup phase (see [Agent package](#agent-package)).

When the agent phase of a selected task has no public network, as on DeepSWE, the trial can reach only the hosts that the run allows. The launcher allows the API hosts that the arm's enabled provider modules declare, and the model metadata host `models.dev`. It refuses the run, with the name of each provider, when an enabled provider module declares no API hosts. Of the provider modules, OpenRouter (`openrouter.ai`) and the Claude engine route (`api.anthropic.com`) declare their hosts now, so only an arm that enables no other provider module can run such a task.

## Launcher flags

`bash bench/harbor/run-harbor.sh <flags>`. The defaults are the job settings of the harness leaderboard. Each departure from them needs its own admission flag and lowers the grade of the run.

| Flag | Default | Meaning |
|---|---|---|
| `--benchmark <id>` | required | A registered benchmark id. |
| `--arm <path>` | required | The arm's Flywheel config. |
| `--auth-profile <id>` | required | The Flywheel auth profile that the snapshot comes from. |
| `--split <name>` or `--task-names <a,b>` | neither: every task | A split of the descriptor, or an explicit list. Give at most one of the two. A bare task name takes the benchmark's task namespace. Each name must match a task of the pinned dataset. With neither, the run takes every task of the pinned dataset except the descriptor's exclusions and measures the reserved split `all`. |
| `--round <name>` | none | The round that an executing run joins. A run with `--split` or with no task selection joins as a measurement, a run with `--task-names` as a rerun. A dry run joins no round, but its benchmark and identity are checked against the round. The name is a lowercase slug. See [A hill-climb round](#a-hill-climb-round). |
| `--attempts <n>` | `3` | Attempts per task. Fewer than 3 needs `--allow-low-k`. |
| `--concurrency <n>` | `4` | Trials at the same time. On Hub, set it to the trial count to run every trial at once. |
| `--timeout-multiplier <x>` | `1` | Harbor's agent and verifier timeout multiplier. |
| `--agent-setup-timeout-multiplier <x>` | `3` | Agent setup timeout multiplier. |
| `--environment-build-timeout-multiplier <x>` | `3` | Environment build timeout multiplier. |
| `--allow-timeout-multipliers` | off | Admits any timeout multiplier other than the defaults. |
| `--resource-overrides '<json>'` | none | Local only: `cpus`, `memory_mb`, `storage_mb`, `gpus`, `tpu`. Needs `--allow-resource-overrides`. `--hosted` refuses them. |
| `--hosted` | off | Runs on Harbor Hub instead of local Docker. Refuses `--prebuild` and resource overrides. |
| `--organization <name>` | `FLYWHEEL_HARBOR_HUB_ORG` | The Hub organization of a hosted job. |
| `--agent-repo <owner/repo>` | `FLYWHEEL_HARBOR_AGENT_REPO` | The public agent repository. |
| `--execute` | off | Authorizes provider spend and container work. Without it, the run is a dry run (`--dry-run` states that explicitly). |
| `--prebuild` / `--skip-prebuild` | skip | Local only: builds each task image before Harbor runs. |
| `--jobs-dir <dir>` | `jobs` in the current directory | Holds the artifact directory of each run and the `rounds/` records. |
| `--job-name <name>` | `flywheel-<benchmark>-<model>` | The Harbor job name and the prefix of the artifact directory. Each run's Harbor job lies inside its own artifact directory, so runs can share a job name. |
| `--claude-token-keychain-item <name>` | `flywheel-claude-oauth-token` | The macOS keychain item of a Claude arm's token. |

Grades:

- `leaderboard_valid`: at least 3 attempts, the default timeout multipliers, and no resource overrides.
- `local_low_k`: fewer than 3 attempts, other timeout multipliers, or resource overrides, each admitted by its flag.
- `debug_only`: one attempt.

An admission flag acknowledges an exception. It does not make the result leaderboard-valid. Dirty Git provenance never blocks a run or changes its grade: the manifest records the revision, the clean boolean, and the dirty paths for a later manual audit.

## A hill-climb round

A round is a named record of runs whose scored attempts pool into one score of one arm on one benchmark. The launcher writes it at `<jobs dir>/rounds/<name>.json` when an executing run with `--round` is prepared, so a run that fails later is still listed, and its manifest state tells how far it got.

The two entry points name a round in two forms. The launcher's `--round` takes the round name, and the launcher prints the record path, `round <name>: <jobs dir>/rounds/<name>.json`, when it records the run. Each `hill.ts` command takes that record path with `--round`.

A round measures one setup. Its first run records the round's identity: the benchmark, the Flywheel commit that the agent package is built from, the arm path and SHA-256, and the chat model and effort that the arm pins. Before it builds or publishes a package, the launcher refuses a run that names the round with another benchmark, commit, arm digest, model, or effort, and names the recorded and the offered value. So one round is one commit and one arm: commit a change to Flywheel or to the arm, then start a new round. A round recorded before rounds had an identity still reads, and its next run sets the identity.

The launchers of a round can run at the same time. Each append to the record holds the lock file `<jobs dir>/rounds/<name>.json.lock` for its read and write, so every run lands. An append that waits more than 10 seconds for the lock stops with an error that names the lock file. Remove that file only when no launcher is joining the round.

This example measures the DeepSeek high arm on Terminal-Bench 2.1 on Harbor Hub as round `r3`. Replace `<profile>`, `<owner/repo>`, and `<jobs dir>`.

```bash
export FLYWHEEL_HARBOR_AGENT_REPO=<owner/repo>
JOBS=<jobs dir>
ARM=bench/harbor/configs/tb-board-deepseek-high.toml
ROUND="$JOBS/rounds/r3.json"
```

1. Fetch the board's data and verify that the port of the board's scoring reproduces the published board. `board verify` also checks that the descriptor's exclusions equal the board's. It exits 1 on any mismatch or when the exclusions differ, and for a benchmark with a `subset` split it prints the projection fit.

   ```bash
   bun bench/harbor/hill.ts board fetch --benchmark terminal-bench-2.1
   bun bench/harbor/hill.ts board verify --benchmark terminal-bench-2.1
   ```

2. Dry-run one split. A dry run makes no trials and no model requests, but it builds and publishes the agent package and, with `--hosted`, runs Hub's free dry run, so it proves the package of the exact commit. It joins no round.

   ```bash
   bash bench/harbor/run-harbor.sh --benchmark terminal-bench-2.1 --arm "$ARM" --auth-profile <profile> \
     --split subset --hosted --concurrency 42 --jobs-dir "$JOBS" --round r3
   ```

3. Run each split with `--execute`. A hosted run stays in the foreground until its job settles, so start the three runs at the same time, each in its own shell. `--concurrency` is the trial count of the split, so Hub runs every trial at once.

   ```bash
   bash bench/harbor/run-harbor.sh --benchmark terminal-bench-2.1 --arm "$ARM" --auth-profile <profile> \
     --split subset --hosted --concurrency 42 --jobs-dir "$JOBS" --round r3 --execute
   bash bench/harbor/run-harbor.sh --benchmark terminal-bench-2.1 --arm "$ARM" --auth-profile <profile> \
     --split holdout --hosted --concurrency 42 --jobs-dir "$JOBS" --round r3 --execute
   bash bench/harbor/run-harbor.sh --benchmark terminal-bench-2.1 --arm "$ARM" --auth-profile <profile> \
     --split holdout2 --hosted --concurrency 60 --jobs-dir "$JOBS" --round r3 --execute
   ```

4. Let each run finalize. An executing hosted run records the Hub job id in its manifest and sets the state `launched`, waits for its Hub job, downloads its trials into `<run>/hub/`, and finalizes them: it writes `disclosure-ledger.json` and sets the manifest state to `finalized` or `refused`. A local run finalizes when Harbor exits.

   When the launcher of a hosted run ends after the launch, for example because the host slept or the terminal closed, the run stays `launched`. A failed Hub status call, a job that does not settle within the run's deadline, or a failed download also stops the launcher with an error and leaves the run `launched`. Settle it from its artifact directory. The command waits for the recorded Hub job, downloads it, and finalizes it with the same code as an uninterrupted run, and it never launches a job:

   ```bash
   bun bench/harbor/run-harbor.ts resume-hosted <run artifact directory>
   ```

   A run that ends before Harbor runs any trial is `refused` with an outcome that tells why: `snapshot_failed` when the snapshot export fails or the snapshot is too long for Hub, `hub_dry_run_refused` when Hub refuses the dry run, and `hub_launch_refused` when Hub refuses the launch. Then read the first score of the round:

   ```bash
   bun bench/harbor/hill.ts score --round "$ROUND"
   ```

5. Rerun the trials that infrastructure or a lost grader left unscored. Without `--launch`, the command prints each task's open attempts and the launcher commands that it would run. With `--launch`, it runs them one after another. The flags after `--` go to each launcher command. The generated commands stay dry runs unless `--execute` follows `--`. Run the reruns from the round's commit, because the launcher refuses another commit.

   ```bash
   bun bench/harbor/hill.ts rerun --round "$ROUND"
   bun bench/harbor/hill.ts rerun --round "$ROUND" --launch -- \
     --auth-profile <profile> --hosted --concurrency 20 --execute
   ```

   The rerun rules:

   - Each attempt slot that a measurement lost can run again at most 2 times, the board's rule.
   - The command refuses while any run of the round is `prepared` or `launched`, so a round with an unfinished run is never planned twice. For a `launched` run, the refusal names the `resume-hosted` command that settles it.
   - A run that ended before Harbor ran any trial (`snapshot_failed`, `hub_dry_run_refused`, or `hub_launch_refused`) measured nothing, so it plans no attempt, and the command lists it. For such a measurement, start a fresh measure run of its split.
   - The rerun sets `--benchmark`, `--task-names`, `--attempts`, `--round`, `--jobs-dir`, and the round's recorded `--arm` itself, and refuses each of them, and `--split`, after `--`, with an error that names the flag. Only a round recorded before rounds had an identity takes `--arm` after `--`.
   - A hub-broken task of the descriptor is not rerun: no agent can pass it on Harbor Hub.
   - Each generated command selects its tasks with `--task-names`, so it joins the round as a rerun. A command whose attempt count is below 3 adds `--allow-low-k`.

   Run the plan again after the reruns finalize, until it shows no open attempt that the cap allows.

6. Scan the passing trials for answer-key use. The scan writes `$JOBS/rounds/r3.answer-key.json`: each passing trial whose tool calls reached a code host, a dataset hub, an archive, or a search engine, and whether a URL names one of the benchmark's own published copies. A candidate is for review, not a verdict. A new scan keeps the verdicts that the record already holds.

   ```bash
   bun bench/harbor/hill.ts scan --round "$ROUND"
   ```

7. Review the candidates. In a Flywheel chat in this repository, ask the chat to launch the workflow file `bench/harbor/workflows/answer-key-review.workflow.yaml` with this input: `answer_key_file`, the absolute path of the answer-key file, and `trials`, the `trial` ids of its `candidates`. For each trial, one agent judges the trial against the board's answer-key rule and a second agent checks that verdict. Write the handoffs of the `checks` phase as a JSON list of `{ "trial", "verdict", "evidence" }`, with `verdict` `confirmed` or `cleared`. `flywheel events search --session <run> --type handoff.written --limit 0 --json` prints each handoff of the run. Then record the verdicts. A verdict for a trial that is not a candidate of the round is refused.

   ```bash
   bun bench/harbor/hill.ts verdicts --round "$ROUND" --from <verdicts.json>
   ```

8. Score the round against the board.

   ```bash
   bun bench/harbor/hill.ts score --round "$ROUND" --board
   ```

   The command prints the pass count of each task, the score of each split that the round measured (over all tasks, over scored tasks, and without hub-broken tasks), the grader-lost, infrastructure, and answer-key fail counts, and the estimated cost, with the number of settled trials, timeout snapshots, trials with unmeasured or unpriced usage, and trials without a store; the cost reads `at least` when any of the last three is not 0. It reads the measured splits from the manifests of the round's measure runs, so it reports no split that the round did not run. With `--board` it also prints the projected full score with its 90% interval and the fit when the round measured `subset`, and the board's field at the round's model and effort on the full stage: each harness with its rate and interval, best rate first, and the round's paired difference over every task that both the round and that harness scored, with the board's published leader marked. It reads the model and the chat effort from the round's identity; `--model <name> --effort <effort>` sets them, and a round recorded before rounds had an identity needs both. A model that the board does not rank still gets the projection.

### Whole-benchmark run

A run with neither `--split` nor `--task-names` runs every task of the pinned dataset except the descriptor's exclusions. That set is the board's whole benchmark: 87 tasks of Terminal-Bench 2.1 and 111 tasks of DeepSWE v1.1. The launcher lists the dataset's tasks with Harbor (`harbor_tasks.py --list <dataset> <ref>`), which downloads no task, and refuses the run when the dataset does not hold an excluded task. The run measures the reserved split `all` and joins its round as a measurement, so reruns, the scan, and the review work as in a round of splits.

This example runs the board-matched DeepSeek high arm on all of Terminal-Bench 2.1 on Harbor Hub, then scores the round against the board. Replace `<profile>`, `<owner/repo>`, `<name>`, and `<jobs dir>`.

```bash
bash bench/harbor/run-harbor.sh --benchmark terminal-bench-2.1 --arm bench/harbor/configs/tb-board-deepseek-high.toml --auth-profile <profile> --agent-repo <owner/repo> --hosted --concurrency 87 --round <name> --execute
bun bench/harbor/hill.ts score --round <jobs dir>/rounds/<name>.json --board
```

A round of all tasks prints no projection, because it measured the full benchmark itself. Its paired comparison with each harness of the board uses all 87 tasks.

## Bring-up with one task

Before a round on a new arm, a new commit, or a new benchmark, run one fast task once and iterate until it passes. The run checks one complete path through the launcher, the package, Harbor, Flywheel, the verifier, and finalization. It is `debug_only` and is not benchmark evidence. Without `--round`, it joins no round.

```bash
bash bench/harbor/run-harbor.sh --benchmark terminal-bench-2.1 --arm "$ARM" --auth-profile <profile> \
  --task-names kv-store-grpc --attempts 1 --allow-low-k --hosted --execute
```

A bring-up names its task with `--task-names` on every benchmark, also on a benchmark without splits, because a run with no task selection runs the whole benchmark.

## Add a benchmark

1. Add one `HarborBenchmark` descriptor to `benchmarks.ts` and add it to `HARBOR_BENCHMARKS`. The descriptor names the id, the Hub dataset and its exact ref, the task namespace, the board key (absent when the board does not rank the benchmark), the tasks that the board excludes with the board's reason for each, the hub-broken tasks with their evidence, whether the trial home carries the answer-key rule file, the names of the benchmark's own published copies for the answer-key scan, whether the grader downloads its tools from GitHub, and whether a local run seals the verifier's Python dependencies into a wheelhouse. Start with `splits: {}`. The dataset states the timeouts and the network mode of the agent phase, and the board states its strata, so the descriptor copies neither. The launcher needs the exclusions without the board's data, so the descriptor states them.
2. Fetch and verify the board's data for it: `bun bench/harbor/hill.ts board fetch --benchmark <id>`, then `board verify`, which exits 1 when the descriptor's exclusions differ from the board's.
3. Propose splits from the board's data:

   ```bash
   bun bench/harbor/hill.ts subset propose --benchmark <id> --size 14 --holdouts 14,20
   ```

   The command prints the pool, the fit figures of each list, and a `splits` block for the descriptor. Every figure is in-sample: the same board cells chose the lists, so the figures are optimistic and are not independent validation.
4. The person picks the splits. Paste the chosen lists into the descriptor's `splits`. The `subset` split is the one that projects to the full benchmark.
5. Bring up one task, then run the first round.

A benchmark without a board key runs and scores, but `board` commands, `subset propose`, and `score --board` refuse it.

## Agent package

Preparation builds the Harbor ACP agent package and pushes it to the agent repository, also for a dry run. The package holds only Git blobs of HEAD of the checkout where you run the launcher. Uncommitted and untracked files never enter it, so commit a change on a local branch or worktree before you launch it; the launcher prints the packaged commit. The launcher refuses the run when the arm config bytes at that commit differ from the validated config.

The package holds:

- the shim project under `harbor_agent/`, with `pyproject.toml` and `uv.lock`. They pin, by hash, the linux x86_64 wheel of the PyPI package `claude-agent-sdk` that bundles the Claude engine (see below);
- the arm config as `flywheel.toml`;
- `runtime/flywheel-linux-x64.tar.xz`: the compiled linux-x64 Flywheel executable `flywheel-bin`, which `scripts/build-binary.ts --target=bun-linux-x64` builds in a tree of the commit's blobs with that commit's `bun.lock`, plus the legal files and the linux-x64 native files. The archive leaves out the Claude engine, which is larger than Harbor's package limit, and the web client, fonts, and payload `build.json`, which an ACP trial does not use. The executable is a glibc build: a task image that has only musl cannot run it;
- `store-analysis/trial-store-analysis.js`: `bench/harbor/trial-store-analysis.ts` of the commit, bundled into one file with `bun build --target=bun`;
- `flywheel_harbor_agent/benchmark-rules.md`, only when the benchmark's descriptor sets `answerKeyRule`. The launcher passes `--answer-key-rule` or `--no-answer-key-rule` to the builder from the descriptor;
- `harbor-agent.json`, the manifest that Harbor reads;
- `BUILD.json`, which names the Flywheel commit, version, release tag, and the SHA-256 of the archive, the config, the store analysis bundle, the rules file, and each shim file, and under `claude_engine` the engine version and SHA-256 that the commit runs and the URL and SHA-256 of the pinned wheel.

A package is about 92.7 MB, against Harbor's source limit of 100 MiB, and the builder refuses a package past Harbor's limits. A build takes about 3.5 minutes. Harbor fetches the package at its exact published commit, in local Docker and on Hub.

The launcher chooses the publication path from the source identity alone, and no flag changes it:

- A package of a released Flywheel version, meaning a commit that a `vX.Y.Z` tag of the public repository names and that the public repository lists as a release, goes to the agent repository's `main` branch with the tag `flywheel-<vX.Y.Z>-<build id>`. The launcher reads the tags from the public repository with `git ls-remote`, never from local tags, so a local tag with a release name on a trial commit does not make it a release.
- Every other package, including any unreleased commit or bring-up trial, goes only to its own branch `build/<build id>`, never to `main`.

The build id is the first 12 hexadecimal characters of a digest of the commit, the archive, the config, the store analysis bundle, the shim files, and the rules file, so the same inputs reuse the same published commit. Everything pushed to the agent repository is public at once. The publisher pushes only these package refs, with Git trace2 events off so that no tool that watches them pushes its own refs beside the package, and it fails when the agent repository then holds any other ref.

### Claude engine

The Claude engine is about 290 MB, so the package cannot carry it. Harbor installs the package's shim project with `uv sync --frozen` in the setup phase, which has network on every benchmark, from the same PyPI that already serves Harbor's own setup. The shim's `uv.lock` pins the `claude-agent-sdk` wheel that bundles the engine at `claude_agent_sdk/_bundled/claude`, and uv refuses a wheel whose hash differs. The lock drops the wheel's Python dependencies, because only the engine runs, and the project refuses to build the package from source, because the source distribution holds no engine. This adds about 4 seconds and a 120 MiB download to the setup of every trial, of every arm.

Before Flywheel starts, the shim links the installed engine at `native/linux-x64/claude` of the extracted runtime, where a compiled Flywheel finds it, and refuses the trial when the engine is missing or its SHA-256 differs from `claude_engine.sha256` of `BUILD.json`. The builder reads that engine from the Agent SDK manifest (`node_modules/@anthropic-ai/claude-agent-sdk/manifest.json`, platform `linux-x64`) of the commit's `bun.lock`, downloads the pinned wheel once into `~/.cache/flywheel-harbor-wheels/` under its SHA-256, and refuses the build when the wheel's engine differs from the commit's engine, so the agent phase never runs another engine than the commit does.

When a commit moves `@anthropic-ai/claude-agent-sdk` in `bun.lock`, the build refuses until the pin follows it. Find the `claude-agent-sdk` release of PyPI whose bundled engine has the CLI version that the refusal names, set it in `harbor_agent/pyproject.toml`, and run `uv lock` in `harbor_agent/`. The two SDKs release the same engine under their own version numbers (TypeScript SDK 0.3.306 and Python SDK 0.2.170 both bundle engine 2.1.306), and PyPI may have no release for some engine versions; then move the TypeScript SDK to a version that has one.

## Trial auth snapshot

An executing run, and a hosted dry run, exports the trial auth snapshot on this host. It carries only the credential providers of the provider modules that the arm config leaves enabled, under the trial profile id `benchmark`, with access tokens that stay valid for the worst-case length of the job: every wave of trials at the slowest task's agent, verifier, and build timeouts, times the largest timeout multiplier, plus one hour. Its host stage is removed in every outcome, and the snapshot is then only in the launcher's memory and in the environment of the Harbor process that it starts.

- On Harbor Hub, the snapshot reaches the trial only as the job secret `FLYWHEEL_AUTH_SNAPSHOT` with `credential_mode: direct`. Hub accepts a secret of at most 16,384 characters, and the launcher refuses a longer snapshot.
- In local Docker, the generated config names the overlay `snapshot-environment.compose.yaml`, which declares `FLYWHEEL_AUTH_SNAPSHOT` for the agent container without a value, so Docker Compose copies it from Harbor's environment when it creates the container. It is in no file, command line, or log of the host. Harbor gets only that variable and an allowlist of Docker, cache, certificate, and temporary-directory variables. The value stays in the container's environment for the container's life, which covers the setup, agent, and verifier phases and `/proc/1/environ`. On the host, anyone who can use this Docker daemon can read it with `docker inspect` until Harbor removes the container.

Both are one-use snapshots of short-lived access tokens. In the trial, the shim removes the snapshot from its environment, writes it to an owner-only file, and starts Flywheel without it, so no Flywheel or tool process inherits it. The snapshot's tokens stay readable in `/proc/<shim pid>/environ` during the trial, also to a command of the same user that the agent runs, because a process cannot change the environment block that the kernel recorded when it started. The boundary of the snapshot is therefore the trial sandbox and the lifetime of its tokens.

An arm that enables the Claude engine route needs the long-lived token that the person makes once with `claude setup-token` (`docs/provider-terms.md`, section 9). The launcher reads the token from the macOS keychain item `flywheel-claude-oauth-token`, or the item that `--claude-token-keychain-item <name>` names, and else from its own `CLAUDE_CODE_OAUTH_TOKEN`. It gives the token only to the one snapshot export process, and the snapshot carries it to the trial, where only the Claude engine receives it. Never add `CLAUDE_CODE_OAUTH_TOKEN` as a Hub secret of its own: the shim passes every other variable to Flywheel, so the agent's shell commands would see it.

## In the trial

The shim checks the config, the runtime archive, the store analysis bundle, and the rules file against their SHA-256 in `BUILD.json`. It extracts the archive into a private work directory, links the Claude engine that the setup phase installed into it and checks the engine against `claude_engine.sha256`, installs the config as `$HOME/.flywheel/flywheel.toml` and, when the package has it, the rules file as `~/.agents/AGENTS.md`, links every other entry of the task image's own home into the trial home so that tools find the caches, toolchains, and user installs that the image set up under `~/go`, `~/.cargo`, `~/.rustup`, `~/.cache`, and `~/.local`, and starts `flywheel-bin --headless --acp --unattended --allow-persistent-processes` directly, with both ACP streams relayed line by line. The agent phase downloads and installs nothing, so it needs no network except the model host. A compiled build resolves its `browser` export condition at build time, so the shim passes no Bun flag.

The trial uses the unattended one-shot mode of PI-AGENT-121. It keeps the core prompt, the remaining engineering doctrine, the available tools, repository instructions, and checkpoint guidance. It omits built-in chat review, publication, and communication guidance, and the skill tool, its catalog, and ask_user. Flywheel returns the final reply after owned work settles, also while stdin stays open. Harbor's launcher changes into the package directory before it starts the shim, so the shim runs Flywheel in the cwd of Harbor's runner, which is the workspace that the runner sends in `session/new`. Flywheel keeps the task image's `PATH`, with the extracted runtime directory first.

When Flywheel answers the prompt as a settled turn, the shim holds that answer, closes Flywheel's stdin as Harbor would, and gives Flywheel two seconds to end before it stops it. After Flywheel exits, the shim copies the trial's event store, with the rows that only its WAL holds, into a private directory as one file that claims rollback journaling, because the copy is published without WAL sidecars and the analysis refuses a WAL-mode file that it opens in memory. Every evidence snapshot copies the live store the same way. Then the shim runs the store analysis bundle on that copy with the same `flywheel-bin` and `BUN_BE_BUN=1`, so the executable runs the script as Bun does. It writes the result, `flywheel-store-analysis.json`, into the agent logs: counts, booleans, tool names, interaction profile ids, the outcome of the last provider response, the usage summary, and the store's SHA-256 and size.

Next the shim publishes the debug evidence of the trial into `flywheel-evidence/` of the agent logs: the analyzed store copy itself, whose SHA-256 is the analysis's store identity, and every Flywheel diagnostic JSONL log that the trial wrote under the workspace and under the trial's home, as `.flywheel/flywheel.sqlite` and `.flywheel/log/`. Harbor scrubs secrets only in text files, so before it copies a file the shim scans its bytes for each credential value of the auth snapshot (each API key, OAuth access and refresh token, and token-login token of 12 or more characters) and withholds a file that holds one. Then the shim writes `flywheel-run-summary.json` and only then relays the held answer. Harbor's stop sequence closes stdin when it reads the answer, sends SIGTERM two seconds later, and SIGKILL two seconds after that, so it starts after the evidence is written.

Flywheel answers the prompt only when its headless channel settles, so a SIGTERM is recorded as `harbor-cancellation` only when the child had sent no answer that settles the turn: a prompt result whose stop reason is not `cancelled`, or an error response. After such a SIGTERM the export runs in its own process group and ends 1.6 seconds after it, so the summary is written before Harbor's SIGKILL; an export that the deadline ends leaves no analysis, and the summary names `export_deadline`. The publication of the debug evidence runs after the analysis, in a process group of its own under the same deadline, so it never costs the analysis or the trial: a publication that the deadline ends or that fails leaves whole files of its own or of the last snapshot in `flywheel-evidence/`, and the summary's `debug_evidence` names `publish_deadline` or `publish_failed:<cause>`. While Flywheel runs, the shim publishes the same tree every 15 seconds from a SQLite online backup of the live store, in a process group of its own, because at its agent timeout Harbor sends the shim no signal: it collects the agent logs at once while the shim and Flywheel still run, and in local Docker they run on into the verifier phase.

A local run on an arm64 host emulates the amd64 task images, so it is slower than Hub's native runs. Only a trial whose turn Harbor cancels analyzes its store inside the 1.6 seconds after SIGTERM, and under emulation it can withhold its analysis with `export_deadline`. A trial that reaches Harbor's agent timeout analyzes nothing and keeps the shim's last evidence snapshot only.

## Artifacts

Each run creates one timestamped artifact directory under the jobs directory, `<job name>-<time>`:

- `preparation-plan.json` records the commands and artifact paths that the launcher uses, the agent package, the snapshot providers, the worst-case job length, and the arm config path, SHA-256 digest, and chat effort.
- `generated.json` is the validated Harbor job config that the run passes to Harbor.
- `run_manifest.json` records the benchmark, the split and the round, the state (`prepared`, `launched`, `finalized`, or `refused`), seed provenance, the runtime source record (`mode: "git_commit"` and the packaged SHA), the agent package and its runtime archive digest, the hosts that an offline agent phase allows, the exact command, the denominator, the grade, and the effective settings. Its `profile_sha256` is the digest of everything that states the run: the benchmark and its dataset, the arm path and digest, the tasks, the attempts, the concurrency, the timeout multipliers, and the resource overrides. The trial records it too. The `flywheel_config` record holds the arm path, digest, and chat effort.
- `metadata.yaml` identifies the agent and primary model.
- `hub/<job name>/<trial>/` holds the trials of a hosted run that the launcher downloaded, and `harbor-jobs/<job name>/<trial>/` holds the trials of a local run, which Harbor writes there. The plan's `trials_directory` names the directory of the run's trials, and finalization and `hill.ts` read the trials from it.
- `disclosure-ledger.json` is written during finalization from real Harbor trial evidence. See METHODOLOGY.md, "Failure categories and precedence".
- Each trial's `agent/flywheel-run-summary.json` carries versioned settlement, cancellation, deadline-authority, and store identity evidence.
- Each trial's `agent/flywheel-store-analysis.json` is the content-free analysis of Flywheel's durable event store for that trial.
- Each trial's `agent/flywheel-evidence/` holds that trial's store and diagnostic logs in the layout of a project root, so a downloaded trial is debugged as a local session is: `flywheel events search --project-root <trial>/agent/flywheel-evidence --errors`. The store holds the conversation content of that one trial: the task, the model's replies, and its tool calls and their output. The logs hold ids, sizes, hashes, and kinds, never content, by the repository's logging rule. The run summary's `debug_evidence` lists the published paths and, by path, each file that the shim withheld and why: `credential:<kind>` for a file that holds a snapshot credential value (the kind names the field, such as `api_key.key`, never the value), or `unsafe_source` for a source that is a link, a FIFO or another non-regular file, has another owner, is writable by others, or has a second link. After each publication the shim examines every other entry of the tree again, and removes and lists each one that is not a regular file of the shim's user free of credential values: `credential:<kind>`, or `unsafe_entry` for a link, a directory, or another entry that the trial planted there. A file whose name holds a credential value is listed under a numbered placeholder, never under its name. A trial whose tool printed a credential therefore publishes no store; its analysis and its logs are still published. A trial that reached Harbor's agent timeout has only the last successful snapshot, with no run summary and no store analysis. A snapshot that fails or reaches its deadline keeps the one before it, so this snapshot can be older than one interval.

The round records are under `<jobs dir>/rounds/`:

- `<name>.json` lists the round's benchmark, its identity, and its runs, each with its artifact directory, its purpose (`measure` or `rerun`), and the split of a measurement. It is replaced by rename under the lock file `<name>.json.lock`, so concurrent appends all land and a reader never sees half of it.
- `<name>.answer-key.json` holds the scan's candidates and the review's verdicts: trial ids, hosts, URLs, and verdict evidence, never transcript text.

The board data is a cache, never part of the repository, at `~/.cache/flywheel/harbor-board` (`--cache <dir>` changes it). `objects/` holds each downloaded file under its content hash, and `snapshots/<board key>.json` names the objects of the last fetch of that benchmark. A fetch writes its snapshot only when every download succeeded, so a fetch that stops part way keeps the last snapshot whole, and a later fetch reuses the objects that it already holds.

Harbor's `result.json` remains the authority for trial identity, verifier reward, and exception. The trial cost reader is the authority for cost: it takes the usage summary of the store analysis, or prices the published store of a trial without one, such as a timed-out trial's last snapshot. Harbor-reported cost is not used. Finalization reconciles Harbor's result and the store analysis against the exact task count times attempts denominator, the same way for a local and a hosted run. Missing, malformed, duplicate, or unexpected evidence produces `trials_unverified` and a nonzero exit even when Harbor exits zero.

## Validation

Run the local checks without provider spend:

```bash
bun run lint:bench
bun run lint:doc-coherence
bun run lint:doc-src-paths
bun test tests/unit/bench/harbor-*.test.ts
cd bench/harbor && "$(dirname "$(realpath "$(command -v harbor)")")/python" -m unittest test_harbor_agent_package test_harbor_agent_shim test_verifier_wheelhouse
```

The Python tests run with Harbor's own Python, because the package checks import Harbor's models.

Leaderboard submission (PR, upload, and review) is outside the scope of this system. It prepares auditable local and submission-shaped evidence; it does not submit it.
