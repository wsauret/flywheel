---
date: 2026-04-23
status: consolidated
type: refactor
source_design: docs/plans/2026-04-23-ce-adoptions-plan.md
source_research: docs/research/2026-04-23-compound-engineering-vs-flywheel.md
pre_consolidation_backup: docs/plans/refactor-rigor-gradient-pipeline.md.pre-consolidation.backup
---

# Plan: Rigor-Gradient Pipeline + CE Adoptions (Consolidated)

## Status

**Consolidated** — ready for `/fly:work`. All Open Questions resolved with user input during consolidation (see Decisions Made). 31 distinct review findings integrated into the checklist or deferred with rationale. Zero remaining blockers.

---

## Executive Summary

Reshape Flywheel's plugin pipeline (plan-creation → plan-review → plan-consolidation → work-implementation → work-review) to use structured JSON artifacts under per-session directories (`.flywheel/plugin/sessions/<slug>-<date>/`). Add assertion-level traceability via `behavioral_contract[]` + `fulfills[]`. Layer targeted compound-engineering adoptions to sharpen reviewer quality (method-primed openers, false-positive suppression, observable-behavior framing, fingerprint dedup).

**Scope**: 7 phases (foundation → reviewers → planning → execution 4a → compliance 4b → command surface → hygiene). ~30 files touched across skills, agents, schemas, references. Drops MINIMAL/MORE/A LOT templates; drops markdown state/baseline/findings in favor of JSON.

**Skip-review (plan-creation → work) is a first-class path**. Review + consolidation are refinement passes. Rigor increases through refinement, not through stage count.

**Evaluation filter** (from design doc): agent-output elegance × token-efficiency. Plan execution success is measured by the code the agent ships after these changes — fewer defensive wrappers, surgical fixes, no ceremony from speculative reviewer findings.

---

## Decisions Made (from consolidation)

These resolve all Open Questions from plan-review. They change earlier phase contents; they are authoritative for implementation.

| # | Decision | Rationale |
|---|---|---|
| D1 | **`context.md` stays a separate sidecar** (not absorbed into spec.json) | Mirrors TUI's plan-research step, which writes `context.md` to session dir and keeps plan artifact (plan.json) structurally pure. No divergence between two tools on a thing they could share. |
| D2 | **`baseline.json` is a full copy of spec.json + SHA-256 hash in `session.json`** | Preserves structural-diff capability even when user edits spec.json mid-execution. Hash catches protocol violations (baseline mutated after work-start). Cost: ~1–5KB/session duplication (negligible). |
| D3 | **K6 commands re-execution check (Check 3) is CUT** | B5 anti-pattern ("declare done without running tests") already addresses the trust mechanism. Re-execution adds wall-time (30s+ for test suites), idempotency risk (running `git commit`/migrations twice), and only covers N samples. Elegance lever: removing the weakest K6 component without losing core win. **Work-review Phase 1.0 now runs TWO mechanical checks, not three**: structured diff + BC coverage. |
| D4 | **Reviewer Output Format references a shared fixture** `flywheel/schemas/findings.example.json` (not inline example in 6 prompts) | Single source of truth; all 6 reviewers reference the same file. Code-quality's LLM-compliance concern met (example exists); elegance's drift concern met (no duplication). |
| D5 | **Reviewers receive explicit `scope_context: "plan" \| "code"` parameter** via plan-review/work-review Task prompts | Deterministic scope.kind disambiguation. Prevents mixed-scope outputs from a single review run. |
| D6 | **Fingerprint dedup: shell + jq script at `flywheel/synthesizer/fingerprint.sh`** | Plugin has no existing runtime (no package.json). Shell + jq is the lowest-install option that's still testable and deterministic. Synthesizer SKILL.md shells out via Bash. No TS compiler, no bundler. ~50-line script. |
| D7 | **`spec.json.pre-consolidation` sidecar**, cleaned on ship | Simpler than in-file revision history. Lives alongside `spec.json` in session dir. Added to artifact map, session.schema.json, and ship cleanup. |
| D8 | **`ajv` as dev-dependency only** (schema-validation tests only) | Pre-flight BC-coverage check in `work-implementation` Phase 1 is prose-directive-based (agent reasons about coverage), not `bunx ajv`. Matches Flywheel's existing style. No runtime bundle addition. |
| D9 | **`/fly:review` routing heuristic authored in Phase 4** (session detection owns it) | Phase 4 rewrites session detection anyway; routing logic lives there. Phase 6 (command surface) becomes verification-only. |
| D10 | **Phase 4 splits into 4a (execution boundary) + 4b (compliance checks)** | 4a = work-implementation adapter + state/baseline JSON. 4b = work-review three → TWO mechanical checks (post-D3). SRP per phase. |
| D11 | **Plan stays self-contained** (current form, not delta-over-design-doc) | Plan is authoritative for `/fly:work`; implementer reads one file, not two. Acceptance of ~70% overlap with design doc (restatement is an elegance cost, but readability win). |
| D12 | **`/fly:session list\|switch\|delete` DEFERRED to follow-up PR** | Core pipeline works with `active.json` pointer + manual `rm -rf`. P3 documentation only in this plan. |
| D13 | **BC claim cardinality: at-least-one required; multiple claims = warning** (not "exactly one") | Elegance + code-quality consensus. Orphaned BCs = error (`BC has no task claim`). Multiple claims surface as Open Question during consolidation — legitimately possible for cross-phase contracts. `uniqueItems` on BC IDs is schema-enforceable. |
| D14 | **TS/build infra: minimal** — only shell scripts + schema files + fixture JSON | Shell + jq for fingerprint (D6). ajv-cli via bunx for schema tests (D8). No package.json, no tsconfig, no TypeScript. Matches plugin's current zero-runtime posture. |

---

## Critical Items (must land together as a cohesive unit)

Phases 1–4b are the architectural unit. Partial landing breaks the pipeline.

| Item | Phase | Blocking? |
|---|---|---|
| Schemas + `.gitignore` + shared conventions updates | 1 | Yes — foundation for all others |
| Reviewer JSON output + fingerprint script + synthesizer write | 2 | Yes — `findings.json` shape depends on this |
| plan-creation writes spec.json; plan-consolidation refines it | 3 | Yes — spec.json is the execution input |
| work-implementation consumes TaskList; baseline+state JSON | 4a | Yes — execution can't run without |
| work-review Phase 1.0 mechanical checks (2 checks, D3 cut one) | 4b | Yes — closes the compliance loop |
| Command surface + dogfood | 5 | Gate — merges the unit |
| Skill hygiene (B1/A4/B7/B8) | 6 | Deferred — additive, no blocking dependency |

---

## Implementation Checklist

Each phase includes **test steps first**, then implementation. Mark tasks complete as you ship them. Behavioral contract IDs (`BC-*`) are referenced — see Technical Reference for full list.

### Phase 1 — Foundation: Schemas, Storage, Shared Conventions

**Goal**: land substrate — authoritative schemas in `flywheel/schemas/`, `.flywheel/` gitignored, updated `flywheel-conventions/SKILL.md` with A2/B2/B3.

**Fulfills**: BC-FOUNDATION-001, BC-FOUNDATION-002, BC-FOUNDATION-003

**Depends on**: nothing (foundation).

#### Test steps

- [ ] **T1.1** Author fixture suite at `tests/schemas/fixtures/`:
  - `findings-valid-code.json` (one code-scope finding)
  - `findings-valid-plan.json` (one plan-scope finding)
  - `findings-missing-summary.json` (should fail: summary required)
  - `findings-missing-schema-version.json` (should fail)
  - `findings-invalid-scope-kind.json` (should fail — `kind: "unknown"`)
  - `findings-missing-scope-kind.json` (should fail — `kind` absent)
  - `findings-bad-polymorphic-mix.json` (should fail — `kind: "code"` with `phase_id` field — `additionalProperties: false` catches this)
  - `findings-malformed-reviewer-output.json` (malformed JSON; synthesizer test case, not schema test)
  - `task-list-valid.json` (spec with BC + fulfills claim)
  - `task-list-orphan-bc.json` (BC with zero `fulfills[]` claims — schema passes; coverage gate catches at procedural layer)
  - `task-list-duplicate-bc-id.json` (should fail — `uniqueItems` on behavioral_contract[].id)
  - `task-list-bad-slug.json` (should fail — `plan_id` pattern `^[a-z0-9-]+$`)
  - `state-valid.json` (state with `commands_run`)
  - `state-invalid-paused.json` (valid — `paused` is allowed status; placeholder test)
  - `baseline-valid.json` (frozen copy of task-list-valid)
  - `session-valid.json` (session metadata with `baseline_hash`)
  - `session-invalid-id-format.json` (should fail — pattern `^[a-z0-9-]+-\d{4}-\d{2}-\d{2}(-\d+)?$`)

