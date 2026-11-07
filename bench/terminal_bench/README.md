# Terminal-Bench 2.1

This directory contains Flywheel's Terminal-Bench 2.1 adapter, run launcher, profiles, evidence reconciliation, and local validation. Use `run-terminal-bench.sh` for every preparation and execution. Do not invoke Harbor directly. The launcher resolves a profile and command-line overrides, writes a generated named JSON config, validates that effective config with Harbor's `JobConfig`, and runs `harbor run -c <generated.json>` only after validation.

## Requirements

An executing run requires Docker, the Harbor CLI, and a Flywheel auth profile with credentials for ordinary auto-routing. A dry run still requires Harbor because preparation validates the generated config and records the Harbor version. Select the profile with the required `--auth-profile <id>` launcher flag. The trusted adapter snapshots that complete selected profile and does not pass ambient provider credentials or a provider selector to Harbor.

Optional `FLYWHEEL_TB_CACHE_DIR` enables a writable host download cache mounted at `/opt/flywheel-download-cache`. This cache is separate from the read-only verifier dependency wheelhouse mounted at `/opt/flywheel-verifier-wheelhouse`. Do not point both mounts at one directory or treat either mount as evidence.

## Prepare without spend

Preparation is dry-run by default. It makes no Harbor trials and no model requests.

```bash
bench/terminal_bench/run-terminal-bench.sh \
  --auth-profile <profile> \
  --config bench/terminal_bench/profiles/gpt-6-luna-shell-smoke.yaml \
  --dry-run
```

Replace `<profile>` with the name of the Flywheel auth profile whose provider logins the campaign uses.

The defaults are `k=5`, concurrency `4`, timeout multipliers `1.0`, and no resource overrides. A profile can set these values. Every run must select an explicit bounded task list, either in the profile or with `--task-names`. Copy an existing profile to a new named profile before changing a campaign. The generated `generated.json`, not the source YAML profile, is the exact config passed to Harbor.

## Execute a campaign

`--execute` authorizes provider spend and container work. Review the preparation plan and generated config from a dry run before executing the same named profile.

```bash
bench/terminal_bench/run-terminal-bench.sh \
  --auth-profile <profile> \
  --config bench/terminal_bench/profiles/gpt-6-luna-shell-smoke.yaml \
  --execute
```

Dirty Git provenance never blocks or changes a campaign grade. The manifest records the exact revision, clean boolean, and dirty paths for later manual audit. When `headless.runtime_source_commit` is set, the adapter builds the runtime archive only from regular Git blobs at that exact commit. It ignores modified, deleted, symlinked, and untracked worktree state. Without a pin, the existing worktree selection behavior remains active. A pin must name a commit in the public history, so that a public clone can build it; `bun run lint:bench-pins` fails on a profile whose pin is not an ancestor of HEAD. The checked-in profiles name no pin. The campaign profiles that pinned builds from before the public history were removed; results recorded with them come from those earlier builds and need a new baseline.

## Flywheel config

A profile can name a checked-in Flywheel config with `headless.flywheel_config`, a path relative to the repository root, such as `bench/terminal_bench/configs/tb-mini-openai.toml`. The config sets the trial's modules and settings, persistent processes included, and pins the chat model and effort in `[profiles.benchmark.roles.chat]`. Before any trial, also in a dry run, the launcher decodes the file with Flywheel's own config schema and refuses the run on any error or warning, naming the file and the problem. An unknown key, such as an interaction profile, is a warning and refuses the run. The config is the only source of the chat model: a profile that also sets `headless.model`, or a run with `--model`, is refused, and the config must pin both model and effort.

The adapter checks the file against the digest the launcher recorded, uploads it into the trial as `$HOME/.flywheel/flywheel.toml`, exports the selected auth profile's credentials under the neutral profile id `benchmark`, and runs Flywheel with `--auth-profile benchmark`, so the config names no host profile. It sets no chat model or effort environment variable. A profile without `headless.flywheel_config` keeps the `headless.model` path and the trial default config.

The launcher rejects non-submission settings unless the matching local admission flag is explicit:

- `--allow-low-k` admits fewer than five attempts per task.
- `--allow-timeout-multipliers` admits a timeout multiplier other than `1.0`.
- `--allow-resource-overrides` admits environment resource overrides.

