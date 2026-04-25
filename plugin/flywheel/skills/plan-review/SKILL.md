---
name: plan-review
description: Run ALL reviewer agents in parallel against a plan. Deduplicates findings semantically and writes findings.json to the active session. Triggers on "review plan", "check plan".
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

# Plan Reviewing Skill

Run ALL available reviewer agents in parallel, collect their prose findings, structure them into the schema, dedup semantically, and write a merged `findings.json` into the active session directory.

**Philosophy:** Each reviewer represents a different stakeholder perspective. These perspectives legitimately conflict. We do NOT resolve conflicts — we preserve them as distinct findings and surface disagreements for the user to decide.

**Architecture:** Reviewers return natural-language prose; the synthesizer (this skill) is the single schema enforcer. Reviewers focus on finding issues; structuring is the synthesizer's job.

## Input

Plan identifier via `$ARGUMENTS`. If empty, the skill reads the active session pointer at `.flywheel/plugin/active.json` and loads that session's `spec.json` as the review target.

If `.flywheel/plugin/active.json` does not exist, error with:

```
No active session. Run /fly:plan first.
```

---

## Phase 1: Resolve Target

1. If `$ARGUMENTS` is non-empty, treat as a plan path.
2. Otherwise: read `.flywheel/plugin/active.json`, extract `session_id`, load `.flywheel/plugin/sessions/<session_id>/spec.json`.
3. The review target (plan content or spec content) is passed inline to the reviewers.

**Plan reviewers:** reviewer-architecture, reviewer-code-quality, reviewer-patterns, reviewer-performance, reviewer-data-integrity, reviewer-elegance.

Reviewers may catch external claim issues (version mismatches, anti-patterns, security concerns) as part of their normal review. There is no separate enrichment step — plan-creation handles initial validation; reviewers provide a second check from their respective perspectives.

---

## Phase 2: Dispatch ALL Reviewers in Parallel

Launch Task for every reviewer in a SINGLE message. Each Task prompt MUST include:

1. The plan content inline
2. Plan-scope location format: `<phase_id>` or `<phase_id>/<task_id>`
3. The no-file-write constraint (reviewers return prose; synthesizer handles all file writes)

**Standard reviewer prompt shape:**

```
Before assessing your domain, read the Elegance Discipline and "Lead with the Failure" sections of flywheel-conventions. If your domain finding is a principle violation (architectural ceremony, mechanical pattern application, parallel state introduced for performance, indirection without depth, SRP/DRY violations, etc.), lead the Failure paragraph with the principle name (e.g., "Shallow Wrapper. ..." or "Violates SRP. ..."). Don't defer to reviewer-elegance; the elegance lens applies to every domain.

Review this plan.

PLAN:
[full plan content or spec.json content]

Return findings as natural-language prose (see your Output Format). Use plan-scope locations: `<phase_id>` or `<phase_id>/<task_id>` (e.g., "phase-2" or "phase-2/t1"). Do NOT emit JSON; the synthesizer structures your output.

Do NOT write to any files. The synthesizer owns all file writes.
```

