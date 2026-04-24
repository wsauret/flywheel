---
name: work-review
description: Perform exhaustive code reviews using multi-agent analysis. Reviews PRs, branches, or current changes. Writes review.findings.json to the active session. Triggers on "review", "code review", "check PR".
allowed-tools:
  - Read
  - Write
  - Grep
  - Glob
  - Bash
  - Task
  - Skill
  - AskUserQuestion
---

# Work Reviewing Skill

Perform exhaustive code reviews using multi-agent analysis. Collect each reviewer's JSON findings, dedup via fingerprint, and write a merged `review.findings.json` into the active session directory.

## Input

The review target is provided via `$ARGUMENTS`. Can be:

- PR number (numeric): `123`
- GitHub URL: `https://github.com/org/repo/pull/123`
- Branch name: `feature/my-branch`
- Empty: review current branch changes

The **active session** is resolved via `.flywheel/plugin/active.json`. If that file is missing, error with:

```
No active session. Run /fly:plan first.
```

---

## Phase 1.0: Mechanical Compliance Checks

Run this phase FIRST when the active session has `baseline.json` + `state.json` + `session.json`, indicating this was planned work. Each check emits K1 JSON findings that flow through the Phase 3 synthesizer (fingerprint dedup + session write).

Read `references/plan-compliance.md` for the full jq shapes, example finding JSON for each check, and the HALT semantics. The logic below is the entry-point summary.

There are **TWO** mechanical checks plus a hash-verification gate (Check 0). The former Check 3 (commands re-execution) was **CUT per D3** — do not implement it. Re-running commands adds wall-time and idempotency risk; the trust mechanism for "ran the tests" is the B5 anti-pattern in work-implementation.

### Load artifacts

```bash
SESSION_DIR=".flywheel/plugin/sessions/$(jq -r .session_id .flywheel/plugin/active.json)"
BASELINE="$SESSION_DIR/baseline.json"
STATE="$SESSION_DIR/state.json"
SESSION="$SESSION_DIR/session.json"
```

If `baseline.json` or `state.json` is missing, skip to Phase 1.5 — this was not planned work.

### Check 0 — Baseline Hash Verification (gate)

Recompute the SHA-256 of `baseline.json` and compare it to `session.json.baseline_hash`:

```bash
COMPUTED=$(shasum -a 256 "$BASELINE" | awk '{print $1}')
STORED=$(jq -r '.baseline_hash' "$SESSION")
```

**BLOCKING:** If they differ, emit a synthetic P1 finding `{scope: {kind: "plan", phase_id: "*"}, title: "Baseline was mutated after work-start"}` and **HALT** — do not run Check 1 or Check 2. Their output would be meaningless against an untrusted reference. Document the halt prominently in the Phase 4 summary.

### Check 1 — Structured Diff (scope drift)

Three sub-cases, all P1:

- **Skipped phases**: `baseline.phases[].id` NOT in `state.phases[]` with `status == "completed"` → `{scope: {kind: "plan", phase_id: <id>}, title: "Phase <id> skipped but baseline requires it"}`
- **Files outside baseline**: any path in `state.phases[i].artifacts.files_created[]` or `files_modified[]` NOT in `baseline.phases[i].files[]` → `{scope: {kind: "code", file: <path>, line: null}, title: "File outside baseline scope modified"}`
- **Removed tasks**: when `state.phases[i].outcomes[]` references at least one baseline task id, baseline task ids NOT referenced are treated as removed → `{scope: {kind: "plan", phase_id: <id>, task_id: <tid>}, title: "Task removed from implementation"}`. If no task ids appear in outcomes at all, the check is silent for that phase.

### Check 2 — BC Coverage

Compute the union of `state.phases[].bc_satisfied[]`. For each `baseline.behavioral_contract[].id` NOT in the union → `{scope: {kind: "plan", bc_id: <id>}, title: "Behavioral contract <id> has no satisfying task"}`. Severity P1.

### Emission

Findings from Check 0, 1, and 2 are synthetic (no reviewer agent produced them) but still flow through the Phase 3 synthesizer path alongside reviewer outputs so that cross-source collisions promote severity. The merged set lands in `review.findings.json` via the Phase 3 write path.