- [ ] **T1.2** Write test runner at `tests/schemas/run.sh`:
  - Uses `bunx ajv --spec=draft2020 -s <schema> -d <fixture>` (NOT default draft-07)
  - Iterates fixtures, asserts expected pass/fail
  - Exits non-zero on unexpected result
  - Enumerate with bash array: `VALID_FIXTURES`, `INVALID_FIXTURES`

- [ ] **T1.3** Manual run of test runner passes: `bash tests/schemas/run.sh` exits 0.

#### Implementation steps

- [ ] **I1.1** `.gitignore` — append `.flywheel/` on its own line.

- [ ] **I1.2** Create `flywheel/schemas/` directory.

- [ ] **I1.3** Author `flywheel/schemas/findings.schema.json`:
  - `$schema: "https://json-schema.org/draft/2020-12/schema"`
  - Required top-level: `schema_version` (const 1), `reviewer` (enum of 6 reviewer slug names), `summary` (string, minLength 100, maxLength 5000), `findings[]`, `residual_risks[]`, `open_questions[]`
  - Each finding: `title`, `severity` (enum P1/P2/P3), `scope`, `what_wrong`, `suggested_fix`, `evidence`
  - `scope` is `oneOf` with **each branch** declaring `additionalProperties: false`:
    - Code branch: `kind: {const: "code"}` + `file` (required) + `line` (integer or null)
    - Plan branch: `kind: {const: "plan"}` + at least one of `phase_id`, `task_id`, `bc_id` (via `anyOf`)

- [ ] **I1.4** Author `flywheel/schemas/task-list.schema.json`:
  - `schema_version` (const 1), `plan_id` (pattern `^[a-z0-9-]+$`), `summary` (100–5000 chars), `goal`, `origin` ({`created_by`, `findings_path`}), `context` ({key_files[], patterns[], gotchas[]}), `behavioral_contract[]` with **`uniqueItems: true` on `.id`** (via `uniqueItemProperties` or equivalent), `phases[]`, `success_criteria[]`
  - Each BC: `id` pattern `^BC-[A-Z0-9]+-\d{3}$`, `title`, `description`, `evidence`, `area`
  - Each phase: `id`, `goal`, `depends_on[]`, `files[]`, `tasks[]` (each with `id`, `description`, `files[]`, `test_scenarios[]`, `fulfills[]`), `verification`, `manual_verification`

