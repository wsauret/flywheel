---
date: 2026-04-23
plan: refactor-rigor-gradient-pipeline.md
source_design: 2026-04-23-ce-adoptions-plan.md
source_research: docs/research/2026-04-23-compound-engineering-vs-flywheel.md
---

# Context: Rigor-Gradient Pipeline Refactor

## Research summary

This refactor reshapes the Flywheel plugin's planning/execution pipeline around structured JSON artifacts under per-session directories. The source is a detailed design document (817 lines) at `docs/plans/2026-04-23-ce-adoptions-plan.md` that decomposes the change into K1–K6 architecture changes plus Tier A/B compound-engineering adoptions. Research traced every cited TUI pattern to verify "adopted from" framing, and inventoried every current SKILL.md and reviewer agent to anchor the delta precisely.

## Key files — current state (pre-refactor)

### Skills (`flywheel/skills/`)
- `plan-creation/SKILL.md` — 227 lines. Writes `docs/plans/<slug>.md` + `.context.md`. Phase 3 picks MINIMAL/MORE/A LOT templates. Phase 1 locate→analyze is BLOCKING at line 50.
- `plan-review/SKILL.md` — 153 lines. **Mutates `docs/plans/<slug>.md` in-place** by appending `# Plan Review Summary`. No separate findings file.
- `plan-consolidation/SKILL.md` — 153 lines. Reads plan+review, overwrites plan. Creates `.pre-consolidation.backup`.
- `work-implementation/SKILL.md` — 194 lines. State: `docs/plans/<slug>.state.md` (**markdown checkboxes, schema v3**). Baseline: `docs/plans/<slug>.baseline.md`. Session: `.flywheel/session.md` (single session, YAML+md).
- `work-review/SKILL.md` — 200 lines. Phase 1.0 plan-compliance exists (prose compare). Writes `docs/reviews/YYYY-MM-DD-<slug>.md`.
- `flywheel-conventions/SKILL.md` — 72 lines. Severity one-liner at **line 25**.
- `compound/SKILL.md` — 193 lines. Step 2 = Gather Context; Step 3 = Check Existing Docs. No Step 2.5.
- `brainstorm`, `debug`, `ship` — descriptions present, no edits needed beyond B7.

### Reviewer agents (`flywheel/agents/`)
All six load `flywheel-conventions` via frontmatter. Line counts + opener/Output Format locations (for Phase 2 edits):
- `reviewer-architecture.md` — 92 lines; opener 9-10; Output Format 64-92.
- `reviewer-code-quality.md` — 110 lines; opener 9-12; Output Format 84-110.
- `reviewer-elegance.md` — 226 lines; opener 9-17; Output Format 200-226. **Has local severity table at 179-182** (to remove).
- `reviewer-performance.md` — 80 lines; opener 9-11; Output Format 52-80.
- `reviewer-patterns.md` — 83 lines; opener 9-11; Output Format 67-83 (**condensed 3-section form, differs from others**). **Has local severity at 61-65** (to remove).
- `reviewer-data-integrity.md` — 145 lines; opener 9-13; Output Format 117-145.

### Commands (`flywheel/commands/fly/`)
`plan.md`, `review.md`, `consolidate.md`, `work.md`, `ship.md`, `brainstorm.md` — route to respective skills. Verify in Phase 5 no hardcoded `docs/plans/` paths.

### Root-level
- `flywheel.toml` — present but unchecked (verify if it references paths moving to session dir).
- `.gitignore` — does NOT currently ignore `.flywheel/`.
- `.flywheel/` — exists; currently houses a single `session.md`.

### Research + plans (`docs/`)
- `docs/research/2026-04-23-compound-engineering-vs-flywheel.md` — the originating CE research doc.
- `docs/plans/2026-04-23-ce-adoptions-plan.md` — the design doc being converted to this plan.
- No `docs/standards/`, `docs/solutions/` content yet (B8 references empty solutions dir as discoverability trigger).

## Patterns identified

