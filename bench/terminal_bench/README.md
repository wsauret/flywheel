# Terminal-Bench 2.1

This directory contains Flywheel's Terminal-Bench 2.1 run launcher, Harbor ACP agent package, profiles, evidence reconciliation, and local validation. Use `run-terminal-bench.sh` for every preparation and execution. Do not invoke Harbor directly. The launcher resolves a profile and command-line overrides, builds and publishes the run's agent package, writes a generated named JSON config, validates it with Harbor's own config model, and runs Harbor only after validation.

There is one execution path. Every trial, in local Docker or on Harbor Hub, runs Harbor's `acp` agent on the same agent package, which runs `flywheel --headless --acp` in the task workspace and records the same evidence. Only where the trial runs differs. The profiles of campaigns that ran on the earlier `--headless --task` installed-agent adapter live in Git history before the change that removed it, and their results are not comparable with runs of the agent package.

## Requirements

A local run requires Docker; every run requires the Harbor CLI, a public agent repository on GitHub that this host can push to, and a Flywheel auth profile with credentials for the arm's provider. A dry run still requires Harbor because preparation validates the generated config and records the Harbor version. Select the auth profile with the required `--auth-profile <id>` launcher flag, and the agent repository with `--agent-repo <owner/repo>` or `FLYWHEEL_TB_AGENT_REPO`. Harbor never sees an ambient provider credential or a provider selector: the trial's one credential is the auth snapshot that the launcher exports.

The read-only verifier dependency wheelhouse of a local run is mounted at `/opt/flywheel-verifier-wheelhouse`. It is not evidence.

## Prepare

Preparation is dry-run by default. It makes no Harbor trials and no model requests, but it builds and publishes the agent package, so the dry run proves the package of the exact commit.

```bash
bench/terminal_bench/run-terminal-bench.sh \
  --auth-profile <profile> --agent-repo <owner/repo> \
  --config bench/terminal_bench/profiles/tb-mini-bringup-kv-store-grpc.yaml \
  --allow-low-k --dry-run
```

Replace `<profile>` with the name of the Flywheel auth profile whose provider logins the campaign uses.

The defaults are `k=5`, concurrency `4`, timeout multipliers `1.0`, and no resource overrides. A profile can set these values. Every run must select an explicit bounded task list, either in the profile or with `--task-names`. Copy an existing profile to a new named profile before changing a campaign. The generated `generated.json`, not the source YAML profile, is the exact config passed to Harbor.

## Execute a campaign

`--execute` authorizes provider spend and container work. Review the preparation plan and generated config from a dry run before executing the same named profile. Without `--hosted`, the trials run in local Docker. A run on an arm64 host emulates the amd64 task images, so it is slower than Hub's native runs. Under that emulation, the store analysis takes about 1.5 seconds on one CPU. A settled trial analyzes its store before the shim relays the answer, so Harbor's stop sequence does not bound it; only a trial that Harbor stops at its timeout analyzes its store inside the 1.6 seconds after SIGTERM, and can withhold its analysis with `export_deadline` under emulation.

```bash
bench/terminal_bench/run-terminal-bench.sh \
  --auth-profile <profile> --agent-repo <owner/repo> \
  --config bench/terminal_bench/profiles/tb-mini-bringup-kv-store-grpc.yaml \
  --allow-low-k --execute
```

Dirty Git provenance never blocks or changes a campaign grade. The manifest records the exact revision, clean boolean, and dirty paths for later manual audit.

The launcher rejects non-submission settings unless the matching local admission flag is explicit:

- `--allow-low-k` admits fewer than five attempts per task.
- `--allow-timeout-multipliers` admits a timeout multiplier other than `1.0`.
- `--allow-resource-overrides` admits environment resource overrides. Harbor Hub refuses them.

`k=1` is always `debug_only`. Other admitted non-submission settings are `local_low_k`. Neither grade is leaderboard-valid.

