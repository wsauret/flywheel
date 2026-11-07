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

## Artifacts

Preparation creates one timestamped artifact directory under the configured jobs directory:

- `preparation-plan.json` records commands and artifact paths used by the launcher.
- `generated.json` is the validated named Harbor config used for execution.
- `run_manifest.json` records seed provenance, the runtime source record, exact command, denominator, grade, effective settings, and environment variable names only. Pinned records contain `mode: "git_commit"` plus the requested and canonically resolved SHA. Unpinned records contain `mode: "worktree"`.
- `metadata.yaml` identifies the named `FlywheelHeadless` agent and primary model.
- `disclosure-ledger.json` is written during finalization from real Harbor trial evidence.
- Each trial's `agent/flywheel-run-summary.json` carries versioned termination, cancellation, deadline-authority, and usage evidence.
- Each trial's `agent/state/.flywheel/flywheel.sqlite` is Flywheel's durable event store for that trial.

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
