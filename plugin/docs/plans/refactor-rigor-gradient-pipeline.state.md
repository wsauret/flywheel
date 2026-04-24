---
plan: refactor-rigor-gradient-pipeline.md
status: completed
schema_version: 3
started: 2026-04-23T22:00:00
completed: 2026-04-24T06:30:00
---

# Execution State: Rigor-Gradient Pipeline + CE Adoptions

## Progress
- [x] Phase 1: Foundation — schemas, .gitignore, conventions (completed 2026-04-23)
- [x] Phase 2: Reviewer boundary — JSON output + method openers + fingerprint dedup (completed 2026-04-23)
- [x] Phase 3: Planning pipeline — spec.json from plan-creation, consolidation refines (completed 2026-04-23)
- [x] Phase 4a: Execution boundary — TaskList input, baseline hash, state.json, atomic writes (completed 2026-04-23)
- [x] Phase 4b: Compliance — work-review mechanical checks (2 checks) (completed 2026-04-23)
- [x] Phase 5: Command surface + end-to-end dogfood (completed 2026-04-23; 164 assertions pass across 17 test files)
- [x] Phase 6: Skill hygiene — B1 rationale, A4 BLOCKING audit, B7, B8 (completed 2026-04-24; 3 core SKILLs -16.9% avg word count, 13 BLOCKING prefixes added, B8 Step 2.5 in compound, 164/164 regression still green)

## Key Decisions (from plan consolidation — D1-D14)
- D1: context.md stays separate sidecar (mirrors TUI)
- D2: baseline.json = full spec copy + SHA-256 in session.json
- D3: Check 3 (commands re-execution) CUT — 2 mechanical checks, not 3
- D4: Reviewer Output Format references shared fixture flywheel/schemas/findings.example.json
- D5: Reviewers get explicit scope_context: "plan" | "code" param
- D6: Fingerprint = shell + jq at flywheel/synthesizer/fingerprint.sh
- D7: spec.json.pre-consolidation sidecar, cleaned on ship
- D8: ajv dev-dependency only; BC-coverage prose-directive-based at runtime
- D9: /fly:review routing heuristic authored in Phase 4a session-detection.md
- D10: Phase 4 split into 4a (execution) + 4b (compliance)
- D11: Plan stays self-contained (not delta-over-design-doc)
- D12: /fly:session list/switch/delete DEFERRED to follow-up PR
- D13: BC cardinality — at-least-one required; multiple = warning; orphans = error
- D14: TS/build infra minimal — shell + jq + schema files only, no package.json

