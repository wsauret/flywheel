# Benchmark task corpora

Every runnable task in these corpora works in a public clone. Its source is a commit in the public history, files inside the task (a vendored `project/` folder), or an empty tree. `bun run lint:bench-pins` fails when a task names a commit that is not an ancestor of HEAD.

## Planning tasks

Planning tasks live under `planning/<id>/`. The planning campaign family (`bun run bench:planning`, refer to `../chat-ab/README.md`, "Planning") loads them, and its `PLANNING_TASKS_DIR` constant names the folder. A task has four files:

- `brief.md` is the person's request. The harness sends it unchanged, then one fixed instruction to write the plan to `PLAN.md`.
- `task.json` is `{ "id", "stratum", "timeoutMinutes", "sandbox" }`, decoded strictly. `id` equals the folder name. `sandbox` is the shared sandbox spec that the implement tasks below also use: `{ "commit", "paths" }` (an immutable selector, a full hash of a commit in the public history optionally followed by `:<subtree>`, and the non-empty list of paths that `git archive` copies), `{ "fixtureRepo" }`, or the empty source, each with an optional `patch` and `setup`. A greenfield task uses the empty source, which provisions an empty repository. The planning family provisions through the chat-ab provisioner, which applies the patch and runs setup before it commits the baseline.
- `manifest.json` (optional) is `{ "mustAddress": [{ "id", "title", "catchCriteria" }], "falsePremises"?: ["<id>"] }`. The points are the known requirements that recall scoring and the pairwise judge read. `falsePremises` lists the ids of the points that refute a false claim of the brief. A task with no manifest, such as a greenfield task, has no recall score.
- `WHY.md` explains why the task exists. Its section "Verification at the pinned tree" gives one `path:line` at the pinned tree for every claim of each point, and states that the requested feature is absent there. The evidence goes in `WHY.md`, never in the manifest, because the judge reads the manifest.

`paths` never includes `bench` or `inspiration`: `bench` holds this answer key, and the loader refuses both. Before setup runs a cell, the harness checks that every backticked repository path of the manifest exists in the sandbox source: the pinned tree, or the fixture folder.

## Implement tasks

Implement tasks live under `implement/<id>/`: `task.json`, a contract-valid recorded `plan.json`, `manifest.json`, a fixture repository or commit-pinned sandbox, and hidden `acceptance/` tests. The direct persona benchmark loads them.

Implement capture retains the diff before it installs the hidden acceptance tests.

Implement task files:

- `task.json` contains `{ "id", "stratum" }`. Optional: `sandbox` is `{ "fixtureRepo", "patch"?, "setup"? }` or `{ "commit", "paths", "patch"?, "setup"? }`. `fixtureRepo` names a task-dir relative folder that holds the source files verbatim; without `sandbox` it is `project/`. `commit` and `paths` instead materialize `git archive` of this repository at that commit restricted to `paths`; the commit must be in the public history. The empty tree (`4b825dc642cb6eb9a060e54bf8d69288fbee4904`) with `"paths": []` is the empty source; every other commit needs a non-empty path list. Either way the harness applies the optional `patch` (task-dir relative) on top, commits the result as the baseline, then runs the optional `setup` commands (e.g. `[["bun", "install"]]`) so their artifacts stay out of the baseline and the diff.
- `plan.json` contains a plan that the `implementation-plan.json` output contract accepts.
- The source folder is copied into the sandbox and committed as the baseline with `.flywheel/` ignored. Its files are frozen inputs: they keep the bytes of the commit they came from, and a change to them changes the task's content identity.
- `acceptance/` contains hidden Bun tests. The harness copies it only after capturing the implementation diff, then runs `bun test ./acceptance`, so only the hidden directory runs.
- `manifest.json` contains `traps` and `judgment` arrays whose entries contain `id`, `title`, and `catchCriteria`.
- `checks.json` maps each new hidden check to its tag: `core` (the use case the change was requested for), `serious` (a realistic failure that breaks the feature even when the normal path works), or `edge` (rare input, defensive handling, and packaging limits). A plan task names each acceptance test by its Bun JUnit name, `acceptance/<file> > <describe> > <test>`, and must tag every one; a native task names the ids that its adapter reports, and every other id the adapter reports is an existing test. Quality is the passed share of the core and serious checks, with each broken existing test counted as one more failed check; edge checks are reported apart (ARCH-DIRECTORIES-024). The file is part of the grader identity, so a change to it regrades stored diffs with `--regrade`.

