---
date: 2026-04-23
status: draft
type: refactor
source_design: docs/plans/2026-04-23-ce-adoptions-plan.md
source_research: docs/research/2026-04-23-compound-engineering-vs-flywheel.md
---

# Plan: Rigor-Gradient Pipeline + CE Adoptions

## Goal

Reshape Flywheel's planning → review → consolidation → work → work-review pipeline so every stage emits/consumes a structured JSON artifact (`spec.json`, `findings.json`, `baseline.json`, `state.json`) under a per-session directory (`.flywheel/plugin/sessions/<id>/`). Add assertion-level traceability via a `behavioral_contract[]` + per-task `fulfills[]` pattern. Layer targeted compound-engineering adoptions (method-primed reviewer openers, false-positive suppression, observable-behavior framing) on top to sharpen reviewer quality and reduce noise in agent output.

Skip-review (plan-creation → work) is a first-class path; review + consolidation are refinement passes. Rigor increases through refinement, not through stage count.

See `docs/plans/2026-04-23-ce-adoptions-plan.md` for the full architecture rationale and `docs/research/2026-04-23-compound-engineering-vs-flywheel.md` for the compound-engineering comparison this plan filters through.

---

## Scope

### In scope

**Architecture changes (K1–K6, mutually dependent):**
- K1 — Reviewer output becomes JSON with polymorphic `scope` (code vs. plan findings)
- K2 — Shared `TaskList` schema with `behavioral_contract[]` + `fulfills[]`
- K3 — `plan-creation` creates a session + emits `spec.json` (drops MINIMAL/MORE/A LOT templates)
- K4 — `plan-consolidation` becomes a refinement pass: merges `findings.json` into `spec.json`
- K5 — `work-implementation` consumes `TaskList` (either `spec.json` or `findings.json` via adapter)
- K6 — `baseline.json` (read-only after work-start) + `state.json` with `commands_run` re-execution check

**CE adoptions (Tier A — direct code-output elegance):**
- A1 — Fingerprint-based dedup on findings JSON
- A2 — Severity behavioral criteria in `flywheel-conventions`
- A3 — Method-embedded reviewer openers (6 agents)
- B2 — False-positive suppression catalog
- B3 — Observable-behavior framing for finding content
- B4 — Spec quality bar + BC coverage validation
- B5 — Concrete anti-patterns in `work-implementation`
- B6 — System-wide test check (late-loaded)

**CE adoptions (Tier B — skill hygiene / token wins):**
- A4 — `**BLOCKING:**` prefix audit
- A5 — Core principles numbered list in `plan-creation`
- B1 — Rationale discipline rule + extraction audit
- B7 — Negative routing on 4 skill descriptions
- B8 — `compound` discoverability check (Step 2.5)

**Supporting work:**
- `.flywheel/` added to `.gitignore`
- New `flywheel/schemas/` directory with 5 authoritative JSON Schema files
- New `/fly:session` command surface (optional — open question)

### Out of scope

- No migration of existing plans in `docs/plans/` — clean break per project policy (no backward-compat shims).
- No changes to `brainstorm`, `debug`, or `ship` skill bodies (only their `description:` frontmatter for B7).
- No changes to `flywheel/commands/fly/*` beyond what the pipeline shifts require (most commands already just invoke skills).
- No changes to the sibling `flywheel-tui` repo. Schemas may be shared in the future (see Open Questions).
- No ideation/tracker integration, HITL, validator subagents, persona catalog, or multi-platform tooling (design doc Rejected items R1–R7).
- No conditional reviewer dispatch — all 6 reviewers always fire (predictability preserved).

---

## Acceptance Criteria

Pass/fail, testable at the end of Phase 6:

1. **AC-PIPE-001** — `/fly:plan "add thing"` creates `.flywheel/plugin/sessions/add-thing-YYYY-MM-DD/` containing valid `spec.json` + `context.md` + `session.json`; updates `.flywheel/plugin/active.json`.
2. **AC-PIPE-002** — `spec.json` conforms to `flywheel/schemas/task-list.schema.json` (validates with `bunx ajv validate`). Contains `schema_version: 1`, non-empty `summary` (100–5000 chars), `behavioral_contract[]` with stable `BC-<AREA>-<NNN>` IDs, and every BC is claimed by exactly one task's `fulfills[]`.
3. **AC-PIPE-003** — `/fly:work` with no args reads `.flywheel/plugin/active.json`, loads the session's `spec.json`, writes `baseline.json` (frozen copy) + initialized `state.json`.
4. **AC-PIPE-004** — `/fly:work <slug>` prefix-scans `sessions/<slug>-*` and promotes it to active without a filesystem sweep.
5. **AC-PIPE-005** — `/fly:review` dispatches 6 reviewers; each returns JSON conforming to `flywheel/schemas/findings.schema.json` with polymorphic `scope` (code for code reviews, plan for plan reviews). Output file is session's `findings.json` (plan-review) or `review.findings.json` (work-review). No markdown review document is written.
6. **AC-PIPE-006** — Cross-reviewer fingerprint matches collapse via pure `Set` operation (no regex/string parsing in synthesizer).
7. **AC-PIPE-007** — `/fly:consolidate` reads `spec.json` + `findings.json`, resolves Open Questions interactively one at a time, writes refined `spec.json`. BC coverage re-validated after integration (every BC claimed once, no orphans).
8. **AC-PIPE-008** — `work-review` Phase 1.0 runs three mechanical checks against `baseline.json` + `state.json`: structured diff (scope drift), BC coverage (every BC has evidence), commands re-execution spot-check (sample N, compare exit codes). Each emits JSON findings conforming to K1.
9. **AC-PIPE-009** — Skip-review path works: `/fly:plan` → `/fly:work` → `/fly:review` produces a full session directory with all artifacts, no consolidation required.
10. **AC-PIPE-010** — `baseline.json` is not mutated by `work-implementation` (file mtime unchanged after Phase 2 completes).
11. **AC-PIPE-011** — All 6 reviewer agents load `flywheel-conventions` via frontmatter and inherit updated severity criteria (A2), FP suppression rules (B2), and observable-behavior framing (B3).
12. **AC-PIPE-012** — `reviewer-elegance.md:179-182` and `reviewer-patterns.md:61-65` no longer define local severity tables that conflict with the shared convention.
13. **AC-PIPE-013** — `.flywheel/` is ignored by git (`git check-ignore .flywheel/plugin/sessions/test/spec.json` returns the path).
14. **AC-PIPE-014** — End-to-end dogfood: run `/fly:plan "add a trivial feature"` → `/fly:work` → `/fly:review` on a scratch branch. All artifacts validate. No prose-parsing boundaries anywhere in the pipeline.

---

## Phase 1 — Foundation: Schemas, Storage, Shared Conventions

**Goal**: establish the substrate the rest of the refactor depends on. Authoritative schemas in `flywheel/schemas/`, `.flywheel/` ignored by git, and the three finding-content rules (A2, B2, B3) landed in `flywheel-conventions`.

**Depends on**: nothing (foundation).

### Files

- `/Users/wsauret/Documents/GitHub/flywheel/plugin/.gitignore` (add `.flywheel/`)
- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/schemas/` (new directory)
- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/schemas/findings.schema.json` (new)
- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/schemas/task-list.schema.json` (new)
- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/schemas/state.schema.json` (new)
- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/schemas/baseline.schema.json` (new)
- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/schemas/session.schema.json` (new)
- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/skills/flywheel-conventions/SKILL.md` (currently 72 lines; adds FP suppression + observable-behavior framing + updates severity at line 25)

### Test steps

Tests for this phase are schema-validation tests run via `bunx ajv`:

1. **Write fixture suite** at `/Users/wsauret/Documents/GitHub/flywheel/plugin/tests/schemas/fixtures/` with:
   - `findings-valid-code.json` — minimal valid code-scope finding
   - `findings-valid-plan.json` — minimal valid plan-scope finding
   - `findings-missing-summary.json` — should fail (summary required)
   - `findings-missing-schema-version.json` — should fail
   - `findings-invalid-scope-kind.json` — should fail (scope.kind must be `code` or `plan`)
   - `task-list-valid.json` — spec with BC + fulfills claim
   - `task-list-orphan-bc.json` — BC not claimed by any task (validator supports, BC-coverage rule lives in consolidation step)
   - `state-valid.json` — state with `commands_run`
   - `baseline-valid.json` — baseline (frozen copy of task-list-valid)
   - `session-valid.json` — session metadata
2. **Write test runner** (bash script or bun test) that runs `bunx ajv -s <schema> -d <fixture>` for each pair and asserts expected pass/fail.
3. Expected: all "valid" fixtures pass; all "missing-*" / "invalid-*" fixtures fail with the expected keyword error.

### Implementation steps

1. **`.gitignore`** — append `.flywheel/` on its own line. Verify existing content is preserved; append only.

2. **`findings.schema.json`** — authoritative JSON Schema (draft 2020-12) with:
   - `schema_version: 1` (required, const)
   - `reviewer` (required, enum: 6 reviewer names)
   - `summary` (required, string, minLength 100, maxLength 5000)
   - `findings[]` (array of objects, each with required `title`, `severity` (P1/P2/P3), polymorphic `scope`, `what_wrong`, `suggested_fix`, `evidence`)
   - `scope` is a `oneOf` over two branches:
     - `kind: "code"` + required `file` + optional `line`
     - `kind: "plan"` + optional `phase_id`, `task_id`, `bc_id` (at least one must be non-null — enforce via `anyOf`)
   - `residual_risks[]` (array of strings, may be empty)
   - `open_questions[]` (array of strings, may be empty)

3. **`task-list.schema.json`** — schema for `spec.json` + `baseline.json`:
   - `schema_version: 1` (const)
   - `plan_id` (required, string, slug pattern)
   - `summary` (required, 100–5000 chars)
   - `goal` (required, string)
   - `origin` (required, `{ created_by: "plan-creation"|"plan-consolidation", findings_path: string|null }`)
   - `context` (required, `{ key_files[], patterns[], gotchas[] }`)
   - `behavioral_contract[]` (required, array; each `{ id, title, description, evidence, area }`; `id` matches `^BC-[A-Z0-9]+-\d{3}$`)
   - `phases[]` (required; each `{ id, goal, depends_on[], files[], tasks[], verification, manual_verification }`)
   - `phases[].tasks[]` — each `{ id, description, files[], test_scenarios[], fulfills[] }`; `fulfills` items must match BC ID pattern
   - `success_criteria[]` (required, array of strings)

4. **`state.schema.json`**:
   - `schema_version: 1`, `plan_id`, `status` (enum: `in_progress`, `completed`), `summary`
   - `phases[]` — each `{ id, status, started_at, completed_at, outcomes, strikes[], bc_satisfied[], artifacts: { files_created[], files_modified[], commands_run[] } }`
   - `commands_run[]` — each `{ command, exit_code (integer), stdout_tail (string) }`
   - `learnings[]`, `error_log[]`

5. **`baseline.schema.json`** — re-uses `task-list.schema.json`'s structure (`$ref`-able) but marked `baseline: true` (or equivalent marker indicating immutability is a protocol rule, not a schema rule — schema-level constraint is just conformance to task-list shape).

6. **`session.schema.json`**:
   - `schema_version: 1`, `session_id` (slug-date pattern), `slug`, `status` (enum: `active`, `paused`, `completed`)
   - `started_at`, `last_checkpoint_at`, `active_skill` (enum of 5 skill names, nullable)
   - `artifacts` object with optional pointers: `spec`, `findings`, `baseline`, `state`, `review_findings`, `context`

7. **`flywheel-conventions/SKILL.md`** edits (current file: 72 lines):
   - **Replace line 25** (severity one-liner) with the A2 three-line block:
     ```
     **Severity**:
     - **P1**: High-impact defect — security, data loss, breaking change, or likely hit in normal usage. BLOCKS MERGE.
     - **P2**: Moderate issue with real downside (edge case, perf regression, maintainability trap). Fix if straightforward.
     - **P3**: Low-impact, narrow scope. User's discretion.
     ```
   - **Add after Output Rules (~line 29)** — B2 False-Positive Suppression section (verbatim from design doc K1/B2 — universal rule + code-only + plan-only subsections).
   - **Add after B2** — B3 "Finding Quality: Lead with Observable Behavior" section with the code and plan examples from the design doc.
   - **Word-count impact**: ~+25 lines. Under the load-on-every-invocation budget; no need to extract to references/ (per design doc B2 rationale).

### Verification

```bash
# Schema validation tests
bunx ajv --version  # confirm ajv installed (install as dev dep if missing)
bun run tests/schemas/run.sh  # or: bun test tests/schemas/  — runs fixture pass/fail suite

