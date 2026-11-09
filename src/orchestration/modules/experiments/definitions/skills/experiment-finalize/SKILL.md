---
description: Use when finalizing kept experiments into clean, reviewable branches, one per independent change.
attended: true
direct-output: Report the branches created, what each contains, the overall metric improvement, and the cleanup commands directly in chat.
---

# Finalize Experiments

Turn a noisy experiment branch into clean, independent branches, one per logical change, each starting from the merge-base. The bundled finalize.sh script does the branch surgery; `references/groups-json.md` defines the input it takes, read with the skill tool's resource action before Step 2.

## Step 1: Analyze and propose groups

1. Read the run history: `flywheel events search --type experiment.run.recorded --json --limit 0 --session <sessionId>`. The session id is the `sessions/<sessionId>` segment of your scratchpad directory path. Keep only rows whose `source` is `store` and whose `sessionId` is this session; drop every `log` row. Validate each payload: `run` and `segment` are integers, `commit` and `description` are strings, `status` is one of `keep`, `discard`, `crash`, `checks_failed`, `metric` is a finite number. Sort the rows by `position` ascending; timestamps are not the order. Then filter to kept experiments only.
2. Read `.experiment/charter.md` for context.
3. Expand every short commit hash to a full hash with `git rev-parse <short_hash>`, and get the merge-base with `git merge-base HEAD main`.
4. For each kept commit, get the diff stat (`$BASE..<commit>` for the first, `<prev_kept>..<commit>` for the rest).
5. Group kept commits into logical changesets. Preserve application order. No two groups may touch the same file, because each branch is applied to the merge-base independently; merge groups that overlap. Flag cross-file dependencies ("group 2 depends on group 1, review together") and merge tightly coupled groups. Keep each group to one idea; the count follows the work.

Present the proposed grouping to the user as a numbered list: title, commits, files, and the metric before and after each group. Before you ask, write the complete groups JSON (the shape in `references/groups-json.md`) to a session note so it is frozen. Wait for approval before proceeding. After approval, run exactly the frozen JSON; do not recompute it. If the user asks for changes, revise the proposal, freeze the revised JSON, and ask again.

## Step 2: Run the frozen groups

Run the bundled finalizer through the skill tool: `skill` with `action:"child-run"`, `skill_id:"experiment-finalize"`, `script:"finalize.sh"`, and `input` set to the frozen groups object. The host reads the exact bundled finalize.sh, writes it and your approved groups into the session scratchpad, and runs it in the experiment working tree. Never run the script another way and never edit it.

The script creates one branch per group from the merge-base, verifies the union matches the original branch, and prints a summary with all branches and cleanup commands. On creation failure it rolls back (deletes branches, restores the original branch, pops the stash). On verification failure it exits non-zero and leaves the branches intact for inspection.

## Step 3: Report

Report the branches created and what each contains, the overall metric improvement (baseline to best), the cleanup commands from the script's summary, and any untried ideas from your session notes.

## Edge cases

- One kept experiment: one branch is fine; do not force splits.
- Overlapping files between groups: the script fails naming the file. Merge the overlapping groups and retry.
- Non-experiment commits on the branch: skip them; only kept experiments from the recorded run facts are processed.