`implement/tiers.json` maps every implementer task id, plan or native, to its tier: `ranked` or `floor` (ARCH-DIRECTORIES-022). The ranking fails when a task has no entry or an entry names no task. The tier is ranking metadata decided from results, so the file lies outside every task identity and a tier change never makes a record stale. `bun run bench:tiers` prints each task's measures and the rule's result, `--check` fails when a committed tier differs from the rule, and `--write` commits the rule's tiers; `bench/README.md` states the rule. A new task needs an entry before any ranking command runs: commit it as `floor` until its pilot cells exist.

### Native tasks in the shared corpus

The direct persona benchmark also discovers native tasks in `implement/`.

A native `task.json` declares `kind: "native"`, `id`, `stratum`, `family`, `split` (`development` or `evaluation`), a task-relative `instruction` file, and `native: { "command": ["<runtime>", "<task-relative-script>", "...fixed arguments"], "timeoutMs": <positive integer> }`. Optional `timeoutMinutes` remains the candidate timeout. Optional `native.path` lists workspace-relative directories, such as `[".bench-home/python/bin"]`, that lead the candidate's `PATH` in the declared order, the way an activated virtual environment does. Loading rejects absolute, drive-rooted, empty, and `..` entries. Only the candidate's process sees the prefix; `prepare` and `grade` keep their own environment. The instruction is UTF-8 and is passed without trimming or newline normalization. Native tasks have no `plan.json`, Bun acceptance directory, or `sandbox` configuration. Family and split are recorded metadata, not automatic evaluation-split enforcement.

The adapter runs as an owned subprocess, never as a host-process import. The runner appends positional arguments:

- `prepare <task-dir> <workspace>`: prepare original source and dependencies in the fresh workspace. Do not create a Git baseline; the runner creates it after preparation. Keep runtime files under `.bench-home`, outside captured code.
- `grade <task-dir> <workspace> <captured-patch> <result-json>`: reconstruct source in a separate fresh workspace, apply the captured patch, restore the original grading authority, and execute the original grader. An adapter using `git apply` must initialize its own grading repository so an enclosing checkout cannot affect patch application.

Exit zero with a UTF-8 JSON report containing exactly `{ "checks": { <check id>: <true for a pass> }, "evidence": <JSON value> }`. `checks` holds the outcome of every check that ran: the task's `checks.json` ids for its new checks and the original grader's ids for its existing tests. A check that did not run, such as after a build failure, is left out and fails. `evidence` preserves the original grader's result. Semantic rejection is a valid report, not a subprocess failure. Nonzero exit, timeout, or an invalid/missing report is an unsuccessful attempt. The complete validated report text is retained in `nativeGrade`, independent of bounded diagnostic stdout/stderr.

The entire regular-file task tree determines fixture identity. Do not write caches or downloads into that tree. Commands get a workspace-owned home and temporary directory, and Python bytecode writes are disabled. This environment contract is not a claim of full filesystem confinement. Adapters remain responsible for pinned acquisition, platform requirements, original-test restoration, and faithful grading. See the [benchmark menu](../README.md#coding-benchmark-menu) for measured task costs and migration status.

The direct persona service runs native candidates in a separate Bun worker under the existing macOS-only `CellIsolation` operating contract. Its OS profile denies candidate read and shell access to the stored task, reference, calibration, and campaign history inputs. Shared runtime source is read-only except for retained compile-cache and skill-lock writes. The current workspace and job folders are writable, as are the permitted account store, account caches, and normal account `Library/Keychains` subtree. Existing account-service, installed-build, and other-profile credential restrictions remain. Source callers use the same owned worker-launch resource or supply an explicit native invocation capability, and never fall back to an unconfined native Agent. The parent owns preparation, patch capture, and the unchanged original grader. This boundary does not claim per-item keychain isolation, adversarial-grader integrity, or Internet isolation, and does not change non-native benchmark platform policies.

The persona harness still writes its own gitignored `.bench-plan.json`.
