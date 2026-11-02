---
name: Test & Fix Surface
description: Exercise every surface item from the surface map, fix reproducible issues in the same pass, and record blocking findings.
dependencies: [uat, implementation, verification]
subagents: [implementer, explorer, reviewer-uat, advisor]
output:
  summary: Brief rollup of what was covered, what was fixed, and what remains blocking.
  commands: { min: 1 }
  fields:
    changelog_path:
      type: path
      description: Path to changelog.md written under run_dir. Contains scenarios run, evidence, fixes, and the full ledger.
    unclear_findings_path:
      type: path
      description: Path to unclear-findings.md written under run_dir. Contains every blocking-unfixable item with repro, evidence, attempted fixes, and next action.
    ledger:
      type: list
      min: 1
      description: "Array of one ledger row per surface item. Each row: { surface_id, status (verified | fixed-and-reverified | blocking-unfixable), verification_method (live-drive | artifact-check | external-probe | source-of-truth), evidence, notes? }. No row may be left out and no status outside the three allowed values. `verification_method` MUST be `live-drive` for entry_point | command | screen | interaction | output_format | lifecycle_state | failure_mode surfaces; those categories cannot be verified by reading source. `artifact-check` is for persistence-category surfaces verified by inspecting the persisted file. `external-probe` is for external_dependency surfaces verified via a sanitized live probe. `source-of-truth` is only valid for configuration-category surfaces whose only existence is a schema/registry entry."
      of:
        type: object
        fields:
          surface_id:
            type: string
            description: The surface id from the surface map.
          status:
            type: enum
            values: [verified, fixed-and-reverified, blocking-unfixable]
            description: The final status of the row.
          verification_method:
            type: enum
            values: [live-drive, artifact-check, external-probe, source-of-truth]
            description: How the row was verified.
          evidence:
            type: string
            description: A product-emitted artifact path or a sanitized observation summary. Never a source file path for a runtime method.
          notes:
            type: string
            optional: true
            description: Anything a reader of the row needs beyond the evidence.
    fixes:
      type: list
      optional: true
      description: "Array of fixes applied during the pass: { surface_id, issue, fix_summary, files_changed[], tests_run[]? }. Omit when no fixes were applied."
      of:
        type: object
        fields:
          surface_id:
            type: string
            description: The surface id the fix belongs to.
          issue:
            type: string
            description: What was wrong.
          fix_summary:
            type: string
            description: What changed and why.
          files_changed:
            type: list
            min: 1
            of: { type: string }
            description: Repo-relative paths the fix changed.
          tests_run:
            type: list
            optional: true
            of: { type: string }
            description: The test commands run after the fix.
    blocking_findings:
      type: list
      optional: true
      description: "Array of blocking-unfixable findings: { surface_id, severity (critical | major | minor), repro, evidence, attempted_fixes, next_action }. Must match every ledger row whose status is blocking-unfixable."
      of:
        type: object
        fields:
          surface_id:
            type: string
            description: The surface id of the blocked row.
          severity:
            type: enum
            values: [critical, major, minor]
            description: The severity of the finding.
          repro:
            type: string
            description: Exact actions, including the isolated environment used.
          evidence:
            type: string
            description: Paths to product-emitted artifacts or sanitized observations.
          attempted_fixes:
            type: string
            description: The distinct approaches attempted.
          next_action:
            type: string
            description: The single concrete next step.
---

# QA Verify

Run an iterative, manual QA and polishing campaign over every surface in the prior surface map. This is **not** a report-only task and **not** a batch-automation task. Automated tests are supporting evidence, not the QA itself. The primary objective is to improve the product: when you find a reproducible problem, fix it in the same iteration; when you observe a clear, local polish opportunity, apply it.

This brief is **repo-agnostic**. Discover the project's test/lint/build commands from its manifests before relying on any single tool.

## Operating Mode

Apply the composed UAT method interactively to each campaign row. Issue one input, observe the result immediately, and choose the next input from that observation. Do not batch interactions or replace a live drive with static captures. When an interaction reveals a reproducible issue, stop, reduce it, apply the composed implementation method, verify the correction, re-exercise the row, and then continue.

### Fresh-Pass Invariant

Every test-fix-surface pass starts from zero verified surfaces. Exercise every surface in the current map from scratch during this pass, including a follow-up pass after review-fixes.

