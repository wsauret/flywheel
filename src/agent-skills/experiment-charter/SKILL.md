---
description: Use when the user invokes /experiment design to build an approved experiment charter section by section.
direct-output: Report the approved charter path, the observed baseline METRIC line, and the commit that holds exactly the three .experiment files directly in chat.
---

# Experiment Charter

Lead a section-by-section approval conversation that produces `.experiment/charter.md`, `.experiment/measure.sh`, and `.experiment/checks.sh`, proves the measure command emits the primary metric, and commits exactly those three files. `ARGUMENTS` is the user's goal. Never call `init_experiment`, `run_experiment`, or `log_experiment` here; `/experiment start` validates the committed charter and begins the loop, and `/experiment dashboard` shows it.

The charter is the user's contract with the loop. Every section is drafted by you, presented in full, and approved by the user with `ask_user` before the next section starts. Never write a file before the complete draft is approved. Working memory (candidate levers, open questions, rejected drafts) goes to the session checkpoint through `checkpoint_replace`, never into the charter.

Two references travel with this package; read each with the skill tool's resource action when you reach the section it serves. `references/scripts.md` is the authoring guide for `./.experiment/measure.sh` and `./.experiment/checks.sh` (the Commands section). `references/loop-rules.md` holds the operating rules the Search strategy section copies into the charter so a fresh agent can run the loop from the charter alone.

## Preflight

1. The current directory must be the Git worktree root with a clean tree (`git status --porcelain` empty); otherwise ask the user to commit or move first. It is `work_dir`.
2. If `.experiment/charter.md` exists, read it and offer to revise it instead of starting over.
3. Read the source, build and test entry points, and any existing benchmark; understand the workload deeply before drafting.

## Charter layout

`charter.md` is a title, exactly one strict TOML block, then the approved `##` sections in the order of the content model below (Objective through Search strategy). `/experiment start` requires every heading present and non-empty, and refuses any unknown key, missing required key, or type mismatch in the block:

```toml
name = "<snake_case session name>"
metric_name = "<primary METRIC name emitted by measure.sh>"
metric_unit = "<unit, may be empty>"
direction = "lower"            # or "higher"
measure_command = "./.experiment/measure.sh"
checks_command = "./.experiment/checks.sh"
work_dir = "."
max_iterations = 200           # optional positive integer; omit for no cap
protected_paths = ["<glob>", "<glob>"]
sealed_paths = ["<glob>"]
```

`protected_paths` and `sealed_paths` are globs relative to `work_dir`. The loop protects the three `.experiment` files itself, so list only the user's own paths. The loop cannot read sealed paths and has no Bash while any exist, so seal only what must stay confidential.

## Section conversation

Draft each section, present it verbatim, and ask for approval or edits with one `ask_user` call. Revise until approved. Content model:

### Objective

What is optimized and on which workload: the primary target, how secondary targets trade off, and the exact formula with weights for a composite primary. Name each corpus and its role, what the current solution replaces, and what may not serve as a fallback or oracle.

### Metrics

The primary `<metric_name>` (`<unit>`, lower or higher is better) and one line per secondary `METRIC` with what it monitors. For a composite primary, write the formula in a fenced block with every weight, floor, and ratchet named, and why the weights make the intended path the path of least resistance.

### Hard gates

Conditions that force `discard`, `checks_failed`, or `crash` regardless of score; a higher objective never rescues a candidate that trips one. Typical: net test regression, crashes, branching on dataset, path, or test index, literal evaluation examples in code, edits to harness files, latency beyond budget.

### Anti-gaming rules

Goodhart's law rules: no memorized evaluation strings, no override tables mined from fixtures, no branching on evaluation mode, no edits to metric extraction or tests, no cached benchmark outputs, no distribution shift that is not a plausible real improvement. Green checks are not proof a candidate is clean.

### Files in scope

Every file the loop may modify, one bullet each with what it does and which lever family it carries; name files that must stay thin wrappers.

### Protected paths

Paths the loop can never write, one bullet each with the reason (tests and fixtures, referees, evaluation data, hooks, the charter and its scripts). The human-readable form of `protected_paths`; the two must agree. Harness maintenance happens outside the loop, never inside a candidate.

### Sealed paths

Paths the loop can never read, one bullet each with the reason, or one sentence stating nothing is sealed. Must agree with `sealed_paths`.

### Commands

What `./.experiment/measure.sh` and `./.experiment/checks.sh` run, how long each takes, and every `METRIC` line the measure script emits. The harness runs both; the loop never edits them. Draft both scripts with this section, following `references/scripts.md`, and get them approved with it.

### Baseline

The observed `METRIC` lines verbatim from one run on the unchanged tree (see Baseline evidence) and the run date. `/experiment start` refuses it without the primary `METRIC <metric_name>=<value>` line.

### Search strategy

`###` subsections: Recommended order (lever families from cheapest to most invasive, starting with baseline and error mining), Portfolio management (each lever family is a theme; a new theme gets one reconnaissance experiment, a kept one earns at most two adjacent follow-ups, two consecutive failures park it, and rotation is mandatory when momentum fades; the theme ledger lives in session notes), Lever menu (concrete actions grouped by lever family and the files each may touch), Experiment loop (the per-iteration cycle), ASI shape (the `asi` object fields), and Keep/discard policy. Copy the operating rules from `references/loop-rules.md` into this section verbatim.

## Baseline evidence

After Commands is approved, write `.experiment/measure.sh` and `.experiment/checks.sh` exactly as approved and make them executable. Run `./.experiment/measure.sh` once through Bash on the unchanged tree. Its stdout must contain `METRIC <metric_name>=<finite number>` for the primary metric and every secondary the Metrics section names; if not, fix the script with the user, re-approve Commands, and run again. The observed lines are the evidence; never infer them. Run `./.experiment/checks.sh` once and confirm it exits 0. Then draft Baseline from the observed lines verbatim, then Search strategy, and approve each.

## Complete draft approval and commit

Assemble `charter.md` (title, TOML block, ten sections in order), present the whole file, and ask for final approval with `ask_user`; re-present until approved. Write `.experiment/charter.md`, then `git add .experiment/charter.md .experiment/measure.sh .experiment/checks.sh` and `git commit -m "chore(experiment): add <name> charter"`. The commit holds only these three paths; unstage anything else first and confirm a clean tree afterward. Report the charter path, the observed primary `METRIC` line, and the commit hash.

The method is complete only when every section was approved, the measure script produced the primary metric on the unchanged tree, and one commit holds exactly the three `.experiment` files on a clean tree. Missing any of these, report the blocker instead of completing.