## Learnings
- Phase 1: `ajv-cli` doesn't bundle ajv-formats; tests run with `--validate-formats=false` (format is annotation-only in draft 2020-12 by default)
- Phase 1: `task-list.schema.json` root lacks `additionalProperties: false` to allow `baseline.schema.json` to extend via `allOf + $ref` (cross-ref + strict root don't compose cleanly in ajv). Inner $defs remain strict.
- Phase 1: BC ID uniqueness enforced via array-level `uniqueItems` with identical items proxy; ID-collision-with-different-body is procedural (D13 coverage gate).
- Phase 1: plugin/.gitignore created even though repo root already covers `.flywheel/` (belt + suspenders).

## Code Context

**Created (Phase 1):**
- flywheel/schemas/findings.schema.json
- flywheel/schemas/task-list.schema.json
- flywheel/schemas/state.schema.json
- flywheel/schemas/baseline.schema.json
- flywheel/schemas/session.schema.json
- flywheel/schemas/findings.example.json
- tests/schemas/fixtures/ (17 fixtures)
- tests/schemas/run.sh (executable, 110 lines)
- plugin/.gitignore (new — `.flywheel/`, `.DS_Store`)

**Modified (Phase 1):**
- flywheel/skills/flywheel-conventions/SKILL.md (72 → 135 lines; added A2 severity block, B2 FP suppression, B3 observable framing, B4 spec quality bar; updated word-limit line)

**Created (Phase 2):**
- flywheel/synthesizer/fingerprint.sh (~135 lines bash + jq; --group flag for dedup + severity promotion)
- tests/reviewers/fingerprint.test.sh (12 assertions, all pass)
- tests/reviewers/malformed.test.sh (5 assertions, all pass)
- tests/reviewers/fixtures/ (4 fixtures)

**Modified (Phase 2):**
- 6 reviewer agents — method-primed openers (A3), JSON output format referencing shared findings.example.json (D4), scope_context param (D5). Total trimmed from 730 → 585 lines.
  - reviewer-architecture.md (91 → 70)
  - reviewer-code-quality.md (109 → 84)
  - reviewer-data-integrity.md (144 → 121)
  - reviewer-elegance.md (225 → 189; local Severity Mapping removed; preserved no-language-standards P2-10)
  - reviewer-patterns.md (82 → 65; local Severity Guide removed; condensed Output Format replaced)
  - reviewer-performance.md (79 → 56)
- flywheel/skills/plan-review/SKILL.md (152 → 211 lines; scope_context="plan"; fingerprint dedup; rejects cross-scope; handles malformed; writes findings.json to session; Phase 5 markdown append removed; empty-args reads active.json)
- flywheel/skills/work-review/SKILL.md (200 → 269 lines; scope_context="code"; same synthesizer structure; writes review.findings.json; docs/reviews/ markdown write removed)
- flywheel/schemas/findings.schema.json — added "synthesizer" to reviewer enum (needed for synthesizer output to validate)

## Learnings (Phase 2)
- Phase 2: Synthesizer output uses `reviewer: "synthesizer"` — added to enum so merged findings.json validates.
- Phase 2: Reviewer files trimmed substantially (730 → 585 lines total, -20%) by replacing long Output Format blocks with the standard JSON instruction.
- Phase 2: fingerprint.sh ~135 lines (larger than plan's ~50 estimate) because `--group` flag with severity promotion + reviewers_matched tracking needs the extra logic.

## UAT findings (live tmux claude sessions, 2026-04-23)

Ran 8 real-session scenarios against the installed plugin via `claude --dangerously-skip-permissions` in tmux. Full pipeline exercised end-to-end against a scratch Flask hello endpoint. 6 real bugs caught + fixed:

**UAT-1 (plan-creation)**: agent produced free-form `context` with keys like `codebase_state`/`chosen_stack` instead of schema-required `{key_files[], patterns[], gotchas[]}`. FIXED: added explicit BLOCKING shape + concrete example to plan-creation/SKILL.md.

**UAT-2 (plan-creation)**: agent added extra `name` and `verification_commands` fields to tasks; used `{name, expects}` objects for test_scenarios instead of plain strings; used " (new)" suffixes on file paths. FIXED: added DO-NOT directive + concrete phase-with-tasks example.

**UAT-3 (plan-review synthesizer)**: synthesizer output uses `reviewer: "synthesizer"` but findings.schema.json enum didn't list it. FIXED: added `"synthesizer"` to enum.

**UAT-4 (plan-review synthesizer)**: synthesizer adds metadata to each finding (`id`, `fingerprint`, `match_count`, `reviewers_matched`, `base_severity`, `promoted`) — schema rejected via `additionalProperties: false`. FIXED: added as optional finding properties.

**UAT-5 (plan-review synthesizer)**: agent produces `scope: {kind: "plan", phase_id: "...", task_id: "...", bc_id: null}` — schema required string, not null. FIXED: phase_id/task_id/bc_id accept `["string", "null"]`.

**UAT-6 (work-implementation state.json)**: agent uses `session_id` (not `plan_id`) as canonical identifier; doesn't include `summary` (state is execution log, not self-describing). FIXED: state.schema.json requires `session_id`, drops required `summary`; `plan_id` remains optional.

**UAT-7 (work-review synthesizer)**: synthesizer includes `mechanical_compliance: {check_0_baseline_hash, check_1_structured_diff, check_2_bc_coverage}` top-level metadata — schema rejected. FIXED: added as optional top-level property.

**UAT passes** (8/8, all scenarios succeed):
- S1 plan-creation: valid spec.json + context.md + session.json + active.json
- S2 plan-review: 6 reviewers in parallel, 16 raw findings → 9 dedup via fingerprint.sh, all scope.kind=plan, schema valid
- S3 plan-consolidation: 4 Open Questions + 3 P3 triage interactive; `.pre-consolidation` sidecar; origin flip plan-creation → plan-consolidation
- S4 work-implementation: baseline.json written, SHA-256 hash stored in session.json, state.json initialized, active_skill clears on exit (P2-14)
- S5 work-review: Check 0 HASH-MATCH, Check 1 clean, Check 2 clean, 6 reviewers re-dispatched for code review, 18 raw → 7 dedup, review.findings.json with mechanical_compliance
- S6 skip-review: covered by full-pipeline + skip-review e2e tests
- S7 stale active.json: **exact expected rescue message** — "Session X not found. Clearing active pointer." + pointer cleared
- S8 slug prefix-scan: myfeat-{04-20,04-21,04-22} → picked myfeat-2026-04-22 (most recent) on tiebreak

## Blockers (if any)
<!-- Issues preventing completion of current phase -->

## Error Log
<!-- Track errors per 3-Strike Protocol -->

| Error | Attempt | Approach | Outcome |
|-------|---------|----------|---------|