### Already aligned with refactor direction
- **locate→analyze** is canonical in `plan-creation/SKILL.md:50` as a BLOCKING directive. No change needed — the refactor builds on it.
- **Context file sidecar** already exists (`plan-creation` writes `.context.md`; `work-implementation` reads it). Session-directory version is a relocation, not a new concept.
- **Baseline snapshot** already exists (`work-implementation` writes `.baseline.md`; `work-review` compares against it). The refactor upgrades markdown → JSON with immutability discipline.
- **Session dir** `.flywheel/` already exists, already gitignored by user convention. Refactor adds per-session subdirectories and an `active.json` pointer.
- **Fingerprint-based dedup** — not yet implemented; the refactor introduces it via K1+A1.

### Contradicts design assumptions (precision corrections)
- Design doc cites `schema_version: 1` as a `WorkerHandoff`/`HandoffFieldSpec` discipline. Verified: `schema_version` lives on `DispatcherDecisionSchema` (`src-legacy/dispatcher/schemas.ts:139`), **not on `WorkerHandoff`**. `WorkerHandoff`'s discipline is `summary` (min 20, max 5000 chars). Plan captures this correction in Open Question #10.
- Design doc frames `flywheel/schemas/*.schema.json` as matching TUI's `WorkerHandoff` pattern. Verified: TUI uses **Zod exclusively**; no JSON Schema files exist. Plan frames the JSON Schema approach as "inspired by / analogous to" TUI's Zod, not "adopted from." Open Question #10.

### Found exactly as claimed
- `src-legacy/queue/steps/plan-draft/prompts.ts` — `DRAFT_JSON_EXAMPLE` + `PLAN_DRAFT_SCHEMA_RULES` show `behavioralContract[]` + `fulfills[]` semantics verbatim.
- `src-legacy/queue/steps/work/fields.ts` — `WORK_STEP_FIELDS` with `commands_run` re-execution accuracy note verbatim.
- `src-legacy/queue/steps/plan-review/prompts.ts` — `PLAN_REVIEW_ANNOTATION_RULES` with "DO NOT MODIFY" discipline on every draft-authored field.

## Conventions observed in current plugin

- SKILL.md frontmatter: `description:` drives invocation routing (B7 targets this field).
- Reviewer agents: uniform `skills: [flywheel-conventions, language-standards]` frontmatter loads the shared conventions. `reviewer-elegance` omits `language-standards` (it's opinion-only, not code-linting).
- References sub-directory: used by `plan-creation`, `plan-review`, `plan-consolidation`, `work-implementation`, `work-review` for extracted late-loaded content. Flywheel-conventions has none currently — per the refactor, B2/B3 additions stay in SKILL.md body (small enough to not warrant extraction).
- Two-pass research: locate → analyze. Enforced by BLOCKING directive.
- Dual-write to Tasks + state file (resilience pattern for Ralph-mode recovery).
- Gitignore: `.flywheel/` exists but is NOT in `.gitignore` yet (Phase 1 step 1).

## Open questions from research

See the plan's **Open Questions** section (14 items total). The most load-bearing for Phase 1 are:

- #13: Does plugin have `package.json`? If not, Phase 1 adds it + ajv devDeps for schema validation tests.
- #14: `flywheel.toml` — does it need updating? Phase 5 regression sweep handles this.
- #10: Design doc precision corrections (schema_version + Zod framing) — low-cost accuracy win in SKILL.md rewrites.

## Next steps

1. Run `plan-review` skill on this plan — 6 reviewers evaluate structure, BC coverage, feasibility. Findings → `findings.json` (though review itself runs under the CURRENT pipeline, not the new one, since the new pipeline is what this plan builds).
2. Run `plan-consolidation` to merge review findings and resolve any raised Open Questions.
3. Transfer to `/fly:work` for execution.

## Agents run (research trace)

- `flywheel:locator-codebase` × 2 (plugin file inventory; TUI reference-pattern locations)
- `flywheel:locator-patterns` × 1 (current severity/template/state patterns; result partially incomplete due to path confusion — re-verified manually)
- `flywheel:locator-docs` × 1 (docs + conventions files)
- `flywheel:analyzer-codebase` × 3 (core planning skills; reviewers + conventions; TUI verbatim snippets)

Total: 7 subagent dispatches; all findings captured in plan + this context file.