Include the mechanical-check summary as the first section of the Phase 4 chat summary. Flag deviations as P1.

---

## Phase 1.5: Setup

### Determine review target

```bash
git branch --show-current
# If PR number:
gh pr view <PR_NUM> --json title,body,files
```

### Setup environment

- If already on target branch: proceed with analysis.
- If different branch: offer to check out the target branch or create a worktree with `git worktree add`.

Ensure the code is ready for analysis before dispatching reviewers.

---

## Phase 2: Dispatch Reviewer Agents

Launch Task for every reviewer in a SINGLE message. Each Task prompt MUST include:

1. The diff / PR content inline (or a reference the reviewer can read)
2. The literal instruction: `scope_context: "code"`
3. The JSON output contract: findings must conform to `flywheel/schemas/findings.schema.json`
4. The no-file-write constraint

**Standard reviewer prompt shape:**

```
Review this change.

scope_context: "code"

CHANGE:
[diff or PR content, or path the reviewer should Read]

Return findings as a single JSON object conforming to flywheel/schemas/findings.schema.json. See flywheel/schemas/findings.example.json for the canonical shape. All findings must use scope.kind = "code" with file and line populated (line may be null if the finding spans the whole file).

Return valid JSON only — no prose wrapper, no markdown fences. Do NOT write to any files. The synthesizer owns all file writes.
```

Dispatch to all six reviewers:

- reviewer-architecture
- reviewer-code-quality
- reviewer-patterns
- reviewer-performance
- reviewer-data-integrity
- reviewer-elegance

### Conditional reviewers

Still dispatch reviewer-data-integrity for every review. If the change contains migration files (`**/migrations/**`, `alembic/`, `prisma/migrations/`), the reviewer will naturally emphasize migration-safety findings.

---

## Phase 3: Synthesize Findings

Collect each reviewer's response message and treat it as a JSON blob.

### 3.1 Parse each reviewer output

For each reviewer response:

- Attempt `jq empty` on the response text. If it fails to parse, record a **synthetic P1 finding** pointing at the reviewer agent file (`flywheel/agents/<reviewer-name>.md`) and continue with remaining reviewers.
- On successful parse, retain the object for merging.

Synthetic P1 shape:

```json
{
  "title": "Reviewer produced invalid JSON: <reviewer-name>",
  "severity": "P1",
  "scope": { "kind": "code", "file": "flywheel/agents/<reviewer-name>.md", "line": null },
  "what_wrong": "<reviewer-name> output could not be parsed as JSON. Its findings are not represented in this merge.",
  "suggested_fix": "Investigate the reviewer prompt or retry that reviewer.",
  "evidence": "Parse failure on reviewer response."
}
```

### 3.2 Reject cross-scope findings

Any finding with `scope.kind == "plan"` is a disambiguation failure (this is a work-review context; D5 requires code-scope).

Emit a synthetic P1 against the violating reviewer agent file and retain the original finding for visibility:

```json
{
  "title": "Cross-scope violation: <reviewer-name> emitted plan-scope finding in work-review context",
  "severity": "P1",
  "scope": { "kind": "code", "file": "flywheel/agents/<reviewer-name>.md", "line": null },
  "what_wrong": "<reviewer-name> produced a plan-scope finding (<original title>) during work-review. The reviewer must honor the scope_context parameter.",
  "suggested_fix": "Update the reviewer prompt or agent file so scope.kind always matches the scope_context sent by the invoker.",
  "evidence": "Original finding: <original title> at phase_id=<...>/task_id=<...>/bc_id=<...>."
}
```

### 3.3 Semantic dedup, then policy via fingerprint.sh

**You do the dedup. The script does the policy.**

Walk the reviewer outputs and group findings that describe the same issue, even when the wording differs. Semantic equivalence is your call; reviewers don't coordinate phrasing.

Emit one JSON array where each element is a group: `{"reviewers": [...], "finding": <representative finding from the group>}`. Pipe it to the script:

```bash
cat /tmp/grouped.json | flywheel/synthesizer/fingerprint.sh
```

