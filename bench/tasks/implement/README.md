# Implement tasks: the trapped-restore suite

The task format is in `../README.md`, section "Implement tasks". This file records the hard implementer suite: tasks that a cheap model fails and a strong model passes, so that a model sweep shows the value of a stronger implementer.

## How a trapped-restore task is built

Each task restores a real Flywheel fix from public history. The sandbox is the Flywheel tree at the fix's parent commit, installed with `bun install --ignore-scripts --backend=hardlink`. The install skips scripts because the repository's postinstall patch step needs packages that the sandbox paths do not hold. The hardlink backend keeps each sandbox near 1.5 GB on disk. The sandbox paths never include `bunfig.toml`: its test root would hide `acceptance/` from `bun test acceptance`. Every hidden test file therefore starts with `import "../tests/preload.ts";`, and its imports point at `../src` and `../tests/helpers`.

The plan is written so that following it literally produces a design the fix rejected. Each such statement is one trap in `manifest.json`. The hidden tests are the fix's own unit tests. `qualification/reference.patch` is the fix's `src` diff, and `qualification/trap.patch` follows the plan literally.

Every task passed three no-model controls before the pilot. Its `WHY.md` records them:

1. Base: the visible checks named in the plan pass, and the hidden tests fail.
2. Reference: the hidden tests pass.
3. Trap: the visible checks pass, and the hidden tests fail.

## Keep rule

The pilot (2026-11-13, Personal profile, subscription routes, $0 billed) ran gpt-6-luna xhigh x2, claude-haiku-5.5 high x2, and claude-opus-5.5 medium x2, plus claude-opus-5.5 high x1 on tasks where opus medium failed. A task is kept when the cheap seats (haiku and luna) pass at most 1 of 4 runs, and opus medium or high passes at least 1 run. A pass means every hidden test passes.

## Suite

| Task | Kind | Cheap passes | Opus passes | Status |
|---|---|---|---|---|
| hosted-thinking-row-wait | trapped-restore (07ef8a320) | 0/4 | medium 1/2 | kept |
| recall-punctuated-words | trapped-restore (cd7fb5e4b) | 1/4 | medium 2/2 | kept |
| httpx-streaming-json-iteration | existing native | 1/4 | medium 1/2 | kept |
| scheme-metacircular | existing native | 1/4 (haiku 1/2; luna 0/1 plus 1 grader failure) | medium 0/1 (1 grader failure), high 1/1 | kept |
| regex-chess | existing native | 2/4 (haiku 2 output overflows, luna 2/2) | medium 2/2 | not in the suite: cheap seats pass |
| astropy__astropy-14598 | existing native | prepare fails | prepare fails | not in the suite: its prepare step exits 1 on this host |

Existing native tasks stay in the corpus whatever their status here.

## Dropped drafts

Their directories are deleted.

| Draft | Source commit | Cheap passes | Opus passes | Reason |
|---|---|---|---|---|
| midstream-5xx-retry | e6b26867b | 1/4 (luna once) | medium 0/2, high 0/1 | Strong seats always fail 4 of 89 hidden tests: those tests pin the classifier's internal shape. |
| reasoning-priced-once | f56e60af1 | 0/4 | medium 0/2, high 0/1 (64/65 best) | Every seat fails: one hidden test pins an exact internal value. |
| workflow-resume-while-opening | acaf2c41b | 0/4 | medium 0/2, high 0/1 | Every seat fails the same 1 of 15 hidden tests; the test is too strict for a correct alternative fix. |
| compaction-fresh-context-trigger | 6dc1c6c1a | 0/4 | medium 0/2 | Every seat fails the same 1 of 30 hidden tests (29/30 in every run). |
| claude-concurrency-not-quota | f752c144f | 0/4 | medium 0/2 | Every seat fails the same 4 of 63 hidden tests. A correct opus fix fails them because they pin the fourth parameter of `cliFailure`, an internal signature. |
| workflow-interrupt-race | 1456229bf | 4/4 | medium 2/2 | Saturated: every seat passes. |
