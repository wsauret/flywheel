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

Perform exhaustive code reviews using multi-agent analysis. Collect each reviewer's prose findings, structure them into the schema, dedup semantically, and write a merged `review.findings.json` into the active session directory.

**Architecture:** Reviewers return natural-language prose; the synthesizer (this skill) is the single schema enforcer. Reviewers focus on finding issues; structuring is the synthesizer's job.

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

## Phase 1: Setup

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
2. Code-scope location format: `<repo-relative-path>` or `<repo-relative-path>:<line>`
3. The no-file-write constraint (reviewers return prose; synthesizer handles all file writes)

**Standard reviewer prompt shape:**

```
Before assessing your domain, read the Elegance Discipline and "Lead with the Failure" sections of flywheel-conventions. If your domain finding is a principle violation (architectural ceremony, mechanical pattern application, parallel state introduced for performance, indirection without depth, SRP/DRY violations, etc.), lead the Failure paragraph with the principle name (e.g., "Shallow Wrapper. ..." or "Violates SRP. ..."). Don't defer to reviewer-elegance; the elegance lens applies to every domain.

Review this change.

CHANGE:
[diff or PR content, or path the reviewer should Read]

Return findings as natural-language prose (see your Output Format). Use code-scope locations: `<repo-relative-path>` or `<repo-relative-path>:<line>` (e.g., "src/auth.ts" or "src/auth.ts:42"). Do NOT emit JSON; the synthesizer structures your output.

Do NOT write to any files. The synthesizer owns all file writes.
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

The synthesizer reads each reviewer's prose output and structures it into `flywheel/schemas/findings.schema.json` shape. Reviewers do NOT emit JSON; the synthesizer is the single schema enforcer.

### 3.1 Read each reviewer's prose output

For each reviewer response:

- Extract per-finding: Title, Severity, Location, Failure (paragraph), Fix.
- If a reviewer returned "No findings" or equivalent, record zero findings from this reviewer.
- If a reviewer's output is incomplete (missing one of the required elements on any finding), construct a synthetic P1 against that reviewer's agent file noting the gap, AND retain the partial finding for the user's visibility.

Synthetic P1 shape (constructed by the synthesizer, in schema):

```json
{
  "title": "Reviewer output incomplete: <reviewer-name>",
  "severity": "P1",
  "location": "flywheel/agents/<reviewer-name>.md",
  "failure": "<reviewer-name> returned a finding missing one of the required elements (Title/Severity/Location/Failure/Fix). The structuring step couldn't fully ingest it; the synthesizer's review may be incomplete for this reviewer's domain. Without complete fields, downstream consumers can't reliably act on the finding.",
  "fix": "Investigate the reviewer's prompt or retry that reviewer. Check whether the agent file or dispatch text needs tightening."
}
```

### 3.2 Validate location format

This is work-review context, so location must be code-scope (`<repo-relative-path>` or `<repo-relative-path>:<line>`). If a reviewer emitted a plan-scope location like `phase-2/t1`, that's a disambiguation failure. Construct a synthetic P1 against the reviewer:

```json
{
  "title": "Wrong location tier: <reviewer-name> emitted plan-scope location in work-review",
  "severity": "P1",
  "location": "flywheel/agents/<reviewer-name>.md",
  "failure": "<reviewer-name> emitted location '<bad-location>' in a work-review context. Code reviews require code-scope locations like 'src/auth.ts' or 'src/auth.ts:42', not plan-scope phase ids. The reviewer must honor the location format the dispatch specified, otherwise findings can't be matched to actual files for fixes.",
  "fix": "Update the reviewer prompt or agent file so the location format always matches the invoker's tier."
}
```

Retain the original (mistargeted) finding alongside so the user can see what was flagged.

### 3.3 Semantic dedup

Walk the findings and group those describing the same issue — reviewers may phrase a shared concern differently (e.g., "missing type hints on handlers" vs "handlers lack return annotations" — same problem). Group by meaning, not by string match.

For each group:
- Take max severity (P1 > P2 > P3). Severity is not promoted by corroboration; a P3 that three reviewers flagged is still a P3.
- Merge the Failure paragraphs into a single rich paragraph that captures the union of intent + observation + reasoning.
- Pick the strongest Fix or merge them into a single coherent proposal.

### 3.3a Drift arbitration (files outside spec scope)

When a reviewer finding targets a file that is NOT in `spec.phases[].files[]`, the synthesizer arbitrates before including it in the final output.

Procedure for each such finding:

1. Read the file. The reviewer flagged something specific; evaluate the finding against the actual file content.
2. Separately, evaluate intent: does the file's existence look like a principled extension (DRY crossed a threshold, SRP split, shared helper, test fixture), or scope creep (unrelated refactor, speculative abstraction, drive-by changes)?
3. **If principled extension**: keep or drop the reviewer's finding based on its merit, independent of the drift. Do NOT additionally flag "file outside baseline" — the file being outside baseline is not, by itself, a finding.
4. **If scope creep**: keep the reviewer's finding. Additionally emit a P2 synthetic finding with location `<path>` and title "Out-of-scope file: <path>" noting the unrelated work.

Principled-extension signals:
- File is in a `tests/fixtures/`, `shared/`, or similar reuse-pattern location
- Has 2+ production consumers (DRY threshold)
- Aligns with an agents.md / ADR rule the spec already cites in `context.patterns[]`
- No behavior change outside what the spec phases declared

Creep signals:
- Unrelated to any declared phase goal
- Single-consumer, no reuse
- Adds new behavior not declared in any phase
- Touches files/directories far from the phase's declared scope

The synthesizer applies this judgment once at merge time.

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

### 3.5 Structure into schema and write

Compose the final JSON, conforming to `flywheel/schemas/findings.schema.json`:

```json
{
  "schema_version": 1,
  "findings": [ /* P1 + P2 + selected P3 findings, plus synthetic P1s for incomplete reviewers and wrong-location-tier */ ],
  "open_questions": [ /* union across reviewers */ ]
}
```

Validate against `flywheel/schemas/findings.schema.json`. If validation fails, the synthesizer's structuring step had a bug — fix and retry.

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
Wrong-location-tier violations: <count>
Incomplete reviewer outputs: <count>

Top findings:
- <title> (P1)
- <title> (P1)
- <title> (P2)

Review written to: .flywheel/plugin/sessions/<session_id>/review.findings.json
```

The "Top findings" list shows 3-5 highest-severity finding titles, ordered by severity then by appearance.

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
- Don't create vague findings without specific `location` references (`path` or `path:line`)
- Don't mark P1 findings as P2/P3 to avoid blocking merge
- Don't ask reviewers to emit JSON — they emit prose; the synthesizer structures
- Don't write markdown review docs to `docs/reviews/` — removed in the rigor-gradient refactor
- Don't end without prompting the user to implement findings

---

## Checklists

See `checklists/` for domain-specific review checklists (loaded on demand).