The bring-up profile `tb-mini-bringup-kv-store-grpc.yaml` runs one fast task once; iterate on it until it passes. This `k=1` run is `debug_only`: it checks one complete launcher, package, Harbor, Flywheel, verifier, and finalization path, and it is not benchmark evidence. The mini profile `tb-mini-openai-5x.yaml` runs the 12 non-cyber tasks of the subset at `k=5`. Every preparation resolves each task name through Harbor's dataset resolution and refuses a name that matches no task.

## Flywheel config

Every profile names a checked-in Flywheel config with `headless.flywheel_config`, a path relative to the repository root, such as `bench/terminal_bench/configs/tb-mini-openai.toml`. The config sets the trial's modules and settings, persistent processes included, and pins the chat model and effort in `[profiles.benchmark.roles.chat]`. It is the only source of the chat model and of the trial's tools: a profile turns a tool off by disabling the module that contributes it in `disabled_modules`, as the arm configs do for `web`, `subagents`, and `papercuts`. Before any trial, also in a dry run, the launcher decodes the file with Flywheel's own config schema and refuses the run on any error or warning, naming the file and the problem. An unknown key, such as an interaction profile, is a warning and refuses the run. A profile without `headless.flywheel_config`, or with the removed `headless.model`, `headless.disabled_tools`, or `headless.system_prompt`, is refused, and the launcher has no `--model` flag.

The package carries the config, and the trial installs it as `$HOME/.flywheel/flywheel.toml` and runs Flywheel under the neutral auth profile id `benchmark`, so the config names no host profile.

## Agent package

Preparation builds the Harbor ACP agent package and pushes it to the agent repository. The package holds only Git blobs of one exact Flywheel commit: the profile's `headless.runtime_source_commit`, or HEAD when the profile names no pin. Uncommitted and untracked files never enter it, so commit a change on a local branch or worktree before you launch it; the launcher prints the packaged commit. A pin must name a commit in the public history, so that a public clone can build it; `bun run lint:bench-pins` fails on a profile whose pin is not an ancestor of HEAD. The package holds the shim project under `harbor_agent/`, the arm config as `flywheel.toml`, the runtime archive of that commit, `harbor-agent.json`, and `BUILD.json`, which names the Flywheel commit, version, release tag, archive digest, and config digest. The launcher refuses the run when the arm config bytes at the commit differ from the validated config. Harbor fetches the package at its exact published commit, in local Docker and on Hub alike.

The launcher chooses the publication path from the source identity alone, and no flag changes it:

- A package of a released Flywheel version, meaning a commit that a `vX.Y.Z` tag of the public repository names and that the public repository lists as a release, goes to the agent repository's `main` branch with the tag `flywheel-<vX.Y.Z>-<build id>`. The launcher reads the tags from the public repository with `git ls-remote`, never from local tags, so a local tag with a release name on a trial commit does not make it a release.
- Every other package, including any unreleased commit or bring-up trial, goes only to its own branch `build/<build id>`, never to `main`.

The build id is the first 12 hexadecimal characters of a digest of the commit, archive, config, and shim files, so the same inputs reuse the same published commit. Everything pushed to the agent repository is public at once. The publisher pushes only these package refs, with Git trace2 events off so that no tool that watches them pushes its own refs beside the package, and it fails when the agent repository then holds any other ref.

## Trial auth snapshot

An executing run, and a hosted dry run, exports the trial auth snapshot on this host. It carries only the credential providers of the provider modules that the arm config leaves enabled, under the trial profile id `benchmark`, with access tokens that stay valid for the job's worst-case length: every wave of trials at the slowest task's agent, verifier, and build timeouts, plus one hour. Its host stage is removed in every outcome, and the snapshot is then only in the launcher's memory and in the environment of the Harbor process it starts.