`k=1` is always `debug_only`. Other admitted non-submission settings are `local_low_k`. Neither grade is leaderboard-valid.

## Conditional paid smoke

The smoke is conditional on working Docker and Harbor installations plus a Flywheel auth profile with GitHub Copilot OAuth credentials. It is paid. Run it only when a live integration check is required:

```bash
bench/terminal_bench/run-terminal-bench.sh \
  --auth-profile <profile> \
  --config bench/terminal_bench/profiles/finalization-kv-store-grpc-gpt-6-luna.yaml \
  --allow-low-k \
  --execute
```

This `k=1` smoke is `debug_only`. It checks one complete launcher, generated-config, Harbor, Flywheel agent, verifier, and finalization path. It is not benchmark evidence and must not be reported as submission-shaped results.

## Run on Harbor Hub

`--hosted` runs the campaign on Harbor Hub instead of local Docker, with every trial at once up to the profile's concurrency. It requires a profile with `headless.flywheel_config`, and it refuses `headless.disabled_tools`, `headless.system_prompt`, `--prebuild`, and resource overrides, because the trial gets only what the agent package holds. Name the public agent repository with `--agent-repo <owner/repo>` or `FLYWHEEL_TB_AGENT_REPO`, and optionally the Hub organization with `--organization <name>` or `FLYWHEEL_TB_HUB_ORG`; without one, the job is the signed-in Hub user's own.

```bash
bench/terminal_bench/run-terminal-bench.sh \
  --auth-profile <profile> \
  --config bench/terminal_bench/profiles/tb-mini-bringup-kv-store-grpc.yaml \
  --allow-low-k --hosted --agent-repo <owner/repo> \
  --dry-run
```

Preparation builds the Harbor ACP agent package and pushes it to the agent repository, also in a dry run, because Hub's dry run validates the published commit. The package holds only Git blobs of one exact Flywheel commit: the profile's `headless.runtime_source_commit`, or HEAD when the profile names no pin. Uncommitted and untracked files never enter it, so commit a change on a local branch or worktree before you launch it; the launcher prints the packaged commit. The package holds the shim project under `harbor_agent/`, the arm config as `flywheel.toml`, the runtime archive of that commit, `harbor-agent.json`, and `BUILD.json`, which names the Flywheel commit, version, release tag, archive digest, and config digest. The launcher refuses the run when the arm config bytes at the commit differ from the validated config.

The launcher chooses the publication path from the source identity alone, and no flag changes it:

- A package of a released Flywheel version, meaning a commit that a `vX.Y.Z` tag of the public repository names and that the public repository lists as a release, goes to the agent repository's `main` branch with the tag `flywheel-<vX.Y.Z>-<build id>`. The launcher reads the tags from the public repository with `git ls-remote`, never from local tags, so a local tag with a release name on a trial commit does not make it a release.
- Every other package, including any unreleased commit or bring-up trial, goes only to its own branch `build/<build id>`, never to `main`.

The build id is the first 12 hexadecimal characters of a digest of the commit, archive, config, and shim files, so the same inputs reuse the same published commit. Everything pushed to the agent repository is public at once. The publisher pushes only these package refs, with Git trace2 events off so that no tool that watches them pushes its own refs beside the package, and it fails when the agent repository then holds any other ref.

Then the launcher exports the trial auth snapshot on this host. It carries only the credential providers of the provider modules that the arm config leaves enabled, under the trial profile id `benchmark`, with access tokens that stay valid for the job's worst-case length: every wave of trials at the slowest task's agent, verifier, and build timeouts, plus one hour. The snapshot reaches Hub only as the job secret `FLYWHEEL_AUTH_SNAPSHOT` with `credential_mode: direct`, and its host stage is removed in every outcome. Hub's free dry run runs first, and a dry run stops there. An executing run then launches the job, waits for it, downloads its trials under the artifact directory's `hub/` folder, and finalizes them.