# Gitignore verification
mkdir -p .flywheel/plugin/sessions/test && touch .flywheel/plugin/sessions/test/spec.json
git check-ignore .flywheel/plugin/sessions/test/spec.json  # should print the path
rm -rf .flywheel/plugin/sessions/test

# flywheel-conventions sanity
wc -l flywheel/skills/flywheel-conventions/SKILL.md  # should be ~97 lines (72 + ~25)
grep -c '^## False-Positive Suppression' flywheel/skills/flywheel-conventions/SKILL.md  # should be 1
grep -c '^## Finding Quality: Lead with Observable Behavior' flywheel/skills/flywheel-conventions/SKILL.md  # should be 1
```

### Success criteria

- All 5 schemas author-validate (parse as JSON Schema 2020-12 themselves via `ajv compile`).
- Fixture suite: all 10+ fixtures pass/fail as expected.
- `flywheel-conventions/SKILL.md` contains B2 and B3 sections and the updated A2 severity block.
- `.flywheel/` is git-ignored.

---

## Phase 2 — Reviewer Boundary: JSON Output + Method Openers + Dedup

**Goal**: all 6 reviewers emit findings as JSON conforming to `findings.schema.json`; synthesizers in plan-review and work-review write `findings.json` / `review.findings.json` and collapse cross-reviewer overlaps via fingerprint. Method-embedded openers (A3) sharpen the kind of inelegance each reviewer catches.

**Depends on**: Phase 1 (schemas + conventions must exist).

### Files

All 6 reviewer agents under `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/agents/`:

- `reviewer-architecture.md` (92 lines; opener lines 9-10, Output Format lines 64-92)
- `reviewer-code-quality.md` (110 lines; opener lines 9-12, Output Format lines 84-110)
- `reviewer-elegance.md` (226 lines; opener lines 9-17, Output Format lines 200-226, **local severity lines 179-182 to remove**)
- `reviewer-performance.md` (80 lines; opener lines 9-11, Output Format lines 52-80)
- `reviewer-patterns.md` (83 lines; opener lines 9-11, Output Format lines 67-83 — **condensed 3-section format, differs from others**, local severity lines 61-65 to remove)
- `reviewer-data-integrity.md` (145 lines; opener lines 9-13, Output Format lines 117-145)

Synthesizer logic in:
- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/skills/plan-review/SKILL.md` (Phase 3)
- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/skills/work-review/SKILL.md` (Phase 3)

### Test steps

1. **Fixture-based synthesizer tests** at `tests/reviewers/`:
   - `six-reviewer-findings-code.json` — mock output from 6 reviewers on a code review (`scope.kind: "code"`)
   - `six-reviewer-findings-plan.json` — mock output from 6 reviewers on a plan review (`scope.kind: "plan"`)
   - `overlapping-findings.json` — 3 reviewers report same issue at `src/auth.ts:42-44` with minor wording variance → fingerprint collision expected, severity promotes by one level.
2. **Fingerprint unit test** — import the dedup function (or test via CLI if implemented as a script). Assert:
   - Code fingerprint: `code:src/auth.ts:6:parsedate-validates-input` (line 42 → bucket 6 via `floor(42/7)`)
   - Plan fingerprint: `plan:phase-2:t3:BC-AUTH-001:error-handling-missing`
   - Overlapping findings with same fingerprint collapse to one
   - Cross-reviewer collision promotes severity (P2 + P2 from two reviewers → P1)
3. **Live dogfood test**: on the current branch, run `/fly:review` and inspect `session/review.findings.json` — should conform to schema, should have non-zero findings, should not duplicate trivial overlaps.

### Implementation steps

1. **Rewrite each reviewer's opener** with the method-embedded form from design doc A3 table. For example:
   - `reviewer-architecture` lines 9-10 → "You are an architecture reviewer who traces dependency direction, state ownership, and abstraction layer boundaries. You spot layering violations and circular imports by mentally mapping the module graph."
   - Keep the rest of the reviewer prompt intact (scope notes, checklists).
2. **Replace each reviewer's Output Format section** with K1 JSON spec:
   - Remove the 6-section markdown template (or 3-section for `reviewer-patterns`).
   - Add "Return findings as a JSON object conforming to `flywheel/schemas/findings.schema.json`. Example: …" with a minimal valid example showing one code-scope finding and one plan-scope finding.
   - Reference the schema rather than restate it (per K1 rationale: single source of truth).
3. **Remove local severity tables** in `reviewer-elegance.md:179-182` and `reviewer-patterns.md:61-65` (both now conflict with the updated shared A2 severity). They already `skills: [flywheel-conventions]` — the shared definition takes over.
4. **`plan-review/SKILL.md` Phase 3** rewrite:
   - Each reviewer Task result is JSON, parsed directly (no regex).
   - Build a fingerprint per finding via the formula in design doc A1.
   - Group by fingerprint; promote severity by one level (P3→P2, P2→P1) when ≥2 reviewers share a fingerprint.
   - Write merged array to the active session's `findings.json`.
   - Print natural-language summary to chat from the `summary` fields of the 6 reviewers + merge metadata.
   - **Remove** the "append Review Summary to plan.md" behavior (Phase 5 in current plan-review; see `plan-review/SKILL.md` current Phase 5 which mutates `docs/plans/<name>.md` via append — this behavior is replaced wholesale).
5. **`work-review/SKILL.md` Phase 3** rewrite: same dedup logic, but write to `review.findings.json` in the active session. Also removes the markdown review document write (`docs/reviews/YYYY-MM-DD-<slug>.md`). Remove the `references/review-document-template.md` reference.

### Verification

```bash
# Line-count sanity
wc -l flywheel/agents/reviewer-*.md
# Expect modest line-count decreases (shorter openers, Output Format reduced from template table to schema ref)

# Opener method-check
grep -h '^You are' flywheel/agents/reviewer-*.md | head -6
# Each line should start with "You are a(n) <domain> reviewer who ..." — the method form

# No local severity tables
grep -A1 'Severity Mapping\|Severity Guide' flywheel/agents/reviewer-elegance.md flywheel/agents/reviewer-patterns.md
# Should find nothing (removed)

# Output Format references schema
grep -c 'findings.schema.json' flywheel/agents/reviewer-*.md
# Each reviewer should reference the schema file

# Synthesizer test
bun run tests/reviewers/dedup.test.ts
```

### Success criteria

- All 6 reviewers' openers match the design doc A3 table (verbatim).
- All 6 reviewers' Output Format sections reference `findings.schema.json` and provide a schema-conforming example.
- `reviewer-elegance` and `reviewer-patterns` no longer carry local severity definitions.
- Synthesizer produces one valid `findings.json` / `review.findings.json` per run with fingerprint-deduped findings.
- Live dogfood on `/fly:review` against the current branch: artifact conforms, no regex in the code path.

---

## Phase 3 — Planning Pipeline: `spec.json` from Stage 1, Consolidation Refines

**Goal**: `plan-creation` directly composes `spec.json` conforming to `task-list.schema.json` with `behavioral_contract[]` synthesized from user intent + research. `plan-consolidation` becomes a refinement pass that merges `findings.json` into `spec.json` (no more "compose from scratch" role). MINIMAL/MORE/A LOT templates are deleted.

**Depends on**: Phase 1 (task-list schema); Phase 2 if consolidation needs to read a findings.json file (foundational schema present, but consolidation's code path touches both).

### Files

- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/skills/plan-creation/SKILL.md` (227 lines — heavy rewrite)
- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/skills/plan-creation/references/plan-templates.md` (delete — MINIMAL/MORE/A LOT gone)
- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/skills/plan-creation/references/formatting-guide.md` (update for session-id filename convention)
- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/skills/plan-creation/references/research-dispatch.md` (keep — locate→analyze unchanged)
- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/skills/plan-creation/references/validation-research.md` (keep — Context7 flow unchanged)
- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/skills/plan-consolidation/SKILL.md` (153 lines — heavy rewrite)
- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/skills/plan-consolidation/references/consolidated-plan-template.md` (delete — replaced by JSON refinement procedure)
- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/skills/plan-review/SKILL.md` (153 lines — finalize Phase 2's edits, confirm no `plan.md` append path remains)
- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/skills/plan-consolidation/references/extraction-patterns.md` (review — keep if still relevant to findings merge logic, else delete)