- [ ] **I1.5** Author `flywheel/schemas/state.schema.json`:
  - `schema_version` (const 1), `plan_id`, `status` enum `["not_started", "in_progress", "paused", "completed"]` (aligned with user's state-machine memory), `summary`, `phases[]` (each with `status`, `started_at`, `completed_at`, `outcomes`, `strikes[]`, `bc_satisfied[]`, `artifacts: {files_created[], files_modified[], commands_run[]}`), `learnings[]`, `error_log[]`
  - `commands_run[]` entries: `command`, `exit_code` (integer), `stdout_tail`, `re_executable` (bool, default true) — **note**: K6 Check 3 cut per D3, but `re_executable` field stays in case future Check 3 re-enabled

- [ ] **I1.6** Author `flywheel/schemas/baseline.schema.json`:
  - `allOf: [{$ref: "task-list.schema.json"}, {required: ["baseline_frozen_at"]}]` + `additionalProperties: false` constraint where applicable
  - `baseline_frozen_at` as ISO8601 timestamp
  - Test runner imports both schemas via `--schema` flag for cross-file `$ref` resolution

- [ ] **I1.7** Author `flywheel/schemas/session.schema.json`:
  - `schema_version` (const 1)
  - `session_id` (pattern `^[a-z0-9-]+-\d{4}-\d{2}-\d{2}(-\d+)?$`)
  - `slug`, `status` enum `["active", "paused", "completed"]`, `started_at`, `last_checkpoint_at`, `active_skill` (enum of 5 skill names or null)
  - `baseline_hash` (SHA-256 hex string, nullable until baseline.json written)
  - **`artifacts` sub-object REMOVED** (decisioned — filenames are constants on disk; sub-object was parallel state per elegance P1-1)

- [ ] **I1.8** Author `flywheel/schemas/findings.example.json` — shared canonical example (D4):
  - `schema_version: 1`, `reviewer: "reviewer-elegance"`, realistic `summary`
  - One code-scope finding, one plan-scope finding
  - Valid against `findings.schema.json`
  - Referenced by all 6 reviewer agent prompts in Phase 2

- [ ] **I1.9** Update `flywheel/skills/flywheel-conventions/SKILL.md`:
  - **Line 25 severity replacement** (A2): replace one-liner with 3-line block:
    ```
    **Severity**:
    - **P1**: High-impact defect — security, data loss, breaking change, or likely hit in normal usage. BLOCKS MERGE.
    - **P2**: Moderate issue with real downside (edge case, perf regression, maintainability trap). Fix if straightforward.
    - **P3**: Low-impact, narrow scope. User's discretion.
    ```
  - **Line 21 word limit update**: replace "Reviewers 1500" with "Reviewers: return valid JSON conforming to `findings.schema.json`; no word limit on the JSON object."
  - **Add B2 "False-Positive Suppression" section** after Output Rules (verbatim from design doc K1/B2)
  - **Add B3 "Finding Quality: Lead with Observable Behavior" section** after B2
  - **Add B4 "Spec Quality Bar" section** after B3 (moved from plan-consolidation per D-elegance P3-1): criteria for a spec to be work-ready (clear goal, repo-relative paths, enumerated test scenarios, explicit verification, dependencies, BC coverage rule "orphans = error, duplicates = warning" per D13)
  - **No references/ subdirectory** — all additions stay in SKILL.md body

#### Verification

- [ ] **V1.1** `bash tests/schemas/run.sh` exits 0; all 17 fixtures behave as expected.
- [ ] **V1.2** `.flywheel/` is gitignored:
  ```bash
  mkdir -p .flywheel/plugin/sessions/test && touch .flywheel/plugin/sessions/test/spec.json
  git check-ignore .flywheel/plugin/sessions/test/spec.json  # should print the path
  rm -rf .flywheel/plugin/sessions/test
  ```
- [ ] **V1.3** `flywheel-conventions/SKILL.md` contains A2 severity block, B2 + B3 + B4 sections, and updated word-limit line. `wc -l` ≈ 100–110.

#### Acceptance: **BC-FOUNDATION-001** (schemas valid + fixtures pass), **BC-FOUNDATION-002** (.flywheel gitignored), **BC-FOUNDATION-003** (conventions updated with A2/B2/B3/B4)

---

### Phase 2 — Reviewer Boundary: JSON Output + Method Openers + Fingerprint Dedup

**Goal**: 6 reviewers emit findings as schema-conforming JSON; synthesizers (plan-review, work-review) dedup via fingerprint script and write `findings.json` / `review.findings.json` to the active session. Method-embedded openers (A3) sharpen reviewer focus.

**Fulfills**: BC-REVIEWERS-001, BC-REVIEWERS-002, BC-REVIEWERS-003, BC-REVIEWERS-004

**Depends on**: Phase 1 (schemas + conventions).

#### Test steps

- [ ] **T2.1** Fixture tests at `tests/reviewers/`:
  - `six-reviewer-findings-code.json` (mock 6 reviewers in work-review context; all `scope.kind: "code"`)
  - `six-reviewer-findings-plan.json` (mock 6 reviewers in plan-review context; all `scope.kind: "plan"`)
  - `overlapping-findings.json` (3 reviewers report same issue at `src/auth.ts:42-44`; fingerprint collision; severity promotes one level on multi-reviewer match)
  - `mixed-scope-reviewer-output.json` (one reviewer produces code-scope finding in plan review — documents the disambiguation failure mode; synthesizer rejects with P1 finding against the violating reviewer)

- [ ] **T2.2** Unit test `tests/reviewers/fingerprint.test.sh`:
  - Invokes `flywheel/synthesizer/fingerprint.sh` with each fixture
  - Asserts code fingerprints: `code:src/auth.ts:6:parsedate-validates-input` (line 42 → bucket 6)
  - Asserts plan fingerprints: `plan:phase-2:t3:BC-AUTH-001:error-handling-missing`
  - **Line-null case** (code finding with `line: null`): `code:src/auth.ts:*:title` (bucket is `*`, not NaN per P3-3)
  - Collision case: 3 reviewers → one fingerprint; severity promoted P2+P2 → P1

- [ ] **T2.3** Malformed reviewer output test: `tests/reviewers/malformed.test.sh` — verifies synthesizer emits P1 finding against the reviewer producing invalid JSON; continues processing remaining reviewers.

- [ ] **T2.4** Live dogfood: run `/fly:review` on current branch. Verify `review.findings.json` in session dir validates against `findings.schema.json`. No regex in synthesizer code path.

#### Implementation steps

- [ ] **I2.1** Write `flywheel/synthesizer/fingerprint.sh` (D6 — ~50 lines bash + jq):
  - Reads findings JSON from stdin or path arg
  - For each finding:
    - Normalize title: `echo "$title" | tr '[:upper:]' '[:lower:]' | tr -s '[:space:][:punct:]' '-' | head -c 60`
    - If `scope.kind == "code"`: bucket = `$line / 7` via bash arithmetic; if `line` null or absent, bucket = `*`; fingerprint = `code:$file:$bucket:$normalized_title`
    - If `scope.kind == "plan"`: fingerprint = `plan:${phase_id:-*}:${task_id:-*}:${bc_id:-*}:$normalized_title`
  - Emit fingerprint + finding as NDJSON to stdout
  - Caller groups by fingerprint via `sort | uniq -c`; promotes severity when count ≥ 2

- [ ] **I2.2** Rewrite all 6 reviewer agent openers (A3 per design doc table):
  - `reviewer-architecture.md` lines 9-10 → method-embedded opener
  - `reviewer-code-quality.md` lines 9-12 → method-embedded opener
  - `reviewer-elegance.md` lines 9-17 → method-embedded opener
  - `reviewer-performance.md` lines 9-11 → method-embedded opener
  - `reviewer-patterns.md` lines 9-11 → method-embedded opener
  - `reviewer-data-integrity.md` lines 9-13 → method-embedded opener

- [ ] **I2.3** Replace each reviewer's Output Format section with K1 JSON instruction:
  - "Return findings as a JSON object conforming to `flywheel/schemas/findings.schema.json`. See `flywheel/schemas/findings.example.json` for a canonical example. Return valid JSON only."
  - **D4**: reference the shared example file (not inline)
  - **Reviewer-patterns special case** (P2-9): its body is shaped around the condensed 3-section form. Before replacing, verify body structure; do not assume symmetry with other 5. Replace its entire Output Format block cleanly.
  - Each reviewer prompt also states the `scope_context` param it will receive (plan vs code) and sets `scope.kind` accordingly (D5).

- [ ] **I2.4** Remove local severity tables:
  - `reviewer-elegance.md:179-182` — delete Severity Mapping block (shared A2 takes over)
  - `reviewer-patterns.md:61-65` — delete local Severity Guide
  - **Preserve `reviewer-elegance.md` frontmatter `skills: [flywheel-conventions]`** (no `language-standards` — intentional omission per P2-10)

- [ ] **I2.5** Rewrite `plan-review/SKILL.md` Phase 2 (Task dispatch):
  - Pass `scope_context: "plan"` to every reviewer Task prompt (D5)
  - Instruct reviewers that their output must be JSON conforming to schema
  - Include the no-file-write constraint (existing behavior preserved)

- [ ] **I2.6** Rewrite `plan-review/SKILL.md` Phase 3 (synthesizer):
  - Shell out to `flywheel/synthesizer/fingerprint.sh` on parsed reviewer JSON
  - Group findings by fingerprint; promote severity on multi-reviewer matches
  - **Reject cross-scope findings**: if a reviewer produces `scope.kind: "code"` in a plan-review context, emit P1 finding against the violating reviewer + include original; do NOT silently pass through
  - **Handle malformed reviewer output** (P2-2): parse failure → P1 finding pointing at reviewer-agent-file; continue with remaining reviewers
  - Write merged array to `findings.json` in active session dir
  - Print chat summary assembling each reviewer's `summary` field + merge metadata

- [ ] **I2.7** Remove `plan-review/SKILL.md` Phase 5 (append Review Summary to plan.md) — **this is the behavior the new plan replaces**:
  - Old Phase 5 appended markdown to `docs/plans/<slug>.md`. Post-refactor, findings live in `findings.json` only. Chat summary prints the synthesis; no markdown write.
  - Also: update empty-argument fallback at `plan-review/SKILL.md:22` (P2-8) — read `.flywheel/plugin/active.json`, load that session's `spec.json` for review, instead of searching `docs/plans/`.

- [ ] **I2.8** Rewrite `work-review/SKILL.md` Phase 3 (synthesizer): same structure as plan-review Phase 3 but passes `scope_context: "code"`, writes `review.findings.json`. Remove the `docs/reviews/YYYY-MM-DD-<slug>.md` markdown document write entirely.

#### Verification

- [ ] **V2.1** `bash tests/reviewers/fingerprint.test.sh` exits 0.
- [ ] **V2.2** `bash tests/reviewers/malformed.test.sh` exits 0.
- [ ] **V2.3** Grep check: `grep -c 'findings.example.json' flywheel/agents/reviewer-*.md` returns 6.
- [ ] **V2.4** Grep check: `grep -A1 'Severity Mapping\|Severity Guide' flywheel/agents/reviewer-elegance.md flywheel/agents/reviewer-patterns.md` is empty (local tables removed).
- [ ] **V2.5** Grep check: `grep 'language-standards' flywheel/agents/reviewer-elegance.md` is empty (preserved omission).
- [ ] **V2.6** Live dogfood: `/fly:review` on current branch produces valid JSON in session dir.

#### Acceptance: **BC-REVIEWERS-001** (6 reviewers emit schema-conforming JSON), **BC-REVIEWERS-002** (fingerprint script dedups across reviewers), **BC-REVIEWERS-003** (method-primed openers applied), **BC-REVIEWERS-004** (markdown review document write removed; scope_context param enforced)

---

### Phase 3 — Planning Pipeline: `spec.json` from Stage 1, Consolidation Refines

**Goal**: `plan-creation` composes `spec.json` directly (drops MINIMAL/MORE/A LOT templates). `plan-consolidation` becomes a refinement pass that merges `findings.json` into `spec.json`. Session dir + `active.json` pointer created at plan-creation time.

**Fulfills**: BC-PLANNING-001, BC-PLANNING-002, BC-PLANNING-003, BC-PLANNING-004

**Depends on**: Phase 1 (task-list schema), Phase 2 (findings.json shape — HARD dependency per P1-G).

#### Test steps

- [ ] **T3.1** Fixture test at `tests/pipeline/plan-create.test.sh`:
  - Given a trivial feature description, invoke plan-creation (dry-run if possible; else inspect output of real run)
  - Assert session dir created at `.flywheel/plugin/sessions/<slug>-<date>/`
  - Assert `spec.json` validates against `task-list.schema.json`
  - Assert `behavioral_contract[]` has ≥1 entry with valid BC ID format
  - Assert BC coverage holds: every BC has ≥1 task claim (orphans = error; multiple = warning, per D13)
  - Assert `origin.created_by === "plan-creation"`
  - Assert `.flywheel/plugin/active.json` points at this session

- [ ] **T3.2** Fixture test at `tests/pipeline/plan-consolidate.test.sh`:
  - Given fixture `spec.json` + `findings.json`
  - Invoke plan-consolidation
  - Assert `spec.json.pre-consolidation` sidecar written before overwrite (D7)
  - Assert refined `spec.json` contains integrated P1 fixes (as updated task descriptions or new tasks)
  - Assert BC coverage holds after integration (per D13)
  - Assert `origin.created_by === "plan-consolidation"`

- [ ] **T3.3** Live dogfood:
  - `/fly:plan "add trivial test endpoint"` — inspect session dir
  - `/fly:review` — inspect `findings.json`
  - `/fly:consolidate` — inspect refined spec + `.pre-consolidation` sidecar
  - Every artifact validates against its schema

#### Implementation steps

- [ ] **I3.1** Rewrite `plan-creation/SKILL.md` output phase:
  - **Keep Phase 0 (existing knowledge), Phase 1 (locate→analyze), Phase 2 (Context7 external validation)** intact. Research pipeline unchanged; only the output changes.
  - **Replace Phases 3–5** with JSON composition per design doc K3:
    1. Derive session ID (`<slug>-<YYYY-MM-DD>`; append `-2` if collision — original OQ #6 recommendation)
    2. Create `.flywheel/plugin/sessions/<session-id>/` directory
    3. Synthesize phases + tasks from research output
    4. Assign concrete file paths (from locator/analyzer findings)
    5. Enumerate test scenarios per task
    6. Compose `behavioral_contract[]` — BC IDs `BC-<AREA>-<NNN>`; assign each task's `fulfills[]` array
    7. **B4 Spec Quality Bar gate** (now in flywheel-conventions per D-elegance P3-1) — verify spec is work-ready: clear file paths, test scenarios, verification, BC coverage (at-least-one per BC per D13). Unresolved uncertainty → `open_questions[]` on spec, not vague tasks.
    8. Write `spec.json` with `schema_version: 1`, `summary` 100–5000 chars, `origin.created_by: "plan-creation"`
    9. Write `context.md` sidecar (mirrors TUI per D1) — research findings as structured prose
    10. Write `session.json` (status: active, timestamps, `active_skill: "plan-creation"` then clear on exit)
    11. Update `.flywheel/plugin/active.json` → `{ schema_version: 1, session_id: "<id>" }`
    12. Print chat summary (spec.json's `summary` field)
    13. Prompt: "Run `/fly:review` for refinement or proceed to `/fly:work`?"

- [ ] **I3.2** Apply A5 core principles (5-item numbered list) in `plan-creation/SKILL.md` — replaces current Philosophy/Context Compaction block (current lines 17-21).

- [ ] **I3.3** Apply B7 negative routing to `plan-creation/SKILL.md` `description:` frontmatter: append "For exploratory requests where the user is unsure what to build, prefer brainstorm first. Once spec.json exists, use plan-review for evaluation or go straight to work. For a reviewed spec, use plan-consolidation to merge findings."

- [ ] **I3.4** DELETE `plan-creation/references/plan-templates.md` — MINIMAL/MORE/A LOT gone per K3.

- [ ] **I3.5** Rewrite `plan-creation/references/formatting-guide.md` entirely (P2-7 — not just change example). Replace type-prefix system (feat-/fix-/refactor-) with session-ID format docs: `<slug>-<YYYY-MM-DD>` pattern, kebab-case slug, date suffix, `-N` collision tiebreak.

- [ ] **I3.6** Rewrite `plan-consolidation/SKILL.md` as refinement pass per K4:
  - **Input**: active session's `spec.json` + `findings.json` + `context.md`
  - **Procedure**:
    1. Read three inputs
    2. Back up spec.json to `spec.json.pre-consolidation` (D7)
    3. Surface unresolved Open Questions from `findings.json.open_questions` + inter-reviewer conflicts (findings sharing fingerprint with diverging severities). Present interactively via AskUserQuestion, **one at a time**.
    4. For each P1 finding: integrate `suggested_fix` into affected task's `description`; add test scenarios; create new tasks + BCs if finding doesn't map to existing tasks
    5. For each P2: same, but user can defer with rationale (recorded as task note)
    6. For each P3: user triage (include / drop / mark follow-up)
    7. If new tasks added, compose missing `fulfills[]` claims or new BCs; re-validate BC coverage (per D13: orphans = error; duplicates = Open Question surfaced)
    8. Update `spec.json.origin.created_by = "plan-consolidation"`; write refined spec.json
    9. Print summary; prompt "Start `/fly:work`?"
  - **No-op case**: if findings.json has zero findings + zero open questions, print "no refinements needed"; prompt for work.

- [ ] **I3.7** DELETE `plan-consolidation/references/consolidated-plan-template.md` — markdown consolidated template replaced by JSON refinement procedure.

- [ ] **I3.8** Review `plan-consolidation/references/extraction-patterns.md` — keep if still relevant to JSON findings extraction; else delete.

- [ ] **I3.9** Apply TUI precision corrections (P2-12 per design doc Open Question #10):
  - In all new SKILL.md wording, rewrite "adopts TUI's `WorkerHandoff` pattern" / "matches TUI's pattern" as "inspired by / analogous to the TUI's Zod-based schema discipline"
  - `schema_version` precedent cited from `DispatcherDecisionSchema` (`src-legacy/dispatcher/schemas.ts:139`), not `WorkerHandoff`
  - `summary` discipline cited from `WorkerHandoffBaseSchema` (`src-legacy/protocol/handoff-schemas.ts:110-169`)

- [ ] **I3.10** Apply TUI namespace correction (P1-C): in plan's Architecture section (Session Lifecycle > "Namespace separation from TUI"), correct to state TUI uses `.flywheel/sessions/` (no `tui/` infix). Plugin uses `.flywheel/plugin/sessions/` — the plugin's `plugin/` infix is the diverging element. `.gitignore` addition still correct.

#### Verification

- [ ] **V3.1** `bash tests/pipeline/plan-create.test.sh` exits 0.
- [ ] **V3.2** `bash tests/pipeline/plan-consolidate.test.sh` exits 0.
- [ ] **V3.3** Grep: `grep -c 'MINIMAL\|MORE\|A LOT' flywheel/skills/plan-creation/SKILL.md` returns 0.
- [ ] **V3.4** Grep: `test ! -f flywheel/skills/plan-creation/references/plan-templates.md`.
- [ ] **V3.5** Grep: `test ! -f flywheel/skills/plan-consolidation/references/consolidated-plan-template.md`.
- [ ] **V3.6** Live dogfood: full plan → review → consolidate sequence completes; all artifacts schema-valid.

#### Acceptance: **BC-PLANNING-001** (plan-creation emits valid spec.json), **BC-PLANNING-002** (BC coverage rule "at-least-one" validated at creation), **BC-PLANNING-003** (consolidation backs up to `.pre-consolidation` sidecar and merges findings), **BC-PLANNING-004** (MINIMAL/MORE/A LOT templates removed)

---

### Phase 4a — Execution Boundary: `TaskList` Input, JSON State, Read-Only Baseline, Hash Verification

**Goal**: `work-implementation` accepts `spec.json` or `findings.json` (fix-findings mode) via adapter. Writes `baseline.json` + SHA-256 hash in session.json (D2). `state.json` records real `commands_run` with accurate exit codes. `active.json` stale-pointer rescue. Session detection also authors `/fly:review` routing heuristic (D9).

**Fulfills**: BC-EXEC-001, BC-EXEC-002, BC-EXEC-003, BC-EXEC-004, BC-EXEC-005

**Depends on**: Phases 1–3.

#### Test steps

- [ ] **T4a.1** Adapter tests at `tests/work/adapter.test.sh`:
  - Spec.json → deserialize into in-memory TaskList; assert shape matches schema
  - Findings.json → adapter groups findings by file/subsystem; converts each finding to a task; synthesizes TaskList with BC carried from parent spec if exists, else synthesized from finding titles

- [ ] **T4a.2** Baseline immutability test:
  - Start work-implementation with fixture spec
  - Assert `baseline.json` exists AND `session.json.baseline_hash` populated
  - Verify hash: `sha256sum baseline.json` matches `session.json.baseline_hash`
  - Post-Phase 2, re-verify hash unchanged
  - Mutate baseline.json manually → assert hash mismatch detected in Phase 4b compliance check

- [ ] **T4a.3** Atomic write test (P1-D):
  - Simulate interrupted state.json write via `kill -9` mid-process
  - Assert `state.json.tmp` present OR `state.json` present, but never both in a corrupted state
  - Resume works: loads last-good state.json

- [ ] **T4a.4** Stale active.json test (P1-F):
  - Create session, delete its dir (`rm -rf`)
  - Invoke `/fly:work` (no args)
  - Assert: error message "Active session not found. Run /fly:plan or /fly:work <slug>." AND `active.json` cleared

- [ ] **T4a.5** `/fly:review` routing test (D9):
  - Session with `spec.json` but no `baseline.json` → routes to `plan-review`
  - Session with `baseline.json` → routes to `work-review`
  - Invocation with PR/branch arg → routes to `work-review` with PR context

#### Implementation steps

- [ ] **I4a.1** Rewrite `work-implementation/SKILL.md` Phase 0 (session detection):
  - Read `.flywheel/plugin/active.json`
  - Slug arg (`$ARGUMENTS` = slug): prefix-scan `sessions/<slug>-*`; tiebreak by most recent date; update `active.json` (per P1-H fix)
  - `findings.json` path arg: use that session in fix-findings mode
  - **Stale pointer rescue** (P1-F): if `active.json` exists but session dir missing → print error + clear `active.json`
  - No args + no active.json: error "No active session. Run /fly:plan."

- [ ] **I4a.2** Rewrite `work-implementation/SKILL.md` Phase 1 (load & resume):
  - Detect input type (spec.json → plan mode; review.findings.json only → fix-findings mode)
  - Adapter: deserialize or synthesize TaskList
  - **Pre-flight BC-coverage check** (original OQ #5 + D13): agent reasons about BC coverage per rules in flywheel-conventions/B4. Orphans → error "BC X has no task claim"; multiple-claims → prompt user Open Question (per D13). **Prose-based per D8** (no ajv at runtime).
  - Write `baseline.json` (frozen copy of TaskList; validate against schema)
  - **Compute SHA-256 of baseline.json; store in `session.json.baseline_hash`** (D2)
  - Write initialized `state.json` (phases = not_started; schema_version: 1; status: not_started)
  - Update `session.json.active_skill = "work-implementation"` + checkpoint timestamp
  - Proceed to Phase 2 execution loop

- [ ] **I4a.3** Rewrite `work-implementation/SKILL.md` Phase 2 (execution loop):
  - Iterate `TaskList.phases[]`
  - Per phase completion, write state.phases[] entry with artifacts (files_created, files_modified, commands_run with accurate exit codes per K5 accuracy discipline)
  - Update state.bc_satisfied[] from phase's tasks' `fulfills[]`
  - Checkpoint updates session.json.last_checkpoint_at
  - **Atomic write**: always write to `state.json.tmp`, then rename (per P1-D). Covered in checkpoint-procedure.md.
  - **Clear `session.json.active_skill = null` on skill exit** (success or failure; per P2-14)

- [ ] **I4a.4** Rewrite `work-implementation/references/session-detection.md`: active-pointer model + stale-pointer rescue + slug-arg tiebreak.

- [ ] **I4a.5** Rewrite `work-implementation/references/load-resume-procedures.md`: adapter logic + pre-flight BC coverage.

- [ ] **I4a.6** Rewrite `work-implementation/references/state-file-template.md`: JSON template per state.schema.json (NOT markdown checkboxes).

- [ ] **I4a.7** Rewrite `work-implementation/references/session-file-template.md`: JSON per session.schema.json.

- [ ] **I4a.8** Create `work-implementation/references/baseline-procedure.md`: copy spec.json → baseline.json; compute hash; baseline is read-only after write (protocol rule); hash in session.json is the enforcement. Document mid-execution plan change = user edits spec.json + re-run work-implementation (fresh baseline, fresh hash).

- [ ] **I4a.9** Rewrite `work-implementation/references/checkpoint-procedure.md`: JSON state write; atomic write-to-tmp-then-rename; commands_run accuracy requirement; reference to Phase 4b for compliance consequences.

- [ ] **I4a.10** Apply B5 anti-patterns to `work-implementation/SKILL.md`: three items from design doc B5 verbatim (no session-based splits; no per-task approval; no "done" without verification).

- [ ] **I4a.11** Append B6 5-question system-wide test check to `work-implementation/references/verification-gates.md`.

- [ ] **I4a.12** **Author `/fly:review` routing heuristic** (D9) in `work-implementation/references/session-detection.md` (shared helper) OR in command file — authoring happens in Phase 4a per D9:
  - Routing: no args + session has `baseline.json` → `work-review`; no args + session has `spec.json` but no `baseline.json` → `plan-review`; arg is PR # or branch → `work-review` with target
  - Documented once; referenced by `flywheel/commands/fly/review.md` in Phase 5

- [ ] **I4a.13** Apply B7 negative routing to `work-implementation/SKILL.md` `description:` frontmatter: append "Do not use for exploration or design decisions — work-implementation executes against an existing spec.json. For design work, use brainstorm or plan-creation."

- [ ] **I4a.14** Document schema version mismatch rejection (P2-6) in skill prompt: "If `schema_version` is not 1, error: 'Unsupported schema version <N>. Re-run the producing skill to regenerate.'"

#### Verification

- [ ] **V4a.1** `bash tests/work/adapter.test.sh` exits 0.
- [ ] **V4a.2** `bash tests/work/baseline-hash.test.sh` exits 0.
- [ ] **V4a.3** `bash tests/work/atomic-write.test.sh` exits 0.
- [ ] **V4a.4** `bash tests/work/stale-active.test.sh` exits 0.
- [ ] **V4a.5** `bash tests/work/routing.test.sh` exits 0.
- [ ] **V4a.6** Live dogfood: `/fly:plan "scratch feature"` → `/fly:work` → inspect `baseline.json` + `session.json.baseline_hash` + `state.json`.

#### Acceptance: **BC-EXEC-001** (adapter produces valid TaskList from either input), **BC-EXEC-002** (baseline hash verified), **BC-EXEC-003** (atomic state writes), **BC-EXEC-004** (stale active.json rescued), **BC-EXEC-005** (review routing heuristic works)

---

### Phase 4b — Compliance: work-review Mechanical Checks

**Goal**: `work-review` Phase 1.0 runs **TWO** mechanical checks against `baseline.json` + `state.json` (D3 cut Check 3 — commands re-execution). Findings emitted in K1 JSON format; flow through Phase 2 synthesizer's fingerprint dedup.

**Fulfills**: BC-COMPLIANCE-001, BC-COMPLIANCE-002, BC-COMPLIANCE-003

**Depends on**: Phase 4a (baseline.json + state.json shape + session.json.baseline_hash).

#### Test steps

- [ ] **T4b.1** Structured diff test at `tests/work-review/diff.test.sh`:
  - Baseline has 3 phases; state has 2 completed + 1 skipped → P1 finding with `scope.kind: "plan"`, `phase_id` set
  - Baseline phase has files [A, B, C]; state phase modified [A, B, Z] → P1 finding for Z outside baseline scope
  - Removed task from baseline → P1 finding

- [ ] **T4b.2** BC coverage test at `tests/work-review/bc-coverage.test.sh`:
  - Baseline has 5 BCs; state `bc_satisfied[]` union covers 4 → P1 finding for uncovered BC with `scope.kind: "plan"`, `bc_id` set
  - Baseline has 3 BCs; all satisfied → pass, no finding

- [ ] **T4b.3** Baseline hash verification test:
  - Normal case: `sha256sum baseline.json` matches `session.json.baseline_hash` → pass
  - Mutated case: edit baseline.json after work-start → hash mismatch → P1 finding "baseline was mutated after work-start" (data-integrity P2-1 fix)

- [ ] **T4b.4** Live dogfood:
  - After Phase 4a completes with a dogfood session, run `/fly:review`
  - Assert `review.findings.json` contains only expected findings
  - Inject a scope drift (modify state.json to claim a file outside baseline.phases[].files) → assert catch

#### Implementation steps

- [ ] **I4b.1** Rewrite `work-review/SKILL.md` Phase 1.0 with TWO mechanical checks (D3 cuts Check 3):
  - Read `baseline.json` + `state.json`
  - **Verify baseline hash**: recompute SHA-256 of baseline.json; compare to `session.json.baseline_hash`. Mismatch → P1 finding "baseline was mutated after work-start" (scope.kind: "plan", phase_id: null) → HALT compliance check; subsequent checks meaningless
  - **Check 1 — Structured diff**: compare `baseline.phases[].files[]` + task IDs vs `state.phases[].files_*[]`. Skipped phases, removed tasks, files outside baseline → P1 findings with polymorphic scope (plan for skipped phases; code for out-of-scope files)
  - **Check 2 — BC coverage**: compute union of `state.phases[].bc_satisfied[]`. For each `baseline.behavioral_contract[].id` NOT in union → P1 finding with `scope.kind: "plan"`, `bc_id` set
  - Each finding flows through Phase 2's fingerprint script + synthesizer write path (emits to `review.findings.json`)
  - **Check 3 (commands re-execution) is CUT per D3** — do not implement

- [ ] **I4b.2** Rewrite `work-review/references/plan-compliance.md`: describe the TWO mechanical checks + baseline hash verification. Delete any references to commands re-execution (D3 cut).

- [ ] **I4b.3** Update AC-PIPE-010 and any references to "three mechanical checks" throughout the plan → **two**.

#### Verification

- [ ] **V4b.1** `bash tests/work-review/diff.test.sh` exits 0.
- [ ] **V4b.2** `bash tests/work-review/bc-coverage.test.sh` exits 0.
- [ ] **V4b.3** `bash tests/work-review/hash.test.sh` exits 0.
- [ ] **V4b.4** Live dogfood: inject scope drift → caught.

#### Acceptance: **BC-COMPLIANCE-001** (baseline hash verified on review), **BC-COMPLIANCE-002** (structured diff catches scope drift), **BC-COMPLIANCE-003** (BC coverage catches uncovered contracts)

---

### Phase 5 — Command Surface + End-to-End Dogfood

**Goal**: `/fly:plan`, `/fly:review`, `/fly:consolidate`, `/fly:work` commands route through new pipeline. Routing heuristic (authored in Phase 4a) verified. Skip-review happy path dogfooded.

**Fulfills**: BC-COMMANDS-001, BC-COMMANDS-002

**Depends on**: Phases 1–4b.

#### Test steps

- [ ] **T5.1** Full E2E dogfood sequence on scratch branch:
  ```
  /fly:plan "add a toy feature to docs/scratch/"
  # verify session dir + spec.json + context.md + session.json + active.json
  /fly:review
  # verify findings.json
  /fly:consolidate
  # verify refined spec.json + spec.json.pre-consolidation sidecar
  /fly:work
  # verify baseline.json + session.json.baseline_hash + state.json
  /fly:review   # against resulting branch
  # verify review.findings.json (2 mechanical check findings, if any)
  ```

- [ ] **T5.2** Skip-review dogfood:
  ```
  /fly:plan "another toy"
  /fly:work    # goes straight to work from spec.json
  ```

- [ ] **T5.3** Resume test after interrupt: kill mid-work → re-invoke `/fly:work` with no args → resumes from state.json.

- [ ] **T5.4** Slug prefix-scan: `/fly:work <slug>` promotes session to active.

#### Implementation steps

- [ ] **I5.1** Verify `commands/fly/plan.md` invokes plan-creation; no hardcoded `docs/plans/` paths.

- [ ] **I5.2** Update `commands/fly/review.md` to invoke the Phase 4a routing helper (D9) that decides plan-review vs work-review. This is **verification + minimal wiring**, not authoring — routing logic lives in session-detection.md from Phase 4a.

- [ ] **I5.3** Verify `commands/fly/consolidate.md` invokes plan-consolidation.

- [ ] **I5.4** Verify `commands/fly/work.md` invokes work-implementation; accepts slug or findings.json path arg.

- [ ] **I5.5** Regression sweep: `grep -rn 'docs/plans/' flywheel/commands/fly/*.md flywheel/skills/*/SKILL.md` — update any remaining references to session-dir paths (other than historical/migrated ones in Technical Reference).

- [ ] **I5.6** Also update B7 negative routing for the remaining targets:
  - `brainstorm/SKILL.md` description: append "Once the approach is clear, use plan-creation to produce a spec.json."
  - `debug/SKILL.md` description: append "Use when the goal is to fix a specific reported issue. For exploration or new features, use brainstorm or plan-creation."

- [ ] **I5.7** Verify `flywheel.toml` (P3-new): read + update if any paths reference docs/plans/ or the old state.md format.

#### Verification

- [ ] **V5.1** Full E2E sequence passes (T5.1) end-to-end.
- [ ] **V5.2** Skip-review sequence passes (T5.2).
- [ ] **V5.3** Resume works (T5.3).
- [ ] **V5.4** Slug prefix-scan works (T5.4).
- [ ] **V5.5** `grep -n 'docs/plans/' flywheel/commands/fly/*.md | grep -v historical` returns 0 lines.

#### Acceptance: **BC-COMMANDS-001** (all commands route correctly), **BC-COMMANDS-002** (E2E skip-review + full-review both succeed)

---

### Phase 6 — Skill Hygiene (Token Wins)

**Goal**: low-risk hygiene — B1 rationale discipline, A4 BLOCKING audit, B7 remaining description updates, B8 compound discoverability.

**Fulfills**: BC-HYGIENE-001

**Depends on**: Phases 1–5 complete (stable SKILL.md content, otherwise moving target).

#### Test steps

- [ ] **T6.1** Token-count diff: before/after `wc -w` on `work-implementation`, `plan-consolidation`, `plan-creation` SKILL.md. Expect 15–20% reduction.

- [ ] **T6.2** BLOCKING audit grep:
  - Before: count `Do NOT`, `Must`, `Never`, `Always` at start of bold directives without `BLOCKING:` prefix
  - After: each gate directive has `**BLOCKING:**` prefix; non-gate directives use plain bold

- [ ] **T6.3** Manual sanity: re-run Phase 5 E2E dogfood → no regression.

#### Implementation steps

- [ ] **I6.1** Append B1 Rationale Discipline rule to `flywheel-conventions/SKILL.md`: "Every line in a SKILL.md loads on every invocation. Include rationale only when it changes what the agent does at runtime. If behavior would not differ without the sentence, cut it. Extract conditional/late-sequence content to `references/` and load on demand."

- [ ] **I6.2** B1 audit pass on `work-implementation/SKILL.md`: read top-to-bottom; flag/cut sentences that don't change agent behavior; extract late-sequence content to references/.

- [ ] **I6.3** B1 audit pass on `plan-consolidation/SKILL.md`.

- [ ] **I6.4** B1 audit pass on `plan-creation/SKILL.md`.

- [ ] **I6.5** A4 BLOCKING prefix audit across all SKILL.md + agent files: prefix `**BLOCKING:**` on every gate directive.

- [ ] **I6.6** B8 compound discoverability Step 2.5 in `compound/SKILL.md`:
  - Insert between Step 2 (Gather Context) and Step 3 (Check Existing Docs)
  - Detect first-time use per repo: `docs/solutions/` has 0 files OR no grep hit for "docs/solutions" in AGENTS.md/CLAUDE.md — **threshold clarified per P2-7**: use existence (0 files) not `<3` to avoid false positives
  - If detected: AskUserQuestion offering to add a one-line reference to AGENTS.md/CLAUDE.md; conditional Edit on yes

#### Verification

- [ ] **V6.1** Token-count check: `for s in work-implementation plan-consolidation plan-creation; do wc -w flywheel/skills/$s/SKILL.md; done` shows 15–20% reduction vs pre-audit.
- [ ] **V6.2** BLOCKING audit grep: every gate directive has prefix.
- [ ] **V6.3** Functional re-run of Phase 5 dogfood: passes.

#### Acceptance: **BC-HYGIENE-001** (three audits applied; no regression in E2E)

---

## Acceptance Criteria (plan-level, verified at end of Phase 6)

| ID | Criterion | How Verified |
|---|---|---|
| AC-PIPE-001 | `/fly:plan "foo"` creates `.flywheel/plugin/sessions/foo-YYYY-MM-DD/` with valid `spec.json` + `context.md` + `session.json`; updates `active.json` | Phase 3 V3.6 |
| AC-PIPE-002 | `spec.json` conforms to `task-list.schema.json`; BC-coverage rule (orphans = error, duplicates = Open Question per D13); non-empty summary 100-5000 chars; valid `BC-<AREA>-<NNN>` IDs with uniqueItems | Phase 1 V1.1 + Phase 3 T3.1 |
| AC-PIPE-003 | `/fly:work` reads `active.json`, writes `baseline.json` + `session.json.baseline_hash` + initialized `state.json` | Phase 4a V4a.2 + V4a.6 |
| AC-PIPE-004 | `/fly:work <slug>` prefix-scans; tiebreaks most-recent; updates `active.json` | Phase 4a V4a.5 indirectly (routing test) + V4a.6 |
| AC-PIPE-005 | `/fly:review` produces schema-conforming JSON (`findings.json` or `review.findings.json`) per polymorphic scope | Phase 2 V2.6 + Phase 4b V4b.4 |
| AC-PIPE-006 | Cross-reviewer matches collapse via fingerprint.sh deterministically | Phase 2 V2.1 |
| AC-PIPE-007 | `/fly:consolidate` writes `.pre-consolidation` sidecar, refines spec, re-validates BC coverage | Phase 3 V3.2 |
| AC-PIPE-008 | work-review Phase 1.0 runs **TWO** mechanical checks (structured diff + BC coverage); baseline hash verified | Phase 4b V4b.1-3 |
| AC-PIPE-009 | Skip-review path works end-to-end | Phase 5 T5.2 |
| AC-PIPE-010 | `baseline.json` hash unchanged after Phase 2 completes (enforcement, not just protocol) | Phase 4b V4b.3 |
| AC-PIPE-011 | All 6 reviewers load flywheel-conventions via frontmatter; inherit updated A2/B2/B3 | Phase 1 V1.3 + Phase 2 |
| AC-PIPE-012 | reviewer-elegance:179-182 + reviewer-patterns:61-65 local severity tables removed | Phase 2 V2.4 |
| AC-PIPE-013 | `.flywheel/` git-ignored | Phase 1 V1.2 |
| AC-PIPE-014 | E2E dogfood: plan → work → review runs cleanly; no prose-parsing in pipeline; no regex in synthesizer | Phase 5 V5.1 |
| AC-PIPE-015 (new per P1-D) | Atomic writes: state.json interrupted mid-write leaves .tmp but no corruption | Phase 4a V4a.3 |
| AC-PIPE-016 (new per P1-F) | Stale active.json pointer rescued with explicit error + pointer clear | Phase 4a V4a.4 |

---

## Technical Reference

### Current state (pre-refactor) — verified via analyzers in Phase 0 research

| File | Lines | Key facts |
|---|---|---|
| `flywheel/skills/plan-creation/SKILL.md` | 227 | Phase 3 picks MINIMAL/MORE/A LOT; Phase 4 writes `docs/plans/<slug>.md`; Phase 5 writes `.context.md`. Locate→analyze BLOCKING at line 50. |
| `flywheel/skills/plan-review/SKILL.md` | 153 | Phase 5 appends `# Plan Review Summary` to `docs/plans/<slug>.md` — to be removed in Phase 2. Empty-arg fallback at line 22 searches `docs/plans/` — update in Phase 2 I2.7. |
| `flywheel/skills/plan-consolidation/SKILL.md` | 153 | Reads plan+review; overwrites plan; creates `.pre-consolidation.backup` (which inspires D7's `spec.json.pre-consolidation`). |
| `flywheel/skills/work-implementation/SKILL.md` | 194 | State in `docs/plans/<slug>.state.md` (markdown checkboxes, schema v3). Session at `.flywheel/session.md` (single-session, YAML). Baseline at `.baseline.md`. |
| `flywheel/skills/work-review/SKILL.md` | 200 | Phase 1.0 compliance check exists (prose compare). Writes `docs/reviews/YYYY-MM-DD-<slug>.md` — to be removed in Phase 2 I2.8. |
| `flywheel/skills/flywheel-conventions/SKILL.md` | 72 | Severity one-liner at line 25. "Reviewers 1500" word limit at line 21. No B2/B3/B4 sections yet. |
| `flywheel/agents/reviewer-*.md` | 80-226 | All 6; five use 6-section Output Format template; `reviewer-patterns` uses condensed 3-section (P2-9). `reviewer-elegance` omits `language-standards` from frontmatter (intentional — P2-10). Local severity at `reviewer-elegance:179-182` and `reviewer-patterns:61-65` — to remove. |
| `.flywheel/` | dir | Exists; houses `session.md`. NOT in `.gitignore` yet — Phase 1 I1.1. |
| `flywheel/commands/fly/*.md` | small | Route to skills. `review.md` currently unconditional → work-review; Phase 4a/5 add plan-review routing (D9). |
| `flywheel.toml` | ? | Root file; verify paths in Phase 5 I5.7. |

### TUI reference patterns (verified — for "inspired by" framing per P2-12)

| Pattern | File | Role |
|---|---|---|
| `behavioralContract[]` + `fulfills[]` | `flywheel-tui/src-legacy/queue/steps/plan-draft/prompts.ts:1-62` | Reference for BC shape; plugin mirrors exactly |
| `WorkerHandoffBaseSchema` (required `summary`) | `flywheel-tui/src-legacy/protocol/handoff-schemas.ts:110-169` | Reference for `summary` 100-5000 char discipline |
| `WORK_STEP_FIELDS` (commands_run accuracy) | `flywheel-tui/src-legacy/queue/steps/work/fields.ts:3-35` | Reference for state.json `commands_run` accuracy discipline |
| `PLAN_REVIEW_ANNOTATION_RULES` ("DO NOT MODIFY") | `flywheel-tui/src-legacy/queue/steps/plan-review/prompts.ts:1-87` | Inspiration for baseline immutability (enforced via hash in D2) |
| `DispatcherDecisionSchema` (required `schema_version: 1`) | `flywheel-tui/src-legacy/dispatcher/schemas.ts:139` | Source of `schema_version` discipline (NOT WorkerHandoff per P2-12) |
| TUI session dir: `.flywheel/sessions/` (no `tui/` infix) | `flywheel-tui/src/infra/paths.ts:9` | Corrects plan body claim (P1-C fix) |
| TUI `plan-research` step writes `context.md` sidecar | `flywheel-tui/src-legacy/queue/steps/plan-research/scaffolding.ts:13-16` | Precedent for D1 (plugin mirrors sidecar model) |

### Post-refactor artifact paths

```
flywheel/                                                  (tracked)
  schemas/
    findings.schema.json
    findings.example.json                                  (D4 shared example)
    task-list.schema.json
    state.schema.json
    baseline.schema.json
    session.schema.json
  synthesizer/
    fingerprint.sh                                         (D6 shell + jq)
  skills/...
  agents/...
  commands/...
tests/                                                     (tracked, dev-only)
  schemas/
    fixtures/*.json
    run.sh
  reviewers/
    *.test.sh
  pipeline/
    *.test.sh
  work/
    *.test.sh
  work-review/
    *.test.sh
.flywheel/                                                 (gitignored)
  plugin/
    active.json                                            { schema_version, session_id }
    sessions/
      <slug>-<YYYY-MM-DD>/
        session.json                                       (metadata + baseline_hash)
        context.md                                         (D1 sidecar)
        spec.json
        spec.json.pre-consolidation                        (D7 sidecar; cleaned on ship)
        findings.json                                      (after plan-review)
        baseline.json                                      (read-only after work-start; hash verified)
        state.json                                         (checkpoint-updated, atomic writes)
        review.findings.json                               (after work-review)
    traces/                                                (reserved)
    log/                                                   (reserved)
docs/                                                      (tracked)
  standards/                                               (unchanged)
  solutions/                                               (unchanged; B8 references)
  research/                                                (unchanged)
  plans/                                                   (stale after ship — this plan + design doc become historical)
```

### Behavioral Contracts (complete list)

| ID | Area | Description | Fulfilled by |
|---|---|---|---|
| BC-FOUNDATION-001 | Foundation | 5 schemas + shared example validate themselves; 17 fixture tests pass/fail as expected | Phase 1 tasks I1.3-I1.8, T1.1-T1.3 |
| BC-FOUNDATION-002 | Foundation | `.flywheel/` added to .gitignore | Phase 1 I1.1, V1.2 |
| BC-FOUNDATION-003 | Foundation | flywheel-conventions/SKILL.md contains A2 severity + B2 FP suppression + B3 observable framing + B4 quality bar + updated word-limit | Phase 1 I1.9, V1.3 |
| BC-REVIEWERS-001 | Reviewers | 6 reviewers emit schema-conforming JSON referencing shared example | Phase 2 I2.3, V2.3 |
| BC-REVIEWERS-002 | Reviewers | Fingerprint shell script dedups across reviewers; line-null → `*` bucket | Phase 2 I2.1, T2.2 |
| BC-REVIEWERS-003 | Reviewers | Method-primed openers (A3) applied to all 6 | Phase 2 I2.2 |
| BC-REVIEWERS-004 | Reviewers | Markdown review-document write removed; scope_context param enforced; malformed-output handling | Phase 2 I2.5-I2.8, V2.6 |
| BC-PLANNING-001 | Planning | plan-creation emits valid spec.json + context.md + session.json; updates active.json | Phase 3 I3.1, T3.1 |
| BC-PLANNING-002 | Planning | BC coverage rule "at-least-one" validated at creation (per D13) | Phase 3 I3.1 step 7, T3.1 |
| BC-PLANNING-003 | Planning | plan-consolidation backs up to .pre-consolidation sidecar and merges findings | Phase 3 I3.6, T3.2 |
| BC-PLANNING-004 | Planning | MINIMAL/MORE/A LOT templates removed; formatting-guide.md rewritten | Phase 3 I3.4-I3.5, V3.3-V3.4 |
| BC-EXEC-001 | Execution | Adapter produces valid TaskList from either spec.json or findings.json | Phase 4a I4a.2, T4a.1 |
| BC-EXEC-002 | Execution | Baseline hash computed + stored in session.json; verified on review | Phase 4a I4a.2, T4a.2 |
| BC-EXEC-003 | Execution | Atomic state.json writes (write-to-tmp-then-rename) | Phase 4a I4a.3, T4a.3 |
| BC-EXEC-004 | Execution | Stale active.json pointer rescued with explicit error + clear | Phase 4a I4a.1, T4a.4 |
| BC-EXEC-005 | Execution | `/fly:review` routing heuristic authored in session detection | Phase 4a I4a.12, T4a.5 |
| BC-COMPLIANCE-001 | Compliance | Baseline hash verified on work-review Phase 1.0 | Phase 4b I4b.1, T4b.3 |
| BC-COMPLIANCE-002 | Compliance | Structured diff catches scope drift; emits K1 JSON findings | Phase 4b I4b.1, T4b.1 |
| BC-COMPLIANCE-003 | Compliance | BC coverage check catches uncovered contracts | Phase 4b I4b.1, T4b.2 |
| BC-COMMANDS-001 | Commands | 4 fly:* commands route correctly through new pipeline | Phase 5 I5.1-I5.4, V5.5 |
| BC-COMMANDS-002 | Commands | E2E skip-review + full-review dogfoods succeed | Phase 5 T5.1-T5.2, V5.1-V5.3 |
| BC-HYGIENE-001 | Hygiene | B1 rationale discipline + A4 BLOCKING audit + B7 remaining descriptions + B8 Step 2.5 applied; no regression | Phase 6 I6.1-I6.6, V6.1-V6.3 |

Total: **22 BCs** across 7 phases. Each BC claimed by tasks in exactly one phase (per D13 rule: at-least-one; multiple phases claiming same BC would be an Open Question — none in this plan).

---

## Risks & Mitigations

- **Risk**: Phases 1–4b interdependent — partial landing breaks the pipeline.
  **Mitigation**: Treat as one unit. E2E dogfood gate at end of Phase 4b before Phase 5 merges the unit.

- **Risk**: Fingerprint.sh depends on `jq` being installed.
  **Mitigation**: Document jq dep in README/CLAUDE.md. Fallback: pure bash + awk if jq missing. Phase 2 T2.1 fixture test catches jq absence early.

- **Risk**: Baseline hash enforcement (D2) creates false positives if user legitimately re-plans mid-execution.
  **Mitigation**: Documented recovery path: user re-runs `plan-creation` or hand-edits spec.json then re-invokes `work-implementation` — which writes a fresh baseline.json + fresh hash. Hash mismatch is "you edited during execution; re-baseline" not "failure."

- **Risk**: BC ID hand-edit mistakes break pre-flight coverage check.
  **Mitigation**: Pre-flight emits human-readable error messages ("BC ID 'BC-auth-1' must match BC-[A-Z0-9]+-NNN format"). Ship a linting helper if adoption friction emerges (future).

- **Risk**: `.flywheel/plugin/sessions/` grows unbounded (session graveyard, P3).
  **Mitigation**: Documented; `/fly:session gc` deferred per D12. 90-day staleness guidance in Session Lifecycle section of design doc.

- **Risk**: Schema drift between `findings.schema.json` and `findings.example.json` example file.
  **Mitigation**: Phase 1 T1.1 includes `findings.example.json` as a valid fixture (must pass `ajv validate`). Drift caught at test time.

- **Risk**: Concurrent `/fly:work` invocations on same session (two terminals).
  **Mitigation**: Documented as known limitation. `session.json.active_skill` set at Phase 1; warning emitted if `last_checkpoint_at` < 15 min AND `active_skill` non-null on re-invocation. Full mutex deferred to future.

- **Risk**: Dropping K6 Check 3 (D3) weakens agent-honesty verification.
  **Mitigation**: B5 anti-pattern directive ("declare done without running tests") + BC coverage (Check 2) together cover the failure mode. Evidence is commands_run exit codes recorded in state.json — still inspectable, just not re-verified.

---

## Open Items (tracked for future, not blockers)

- Session GC / `/fly:session list|switch|delete` commands (D12 deferred)
- TUI convergence — publish `flywheel/schemas/*` as shared package when drift bites (original OQ #8 deferred)
- `flywheel.toml` regression in Phase 5 I5.7 — may require inline updates depending on contents
- Optional: JSON-schema-to-Zod bridge if plugin/TUI schema sharing becomes a priority

---

## Review Findings Summary

All 31 distinct findings from plan-review have been addressed:

- **P1 findings (8)**: All addressed —
  - P1-A (oneOf polymorphism): Phase 1 I1.3 scope `additionalProperties: false` + `const` kind
  - P1-B (BC coverage = schema vs procedural): D13 + Phase 1 I1.4 (uniqueItems) + B4 in conventions
  - P1-C (TUI namespace claim wrong): Phase 3 I3.10 corrects plan body
  - P1-D (atomic writes): Phase 4a I4a.3 + AC-PIPE-015
  - P1-E (baseline immutability): D2 + Phase 4a I4a.2 + Phase 4b I4b.1
  - P1-F (stale active.json): Phase 4a I4a.1 + AC-PIPE-016
  - P1-G (Phase 3 dependency): Updated in Phase 3 header
  - P1-H (prefix-scan claim): Phase 4a I4a.1 adds tiebreak by most-recent

- **P2 findings (16)**: All addressed or deferred with rationale —
  - P2-1 (inline vs shared example): D4 (shared example)
  - P2-2 (malformed reviewer output): Phase 2 I2.6 + T2.3
  - P2-3 (commands re-exec idempotency): D3 (cut — rationale: B5 covers)
  - P2-4 (plan_id slug pattern): Phase 1 I1.4 + I1.7
  - P2-5 (ajv runtime-vs-dev): D8 (dev-only)
  - P2-6 (schema version mismatch): Phase 4a I4a.14
  - P2-7 (formatting-guide full rewrite): Phase 3 I3.5
  - P2-8 (plan-review empty-arg fallback): Phase 2 I2.7
  - P2-9 (reviewer-patterns divergence): Phase 2 I2.3 special-cased
  - P2-10 (reviewer-elegance frontmatter): Phase 2 I2.4 preserves
  - P2-11 (word-limit inconsistency): Phase 1 I1.9 updates line 21
  - P2-12 (TUI precision OQ #10): Phase 3 I3.9 applies
  - P2-13 (active.json multiple writers): Documented in Risks
  - P2-14 (active_skill clear on exit): Phase 4a I4a.3
  - P2-15 (B4 centralization): Phase 1 I1.9 moves B4 to conventions
  - P2-16 (plan-over-design restatement): D11 (keep self-contained)

- **P3 findings (7)**: All addressed or noted —
  - P3-1 (session.json artifacts parallel state): Phase 1 I1.7 removes sub-object
  - P3-2 (normalize regex): Documented — one regex call is acceptable hot-path
  - P3-3 (line:null → NaN): Phase 2 I2.1 handles with `*` bucket
  - P3-4 (status enum missing paused): Phase 1 I1.5 adds all 4 states
  - P3-5 (BC ID UX): Documented in Risks
  - P3-6 (session growth): Documented; deferred per D12
  - P3-7 (Phase 4 split): D10 splits into 4a + 4b

- **Open Questions (9)**: All resolved —
  - OQ-α: D4 (shared example)
  - OQ-β: D2 (full copy + hash)
  - OQ-γ: D1 (sidecar, mirrors TUI)
  - OQ-δ: D3 (cut Check 3)
  - OQ-ε: D5 (explicit scope_context)
  - OQ-ζ: Phase 3 I3.10 applies fix
  - OQ-η: D6 (shell + jq)
  - OQ-θ: D9 (Phase 4a)
  - OQ-ι: D7 (pre-consolidation sidecar)

---

## Appendix — Raw Pre-Consolidation Content

Full pre-consolidation plan (with Plan Review Summary appended) preserved at:

```
docs/plans/refactor-rigor-gradient-pipeline.md.pre-consolidation.backup
```

Original design doc (unchanged):

```
docs/plans/2026-04-23-ce-adoptions-plan.md
```

Research context (Phase 0 research trail):

```
docs/plans/refactor-rigor-gradient-pipeline.context.md
```

Research basis (CE comparison):

```
docs/research/2026-04-23-compound-engineering-vs-flywheel.md
```
