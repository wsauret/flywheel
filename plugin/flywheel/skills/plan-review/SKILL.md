---
name: plan-review
description: Run ALL reviewer agents in parallel against a plan. Deduplicates findings via fingerprint script and writes findings.json to the active session. Triggers on "review plan", "check plan".
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

Run ALL available reviewer agents in parallel, collect their JSON findings, dedup via fingerprint, and write a merged `findings.json` into the active session directory.

**Philosophy:** Each reviewer represents a different stakeholder perspective. These perspectives legitimately conflict. We do NOT resolve conflicts — we preserve them as distinct findings with `reviewers_matched` annotations and surface disagreements for the user to decide.

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
2. The literal instruction: `scope_context: "plan"`
3. The JSON output contract: findings must conform to `flywheel/schemas/findings.schema.json`
4. The no-file-write constraint (reviewers return findings in their response only; synthesizer handles all file writes)

**Standard reviewer prompt shape:**

```
Review this plan.

scope_context: "plan"

PLAN:
[full plan content or spec.json content]

Return findings as a single JSON object conforming to flywheel/schemas/findings.schema.json. See flywheel/schemas/findings.example.json for the canonical shape. All findings must use scope.kind = "plan" with phase_id / task_id / bc_id populated.

Return valid JSON only — no prose wrapper, no markdown fences. Do NOT write to any files — no editing the plan, no creating review files. The synthesizer owns all file writes.
```

Dispatch the same prompt shape (adapted to each reviewer's focus) to all six reviewers in one message with six Task calls.

**Rules:**

- Do NOT filter reviewers — dispatch all six
- Every prompt MUST include the `scope_context: "plan"` line and the no-file-write constraint
- Launch all six in a single message

---

## Phase 3: Synthesize Findings

Collect each reviewer's response message and treat it as a JSON blob. The synthesizer then runs the following routine:

### 3.1 Parse each reviewer output

For each reviewer response:

- Attempt `jq empty` on the response text. If it fails to parse, record a **synthetic P1 finding** pointing at the reviewer agent file (`flywheel/agents/<reviewer-name>.md`) and continue with remaining reviewers.
- On successful parse, retain the object for merging.

The synthetic P1 shape (authored by the synthesizer itself):

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

For each valid reviewer output, iterate its `findings[]`:

- Any finding with `scope.kind == "code"` is a disambiguation failure (this is a plan-review context; D5 requires plan-scope).
- Emit a **synthetic P1 finding** against the violating reviewer agent file, AND retain the original finding in the merged output so the user can see what the reviewer tried to flag.

Synthetic shape:

```json
{
  "title": "Cross-scope violation: <reviewer-name> emitted code-scope finding in plan-review context",
  "severity": "P1",
  "scope": { "kind": "code", "file": "flywheel/agents/<reviewer-name>.md", "line": null },
  "what_wrong": "<reviewer-name> produced a code-scope finding (<original title>) during plan-review. The reviewer must honor the scope_context parameter.",
  "suggested_fix": "Update the reviewer prompt or agent file so scope.kind always matches the scope_context sent by the invoker.",
  "evidence": "Original finding: <original title> at <file>:<line>."
}
```

### 3.3 Semantic dedup, then policy via fingerprint.sh

**You do the dedup. The script does the policy.**

Walk the reviewer outputs and decide which findings describe the same issue — reviewers may phrase a shared concern differently (e.g. "missing type hints on handlers" vs "handlers lack return annotations" — same problem). Group them by meaning, not by string match.

Then emit one JSON array where each element is a group: `{"reviewers": [...], "finding": <one representative finding from the group>}`. Pipe it to the script:

```bash
# Write your groupings to a tmp file, then:
cat /tmp/grouped.json | flywheel/synthesizer/fingerprint.sh
```

The script annotates each group with `fingerprint`, `match_count`, `reviewers_matched`, and promotes `finding.severity` one level when `match_count >= 2`.

**BLOCKING:** `flywheel/synthesizer/fingerprint.sh` is a black-box tool. Do NOT read its source. Run `flywheel/synthesizer/fingerprint.sh --help` to see the contract if you need it.

### 3.4 Compose the merged findings.json

Shape (conforms to `flywheel/schemas/findings.schema.json`):

```json
{
  "schema_version": 1,
  "reviewer": "synthesizer",
  "summary": "<concat of each reviewer's summary> | <N reviewers ran, M findings total, K dedup groups, severity counts>",
  "findings": [ /* findings from each group + any synthetic P1s */ ],
  "residual_risks": [ /* union across reviewers */ ],
  "open_questions": [ /* union across reviewers */ ]
}
```

**Note**: the `reviewer` field in the schema currently enumerates the 6 reviewer names. Phase 3 of the overall pipeline refactor will extend the schema to accept `"synthesizer"` as a valid value. Until then, the synthesizer writes this field and the schema will be updated to match.

### 3.5 Write to active session

Write the merged object to `.flywheel/plugin/sessions/<session_id>/findings.json`. Use an atomic write:

```bash
# Pseudocode — use Write to a tmp path then mv
tmp=".flywheel/plugin/sessions/<session_id>/findings.json.tmp"
final=".flywheel/plugin/sessions/<session_id>/findings.json"
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
Cross-scope violations: <count>
Malformed outputs: <count>

<concat of each reviewer's summary field, one per line>

Findings written to: .flywheel/plugin/sessions/<session_id>/findings.json

Next step: /fly:plan-consolidation
```

No markdown write to `docs/plans/`. The durable artifact is `findings.json` in the session dir.

---

## Error Handling

- **Active session missing**: error with "No active session. Run /fly:plan first."
- **Reviewer timeout**: treat as malformed output → synthetic P1 against that reviewer.
- **Reviewer returns empty or non-JSON**: synthetic P1 against that reviewer.
- **50% of reviewers fail**: surface in chat summary but still write findings.json with whatever did parse.

---

## Anti-Patterns

- **Filter reviewers** — dispatch all six, always
- **Silently drop cross-scope findings** — surface the violation as a P1
- **Fail the whole synthesis when one reviewer is malformed** — continue with remaining reviewers
- **Write to docs/plans/** — the markdown append was removed in the rigor-gradient refactor
- **Resolve disagreements by picking winners** — the user decides; surface conflicts as distinct findings

---

## Detailed References

- `references/review-summary-template.md` — output format, deduplication patterns
- `references/conflict-handling.md` — philosophy, detection patterns, Open Question conversion