The script returns each group annotated with `fingerprint`, `match_count`, `reviewers_matched`, and promotes `finding.severity` one level when `match_count >= 2`.

**BLOCKING:** `flywheel/synthesizer/fingerprint.sh` is a black-box tool. Do NOT read its source. Run `flywheel/synthesizer/fingerprint.sh --help` for the contract.

### 3.4 Triage P3 findings

After dedup, present P3 findings to the user:

```
P3 (Nice-to-have) findings:
1. [Finding title] — [one-line summary] (file:line)
2. [Finding title] — [one-line summary] (file:line)
...

Which P3 items should be included?
1. All
2. None
3. Pick specific ones (list numbers)
```

Keep only the P3s the user selects. Dropped P3s are omitted from `review.findings.json` entirely — they are not deferred.

If there are no P3 findings, skip this step.

### 3.5 Compose the merged review.findings.json

Shape (conforms to `flywheel/schemas/findings.schema.json`):

```json
{
  "schema_version": 1,
  "reviewer": "synthesizer",
  "summary": "<concat of each reviewer's summary> | <N reviewers ran, M findings total, K dedup groups, severity counts>",
  "findings": [ /* P1 + P2 + selected P3 findings, plus synthetic P1s */ ],
  "residual_risks": [ /* union across reviewers */ ],
  "open_questions": [ /* union across reviewers */ ]
}
```

### 3.6 Write to active session

Resolve the target path via `.flywheel/plugin/active.json`:

```
.flywheel/plugin/sessions/<session_id>/review.findings.json
```

Write atomically: write to `review.findings.json.tmp` then rename.

---

## Phase 4: Chat Summary & Next Steps

Print a condensed summary:

```
Work Review — <target>

Reviewers: N ran (<list>)
Findings: M total → K dedup groups
Severity: P1=<count>, P2=<count>, P3=<count kept>/<count dropped>
Cross-scope violations: <count>
Malformed outputs: <count>

<concat of each reviewer's summary field, one per line>

Review written to: .flywheel/plugin/sessions/<session_id>/review.findings.json
```

### Next-step prompt

```
What's next?
1. Implement review findings (invoke /fly:work on the review file)
2. Ship as-is (skip to /fly:ship)
```

- Option 1: invoke the `work-implementation` skill with the `review.findings.json` path as input.
- Option 2: proceed directly to `/fly:ship`.

**No markdown write to `docs/reviews/`.** The durable artifact is `review.findings.json` in the session dir.

---

## Key Principles

- **P1 findings block merge.** Present them prominently in the chat summary.
- **Run reviewers in parallel.** Single message, multiple Task calls.
- **BLOCKING: Always persist the review.** Write `review.findings.json` before presenting the summary. The JSON is the single durable artifact that survives context clears.
- **Prompt for implementation.** After presenting findings, offer to invoke `work-implementation` on the review file.

---

## Error Handling

- **Active session missing**: error with "No active session. Run /fly:plan first."
- **Reviewer failures**: emit synthetic P1 against that reviewer, continue with others. Minimum 50% reviewer success before proceeding.
- **Git/GitHub failures**: if PR not found, verify number. If branch inaccessible, suggest worktree. If gh CLI not authenticated, surface setup instructions.
- **File write failure**: retry once with the `.tmp` pattern; if still failing, include full findings in the chat summary rather than losing them.

---

## Anti-Patterns

- Don't present findings one-by-one asking for approval
- Don't skip reviewers to save time — parallel execution is fast
- Don't create vague findings without specific `file:line` references
- Don't mark P1 findings as P2/P3 to avoid blocking merge
- Don't write markdown review docs to `docs/reviews/` — removed in the rigor-gradient refactor
- Don't end without prompting the user to implement findings
- Don't re-introduce Phase 1.0 "Check 3" (commands re-execution) — CUT per D3; reversing requires a plan-level decision, not an implementation change
- Don't run Check 1 or Check 2 when Check 0 halts — the baseline is untrusted; downstream findings would be noise

---

## Checklists

See `checklists/` for domain-specific review checklists (loaded on demand).