- On Harbor Hub, the snapshot reaches the trial only as the job secret `FLYWHEEL_AUTH_SNAPSHOT` with `credential_mode: direct`.
- In local Docker, the generated config names the overlay `snapshot-environment.compose.yaml`, which declares `FLYWHEEL_AUTH_SNAPSHOT` for the agent container without a value, so Docker Compose copies it from Harbor's environment when it creates the container. It is in no file, command line, or log of the host. Harbor gets only that variable and an allowlist of Docker, cache, certificate, and temporary-directory variables. The value stays in the container's environment for the container's life, which covers the setup, agent, and verifier phases and `/proc/1/environ`. On the host, anyone who can use this Docker daemon can read it with `docker inspect` until Harbor removes the container.

Both are one-use snapshots of short-lived access tokens. In the trial, the shim removes the snapshot from its environment, writes it to an owner-only file, and starts Flywheel without it, so no Flywheel or tool process inherits it. The snapshot's tokens stay readable in `/proc/<shim pid>/environ` during the trial, also to a command of the same user that the agent runs, because a process cannot change the environment block that the kernel recorded when it started. The boundary of the snapshot is therefore the trial sandbox and the lifetime of its tokens.

The Claude arm, `configs/tb-mini-claude.toml`, runs Flywheel's Claude engine route on the person's Claude subscription with Sonnet 5.5 at medium effort. Its trial has no Claude login, so it runs on a long-lived token that the person makes once with `claude setup-token` (`docs/provider-terms.md`, section 9). The launcher reads the token from the macOS keychain item `flywheel-claude-oauth-token`, or the item that `--claude-token-keychain-item <name>` names, and else from its own `CLAUDE_CODE_OAUTH_TOKEN`. It gives the token only to the one snapshot export process, and the snapshot carries it to the trial, where only the Claude engine receives it. Never add `CLAUDE_CODE_OAUTH_TOKEN` as a Hub secret of its own: the shim passes every other variable to Flywheel, so the agent's shell commands would see it. Its profiles are `tb-mini-claude-bringup-kv-store-grpc.yaml` and `tb-mini-claude-14x1.yaml`.