In the trial, the shim removes the snapshot from its environment, writes it to an owner-only file, installs Bun, the runtime, the config, and the package's trial store analysis, and runs `flywheel --headless --acp` with Harbor's ACP stdin passed through and its stdout relayed line by line. Harbor's launcher changes into the package directory before it starts the shim, so the shim runs Flywheel in the cwd of Harbor's runner, which is the workspace that the runner sends in `session/new`. Flywheel keeps the task image's `PATH`, as in a local run. After Flywheel exits, the shim copies the trial's event store into a private directory and runs `bench/terminal_bench/trial-store-analysis.ts` of the packaged commit on that copy. It writes only the result, `flywheel-store-analysis.json`, into the agent logs: counts, booleans, tool names, interaction profile ids, and the store's SHA-256 and size. The store itself never goes into the logs, because Harbor scrubs secrets only in text files. Then the shim writes `flywheel-run-summary.json`. Harbor closes stdin when the prompt is answered and sends SIGTERM two seconds later. Flywheel answers the prompt only when its headless channel settles, so a SIGTERM is recorded as `harbor-cancellation` only when the shim had relayed no answer that settles the turn: a prompt result whose stop reason is not `cancelled`, or an error response. The export runs in its own process group and ends 2.5 seconds after Flywheel exits, or 1.6 seconds after Harbor's SIGTERM, so the summary is written before Harbor's SIGKILL; an export that the deadline ends leaves no analysis, and the summary names `export_deadline`.

The snapshot's tokens stay readable in `/proc/<shim pid>/environ` during the trial, also to a command of the same user that the agent runs, because a process cannot change the environment block that the kernel recorded when it started. The shim receives the job secret as an environment variable. The boundary of the snapshot is therefore the trial sandbox and the lifetime of its tokens.

The bring-up profile `tb-mini-bringup-kv-store-grpc.yaml` runs one fast task once; iterate on it until it passes. The mini profile `tb-mini-openai-5x.yaml` runs the 12 non-cyber tasks of the subset at `k=5`. Every preparation, local or hosted, resolves each task name through Harbor's dataset resolution and refuses a name that matches no task.

## Artifacts

Preparation creates one timestamped artifact directory under the configured jobs directory:

- `preparation-plan.json` records commands and artifact paths used by the launcher, and the Flywheel config path, SHA-256 digest, and chat effort, or `null` without one.
- `generated.json` is the validated named Harbor config used for execution.
- `run_manifest.json` records seed provenance, the runtime source record, exact command, denominator, grade, effective settings, and environment variable names only. Pinned records contain `mode: "git_commit"` plus the requested and canonically resolved SHA. Unpinned records contain `mode: "worktree"`. The `flywheel_config` record holds the config path, SHA-256 digest, and chat effort, or `null` without one.
- `metadata.yaml` identifies the named `FlywheelHeadless` agent and primary model.
- `disclosure-ledger.json` is written during finalization from real Harbor trial evidence.
- Each trial's `agent/flywheel-run-summary.json` carries versioned termination, cancellation, deadline-authority, and usage evidence.
- Each local trial's `agent/state/.flywheel/flywheel.sqlite` is Flywheel's durable event store for that trial. A hosted trial holds `agent/flywheel-store-analysis.json`, the content-free analysis of that store, in its place.

In unpinned mode, safe untracked runtime files under the allowed source roots and file list are included automatically. Unsafe paths and secret names or suffixes are excluded from the archive. In pinned mode, only allowed Git-object bytes and both required ripgrep addons are included. Each trial's existing source archive digest sidecar is the evidence for the exact archive bytes.

Harbor's `result.json` remains the authority for trial identity, verifier reward, exception, and Harbor-reported cost. The Flywheel sidecar supplies termination and usage evidence. Finalization reconciles both sources against the exact task count times `k` denominator. Missing, malformed, duplicate, or unexpected evidence produces `trials_unverified` and a nonzero exit even when Harbor exits zero.

See [METHODOLOGY.md](METHODOLOGY.md) for evidence contracts, classification, and deadline policy.

## Validation

Run the local Terminal-Bench checks without provider spend:

```bash
bun run lint:bench
bun run lint:doc-coherence
bun run lint:doc-src-paths
```

Actual leaderboard submission PR, upload, and review mechanics are outside this integration's supported scope. The harness prepares auditable local and submission-shaped evidence; it does not submit it.