### Test steps

1. **Unit-style fixture test**: given a synthetic feature description, run `plan-creation` in isolation (dry-run, if possible) and assert:
   - `spec.json` conforms to `task-list.schema.json`
   - `behavioral_contract[]` has ≥1 entry with valid `BC-<AREA>-<NNN>` ID format
   - Every BC is claimed by exactly one task (BC-coverage rule)
   - Top-level `summary` is 100–5000 chars
   - `origin.created_by === "plan-creation"`
2. **Consolidation merge test**: given a fixture `spec.json` + `findings.json` (from Phase 2 tests), run `plan-consolidation` and assert:
   - Refined `spec.json` contains integrated P1 fixes (as updated task descriptions or new tasks)
   - BC coverage still holds after integration (every BC claimed once)
   - `origin.created_by === "plan-consolidation"`
3. **Live dogfood**: `/fly:plan "add a trivial toy feature"` → inspect session directory. Then `/fly:review` → inspect `findings.json`. Then `/fly:consolidate` → inspect refined spec. Every artifact must validate against its schema.

### Implementation steps

1. **`plan-creation/SKILL.md` rewrite**:
   - Keep Phase 0 (existing knowledge), Phase 1 (locate→analyze), Phase 2 (Context7 external validation) intact. Their research output feeds the JSON composer.
   - Replace Phase 3 (template switching) + Phase 4 (write markdown) + Phase 5 (context file) with the new composition procedure per design doc K3 (11 steps: derive session ID → synthesize phases/tasks → assign file paths → enumerate test scenarios → compose BCs → quality bar → write spec.json → write context.md → write session.json → update active.json → summary).
   - Delete all references to MINIMAL/MORE/A LOT.
   - Apply A5: replace the current Philosophy/Context Compaction block (lines ~17-21) with the 5-principle numbered list from design doc A5.
   - Apply B7: update the `description:` frontmatter to include the "For exploratory requests where the user is unsure … once spec.json exists, use plan-review for evaluation or go straight to work" negative-routing note.
   - Apply B4 (plan quality bar) as a gate between JSON composition and file write — BC coverage check + file-paths/test-scenarios check. Unresolved uncertainty → `open_questions[]` on the spec rather than vague tasks.
2. **`plan-templates.md` delete** — remove entirely. Add a one-line note in the parent skill if any tool still references the file path (otherwise clean deletion).
3. **`formatting-guide.md` update**: change the example from `feat-add-user-auth.md` to `add-user-auth-2026-04-23` (session ID format). Filename is now a session directory name, not a plan filename.
4. **`plan-consolidation/SKILL.md` rewrite** per design doc K4:
   - Inputs: active session's `spec.json` + `findings.json` + `context.md`
   - Procedure: read → surface Open Questions one at a time → integrate P1 findings into spec tasks/BCs → handle P2 (integrate or defer with rationale) → triage P3 (user decides) → re-validate BC coverage → overwrite `spec.json` → summary.
   - If `findings.json` has zero findings and zero open questions → no-op, print "no refinements needed", prompt for work.
   - **Remove**: the current behavior of reading from `plan.md` (with appended Review Summary) and writing `consolidated-plan-template.md`-shaped markdown. The whole markdown path is gone.
5. **`consolidated-plan-template.md` delete**.
6. **`plan-review/SKILL.md`** — final sweep to confirm no `plan.md` append path remains after Phase 2 (Phase 2's synthesizer rewrite already replaces Phase 5's append; this is verification, not new work).

### Verification

```bash
# plan-creation structure
grep -c 'MINIMAL\|MORE\|A LOT' flywheel/skills/plan-creation/SKILL.md  # should be 0
grep -c 'spec.json' flywheel/skills/plan-creation/SKILL.md              # should be ≥3
grep -c 'behavioral_contract' flywheel/skills/plan-creation/SKILL.md    # should be ≥2
test ! -f flywheel/skills/plan-creation/references/plan-templates.md    # file deleted

# plan-consolidation structure
grep -c 'findings.json' flywheel/skills/plan-consolidation/SKILL.md     # should be ≥3
grep -c 'consolidated-plan-template' flywheel/skills/plan-consolidation/SKILL.md  # should be 0
test ! -f flywheel/skills/plan-consolidation/references/consolidated-plan-template.md

# Dogfood
bun run tests/pipeline/plan-create-consolidate.test.ts
```

### Success criteria

- `plan-creation` produces valid `spec.json` with `behavioral_contract[]` and BC coverage holding.
- `plan-consolidation` merges `findings.json` into `spec.json` without altering non-affected tasks; BC coverage still holds.
- MINIMAL/MORE/A LOT system is fully removed (no references anywhere).
- End-to-end: `/fly:plan` → `/fly:consolidate` runs cleanly against a synthetic feature.

---

## Phase 4 — Execution Boundary: `TaskList` Input, JSON State, Read-Only Baseline

**Goal**: `work-implementation` accepts `spec.json` or `findings.json` via an adapter; writes `baseline.json` (read-only after work-start) and `state.json` (with `commands_run` accuracy per K6). `work-review` Phase 1.0 runs three mechanical compliance checks: structured diff, BC coverage, commands re-execution spot-check. Replaces all current markdown state tracking (current `.state.md` is schema v3 markdown with checkboxes — see `work-implementation/references/state-file-template.md`).

**Depends on**: Phases 1–3 (schemas, reviewers, specs must all flow through the new shape).

### Files

- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/skills/work-implementation/SKILL.md` (194 lines — Phase 0 + Phase 1 rewrite)
- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/skills/work-implementation/references/state-file-template.md` (currently markdown-checkbox v3; replace with JSON state template per K5/K6)
- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/skills/work-implementation/references/baseline-procedure.md` (new — procedure for freezing spec.json → baseline.json)
- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/skills/work-implementation/references/session-detection.md` (rewrite — use `active.json` pointer + per-session dirs, not single `session.md`)
- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/skills/work-implementation/references/session-file-template.md` (replace: markdown → JSON per session.schema.json)
- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/skills/work-implementation/references/load-resume-procedures.md` (rewrite — spec.json/findings.json adapter logic)
- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/skills/work-implementation/references/checkpoint-procedure.md` (rewrite — JSON state write; `artifacts.commands_run` accuracy requirement)
- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/skills/work-review/SKILL.md` (200 lines — Phase 1.0 rewrite with three mechanical checks)
- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/skills/work-review/references/plan-compliance.md` (rewrite for three K6 mechanical checks)

### Test steps

1. **Fixture-based adapter test**: given a fixture `spec.json`, load via adapter → assert `TaskList` matches expected shape. Given a fixture `findings.json`, load via adapter → assert `TaskList` is synthesized (each finding becomes a task, grouped by file/subsystem into phases).
2. **Baseline immutability test**: start work-implementation with a fixture spec, confirm `baseline.json` exists. Mutate a spec field post-start. Assert `baseline.json` file mtime unchanged. Run any work-implementation step that might touch baseline → assert still unchanged.
3. **Compliance check tests** (Phase 1.0 in work-review):
   - **Structured diff**: baseline has 3 phases, state has only 2 completed + 1 skipped → P1 finding ("skipped phase-X").
   - **BC coverage**: baseline has 5 BCs, state's `bc_satisfied[]` union covers 4 → P1 finding for the uncovered BC.
   - **Commands re-execution**: state claims `bun run test src/foo.test.ts` exited 0; re-execute → exit 0 matches (pass) or exit 1 (P1 finding).
4. **Live dogfood**: run `/fly:plan` → `/fly:work` on a trivial scratch task. Confirm `baseline.json` + `state.json` created, phases advance correctly, `commands_run` captured with real exit codes.

### Implementation steps

1. **`work-implementation/SKILL.md` Phase 0 (Session Detection) rewrite**:
   - Read `.flywheel/plugin/active.json` (O(1) active pointer lookup).
   - If `$ARGUMENTS` is a slug: prefix-scan `.flywheel/plugin/sessions/<slug>-*`, promote the match to active (update `active.json`).
   - If `$ARGUMENTS` is a path ending in `findings.json`: use that session (fix-findings mode).
   - If no active and no args: error "No active session. Invoke /fly:plan to start one."
   - Update `references/session-detection.md` to match.
2. **`work-implementation/SKILL.md` Phase 1 (Load & Resume) rewrite**:
   - Detect input type: spec.json present → plan mode; review.findings.json only → fix-findings mode.
   - Adapter: spec.json → deserialize into `TaskList`. findings.json → adapter groups findings by file/subsystem, converts each finding into a task, synthesizes `TaskList` (BC carried from parent if exists, else synthesized from finding titles).
   - Write `baseline.json` (frozen copy of TaskList; schema-validate; once written this phase, READ-ONLY).
   - Write initialized `state.json` (all phases `not_started`).
   - Update `session.json.active_skill = "work-implementation"`.
3. **`work-implementation/SKILL.md` Phase 2 (Execution Loop)**:
   - Iterate `TaskList.phases[]`. Per task, generate file content, run verification command.
   - Per phase completion, write `state.phases[]` entry with `artifacts` (`files_created[]`, `files_modified[]`, `commands_run[]` — real exit codes only, accuracy enforced by work-review re-execution).
   - Update `state.bc_satisfied[]` from the phase's tasks' `fulfills[]` claims as they complete.
   - Checkpoint updates `session.json.last_checkpoint_at`.
4. **`work-implementation/references/` rewrites**:
   - `state-file-template.md` — new JSON template per `state.schema.json`.
   - `baseline-procedure.md` (new) — "copy spec.json to baseline.json at work-start; do not mutate; any mid-execution plan change requires explicit re-planning (user edits spec.json, re-invokes work-implementation, fresh baseline)."
   - `session-file-template.md` — JSON per `session.schema.json`.
   - `load-resume-procedures.md` — adapter logic + resume via `active.json`.
   - `checkpoint-procedure.md` — JSON state write; `commands_run` accuracy requirement; reference to K6 re-execution consequence.
5. **B5 anti-patterns**: append to `work-implementation/SKILL.md` anti-patterns section — three concrete items from design doc B5 verbatim (no session-based phase splits; no per-task approval asking; no "done" without verification).
6. **B6 system-wide test check**: append to `work-implementation/references/verification-gates.md` the 5-question catalog from design doc B6 (callbacks/middleware/observers; real chain vs mocks; orphaned state; other interfaces; cross-layer error alignment).
7. **`work-review/SKILL.md` Phase 1.0 rewrite** per design doc K6:
   - Read `baseline.json` + `state.json`.
   - **Check 1 (structured diff)**: compare `baseline.phases[].files[]` and task IDs vs `state.phases[].files_*[]`. Skipped phases, removed tasks, files outside baseline → P1 findings in K1 JSON format with `scope.kind = "code"` where applicable, `scope.kind = "plan"` with `phase_id` for skipped-phase findings.
   - **Check 2 (BC coverage)**: compute union of `state.phases[].bc_satisfied[]`. For each `baseline.behavioral_contract[].id` not in that union → P1 finding with `scope.kind = "plan"` and `bc_id` set.
   - **Check 3 (commands re-execution)**: sample last N=3 `commands_run` entries across phases. Re-run each via Bash; compare exit codes. Mismatch → P1 finding. Missing files claimed in `files_created`/`files_modified` (check via `test -f`) → P1 finding.
   - Each check's findings flow through the same fingerprint-dedup + write-to-`review.findings.json` pipeline as the reviewer findings (K1, A1).
8. **`work-review/references/plan-compliance.md` rewrite** to describe the three mechanical checks (replaces current prose-compare description).

### Verification

```bash
# Adapter tests
bun run tests/work/adapter.test.ts