Dispatch the same prompt shape (adapted to each reviewer's focus) to all six reviewers in one message with six Task calls.

**Rules:**

- Do NOT filter reviewers — dispatch all six
- Every prompt MUST specify plan-scope location format and the no-file-write constraint
- Launch all six in a single message

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
  "failure": "<reviewer-name> returned a finding missing one of the required elements (Title/Severity/Location/Failure/Fix). The structuring step couldn't fully ingest it; the synthesizer's review may be incomplete for this reviewer's domain. Without complete fields, downstream consolidation can't reliably integrate the finding.",
  "fix": "Investigate the reviewer's prompt or retry that reviewer. Check whether the agent file or dispatch text needs tightening."
}
```

### 3.2 Validate location format

This is plan-review context, so location must be plan-scope (`<phase_id>` or `<phase_id>/<task_id>`). If a reviewer emitted a code-scope location like `src/auth.ts:42`, that's a disambiguation failure. Construct a synthetic P1 against the reviewer:

```json
{
  "title": "Wrong location tier: <reviewer-name> emitted code-scope location in plan-review",
  "severity": "P1",
  "location": "flywheel/agents/<reviewer-name>.md",
  "failure": "<reviewer-name> emitted location '<bad-location>' in a plan-review context. Plan reviews require plan-scope locations like 'phase-2' or 'phase-2/t1', not code-scope paths. The reviewer must honor the location format the dispatch specified, otherwise findings can't be matched to spec.json structure during consolidation.",
  "fix": "Update the reviewer prompt or agent file so the location format always matches the invoker's tier."
}
```

Retain the original (mistargeted) finding alongside so the user can see what was flagged.

### 3.3 Semantic dedup

Walk the findings and group those describing the same issue — reviewers may phrase a shared concern differently (e.g., "phase-2 missing fallback" and "phase-2 lacks retry logic" — same gap). Group by meaning, not by string match.

For each group:
- Take max severity (P1 > P2 > P3). Severity is not promoted by corroboration; a P3 that three reviewers flagged is still a P3.
- Merge the Failure paragraphs into a single rich paragraph that captures the union of intent + observation + reasoning.
- Pick the strongest Fix or merge them into a single coherent proposal.

### 3.4 Structure into schema

Compose the final JSON, conforming to `flywheel/schemas/findings.schema.json`:

```json
{
  "schema_version": 1,
  "findings": [ /* deduped findings + synthetic P1s for incomplete reviewers + synthetic P1s for wrong location tier */ ],
  "open_questions": [ /* union of any open questions reviewers raised */ ]
}
```

### 3.5 Validate and write

Validate the structured JSON against `flywheel/schemas/findings.schema.json`. If validation fails, the synthesizer's structuring step had a bug — fix and retry. Reviewers are not at fault for synthesizer bugs.

Atomic write to `.flywheel/plugin/sessions/<session_id>/review.findings.json`:

```bash
tmp=".flywheel/plugin/sessions/<session_id>/review.findings.json.tmp"
final=".flywheel/plugin/sessions/<session_id>/review.findings.json"
# write JSON to $tmp
mv "$tmp" "$final"
```

---

## Phase 4: Chat Summary

Print a condensed summary to the user (NOT the full findings.json):

```
Plan Review — <slug>

Reviewers: N ran (<list>)
Findings: M total → K dedup groups
Severity: P1=<count>, P2=<count>, P3=<count>
Wrong-location-tier violations: <count>
Incomplete reviewer outputs: <count>

Top findings:
- <title> (P1)
- <title> (P1)
- <title> (P2)

Findings written to: .flywheel/plugin/sessions/<session_id>/review.findings.json

Next step: /fly:plan-consolidation
```

The "Top findings" list shows 3-5 highest-severity finding titles, ordered by severity then by appearance.

No markdown write to `docs/plans/`. The durable artifact is `review.findings.json` in the session dir.

---

## Error Handling

- **Active session missing**: error with "No active session. Run /fly:plan first."
- **Reviewer timeout**: treat as incomplete output → synthetic P1 against that reviewer.
- **Reviewer returns empty or unparseable prose**: synthetic P1 against that reviewer.
- **50% of reviewers fail**: surface in chat summary but still write findings.json with whatever did parse.

---

## Anti-Patterns

- **Filter reviewers** — dispatch all six, always
- **Silently drop wrong-tier locations** — surface the violation as a P1
- **Fail the whole synthesis when one reviewer is malformed** — continue with remaining reviewers
- **Ask reviewers to emit JSON** — they emit prose; the synthesizer structures
- **Write to docs/plans/** — the markdown append was removed in the rigor-gradient refactor
- **Resolve disagreements by picking winners** — the user decides; surface conflicts as distinct findings

---

## Detailed References

- `references/review-summary-template.md` — output format, deduplication patterns
- `references/conflict-handling.md` — philosophy, detection patterns, Open Question conversion