Prior QA evidence is never verification evidence for the current pass. Prior changelogs, ledgers, captures, observations, statuses, and product artifacts can identify risks and help order work, but they cannot satisfy a row, reduce current coverage, or appear as the row's evidence. Do not copy, carry forward, summarize, relabel, or downgrade prior results instead of performing the current live operation.

Contest findings set priority, not scope. Address contested rows first, then exercise every other mapped row from scratch. A follow-up pass is a complete QA pass, not a patch to the prior ledger.

## Exercise Means the Real Operation

The composed UAT method defines what counts as exercising a surface: the production code path runs end to end against the real backends, with only local state isolated. The user requested QA and accepted its cost; skipping a surface because the real operation is billable is the same defect as `source-of-truth` for a runtime surface.

If you genuinely cannot exercise a surface: the credential is missing, the third-party service is unreachable, the operation is destructive against shared production data the user has not authorized you to touch (real customer records, public production database rows, a billing account distinct from a QA sandbox account, etc.); that is `blocking-unfixable` with the specific blocker recorded, not a quiet downgrade.

## Inputs

- The output of the surface-map phase with `run_dir`, `surface_map_path`, and the flat `surfaces[]` array. Read both that output and the markdown surface map at `surface_map_path`; the markdown orients you, and the output is the canonical work list.
- The run directory `run_dir` already exists. You write **only** `changelog.md` and `unclear-findings.md` inside it. No other files.
- When this is a follow-up pass after review-fixes returned findings, the output of the phase before carries those findings. Use those findings to order the fresh pass, never as evidence that any surface is verified. Re-exercise every mapped row and every new coverage gap.

## Evidence Model

Evidence is a path or reference to something the product or its environment recorded during the drive, not something you produced and archived. Acceptable evidence forms:

- A path to a product-emitted artifact that exists after the drive: session/state files, transcripts, traces, logs, persisted config, generated reports, queue/journal artifacts, audit databases. The exact paths are project-specific; discover them in Part 1.
- A concise sanitized observation summary embedded in `changelog.md` for the row. Factual, no raw frames. The reader should be able to derive what was observed without re-running the drive.
- A boolean credential/dependency presence summary for `external-probe` rows.

Source-file paths are never valid evidence for runtime surfaces. "The handler is wired in `src/foo.ts:42`" is not evidence that the user-facing behavior works. Never cite a `src/...` path as evidence for a `live-drive`, `artifact-check`, or `external-probe` row.

## Feature Preservation

This QA pass is not permission to reduce product scope. Do not delete, hide, disable, narrow, stub, downgrade, or bypass any existing feature, command, screen, configuration option, integration, or test merely because it is hard to test or currently broken. A valid fix preserves the intended capability and repairs its behavior. Only make a user-visible option unavailable when direct source-of-truth evidence proves it is unsupported for the current configuration/auth/runtime state; record that evidence and preserve the feature for supported states.

If a feature requires a product decision, account authorization, external dependency, or risky architectural change to work, record it as `blocking-unfixable` after safe reduction attempts instead of removing the feature.

## Ledger Discipline

Every surface item from the surface map gets exactly one row in the ledger with one of three statuses:

- `verified`: exercised end to end, observed behavior matches expected behavior, no fix needed.
- `fixed-and-reverified`: a reproducible issue was found, fixed in this pass, and re-tested after the fix.
- `blocking-unfixable`: after safe reduction and at least three documented fix attempts (or a stated reason why one approach is exhaustive), the surface cannot be made to pass without a product decision, missing credential, provider/service outage, missing local executable, destructive side effect, or other hard dependency. Every `blocking-unfixable` row must have a matching entry in `unclear-findings.md`.

`unattempted` is never a valid final status. The Rollup must report `unattempted: 0`.

Each row declares its `verification_method`, drawn from the **Live Exercise Contract** in Part 2. A source-file path is never evidence for a runtime method.

A row is **not** `verified` when:

- The drive produced no observable state change (composed UAT method); record as `blocking-unfixable` with reason `no observable state change detected`.
- The cited evidence does not contain what the row claims it shows. Re-drive and re-cite, or downgrade.
- The justification cites source code or hand-waved reasoning ("this is correct per …Schema.ts") in place of an observed outcome.

---

## Part 0: Baseline and Project Discovery

Before any QA work, capture the starting state:

1. Record the working-tree state. Use a project-scoped status command if one exists; otherwise the relevant VCS status. Summarize in `changelog.md` under "Baseline". Do not include unrelated user changes in your edits.
2. Discover the project's verification tooling from manifests (`package.json`, `Makefile`, `justfile`, `pyproject.toml`, `Cargo.toml`, `go.mod`, etc.). Identify the canonical test command, lint command, and any boundary/typecheck commands.
3. Record the baseline pass/fail of those commands in `changelog.md` (composed verification method).
4. Identify the project's production runtime and the third-party services it depends on. List the configured backends (provider endpoints, database URLs, queue brokers, object stores, OAuth issuers: whatever the project actually talks to in production). For each, confirm a credential or connection is present and usable. If the project distinguishes "production-grade" tiers from cheaper alternatives, use the production tier. Throughout Part 2 the drive routes traffic to these real backends. If a production resource is unavailable or the credential is missing, that specific surface is `blocking-unfixable`; do not paper over it by switching to a fake.

If the project has no test/lint tooling, record that as a constraint and proceed; verification will lean harder on direct exercise.

---

## Part 1: Pre-Flight: Establish Live-Drive Capability

You cannot exercise surfaces without first being able to drive the product. Do not enter Part 2 until this phase passes.

1. **Locate the launch command.** Inspect manifests, executable directories, run scripts, and any project README that documents how to start the product. Pick the canonical foreground command.
2. **Read project testing/UAT docs.** Dispatch an `explorer` to find UAT guides, live integration runbooks, manual-test runbooks, or harness READMEs. If the project has a shared live-drive harness, prefer driving the product through it; it encodes the project's boot signal, input conventions, and the way the product persists state.
3. **Smoke-test the launch.** Start the product and observe the initial state directly. For interactive terminal apps, drive through a pty/tmux harness interactively (issue input → inspect pane → decide next input; never batch-then-dump). For CLIs, servers, browser apps, and libraries, use the equivalent live channel for that product shape.
4. **Identify where the product persists state.** During the drive, the product writes session/state/log/trace/database artifacts of its own. Note their location now; you will cite paths there as evidence in Part 2.
5. **Record the launch recipe in `changelog.md`** under "Baseline → Pre-flight": exact command, harness, isolated sandbox directory, ready-signal predicate, and the product-state location that you noted in action 4. Subsequent scenarios cite the same recipe.

If the product cannot be launched in this environment, stop and record the entire pass as `blocking-unfixable` with the launch failure as the blocker. Do not paper over by marking surfaces verified from source.

---

## Part 2: Iteration Loop

Read the surface map JSON. Group surfaces by category and dependency so that:

- Surfaces with no dependencies are exercised first.
- A surface that depends on another (`dependencies[]`) is exercised after its dependency is at least once verified or marked blocking.
- External-dependency-backed surfaces are scheduled together so credentials/state can be set up once.

Then run this loop until every required row has sufficient current evidence:

1. Pick the next scenario that requires exercise or re-exercise.
2. Drive the live product through it: one input, observe, decide next input.
3. Apply the composed UAT depth-of-proof ladder. Do not stop at "rendered state matches roughly." Record the levels reached in the scenario block.
4. Ask the composed UAT question classes. Each class is required per scenario unless the observed state proves the class non-applicable; record the answer or that proof in the scenario block.
5. Judge the surface against the **Product Bar** (below). Visual hierarchy, taste, color, spacing, affordances, clarity, "does this give the user calm confidence?"; these are part of `verified`, not extras.
6. If you observe a reproducible issue, apply Part 3's Fix-First rule before continuing. Re-drive after the fix.
7. Update `changelog.md` immediately for the row. Do not batch the entire log to the end of the run.

Loop until every surface row has a final status backed by sufficient evidence. Do not lower coverage or silently skip rows.

### Changelog Skeleton

Create `changelog.md` under `run_dir` with this shape and keep it current:

```markdown
# QA Run <run_dir basename>

## Baseline
- Working-tree state at start: <summary>
- Test command: <command>: <pass/fail>
- Lint command: <command>: <pass/fail>
- Other checks: <list>
- Pre-flight: launch command, harness, sandbox, ready signal, where the product persists artifacts.
- Production runtime: <chosen runtime/provider/model>, why this is the production grade for this project.

## Coverage Map
<one-line description of how surfaces were grouped, with totals per category>

## Scenarios
<one entry per surface item exercised; see template below>

## Fixes
<one entry per fix applied; see Part 3>

## Ledger
| surface_id | category | status | verification_method | evidence | notes |
|---|---|---|---|---|---|

## Rollup
- Total surfaces: N
- verified: N
- fixed-and-reverified: N
- blocking-unfixable: N
- unattempted: 0
- live-drive: N (must equal the count of runtime-category surfaces)
- artifact-check: N
- external-probe: N
- source-of-truth: N
- Improvements applied this pass: N (must be ≥ 1 for the initial verify pass)
```

Also create `unclear-findings.md` with a top-level header. Body stays empty until a blocking finding appears.

### Live Exercise Contract

The `verification_method` per row is bounded by the surface's category. Source inspection is **never** valid for a runtime surface.

| Surface category | Required method | Evidence form |
|---|---|---|
| `entry_point` | `live-drive` | Product-emitted launch artifact (log file, startup record, response body) and a sanitized observation summary. |
| `command` | `live-drive` | Persistent state showing the command's effect (the new view, the emitted output, the changed status) referenced by product artifact path. |
| `screen` | `live-drive` | Sanitized observation summary of the rendering plus any product artifact that records the render (transcript entry, snapshot row in the product's own store). |
| `interaction` | `live-drive` | Observed state BEFORE the input and AFTER, summarized in the scenario block. |
| `output_format` | `live-drive` | A real instance of the format/block kind/exit code captured in the product's persistent log or artifact. |
| `lifecycle_state` | `live-drive` | Product artifact recording the named state (status row, queue projection, persistent indicator). |
| `failure_mode` | `live-drive` or `blocking-unfixable` | Evidence of the failure being triggered (fault injection, killed process, malformed input, missing credential) and the product's response. Source-of-truth is **not** acceptable; if no fault-injection harness exists, record as `blocking-unfixable` with the missing harness as the blocker. |
| `persistence` | `live-drive` + `artifact-check` | First drive the product to mutate the persisted state, then inspect the resulting file/row/key. Method recorded as `artifact-check`. |
| `external_dependency` | `external-probe` | Sanitized boolean of credential presence + sanitized response from a minimal probe. Never log secrets. |
| `configuration` | `live-drive` if there is a user-facing toggle; otherwise `source-of-truth` | A schema/registry-only env override may be `source-of-truth`. A user-facing toggle must be driven. |

`source-of-truth` is the escape hatch for surfaces with no user-facing path. It is **not** an escape hatch for runtime surfaces that you found inconvenient to drive. Evidence for `live-drive`, `artifact-check`, and `external-probe` rows MUST NOT be a source file path.

### Product Bar

Evaluate every surface as a product, not as a feature checklist. Ask:

- Is the right complete information visible? Nothing important hidden, nothing irrelevant cluttering.
- Is the state clear? Does the user know what just happened, what is happening, and what they can do next?
- Is the visual hierarchy intentional? Spacing, weight, dim/bright, selective color.
- Are colors meaningful and tasteful? Calm over loud.
- Are controls discoverable? No surprising or irreversible action without warning.
- Does collapse/expand hide and restore exactly the right details?
- Does text fit its container at the project's supported viewport sizes (terminal sizes, browser breakpoints, paper sizes)?
- Does selection/copy/share preserve readable structure where intended?

Cosmetic, layout, and clarity issues are findings. A surface that "functionally works" but renders ugly, ambiguous, or jarring text is a candidate for a polish fix in Part 3, not a free pass to `verified`.

### Scenario Template

Record each scenario under `## Scenarios` with this shape:

```markdown
### <surface_id>
- Method: <live-drive | artifact-check | external-probe | source-of-truth>
- Actions: <exact inputs, commands, or probes; reproducible from the recipe in Pre-flight>
- Expected: <expected_behavior from the surface map>
- Observed: <observed behavior: concrete, sanitized, with the product-artifact path that records it>
- Verification levels reached: <e.g. 1, 2, 3>
- Question classes: <one bullet per class with the question asked and the answer; cite non-applicable proof if any class is skipped>
- Product Bar: <observations against the bar: pass, or specific concern + severity>
- Evidence: <path to a product-emitted artifact or "embedded summary above". NEVER a source file path for runtime surfaces.>
- Outcome: verified | issue (see Fixes) | blocking-unfixable (see unclear-findings.md)
```

If a single drive naturally exercises multiple surfaces, reference the same evidence from each scenario and note the relationship; but write a separate scenario block per surface_id.

---

## Part 3: Fix-First

Fix every reproducible problem you find when the evidence demonstrates that a change is needed. Zero fixes is a valid outcome when complete coverage and sufficient evidence show no reproducible issue or justified polish change. Do not manufacture work to satisfy a minimum.

Fix-first rules:

- If the fix is clear and local, implement it immediately, then re-drive the scenario that exposed it.
- If the fix touches shared behavior, inspect the surrounding architecture before implementing the smallest correct change consistent with the project's existing patterns.
- If the fix is unclear, ambiguous, risky, or requires a taste/product decision: first **reduce the failure** as far as you can, attempt the safe local fix path, and only then record it as `blocking-unfixable` in `unclear-findings.md`.
- For fixes that span multiple surface items, you may dispatch implementer subagents in parallel: one subagent per scoped fix. Subagents must not invent scope.
- After every fix, re-run the project's test/lint commands relevant to the change, then re-drive the scenario that surfaced the issue. A finding is not `fixed-and-reverified` until both passed AND the re-drive produced an observation that proves the fix.

Record each fix under `## Fixes`:

```markdown
### <surface_id>
- Issue: <what was wrong, with the evidence reference that proved it>
- Fix: <what changed and why>
- Files changed: <repo-relative paths>
- Tests run: <commands and result>
- Re-drive: <pass/fail of the scenario after the fix, with the new evidence reference>
```

Do not batch a long list of known fixable issues before acting; work progressively: find, fix, test, re-drive, record, move on.

Do not make tests or QA pass by deleting or unregistering commands, screens, configuration keys, integrations, tests, or coverage rows. Fix the broken path, or record the hard blocker with evidence.

Do not manipulate version-control history during QA. No rebasing, squashing, amending, resetting, cherry-picking, or force-pushing. Commit fixes forward as new commits on the current branch.

---

## Part 4: Blocking Findings

For each `blocking-unfixable` row, add an entry to `unclear-findings.md`:

```markdown
## <surface_id>
- Repro: <exact actions, including isolated environment used>
- Evidence: <paths to product-emitted artifacts or sanitized observations>
- Severity: critical | major | minor
- Why blocked: <product decision, missing credential, account authorization, external outage, destructive side effect, missing executable, missing fault-injection harness, etc.>
- Attempted approaches: <list at least three distinct attempts, OR a one-line justification of why one approach is exhaustive (e.g. "the operation mutates a shared OS resource with no scoped override env")>
- Candidate options: <possible paths forward, including environment overrides or fixtures that would unblock it>
- Recommended next decision: <single concrete next step>
- User impact: <observable effect on the end user>
```

A single failed attempt does not justify `blocking-unfixable`. Mouse-can't-be-driven, harness-doesn't-support, credentials-touch-global-state: each of these has at least one mitigation (alternative input mode, redirected env, scoped sandbox). Try them before declaring the surface blocked.

Do not mark the campaign complete with any `blocking-unfixable` row unless your parent accepted it. Message your parent with `message_session` for each such row and wait for its reply; the parent asks the person when the decision is theirs.

---

## Part 5: Final Verification and Completion Criteria

Before writing the final handoff, audit the pass as a whole.

1. Re-run the project's test command, lint command, and any targeted checks for areas you touched. Record results in `changelog.md` under "Baseline → Final verification".
2. Re-confirm every `fixed-and-reverified` row by re-driving the scenario one more time after the final test run. Update the evidence reference with the post-fix observation.
3. **Evidence-quality gate.** For every ledger row, confirm:
   - `verification_method` matches the row's surface category per the Live Exercise Contract.
   - The `evidence` value is a product-emitted artifact path, persisted artifact reference, sanitized observation summary, or sanitized probe summary; **not** a source file path, for any row whose method is `live-drive`, `artifact-check`, or `external-probe`.
   - Every runtime-category surface has `live-drive` (or `blocking-unfixable` for failure modes that need missing harnesses).
   - Any row that fails these checks is downgraded: if you can still exercise it before the handoff, do so and replace the evidence; otherwise re-classify as `blocking-unfixable` with the missing-evidence reason recorded in `unclear-findings.md`.
4. **Goal completion checklist.** Confirm every item below. Each that is false blocks the handoff.
   - [ ] Every surface row has exactly one ledger entry with a final status (`verified`, `fixed-and-reverified`, or `blocking-unfixable`). No `unattempted`.
   - [ ] `blocking_unfixable` count matches the number of entries in `unclear-findings.md`.
   - [ ] Per-method totals in the Rollup match a re-count of the ledger.
   - [ ] Every row has the required coverage and fresh evidence from this invocation; no prior observation satisfies a row.
   - [ ] Every `live-drive`/`artifact-check`/`external-probe` row's evidence references a product-emitted artifact or sanitized observation summary, never a `src/...` path.
   - [ ] No `*.log`, `*.txt`, `*.png`, screenshot, pane-dump, or per-surface transcript files exist in `run_dir`. Only `changelog.md`, `unclear-findings.md`, and the prior `surface-map.md` from the surface-map phase.
   - [ ] Production runtime in use throughout the pass; no silent downgrade to cheaper/mock alternatives.
   - [ ] Every `blocking-unfixable` row has ≥3 attempted approaches OR a stated reason why one approach is exhaustive.
   - [ ] Final project test and lint commands are green (or any failure is recorded as baseline-attributable with evidence).
5. Update the Rollup in `changelog.md` with status totals, verification-method totals, and the improvement count.

Final tool call is `handoff` with the structured findings. Fill every required field that the output contract of your brief declares. Include `fixes` when fixes were applied. Include `blocking_findings` when any row is `blocking-unfixable`. Cite the baseline and final check commands in `commands_run`.

After the handoff write, present a short text summary stating: total surfaces, verified, fixed-and-reverified, blocking-unfixable, the run directory path, the per-method totals, the count of improvements applied, and the highest-risk gaps that need user attention.

---

## Anti-Patterns

- **Source-only verification of runtime surfaces**: citing a source file path as evidence for an `entry_point`, `command`, `screen`, `interaction`, `output_format`, `lifecycle_state`, or `failure_mode` surface. These require `live-drive` evidence (or `blocking-unfixable` for fault-injection failure modes that need a missing harness).
- **Batch automation + frame dumps**: pre-scripting a sequence of inputs, dumping pane snapshots to `*.log` files, and then judging from the dumps. The static snapshot stops you watching the product.
- **Identical evidence across distinct surfaces**: citing the same product artifact for two different surface rows when the rows describe different behaviors. Each row needs its own observation.
- **Rationalizing unexpected behavior via source**: when the live drive produced something surprising, do not justify it by reading `src/...` and asserting it is "correct per the registry." The user does not see source. If the rendered behavior is wrong for the user, it is a finding even if the code "intended" it.
- **Single-attempt blocking-unfixable**: declaring a surface blocked after one failed approach. Three distinct attempts or a stated reason for exhaustiveness is the bar.
- **Sampling**: exercising "representative" surfaces and inferring the rest. Every row in the surface map is exercised or marked blocking with evidence.
- **Pre-classifying surfaces out of scope**: marking a surface "out of scope" without an attempted run and concrete blocker is forbidden.
- **Report-only findings**: recording an issue without attempting a fix. Reproducible, fixable issues must be fixed in the same pass.
- **Manufactured improvement**: applying a fix or polish without evidence of benefit merely to produce a nonzero change count. Clean, evidence-backed zero fixes is valid.
- **Silent runtime downgrade**: substituting a cheaper provider, mock backend, or stub harness to save cost, or citing a unit test pass or any in-process double as evidence for a runtime-category surface. If the production runtime is unavailable, that is `blocking-unfixable`.
- **Disabling features to make QA pass**: silently dropping a command, screen, configuration option, or test row instead of repairing the broken path.
- **Cluttering the run directory**: the run directory holds `surface-map.md` (from the surface-map phase), `changelog.md`, and `unclear-findings.md`. No transcripts, raw shell output, screenshots, or per-surface dumps anywhere in the repo.
- **Printing secrets**: never print API keys, tokens, or unmasked credential contents while verifying external dependencies. Report boolean presence and sanitized error summaries only.
- **History rewriting**: no rebase/squash/amend/reset/cherry-pick/force-push during QA.
- **Skipping pre-flight**: proceeding into Part 2 without first proving the product can be launched and driven. If the launch is broken, that is the campaign's first finding, not a reason to fall back to source inspection.