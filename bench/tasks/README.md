# Benchmark task corpora

## Planning tasks

Planning tasks live under `planning/<id>/`. The planning campaign family (`bun run bench:planning`, refer to `../chat-ab/README.md`, "Planning") loads them, and its `PLANNING_TASKS_DIR` constant names the folder. A task has four files:

- `brief.md` is the person's request. The harness sends it unchanged, then one fixed instruction to write the plan to `PLAN.md`.
- `task.json` is `{ "id", "stratum", "timeoutMinutes", "sandbox" }`, decoded strictly. `id` equals the folder name. `sandbox` is `"greenfield"`, which provisions an empty repository through the empty Git tree, or `{ "commit", "paths" }`: an immutable selector (a full commit hash, optionally `:<subtree>`) and the non-empty list of paths that `git archive` copies. There is no `patch`, `setup`, or snapshot sandbox, and no `bun install` runs.
- `manifest.json` (optional) is `{ "mustAddress": [{ "id", "title", "catchCriteria" }], "falsePremises"?: ["<id>"] }`. The points are the known requirements that recall scoring and the pairwise judge read. `falsePremises` lists the ids of the points that refute a false claim of the brief. A task with no manifest, such as a greenfield task, has no recall score.
- `WHY.md` explains why the task exists. Its section "Verification at the pinned tree" gives one `path:line` at the pinned tree for every claim of each point, and states that the requested feature is absent there. The evidence goes in `WHY.md`, never in the manifest, because the judge reads the manifest.

`paths` never includes `bench` or `inspiration`: `bench` holds this answer key, and the loader refuses both. Before setup runs a cell, the harness checks that every backticked repository path of the manifest exists at the pinned tree.

## Implement tasks

Implement tasks live under `implement/<id>/`: `task.json`, a contract-valid recorded `plan.json`, `manifest.json`, a fixture repository or commit-pinned sandbox, and hidden `acceptance/` tests. The direct persona benchmark loads them.

Implement capture retains the diff before it installs the hidden acceptance tests.

Implement task files:

- `task.json` contains `{ "id", "stratum" }`. Optional: `sandbox` selects a commit-pinned sandbox `{ "commit", "paths", "patch"?, "setup"? }` instead of `project/`: the harness materializes `git archive` of this repository at that commit restricted to `paths`, applies the optional `patch` (task-dir relative) on top, commits the result as the baseline, then runs the optional `setup` commands (e.g. `[["bun", "install"]]`) so their artifacts stay out of the baseline and the diff.
- `plan.json` contains a plan that the `implementation-plan.json` output contract accepts.
- `project/` is copied into the sandbox and committed as the baseline with `.flywheel/` ignored (unless `sandbox` names a commit).
- `acceptance/` contains hidden Bun tests. The harness copies it only after capturing the implementation diff, then runs `bun test acceptance`.
- `manifest.json` contains `traps` and `judgment` arrays whose entries contain `id`, `title`, and `catchCriteria`.

### Native tasks in the shared corpus

The direct persona benchmark also discovers native tasks in `implement/`.

A native `task.json` declares `kind: "native"`, `id`, `stratum`, `family`, `split` (`development` or `evaluation`), a task-relative `instruction` file, and `native: { "command": ["<runtime>", "<task-relative-script>", "...fixed arguments"], "timeoutMs": <positive integer> }`. Optional `timeoutMinutes` remains the candidate timeout. Optional `native.path` lists workspace-relative directories, such as `[".bench-home/python/bin"]`, that lead the candidate's `PATH` in the declared order, the way an activated virtual environment does. Loading rejects absolute, drive-rooted, empty, and `..` entries. Only the candidate's process sees the prefix; `prepare` and `grade` keep their own environment. The instruction is UTF-8 and is passed without trimming or newline normalization. Native tasks have no `plan.json`, Bun acceptance directory, or `sandbox` configuration. Family and split are recorded metadata, not automatic evaluation-split enforcement.

The adapter runs as an owned subprocess, never as a host-process import. The runner appends positional arguments:

- `prepare <task-dir> <workspace>`: prepare original source and dependencies in the fresh workspace. Do not create a Git baseline; the runner creates it after preparation. Keep runtime files under `.bench-home`, outside captured code.
- `grade <task-dir> <workspace> <captured-patch> <result-json>`: reconstruct source in a separate fresh workspace, apply the captured patch, restore the original grading authority, and execute the original grader. An adapter using `git apply` must initialize its own grading repository so an enclosing checkout cannot affect patch application.

Exit zero with a UTF-8 JSON report containing exactly `{ "passed": <nonnegative integer>, "failed": <nonnegative integer>, "total": <positive integer>, "evidence": <JSON value> }`. Counts must sum to `total`; `evidence` preserves the original grader's result, including its test IDs or aggregate criterion. Semantic rejection is a valid report, not a subprocess failure. Nonzero exit, timeout, or an invalid/missing report is an unsuccessful attempt. The complete validated report text is retained in `nativeGrade`, independent of bounded diagnostic stdout/stderr.

The entire regular-file task tree determines fixture identity. Do not write caches or downloads into that tree. Commands get a workspace-owned home and temporary directory, and Python bytecode writes are disabled. This environment contract is not a claim of full filesystem confinement. Adapters remain responsible for pinned acquisition, platform requirements, original-test restoration, and faithful grading. See the [benchmark menu](../README.md#coding-benchmark-menu) for measured task costs and migration status.

The direct persona service runs native candidates in a separate Bun worker under the existing macOS-only `CellIsolation` operating contract. Its OS profile denies candidate read and shell access to the stored task, reference, calibration, and campaign history inputs. Shared runtime source is read-only except for retained compile-cache and skill-lock writes. The current workspace and job folders are writable, as are the permitted account store, account caches, and normal account `Library/Keychains` subtree. Existing account-service, installed-build, and other-profile credential restrictions remain. Source callers use the same owned worker-launch resource or supply an explicit native invocation capability, and never fall back to an unconfined native Agent. The parent owns preparation, patch capture, and the unchanged original grader. This boundary does not claim per-item keychain isolation, adversarial-grader integrity, or Internet isolation, and does not change non-native benchmark platform policies.

The persona harness still writes its own gitignored `.bench-plan.json`.