# Baseline immutability
bun run tests/work/baseline-readonly.test.ts

# Compliance checks
bun run tests/work/compliance-mechanical.test.ts

# Dogfood
/fly:plan "add a hello endpoint in tests/fixtures/"
/fly:work
test -f .flywheel/plugin/sessions/add-hello-endpoint-2026-04-23/baseline.json
test -f .flywheel/plugin/sessions/add-hello-endpoint-2026-04-23/state.json
bunx ajv -s flywheel/schemas/state.schema.json -d .flywheel/plugin/sessions/add-hello-endpoint-2026-04-23/state.json
```

### Success criteria

- `work-implementation` loads either `spec.json` or `findings.json` via adapter.
- `baseline.json` untouched after work-start (verify via file mtime).
- `state.json` records real `commands_run` exit codes.
- `work-review` Phase 1.0 runs three mechanical checks; each produces K1-shape findings that flow through fingerprint dedup.
- Live dogfood end-to-end succeeds.

---

## Phase 5 — Command Surface + End-to-End Dogfood

**Goal**: `/fly:plan`, `/fly:review`, `/fly:consolidate`, `/fly:work`, `/fly:review` (on PR/branch) all route through the new session model. The skip-review happy path (plan-creation → work) works as a single-skill sequence.

**Depends on**: Phases 1–4 (all artifacts + skills in place).

### Files

- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/commands/fly/plan.md`
- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/commands/fly/review.md`
- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/commands/fly/consolidate.md`
- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/commands/fly/work.md`
- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/commands/fly/ship.md` (verify no changes needed — ship operates on git state, not session artifacts)
- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/commands/fly/brainstorm.md` (verify — no changes expected)

**Optional (scope-deferred Open Question)**: `/fly:session list|switch|delete` — see Open Questions.

### Test steps

1. **Trivial E2E dogfood**: in a scratch branch, run the full sequence. Track time and artifact state:
   ```
   /fly:plan "add a toy feature to docs/scratch/"
   ls .flywheel/plugin/sessions/add-toy-feature-2026-04-23/   # spec.json, context.md, session.json
   cat .flywheel/plugin/active.json                            # points at this session
   /fly:review
   ls .flywheel/plugin/sessions/add-toy-feature-2026-04-23/   # + findings.json
   /fly:consolidate
   # spec.json refined
   /fly:work
   ls .flywheel/plugin/sessions/add-toy-feature-2026-04-23/   # + baseline.json, state.json
   # /fly:review on resulting branch
   ls .flywheel/plugin/sessions/add-toy-feature-2026-04-23/   # + review.findings.json
   ```
2. **Skip-review path**:
   ```
   /fly:plan "another toy"
   /fly:work    # goes straight to work from spec.json
   ```
3. **Resume test**:
   - Kill mid-work, re-invoke `/fly:work` with no args — reads `active.json`, resumes from `state.json`.
   - `/fly:work other-slug` — promotes `sessions/other-slug-*` to active.

### Implementation steps

1. **`commands/fly/plan.md`** — verify it invokes the `plan-creation` skill. Command body may already be minimal; update any hardcoded references to `docs/plans/` output paths (should now reference session dir).
2. **`commands/fly/review.md`** — verify it routes to `plan-review` when a session exists with spec.json, or `work-review` when invoked against a PR/branch. Document the routing heuristic inline.
3. **`commands/fly/consolidate.md`** — verify it invokes `plan-consolidation`. Update any references.
4. **`commands/fly/work.md`** — verify it invokes `work-implementation`. Accept slug or findings.json path arg.
5. **Regression sweep on other commands** — grep every command for `docs/plans/` path assumptions and update to session-dir references.

### Verification

```bash
# Commands don't hardcode docs/plans/ paths (except as input location if user provides path)
grep -n 'docs/plans/' flywheel/commands/fly/*.md
# Expected: 0 or only historical/migrated references

# Dogfood trace
(actually run the E2E flow; save output to a /tmp log; inspect artifacts)
```

### Success criteria

- All 5 fly:* commands route correctly through the new pipeline.
- E2E dogfood succeeds: plan → review → consolidate → work → review produces all artifacts with correct schema conformance.
- Skip-review dogfood succeeds: plan → work.
- Resume via `active.json` works after interrupt.

---

## Phase 6 — Skill Hygiene (Token Wins)

**Goal**: low-risk hygiene improvements across all SKILL.md files. Purely additive or line-count-reducing; no semantic pipeline changes.

**Depends on**: Phases 1–5 complete (otherwise the BLOCKING prefix / rationale audit is aiming at a moving target).

### Files

- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/skills/flywheel-conventions/SKILL.md` — add B1 rationale discipline rule
- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/skills/work-implementation/SKILL.md` — B1 extraction audit
- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/skills/plan-consolidation/SKILL.md` — B1 audit
- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/skills/plan-creation/SKILL.md` — B1 audit
- All SKILL.md files (plugin-wide) — A4 BLOCKING prefix audit
- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/skills/brainstorm/SKILL.md` — B7 description field
- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/skills/debug/SKILL.md` — B7 description field
- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/skills/work-implementation/SKILL.md` — B7 description field
- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/skills/plan-creation/SKILL.md` — B7 description field
- `/Users/wsauret/Documents/GitHub/flywheel/plugin/flywheel/skills/compound/SKILL.md` (193 lines) — B8 discoverability Step 2.5

### Test steps

1. **Word-count diff**: before/after token count for each SKILL.md. Expect 15–20% reduction on `work-implementation`, `plan-consolidation`, `plan-creation`.
2. **BLOCKING audit**: grep before/after. Each "Do NOT" or "Must" directive that is a gate should prefix `**BLOCKING:**`.
3. **Manual sanity**: re-invoke `/fly:plan` after audit — behavior unchanged.

### Implementation steps

1. **B1 rationale rule** — append to `flywheel-conventions/SKILL.md`:
   > ## Rationale Discipline
   > Every line in a SKILL.md loads on every invocation. Include rationale only when it changes what the agent does at runtime. If behavior would not differ without the sentence, cut it. Extract conditional/late-sequence content to `references/` and load on demand.
2. **B1 audit pass** on `work-implementation/SKILL.md`, `plan-consolidation/SKILL.md`, `plan-creation/SKILL.md`:
   - Read each top-to-bottom; flag any sentence whose removal wouldn't change agent behavior.
   - Extract late-sequence/conditional content (e.g., error-handling details only reached after failure) to `references/`.
   - Preserve all structural directives and the updated Phase 3/Phase 4 content.
3. **A4 BLOCKING prefix audit** across all SKILL.md files plugin-wide:
   - Grep for `Do NOT`, `Must`, `Never`, `Always` at start of directives.
   - If it's a runtime gate (agent must act differently if ignored), prefix `**BLOCKING:**`.
   - Plain bold for non-gate directives.
4. **B7 negative routing** — update `description:` frontmatter for 4 skills per design doc B7:
   - `plan-creation` — append "For exploratory requests where the user is unsure what to build, prefer brainstorm first. Once spec.json exists, use plan-review for evaluation or go straight to work. For a reviewed spec, use plan-consolidation to merge findings."
   - `brainstorm` — append "Once the approach is clear, use plan-creation to produce a spec.json."
   - `work-implementation` — append "Do not use for exploration or design decisions — work-implementation executes against an existing spec.json. For design work, use brainstorm or plan-creation."
   - `debug` — append "Use when the goal is to fix a specific reported issue. For exploration of unknown problems or building new features, use brainstorm or plan-creation."
5. **B8 compound discoverability Step 2.5** — insert new step between existing Step 2 (Gather Context) and Step 3 (Check Existing Docs) in `compound/SKILL.md`:
   - Detect first-time use per repo: `docs/solutions/` has <3 files, or no grep hit for "docs/solutions" in `AGENTS.md`/`CLAUDE.md`.
   - If detected: `AskUserQuestion` offering to add a one-line reference to AGENTS.md/CLAUDE.md.
   - If yes: conditional `Edit` injecting the reference.

### Verification

```bash
# Token-count before/after
for skill in work-implementation plan-consolidation plan-creation; do
  wc -w "flywheel/skills/$skill/SKILL.md"
done

# BLOCKING prefix coverage
grep -rEn '^(\*\*BLOCKING:\*\*|\*\*Do NOT|\*\*Must|\*\*Never|\*\*Always)' flywheel/skills/*/SKILL.md flywheel/agents/*.md | head -20

# B7 description updates
grep -A1 '^description:' flywheel/skills/{plan-creation,brainstorm,debug,work-implementation}/SKILL.md

# B8 Step 2.5
grep '^## Step 2\.5' flywheel/skills/compound/SKILL.md
```

### Success criteria

- 15–20% word-count reduction on the three audited SKILL.md files.
- Every gate directive has `**BLOCKING:**` prefix.
- B7 descriptions updated for 4 skills.
- B8 Step 2.5 present in compound.
- Functional regression check (re-run dogfood from Phase 5) passes.

---

## Implementation Checklist (flat, for `/fly:work`)

### Phase 1 — Foundation

- [ ] Add `.flywheel/` to `.gitignore`
- [ ] Create `flywheel/schemas/` directory
- [ ] Author `flywheel/schemas/findings.schema.json` (K1)
- [ ] Author `flywheel/schemas/task-list.schema.json` (K2)
- [ ] Author `flywheel/schemas/state.schema.json` (K5/K6)
- [ ] Author `flywheel/schemas/baseline.schema.json` (K6)
- [ ] Author `flywheel/schemas/session.schema.json`
- [ ] Write fixture suite at `tests/schemas/fixtures/` (10+ pass/fail fixtures)
- [ ] Write `tests/schemas/run.sh` or bun test runner
- [ ] Update `flywheel-conventions/SKILL.md:25` with A2 severity (3-line block)
- [ ] Add B2 False-Positive Suppression section to `flywheel-conventions/SKILL.md`
- [ ] Add B3 Observable-Behavior Framing section to `flywheel-conventions/SKILL.md`
- [ ] Verify Phase 1 acceptance: all fixtures pass/fail as expected; `.flywheel/` ignored; conventions file contains new sections

### Phase 2 — Reviewer Boundary

- [ ] Write fixture tests at `tests/reviewers/` for synthesizer dedup
- [ ] Rewrite opener paragraph in `reviewer-architecture.md` (A3)
- [ ] Rewrite opener paragraph in `reviewer-code-quality.md` (A3)
- [ ] Rewrite opener paragraph in `reviewer-elegance.md` (A3)
- [ ] Rewrite opener paragraph in `reviewer-performance.md` (A3)
- [ ] Rewrite opener paragraph in `reviewer-patterns.md` (A3)
- [ ] Rewrite opener paragraph in `reviewer-data-integrity.md` (A3)
- [ ] Replace Output Format in each reviewer with `findings.schema.json` reference + example (K1)
- [ ] Delete local severity table in `reviewer-elegance.md:179-182`
- [ ] Delete local severity table in `reviewer-patterns.md:61-65`
- [ ] Rewrite `plan-review/SKILL.md` Phase 3: parse JSON findings, apply fingerprint dedup (A1), write session `findings.json`
- [ ] Remove markdown Review Summary append behavior from `plan-review/SKILL.md` Phase 5
- [ ] Rewrite `work-review/SKILL.md` Phase 3: same dedup, write session `review.findings.json`
- [ ] Remove markdown review document write (`docs/reviews/YYYY-MM-DD-*.md`) from `work-review/SKILL.md`
- [ ] Verify Phase 2 acceptance: reviewer tests pass; live `/fly:review` on current branch produces valid JSON

### Phase 3 — Planning Pipeline

- [ ] Write adapter tests at `tests/pipeline/`
- [ ] Rewrite `plan-creation/SKILL.md` Phase 3-5: compose + write `spec.json`, `context.md`, `session.json`, update `active.json` (K3)
- [ ] Apply A5: replace Philosophy/Context Compaction with 5-principle numbered list
- [ ] Apply B4: integrate spec quality bar + BC coverage check at plan-creation output
- [ ] Apply B7: update `description:` frontmatter with negative routing
- [ ] Delete `plan-creation/references/plan-templates.md` (MINIMAL/MORE/A LOT gone)
- [ ] Update `plan-creation/references/formatting-guide.md` for session-id filename
- [ ] Rewrite `plan-consolidation/SKILL.md` as K4 refinement pass
- [ ] Delete `plan-consolidation/references/consolidated-plan-template.md`
- [ ] Review `plan-consolidation/references/extraction-patterns.md` — keep or delete
- [ ] Final sweep: confirm `plan-review/SKILL.md` no longer appends to `plan.md` (Phase 2 should already have done this)
- [ ] Verify Phase 3 acceptance: `/fly:plan` + `/fly:consolidate` dogfood produces schema-valid artifacts

### Phase 4 — Execution Boundary

- [ ] Write adapter + baseline immutability + compliance tests
- [ ] Rewrite `work-implementation/SKILL.md` Phase 0 (session detection via `active.json`)
- [ ] Rewrite `work-implementation/SKILL.md` Phase 1 (load & resume with adapter)
- [ ] Rewrite `work-implementation/SKILL.md` Phase 2 (execution loop writing to `state.json`)
- [ ] Add B5 anti-patterns to `work-implementation/SKILL.md`
- [ ] Replace `work-implementation/references/state-file-template.md` with JSON template
- [ ] Create `work-implementation/references/baseline-procedure.md`
- [ ] Rewrite `work-implementation/references/session-detection.md` for active-pointer model
- [ ] Replace `work-implementation/references/session-file-template.md` with JSON template
- [ ] Rewrite `work-implementation/references/load-resume-procedures.md` with adapter logic
- [ ] Rewrite `work-implementation/references/checkpoint-procedure.md` for JSON state write + `commands_run` accuracy
- [ ] Append B6 5-question check to `work-implementation/references/verification-gates.md`
- [ ] Rewrite `work-review/SKILL.md` Phase 1.0 with three mechanical checks (structured diff, BC coverage, commands re-execution)
- [ ] Rewrite `work-review/references/plan-compliance.md` for three mechanical checks
- [ ] Verify Phase 4 acceptance: `/fly:work` on trivial scratch task produces valid state; baseline immutable; `/fly:review` runs three mechanical checks

### Phase 5 — Command Surface + Dogfood

- [ ] Verify `commands/fly/plan.md` routes to `plan-creation` (no hardcoded `docs/plans/` paths)
- [ ] Verify `commands/fly/review.md` routes correctly (plan-review vs work-review)
- [ ] Verify `commands/fly/consolidate.md` routes to `plan-consolidation`
- [ ] Verify `commands/fly/work.md` routes to `work-implementation` with session resolution
- [ ] Regression sweep: grep all commands for `docs/plans/` path assumptions
- [ ] E2E dogfood: full plan → review → consolidate → work → review sequence
- [ ] E2E dogfood: skip-review path (plan → work)
- [ ] E2E dogfood: resume after interrupt

### Phase 6 — Skill Hygiene

- [ ] Append B1 Rationale Discipline rule to `flywheel-conventions/SKILL.md`
- [ ] B1 audit pass on `work-implementation/SKILL.md`
- [ ] B1 audit pass on `plan-consolidation/SKILL.md`
- [ ] B1 audit pass on `plan-creation/SKILL.md`
- [ ] A4 BLOCKING prefix audit across all SKILL.md + agent files
- [ ] B7 description update: `brainstorm/SKILL.md`
- [ ] B7 description update: `debug/SKILL.md`
- [ ] B7 description update: `work-implementation/SKILL.md`
- [ ] B7 description update: `plan-creation/SKILL.md`
- [ ] B8 Step 2.5 in `compound/SKILL.md`
- [ ] Re-run dogfood; confirm no regression

---

## Open Questions

From the design doc, still to resolve:

1. **`spec.json` revision tracking** — Track `revision` count + changelog, or write pre-consolidation to `spec.json.pre-consolidation` sidecar? Recommended: pre-consolidation sidecar, cheaper and more forgiving. Sidecar is cleaned on successful ship.
2. **Research sidecar `context.md`** — Keep as separate file (durable) or absorb into `spec.json.context` field? Recommended: keep separate — context.md has free-form prose and file references that stay useful for downstream readers even if spec.json evolves.
3. **State write cadence** — Per-task, per-phase, or per-checkpoint? Recommended: **per-phase** (simplest; matches existing Flywheel convention per user's state-machine memory; recovery granularity is phase-level not task-level).
4. **Re-execution scope in work-review** — Sample N commands (N=3) or all? Recommended: **N=3** default, configurable via environment variable if needed. Bounded cost; good signal on accuracy.
5. **User edits to `spec.json` between plan-creation and work** — Pre-flight BC coverage re-validation? Recommended: yes, run the mechanical BC-coverage check as a pre-flight in `work-implementation` Phase 1. Cheap; catches user edit mistakes before work starts.
6. **Slug collision on same day** — Error, append `-2`, overwrite, or resume? Recommended: **append `-2`** with a user-visible notice. Matches user's state-machine memory (delete is an explicit action, not implicit).
7. **Session list/switch/delete commands** — Include in this plan as `/fly:session` subcommands, or defer? Recommended: **defer**. Core pipeline works without them (O(1) active pointer + prefix-scan). Add `/fly:session list` + `/fly:session switch <slug>` + `/fly:session delete <slug>` as a follow-up PR when utility is proven.
8. **TUI convergence** — Publish `flywheel/schemas/*.schema.json` as a shared package both repos import, or duplicate? Recommended: **plugin-local for now**. The TUI uses Zod exclusively (see finding below); convergence requires the TUI to adopt JSON Schema or we convert Zod → JSON Schema at build time. Both are real work; defer until drift bites.
9. **Backward scope for existing plans in `docs/plans/`** — Is the user comfortable with a clean break? The only in-flight plan is the one you're reading (`refactor-rigor-gradient-pipeline.md`) and its source (`2026-04-23-ce-adoptions-plan.md`). After this plan ships, both become historical. No `docs/plans/*.md` created under the old system exists other than these.

New findings from Phase 1 research (not in the design doc):

10. **TUI schema-source precision** — The design doc cites `WorkerHandoff` / `HandoffFieldSpec` / `WORK_STEP_FIELDS` from the TUI. Research confirmed all three exist verbatim in `src-legacy/queue/…` of the sibling repo, but with two precision corrections:
    - `schema_version: 1` is a required field on `DispatcherDecisionSchema` (`src-legacy/dispatcher/schemas.ts:139`) and other dispatcher/evaluator schemas — **not on `WorkerHandoff` itself**. `WorkerHandoff`'s enforced discipline is `summary` (min 20, max 5000 chars, single-paragraph). The plan should cite dispatcher schemas for `schema_version` precedent and `HandoffFieldSpec` for `summary` precedent separately.
    - TUI uses Zod exclusively for schemas — not JSON Schema files. The plugin's proposed `flywheel/schemas/*.schema.json` is an independent design choice, **analogous to** (not "adopted from") the TUI's Zod approach. Framing in the SKILL.md rewrites and this plan should say "schema-first discipline inspired by the TUI's Zod approach" rather than "adopted from the TUI's `WorkerHandoff` pattern."
    - **Decision required**: update language in the SKILL.md rewrites and in the design doc's K1 section to correct these two precision issues? Recommended: yes, low-cost accuracy win.

11. **Reviewer Output Format divergence** — 5 of 6 reviewers use a 6-section markdown template; `reviewer-patterns.md:67-83` uses a 3-section condensed form. The K1 JSON schema replaces both, so divergence disappears — **but**: the condensed form lost "Approach Chosen," "Completed Steps," and "Current Status" in the current markdown. Should JSON findings include those as optional top-level fields (parallel to `residual_risks`, `open_questions`), or are they implicit in the `findings[]` content? Recommended: drop them. The 5-section form was process-oriented (summarize the review task itself), not finding-oriented. `summary` field covers it.

12. **Local severity conflict surface** — `reviewer-elegance.md:179-182` and `reviewer-patterns.md:61-65` currently define their own severity tables. Phase 2 removes them in favor of the shared A2 definition. **Verify no calling code depends on the local definitions** (likely not — reviewer definitions are prompts for LLMs, not parsed).

13. **Is there a dev dependency on `ajv` in this plugin?** Phase 1 verification uses `bunx ajv`. If ajv is not a devDependency, add it in Phase 1: `bun add -D ajv ajv-formats ajv-cli`. If the plugin has no `package.json` at all, this is infra we're adding for the first time.

14. **`flywheel.toml` — does it need updating?** `plugin` root contains `flywheel.toml`. The design doc doesn't mention touching it. Phase 1 verification includes a read-and-report step — if it references paths or schemas that are moving, update; otherwise leave alone.

---

## Technical Reference

### Current state (pre-refactor) — verified via analyzers

- **plan-creation/SKILL.md**: 227 lines. Phase 3 selects between MINIMAL/MORE/A LOT templates. Phase 4 writes `docs/plans/<slug>.md`. Phase 5 writes `docs/plans/<slug>.context.md`. Locate→analyze is BLOCKING at line 50.
- **plan-review/SKILL.md**: 153 lines. Phase 5 **mutates `docs/plans/<slug>.md` in-place** by appending a `# Plan Review Summary` section. No separate findings file exists.
- **plan-consolidation/SKILL.md**: 153 lines. Reads `docs/plans/<slug>.md` (which must have Review Summary appended). Overwrites with consolidated version. Creates `.pre-consolidation.backup`.
- **work-implementation/SKILL.md**: 194 lines. State tracking in `docs/plans/<slug>.state.md` (**markdown checkboxes, schema_version: 3**). Session file at `.flywheel/session.md` (single-session, YAML+markdown). Baseline at `docs/plans/<slug>.baseline.md` (copy, deleted on completion).
- **work-review/SKILL.md**: 200 lines. Phase 1.0 already does plan-compliance check against baseline.md (prose compare). Writes `docs/reviews/YYYY-MM-DD-<slug>.md`.
- **All 6 reviewers** load `flywheel-conventions` via frontmatter. 5 use 6-section Output Format template; `reviewer-patterns` uses condensed 3-section form.
- **flywheel-conventions/SKILL.md**: 72 lines. Severity one-liner at **line 25**: `**Severity**: P1 = blocks deploy / security / data loss. P2 = fix before merge. P3 = suggestion.`
- **Local severity tables to remove**: `reviewer-elegance.md:179-182`, `reviewer-patterns.md:61-65`.
- **`.flywheel/`** exists in current codebase (houses `session.md`). `.gitignore` **does not currently ignore it** — Phase 1 step 1.

### TUI reference patterns (verified)

- `src-legacy/queue/steps/plan-draft/prompts.ts:1-62` — `DRAFT_JSON_EXAMPLE` + `PLAN_DRAFT_SCHEMA_RULES` show `behavioralContract[]` shape + `steps[].fulfills` semantics **exactly as plan proposes**.
- `src-legacy/queue/shared/handoff-render.ts:3-8` — `HandoffFieldSpec` interface.
- `src-legacy/protocol/handoff-schemas.ts:110-169` — `WorkerHandoffBaseSchema` with `summary` required (min 20, max 5000). No `schema_version` here.
- `src-legacy/queue/steps/work/fields.ts:3-35` — `WORK_STEP_FIELDS` with `commands_run` accuracy note verbatim ("A verification agent will re-execute commands").
- `src-legacy/queue/steps/plan-review/prompts.ts:1-87` — `PLAN_REVIEW_ANNOTATION_RULES` with "DO NOT MODIFY" discipline on every draft-authored field.
- `src-legacy/dispatcher/schemas.ts:105,139` — `schema_version: 1` required on `DispatcherDecisionSchema` and handoff (not on `WorkerHandoff`).
- **All schemas in TUI are Zod (TypeScript runtime), not JSON Schema.**

### Artifact paths (post-refactor)

```
flywheel/schemas/                                                  (tracked)
  findings.schema.json
  task-list.schema.json
  state.schema.json
  baseline.schema.json
  session.schema.json

.flywheel/                                                          (gitignored)
  plugin/
    active.json                                                     { schema_version, session_id }
    sessions/
      <slug>-<YYYY-MM-DD>/
        session.json
        context.md
        spec.json
        findings.json                                               (after review)
        baseline.json                                               (read-only after work-start)
        state.json                                                  (checkpoint-updated)
        review.findings.json                                        (after work-review)
    traces/                                                         (reserved; future)
    log/                                                            (reserved; future)

docs/                                                               (tracked)
  standards/                                                        (unchanged)
  solutions/                                                        (unchanged; B8 references)
  research/                                                         (unchanged)
  plans/                                                            (stale after this PR — design doc + this plan become historical)
```

### Key directive files

- Conventions load via frontmatter: `skills: [flywheel-conventions, language-standards]` (5 reviewers) or `skills: [flywheel-conventions]` (elegance).
- Locate→analyze pattern is BLOCKING in `plan-creation/SKILL.md:50` (no change — already aligned).

---

## Risks & Mitigations

- **Risk**: K1–K6 are interdependent — landing partially leaves pipeline broken.
  **Mitigation**: Phase 1–4 treated as one cohesive unit. No intermediate state where partial work ships. CI or local dogfood gate at end of Phase 4 before merging Phase 5+6 hygiene.

- **Risk**: Schema drift between `findings.schema.json` and reviewer prompt examples.
  **Mitigation**: K1's "schema as first-class artifact" rule — reviewer prompts reference the schema file, not restate it. Phase 2's fixture tests validate the prompt's embedded example against the schema.

- **Risk**: `work-review`'s commands re-execution spot-check runs arbitrary shell commands — if a prior `state.json` was tampered with, re-execution could run unintended commands.
  **Mitigation**: commands re-execution runs only within the current repo working tree; exit-code-only comparison; no network commands escalated; sampling cap (N=3).

- **Risk**: Behavioral contract IDs become stale when tasks are renamed/reordered during consolidation.
  **Mitigation**: `BC-<AREA>-<NNN>` IDs are content-keyed, not position-keyed. Consolidation preserves IDs; new BCs append with next N. BC coverage re-validation catches orphans at consolidation time (K4 step 6).

- **Risk**: Users accustomed to markdown-viewable plan files lose readability.
  **Mitigation**: JSON artifacts carry `summary` (100–5000 chars) on top — readable without deserializing. Skills print summaries to chat at completion. Users can hand-edit JSON (it's pretty-printed). If demand emerges, a `/fly:session render <id>` could emit on-demand markdown.

- **Risk**: Fingerprint false collisions (two genuinely distinct findings bucket into same fingerprint).
  **Mitigation**: Line bucket of 7 is conservative. Title normalization strips noise but preserves content. Cross-reviewer collision promotes severity rather than collapsing to a single message — the promoted finding still includes all source reviewer names for traceability.

- **Risk**: JSON Schema authoring errors — invalid schemas, wrong draft version.
  **Mitigation**: Phase 1 fixture suite validates the schemas themselves (fixtures that should pass do pass; fixtures that should fail do fail). Author schemas with `$schema: "https://json-schema.org/draft/2020-12/schema"` explicitly.

---

## Success Metric

End-to-end: `/fly:plan "add a trivial test endpoint"` → `/fly:work` → `/fly:review` executes cleanly on a scratch branch. All artifacts validate against their schemas. No prose-parsing boundaries anywhere in the code path. Reviewer findings go through JSON → fingerprint dedup → session file, never through regex. `baseline.json` unchanged after Phase 2 of work. `work-review` catches both real scope drift and fabricated `commands_run` entries via the three mechanical checks.

Tokens saved per review cycle: reviewer output reduction ~60 tokens/finding × 15 findings × 6 reviewers ≈ 5.4k/review (matches design doc estimate conservatively). SKILL.md load reduction on `work-implementation`/`plan-consolidation`/`plan-creation`: 15–20% per invocation after Phase 6 audit.

---

# Plan Review Summary

**Reviewed**: 2026-04-23
**Reviewers run in parallel**: 6 (architecture, code-quality, patterns, performance, data-integrity, elegance)
**Total distinct findings after dedup**: 31 (8 P1, 16 P2, 7 P3) + 9 cross-reviewer Open Questions

---

## P1 — Must resolve before execution

**P1-A. `scope` polymorphism in `findings.schema.json` uses `oneOf` incorrectly — both branches can match simultaneously.**
[code-quality, architecture cross-ref] Phase 1 step 2 specifies `scope` as `oneOf` over `kind: "code"` and `kind: "plan"` branches. Without `additionalProperties: false` on each branch and `const` (not `enum`) on `kind`, a malformed finding with `kind: "code"` + `phase_id` validates against the code-scope branch. Fix: each `oneOf` branch must declare `additionalProperties: false` and `kind` as a `const` discriminant.

**P1-B. `task-list.schema.json` cannot enforce "every BC claimed by exactly one task" — AC-PIPE-002 misrepresents this as a schema guarantee.**
[code-quality + elegance + data-integrity] JSON Schema 2020-12 cannot cross-reference `behavioral_contract[].id` values against `phases[].tasks[].fulfills[]`. The plan conflates schema validation with procedural coverage gates. Three separate issues nest under this:
  - (B.1) **Split claim clearly**: schema validates structure only; BC-coverage is a procedural gate in plan-creation/plan-consolidation.
  - (B.2) **"Exactly one" is over-constrained** (elegance P1): legitimately, a "graceful session cleanup" BC may span two phases' tasks. Change to: orphaned BCs (zero claims) are errors; duplicate claims are warnings surfaced as Open Questions. Keep `uniqueItems` on `behavioral_contract[].id` (data-integrity DI-P2-3) to prevent ID collision — that IS schema-enforceable.
  - (B.3) BC IDs are not unique across the array today — add `uniqueItems` in `task-list.schema.json` on `behavioral_contract`.

**P1-C. TUI namespace claim is factually wrong — blocks Phase 1 step 1 as written.**
[patterns + architecture cross-ref] `flywheel-tui/src/infra/paths.ts:9` defines `SESSIONS_DIR = ".flywheel/sessions"` (no `tui/` infix). The plan's Architecture section claims TUI uses `.flywheel/tui/sessions/` — it does not. `.flywheel/traces/` and `.flywheel/log/` are also claimed by TUI at those paths today. The plugin's `.flywheel/plugin/sessions/` namespace is safe (plugin/ infix is unique), but the plan's description of TUI layout must be corrected before Phase 1 ships. Add: `.gitignore` addition of `.flywheel/` is correct regardless — both tools' artifacts belong gitignored.

**P1-D. Atomic writes are unspecified; all JSON writes are vulnerable to partial-write corruption on crash.**
[data-integrity + code-quality (concurrent-writes) + performance (crash recovery)] `state.json` is the highest-risk case (multi-phase checkpoint writes). A partial write leaves an unparseable file that breaks `work-review`, session resume, and the BC-coverage check. The plan's Risks section is silent. Fix: specify write-to-`<file>.tmp`-then-rename in `references/checkpoint-procedure.md`. Applies to all JSON artifacts. This mechanism also mitigates concurrent-write race on same session (code-quality P2-4) because rename is atomic.

**P1-E. `baseline.json` immutability is protocol-only, not enforced — compliance diff trusts a mutable file.**
[architecture P1-2 + data-integrity P2-1] AC-PIPE-010 checks mtime after Phase 2, which catches unintentional mutation only at review time. A malicious or accidental mutation mid-execution is invisible until then. Fix: at baseline.json write time, compute SHA-256 and record in `session.json.artifacts.baseline_hash`. At work-review time, recompute and assert match. Mismatch → P1 finding "baseline was mutated after work-start."

**P1-F. Stale `active.json` pointer has no specified rescue path.**
[data-integrity P1-2/P1-3 + code-quality P2-3] User deletes `sessions/foo-date/` directly; `/fly:work` reads active.json, fails to load, errors without explanation. Deletion is an action per user memory, but no skill owns the "clear active.json when its target is gone" invariant. Fix: Phase 4 session-detection must handle "active.json exists but target dir absent" — print "Active session not found; it may have been deleted. Run /fly:plan or /fly:work <slug>" and clear `active.json`.

**P1-G. Phase 3's declared dependency on Phase 2 output format is understated.**
[architecture P1-3] Phase 3 says "Phase 2 if consolidation needs findings.json." Consolidation ALWAYS reads findings.json when it exists (K4 step 1). This is a hard dependency. Fix: state Phase 3 `Depends on: Phase 1 + Phase 2` without qualifier.

**P1-H. Prefix-scan claim (AC-PIPE-004) is misleading at scale; slug-multi-match is undefined.**
[performance P1-1] `sessions/add-user-auth-*` returns all date-suffixed matches (including `-2`, `-3` collision-tiebreaks). Plan says "if found, update active.json" — no disambiguation specified for multi-match. Fix: specify "most recent by YYYY-MM-DD" as the tiebreak rule, and acknowledge the scan is O(N) over subset, not strict O(1).

---

## P2 — Fix before merge

**P2-1. Reviewer Output Format examples must be inline (not just schema reference) to get reliable JSON from LLMs.**
[code-quality P2-1 vs elegance P2-1 — **CONFLICT**, see Open Questions below] Schema reference alone is fragile for polymorphic `scope`; but 6 copies of an example drift. Open Question below.

**P2-2. No retry/fail-path for malformed reviewer JSON output.**
[code-quality P2-2] Phase 2 assumes JSON parses. Fix: if parse fails, synthesizer emits a P1 finding against the failing reviewer and continues; add fixture `malformed-reviewer-output.json`.

**P2-3. `commands_run` re-execution has no idempotency gate.**
[data-integrity P1-4 + code-quality P2-5 + performance P2-4] Re-running `git commit`, `bun run scripts/seed-db.ts`, DB migrations, or long test suites (30s+) is unsafe and unbounded in wall-time. Fix: add `re_executable: boolean` field to `commands_run` entries (implementer marks unsafe commands `false`); impose per-command timeout (30s default); skip-list patterns (`git commit`, `migrate`, `seed`, `curl`, `rm`). This addresses all three reviewers' concerns in one mechanism.

**P2-4. `plan_id` / `session_id` slug patterns underspecified in schemas.**
[code-quality P2-6] No regex constraint currently; `plan_id: "Hello World!"` validates. Fix: `session_id` pattern `^[a-z0-9-]+-[0-9]{4}-[0-9]{2}-[0-9]{2}$`; `plan_id` pattern `^[a-z0-9-]+$`.

**P2-5. AJV runtime-vs-devDep decision is ambiguous.**
[performance P2-3 + code-quality P3-4] Phase 1 verification uses `bunx ajv` (tests) but Open Question #5 (pre-flight BC-coverage) implies runtime use in `work-implementation`. `-D` flag contradicts runtime use. Also: AJV cold-compile of `task-list.schema.json` with `$ref`/`oneOf`/`anyOf` is 100–200ms per process start. Fix: decide — tests-only (implement pre-flight in shell/jq, not ajv) vs runtime (add as non-dev dep, amortize compile cost). Also: Phase 1 must use `bunx ajv --spec=draft2020` or the draft-07 default silently ignores 2020-12 features (performance OQ-2).

**P2-6. Schema version mismatch behavior unspecified — consumers can silently misparse.**
[data-integrity P2-2] All artifacts carry `schema_version: 1` but no skill rejects `schema_version: 2` explicitly. Fix: each consumer skill prompt adds a directive: "If `schema_version` is not 1, error with 'Unsupported schema version <N>. Re-run the producing skill.' Do not attempt to parse."

**P2-7. `formatting-guide.md` update is scoped too narrowly — the whole type-prefix system is now legacy.**
[patterns P2-2] Plan says "change an example" but the current file documents `feat-`/`fix-`/`refactor-` prefix conventions with sanitization rules that contradict the new `<slug>-<YYYY-MM-DD>` session-dir naming. Fix: Phase 3 step 3 must be "replace the filename section entirely," not "change example."

**P2-8. `plan-review/SKILL.md:22` empty-argument fallback hardcodes `docs/plans/` path.**
[patterns P2-3] Not addressed by any Phase 3 or Phase 5 step. Fix: Phase 3 step 6 must explicitly change the empty-arg fallback to read `.flywheel/plugin/active.json` and load its session's `spec.json`.

**P2-9. `reviewer-patterns.md` condensed 3-section Output Format diverges from other 5; Phase 2 step 2 treats all 6 as equivalent.**
[patterns P1-2] K1's JSON replacement unifies them, but the rest of patterns' body is shaped around the condensed form. Fix: Phase 2 step 2 must flag that patterns needs a separate structural pass before the JSON replacement.

**P2-10. `reviewer-elegance` omits `language-standards` from its frontmatter intentionally (per context.md note) — Phase 2 implementation step 1 doesn't preserve this.**
[patterns P2-6] An implementer rewriting all 6 uniformly may accidentally add `language-standards` back. Fix: Phase 2 step 1 must explicitly preserve `reviewer-elegance.md`'s lone `skills: [flywheel-conventions]` frontmatter.

**P2-11. `flywheel-conventions/SKILL.md:21` says "Reviewers 1500" word limit — nonsensical for JSON output after Phase 2.**
[patterns P3-3] Phase 2 or Phase 6 should replace with "Reviewers: return JSON conforming to findings.schema.json; no word limit on the JSON object."

**P2-12. Design doc precision (Open Question #10) should be resolved in plan body, not deferred.**
[patterns P2-5] Plan body still says "adopts TUI's WorkerHandoff pattern" / "matches TUI's pattern." Implementers copy body text into new SKILL.md files, propagating the inaccuracy. Fix: resolve OQ#10 now → rewrite body references as "inspired by / analogous to" the TUI's Zod-based schema discipline; cite dispatcher schemas (not WorkerHandoff) for `schema_version` precedent.

**P2-13. `active.json` has multiple writers (plan-creation, work-implementation on slug-arg, work-review for standalone sessions) — write-order contract undefined.**
[architecture P2-5] Fix: specify "session-creating skill acquires active.json write" as the invariant; resume-promoting skills also write. No overlapping-write guard specified — document as known limitation or add a sequence check.

**P2-14. `session.json.active_skill` can become stale on crash — resume logic depends on this field.**
[architecture P2-6 + data-integrity (concurrent writes)] Fix: on skill exit (success or failure), clear `active_skill`. On resume, if `active_skill` is non-null AND `last_checkpoint_at` > 15 min ago, warn "previous session may have crashed" before proceeding.

**P2-15. B4 quality bar is duplicated across plan-creation and plan-consolidation, not centralized.**
[architecture P3-13 + elegance P3-1] Fix: move B4 rule body into `flywheel-conventions`; both producers reference it once. Single source of truth for the quality bar.

**P2-16. Plan doc overlaps design doc at ~70%+; plan should be a delta (acceptance criteria + test steps + checklist), not restatement.**
[elegance P2-4] Plan is 824 lines, design doc is 817. The plan restates K1-K6 prose, schema blocks, implementation sequence. Fix: compress plan to reference design-doc sections (`See design doc §K1`); retain what's NEW in plan (test steps, implementation steps, acceptance criteria, resolved Open Questions). Target: ~400 lines.

---

## P3 — Suggestions

**P3-1. `session.json.artifacts` map is parallel state — every value is a constant filename.**
[elegance P1-1] The sub-object serves no purpose (disk check is cheaper than reading session.json to find a constant). Fix: drop `artifacts` from `session.schema.json`; keep `session_id`, `slug`, `status`, timestamps, `active_skill`.

**P3-2. Fingerprint `normalize(title)` step may use regex, contradicting "no regex" claim.**
[performance P2-2] Plan's normalize is undefined. Fix: define `normalize` as `title.toLowerCase().replace(/\s+/g, '-').slice(0, 60)` — one regex call is acceptable (hot-path benign at N=120); or document the trade-off.

**P3-3. Fingerprint formula breaks for `line: null` code findings (`Math.floor(undefined/7) = NaN`).**
[code-quality P3-8] Fix: define the line-absent bucket as `"*"`; fingerprint becomes `code:src/auth.ts:*:title-normalized`.

**P3-4. `state.json.status` enum missing `paused` — inconsistent with `session.schema.json`.**
[code-quality P3-2] State machine has `active/paused/completed` per user memory; state.json enum has only `in_progress/completed`. Fix: align to `not_started | in_progress | paused | completed`.

**P3-5. BC ID hand-edit UX — humans will produce `BC-auth-1`, `BC-AUTH_001`, etc.**
[code-quality P3-1] Fix: pre-flight check in `work-implementation` Phase 1 emits human-readable error: "BC ID 'BC-auth-1' must match BC-[A-Z0-9]+-NNN format, e.g., BC-AUTH-001."

**P3-6. Session directory growth is unbounded; `.flywheel/plugin/sessions/` becomes a graveyard over time.**
[performance P3-1 + data-integrity P3-1] No TTL, no GC. Acceptable for v1 per scope decision, but: document in Session Lifecycle section that completed sessions older than 90 days are pruning candidates; add `/fly:session gc` as a concrete follow-up item (not just "deferred").

**P3-7. Phase 4 covers two distinct concerns (work-implementation adapter + work-review mechanical checks).**
[elegance P2-5] Split to Phase 4a (execution boundary) + Phase 4b (compliance checks) for cleaner SRP.

---

## Open Questions (from conflicts + reviewer asks)

**OQ-α. Inline example vs schema-only reference in reviewer Output Format?** (code-quality P2-1 vs elegance P2-1)
- code-quality: LLM compliance with polymorphic `scope` needs worked example in-prompt; recommend inline example with one code + one plan finding
- elegance: one schema file is the single source of truth; inline examples drift across 6 reviewers
- **Resolution needed**: inline example (accept 6× duplication for compliance robustness), or single `findings.example.json` fixture referenced by all 6 reviewers (hybrid: one copy, referenced not embedded), or schema-only (risk schema-noncompliant LLM output)?

**OQ-β. `baseline.json`: full copy vs. content-hash + frozen_at timestamp?** (data-integrity P2-1 vs elegance P2-3)
- data-integrity: keep full copy; add hash verification on top (catches mutation)
- elegance: replace with hash + `frozen_at`; compare state.phases against spec.json directly (if spec diverges → re-plan)
- **Resolution needed**: full copy gives structural diff even when user re-edits spec.json mid-execution; hash-only is cleaner but loses that capability. Which trade-off is right?

**OQ-γ. `context.md` sidecar vs absorb into `spec.json.context`?** (elegance P2-2 vs performance P1-2 vs original OQ #2)
- elegance: absorb into `spec.json.context` + optional `context.notes` string for free-form overflow (single source of truth)
- performance: load overhead unresolved but not mandating elimination
- **Resolution needed**: absorb (elegance wins, performance neutral) vs keep separate (durability, hand-editability of prose)?

**OQ-δ. K6 commands re-execution — keep, harden, or cut?** (elegance P3-2: cut vs data-integrity P1-4: harden vs performance P2-4: harden-with-timeouts)
- elegance: B5 directive already prevents "done without tests"; re-execution is the weakest K6 component
- data-integrity + performance: keep but add `re_executable` flag + timeout + skip-list (see P2-3 above)
- **Resolution needed**: trust-only (cut K6 check 3, lean on B5) vs mechanical (keep + harden)?

**OQ-ε. Does plan-review's Task prompt to reviewers pass `scope_context: "plan"` explicitly?** (architecture P2-7 + patterns OQ-B)
- Reviewers emit polymorphic `scope.kind`. If prompt doesn't disambiguate, reviewer guesses from content. Cross-context mixing (code-scope findings in a plan review) is valid schema but semantically useless to consolidation.
- **Resolution needed**: explicit scope-context param in Task prompt, or detect from invocation context?

**OQ-ζ. `.flywheel/sessions/` TUI path — does Phase 1 gitignore addition collide with TUI artifacts?** (patterns P1-1 + architecture P2-11)
- Confirmed: TUI writes to `.flywheel/sessions/`, `.flywheel/traces/`, `.flywheel/log/`. Plugin writes to `.flywheel/plugin/`. Paths are disjoint; `.gitignore` addition ignores both.
- **Resolution needed**: only documentation correction in plan body (no behavior change). Patterns reviewer flagged the *claim* is wrong, not the *behavior*. Lightweight fix.

**OQ-η. Fingerprint implementation target — LLM-prompt logic or real TypeScript module?** (patterns P2-4)
- Phase 2 test step 2 says "import the dedup function." Plan describes fingerprint as synthesizer instructions (prose in SKILL.md).
- **Resolution needed**: (a) synthesizer is prose (replace test with fixture-based integration test), or (b) add a real `flywheel/synthesizer/fingerprint.ts` module called by the skill (becomes first real TS code in plugin)?

**OQ-θ. `/fly:review` routing heuristic — author in Phase 4 or Phase 5?** (architecture P3-14)
- Currently Phase 5 treats as "verify existing routing." But routing to plan-review (session has spec.json but no baseline.json) vs work-review (baseline.json or PR/branch arg) does not exist today.
- **Resolution needed**: move routing authoring into Phase 5 implementation (make it a real step, not verification) or into Phase 4 (where session detection lives)?

**OQ-ι. `spec.json` revision tracking — sidecar vs in-file history?** (elegance P3-4, original OQ #1)
- Plan recommends `spec.json.pre-consolidation` sidecar but it's not in the artifact map, `session.schema.json`, or cleanup policy.
- **Resolution needed**: commit to sidecar approach (add to artifact map, schema, ship cleanup) or adopt in-file `revision_count` + `previous_summary` field (single artifact, lighter footprint)?

---

## Preserved elegance (do not change during consolidation)

Multiple reviewers called out what's genuinely right:

- **Single `active.json` pointer** for O(1) resume — models git HEAD, no scan overhead (elegance)
- **Polymorphic `scope` in `findings.schema.json`** — clean discriminated union handling both plan and code findings in one synthesizer (elegance)
- **Fingerprint as pure Set operation** — deterministic, no model cost; line-bucket-of-7 tolerates adjacent-line variance (elegance)
- **B2 + B3 paired rules** — B2 sets the suppression gate; B3 formats what passes. Short and complementary (elegance)
- **Deletion of MINIMAL/MORE/A LOT templates** — strict simplification; correctly identified as "format change, not additional work" (elegance)
- **Deferred `/fly:session` management commands** — correct scope discipline; core pipeline works without them (elegance)
- **locate→analyze BLOCKING at `plan-creation/SKILL.md:50`** — already aligned; plan builds on it (architecture)
- **`.flywheel/` gitignore + per-session dir** — clean separation from tracked artifacts (architecture)

---

## Metrics

- **Reviewers run**: 6 in parallel (architecture, code-quality, patterns, performance, data-integrity, elegance)
- **Raw findings**: ~60 across all reviewers
- **After dedup**: 31 distinct findings + 9 Open Questions
- **Cross-reviewer promotions** (same concern, ≥2 reviewers): BC claim cardinality (3 reviewers), atomic writes (3 reviewers), TUI namespace (2 reviewers), baseline immutability (2 reviewers), stale active.json (2 reviewers), commands re-execution idempotency (3 reviewers)
- **Conflicts → Open Questions**: 9 (see above)
- **Severity distribution**: 8 P1, 16 P2, 7 P3