The DeepSeek board arms, `configs/tb-board-deepseek-low.toml` and `configs/tb-board-deepseek-high.toml`, match the settings of the [harness leaderboard](https://huggingface.co/spaces/joelniklaus/harness-leaderboard) so that Flywheel can be placed beside the harnesses that it ranks. They run the September release of DeepSeek-V4.1-Flash at reasoning effort low or high, on the person's OpenRouter API key, with OpenRouter restricted to DeepInfra's fp8 endpoint and no fallback, because the board serves that model from DeepInfra. Automatic titles use the same route, so no other model runs in a trial. Their profiles run the 14 tasks 3 times each, as the board does, with the board's tripled environment build timeout, which needs `--allow-timeout-multipliers`: `tb-board-deepseek-low-3x.yaml` and `tb-board-deepseek-high-3x.yaml`, and the bring-up profile `tb-board-deepseek-bringup-kv-store-grpc.yaml`.

## Run on Harbor Hub

`--hosted` runs the campaign on Harbor Hub instead of local Docker, with every trial at once up to the profile's concurrency. It refuses `--prebuild` and resource overrides. Optionally name the Hub organization with `--organization <name>` or `FLYWHEEL_TB_HUB_ORG`; without one, the job is the signed-in Hub user's own.

```bash
bench/terminal_bench/run-terminal-bench.sh \
  --auth-profile <profile> --agent-repo <owner/repo> \
  --config bench/terminal_bench/profiles/tb-mini-bringup-kv-store-grpc.yaml \
  --allow-low-k --hosted --dry-run
```

Hub's free dry run runs first, and a dry run stops there. An executing run then launches the job, waits for it, downloads its trials under the artifact directory's `hub/` folder, and finalizes them.

## In the trial

The shim installs Bun, the runtime, the config, and the package's trial store analysis, and runs `flywheel --headless --acp` with both ACP streams relayed line by line. Harbor's launcher changes into the package directory before it starts the shim, so the shim runs Flywheel in the cwd of Harbor's runner, which is the workspace that the runner sends in `session/new`. Flywheel keeps the task image's `PATH`. When Flywheel answers the prompt as a settled turn, the shim holds that answer, closes Flywheel's stdin as Harbor would, and gives Flywheel two seconds to end before it stops it. After Flywheel exits, the shim copies the trial's event store into a private directory and runs the trial store analysis on that copy. The package builder bundles `bench/terminal_bench/trial-store-analysis.ts` of the packaged commit with `bun build --target=bun` into one file, `store-analysis/trial-store-analysis.js`, whose digest `BUILD.json` records, so that the trial loads one prebuilt file instead of each `src/` module. It writes only the result, `flywheel-store-analysis.json`, into the agent logs: counts, booleans, tool names, interaction profile ids, the outcome of the last provider response, the estimated cost of the priced usage, and the store's SHA-256 and size. The store itself never goes into the logs, because Harbor scrubs secrets only in text files. Then the shim writes `flywheel-run-summary.json` and only then relays the held answer, so Harbor's stop sequence, which closes stdin when it reads the answer, sends SIGTERM two seconds later, and SIGKILL two seconds after that, starts after the evidence is written. Flywheel answers the prompt only when its headless channel settles, so a SIGTERM is recorded as `harbor-cancellation` only when the child had sent no answer that settles the turn: a prompt result whose stop reason is not `cancelled`, or an error response. After such a SIGTERM the export runs in its own process group and ends 1.6 seconds after it, so the summary is written before Harbor's SIGKILL; an export that the deadline ends leaves no analysis, and the summary names `export_deadline`.

## Artifacts

Preparation creates one timestamped artifact directory under the configured jobs directory:

- `preparation-plan.json` records commands and artifact paths used by the launcher, the agent package, and the Flywheel config path, SHA-256 digest, and chat effort.
- `generated.json` is the validated named Harbor config used for execution.
- `run_manifest.json` records seed provenance, the runtime source record, the agent package and its runtime archive digest, exact command, denominator, grade, and effective settings. The runtime source record contains `mode: "git_commit"` plus the requested and canonically resolved SHA. The `flywheel_config` record holds the config path, SHA-256 digest, and chat effort.
- `metadata.yaml` identifies the agent and primary model.
- `disclosure-ledger.json` is written during finalization from real Harbor trial evidence. A trial that ends on the provider's refusal of its content, such as the ChatGPT backend's `cyber_policy` or an Anthropic content-filter stop that outlasts Flywheel's retries, counts as `provider_refusal`: a scored failure of the arm that stays in the denominator, never `provider_infra`.
- Each trial's `agent/flywheel-run-summary.json` carries versioned settlement, cancellation, deadline-authority, and store identity evidence.
- Each trial's `agent/flywheel-store-analysis.json` is the content-free analysis of Flywheel's durable event store for that trial. The store stays in the sandbox.

The runtime archive holds only regular Git blobs of the packaged commit under the allowed source roots and file list, with secret-shaped names excluded, plus both Linux ripgrep addons and the tokenizer assets. Every run summary names the archive digest that the manifest recorded at build time.

Harbor's `result.json` remains the authority for trial identity, verifier reward, exception, and Harbor-reported cost. The store analysis supplies the outcome of the last provider response and the estimated cost, which stands in for Harbor's cost only when Harbor reports none. Finalization reconciles both sources against the exact task count times `k` denominator, the same way for a local and a hosted run. Missing, malformed, duplicate, or unexpected evidence produces `trials_unverified` and a nonzero exit even when Harbor exits zero.

See [METHODOLOGY.md](METHODOLOGY.md) for evidence contracts, classification, and deadline policy.

## Validation

Run the local Terminal-Bench checks without provider spend:

```bash
bun run lint:bench
bun run lint:doc-coherence
bun run lint:doc-src-paths
```

Actual leaderboard submission PR, upload, and review mechanics are outside this integration's supported scope. The harness prepares auditable local and submission-shaped evidence; it does not submit it.
