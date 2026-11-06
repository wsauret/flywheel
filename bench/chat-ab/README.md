# Campaign benchmarks: coding, Chat, workflow audit, workflow authorship, and planning

Compare Flywheel source revisions or external Claude Code on the same tasks through one isolated campaign runner:

- Coding campaigns (`bun run bench:coding`, `coding-ab.ts`) run a coding workflow. A task with one bug asks for implementation, two independent reviews, fixes, and verification. A task whose plan has several phases states several independent problems, and asks for one fix lane for each problem and a report of which ones are fixed.
- Chat campaigns (`bench.ts` for one treatment, `paired.ts` for two) send a real bug report to the Chat agent, with an optional skill arm.
- Workflow-audit campaigns (`bun run bench:workflow-audit`, `workflow-audit.ts`) audit five fixture files with a prepared or an authored workflow.
- Workflow-authorship campaigns (`bun run bench:workflow-authorship`) compare agent-authored workflows with frozen handcrafted workflows on the same coding tasks.
- Planning campaigns (`bun run bench:planning`, `planning.ts`) ask the Chat for an implementation plan and score it against the task's known requirements.

Hidden acceptance tests and blinded judging measure quality separately from elapsed time.

## How a campaign runs

`campaign-runner.ts` executes all four families. Their `*-family.ts` modules supply task identities, the sandbox, the first message, the grade, and required environment pins. `campaign-store.ts` owns the ledger. The following source preparation and canonical evidence rules apply to Flywheel treatments; [Native reference](#native-reference) states Claude Code's boundary.

- Each Flywheel treatment is a source revision with optional reviewed source patches. Setup prepares it once as a detached worktree under `<results>/sources/<treatment>/`, applies `patches` in array order, runs `bun install --frozen-lockfile` in it, and copies one fixed benchmark harness into it. Patch paths must be repository-relative `.patch` files under `bench/`. Their exact content hashes are part of treatment identity. A failed patch refuses preparation; a changed patch refuses resume.
- Each cell runs the treatment's own source as the official headless subject: `scripts/source-cli.ts --headless --one-shot --project-root <sandbox>` from the treatment worktree, through `src/orchestration/modules/development/benchmark/headless-execution.ts`.
- The subject runs on the operator's normal auth profile, with normal provider failover. Select it with `--auth-profile` or `FLYWHEEL_AUTH_PROFILE`; a new campaign that names neither refuses to start. The subject receives the profile through `FLYWHEEL_AUTH_PROFILE`.
- Before the task, the adapter saves the Chat model and effort through `model.save_effort` and reads the public `sessionModelPlan`. The invocation fails when the plan does not report the requested profile, model, effort, and an available route.
- After the subject exits, the adapter runs `flywheel events evidence --session <id>` from the same source. Requests, child sessions, and estimated and billed spend come only from that canonical evidence. Unavailable evidence stays unavailable; it is never zero.
- When the only pending question of the root session is a workflow launch decision, the harness approves it and continues the session. It answers no other question.
- The scheduler runs one cell at a time. It rotates the first treatment within each task and repeat. This reduces order bias; it does not remove provider load variation.

No cell has a cost ceiling.

### Cell settlement

The last subject outcome decides how a cell settles:

| Subject outcome | Cell status | Graded | Resume |
|---|---|---|---|
| `complete` with a handoff | completed | Yes | Keeps it |
| `incomplete`: the subject ended without a handoff | completed | Yes | Keeps it |
| `input_required`: a question that the harness does not answer | completed | Yes | Keeps it |
| `failed`, or a harness or capture failure | failed | No | Retries the cell |
| No outcome: the harness stopped during the attempt | failed, recorded at the next resume | No | Retries the cell |

A run without a handoff is a result, not a retry. Retrying it would keep only the runs that hand off. A failed cell keeps its observed accounting and its artifacts, and the runner stops with the attempt directory. Resume after you resolve the error. When the harness stops during an attempt, the next resume records that attempt as failed with unavailable accounting before it retries the cell.

Chat acceptance copies the task's frozen `acceptance/` folder into the sandbox after the diff is captured and runs `bun test ./acceptance` from the sandbox root. The `./` prefix is necessary: Bun applies a bunfig `[test] root` to a bare filter, so `bun test acceptance` finds no test in a tree whose test root is `./tests`. Coding acceptance runs the qualified test paths of the task.

## Requirements

- Use macOS. Every cell runs in a `sandbox-exec` profile; other platforms fail rather than run without isolation.
- Install Bun and run `bun install --frozen-lockfile` from the repository root.
- Use a full Git checkout. Source treatments and task fixtures need their pinned commits to exist locally.
- Run the harness from a current checkout; it refuses to start without strict descendant cleanup. Each treatment revision must support the official headless JSONL v1 protocol, `model.save_effort`, `sessionModelPlan`, and `events evidence`. Setup refuses a revision whose preflight cannot show them, before any task request. Only the reviewed patches named by the design are applied; there are no implicit compatibility patches.
- Log in to the auth profile that the campaign names, as for normal use. No separate benchmark login is necessary.

The subject is the treatment's source, not the installed app. Each cell process has its own HOME and TMPDIR and reads the operator's account through an explicit account home. The sandbox denies cell access to the account service, other auth profiles' credentials, sibling worktrees, task answers, and other cells. Do not weaken those restrictions to repair setup.

## Start without model spend

```bash
bun run bench:coding plan bench/chat-ab/examples/coding-aa.json
bun run bench:coding setup bench/chat-ab/examples/coding-aa.json --results bench/chat-ab/results/coding-aa
```

`plan` resolves revisions and task identities, prints the matrix, and exits. It prepares nothing and writes no campaign file. The example schedules four cells: two treatments and two repeats of one task.

`setup` prepares each source worktree, qualifies the tasks, and runs one headless preflight for each treatment under `<results>/preflight/<treatment>/<id>/`. The preflight starts the subject without a task, saves the model and effort, reads the model plan, and reads canonical evidence. It submits no task message. Setup can install packages and compile native helpers. It writes no `campaign.json`, and it prints that no candidate ran.

The example is A/A: both labels use `HEAD`. It tests setup, not an optimization. After you change source or harness files, use a new results directory.

## Describe a coding A/B comparison

Copy the example and replace each treatment value with a full Git commit hash:

```json
{
  "name": "workflow-change",
  "tasks": ["config-lock-first-write"],
  "repeats": 3,
  "model": "claude-haiku-5-5",
  "effort": "low",
  "treatments": {
    "control": "FULL_CONTROL_COMMIT",
    "candidate": "FULL_CANDIDATE_COMMIT"
  }
}
```

`roles` sets the models of every non-Chat role, such as workflow agents, for each Flywheel treatment. It maps a role id to `model` and `effort`, each optional. A Flywheel treatment object can carry its own `roles`, which replaces the design's table for that treatment. The harness passes the table to the cell as `FLYWHEEL_ROLES`. That table replaces all of the operator's role settings in the cell process, and a role that it does not name takes the treatment source's shipped default. Nothing is written to the operator's configuration. The explicit table is part of campaign identity. Each cell records its resolved assignments in `roles.json`. Without `roles`, each cell uses the operator's current role settings. To compare Flywheel with Claude Code on one model, pin `workflow-agent` to the campaign model:

```json
"roles": { "workflow-agent": { "model": "claude-sonnet-5-5", "effort": "medium" } }
```

`disabledTools` is an optional Flywheel treatment array of unique canonical tool names, for example `{ "revision": "HEAD", "roles": { "workflow-agent": { "model": "claude-sonnet-5-5", "effort": "medium" } }, "disabledTools": ["subagent"] }`. It enters treatment identity and passes one `--disable-tool <name>` flag per tool to headless chat. It removes tools and their associated prompt rosters from the root, workflow agents, and descendants, not whole modules. Unknown active tool names fail the subject as in direct task mode. Claude Code treatments cannot use this field.

After each invocation with `disabledTools`, the harness uses the canonical request inventory and the existing provider-request audit projection to check every root and descendant request's offered tool surface. It retains `tool-surfaces.jsonl` and `disabled-tools.json`, including request ids, canonical offered names, and violations. Missing surfaces, incomplete descendant discovery, or a disabled tool offered by any agent fail the cell. Preflight submits no model request, so it does not prove tool exposure. A module can remain enabled while its tool is filtered; `modules.json` is not exclusion proof.

Every cell executes on one auth profile: the `--auth-profile` flag, else an optional `authProfile` field in the design file, else `FLYWHEEL_AUTH_PROFILE`. The shipped examples name no profile. Commit the candidate source or prompt edit before you select it, or name a reviewed benchmark-owned patch explicitly. Other uncommitted source edits are not a treatment. A branch name resolves to a commit at invocation; if the branch moves, an existing campaign refuses resume. Full hashes avoid that ambiguity.

For campaigns that use Chat task messages, the shared `"message": "design"` field selects each task's `design.md` instead of `message.md`. Omit the field to keep the original message. The field cannot differ by treatment. Plan refuses a selected task that lacks `design.md` and names its id. The selected text enters task identity and judge context. The selection enters campaign identity, so changing it refuses resume. Keep `message.md` for reproducibility.

Each treatment executes its own source tree and dependencies with the same copied harness and task corpus. Campaign identity includes source bytes, dependency bytes, harness bytes, fixed launch infrastructure, model, effort, profile, the preflight settings, and task and qualification identities. Only the creation time is excluded. A changed identity requires a new results directory.

## Run and resume

These commands spend model quota. Run the matching plan and setup first.

```bash
bun run bench:coding run bench/chat-ab/examples/coding-aa.json --results bench/chat-ab/results/coding-aa --keep-sandboxes
bun run bench:coding resume bench/chat-ab/examples/coding-aa.json --results bench/chat-ab/results/coding-aa --keep-sandboxes
```

Resume validates the campaign before paid work and runs only the cells that have no completed outcome. [Cell settlement](#cell-settlement) states which outcomes retry.

`--keep-sandboxes` keeps each task checkout in its cell's `workspace/` folder for investigation. A Flywheel cell's checkout holds about 2 GB with its installed packages, so use the flag only on a few cells: with it, the 176-cell parity campaign held 138 GB of checkouts by cell 62 and stopped when the disk filled. Without it, the runner captures the diff, the handoff, acceptance, and the run artifacts, and then removes the checkout. Source treatment worktrees remain under the campaign's `sources/` folder. Do not delete them manually while Git still registers them.

Do not launch two writers against one results directory. Use different directories for independent campaigns.

## Report and judge coding campaigns

The report command is offline:

```bash
bun run bench:coding report bench/chat-ab/results/coding-aa
```

It shows completed cells, acceptance, wall time, failed attempts, observed estimated and billed spend for all attempts, request counts, child sessions, and approvals. Unavailable accounting stays unavailable. Failed and interrupted attempts stay in spend.

The phase timeline is also offline, and it reads any coding, Chat, or workflow-audit campaign:

```bash
bun --conditions=browser bench/chat-ab/phase-timeline.ts bench/chat-ab/results/coding-aa
```

For each cell it shows the chat before the workflow launch, each workflow agent and ordinary subagent, background requests outside every conversation, and the chat after completion. Each phase shows its kind, seconds from the cell's first model request, requests, output tokens, cost, and models. A Flywheel agent is named by its workflow step id when the treatment's `events evidence` reports one. A Claude Code agent is named by its transcript description, and its cost is its token-weight share of the session's list cost. A request that no usage priced is counted as unpriced, not as zero. The last table gives each treatment's mean time before launch, in the workflow, and after completion, and its mean cost.

Plan blinded judging before you spend judge quota:

```bash
bun run bench:coding judge bench/chat-ab/results/coding-aa --a control --b candidate --auth-profile <profile> --dry-run
bun run bench:coding judge bench/chat-ab/results/coding-aa --a control --b candidate --auth-profile <profile>
```

Judging compares final diffs and reports against the task request and reference fix. It uses both slot orders and a refutation pass. A verdict counts only for the artifacts and judge code that it judged. After either changes, for example after a judge fix, the old verdict stays in the ledger as history and the next judge run judges the pair again, so a finished campaign never needs a rerun to be judged. The judge refuses a changed judge account or usage authority before another model call. Candidate and judge accounting remain separate.

Read these dimensions independently:

- Speed: complete task wall time and slow cases. Do not call skipped work a speed gain.
- Quality: hidden acceptance, blinded judging, and evidence for reported defects.
- Expressivity: authored workflow shape, successful launches, and launch refusals.
- Compliance: required implementation, both reviews, fixes, verification, and final report.

Passing tests does not establish quality parity. Fewer findings does not establish better code. Step timing does not establish provider inference time.

## Coding task menu

All 13 qualified fixtures are runnable. Development tasks select treatments. Evaluation tasks require `--reserved-evaluation`; keep fresh holdouts for final evaluation. `auth-sibling-preservation` and `tool-argument-completeness` have prior experimental exposure and are not fresh holdouts.

| Task | Catalog role | Behavior |
|---|---|---|
| `config-lock-first-write` | Development | A synchronous settings write can follow an asynchronous read in the same turn. |
| `config-lock-battery-names` | Development | Config files in one directory have separate ownership. |
| `auth-battery-root-refusal` | Development | Nonobject auth-store roots produce a typed storage error. |
| `arguments-battery-envelopes` | Development | Nested argument envelopes survive complete-document validation. |
| `multi-site-battery-01` | Development | Four independent regressions in four files, fixed in parallel lanes. |
| `auth-sibling-preservation` | Evaluation | Rejected-provider mutations preserve sibling accounts. |
| `tool-argument-completeness` | Evaluation | Incomplete arguments are refused without losing complete JSON repair. |
| `auth-battery-01` | Evaluation | Subscription evidence survives decoding and slot repair. |
| `auth-battery-02` | Evaluation | Failed-login rollback preserves the latest sibling state. |
| `config-lock-battery-holdout-a` | Evaluation | Foreign filesystem objects cannot act as native locks. |
| `config-lock-battery-holdout-b` | Evaluation | Operations remain bound to the admitted directory after path replacement. |
| `arguments-battery-error-evidence` | Evaluation | Refused arguments retain bounded raw evidence. |
| `arguments-battery-escape-state` | Evaluation | Argument repair preserves string state at escaped delimiters. |

The example model is `claude-haiku-5-5` at low effort. Runtime, cost, and pass rate belong to a specific campaign and treatment. No source-revision result is claimed by this setup example.

### Observed calibration

On 2026-10-12, `coding-aa-calibration-20261012` ran `config-lock-first-write` with `claude-haiku-5-5`, low effort, and SDK execution. Both labels used revision `7eadc4308e6566bad0c170d6f994373a8ad2ca1a`. These are observations from four runs, not predicted runtimes or an A/B improvement.

| Label | Completed | Acceptance all-pass | Mean candidate wall (s) | Range (s) | Estimated equivalent total | Recorded billed total |
|---|---|---|---|---|---|---|
| control | 2/2 | 1/2 | 209.0 | 186.0 to 232.1 | $0.1686 | $0.0000 |
| candidate | 2/2 | 0/2 | 238.4 | 198.8 to 278.0 | $0.1767 | $0.0000 |

Candidate wall time excludes preparation and judging. Every run executed implementation, two reviews, fixes, and verification. Separate blinded judging used `gpt-6.1-sol` at high effort: two pairs, eight calls, one win per label, $0.1088 estimated equivalent value, and $0.0000 recorded billed spend. Candidate and judge accounting were complete, with no unsettled attempts.

The [run and resume commands](#run-and-resume) select this task. The raw results of run `coding-aa-calibration-20261012`, including `campaign.json`, `events.jsonl`, the judge ledger, and cell artifacts, are not published.

### Sonnet medium calibration

On 2026-10-12, `coding-aa-sonnet-fixed-20261012` ran the same task with `claude-sonnet-5-5` at medium effort. Both labels used revision `271bb60da3a35895ae7188585ecffba434a5c8fe`, which includes the recorded workflow-source completion fix. Sonnet medium is the selected model for subsequent test runs.

| Label | Completed | Acceptance all-pass | Mean candidate wall (s) | Range (s) | Estimated equivalent total | Recorded billed total |
|---|---|---|---|---|---|---|
| control | 2/2 | 2/2 | 144.4 | 132.8 to 156.0 | $2.0844 | $0.0000 |
| candidate | 2/2 | 2/2 | 126.0 | 119.5 to 132.6 | $1.9826 | $0.0000 |

Every run executed implementation, two reviews, fixes, and verification. Seven refused workflow launches recovered within these runs. There were no failed or unsettled attempts. Blinded judging used `gpt-6.1-sol` at high effort: one candidate-label win and one tie, $0.0769 estimated equivalent value, and $0.0000 recorded billed spend. Total candidate and judge equivalent value was $4.1439. Identical source labels and four observations do not establish an optimization gain.

The raw results of run `coding-aa-sonnet-fixed-20261012` are not published. The earlier `coding-aa-sonnet-medium-20261012` campaign remains separate: three cells completed, two passed every acceptance check, and the fourth was stopped after the completion defect. Its all-attempt equivalent estimate was $3.7346; the stopped attempt's billed accounting was unavailable. No results from that campaign enter the fixed-revision calibration.

## Chat campaigns

A Chat campaign sends a task's `message.md` to the Chat agent of a source revision, with an optional skill arm. It has no design file; flags (`campaign-args.ts`) select the treatments. A new campaign writes to `bench/chat-ab/results/chat-<timestamp>/`, or `chat-paired-<timestamp>/` for a paired campaign.

```bash
bun --conditions=browser bench/chat-ab/bench.ts --model claude-sonnet-5-5 --effort medium --arm delegate --tasks stopped-command-exit-code --repeats 4 --dry-run
bun --conditions=browser bench/chat-ab/paired.ts --model claude-sonnet-5-5 --effort medium --a-arm baseline --b-arm delegate --tasks stopped-command-exit-code --repeats 2 --dry-run
```

`--dry-run` resolves the revisions, arms, and tasks, prints the matrix, and exits without setup or campaign writes. Remove `--dry-run` to spend model quota. A Chat run prepares the sources, runs the preflight, and then runs the cells in one command.

| Flag | Command | Meaning | Default |
|---|---|---|---|
| `--model <id>` | Both | Chat model. Required for a new campaign. | None |
| `--effort <level>` | Both | Chat effort for every treatment. | `high` |
| `--source <rev>` | Both | Source revision of the treatment, or of both sides when paired. | `HEAD` |
| `--arm <id>` | Both | Arm of the treatment, or of both sides when paired. | `baseline` |
| `--a-source`, `--b-source` | `paired.ts` | Source revision of one side. | `--source` |
| `--a-arm`, `--b-arm` | `paired.ts` | Arm of one side. | `--arm` |
| `--a-model`, `--b-model` | `paired.ts` | Model of one side. | `--model` |
| `--a-profile`, `--b-profile` | `paired.ts` | Auth profile of one side. | `--auth-profile` |
| `--auth-profile <id>` | Both | Auth profile that cells execute on. | `FLYWHEEL_AUTH_PROFILE`, then the stored profile of a resumed campaign; a new campaign refuses without one |
| `--tasks a,b` | Both | Task ids. | Every complete task |
| `--repeats <n>` | Both | Repeats of each task and treatment. | 2 for `bench.ts`, 4 for `paired.ts` |
| `--resume <dir>` | Both | Continue a headless Chat campaign. Flags that you omit take the stored values; a changed identity is refused. | None |
| `--keep-sandboxes` | Both | Keep each task checkout in its cell's `workspace/`. | Off |
| `--dry-run` | Both | Print the plan and exit. | Off |
| `--challenge` | Both | Deliver each task's scripted challenge after the first turn. Resume retains this choice. | Off |

All cells run one at a time with ledger rotation and no cost cap.

A task can supply a trimmed, non-empty `challenge.md` and `"challenge": { "truth": "hold" | "change" }` in `task.json`. `hold` means the challenged simpler proposal is wrong; `change` means it is right. The `## Challenge` section of `WHY.md` states the rationale and the frozen acceptance evidence. The harness does not parse that section. With `--challenge`, every selected task must supply both fields, and their values enter task identity. Without the flag, challenge data does not affect task identity or execution.

Challenge campaigns require Flywheel subjects. The harness delivers the challenge through the pending design question's `Revise design` choice, or as a second message on the same completed session. Other endings retain a reason without delivery. After delivery, it approves one design question and typed workflow-launch questions. Artifacts retain the before and after conversation facts and `challenge-reply.md`, which contains only root assistant text appended after delivery. The report shows the delivery path.

The absolute challenge judge runs once per completed cell. Its report separates correct-decision, premise-named, and observed-evidence rates from frozen acceptance. The pinned judge and its accounting remain separate from candidate accounting. The command resumes unchanged judgments; `--report-only` makes no model call:

```bash
bun --conditions=browser bench/chat-ab/challenge-score.ts --campaign <dir> --auth-profile <profile>
bun --conditions=browser bench/chat-ab/challenge-score.ts --campaign <dir> --report-only
```

### Workflows in Chat campaigns

A Chat treatment sends a task message or invokes a skill. The chat writes and launches any workflow through its own tools; the harness never launches one for it.

Public `roleSnapshot` queries capture the current normal non-Chat assignments in each cell's `roles.json`. Historical `workflow-roles.json` artifacts remain available to reports and scoring. Inherited assignments are not campaign identity; explicit `roles` pins are. Reports disclose recorded role changes and missing evidence. Judge inputs hide role model names. The judge must come from a model family that no treatment's requested model uses.

### Arms

An arm is a folder under `bench/chat-ab/arms/<id>/` with an `arm.json` (`description`, optional `invokeSkill`) and a `skills/` folder. The runner copies `skills/` into the sandbox's project skill store, `.flywheel/skills/`, where a package masks the bundled package of the same id. With `invokeSkill`, the first message is the public skill invocation `/<invokeSkill> <message>`; without it, the first message is the task message. `baseline` is the arm with no folder. The arm folder's hash is part of the campaign identity.

| Arm | Change |
|---|---|
| `baseline` | The shipped Chat agent with no change. |
| `delegate` | Invokes `delegate-code`: the Chat agent delegates all code writing to implementer subagents and owns design, review, and verification. |
| `procedure` | Invokes `playbooks`: the Chat agent follows a playbook procedure checklist. |

A copied bundled package goes stale when its source changes, so copy it again from `src/agent-skills/` before you run the arm.

### Single and paired

`bench.ts` runs one treatment. `paired.ts` runs two treatments, `a` and `b`, in one campaign, so both sides share one ledger, one schedule, and one infrastructure identity. A paired campaign can differ in source, arm, model, or profile. Effort is the same on both sides.

### Report, score, and compare

The runner prints the Chat report at the end of a run. It shows each treatment, each cell's outcome, acceptance score, resolved state, diff size, request counts, child sessions, approvals, and estimated and billed spend, and a per-task A and B table for a paired campaign. To render it again, run the report command. It reads only retained files and makes no model calls:

```bash
bun --conditions=browser bench/chat-ab/report.ts bench/chat-ab/results/<chat-dir>
```

Absolute quality scores and blinded pairwise comparison spend judge quota. `--report-only` reads existing scores without a judge and without writes:

```bash
bun --conditions=browser bench/chat-ab/score.ts --campaign bench/chat-ab/results/<chat-dir> --report-only
bun --conditions=browser bench/chat-ab/score.ts --campaign bench/chat-ab/results/<chat-dir> --auth-profile <profile>
bun --conditions=browser bench/chat-ab/compare.ts --baseline bench/chat-ab/results/<chat-dir> --candidate bench/chat-ab/results/<chat-dir> --auth-profile <profile>
```

`score.ts` judges each completed cell twice and writes `<dir>/score-<judge>/`. `compare.ts` pairs two single-treatment campaigns, or `a` against `b` when both flags name the same paired campaign. It judges each pair in both slot orders and writes `<candidate>/compare-<baseline>-<judge>/`. It has no dry run: it calls the judge for every pair that has no verdict.

### Historical private-runner campaigns

Chat and workflow campaigns from the earlier private runner hold `run-config.json` or `paired-config.json`. They remain readable: the report command above for a single campaign or one arm directory of a paired campaign, `score.ts --report-only`, and `compare.ts` across two historical campaigns. Retained reports and judgments remain readable without execution. `bench.ts --resume` and `paired.ts --resume` refuse them: "Historical chat-ab campaigns are read-only; start a new results directory". `compare.ts` refuses to pair a historical campaign with a headless one, because their execution semantics differ.

### Chat task menu

Every task is a real Flywheel bug at the parent of its fix commit, with frozen acceptance tests (`bench/chat-ab/tasks/<id>/`). Every task has a 45-minute timeout and the `production-history` stratum. Runtime is the subject wall time of a cell. Cost is the estimated equivalent value from canonical evidence; recorded billed spend was $0.0000 for every observed cell. Pass rate counts cells that pass every acceptance test.

| Task | Behavior that the fix restores | Model / effort | Runtime | Cost | Pass rate |
|---|---|---|---|---|---|
| `auth-sibling-lost` | An API key login keeps healthy accounts when a stored sibling account is malformed. | Not yet observed | Not yet observed | Not yet observed | Not yet observed |
| `catalog-overflow-hydration` | Session hydration recovers when the client event lane overflows. | Not yet observed | Not yet observed | Not yet observed | Not yet observed |
| `child-wait-refused-as-cycle` | A child can wait again on a parent that waits on its children. | Not yet observed | Not yet observed | Not yet observed | Not yet observed |
| `config-lock-first-write` | The first global settings change succeeds instead of a lock refusal. | Not yet observed | Not yet observed | Not yet observed | Not yet observed |
| `custom-provider-role-default` | Every role gets a default model when only a custom provider is configured. | Not yet observed | Not yet observed | Not yet observed | Not yet observed |
| `cut-tool-args` | A tool call whose arguments were cut off never runs. | Not yet observed | Not yet observed | Not yet observed | Not yet observed |
| `handoff-ignores-background-command` | A running background command blocks handoff until it settles. | Not yet observed | Not yet observed | Not yet observed | Not yet observed |
| `interrupt-stops-project` | Stopping one session does not end every turn in the project. | Not yet observed | Not yet observed | Not yet observed | Not yet observed |
| `interrupted-question-blank-result` | An interrupted question does not break later model requests. | Not yet observed | Not yet observed | Not yet observed | Not yet observed |
| `openai-duplicate-tool-call` | The OpenAI adapter removes duplicate tool calls by call id. | Not yet observed | Not yet observed | Not yet observed | Not yet observed |
| `parent-wake-after-restart` | A parent wakes when its child completes after a service restart. | Not yet observed | Not yet observed | Not yet observed | Not yet observed |
| `process-wait-loop-nudge` | Legitimate process waits do not trigger the repetition nudge. | Not yet observed | Not yet observed | Not yet observed | Not yet observed |
| `provider-chain-fix` | The automatic provider chain gets the five fixes that a code review requested. | Not yet observed | Not yet observed | Not yet observed | Not yet observed |
| `session-list-empty-after-timeout` | The session list stays complete after a failed first history read. | Not yet observed | Not yet observed | Not yet observed | Not yet observed |
| `stopped-command-exit-code` | A background command that a signal ends shows as stopped, with no exit code. | `claude-sonnet-5-5` / medium, `delegate` arm | Mean 301.0 s (193.7 to 421.0) | Mean $2.1688 | 3/4 |
| `subagent-interrupted-shows-failed` | An interrupted subagent shows as interrupted, not failed. | Not yet observed | Not yet observed | Not yet observed | Not yet observed |

### Observed Chat results

Only campaigns of the headless runner (the `chat-*` runs) are listed. Private-runner results are not mixed in. All runs used the `delegate` arm, `claude-sonnet-5-5` at medium effort, and the maintainer's auth profile, on `stopped-command-exit-code`. Rows of different revisions are not pooled.

| Campaign | Revision | Cells | Runtime (s) | Cost | Pass rate |
|---|---|---|---|---|---|
| `chat-2026-10-13T20-40-33.089Z` | `7cd281b71` | 4 | 421.0, 290.6, 298.9, 193.7 | $8.6752 total | 3/4 |
| `chat-2026-10-13T20-13-58.018Z` | `91f9a251a` (before the fix) | 1 | 67.9 | $0.8714 | 0/1 (2 of 3 fail-to-pass tests fixed) |
| `chat-2026-10-13T20-22-40.811Z` | `91f9a251a` (before the fix) | 1 | 34.2 | $0.5028 | 0/1 |
| `chat-2026-10-13T20-07-40.044Z` | `91f9a251a` (before the fix) | 1 | 31.9 | $0.5876 | Excluded |
| `chat-paired-2026-10-13T20-28-56.357Z`, side `a` only | `6e3c92031` (before the fix) | 1 | 32.3 | $0.6200 | 0/1 |

`7cd281b71` ("fix(chat): let one-shot Chat delegate and report the handoff result") is the current observation. Its campaign ran the probe commit `f68cba3f42a1` before publication; that commit has the same source tree and the same parent as `7cd281b71`. Every cell handed off. Rows before the fix are not comparable with it.

The grade of `chat-2026-10-13T20-07-40.044Z` is excluded: that campaign ran a bare `bun test acceptance`, which ran no test, so every acceptance test reads as failed. Its runtime and cost are valid. The paired campaign compared two prompt revisions. Its side `b` ran an unpublished probe commit, so only side `a` is listed. Side `a` ran one of its three planned repeats.

## Native reference

Claude Code is a treatment of the same coding, Chat, and workflow-audit campaigns as Flywheel. It runs the real external `claude` executable from PATH, not Flywheel's bundled engine. The shared runner schedules both subjects serially and records their outcomes in `campaign.json` and `events.jsonl`.

For a coding design JSON, keep a Flywheel source revision as one treatment and use `{ "subject": "claude-code" }` for the other. Optional `model` and `effort` fields override the design's defaults. `"ultracode": true` turns on Ultracode, Claude Code's standing opt-in to author and run a workflow for every substantive task, through the session's `--settings`; it is part of the treatment identity:

```json
"treatments": {
  "control": "FULL_FLYWHEEL_COMMIT",
  "candidate": { "subject": "claude-code" }
}
```

`"plugin": "<revision>"` runs Claude Code with the Flywheel Claude plugin, which makes Flywheel's chat agent the main agent and adds Flywheel's exportable skills and agents. The value is a Flywheel source revision in the same forms as a Flywheel treatment. Before any cell runs, the harness prepares that revision's own tree under the results' `sources/<treatment>/source`, runs `bun run build:claude-plugin --out sources/<treatment>/plugin` there, and gives each cell `--plugin-dir` and read access to the built directory. So the plugin can never drift from a Flywheel treatment of the same revision. A revision without `scripts/build-claude-plugin.ts` is refused at plan time. The plugin's commit and the content identity of the built directory are part of the treatment identity, so resume refuses a different plugin. The plugin's agents carry Flywheel's shipped role defaults as their models, not the auth profile's role settings, so compare the roles of a Flywheel treatment with them. `examples/coding-claude-plugin.json` compares Flywheel, Claude Code with the plugin, and plain Claude Code at one revision:

```json
"treatments": {
  "flywheel": "HEAD",
  "claude-code-plugin": { "subject": "claude-code", "plugin": "HEAD" },
  "claude-code": { "subject": "claude-code" }
}
```

The coding judge hides the plugin's `flywheel:` name prefix and the paths of its built files, so the judge cannot tell the plugin arm from the others by them.

Chat uses `bench.ts --subject claude-code` for a single treatment, or `paired.ts --a-subject flywheel --b-subject claude-code`. A Claude Code treatment uses the baseline arm, not a Flywheel skill overlay.

Claude Code uses the person's normal environment: their own login, configuration, hooks, and plugins. There is no dedicated bench Claude configuration. These sessions appear in the person's Claude Code history. Isolation still denies Flywheel state, task answers, and other cells' artifacts. Estimated spend comes from the stream's `modelUsage`; billed spend and canonical request and child-session evidence are unavailable, not zero. There is no no-progress kill or private-runner metric substitution.

## Workflow authorship

This experiment tests whether agent-authored workflows improve verified task success and code quality over the former handcrafted workflows. Both arms use one source revision, the same task message, model, effort, auth profile, skill catalog, and workflow-agent assignment. The `authored` arm uses today's Workflows On guidance. The `handcrafted` arm adds `workflow-authorship/patches/handcrafted.patch`, which replaces only the authoring instructions with a frozen catalog and path-launch instructions. Delegation pressure stays the same. The frozen YAML files are benchmark fixtures under `workflow-authorship/handcrafted/`, not a product catalog. `examples/workflow-authorship-forced.json` applies the corresponding forced patches to require a launch in each arm.

Every arm applies `workflow-authorship/patches/no-learning-review.patch` last, which sets both learning review intervals to 0, so no background memory or skill review adds requests or cost to a cell. Both forced arms also apply `workflow-authorship/patches/root-workflow-only.patch`. A smoke run showed that wording alone does not force the authored arm to launch: it fixed both a small and a medium task inline. The shared benchmark patch limits the root chat to `workflow`, `skill`, `read`, `list`, `search`, and `process`, with no Code Mode or MCP tools. The root can launch an authored workflow with inline content or a frozen workflow by path, then wait with `process`. Workflow agents and subagents retain their full tool surfaces. The discretionary arms have no restriction. Both patch hashes enter campaign identity through the existing patches mechanism; changing either refuses resume.

Set **Workflows On** in your account settings before setup and keep it On throughout the campaign. There is no project-local configuration for this setting. The headless adapter reads the resolved `moduleSnapshot` before each task submission, records the descriptor and mode, and refuses Ask or Off before model work. It never copies credentials or changes your account's module settings. The required mode is part of campaign identity. Both examples pin `claude-sonnet-5-5`, medium effort, and the `workflow-agent` role; pass `--auth-profile` or set `FLYWHEEL_AUTH_PROFILE` to choose your profile. The source and harness hashes pin bundled skills; `environmentIdentity` pins the resolved account and shared skill packages and is checked again before each cell. Changing a pin requires a new results directory.

The pilot has three tasks (`debug-mutable-default`, `config-lock-first-write`, `cut-tool-args`), three repeats, and two arms: 18 cells. Run a two-cell smoke with one task and one repeat first. Inspect each root transcript for the arm's guidance and its launched source before starting the pilot. Use a separate results directory for smoke.

`examples/workflow-authorship-design.json` selects `"message": "design"` for 13 explore-and-implement tasks, five repeats, and the two forced arms: 130 cells. Each task supplies the problem, approach, and key decisions in `design.md`; the agent finds the implementation details. `examples/workflow-authorship-calibration.json` uses those same tasks with one repeat and only the discretionary authored arm: 13 cells. Calibration measures unprompted workflow launches before the full comparison. Both examples keep the same model, effort, profile, and workflow-agent assignment as the forced pilot. The calibration arm applies only `no-learning-review.patch`; it does not force a launch or restrict root tools. Plan refuses either example until every selected task has its design variant.

```bash
bun run bench:workflow-authorship plan bench/chat-ab/examples/workflow-authorship.json
bun run bench:workflow-authorship setup bench/chat-ab/examples/workflow-authorship.json --results bench/chat-ab/results/workflow-authorship-pilot
bun run bench:workflow-authorship run bench/chat-ab/examples/workflow-authorship.json --results bench/chat-ab/results/workflow-authorship-pilot --keep-sandboxes
bun run bench:workflow-authorship resume bench/chat-ab/examples/workflow-authorship.json --results bench/chat-ab/results/workflow-authorship-pilot --keep-sandboxes
bun run bench:workflow-authorship report bench/chat-ab/results/workflow-authorship-pilot
bun run bench:workflow-authorship judge bench/chat-ab/results/workflow-authorship-pilot --a authored --b handcrafted --auth-profile <profile> --dry-run
```

Plan and setup submit no task message. Run and resume spend subject quota. Remove `--dry-run` from judge to spend judge quota. Use full source commit hashes in the final design rather than a moving `HEAD`.

Hidden acceptance checks decide verified success. Each outcome also retains estimated and billed cost, wall time, incomplete and unanswered outcomes, failed attempts, workflow launches, each workflow's phase names and started agent attempts, and the distinct executed rounds of each repeat. Request and usage evidence comes from `events evidence`; `events search` adds the durable workflow registration, definition, and control facts. Each captured source file has its exact byte hash. Its modification time must not be later than the immutable definition fact, and its decoded canonical definition must match that fact before those bytes can establish compliance. A file that was deleted or replaced after launch has unavailable source evidence, not proof that the workflow was authored.

The report shows success k/n and Wilson 95% intervals for each task and arm; median cell cost and wall time; total cost divided by successes; workflows, agents, and repeat rounds; compliance; incomplete and unanswered results; failed attempts; and blinded judge win/tie/loss counts. Cell cost and time include all its attempts, not just the successful retry. The handcrafted arms must launch only byte-identical frozen files; the authored arms must launch only non-frozen files. In the forced arms no launch is non-compliance; in the discretionary arms it counts as no workflow, because choosing to work without one is part of the treatment. Unknown source evidence stays unknown. Non-compliant cells are never excluded from success, cost, or quality results.

Across tasks, the report takes the mean of each task's paired-repeat differences in success rate, cost, and time. A fixed-seed percentile bootstrap resamples tasks 10,000 times for the 95% interval. It never pools repeats as independent tasks. The report states partial pairs and unavailable prices. Judge inputs hide model and arm names, frozen workflow names, and every recorded authored workflow and phase name; workflow-file diffs are withheld from the code-quality judge. Judge quota and accounting remain separate from candidate accounting.

### Status and future directions

The benchmark is paused. The pilots and a 13-task calibration (`bench/findings/workflow-authorship-results.md`) showed that its current tasks cannot answer its question. With Workflows On, Sonnet 5.5 at medium effort launched no workflow in 31 of 31 discretionary cells, including fixes that touch 10 files. With a design-given message, it solved 12 of the 13 tasks alone in 1 to 8 minutes. Forcing a workflow onto such tasks measures orchestration overhead, not the value of a workflow. Using a weaker model only to create headroom changes the question instead of answering it.

Ideas for a later campaign:

1. Use epic-sized tasks on which the agent decides to orchestrate by itself. Then the discretionary arms become the primary comparison, and the forced arms become a check. Candidate sources: large `feat` commits in Flywheel history that touched roughly 15 to 40 files and shipped tests that can become hidden checks, or composites of three or four related history fixes in one subsystem, delivered as one design-given request.
2. Before any paid matrix, gate each candidate task on one discretionary cell. Keep it only when the authored arm launched a workflow without being told. If no candidate triggers orchestration, report that as the result.
3. Size each run by tasks, not trials: about 12 qualified tasks with 3 to 5 trials per arm. The interval across tasks needs many tasks.
4. Run the model-capability axis below on the qualified tasks, as a test of whether a stronger planner benefits more from authoring its own workflow.
5. Retire the two ported plan tasks (`template-multiphase`, `metrics-resteer`) from authorship campaigns. Sonnet solved each alone in about a minute.

### Model-capability axis

The runner already supports per-treatment model and effort overrides. This axis is supported but is not part of the pilot. To compare model capabilities, copy the pilot design into a separate campaign and set an arm's Chat and workflow-agent assignments together:

```json
"authored": {
  "revision": "FULL_SAME_SOURCE_COMMIT",
  "model": "claude-haiku-5-5",
  "effort": "medium",
  "roles": { "workflow-agent": { "model": "claude-haiku-5-5", "effort": "medium" } }
}
```

Keep the other arm, tasks, profile, and skills fixed. Label this as a model-capability comparison, not a clean estimate of authorship alone. No capability-axis result is claimed here.

### Workflow audit

`workflow-audit.ts` has the same design JSON and `plan`, `setup`, `run`, `resume`, `report`, and `judge` actions as coding campaigns. All eleven tests use the five files of the cut-tool-args fixture. Tests 1 to 3 audit them for bugs. Test 1 copies the subject's own prepared workflow into the sandbox project: `review.workflow.yaml` for Flywheel or `review.workflow.js` for Claude Code. The message names that file; all other message text is the same. Test 2 uses the request in `workflow-audit/test2/message.md` and each subject authors its own workflow. Test 3 uses the request in `workflow-audit/test3/message.md`, which names the shape: rounds of finders until a round finds no new bug, then three refuters for each finding and a two-of-three vote. Each subject authors that shape in its own grammar.

Tests 4 and 5 are answer tests: they ask a question, not for a bug hunt, and their messages tell the subject to change no file. Test 4 uses `workflow-audit/test4/message.md`: one parallel lane per file, then one synthesis that traces a malformed tool-call argument from the provider stream to what the user sees, with file:line references. Test 5 uses `workflow-audit/test5/message.md`: three independent design drafts for a safer argument repair, three independent judges that score every draft on correctness, risk, and size of change, then one synthesis of the best design.

Tests 6, 7, and 8 restate tests 2, 4, and 5 without the word "workflow" and without a named shape (`workflow-audit/test6/message.md` and so on). They measure whether a subject chooses a workflow on its own. Test 6 is a bug audit with the site grade of tests 1 to 3. Tests 7 and 8 are answer tests that use the reference answers of tests 4 and 5.

Tests 9, 10, and 11 are small tasks that need no workflow: a quick question, a one-line edit, and a conversational opener (`workflow-audit/test9/message.md` and so on). They measure whether a subject that runs substantive work through workflows still works alone on a small task. Each is an answer test with its own reference answer.

```bash
bun run bench:workflow-audit plan bench/chat-ab/examples/workflow-audit.json
bun run bench:workflow-audit setup bench/chat-ab/examples/workflow-audit.json --results bench/chat-ab/results/workflow-audit-reference
bun run bench:workflow-audit run bench/chat-ab/examples/workflow-audit.json --results bench/chat-ab/results/workflow-audit-reference --keep-sandboxes
bun run bench:workflow-audit resume bench/chat-ab/examples/workflow-audit.json --results bench/chat-ab/results/workflow-audit-reference --keep-sandboxes
bun run bench:workflow-audit report bench/chat-ab/results/workflow-audit-reference
bun run bench:workflow-audit judge bench/chat-ab/results/workflow-audit-reference --a control --b candidate --auth-profile <profile> --dry-run
```

Plan and setup submit no task message. Run and resume spend subject quota. Remove `--dry-run` from judge to spend judge quota. Both the grade and the judge read the whole handoff answer: its summary, then each result field that holds a value, because a subject can put its findings in result fields beside a short summary. For tests 1 to 3, the absolute grade states whether that answer names each shipped bug site, and blinded judging compares the two answers in both slot orders against the reference fix, then tries to refute each winning verdict. Tests 4 and 5 have no site grade: the report shows `not graded` for them, not zero sites named. Their blinded judging compares the two answers against the test's written reference answer, `workflow-audit/<test>/reference.md`, with the same slot orders and refutation. The test 4 reference is a correct trace, and the test 5 reference lists the real risks in the current repair and the behavior that a good design keeps. Line numbers in both refer to the fixture's base commit. Each reference is part of its test's content identity, so the judge refuses a campaign recorded with a different reference. The judge ledger retains calls, accounting, artifact identities, and verdicts, as in coding campaigns. Step evidence remains in execution artifacts; there is no per-step pairing report.

#### Parity check

Use `examples/workflow-audit-parity.json` for the repeatable Flywheel against latest Claude Code comparison. It selects tests 1 to 11 with four repeats and four treatments, 176 cells. Every root and Flywheel workflow agent uses `claude-sonnet-5-5` at medium effort. Flywheel uses the auth profile that the design names. Claude Code uses its normal login with `"ultracode": true`, its standing workflow opt-in and the counterpart of Flywheel's Workflows On. Keep Workflows On throughout the campaign.

| Treatment | Flywheel role table | Subagents |
|---|---|---|
| `fw-nosub` | Only `workflow-agent`: Sonnet medium | `disabledTools: ["subagent"]` |
| `fw-sub-default` | Only `workflow-agent`: Sonnet medium | On, other roles use shipped defaults |
| `fw-sub-sonnet` | Every role, all 18: Sonnet medium | On |
| `claude-code` | Claude Code with Ultracode | Root can dispatch; workflow step agents cannot |

There is no design-level role table. Each Flywheel table replaces the operator's role settings. Omitted roles use that treatment's shipped defaults, which can select another provider. That is the purpose of `fw-sub-default`. Each cell's `roles.json` records the resolved assignments. A pinned model that the profile cannot serve falls back under role policy without an error: a `claude-haiku-4-5` pin on the maintainer's auth profile resolved to `gpt-6-luna`. Compare `roles.json` with the design in the first round.

Claude Code 2.1.292's workflow-subagent definition disallows Agent, Workflow, and SendUserMessage. The installed 2.1.310 smoke offered no Agent tool to its 28 workflow step agents. Thus `fw-nosub` is the apples-to-apples workflow arm. The root remains asymmetric: Claude Code can dispatch subagents up to depth 3, but Flywheel's flag removes `subagent` and its roster from the root too. Do not describe this arm as identical capability exposure.

Claude Code's version is resolved from PATH at plan and run time. It updated from 2.1.308 to 2.1.310 within one session. The report's subject column records the version that ran, not the version first planned.

Run a long campaign from a dedicated detached worktree at the measured commit. Keep `--results` inside that worktree. The cell sandbox denies access to other worktrees, including the main checkout. A results path in main produced `EPERM ... lstat '<repo>'`. Do not weaken isolation to use an external results directory. Keep the worktree until its summary is committed.

Run the checked-in design file itself, never a copy outside the repository. A design copy in a scratch or temporary folder is lost with that folder, as the earlier campaigns' designs were. The file's `HEAD` revisions resolve to the worktree's commit, which cannot move in a detached worktree, so resume keeps the same identity. A changed design is a committed edit of this file or a new file under `examples/`, committed before it runs.

Run these commands from that worktree's root. Use a new results directory for each campaign:

```bash
bun run bench:workflow-audit plan bench/chat-ab/examples/workflow-audit-parity.json
bun run bench:workflow-audit setup bench/chat-ab/examples/workflow-audit-parity.json --results bench/chat-ab/results/workflow-audit-parity-20261023
bun run bench:workflow-audit run bench/chat-ab/examples/workflow-audit-parity.json --results bench/chat-ab/results/workflow-audit-parity-20261023
bun run bench:workflow-audit judge bench/chat-ab/results/workflow-audit-parity-20261023 --a fw-nosub --b claude-code --auth-profile <profile>
bun run bench:workflow-audit judge bench/chat-ab/results/workflow-audit-parity-20261023 --a fw-sub-default --b claude-code --auth-profile <profile>
bun run bench:workflow-audit judge bench/chat-ab/results/workflow-audit-parity-20261023 --a fw-sub-sonnet --b claude-code --auth-profile <profile>
bun run bench:workflow-audit report bench/chat-ab/results/workflow-audit-parity-20261023
```

Plan and setup submit no task message. Run and judge spend model quota. Add `--dry-run` to each judge command first. The first round of the campaign is its smoke: the scheduler runs test1 once for each treatment before later cells. Inspect those four cells as they finish. Verify the root and every workflow agent's model and effort with `phase-timeline.ts`, including Ultracode agents, and read the no-subagent cell's `disabled-tools.json`. The runner stops at the first failed cell; fix the cause and continue with `resume` on the same design and results directory.

The offline report keeps the aggregate and cell tables. It adds per-test rows for all treatments with completed counts, mean wall time, mean estimated cost, sites named, workflows launched, and mean workflow agents. Workflows launched counts cells with at least one workflow-agent phase over cells with complete coverage. Mean workflow agents counts those phases per covered cell, including cells with none. The shared phase readers identify Flywheel workflow agents by session kind `workflow-agent`, and Claude Code workflow agents by transcript paths under `subagents/workflows/wf_*/`. Ordinary subagents, including nested ones, do not count in either column. Missing transcripts, missing request evidence, and incomplete descendant discovery are unavailable and excluded from both denominators.

Each Flywheel row shows its own pair's judge tally against Claude Code. The parity summary has one ratio and judge section per Flywheel arm. Judge ledgers are per ordered pair. Parity ratios divide each Flywheel arm's mean by Claude Code's mean with equal weight per test; below 1 favors Flywheel. Judge replay makes no model call and counts only verdicts that match current artifacts and judge identity.

Record each campaign's summary in `bench/findings/workflow-audit-results.md` in the same commit. Include the measured Flywheel commit, Claude Code version, model and effort evidence, report, and caveats. Results folders are git-ignored; this findings document is the durable record.

A treatment revision must speak today's headless protocol. The harness decodes subject records strictly, so revisions older than recent protocol changes refuse at preflight. Do not add compatibility paths to rerun them. Their history lives in `bench/findings/workflow-audit-results.md`.

## Planning

This family measures how well a Chat plans before it implements: whether its plan finds the requirements that the repository imposes, and whether it catches false claims in the request. Each cell sends one brief from `bench/tasks/planning/` to the Chat agent of a Flywheel source treatment. The task contract is in `bench/tasks/README.md`.

| Task | Stratum | Tree | Known requirements | False premises |
|---|---|---|---|---|
| `healthz-greenfield` | small | empty repository | none | none |
| `session-cost-budget` | medium | `e63bd9b6c9c602dcc2b0643fadfc75a7f947f0ff:flywheel-tui` | 9 | none |
| `handoff-size-guard` | broad | `e63bd9b6c9c602dcc2b0643fadfc75a7f947f0ff:flywheel-tui` | 10 | none |
| `retry-telemetry-refactor` | broad | `e63bd9b6c9c602dcc2b0643fadfc75a7f947f0ff:flywheel-tui` | 12 | m1 to m4 |

The three repository tasks copy `src`, `tests`, `docs`, `scripts`, and the root configuration of the pinned tree, never `bench` or `inspiration`. They are pinned because the current source no longer holds every requirement that they cite.

The brief is followed by one fixed instruction (`PLANNING_INSTRUCTION` in `planning-task.ts`, part of the task identity): write the complete plan to `PLAN.md` at the repository root, change no other file, treat the request as approved, and record each open question with the assumption chosen, because nobody answers questions. The instruction does not name a planning skill: choosing one is part of what a treatment measures.

Capture keeps `PLAN.md` as the cell's `plan.md` artifact when it is a regular file without credential bytes. Every other change is recorded as `otherChanges`: implementation is non-compliance, and the plan is still scored. A cell that ends `input_required` or `incomplete` keeps the plan it wrote, and a cell with no plan counts as one. The final reply stays in `handoff.json`.

Scoring has two parts, both by the pinned chat-ab judge (`CHAT_AB_JUDGE`, which must come from a model family that no treatment uses):

- Recall: one call for each completed cell that has a plan and a manifest. The judge classifies every known requirement as addressed, uncertain, or missed; a reply that leaves out, repeats, or invents an id is no score and is retried on the next `judge`. The ledger is `<results>/recall-<judge>/`.
- Pairwise: the shared block judge in its `plans` mode compares two treatments' plans for the same task and repeat, blinded, in both slot orders, with an adversarial pass. It reads the known requirements (for greenfield: "None: the repository is empty"), never a fix. A pair whose cells lack a plan is skipped.

Judge accounting stays separate from candidate accounting. The report counts, for each stratum and treatment, plans written, addressed requirements over opportunities, uncertain points, false premises addressed, non-compliant cells, unanswered and incomplete cells, and pairwise wins, losses, and ties against each treatment it was compared with. It reads every comparison that `judge` wrote, whichever two treatments it named. It draws no interval.

`examples/planning.json` compares Sonnet 5.5 at medium effort with Opus 5.5 at high effort on the four tasks, three repeats: 24 cells. Each arm applies `no-learning-review.patch`.

```bash
bun run bench:planning plan bench/chat-ab/examples/planning.json
bun run bench:planning setup bench/chat-ab/examples/planning.json --results bench/chat-ab/results/planning-models
bun run bench:planning run bench/chat-ab/examples/planning.json --results bench/chat-ab/results/planning-models
bun run bench:planning report bench/chat-ab/results/planning-models
bun run bench:planning judge bench/chat-ab/results/planning-models --auth-profile <profile> --dry-run
```

Plan submits no task message. Setup prepares the subjects, runs their preflight, and checks every backticked manifest path at the pinned tree. Run and resume spend subject quota. `judge` scores recall for every cell, then compares the first two treatments (or `--a` and `--b`); remove `--dry-run` to spend judge quota.

Caveats:

- A Claude-family author wrote the manifests, so recall can favor plans in that family's style. Recall ranks treatments relative to each other; it is not an absolute measure.
- The judge cannot read the repository, so it judges grounding only through the manifest. The greenfield task has no reference.
- The judge-family rule refuses GPT treatments while the judge is a GPT model.
- Headless Chats can still stop for design approval and write no plan, and can implement despite the instruction. Both are counted, not excluded.
- The pinned tree is from July 2026 and has no `node_modules`; the Chat cannot run its tests.
- The retired step benchmark of `fly.plan-create` exposed its answer key to the subject, so its results are not comparable with this family.

## Evidence and maintenance

A coding, Chat, or workflow-audit results directory holds:

- `campaign.json`: the manifest that pins the comparison. A run writes it; `plan` and `setup` do not.
- `events.jsonl`: one `attempt` record before each cell and one `outcome` record after it, with the subject outcomes, canonical accounting, the grade, and artifact hashes.
- `sources/<treatment>/`: the prepared source worktree and its integrity record.
- `preflight/<treatment>/<id>/`: each preflight, with its `workspace/` and its `artifacts/execution/`.
- `cells/<treatment>-<task>-r<repeat>-<attempt>/workspace/`: the subject's side. It holds the task checkout while the cell runs, or after it with `--keep-sandboxes`, and the cell's temporary folder.
- `cells/<treatment>-<task>-r<repeat>-<attempt>/artifacts/`: the harness side. `run-<n>/` holds `stdout.jsonl`, `stderr.txt`, `plan.json`, `evidence.json`, and the question evidence of each subject invocation. `handoff.json` and `diff.patch` hold the final report and the diff.
- `judge-<pair-hash>.jsonl` (coding and workflow audit): each ordered comparison's calls and verdicts.
- `score-<judge>/` and `compare-<baseline>-<judge>/` (Chat): judge ledgers and reports.

Before you change this harness, run `bun run test -- tests/unit/bench` and `bun run lint:bench`. Check the documented no-spend commands again after you change source preparation, isolation, or subject arguments.
