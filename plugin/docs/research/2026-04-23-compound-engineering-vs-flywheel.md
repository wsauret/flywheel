---
date: 2026-04-23
topic: "Compound-engineering plugin (inspiration/) — workflows, structure, and contrast with Flywheel"
status: complete
tags: [research, compound-engineering, flywheel, plugin, skills, agents, planning, work-mode, review, comparison]
---

# Research: Compound-Engineering Plugin vs. Flywheel Plugin

## Executive Summary

The **compound-engineering** plugin (v3.0.1, authored by Kieran Klaassen / EveryInc, in `inspiration/compound-engineering/plugins/compound-engineering/`) is a mature, multi-platform agent plugin containing **37 skills** and **49 reviewer/researcher/specialist agents**, organized as an explicit *compound loop*: `ideate → brainstorm → plan → work → review → compound → repeat`. It targets Claude Code, Cursor, and Codex simultaneously via parallel `.claude-plugin/`, `.cursor-plugin/`, and `.codex-plugin/` manifests, and includes a Bun/TypeScript CLI for cross-platform conversion. It implements *persona-based reviewer dispatch* (18+ code-review personas in 4 tiers), *confidence-anchored scoring* (5 discrete anchors: 0/25/50/75/100), *two-pass validation* (independent validator sub-agents), *tracker-defer* for out-of-scope findings, and a *HITL document-review surface* through Proof (proofeditor.ai). Plan review is not a separate skill — it is embedded into `ce-code-review` as "Stage 2b Requirements Completeness" and into `ce-doc-review` for requirements/plan documents.

The **flywheel** plugin (v1.0.0, authored by Wesley Sauret, in `plugin/flywheel/`) is smaller and linear: **14 skills** and **15 agents** (6 reviewers + 4 locators + 5 analyzers), with a clean pipeline: `brainstorm → plan-creation → plan-review → plan-consolidation → work-implementation → work-review → ship → compound`. It is Claude-Code-only, declares a single Context7 MCP server, uses a *locate-then-analyze two-pass research pattern* (haiku locators produce paths, sonnet analyzers read contents), has a *dedicated plan-review skill* distinct from code review, and persists implementation state in explicit `.flywheel/session.md` + `<plan>.state.md` + `<plan>.baseline.md` files. Severity is simpler (P1/P2/P3, no confidence axis); reviewer dispatch is non-conditional (ALL 6 reviewers fire in parallel regardless of diff content); Ralph mode (stateless-loop activation for large plans) is a first-class concept.

Both plugins share: a `compound` skill that writes to `docs/solutions/` with a YAML frontmatter schema (near-identical two-track `bug` vs `knowledge` design); a skills/agents filesystem convention (SKILL.md + references/ + optional scripts/); and the pattern of gating skill advancement behind blocking `AskUserQuestion`.

Major structural differences surface in **five areas**: (1) reviewer architecture — CE has tiered persona selection with pre-commit gates and cross-reviewer promotion; Flywheel fires all reviewers unconditionally; (2) plan review — CE embeds it in code review; Flywheel dedicates a distinct skill; (3) session state — Flywheel has explicit dual-write state files and Ralph mode; CE relies on task lists + temp scratch directories; (4) ideation phase — CE has a dedicated `ce-ideate` skill before brainstorm; Flywheel starts at brainstorm; (5) multi-platform conversion — CE is authored once and shipped to three platforms; Flywheel is Claude-only.

---

## Compound-Engineering Plugin

### Core Philosophy

From root `README.md` and `ce-compound/SKILL.md:499`:

> The core loop: **brainstorm → plan → work → debug → code-review → compound → repeat**. Each cycle makes the next cycle easier. A good compound note means the next agent does not have to learn the same lesson from scratch. Knowledge compounds like interest.

Operationally expressed in:
- The `docs/solutions/` knowledge store (YAML frontmatter, structured search by module/tags/problem_type)
- Auto-invoke triggers ("that worked", "it's fixed", "problem solved") on `ce-compound`
- Discoverability self-check — `ce-compound` and `ce-compound-refresh` edit `AGENTS.md`/`CLAUDE.md` to ensure future agents find the knowledge store
- Universal `ce-` prefix on all components for unambiguous cross-plugin identification

---

### Planning Workflow (Ideate → Brainstorm → Plan → Proof)

Compound-engineering has **four planning-related skills** that chain. Collectively they address: "What should I do?" → "What should it mean?" → "How should it be built?" → "Is this right?"

#### ce-ideate (`skills/ce-ideate/SKILL.md:1-269`)

**Purpose**: Generates ranked candidate ideas. Answers "What are the strongest ideas worth exploring?"

**Triggers**: "what should I improve", "give me ideas", "ideate on X", "surprise me", "what would you change" (`SKILL.md:45-48` approximately)

**Phase structure** (`SKILL.md:50-267`):
- **Phase 0 Resume and Scope**: Checks `docs/ideation/` for recent docs. Classifies subject into `repo-grounded` / `elsewhere-software` / `elsewhere-non-software` (lines 68-99). Non-software routes to `references/universal-ideation.md`.
- **Phase 0.3 Volume and Intent**: Detects issue-tracker intent from keywords "bugs", "open issues" (lines 122-138). Default: 6-8 ideas per sub-agent, 5-7 survivors.
- **Phase 0.5 Cost Transparency**: Announces approximate agent count before dispatch — baseline 9 agents (repo mode), 8 (elsewhere-non-software) (lines 149-159).
- **Phase 1 Mode-Aware Grounding**: Generates 8-hex `<run-id>`, creates stable scratch at `${TMPDIR:-/tmp}/compound-engineering/ce-ideate/<run-id>` (lines 170-176). Repo mode dispatches: codebase scan (haiku model), `ce-learnings-researcher`, `ce-web-researcher`, optional `ce-issue-intelligence-analyst`. Elsewhere mode substitutes user-context synthesis.
- **Phase 2 Divergent Ideation**: Dispatches **6 parallel ideation sub-agents** (4 in issue-tracker mode). Each assigned one of six frames: Pain/friction, Inversion/removal/automation, Assumption-breaking, Leverage/compounding, Cross-domain analogy, Constraint-flipping (lines 248-254). Merge, dedupe, cross-cutting synthesis. **Checkpoint A**: writes `<scratch-dir>/raw-candidates.md`. Then loads `references/post-ideation-workflow.md` (non-optional).

**Post-ideation workflow** (`references/post-ideation-workflow.md`):
- **Phase 3**: Adversarial filtering by orchestrator directly. Targets 5-7 survivors. **Checkpoint B**: writes `<scratch-dir>/survivors.md`.
- **Phase 4**: Presents survivors with: title, description, rationale, downsides, confidence, complexity.
- **Phase 5**: Mode-determined persistence — repo mode → `docs/ideation/YYYY-MM-DD-<topic>-ideation.md`; elsewhere mode → Proof default.
- **Phase 6**: Four-option blocking menu: Refine in conversation, Open in Proof, Brainstorm a selected idea, Save and end (lines 145-148). On "Brainstorm": marks chosen idea `Explored`, saves durable record, loads `ce-brainstorm` with idea as seed.

#### ce-brainstorm (`skills/ce-brainstorm/SKILL.md:1-207`)

**Purpose**: Between ideate and plan. Answers "What exactly should one chosen idea mean?"

**Triggers**: "let's brainstorm", "what should we build", "help me think through X"

**Phase structure**:
- **Phase 0 Resume, Assess, Route**: checks `docs/brainstorms/` for `*-requirements.md`. Scope: Lightweight/Standard/Deep; Deep further split Deep-feature vs Deep-product (lines 93-98). Non-software routes to `references/universal-brainstorming.md`.
- **Phase 1.1 Existing Context Scan**: Checks `AGENTS.md` for constraints. Verifies infrastructure claims against codebase before asserting absence (line 116). Optional `ce-slack-researcher` (opt-in).
- **Phase 1.2 Product Pressure Test**: Lightweight = 3 questions; Standard adds "what if we do nothing?"; Deep adds 6-12 month capability framing; Deep-product adds sharpest user outcome, adjacent-product rejection, failure conditions (lines 130-153).
- **Phase 1.3 Collaborative Dialogue**: One question at a time. Prefers single-select. Asks user's thinking first before offering ideas.
- **Phase 2 Explore Approaches**: 2-3 concrete approaches. At least one non-obvious angle. Present all options before recommending.
- **Phase 3 Requirements Capture**: Loads `references/requirements-capture.md` for template.
- **Phase 4 Handoff**: Loads `references/handoff.md`.

**Output** (`references/requirements-capture.md:1-216`): `docs/brainstorms/YYYY-MM-DD-<topic>-requirements.md` with YAML frontmatter (`date`, `topic`). Stable IDs: **R-IDs** (requirements), **A-IDs** (actors), **F-IDs** (flows), **AE-IDs** (acceptance examples). Finalization checklist at lines 185-201.

**Handoff** (`references/handoff.md:46-61`): Options — Plan with ce-plan (recommended), Agent review with ce-doc-review, Open in Proof HITL, Build with ce-work, More clarifying questions, Done for now. On "Plan": immediately loads `ce-plan` with requirements doc path.

#### ce-plan (`skills/ce-plan/SKILL.md:1-850`) — LONGEST SKILL IN PLUGIN

**Purpose**: After brainstorm. Answers "How should it be built?" Output feeds `ce-work`.

**Triggers**: "plan this", "create a plan", "write a tech plan", "plan the implementation", "plan a trip", "create a study plan"; `"deepen"` keyword triggers fast-path to Phase 5.3

**Phase structure**:
- **Phase 0.1 Resume** (`SKILL.md:69-79`): Checks `docs/plans/` for recent matches. "deepen" keyword fast-path.
- **Phase 0.2-0.3 Source Document** (`SKILL.md:103-115`): Searches `docs/brainstorms/` for `*-requirements.md`. If found, carries all R/A/F/AE IDs forward as constraints.
- **Phase 0.4 Planning Bootstrap** (`SKILL.md:119-143`): No requirements doc → establishes problem frame, behavior, scope, success criteria. Can route to `ce-debug` or `ce-work` if appropriate.
- **Phase 0.6 Classify Plan Depth** (`SKILL.md:160-166`): Lightweight / Standard / Deep.
- **Phase 1.1 Local Research** (`SKILL.md:177-189`, always parallel): `ce-repo-research-analyst` + `ce-learnings-researcher`; optional `ce-slack-researcher`.
- **Phase 1.1b Execution Posture** (`SKILL.md:193-204`): Detects TDD/characterization-first signals.
- **Phase 1.2-1.3 External Research Decision** (`SKILL.md:208-248`): Leans toward external when high-risk, thin local patterns. Parallel: `ce-best-practices-researcher` + `ce-framework-docs-researcher`.
- **Phase 1.4b Depth Reclassification** (`SKILL.md:262-270`): Lightweight → Standard when external contracts detected.
- **Phase 1.5 Flow Analysis** (`SKILL.md:275-281`, Standard/Deep conditional): `ce-spec-flow-analyzer`.
- **Phase 2 Resolve Planning Questions** (`SKILL.md:285-296`): Build question list; defer implementation-time questions.
- **Phase 3 Structure Plan**: Filename format `docs/plans/YYYY-MM-DD-NNN-<type>-<descriptive-name>-plan.md`. **Implementation units carry stable U-IDs** (U1, U2…) never renumbered (`SKILL.md:331`). Optional High-Level Technical Design section (3.4): pseudo-code, mermaid, data flow, state diagram.
- **Phase 4 Write Plan** (`SKILL.md:456-669`): YAML frontmatter with `title`, `type`, `status: active`, `date`, optional `origin`/`deepened`. Each Implementation Unit has: Goal, Requirements, Dependencies, Files, Approach, Test scenarios (categorized: happy path, edge cases, error paths, integration), Verification.
- **Phase 5.1 Review Before Writing**: No code invented, U-IDs unique and stable, visual aids warranted.
- **Phase 5.2 Write Plan File**: REQUIRED before interactive options.
- **Phase 5.3 Confidence Check**: Auto mode (default) or Interactive. Loads `references/deepening-workflow.md` when deepening warranted.
- **Phase 5.3.8 onwards**: Loads `references/plan-handoff.md` (mandatory).

**Deepening workflow** (`references/deepening-workflow.md:1-250`):
- **Section-level confidence scoring**: trigger count + risk bonus + critical-section bonus. Selects top 2-5 sections (lines 14-19).
- **Deterministic section→agent mapping** (lines 99-139): Requirements Trace → `ce-spec-flow-analyzer`; Key Technical Decisions → `ce-architecture-strategist`; System-Wide Impact → `ce-architecture-strategist` + specialists (`ce-security-sentinel`, `ce-data-integrity-guardian`, `ce-performance-oracle`).
- **Two execution modes**: direct (default) vs artifact-backed when >5 agents (lines 155-170). Artifact-backed uses `mktemp -d -t ce-plan-deepen-XXXXXX`.
- **Interactive re-deepen** (lines 200-219): agent findings presented one-by-one, user accepts/rejects/discusses before integration.
- **Phase 5.3.7 synthesis** (lines 222-250): Allowed to clarify rationale, tighten trace, reorder/split units (U-IDs preserved), expand risk — never add implementation code.

**Plan handoff** (`references/plan-handoff.md:1-95`):
- **Phase 5.3.8**: MANDATORY `ce-doc-review` run after confidence check (lines 7-17).
- **Phase 5.4 menu** (lines 38-44): Start /ce-work, Create Issue, Open in Proof (HITL), Done for now.
- **Issue creation** (lines 70-94): reads `AGENTS.md` for `project_tracker: github` or `project_tracker: linear`; runs `gh issue create` or Linear MCP.

#### ce-proof (`skills/ce-proof/SKILL.md:1-316` + `references/hitl-review.md:1-369`)

**Purpose**: HITL (human-in-the-loop) document review via proofeditor.ai.

**Triggers**: "view this in proof", "share to proof", "HITL this doc", handoffs from brainstorm/ideate/plan

**HITL mechanics** (`references/hitl-review.md`):
- **Phase 1 Upload and Wait** (lines 34-55): POSTs markdown to `https://www.proofeditor.ai/share/markdown` for `slug`, `accessToken`, `tokenUrl`. Posts presence binding display name "Compound Engineering" to agent ID `ai:compound-engineering`. Blocking question: "I'm done with feedback" or "I have no feedback".
- **Phase 2 Ingest Pass** (lines 68-148, idempotent no cache): Reads fresh `/state` for `markdown`, `revision`, `marks`, `mutationBase.token`. Filters marks: authored by `human:*`, unresolved, no prior `ai:*` reply or has new human reply after last agent reply. Decision logic: auto-apply imperatives, answer questions, evaluate disagreements. Parallelizes `comment.reply` and `comment.resolve`. Default mutation: `suggestion.add` with `status: "accepted"` (creates tracked suggestion AND commits in one call).
- **Phase 3 Terminal Report** (lines 176-190): Exception-based — what got handled, open threads, doc URL.
- **Phase 4 Next-Signal**: Discuss / Save / Re-check / Pause.
- **Phase 5 End-Sync** (lines 224-280): Atomic write via `jq -jr '.markdown' "$STATE_TMP" > "$TMP" && mv "$TMP" "$SOURCE"`. Returns `{ status, localPath, localSynced, docUrl, openThreadCount, revision }`.

---

### Work Mode Workflow

#### ce-work (`skills/ce-work/SKILL.md:1-301` + references)

**Purpose**: Core implementation execution. Reads a plan file and executes units.

**Phase structure**:
- **Phase 0 Triage** (lines 23-42): plan-file vs bare prompt; complexity routing table (Trivial/Small/Large).
- **Phase 1 Quick Start** (lines 46-170): read plan, branch setup, task list creation, execution strategy selection.
- **Phase 2 Execution Loop** (lines 172-299, `while tasks remain` at 178-191): Test Discovery, System-Wide Test Check, incremental commits.
- **Phase 3-4** (line 301): Loads `references/shipping-workflow.md`.

**Subagent strategies** (lines 130-170):
- **Inline** (1-2 tasks)
- **Serial subagents** (3+ with dependencies)
- **Parallel subagents** (3+ that pass safety check)
- **Parallel Safety Check**: file-to-unit intersection check; any overlap downgrades to serial
- **Parallel constraint**: subagents must NOT stage, commit, or run full test suite — orchestrator owns that
- Omits `mode` parameter on dispatch (line 155)

**Shipping workflow** (`references/shipping-workflow.md`):
- **Phase 3** (lines 7-65):
  1. Run full test suite + linting
  2. **Code Review gate** (Tier 2 `ce-code-review mode:autofix` default)
  3. **Residual Work Gate** (lines 31-45): blocking user question — Apply/fix now, File tickets via tracker, Accept and proceed, Stop
  4. Final Validation checklist
  5. Post-Deploy Monitoring (REQUIRED in every PR)
- **Phase 4** (lines 67-99): Evidence context decision → plan `status: active` → `completed` → load `ce-commit-push-pr` (or `ce-commit` if no PR desired) → user notification with PR link.

**Tracker-defer** (`references/tracker-defer.md:1-150`):
- Two modes: Interactive (ce-code-review walk-through, user-facing) and Non-interactive (lfg, silent fallback)
- **Detection** (lines 33-48): reads `CLAUDE.md`/`AGENTS.md` for tracker; produces `{ tracker_name, confidence, named_sink_available, any_sink_available }`
- **Fallback chain** (lines 80-86): Named tracker → GitHub Issues via `gh` → No sink
- **Ticket composition**: reads `why_it_matters` from reviewer artifact at `.context/compound-engineering/ce-code-review/<run-id>/{reviewer}.json`; fingerprinted by `normalize(file) + line_bucket(line, ±3) + normalize(title)`

#### ce-work-beta (`skills/ce-work-beta/SKILL.md`) — adds Codex delegation

Key additions vs. ce-work:
| Feature | ce-work | ce-work-beta |
|---|---|---|
| `disable-model-invocation` | absent | `true` (line 5) |
| Codex delegation | absent | Full delegation routing gate (line 182) |
| Argument parsing | none | `delegate:codex` / `delegate:local` tokens |
| Config resolution | none | `.compound-engineering/config.local.yaml` |
| Phase 2 loop | direct | branches on `delegation_active` |
| Frontend design step | absent | Step 7 `ce-frontend-design` for UI tasks |

**Codex delegation workflow** (`references/codex-delegation-workflow.md`):
- **Pre-delegation checks** (lines 32-86): Platform Gate (Claude Code only), Environment Guard (not inside Codex sandbox), Availability Check (`command -v codex`), one-time Consent Flow
- **Batching** (line 90): all units in one batch; split at phase boundaries in groups of ~5 if >5 units; never split units sharing files
- **Execution loop** (lines 202-315): launch `codex exec` with `run_in_background: true`; poll result file every 10s, max 5 rounds (~5 min); result JSON at `<scratch-dir>/result-batch-<n>.json`; circuit breaker after 3 consecutive failures
- **Rollback**: `git checkout -- .` + `git clean -fd -- <batch-file-paths>` on failure

#### lfg — Let's F***ing Go (`skills/lfg/SKILL.md:1-58`)

**Full autonomous pipeline.** `disable-model-invocation: true` — user must invoke manually.

Sequential non-interactive pipeline (8 steps, lines 12-58):
1. Optional: invoke `ralph-loop` if available
2. Invoke `ce-plan` — **GATE**: must produce plan file in `docs/plans/`
3. Invoke `ce-work` — **GATE**: must verify code changes
4. Invoke `ce-code-review mode:autofix plan:<path>`
5. Persist autofixes: `git add`/`commit`/`push`
6. Autonomous residual handoff (lines 30-54): `tracker-defer.md` non-interactive → `gh pr edit` or fallback file at `docs/residual-review-findings/<branch-or-sha>.md`
7. Invoke `ce-test-browser`
8. Output `<promise>DONE</promise>`

Never prompts user; all decisions autonomous.

#### ce-worktree (`skills/ce-worktree/SKILL.md`)

Creates worktree at `.worktrees/<branch>` via `bash scripts/worktree-manager.sh create <branch-name> [from-branch]`. Copies `.env*` files (excluding `.env.example`). Base branches (main, develop, staging, release/*) auto-trust unchanged configs. Offered as option by `ce-work` and `ce-code-review`.

#### ce-polish-beta (`skills/ce-polish-beta/SKILL.md`)

Visual iteration mode. `disable-model-invocation: true`.
- **Phase 1**: Branch setup
- **Phase 2 Dev server startup** (lines 22-41): Reads `.claude/launch.json`, then runs `scripts/detect-project-type.sh`; routes to per-framework reference (astro/next/nuxt/procfile/rails/remix/sveltekit/vite)
- **Phase 3**: Pure conversational iteration — user describes what to fix, agent makes changes, hot reload happens; no checklist; user says "done" → commit and stop

#### ce-debug (`skills/ce-debug/SKILL.md`)

Four phases:
- **Triage**: parse input, fetch issue if tracker-referenced
- **Investigate**: reproduce, verify env, trace code path
- **Root Cause**: assumption audit, hypotheses with predictions, **causal chain gate** before any fix
- **Fix**: test-first — failing test → minimal fix → regression run
- **Handoff**: structured summary, blocking question: Fix now / Diagnosis only / Brainstorm

Differs from ce-work: one change at a time, explicit causal chain gate, no parallel subagent dispatch for implementation (parallel only for read-only investigation).

---

### Shipping Workflow

#### ce-commit (`skills/ce-commit/SKILL.md:1-103`)
Standalone commit. Detects conventions from recent history. Logical split (file-level, max 2-3 commits). Warns if on default branch.

#### ce-commit-push-pr (`skills/ce-commit-push-pr/SKILL.md:1-245`)
Full pipeline — commit → push (`git push -u origin HEAD`) → generate description via `ce-pr-description` → `gh pr create`. Handles description-only update mode; evidence decision before delegation; existing PR path asks whether to rewrite description.

#### ce-pr-description (`skills/ce-pr-description/SKILL.md:1-401`)
Pure description generator; returns `{ title, body_file }` — never calls `gh pr edit`/`gh pr create`. 9-step process: resolve diff → classify commits → evidence decision → narrative frame → size change → apply writing principles → compose title → compose body → write to OS temp file. Generates Compound Engineering badge with HARNESS/MODEL_SLUG substitutions (lines 328-346).

#### ce-resolve-pr-feedback (`skills/ce-resolve-pr-feedback/SKILL.md`)
Two modes: Full (all unresolved threads) / Targeted (single thread URL).

Full mode loop (lines 34-309): fetch via `scripts/get-pr-comments` GraphQL → triage → **cross-invocation cluster analysis** (gated on signal + spatial overlap) → task list → parallel dispatch of `ce-pr-comment-resolver` agents (max 4 per batch) → combined validation → commit/push → reply/resolve via `scripts/reply-to-pr-thread` and `scripts/resolve-pr-thread` → verify → summary.

Verdicts: `fixed`, `fixed-differently`, `replied`, `not-addressing`, `needs-human`. Max 2 fix-verify cycles.

---

### Review Workflows

#### ce-code-review (`skills/ce-code-review/SKILL.md` + ~10 reference docs)

**Four modes**:
- `mode:interactive` (default)
- `mode:autofix` — no prompts, applies only `safe_auto -> review-fixer`
- `mode:report-only` — strictly read-only, no artifacts, no tickets
- `mode:headless` — CI mode, structured text envelope, single `safe_auto` pass, returns "Review complete"

**Persona catalog** (`references/persona-catalog.md:1-69`) — **18 personas in 4 tiers**:

1. **Always-on (4 structured + 2 unstructured)**: `ce-correctness-reviewer`, `ce-testing-reviewer`, `ce-maintainability-reviewer`, `ce-project-standards-reviewer` (structured JSON); `ce-agent-native-reviewer` + `ce-learnings-researcher` (unstructured, synthesized separately)

2. **Cross-cutting conditional (8)**: `ce-security-reviewer`, `ce-performance-reviewer`, `ce-api-contract-reviewer`, `ce-data-migrations-reviewer`, `ce-reliability-reviewer`, `ce-adversarial-reviewer` (threshold: ≥50 changed non-test/lockfile lines OR high-risk domains), `ce-cli-readiness-reviewer`, `ce-previous-comments-reviewer` (PR-only)

3. **Stack-specific conditional (6)**: `ce-dhh-rails-reviewer`, `ce-kieran-rails-reviewer`, `ce-kieran-python-reviewer`, `ce-kieran-typescript-reviewer`, `ce-julik-frontend-races-reviewer`, `ce-swift-ios-reviewer`

4. **Migration conditional (2)**: `ce-schema-drift-detector`, `ce-deployment-verification-agent` (only when diff contains migration files)

**Model inheritance** (`SKILL.md:399-468`): correctness + security + adversarial inherit session model; all others at `model: "sonnet"`; orchestrator inherits session model.

**Subagent template** (`references/subagent-template.md:1-180`): **two-tier return**. Artifact file at `.context/compound-engineering/ce-code-review/{run_id}/{reviewer_name}.json` holds full fields. Compact return to orchestrator omits detail fields.

**Validator / Judge (Stage 5b)** (`references/validator-template.md:1-86`, `SKILL.md:515-553`): **Two-pass mechanism**. After Stage 5 merge/dedup, one independent validator sub-agent per surviving finding (capped at 15). Fresh-context, no commitment to persona's verdict. Returns `{ "validated": true|false, "reason": "<one sentence>" }`. Validator rejections drop finding. Validator failures default to drop. Only runs in headless/autofix modes and Interactive LFG + file-tickets paths.

**Findings schema** (`references/findings-schema.json:1-139`):
- **5 discrete confidence anchors** — 0, 25, 50, 75, 100. Each has behavioral criterion:
  - 0/25: suppress silently (false positive / unverifiable)
  - 50: verified real but nitpick — soft buckets or P0 escape
  - 75: double-checked, will affect users — actionable
  - 100: verifiable from code alone — actionable
- **Severity P0-P3** (independent axis): P0=critical/blocks merge, P1=should fix, P2=fix if straightforward, P3=user discretion
- `autofix_class`: `safe_auto`, `gated_auto`, `manual`, `advisory`
- `owner`: `review-fixer`, `downstream-resolver`, `human`, `release`

**Stage 5 merge pipeline** (`SKILL.md:470-513`):
1. Validate compact JSON
2. Deduplicate by fingerprint `normalize(file) + line_bucket(line, ±3) + normalize(title)`
3. **Cross-reviewer promotion**: 2+ independent reviewers on same fingerprint → promote anchor one step (50→75, 75→100)
4. Separate `pre_existing: true` findings
5. Resolve routing disagreements (most conservative)
6. Normalize routing
6b. Tie-break `Skip > Defer > Apply > Acknowledge` (deterministic for LFG reproducibility)
6c. Mode-aware demotion (testing/maintainability P2-P3 advisory → soft buckets)
7. Confidence gate: suppress below anchor 75 (P0 at 50+ escapes)
8. Partition: fixer queue / residual / report-only
9. Sort by severity → anchor → file → line
10. Collect coverage (residual_risks, testing_gaps union)

**Bulk-preview** (`references/bulk-preview.md`): Fires before every bulk action (routing B/LFG, C/file-tickets, walk-through LFG-the-rest). Shows grouped preview by action bucket.

**Walkthrough** (`references/walkthrough.md:1-247`): Per-finding loop in P0→P3 order. Each finding presented with severity/file:line/What's wrong/Proposed fix/Why it works. 4-option blocking question: `Apply`, `Defer — file a [TRACKER] ticket`, `Skip`, `LFG the rest`. `(recommended)` label marks tie-break.

**Plan review embedded** (`SKILL.md:342-356`, `SKILL.md:561-563`): **Not a separate skill** — Stage 2b "Requirements Completeness". Discovery priority: (1) `plan:` argument, (2) PR body scan for `docs/plans/*.md`, (3) keyword from branch name. Confidence: `explicit` or `inferred`. Stage 6 renders Requirements Completeness: unaddressed requirements from `explicit` plan → P1 findings; from `inferred` plan → P3 advisory. Missing requirements in `explicit` plan → verdict "Not ready" even if code clean.

#### ce-doc-review (`skills/ce-doc-review/SKILL.md` + references)

Reviews requirements or plan documents using parallel persona agents.

**Two modes**: interactive (default), `mode:headless`.

**Persona catalog** (`SKILL.md:40-121`) — **7 personas**:
- Always-on (2): `ce-coherence-reviewer`, `ce-feasibility-reviewer`
- Conditional (5, content-signal based): `product-lens`, `design-lens`, `security-lens`, `scope-guardian`, `adversarial`

Max 7 agents in parallel. Dispatch uses full document (not split). Each receives `{decision_primer}` — cumulative prior-round decision record for multi-pass sessions.

**Doc findings schema** (`references/findings-schema.json:1-85`):
- `section` field (not file/line)
- `finding_type`: `error` (contradiction) or `omission` (missing) — no `advisory` type
- No `owner` or `requires_verification`
- `deferred_questions` array instead of `testing_gaps`
- `autofix_class` 3 values: `safe_auto`, `gated_auto`, `manual` (no `advisory`)

**Synthesis pipeline** (`references/synthesis-and-presentation.md:1-407`):
- **3.3b Same-persona premise redundancy collapse**: ≥3 findings from one persona sharing root premise → keep strongest, demote others to FYI
- **3.5c Premise-dependency chain linking**: P0/P1 manual findings in framing sections = roots; dependents annotated with `depends_on`. Walk-through cascades root decision to dependents.
- **3.6 Promote auto-eligible**: `manual` findings may be promoted to `safe_auto`/`gated_auto` when codebase-pattern-resolved, factually incorrect, or mechanically implied
- Safe_auto fixes at anchor 100 applied directly to document in Phase 4 via platform edit tool (no separate fixer subagent)

**Routing options**: A (per-finding), B (LFG), C (Append-to-Open-Questions batch), D (Report only). **Option C** appends all findings to `## Deferred / Open Questions` section.

**Open Questions Defer** (`references/open-questions-defer.md:1-178`): Appends to `## Deferred / Open Questions` with timestamped subsections `### From YYYY-MM-DD review`. HTML comment dedup-key `<!-- dedup-key: section="..." title="..." evidence="..." -->`. Re-reads document before each append for concurrent safety.

---

### Agent Architecture

**49 agents** discoverable in `agents/`, grouped in README by role:

**Review (28)**: `ce-adversarial-reviewer`, `ce-agent-native-reviewer`, `ce-api-contract-reviewer`, `ce-architecture-strategist`, `ce-cli-agent-readiness-reviewer`, `ce-cli-readiness-reviewer`, `ce-code-simplicity-reviewer`, `ce-correctness-reviewer`, `ce-data-integrity-guardian`, `ce-data-migration-expert`, `ce-data-migrations-reviewer`, `ce-deployment-verification-agent`, `ce-dhh-rails-reviewer`, `ce-julik-frontend-races-reviewer`, `ce-kieran-rails-reviewer`, `ce-kieran-python-reviewer`, `ce-kieran-typescript-reviewer`, `ce-maintainability-reviewer`, `ce-pattern-recognition-specialist`, `ce-performance-oracle`, `ce-performance-reviewer`, `ce-reliability-reviewer`, `ce-schema-drift-detector`, `ce-security-reviewer`, `ce-security-sentinel`, `ce-swift-ios-reviewer`, `ce-testing-reviewer`, `ce-project-standards-reviewer`

**Document Review (7)**: `ce-adversarial-document-reviewer`, `ce-coherence-reviewer`, `ce-design-lens-reviewer`, `ce-feasibility-reviewer`, `ce-product-lens-reviewer`, `ce-scope-guardian-reviewer`, `ce-security-lens-reviewer`

**Research (9)**: `ce-best-practices-researcher`, `ce-framework-docs-researcher`, `ce-git-history-analyzer`, `ce-issue-intelligence-analyst`, `ce-learnings-researcher`, `ce-repo-research-analyst`, `ce-session-historian`, `ce-slack-researcher`, `ce-web-researcher`

**Design (3)**: `ce-design-implementation-reviewer`, `ce-design-iterator`, `ce-figma-design-sync`

**Workflow (2)**: `ce-pr-comment-resolver`, `ce-spec-flow-analyzer`

**Docs (1)**: `ce-ankane-readme-writer`

**Agent file pattern** (e.g., `agents/ce-adversarial-reviewer.agent.md:1-112`):
```yaml
---
name: ce-adversarial-reviewer
description: <one-line trigger description>
model: inherit       # or haiku, sonnet
tools: Read, Grep, Glob, Bash
color: red           # optional, UI hint
---
```
Body: Identity, Depth calibration, Analysis techniques, Confidence calibration (persona-specific 0/25/50/75/100 interpretations), Explicit suppress conditions ("What you don't flag"), Output format stub.

---

### Compound Learning Loop

#### ce-compound (`skills/ce-compound/SKILL.md`)

**Full mode (default)** — 4 phases:

- **Phase 0.5 Auto Memory Scan** (lines 74-89): Checks system prompt for `MEMORY.md` block; passes relevant entries to Phase 1 subagents as evidence tagged `(auto memory [claude])`
- **Phase 1 Research** (lines 96-189): Launches **3 parallel background subagents + 1 foreground**:
  - `Context Analyzer` — reads conversation + `references/schema.yaml`, classifies track (bug vs knowledge), produces frontmatter skeleton
  - `Solution Extractor` — extracts problem/symptoms/root cause/solution/prevention
  - `Related Docs Finder` — grep-first `docs/solutions/` search, scores overlap across 5 dimensions (problem, root cause, solution, files, prevention) as High/Moderate/Low
  - `ce-session-historian` (optional, user-consented, foreground) — searches `~/.claude/projects/`, `~/.codex/sessions/`, `~/.cursor/projects/`
- **Phase 2 Assembly & Write** (lines 194-225): Orchestrator (not subagents) assembles, validates YAML, writes `docs/solutions/[category]/[filename].md`
- **Phase 2.5 Selective Refresh** (lines 229-269): Conditionally invokes `ce-compound-refresh` with narrow scope
- **Discoverability Check** (lines 277-307): Reads AGENTS.md/CLAUDE.md; if knowledge store not surfaced, proposes smallest addition; asks user consent
- **Phase 3 Optional Enhancement** (lines 312-326): Based on `problem_type`, auto-triggers specialists (`ce-performance-oracle`, `ce-security-sentinel`, `ce-data-integrity-guardian`) plus stack-appropriate reviewers

**Auto-invoke triggers** (line 499): "that worked", "it's fixed", "working now", "problem solved"

**YAML schema** (`references/schema.yaml`):

**Bug track**: problem_types = `build_error`, `test_failure`, `runtime_error`, `performance_issue`, `database_issue`, `security_issue`, `ui_bug`, `integration_issue`, `logic_error`. Required: `symptoms` (1-5 array), `root_cause` (17 enum values), `resolution_type` (10 enum values).

**Knowledge track**: problem_types = `best_practice`, `documentation_gap`, `workflow_issue`, `developer_experience`, `architecture_pattern`, `design_pattern`, `tooling_decision`, `convention`. Bug-track fields all optional.

Both require: `module`, `date` (YYYY-MM-DD), `problem_type`, `component` (17 enum values), `severity` (critical/high/medium/low). YAML safety: items starting with `` ` [ * & ! | > % @ ? `` must be double-quoted.

#### ce-compound-refresh (`skills/ce-compound-refresh/SKILL.md`)

Maintains `docs/solutions/` over time. 5 phases:
- **Mode Detection** (lines 1-26): `mode:autofix` skips questions
- **Phase 0 Assess and Route**: Focused (1-2 files) / Batch (up to 8) / Broad (9+). Broad does lightweight triage: inventory frontmatter, cluster by module/component
- **Phase 1 Investigate**: Checks references, solutions, code examples, auto-memory block, overlap. Update (cosmetic drift) vs Replace (substantive drift)
- **Phase 1.5**: Pattern docs under `docs/solutions/patterns/`
- **Phase 1.75 Document-Set Analysis**: 5-dimension overlap, supersession signals, Retrieval-Value Test for consolidation decision
- **Phase 2 Classify**: Keep / Update / Consolidate / Replace / Delete
- **Phase 3 Ask** (interactive only)
- **Phase 4 Execute**: Replace subagents run **sequentially** (not parallel) to avoid context exhaustion
- **Phase 5 Commit**: Detects current branch; offers branch+PR or direct commit

---

### Session / Audit / Admin Skills

#### ce-sessions / ce-session-inventory / ce-session-extract

**Pattern**: Internal agent primitives with `user-invocable: false`, `context: fork`. Operate on platform-specific JSONL session files outside working dir. All platform knowledge encapsulated in scripts.

- `ce-sessions` (user-facing, `:1-34`): Thin dispatcher for `ce-session-historian`
- `ce-session-inventory` (`SKILL.md:1-59`, internal): `<repo> <days> [platform]` args → `bash scripts/discover-sessions.sh | python3 scripts/extract-metadata.py` → JSONL. Claude adds `branch`/`last_ts`; Codex adds `cwd`/`source`/`cli_version`/`model`; Cursor derives `ts` from mtime. Ends with `_meta` line. Callers parse JSONL directly — never paraphrase.
- `ce-session-extract` (`SKILL.md:1-65`, internal): `<file> <mode> [limit]`. Modes: `skeleton` (narrative + collapsed tool-call summaries) / `errors`. Prevents agents loading multi-megabyte session files into context.

#### ce-agent-native-audit (`skills/ce-agent-native-audit/SKILL.md:1-279`)

`disable-model-invocation: true`. Audits codebase against 8 agent-native architecture principles:
1. Action Parity — whatever user can do, agent can do
2. Tools as Primitives — tools provide capability, not behavior
3. Context Injection — system prompt includes dynamic app state
4. Shared Workspace — agent and user work in same data space
5. CRUD Completeness — every entity has full CRUD
6. UI Integration — agent actions immediately reflected in UI
7. Capability Discovery — users can discover agent capabilities
8. Prompt-Native Features — features are prompts defining outcomes

Launches **8 parallel Explore-type sub-agents** (`Agent` with `subagent_type: Explore` in Claude Code; `spawn_agent agent_type: "explorer"` in Codex). Each returns X/Y score. Orchestrator compiles summary: ≥80% excellent, 50-79% partial, <50% needs work.

#### ce-setup (`skills/ce-setup/SKILL.md:1-165`)

`disable-model-invocation: true`. Diagnoses environment, installs missing tools, bootstraps `.compound-engineering/config.local.yaml`.

#### ce-report-bug, ce-update

- `ce-report-bug`: Structured info → `gh` issue against `EveryInc/compound-engineering-plugin`
- `ce-update` (Claude Code only): Parses installed version path; `gh release list`; recommends `claude plugin update`

---

## Flywheel Plugin

### Agent Roster (15 total)

**Reviewers (6)**: `reviewer-architecture`, `reviewer-code-quality`, `reviewer-data-integrity`, `reviewer-patterns`, `reviewer-performance`, `reviewer-elegance`

**Research Locators (4, haiku model, NO Read tool)**: `locator-codebase` (Grep, Glob), `locator-patterns` (Grep, Glob), `locator-docs` (Grep, Glob), `locator-web` (WebSearch)

**Research Analyzers (5, sonnet model, documentarian mode)**: `analyzer-codebase` (Read, Grep, Glob), `analyzer-patterns`, `analyzer-docs`, `analyzer-web` (WebFetch, Read), `analyzer-git-history` (Bash, Read, Grep, Glob)

### flywheel-conventions (`skills/flywheel-conventions/SKILL.md`)

`user-invocable: false`. Shared rules for all subagents:
- **Tool discipline** (lines 9-16): Grep for content search, Glob for file search, Read for file reading; Bash only for git/bun/system ops
- **Output limits** (lines 20-21): Locators 500 words, Analyzers 1500 words, Reviewers 1500 words
- **Output format** (lines 22-26): Structured sections, paths only, `OPEN QUESTION:` for ambiguities, `path/file.ts:42-67` references
- **Severity**: P1 blocks deploy/security/data loss; P2 fix before merge; P3 suggestion
- **Research agent behavior** (lines 30-33): Documentarian mode; Read files without limit/offset
- **Dispatch** (lines 37-62): Locators parallel first; top 15 findings fed to analyzers; implementation subagents (`general-purpose`, `Explore`, `Plan`) inherit parent model — never set `model` explicitly; only research agents use explicit model
- **3-Strike error protocol** (lines 65-70): (1) Diagnose, (2) Alternative approach, (3) Rethink assumptions, (4) Escalate

### Slash Commands

All 8 commands in `commands/fly/` follow identical pattern: YAML frontmatter + MANDATORY FIRST ACTION instruction + `$ARGUMENTS` + brief summary.

| Command | Skill invoked |
|---|---|
| `/fly:plan` (`plan.md:21-28`) | `plan-creation` (or `plan-review` for existing plan) |
| `/fly:work` (`work.md:13-17`) | `work-implementation` |
| `/fly:review` (`review.md:11-17`) | `work-review` |
| `/fly:brainstorm` (`brainstorm.md:11-13`) | `brainstorm` |
| `/fly:research` (`research.md:11-15`) | `codebase-research` |
| `/fly:debug` (`debug.md:11-13`) | `debug` |
| `/fly:compound` (`compound.md:11-13`) | `compound` |
| `/fly:ship` (`ship.md:11-13`) | `ship` |

**`/fly:plan` orchestrates a 3-skill sequence** (`plan.md:49-64`): `plan-creation → plan-review → plan-consolidation`. Passes `PLAN_PATH` + `CONTEXT_PATH`. Branches to skip creation if input is an existing plan file.

---

### Planning Workflow

#### codebase-research (`skills/codebase-research/SKILL.md:1-142`)

Dedicated research skill producing persistent documents.

**Triggers**: "research", "investigate", "explore codebase"

**Phases**:
- **Phase 0** (lines 36-49): `find docs/research -name "*<topic-slug>*" -mtime -14` for existing research. AskUserQuestion: Reuse / Refresh / Start new
- **Phase 1** (lines 54-60): **4 locators in parallel** (haiku) — `locator-codebase`, `locator-patterns`, `locator-docs`, `locator-web`. Single message, multiple Task calls.
- **Phase 1b** (lines 62-69): Deduplicate, rank by multi-locator hits. Selection caps: 15 paths for analyzer-codebase, 10 for analyzer-patterns, 5 for analyzer-docs, 10 URLs for analyzer-web
- **Phase 2** (lines 74-82): Analyzers in parallel (sonnet). Documentarian mode.
- **Phase 3** (lines 86-90): Write to `docs/research/YYYY-MM-DD-<topic-slug>.md` with YAML frontmatter (`date`, `topic`, `status`, `tags`). Optional git-commit.
- **Phase 4** (lines 94-98): Summary + AskUserQuestion: create plan / continue / done

**Context budget** (lines 113-116): If >30 locator results, consolidate before Phase 2. After Phase 2, write immediately.
**2-Action Rule** (lines 119-127): After 2 visual ops (WebFetch, browser, image), immediately persist as text.

#### brainstorm (`skills/brainstorm/SKILL.md:1-185`)

**Triggers**: "explore", "brainstorm", "think about"

**Phases**:
- **Phase 1** (lines 48-52): Silent research — 4 locators in parallel including `locator-web`. NOT shown to user; informs smarter questions
- **Phase 1.5** (lines 57-62): Research Review checkpoint. AskUserQuestion: approve / add focus / redirect. Max 2 re-research cycles
- **Phase 2** (lines 67-86): **One question at a time** via AskUserQuestion. **5-question sequence**: core problem → audience → success → constraints → scope. Prefers multiple choice
- **Phase 2.5** (lines 96-99): Past solutions lookup — `grep -l "<keyword>" docs/solutions/**/*.md`. Top 3-5 matches if found
- **Phase 3** (lines 103-108): Always present **2-3 approaches** with tradeoffs table, when-to-choose, S/M/L effort. User selects via AskUserQuestion
- **Phase 4** (lines 113-118): Incremental design validation — 200-300 words per section. Fixed order: Overview → User flows → Architecture → Data model → Error handling → Success criteria. Confirm after each
- **Phase 5** (lines 128-130): Write `docs/plans/<topic>-design.md`
- **Phase 5b** (lines 135-138): Design iteration — 5-step procedure. Max 3 cycles
- **Handoff** (lines 143-147): AskUserQuestion — `/fly:plan`, `/fly:work`, continue, done

**Context management** (lines 150-155): Warnings if >3 research cycles, >5 questions, >3 iteration cycles. If context >40%, write state and offer fresh continue.

**Output frontmatter**: `created`, `status: validated`, `type: design`, `brainstorm_session: true`

#### plan-creation (`skills/plan-creation/SKILL.md:1-227`)

**Triggers**: "create plan", "plan for", "write a plan"

**Phases**:
- **Phase 0** (lines 30-43): Existing knowledge check — `docs/standards/` (by tags), `docs/solutions/` (up to 5 matches), `docs/research/` (30-day `find -mtime -30`)
- **Phase 1** (lines 47-57): Locate-then-analyze. **3 locators in parallel** (`locator-codebase`, `locator-patterns`, `locator-docs` — note: no `locator-web`). **No direct Read/Grep/Glob on target codebase** — blocking constraint. Then `analyzer-codebase` with top 10-15 paths. Flags: `EXISTING_SOLUTION`, `PATTERN_CONFLICT`, `DRY_VIOLATION`, `INTEGRATION_RISK`
- **Phase 1.5** (lines 63-74): Research Validation Gate — 4-item checklist. Max 2 re-research attempts
- **Phase 2** (lines 79-94): External validation — keyword scan for high-risk topics (security, payments, crypto, migrations, privacy). **Context7 workflow**: resolve library ID → query docs → verify with code. Fallback to WebSearch. Flags `CLAIM_INVALID` or `VERSION_ISSUE`
- **Phase 3** (lines 98-116): Title → kebab-case filename. Template selection: MINIMAL (bugs/small) / MORE (most features) / A LOT (major/architectural)
- **Phase 4** (lines 120-143): Write plan — all sections with file:line references, test-first phase ordering, Single Responsibility per phase
- **Phase 5** (lines 148-153): Write context file to `<filename>.context.md` — key file paths, patterns, validation summary, gotchas
- **Phase 6** (lines 157-180): Plan Summary + AskUserQuestion (approve / adjust scope / change approach / add constraints). Max 2 revision cycles
- **Phase 7** (lines 184-191): AskUserQuestion — "Run review (Recommended)" invokes `skill: plan-review`, or "Done for now"

**Output artifacts**: `docs/plans/<filename>.md` + `docs/plans/<filename>.context.md`

#### plan-review (`skills/plan-review/SKILL.md:1-153`) — DEDICATED SKILL

**Triggers**: "review plan", "check plan"

**Phases**:
- **Phase 1** (lines 30-43): Discover ALL reviewers via bash — project-local, user-global, plugin cache. Known types: `reviewer-architecture`, `reviewer-code-quality`, `reviewer-patterns`, `reviewer-performance`, `reviewer-data-integrity`, `reviewer-elegance`. **No filtering by relevance**
- **Phase 2** (lines 49-73): **ALL discovered reviewers in SINGLE message with parallel Task calls**. Each prompt includes full plan content + explicit no-file-write constraint. Findings with P1/P2/P3 priority and `OPEN QUESTION:` markers
- **Phase 3** (lines 79-89): **Deduplication** — identical (same section + same issue) → merge with source count; similar → group under theme; unique → preserve standalone
- **Phase 4** (lines 94-105): **Conflict detection** — opposite recommendations, priority disagreements. Each conflict converted to Open Question: Context, Perspective A, Perspective B, Trade-off, Options A/B/C
- **Phase 5** (lines 110-118): **Append Review Summary to plan file (NON-OPTIONAL)**. Read plan → construct summary → write back. Verify with `grep -c "Plan Review Summary"`
- **Phase 6** (lines 122-126): AskUserQuestion — run consolidation / run specific agent deeper / done

Minimum success: 50% of agents must respond (line 130).

#### plan-consolidation (`skills/plan-consolidation/SKILL.md:1-153`)

**Triggers**: "consolidate plan", "finalize plan"

Input: Plan path via `$ARGUMENTS`; must already have Plan Review Summary.

**Phases**:
- **Phase 1** (lines 28-32): Analyze structure
- **Phase 2** (lines 36-42): Extract findings into P1/P2/P3 categories and phases
- **Phase 3** (lines 46-67): Resolve Open Questions — scan for `OPEN QUESTION:`, `TODO`, `TBD`, "Option A vs Option B", "Conflicts Between Reviewers". Present one at a time with recommendation. Three response types: user picks / "You decide" → apply recommendation / custom
- **Phase 4** (lines 72-82): Synthesis — deduplicate, prioritize P1 first, preserve test-first ordering, integrate INTO checklist items
- **Phase 5** (lines 86-88): Generate from `references/consolidated-plan-template.md`
- **Phase 6** (lines 92-99): `cp [plan_path] [plan_path].pre-consolidation.backup`; overwrite; original in Appendix
- **Phase 7** (lines 103-114): Summary + AskUserQuestion — "Start /fly:work" or "Done for now"

**Output structure**: Status → Executive Summary → Decisions Made → Critical Items → Implementation Checklist → Technical Reference → Review Findings Summary → Appendix (raw review data in `<details>` block)

---

### Work Mode Workflow

#### work-implementation (`skills/work-implementation/SKILL.md`)

**Triggers** (line 3): "work on", "implement", "execute plan", "carry on", "continue"

**Allowed tools** (lines 4-16): Read, Write, Edit, Grep, Glob, Bash, Task, TaskCreate, TaskUpdate, TaskList, Skill, AskUserQuestion

**Phase 0 — Session Detection** (lines 36-44): Reads `.flywheel/session.md` first. If exists + no args → resume/details/start-fresh prompt. If exists + args → same plan resumes, different plan auto-switches silently. Validation in `references/session-detection.md`.

**Phase 1 — Load & Resume** (lines 47-58): Derives state file `${PLAN_PATH%.md}.state.md`. Creates **baseline snapshot** at `${PLAN_PATH%.md}.baseline.md` (used by work-review for plan compliance). Writes `.flywheel/session.md`. Loads `.context.md` + applicable standards from `docs/standards/`. Creates one native Task per plan phase (**dual-write with state file**).

**Phase 2 — Execute Per-Phase Loop** (lines 62-118):
- **Probe** (2.1): Quick check on referenced files; warn if >500 lines
- **Dispatch** (2.2): Spawns `general-purpose` Task subagent per phase. Passes full phase content inline. Must NOT set `model` parameter (line 71)
- **TDD Cycle** (2.2a): RED-GREEN-REFACTOR per task; skipped for pure refactoring, config-only, or docs
- **Checkpoint — Dual-Write** (2.3):
  1. TaskUpdate to completed
  2. Update state file with decisions/learnings/code context
  3. Verify TDD evidence and run tests
  4. Update session file timestamp and phase number
  5. Manual verification pause if plan has Manual Verification criteria
- **Ralph Mode Check** (2.4): Activates if >5 phases, `--ralph` flag, or context >50% with >2 phases remaining; writes detailed state and suggests context clear
- **Loop** (2.5): Continue to next unchecked phase

**Phase 3 — Quality Check** (lines 121-127): Verification gates from `references/verification-gates.md`. Two-stage review: Stage 1 = spec compliance, Stage 2 = code quality.

**Phase 4 — Complete** (lines 130-153): Present user with review or ship. On completion: marks state `completed`, removes `.flywheel/session.md` and baseline file.

**Recovery** (lines 155-160): "carry on" / no-arg `/fly:work` → session file identifies plan → checks TaskList + state file → resumes from first uncompleted phase.

#### State / Session / Baseline Files

**State file** (`references/state-file-template.md`): Path `docs/plans/<plan-name>.state.md`. YAML frontmatter: `plan`, `status` (in_progress/completed), `schema_version: 3` (lines 18-21). Progress markers: `[ ]` not started, `[x]` complete, `[~]` awaiting manual verification. Schema v3 adds Error Log table for 3-Strike tracking.

**Session file** (`references/session-file-template.md`): Path `.flywheel/session.md`. Only ONE active session at a time. Fields: `active_skill`, `plan_path`, `state_path`, `context_path`, `started`, `last_checkpoint`, `current_phase`, `total_phases`, `skip_manual_pauses`. `.flywheel/` gitignored.

**Baseline file** (`<plan>.baseline.md`): Snapshot at work-start. Used by work-review to compare "what was committed to" vs evolved current plan.

#### Ralph Mode (`references/ralph-mode.md`)

Named after Ralph Wiggum — "agent as stateless function". **Triggers** (lines 9-13): plan >5 phases OR `--ralph` flag OR context >50% with >2 phases remaining. On activation: writes exhaustive state including Current Working State section (last action, next action, open questions), then 2-option prompt: clear context (recommended) / continue without clearing.

State file MUST contain (lines 49-77): Progress with outcomes, Key Decisions with rationale, Learnings with file:line, Code Context, Current Working State.

#### Verification Gates (`references/verification-gates.md`)

**Pre-flight** (lines 7-17): 4 checks — problem understood, approach fits patterns, no duplicates, security considered.

**Verification protocol** (lines 21-28): IDENTIFY → RUN → READ → VERIFY → CLAIM WITH EVIDENCE — no claims without running commands.

**Banned phrases** (lines 30-37): "Done", "Fixed", "Complete", "Should work", "Probably", "Seems to", "Great!", "Perfect!", "Looks good!" without evidence.

**Two-stage review** (lines 58-78): Stage 1 = spec compliance first; only advance to Stage 2 (code quality) if Stage 1 passes.

---

### Review Workflow

#### work-review (`skills/work-review/SKILL.md`)

**Triggers** (line 3): "review", "code review", "check PR"

**Input** (lines 22-26): PR number, GitHub URL, branch name, or empty for current branch.

**Phase 1.0 — Plan Compliance** (lines 29-37): Checks for `docs/plans/*.state.md`. If found, compares implementation against **`.baseline.md` snapshot** (what was committed to, not evolved current plan). Significant deviations → P1.

**Phase 2 — Parallel Reviewer Agents** (lines 62-80): **ALL 6 agents run simultaneously**:
- `reviewer-architecture`, `reviewer-code-quality`, `reviewer-patterns`, `reviewer-performance`, `reviewer-data-integrity`, `reviewer-elegance`
- Conditional: `reviewer-data-integrity` also triggered when PR contains `**/migrations/**`, `alembic/`, or `prisma/migrations/`

**No filtering by diff content** — all reviewers fire unconditionally (differs from CE's persona catalog).

**Phase 3 — Synthesis** (lines 82-130): Collect, deduplicate, categorize. **Severity**: P1=BLOCKS MERGE, P2=should fix, P3=nice-to-have. P3 triage: present to user; only user-selected P3s enter implementation checklist; dropped P3s omitted entirely (not deferred). Convert findings to ordered implementation phases (P1 first, 2-4 steps per phase, each ends with verify step).

**Phase 4 — Persist** (lines 132-145): Write to `docs/reviews/YYYY-MM-DD-<target-slug>.md`. Slug patterns: `pr-{number}-{title-slug}`, branch slug, or `review-current-changes`.

**Phase 5 — Summary** (lines 149-165): Brief summary + invoke `work-implementation` on review file OR proceed to ship.

---

### Ship / Debug / Compound

#### ship (`skills/ship/SKILL.md`)

**Triggers** (line 3): "ship", "open pr", "send pr"

**Phases**:
- **Phase 1** (lines 30-40): Run git status/diff/log/branch in parallel
- **Phase 2** (lines 49-61): If on `main`/`master`/`develop`, generate branch `<type>/<short-description>`, confirm via AskUserQuestion, `git checkout -b`
- **Phase 3** (lines 63-76): Review `git diff`, group logically, stage with specific paths (**never `git add -A` or `git add .`**), commit in imperative mood
- **Phase 4** (lines 78-111): Push, analyze commits vs base, create PR via `gh pr create` with Summary + Changes. Under 70 chars title
- **Phase 5** (lines 113-126): **Invoke `compound` skill — "Do NOT skip this phase"**

**Hard rules** (lines 19-25): NEVER add Co-Authored-By or Claude attribution.

#### debug (`skills/debug/SKILL.md`)

**Triggers** (line 3): "debug", "fix this", "troubleshoot"

- **Phase 0** (lines 24-42): Parse problem from args or AskUserQuestion. Checks `.flywheel/session.md` — warns if active work session conflicts. Gets verification command. Runs baseline capture (last 2000 chars truncated)
- **Phase 1** (lines 49-82): **Inline investigation (no subagent dispatch)**. Reads error output, searches via Grep/Glob, checks recent git changes. Produces 2-3 ranked hypotheses with evidence and likelihood. Confirms direction via AskUserQuestion
- **Phase 2 — Fix Loop** (lines 84-119): **Max 10 iterations**. Each: (1) one minimum targeted fix, (2) verify, (3) evaluate, (4) track strikes per hypothesis. **3 strikes on a hypothesis → advance to next**. All exhausted → AskUserQuestion for new direction
- **Phase 3** (lines 139-164): Root cause summary, show `git diff`. Offer: commit+compound (invokes `/fly:ship` then `/fly:compound`) or done

#### compound (`skills/compound/SKILL.md`)

**Triggers**: "that worked", "it's fixed", "working now", "problem solved" or `/fly:compound`

- **Step 1** (lines 31-43): Detect non-trivial only. Additional categories: `pattern` → `docs/solutions/patterns/`, `mistake` → `docs/solutions/mistakes/`
- **Step 1.5** (lines 45-59): **3-Strike integration** — when invoked after 3-Strike escalation, captures all 3 failed attempts (sanitized), root cause, user-provided solution, prevention
- **Step 2** (lines 61-79): Extracts module, symptom, investigation, root cause, solution, prevention from conversation
- **Step 3** (lines 81-86): Search `docs/solutions/` for similar
- **Step 4** (lines 88-113): Sanitize (credentials, PII, internal URLs), validate YAML, create file in `docs/solutions/${CATEGORY}/`
- **Step 5** (lines 115-128): Optional specialized reviewer (reviewer-performance for perf, reviewer-data-integrity for DB)
- **Step 5.5** (lines 130-149): **Standards inference** — if 2+ solutions share same root_cause type, suggest creating standard in `docs/standards/`
- **Step 6**: Decision menu from `references/decision-menu.md`

**YAML schema** (`references/yaml-schema.md`): Required: module, date, problem_type (15 enum), component (18 enum), symptoms (1-5), root_cause (17 enum), resolution_type (10 enum), severity. 15 category directories mapped from problem_type.

**Decision menu** (`references/decision-menu.md`): 7 options after doc — (1) continue workflow, (2) add to Required Reading (formats as WRONG/CORRECT pattern in `docs/solutions/patterns/critical-patterns.md`), (3) link related issues, (4) add to existing skill, (5) create new skill, (6) view documentation, (7) other.

---

## Code References Summary

### Compound-Engineering key files

| File | Lines | Description |
|------|-------|-------------|
| `inspiration/compound-engineering/plugins/compound-engineering/skills/ce-plan/SKILL.md` | 1-850 | Planning orchestrator (longest skill) |
| `.../ce-plan/references/deepening-workflow.md` | 1-250 | Section-level confidence scoring + deterministic agent mapping |
| `.../ce-plan/references/plan-handoff.md` | 1-95 | Mandatory ce-doc-review; Phase 5.4 menu |
| `.../ce-brainstorm/SKILL.md` | 1-207 | Collaborative dialogue + requirements capture |
| `.../ce-brainstorm/references/requirements-capture.md` | 1-216 | R/A/F/AE ID schema |
| `.../ce-ideate/SKILL.md` | 1-269 | 6-frame divergent ideation |
| `.../ce-ideate/references/post-ideation-workflow.md` | 1-233 | Adversarial filtering → survivors |
| `.../ce-proof/references/hitl-review.md` | 1-369 | Proofeditor.ai integration |
| `.../ce-work/SKILL.md` | 1-301 | 4-phase work execution |
| `.../ce-work/references/shipping-workflow.md` | 1-99 | Code review gate + residual work gate |
| `.../ce-work-beta/references/codex-delegation-workflow.md` | 1-315 | Codex delegation with 5-min polling |
| `.../lfg/SKILL.md` | 1-58 | Full autonomous pipeline |
| `.../ce-code-review/SKILL.md` | 1-797 | 4-mode persona-based code review |
| `.../ce-code-review/references/persona-catalog.md` | 1-69 | 18-persona catalog in 4 tiers |
| `.../ce-code-review/references/findings-schema.json` | 1-139 | 5-anchor confidence + P0-P3 severity |
| `.../ce-code-review/references/validator-template.md` | 1-86 | Stage 5b independent re-verification |
| `.../ce-code-review/references/walkthrough.md` | 1-247 | Per-finding 4-option blocking flow |
| `.../ce-code-review/references/tracker-defer.md` | 1-150 | Linear/GitHub ticket creation |
| `.../ce-doc-review/SKILL.md` | 1-172 | 7-persona document review |
| `.../ce-doc-review/references/synthesis-and-presentation.md` | 1-407 | 9-step synthesis + chain linking |
| `.../ce-doc-review/references/open-questions-defer.md` | 1-178 | In-document append mechanic |
| `.../ce-compound/SKILL.md` | 1-530 | Bug + knowledge track learning |
| `.../ce-compound/references/schema.yaml` | full | Frontmatter contract |
| `.../ce-compound-refresh/SKILL.md` | 1-679 | Maintenance loop with 5 classification outcomes |
| `.../ce-agent-native-audit/SKILL.md` | 1-279 | 8-principle audit via 8 parallel Explore agents |
| `inspiration/compound-engineering/AGENTS.md` | 1-186 | Root contributor file |
| `.../plugins/compound-engineering/AGENTS.md` | 1-257 | Plugin-level skill compliance checklist |

### Flywheel key files

| File | Lines | Description |
|------|-------|-------------|
| `plugin/flywheel/.claude-plugin/plugin.json` | 1-25 | Manifest with context7 MCP |
| `plugin/flywheel/skills/codebase-research/SKILL.md` | 1-142 | 4-phase locate→analyze research |
| `plugin/flywheel/skills/brainstorm/SKILL.md` | 1-185 | 5-question dialog + 2-3 approach presentation |
| `plugin/flywheel/skills/plan-creation/SKILL.md` | 1-227 | 7-phase planning with Context7 validation |
| `plugin/flywheel/skills/plan-review/SKILL.md` | 1-153 | All-reviewers parallel dispatch + conflict → Open Question |
| `plugin/flywheel/skills/plan-consolidation/SKILL.md` | 1-153 | Merge findings into actionable checklist |
| `plugin/flywheel/skills/work-implementation/SKILL.md` | 1-160 | Session + state + baseline files, Ralph mode |
| `plugin/flywheel/skills/work-implementation/references/ralph-mode.md` | full | Stateless loop activation |
| `plugin/flywheel/skills/work-implementation/references/verification-gates.md` | 1-80 | IDENTIFY → RUN → READ → VERIFY protocol |
| `plugin/flywheel/skills/work-review/SKILL.md` | 1-165 | All 6 reviewers parallel, plan compliance via baseline |
| `plugin/flywheel/skills/ship/SKILL.md` | 1-126 | Branch → commit → PR → invoke compound |
| `plugin/flywheel/skills/debug/SKILL.md` | 1-164 | Inline investigation + 10-iter fix loop |
| `plugin/flywheel/skills/compound/SKILL.md` | full | Sanitize + YAML + standards inference |
| `plugin/flywheel/skills/flywheel-conventions/SKILL.md` | full | Shared subagent rules (tool discipline, severity, 3-strike) |
| `plugin/flywheel/commands/fly/plan.md` | 1-99 | Orchestrates plan-creation → plan-review → plan-consolidation |

---

## Patterns Identified

- **Two-tier review return** (CE): `ce-code-review/references/subagent-template.md:21-51` — full JSON to disk at `.context/compound-engineering/ce-code-review/{run_id}/{reviewer}.json`; compact return to orchestrator. Prevents orchestrator context bloat while preserving full detail for walk-through rendering.

- **Confidence-anchored scoring** (CE): `ce-code-review/references/findings-schema.json` — 5 discrete anchors (0/25/50/75/100) each with a behavioral criterion the reviewer self-applies. Severity and confidence are independent axes. Default suppress below 75, with P0 escape at 50.

- **Two-pass validation** (CE): `ce-code-review/SKILL.md:515-553` — Stage 5b spawns independent fresh-context validator per finding. Conservative bias (validator failures default to drop).

- **Persona catalog with threshold rules** (CE): `ce-code-review/references/persona-catalog.md` — 4-tier dispatch (always-on, cross-cutting, stack-specific, migration-conditional) with explicit thresholds (`ce-adversarial-reviewer` fires at ≥50 changed non-test/lockfile lines).

- **Tracker-defer with fingerprint dedup** (CE): `ce-code-review/references/tracker-defer.md` — `normalize(file) + line_bucket(line, ±3) + normalize(title)` fingerprint prevents duplicate tickets across retries. Fallback chain: named tracker → GitHub → no-sink.

- **HITL via Proof** (CE): `ce-proof/references/hitl-review.md` — idempotent ingest pass with no session cache; reads fresh `/state` every cycle; atomic end-sync via `jq` + `mv`.

- **Deepening workflow** (CE): `ce-plan/references/deepening-workflow.md` — section-level confidence scoring with deterministic section→agent mapping; interactive re-deepen mode presents agent findings one-by-one.

- **Locate-then-analyze two-pass** (Flywheel): `flywheel/skills/codebase-research/SKILL.md:54-82` — haiku locators (paths only, no file contents) → sonnet analyzers (targeted reads, documentarian mode). Reduces context 40-60% per skill description.

- **Dedicated plan review** (Flywheel): `flywheel/skills/plan-review/SKILL.md` — distinct skill that dispatches ALL reviewers unconditionally, deduplicates, converts disagreements to Open Questions, appends summary to plan file.

- **Dual-write checkpoint** (Flywheel): `flywheel/skills/work-implementation/references/checkpoint-procedure.md` — (1) TaskUpdate completed (primary, survives terminal restarts), (2) state file update (backup, cross-session recovery).

- **Baseline snapshot** (Flywheel): `flywheel/skills/work-implementation/SKILL.md:47-58` — `<plan>.baseline.md` preserves plan at work-start; `work-review` compares implementation against baseline (not evolved current plan).

- **Ralph mode** (Flywheel): `flywheel/skills/work-implementation/references/ralph-mode.md` — "agent as stateless function"; context-threshold activation (>50% context, >2 phases remaining) writes exhaustive state including Current Working State, then suggests context clear.

- **3-Strike protocol** (Flywheel): `flywheel/skills/flywheel-conventions/SKILL.md:65-70` — (1) Diagnose, (2) Alternative approach, (3) Rethink assumptions, (4) Escalate to user. Integrated into `compound` Step 1.5 to capture escalation context.

- **Commands-as-skill-orchestrators** (Flywheel): `flywheel/commands/fly/plan.md:49-64` — `/fly:plan` command orchestrates 3 skills in sequence (plan-creation → plan-review → plan-consolidation) with `PLAN_PATH`/`CONTEXT_PATH` variable passing.

---

## Comparison & Contrast

### Quantitative

| Dimension | compound-engineering | flywheel |
|---|---|---|
| Version | 3.0.1 | 1.0.0 |
| Skills | 37 | 14 |
| Agents | 49 | 15 |
| Commands | 0 (migrated to skills in v2.39.0) | 8 slash commands |
| Target platforms | Claude Code, Cursor, Codex | Claude Code only |
| MCP servers | 0 declared | 1 (context7) |
| Authored | Kieran Klaassen / EveryInc | Wesley Sauret |
| Philosophy | Compound loop (ideate→brainstorm→plan→work→review→compound) | Linear pipeline (brainstorm→plan→review→consolidate→work→review→ship→compound) |
| Component prefix | `ce-` required on all skills/agents | None on agents; `fly:` on commands |
| Pre-plan ideation | `ce-ideate` dedicated skill | Absent (starts at brainstorm) |
| Plan-review location | Embedded in `ce-code-review` (Stage 2b) + `ce-doc-review` | Dedicated `plan-review` skill |
| Severity model | P0-P3 + 5-anchor confidence (0/25/50/75/100), independent axes | P1/P2/P3 single axis |
| Reviewer dispatch | 4-tier persona catalog with thresholds; 18+ personas conditional | ALL 6 reviewers fire in parallel unconditionally |
| Validator pass | Stage 5b independent validator per finding (capped 15) | Single-pass |
| Tracker integration | Linear + GitHub Issues via tracker-defer | Absent |
| HITL document review | Proof (proofeditor.ai) | Absent |
| Worktree isolation | `ce-worktree` skill | Optional, recommended in work-implementation |
| Session state | Task list + OS-temp scratch + `.context/` for repo-bound | Explicit `.flywheel/session.md` + `<plan>.state.md` + `<plan>.baseline.md` |
| "Ralph mode" equivalent | `lfg` (full autonomous pipeline) | `Ralph mode` (stateless-loop trigger within work-implementation) |
| Compound-refresh | `ce-compound-refresh` dedicated skill (679 lines) | Absent (relies on re-authoring) |
| Knowledge maintenance | Discoverability check self-maintains AGENTS.md/CLAUDE.md | Absent |
| Agent-native audit | `ce-agent-native-audit` (8 principles) | Absent |
| Codex delegation | `ce-work-beta` with `codex exec` | Absent |
| Cross-platform converter | `src/` Bun/TypeScript CLI | Absent |
| Marketplace catalogs | 3 (Claude, Cursor, Codex) | 0 |
| Test suite | 49 converter/writer tests | Absent (in plugin) |
| Config | `.compound-engineering/config.local.yaml` | Absent |

### Architectural Thesis

The two plugins represent *opposite optimization targets*. Compound-engineering optimizes for **never missing a lens**: 18+ specialized reviewers, persona-based dispatch, self-maintaining knowledge base, cross-platform reach. Surface area is the feature. Flywheel optimizes for **predictable recoverability**: a minimal skill set covering the idea-to-shipped path, explicit session state that survives context compaction, one way to do each thing. Discipline is the feature.

Neither is strictly better; they suit different contexts. CE fits a Rails-heavy multi-developer org where catching rare cross-cutting issues justifies 20+ specialized agents. Flywheel fits a focused engineering workflow where predictable pipeline behavior and context economy matter more than reviewer variety. Most genuinely *interesting* ideas live in CE's breadth — most genuinely *correct* engineering choices live in Flywheel's discipline.

### Head-to-Head Scorecard

Each dimension evaluated on outcome quality, not feature count. "Winner" is judged against an engineer using the plugin daily on real work.

| Dimension | Compound-Engineering | Flywheel | Winner | Why |
|---|---|---|---|---|
| Plan review timing | Embedded in code-review Stage 2b (retroactive) | Dedicated skill *before* work (proactive) | **Flywheel** | Catching misalignment before code is always cheaper than after. CE's Stage 2b detects drift, but by then the work is done. |
| Session durability | Platform task list + OS-temp scratch | `.flywheel/session.md` + `<plan>.state.md` + `<plan>.baseline.md` | **Flywheel** | Flywheel survives context wipe with exact resume state. CE has no equivalent. Ralph mode is only possible because the state file exists. |
| Plan compliance | Extract requirements at review time | `<plan>.baseline.md` snapshot compared against implementation | **Flywheel** | The snapshot is a genuine innovation. Compares implementation against the *committed* plan, not the evolved one. CE cannot detect plan drift this way. |
| Reviewer precision | 4-tier persona catalog, diff-size thresholds | All 6 reviewers fire unconditionally | **CE** (for large diffs); Flywheel (for small) | CE wins when stack-specific or adversarial lenses matter. On a 10-line typo fix, Flywheel's 6 reviewers produce 6× more noise than needed. |
| Severity model | P0-P3 × 5-anchor confidence (2-axis) | P1-P3 (1-axis) | **CE marginally** | The confidence axis filters "might be an issue" speculation. But Flywheel's explicit evidence requirements accomplish most of the same filtering. Cognitive-load cost for minor gain. |
| Out-of-scope findings | `tracker-defer` → Linear/GitHub issues | P3 findings user doesn't select are dropped entirely | **CE** | Flywheel loses real-but-out-of-scope findings forever. CE files them. Meaningful gap. |
| Knowledge discoverability | `ce-compound` self-audits AGENTS.md and proposes edits if `docs/solutions/` unsurfaced | No mechanism | **CE** | Low-cost auto-maintenance of instruction files. Flywheel's `docs/solutions/` is invisible to new agents unless manually referenced. |
| Knowledge decay | `ce-compound-refresh` with 5-outcome classification | No mechanism | **CE at scale**, premature at Flywheel's current size | Essential when `docs/solutions/` hits ~50+ entries. Overkill before that. |
| Failure-case learning | No equivalent | 3-Strike protocol feeds into `compound` Step 1.5 | **Flywheel** | Captures escalation context (all 3 failed attempts) into a solution doc. CE has no formal escalation-to-learning pipeline. |
| Compound decision menu | Simple save-and-exit | 7-option menu including "add to Required Reading" WRONG/CORRECT pattern | **Flywheel** | Required Reading creates a pattern library more actionable than a flat solutions directory. |
| Large-plan handling | `lfg` (autonomous fire-and-forget) | Ralph mode (stateless pause-and-resume, context-threshold triggered) | **Different tools** | `lfg` suits trusted delegation; Ralph suits interactive work that outgrows context. Flywheel's is more aligned with an interactive workflow. |
| Research agent model | Named-persona reviewers + dedicated research agents | Locate-then-analyze two-pass (haiku → sonnet) | **Flywheel** | The locate/analyze split is more token-efficient. CE's researchers (ce-repo-research-analyst, ce-learnings-researcher, ce-best-practices-researcher) overlap and lack the strict paths-only→contents-only separation. |
| Skill-authoring discipline | Elaborate compliance checklist (1024-char cap, rationale-discipline, extraction patterns) | Lighter rulebook | **CE** | CE's "Every line in SKILL.md loads on every invocation" rule is pure value and free to adopt. |
| HITL document surface | Proof (proofeditor.ai) integration | None | **CE for doc-heavy teams**, Flywheel (skip) | External service adds moving parts. Plan-review already surfaces disagreements via AskUserQuestion. Not worth the complexity for terminal-first users. |
| Pre-plan ideation | `ce-ideate` with 6 divergent frames | None (starts at brainstorm) | **CE for exploration, Flywheel for execution** | Most engineers invoke planning with intent in mind. ce-ideate is useful but rarely needed. |
| Multi-platform | Claude + Cursor + Codex with converter CLI | Claude-only | **CE for reach**, Flywheel (by design) | Different missions, not comparable on a single axis. |
| Codex delegation | `ce-work-beta` with `codex exec` | None | **CE** (for users running multi-model) | Niche. Skip unless Codex is part of the workflow. |
| Validator subagents | Stage 5b — one validator per finding (capped 15) | Single-pass | **Neither clearly** | CE: catches hallucinations, costs ~30k tokens per review. Flywheel: trusts reviewer evidence, saves tokens. Depends on whether your reviewers hallucinate in practice. |
| Worktree isolation | `ce-worktree` dedicated skill | Optional, recommended in work-implementation | **Tie** | Mechanically similar. CE's is more formalized; Flywheel's is more lightweight. |

### Where Each Plugin Wins

**Flywheel genuinely leads on**:
- Durable session state (explicit files survive context wipe; CE lacks this entirely)
- Baseline snapshot for plan compliance (novel mechanism — CE has nothing equivalent)
- Plan review as a first-class pre-work gate (catches misalignment before cost incurred)
- 3-Strike protocol → compound integration (systematic failure-to-learning pipeline)
- Decision menu with Required Reading patterns (sharper teaching loop than a flat directory)
- Locate-then-analyze separation (research agents with strict paths-vs-contents boundary)
- Predictability (same 6 reviewers, same 7 phases, every time — easier to reason about, easier to debug)

**Compound-engineering genuinely leads on**:
- Tracker-defer (P3 findings captured as issues rather than lost)
- Discoverability self-check (auto-audits AGENTS.md for knowledge-store reference)
- Diff-size thresholds for reviewer dispatch (skips adversarial on typo-sized diffs)
- Rationale discipline rule ("every line loads on every invocation" — saves tokens)
- Reference file inclusion patterns (`@` inline for ≤150-line structural; backtick paths for on-demand)
- Deepening workflow (section-level confidence scoring + targeted re-review)
- Compound-refresh (knowledge maintenance at scale; essential once catalog grows)
- Cross-platform authoring discipline (most of which is adoptable even if Flywheel stays Claude-only)

**Ties or context-dependent**:
- Reviewer personas (CE broader, Flywheel focused — both defensible)
- Ideation (CE's ce-ideate helps for exploration; unused in directed engineering work)
- Confidence scoring (CE's 5-anchor is precise but adds cognitive load)
- Autonomous pipeline (CE's lfg vs Flywheel's Ralph — different modes, not competing)

---

## Recommendations for Flywheel

Filter applied: each recommendation is evaluated on (1) **outcome improvement** — does it make agent work measurably better, or just *more*? (2) **token efficiency** — does it save or cost tokens relative to the benefit? (3) **philosophical fit** — does it preserve Flywheel's disciplined-pipeline character, or drift toward CE's breadth?

CE has 37 skills and 49 agents. Flywheel has 14 and 15. Importing without judgment would destroy Flywheel's focus. These recommendations err toward conservatism.

### Tier 1 — Adopt (clear wins, low cost)

**1. Tracker-defer for dropped P3 findings**
- **Where**: `work-review/SKILL.md:82-130` (Phase 3 P3 triage), also `plan-review` conflict outputs
- **Current**: P3 findings user doesn't select are omitted entirely — no residual record
- **Proposed**: Add a fourth triage option: "File as GitHub issues". On selection, detect `gh auth status`; if authenticated, create one issue per finding with a fingerprint-based dedup check against existing open issues. If no `gh`, fall back to writing `docs/reviews/YYYY-MM-DD-<slug>.deferred.md` in the review directory.
- **Cost**: ~200 tokens per `gh issue create` (one-shot); detection probe ~50 tokens cached per session.
- **Benefit**: Zero findings lost. Users currently face a false tradeoff (accept noise or lose signal); this resolves it.
- **Reference**: `inspiration/compound-engineering/plugins/compound-engineering/skills/ce-code-review/references/tracker-defer.md:1-150` — import the detection + fallback chain pattern; skip the Linear-specific path unless needed.
- **Verdict**: Unambiguous improvement. Do this.

**2. Discoverability check in `compound`**
- **Where**: `compound/SKILL.md` — add a Step 2.5 before the YAML validation step
- **Current**: First-time users may never realize `docs/solutions/` exists. New agents opening a repo won't find the knowledge store unless explicitly told.
- **Proposed**: On first compound creation per repo (detected by: `docs/solutions/` has fewer than 3 files, or `AGENTS.md`/`CLAUDE.md` doesn't mention "docs/solutions" via grep), offer to add a one-line reference in AGENTS.md. Single AskUserQuestion, one conditional Edit.
- **Cost**: ~100 tokens total (one grep, one AskUserQuestion, one conditional Edit). Fires at most once per repo.
- **Benefit**: Self-maintaining workflow. Every future agent (Claude or otherwise) opening the repo sees the knowledge store reference and uses it.
- **Reference**: `ce-compound/SKILL.md:277-307` — small and portable pattern.
- **Verdict**: Cheap, high-value. Do this.

**3. Fingerprint-based dedup for review findings**
- **Where**: `plan-review/SKILL.md:79-89` (Phase 3 dedup), `work-review/SKILL.md` synthesis
- **Current**: "identical (same section + same issue) → merge with source count" — a string-match heuristic that misses near-duplicates (e.g., reviewer A says `file.ts:42`, reviewer B says `file.ts:44`, reporting the same bug).
- **Proposed**: Adopt CE's fingerprint formula — `normalize(file) + line_bucket(line, ±3) + normalize(title)`. Where `normalize` = lowercase + whitespace-collapse + strip leading articles; `line_bucket(n, ±3)` rounds to a 7-line window (so lines 42 and 44 hash the same). Pure orchestrator-side text transform — no new subagent calls.
- **Cost**: ~0 tokens (deterministic logic, no model calls).
- **Benefit**: Noticeably cleaner review output. Cross-reviewer agreement becomes more visible (same fingerprint from 3 reviewers = strong signal to promote priority).
- **Reference**: `ce-code-review/references/tracker-defer.md` — fingerprint described there; also `ce-code-review/SKILL.md:470-513` Stage 5 merge pipeline.
- **Verdict**: Free improvement. Do this.

**4. Diff-size threshold for `work-review` dispatch**
- **Where**: `work-review/SKILL.md:62-80` (Phase 2 parallel reviewer dispatch)
- **Current**: All 6 reviewers fire on every diff, whether 10 lines or 10,000.
- **Proposed**: Compute diff size up front (non-test, non-lockfile lines). For diffs <50 lines, skip `reviewer-architecture` and `reviewer-performance` by default — they produce noise or silence on tiny diffs. For >500 lines, offer `reviewer-elegance` a second time on the largest file. Keep the override explicit: if user passes `--full`, ignore thresholds.
- **Cost**: Saves ~6k tokens per small-PR review (two reviewer subagents × ~3k each). Adds ~100 tokens of threshold logic to SKILL.md.
- **Benefit**: Faster small-PR reviews. Reduces noise on trivial changes. Preserves signal on large changes.
- **Reference**: `ce-code-review/references/persona-catalog.md:1-69` (threshold concept only); don't import the full 18-persona catalog — just the threshold pattern.
- **Verdict**: Measurable token savings + less noise. Do this.

**5. Rationale discipline rule in `flywheel-conventions`**
- **Where**: `flywheel-conventions/SKILL.md` — add to the Output Format section
- **Current**: No guidance on SKILL.md prose density. Several Flywheel SKILL.md files contain explanatory prose that doesn't change agent behavior at runtime.
- **Proposed**: Add the rule: *"Every line in a SKILL.md loads on every invocation. Include rationale only when it changes what the agent does at runtime. If behavior wouldn't differ without the sentence, cut it. Keep rationale at the highest-level location that covers it; restate behavioral directives at the point they take effect."* Then audit existing SKILL.md files (especially `work-implementation/SKILL.md:1-160` and `plan-creation/SKILL.md:1-227`) against this rule.
- **Cost**: Authoring-time discipline. One-time audit pass per skill. Runtime cost: *negative* (reduces tokens loaded per invocation).
- **Benefit**: Tighter prompts = smaller context on every skill invocation. In a multi-skill session (e.g., plan → review → consolidate → work), savings compound.
- **Reference**: `plugins/compound-engineering/AGENTS.md` "Rationale Discipline" section.
- **Verdict**: Pure win. The rule is free; the audit is one-time. Do this.

### Tier 2 — Consider (good ideas, scope carefully)

**6. Lightweight confidence marker on findings (not full 5-anchor)**
- **Where**: Reviewer agent output contracts; `plan-review`/`work-review` synthesis phases
- **Current**: Reviewers produce findings as P1/P2/P3. Confidence is implicit in prose ("this might", "this definitely").
- **Proposed**: Add a `confidence: high | medium | low` field to every finding. Below `medium` gets suppressed unless P1. Do NOT import CE's 0/25/50/75/100 numeric anchor system — overkill for Flywheel's scope.
- **Cost**: +1 word per finding × ~20 findings/review = ~20 tokens per review. Reviewer agent prompts need a small addition defining the three levels.
- **Benefit**: Filters "might be an issue" speculation. Makes severity × confidence tradeoff explicit. BUT — Flywheel reviewers already cite evidence; speculation noise may not be a real problem in practice.
- **Reference**: `ce-code-review/references/findings-schema.json:1-139` (conceptual model); adapt to 3-level.
- **Verdict**: Test first. Run a small audit: how often do current reviews include unverified speculation? If rarely, skip. If common, adopt.

**7. Conditional/late-sequence extraction audit on `work-implementation/SKILL.md`**
- **Where**: `work-implementation/SKILL.md:1-160`, and its references directory
- **Current**: SKILL.md is ~160 lines loaded on every `/fly:work` invocation. Contains full Ralph mode description (~20 lines) even though Ralph mode fires only at threshold. Contains checkpoint procedure details (~15 lines) even though they're also in `references/checkpoint-procedure.md`.
- **Proposed**: Extract Ralph-activation details, 3-Strike escalation mechanics, and checkpoint details from SKILL.md into `references/` files with backtick paths. Keep only the trigger conditions inline (e.g., "If context >50% with >2 phases remaining, read `references/ralph-mode.md`").
- **Cost**: One-time refactor effort. Runtime savings: ~15-20% of SKILL.md tokens per invocation.
- **Benefit**: Less context burden on every work invocation. Cost compounds over a multi-phase plan.
- **Reference**: `plugins/compound-engineering/AGENTS.md` "Conditional and Late-Sequence Extraction" section.
- **Verdict**: Worth doing, but requires careful testing after refactor to confirm agent behavior is preserved.

**8. Optional "deepen" pass in `plan-review`**
- **Where**: `plan-review/SKILL.md:122-126` (Phase 6 handoff menu)
- **Current**: plan-review fires all 6 reviewers once. If their output is weak on a specific section, no built-in way to push deeper without re-running the whole skill.
- **Proposed**: Add a fourth option in Phase 6 AskUserQuestion: "Deepen on specific section". If selected, user picks a section name; orchestrator re-runs only the top 2 most-relevant reviewers against that section with an explicit "analyze X deeper; previous review noted Y" prompt. Cap at 2 deepen passes per plan.
- **Cost**: Conditional — fires only when user selects. ~3-6k tokens per deepen pass (2 reviewers × 1 section).
- **Benefit**: Targeted re-examination without forcing full re-review. Useful when plan is mostly right but one section is unclear.
- **Reference**: `ce-plan/references/deepening-workflow.md:1-250` — import the user-triggered pattern only, skip the deterministic section→agent mapping (too bespoke).
- **Verdict**: Legitimate gap. Adopt, but keep simple.

**9. Auto-memory integration in `compound` (Claude Code only)**
- **Where**: `compound/SKILL.md` Step 2 (extract from conversation)
- **Current**: compound extracts context only from the current conversation transcript. Doesn't reference Claude Code's auto-memory (`MEMORY.md` block in system prompt).
- **Proposed**: In Step 2, also scan system prompt for `## Memories` or equivalent block; cite relevant memory entries as evidence, tagged `(source: claude-memory)`. Use them to inform `prevention` and `applies_when` fields.
- **Cost**: ~200 tokens to scan and filter. Conditional — only runs if auto-memory is present.
- **Benefit**: Durability across sessions — memory observations feed into solution docs, reducing redundancy between memory and compound knowledge.
- **Caveat**: Claude Code-specific. Adds platform coupling. If Flywheel grows to other platforms, this needs per-platform adapters.
- **Reference**: `ce-compound/SKILL.md:74-89` Phase 0.5.
- **Verdict**: Valuable but platform-coupling tradeoff. Worth it if Flywheel stays Claude-only.

### Tier 3 — Skip (not worth the cost)

**10. Stage 5b validator subagents** — CE spawns up to 15 additional independent-context validators per review to catch hallucinated findings. At ~2k tokens each, that's ~30k tokens added per review for marginal hallucination reduction. Flywheel reviewers already cite evidence (per `flywheel-conventions/SKILL.md`). Skip unless hallucinated findings become a real problem in practice.

**11. Full 18-persona reviewer catalog** — CE's catalog reflects years of accumulating reviewer lenses for specific gotchas (DHH-style Rails, Kieran-style Python, Julik-style frontend races). Importing wholesale creates a maintenance burden disproportionate to Flywheel's scope. If a specific stack-heavy lens is ever needed, add as a single new reviewer agent — not a tiered system. Skip.

**12. `ce-compound-refresh`** — 679-line maintenance skill. Premature at Flywheel's current `docs/solutions/` scale. Revisit when catalog exceeds ~50 entries and staleness becomes a real problem. Until then, manual `compound` invocations with dedup check are sufficient.

**13. HITL via Proof (proofeditor.ai)** — External service dependency conflicts with Flywheel's terminal-first workflow. Plan-review + plan-consolidation already surface disagreements via AskUserQuestion. The marginal value of a web-based markup surface doesn't justify the additional moving parts. Skip.

**14. `ce-ideate` pre-plan ideation skill** — 269-line skill that dispatches 6 parallel sub-agents across 6 thinking frames. Useful for "what should I build?" exploration. Most Flywheel users invoke `/fly:plan` with concrete intent already. Starts too far upstream. Skip unless user feedback shows demand for open-ended exploration.

**15. `lfg` autonomous pipeline** — Fires plan → work → review → test with zero user prompts. Conflicts with Flywheel's interactive-by-default philosophy. If full autonomy is ever needed, implement as a separate `/fly:auto` command with explicit opt-in, not a default path. Skip.

**16. Multi-platform conversion infrastructure** — The Bun/TypeScript converter CLI ships CE to Cursor and Codex. Flywheel is Claude-only by design. Adding conversion infrastructure is a strategic pivot, not a workflow improvement. Skip.

**17. `ce-agent-native-audit` (8 principles)** — Audits a codebase against CE's own thesis about agent-native architecture. Interesting but niche. Flywheel's `work-review` already surfaces architectural concerns via `reviewer-architecture`. Skip.

**18. Codex delegation in `work-implementation`** — CE's `ce-work-beta` runs implementation units via `codex exec` for multi-model workflows. Skip unless Codex becomes part of the Flywheel user base.

**19. `ce-worktree` as a dedicated skill** — Flywheel already recommends worktrees in `work-implementation/references/load-resume-procedures.md:130-144`. Formalizing into a dedicated skill adds invocation surface without clear outcome gain. Keep the current lightweight recommendation.

### Net Assessment

**All Tier 1 adoptions combined** add ~500 tokens of new SKILL.md content across 3 files (tracker-defer option, discoverability check, rationale-discipline rule) and ~200 tokens of dedup-fingerprint logic. They **save** up to ~6k tokens per small-PR review (diff-size threshold) and up to ~20% of SKILL.md tokens per work invocation (rationale-discipline audit). Net token savings per typical session: ~5-10k. Plus: zero P3 findings lost, knowledge store auto-discovered, fewer duplicate findings reaching the user.

Estimated implementation effort:
- Tier 1: ~2-3 focused work sessions. Each item is a contained SKILL.md edit or agent-prompt update.
- Tier 2: ~1-2 work sessions per item, with test validation. The rationale-discipline audit is the longest (reading through each SKILL.md and extracting conditional blocks).
- Tier 3: No work. Active decision to not adopt.

**Philosophical guardrail**: Flywheel's core value is a *disciplined, predictable, state-durable* pipeline. Every addition should preserve that. Reject any change that:
- Introduces conditional reviewer dispatch with complex decision rules (violates predictability)
- Removes or weakens session state files (violates durability)
- Adds skills with overlapping triggers (violates discipline)
- Couples to external services without fallback (violates focus)

CE's best ideas are the ones compatible with these constraints. The ones that aren't — validator subagents, full persona catalogs, HITL via Proof — are genuine CE innovations that just don't fit Flywheel's design. Leaving them in `inspiration/` is the right call.

---

## Prompt-Craft Comparison: Fine-Grained Textual Differences

The previous recommendations cover architectural and workflow additions. This section goes inside the prompts themselves — comparing the actual wording of plan-creation vs ce-plan, work-implementation vs ce-work, and work-review's reviewer agents vs CE's reviewer agents + subagent-template. Each subsection quotes both plugins directly, identifies what CE's phrasing does better (or worse), and names the specific textual change Flywheel could adopt without importing any new skills or agents.

The goal is prompt sharpness — tighter directives, clearer negative space, more useful outputs — not more surface area. Everything in this section is ≤ ~50 tokens to adopt; most improvements cost 0 or negative tokens (they replace bloated text with tighter text).

### 1. Severity Vocabulary — Behavioral Criteria Beat Adjectives

**Flywheel** (`work-review/SKILL.md:95-97`):
```
- P1 (Critical): Security vulnerabilities, data corruption risks, breaking changes -- BLOCKS MERGE
- P2 (Important): Performance issues, architectural concerns, reliability issues
- P3 (Nice-to-have): Minor improvements, cleanup, documentation
```

**CE** (`ce-code-review/SKILL.md:82-87`):
```
| P0 | Critical breakage, exploitable vulnerability, data loss/corruption | Must fix before merge
| P1 | High-impact defect likely hit in normal usage, breaking contract | Should fix
| P2 | Moderate issue with meaningful downside (edge case, perf regression, maintainability trap) | Fix if straightforward
| P3 | Low-impact, narrow scope, minor improvement | User's discretion
```

**What CE does better**: CE's definitions give *behavioral criteria* the model can apply to a finding ("likely hit in normal usage", "fix if straightforward"). Flywheel's adjectives ("Important", "Nice-to-have") are subjective categories the model has to interpret. CE also separates the meaning column from the action column — severity tells you *what it is*, the action column tells you *what to do about it*.

**Adoption**: Rewrite `work-review/SKILL.md:95-97` with behavioral criteria. Keep P1/P2/P3 (don't add P0 — that's a separate architectural call covered elsewhere). Cost: ~0 tokens (replaces existing text with same-length sharper version).

Suggested replacement:
```
- P1: High-impact defect — security, data loss, breaking change, or likely hit in normal usage. BLOCKS MERGE.
- P2: Moderate issue with real downside (edge case, perf regression, maintainability trap). Fix if straightforward.
- P3: Low-impact, narrow scope. User's discretion.
```

---

### 2. Reviewer Output Format — Findings-Shaped vs Task-Shaped

**Flywheel** (`agents/reviewer-architecture.md:64-89`):
```
### End Goal
[1-2 sentences: What we're trying to achieve]

### Approach Chosen
[1-2 sentences: The strategy selected and why]

### Completed Steps
- [Completed action 1]
(max 10 items)

### Current Status
[What's done, what's blocked, what's next - 1 paragraph max]

### Key Findings
- [Finding 1]
(max 15 items - if more, prioritize by severity and truncate)

### Files Identified
- `path/to/file.ts` - [brief description]
```

**CE** (`ce-code-review/references/subagent-template.md:29-33`):
```
RETURN compact JSON to the parent with ONLY merge-tier fields per finding:
title, severity, file, line, confidence, autofix_class, owner, requires_verification, pre_existing, suggested_fix.
```

**What CE does better**: CE's output is findings-shaped — each finding has explicit fields the synthesizer can dedupe, sort, and render. Flywheel's output format is task-shaped ("End Goal / Approach Chosen / Completed Steps / Current Status") — it looks like a generic work-report template, not a reviewer output. Each finding is collapsed into a single bullet under "Key Findings", losing structure that synthesis would need.

**This is arguably the single biggest prompt-craft gap in Flywheel.** The reviewer output format forces the synthesizer to parse prose to extract structured findings. Fingerprint-based dedup (Tier 1 recommendation #3) won't work well without structured fields.

**Adoption**: Rewrite the Output Format section of ALL 6 reviewer agents (`agents/reviewer-*.md`) to be findings-shaped:

```markdown
## Output Format

Return findings as a structured list. Each finding:

**Finding N: [one-line title]**
- Severity: P1 | P2 | P3
- File: `path/to/file.ts:LINE`
- What's wrong: [1-2 sentences describing observable behavior — not code structure]
- Suggested fix: [concrete change, or "see discussion"]
- Evidence: [quote or file:line reference]

If no findings, return: "No findings."

Optional sections after findings:
- Residual risks: [concerns that aren't actionable but worth noting]
- Open questions: `OPEN QUESTION: [ambiguity that blocks a clean finding]`
```

This is markdown (not JSON) — matches Flywheel's current text-based synthesis. But it's findings-shaped. Dedup/sort logic in `work-review/SKILL.md` Phase 3 can now operate on parsed fields instead of prose.

Cost: ~30 lines replacing existing output format sections × 6 reviewer agents = ~180 tokens total saved (old format is ~35 lines per agent; new is ~20). Benefit: synthesizer gets structured input it can actually dedupe.

---

### 3. Reviewer Persona Openers — Evocative vs Functional

**Flywheel** (`agents/reviewer-architecture.md:9-10`):
```
You are a system architecture reviewer. Your question is: **"Does this change fit the system's structure?"**

You are NOT checking whether the code is correct, well-typed, or consistent with naming conventions — other reviewers handle that.
```

**CE** (`agents/ce-correctness-reviewer.agent.md:10-12`):
```
You are a logic and behavioral correctness expert who reads code by mentally executing it -- tracing inputs through branches, tracking state across calls, and asking "what happens when this value is X?" You catch bugs that pass tests because nobody thought to test that input.
```

**What CE does better**: CE's opener embeds *the method* — "reads code by mentally executing it", "tracing inputs through branches", "what happens when this value is X?". These aren't just role descriptions — they're instructions about *how to review*. A model reading "reads code by mentally executing it" is primed to do exactly that.

Flywheel's opener names the role and the question but doesn't describe the method. "Does this change fit the system's structure?" is a framing device, not an instruction.

**Adoption**: Rewrite openers for all 6 Flywheel reviewer agents with method-embedded language:

| Agent | Current opener | Adoption direction |
|---|---|---|
| `reviewer-architecture` | "You are a system architecture reviewer. Your question is: 'Does this change fit the system's structure?'" | "You are an architecture reviewer who traces dependency direction, state ownership, and abstraction layer boundaries. You spot layering violations and circular imports by mentally mapping the module graph." |
| `reviewer-code-quality` | (similar generic opener) | "You read code for type safety, readability, and idiom adherence. You ask: 'will a maintainer six months from now understand this in 30 seconds?' You flag cleverness that obscures intent." |
| `reviewer-elegance` | (similar) | "You review for design simplicity — fewer moving parts, less state, shorter call chains. You ask: 'is there a version of this with half the complexity that serves the same need?' You flag accidental complexity, not essential complexity." |
| `reviewer-performance` | (similar) | "You trace hot paths, allocation patterns, and I/O boundaries. You ask: 'at what scale does this break?' You flag O(n²) where O(n) fits, N+1 queries, and blocking calls in async paths." |
| `reviewer-patterns` | (similar) | "You read the surrounding codebase first, then the diff. You ask: 'does this match how the rest of the codebase solves similar problems?' You flag local reinventions of existing utilities and convention breaks." |
| `reviewer-data-integrity` | (similar) | "You check migration safety, transaction boundaries, referential integrity, and rollback behavior. You ask: 'what breaks if this fails halfway through?'" |

Cost: ~2 lines × 6 agents = ~12 lines total, replacing equivalent-length generic openers. Net 0 tokens.

---

### 4. False-Positive Suppression Catalog

**Flywheel**: No explicit FP catalog. Individual reviewers have scattered "What NOT to review" sections.

**CE** (`ce-code-review/references/subagent-template.md:115-126`):
```
False-positive categories to actively suppress. Do NOT emit a finding when any of these apply...

- Pre-existing issues unrelated to this diff.
- Pedantic style nitpicks that a linter or formatter would catch.
- Code that looks wrong but is intentional (check comments, commit messages, PR description).
- Issues already handled elsewhere (check callers, guards, middleware, framework defaults).
- Suggestions that restate what the code already does in different words.
- Generic "consider adding" advice without a concrete failure mode.
- Issues with a relevant lint-ignore comment.
- General code-quality concerns not codified in CLAUDE.md / AGENTS.md.
- Speculative future-work concerns with no current signal.
```

**What CE does better**: This is the single most noise-reducing directive in CE. Each category is a concrete failure mode reviewers actually produce. "Suggestions that restate what the code already does in different words" is a pattern every model does at some point — naming it suppresses it.

**Adoption**: Add a condensed 5-item FP catalog to `flywheel-conventions/SKILL.md` under the "Output Format" section (so all reviewer agents inherit it via the `skills: [flywheel-conventions]` reference). Keep tight:

```markdown
## False-Positive Suppression

Do NOT emit a finding if any apply:

- **Already handled elsewhere**: check callers, guards, middleware, framework defaults before flagging
- **Restates existing behavior**: "consider extracting a helper" when the code already is a small helper; "add a guard" when a guard one line up enforces it
- **Generic "consider adding" advice**: if you can't name what concretely breaks, don't flag
- **Style a linter would catch**: formatting, unused vars, import order — belongs to toolchain
- **Speculative future-work**: "might break under load" without evidence the concern is reachable now

A suppressed finding is better than a noisy one. If in doubt between "flag weakly" and "suppress", suppress.
```

Cost: ~12 lines added to `flywheel-conventions/SKILL.md`. Benefit: reduces noise across all 6 reviewer outputs × every review. Token savings compound quickly.

---

### 5. "Why It Matters" Framing — Observable Behavior First

**Flywheel**: No equivalent directive. Reviewer findings are free-form bullets.

**CE** (`ce-code-review/references/subagent-template.md:92-113`):
```
Writing `why_it_matters` (required field, every finding):

- **Lead with observable behavior.** Describe what the bug does from the outside — what a user, attacker, operator, or downstream caller experiences. Do not lead with code structure ("The function X does Y..."). Start with the effect ("Any signed-in user can read another user's orders...").
- **Explain why the fix resolves the problem.** If you include a `suggested_fix`, the `why_it_matters` should make clear why that specific fix addresses the root cause.
- **Keep it tight.** Approximately 2-4 sentences plus the minimum code quoted inline.

Illustrative pair — same finding, weak vs. strong framing:

WEAK (code-citation first):
  orders_controller.rb:42 has a missing authorization check.
  Add current_user.owns?(account) guard before the query.

STRONG (observable behavior first):
  Any signed-in user can read another user's orders by pasting the
  target account ID into the URL. The controller looks up the account
  and returns its orders without verifying the current user owns it.
  Adding a one-line ownership guard before the lookup matches the
  pattern already used in the shipments controller for the same attack.
```

**What CE does better**: This turns "what's wrong with this code?" into "what concretely breaks, for whom?". A finding that says "orders_controller.rb:42 has a missing authorization check" requires the reader to infer stakes. A finding that says "any signed-in user can read another user's orders" communicates stakes directly.

**Adoption**: Add to `flywheel-conventions/SKILL.md`:

```markdown
## Finding Quality: Lead with Observable Behavior

For every finding, the "What's wrong" field must lead with what breaks, for whom — not with code structure.

**Weak**: "The function parseDate() doesn't validate input format."
**Strong**: "Users submitting dates in DD/MM/YYYY format hit a silent parse error that logs them out. The function only accepts YYYY-MM-DD and returns null for other formats; the caller doesn't check."

If you can't name a concrete observable consequence (wrong result, unhandled error, contract mismatch, security exposure), the finding is advisory — mark it as P3 or suppress.
```

Cost: ~8 lines to `flywheel-conventions/SKILL.md`. Benefit: Findings become triagable without re-reading the file.

---

### 6. Intent Verification Directive

**Flywheel**: Plan compliance check happens at review synthesis time (`work-review/SKILL.md:29-37` Phase 1.0), comparing implementation against baseline plan.

**CE** (`ce-code-review/references/subagent-template.md:147`):
```
**Intent verification:** Compare the code changes against the stated intent (and PR title/body when available). If the code does something the intent does not describe, or fails to do something the intent promises, flag it as a finding. Mismatches between stated intent and actual code are high-value findings.
```

**What CE does better**: CE pushes intent verification down to every reviewer. Each reviewer checks "does this code match what it's supposed to do?" from their own lens. Flywheel centralizes this in a single Phase 1.0 step that compares against baseline plan.

Both approaches are defensible. CE catches intent drift in individual reviewer passes (more coverage); Flywheel catches it once at synthesis (less redundancy). But CE's version surfaces the drift inside each finding's context, which is more actionable.

**Adoption** (lightweight): Add to `flywheel-conventions/SKILL.md` as a cross-cutting rule:

```markdown
## Intent Verification

For every review, check the stated intent (PR title/body, plan description, or argument) against the code. Flag as P1:
- Code that does something the intent does not describe (scope creep)
- Code that fails to do something the intent promises (incomplete)

Intent-vs-implementation mismatches are high-value findings — surface them even if the code itself is well-written.
```

Cost: ~8 lines added. Complements Flywheel's existing plan-compliance check (they're not redundant — compliance = "matches baseline plan"; intent verification = "matches stated purpose").

---

### 7. Plan Quality Bar Checklist

**Flywheel** (`plan-creation/SKILL.md`): No explicit quality bar. Relies on MINIMAL/MORE/A LOT templates to structure plans.

**CE** (`ce-plan/SKILL.md:44-56`):
```
## Plan Quality Bar

Every plan should contain:
- A clear problem frame and scope boundary
- Concrete requirements traceability back to the request or origin document
- Repo-relative file paths for the work being proposed (never absolute paths)
- Explicit test file paths for feature-bearing implementation units
- Decisions with rationale, not just tasks
- Existing patterns or code references to follow
- Enumerated test scenarios for each feature-bearing unit, specific enough that an implementer knows exactly what to test without inventing coverage themselves
- Clear dependencies and sequencing

A plan is ready when an implementer can start confidently without needing the plan to write the code for them.
```

**What CE does better**: Gives the model a self-audit checklist. Before writing Phase 5 (Context File), the model can check: "do I have all these?" Templates alone don't produce this — a MINIMAL template has fewer fields but no quality bar.

The final sentence is the sharpest directive in the whole CE plan skill: *"A plan is ready when an implementer can start confidently without needing the plan to write the code for them."* That one sentence encodes the stop-condition.

**Adoption**: Add to `plan-creation/SKILL.md` between Phase 4 and Phase 5:

```markdown
## Plan Quality Bar

Before writing the context file (Phase 5), verify the plan contains:

- Clear problem frame and scope boundary (what's in, what's out)
- Traceability back to the source (feature request, bug report, design doc)
- Repo-relative file paths (never absolute paths)
- Explicit test file paths for each behavior-bearing phase
- Decisions with rationale, not just tasks
- Enumerated test scenarios specific enough that the implementer doesn't invent coverage
- Clear dependencies between phases

A plan is ready when an implementer can start confidently without needing the plan to write the code for them.
```

Cost: ~12 lines added to `plan-creation/SKILL.md`. Benefit: catches under-specified plans before they cause rework during implementation.

---

### 8. Core Principles Numbered List

**Flywheel** (`plan-creation/SKILL.md:17-21`):
```
**Philosophy:** Create plans grounded in codebase reality AND validated against external docs. Don't defer validation — bad assumptions caught early are cheap; caught late they become bad code.

**Context Compaction:** This skill creates `.context.md` files to persist research findings.
```

**CE** (`ce-plan/SKILL.md:33-42`):
```
## Core Principles

1. **Use requirements as the source of truth**
2. **Decisions, not code** - Capture approach, boundaries, files, dependencies, risks, and test scenarios. Do not pre-write implementation code or shell command choreography.
3. **Research before structuring** - Explore the codebase, institutional learnings, and external guidance when warranted before finalizing.
4. **Right-size the artifact** - Small work gets a compact plan. Large work gets more structure.
5. **Separate planning from execution discovery** - Resolve planning-time questions here. Explicitly defer execution-time unknowns to implementation.
6. **Keep the plan portable** - The plan should work as a living document, review artifact, or issue body without embedding tool-specific executor instructions.
7. **Carry execution posture lightly when it matters** - If the request implies test-first, reflect that as a lightweight signal. Do not turn the plan into step-by-step execution choreography.
8. **Honor user-named resources** - When the user names a specific resource, treat it as authoritative input. Discover it before assuming it's unavailable.
```

**What CE does better**: Numbered principles are referenceable. Later in the skill, directives can say "per Core Principle 2, don't pre-write code" rather than re-stating the rule. Flywheel's two Philosophy/Context Compaction lines cover some of this but don't scaffold reasoning about *why* the rule applies.

Principle 2 ("Decisions, not code") is the most load-bearing. Principle 5 ("Separate planning from execution discovery") is the one Flywheel would benefit from most — it explicitly allows plans to have Open Questions deferred to implementation time, which Flywheel handles implicitly.

**Adoption**: Replace the Philosophy/Context Compaction lines in `plan-creation/SKILL.md:17-21` with 5 numbered principles (not all 8 — trim to what Flywheel actually uses):

```markdown
## Core Principles

1. **Codebase reality first** — Every plan must be grounded in what the codebase actually does. Dispatch locators before hypothesizing patterns.
2. **Decisions, not code** — Capture approach, boundaries, files, dependencies, risks, and test scenarios. Do not pre-write implementation code.
3. **Right-size the artifact** — Small work gets MINIMAL. Large work gets A LOT. The principles stay the same at every depth.
4. **Separate planning from execution discovery** — Resolve planning-time questions here. Explicitly defer execution-time unknowns to `work-implementation`.
5. **Validate high-risk claims** — Security, payments, crypto, migrations, privacy trigger external validation via Context7. Don't defer; caught late, bad assumptions become bad code.
```

Cost: ~8 lines replacing 4 lines = ~4 line net add. Benefit: referenceable principles, sharper decomposition.

---

### 9. System-Wide Test Check — Explicit Questions

**Flywheel** (`work-implementation/SKILL.md:96-100`):
```
### 2.2a TDD Cycle

Read `flywheel-conventions/references/tdd-cycle.md` before proceeding -- contains RED/GREEN/REFACTOR steps and skip conditions.

Apply RED-GREEN-REFACTOR per implementation task. Skip TDD for pure refactoring, config-only, or docs changes.
```

**CE** (`ce-work/SKILL.md:212-224`):
```
**System-Wide Test Check** — Before marking a task done, pause and ask:

| Question | What to do |
|----------|------------|
| **What fires when this runs?** Callbacks, middleware, observers, event handlers — trace two levels out from your change. | Read the actual code (not docs) for callbacks on models you touch, middleware in the request chain, `after_*` hooks. |
| **Do my tests exercise the real chain?** If every dependency is mocked, the test proves your logic works *in isolation* — it says nothing about the interaction. | Write at least one integration test that uses real objects through the full callback/middleware chain. |
| **Can failure leave orphaned state?** If your code persists state (DB row, cache, file) before calling an external service, what happens when the service fails? | Trace the failure path with real objects. If state is created before the risky call, test that failure cleans up. |
| **What other interfaces expose this?** Mixins, DSLs, alternative entry points. | Grep for the method/behavior in related classes. If parity is needed, add it now — not as a follow-up. |
| **Do error strategies align across layers?** Retry middleware + application fallback + framework error handling — do they conflict? | List the specific error classes at each layer. Verify your rescue list matches what the lower layer actually raises. |

**When to skip:** Leaf-node changes with no callbacks, no state persistence, no parallel interfaces.
```

**What CE does better**: CE's System-Wide Test Check is a 5-question checklist for integration bugs that pass unit tests. Each question is a real failure mode — callbacks, mocks, orphaned state, parallel interfaces, error strategy alignment. Flywheel's TDD cycle covers the happy-path GREEN/RED/REFACTOR but not these integration-level traps.

This is a *major* quality lever. Unit-test-passing bugs that fail at integration time are the most common class of production bugs.

**Adoption**: Add to `work-implementation/references/verification-gates.md` (not SKILL.md — this is late-sequence, only needed at task-done time):

```markdown
## System-Wide Test Check

Before marking a phase complete, pause and ask:

- **What fires when this runs?** Callbacks, middleware, observers — trace two levels out from the change. Read the actual code, not docs.
- **Do tests exercise the real chain?** If every dependency is mocked, the test proves logic in isolation, not interaction. Write at least one integration test with real objects through the full chain.
- **Can failure leave orphaned state?** If code persists state before an external call, test the failure path. If state is created before the risky call, verify failure cleans up.
- **What other interfaces expose this?** Mixins, alternative entry points, parallel handlers. Grep for the behavior in related classes. Add parity now, not as follow-up.
- **Do error strategies align across layers?** Retry middleware + application fallback + framework error handling — do they conflict? List error classes at each layer; verify rescues match.

**Skip when**: Leaf-node changes with no callbacks, no state persistence, no parallel interfaces. The check takes 10 seconds; the answer is "nothing fires, skip."

**Matters most**: Changes touching models with callbacks, error handling with fallback/retry, or functionality exposed through multiple interfaces.
```

Cost: ~15 lines to `references/verification-gates.md` (late-sequence load, not every invocation). Benefit: catches integration bugs before they reach review.

---

### 10. Skill Descriptions for Auto-Invocation

**Flywheel** (`plan-creation/SKILL.md:3`):
```
description: Research codebase, validate external claims, and draft implementation plans. Single-pass creation with integrated validation via Context7 and locator/analyzer agents. Triggers on "create plan", "plan for", "write a plan".
```

**CE** (`ce-plan/SKILL.md:3`):
```
description: "Create structured plans for any multi-step task -- software features, research workflows, events, study plans, or any goal that benefits from structured breakdown. Also deepen existing plans with interactive review of sub-agent findings. Use for plan creation when the user says 'plan this', 'create a plan', 'write a tech plan', 'plan the implementation', 'how should we build', 'what's the approach for', 'break this down', 'plan a trip', 'create a study plan', or when a brainstorm/requirements document is ready for planning. Use for plan deepening when the user says 'deepen the plan', 'deepen my plan', 'deepening pass', or uses 'deepen' in reference to a plan. For exploratory or ambiguous requests where the user is unsure what to do, prefer ce-brainstorm first."
```

**What CE does better** (mostly):
1. **Exhaustive trigger phrases** — CE names 9 trigger phrases. Flywheel names 3. More triggers = more reliable auto-invocation on edge cases.
2. **Negative routing** — CE's last sentence tells Claude when NOT to invoke this skill: "For exploratory or ambiguous requests where the user is unsure what to do, prefer ce-brainstorm first." This prevents plan-creation from firing on fuzzy inputs that need brainstorming first.
3. **Scope expansion** — CE's "any multi-step task" framing is broader. Flywheel's is narrower but still fits most cases.

**What Flywheel does better**: CE's description is 130 words vs Flywheel's 35. Long descriptions have a cost — they're loaded into every skill-selection decision. CE's length may hurt selection accuracy when many skills compete.

**Adoption** (scoped): Don't bloat Flywheel's descriptions to CE's length. Instead: add *negative routing hints* where appropriate, and expand trigger phrases modestly.

Example for `plan-creation/SKILL.md:3`:
```
description: Research codebase, validate external claims, and draft implementation plans. Triggers on "create plan", "plan this", "plan for X", "write a plan", "how should we build X", "break this down". For exploratory requests where the user is unsure what to build, prefer brainstorm first. For existing plans, use plan-review instead.
```

Cost: ~30 extra tokens in description. Benefit: fewer mis-invocations on ambiguous inputs. Do this for all skills where adjacent skills could plausibly fire:
- `plan-creation`: "for exploratory, use brainstorm; for existing plans, use plan-review"
- `brainstorm`: "for concrete implementation plans, use plan-creation after brainstorming"
- `work-implementation`: "for planning, use plan-creation first; for review, use work-review after work"
- `debug`: "for bugs with unknown root cause only; for planned work, use plan-creation"

---

### 11. Specific Anti-Pattern Callouts

**Flywheel** (`work-implementation/SKILL.md:174-179`):
```
## Anti-Patterns

- **Skip checkpoints** - lose recovery capability
- **Parallel implementation** - causes file conflicts
- **Make subagent read plan** - provide text directly
- **Ignore test failures** - fix before checkpoint
```

**CE** (`ce-work/SKILL.md:346`):
```
- **Re-scoping the plan into human-time phases** - The plan's Implementation Units define the scope of execution. Do not estimate human-hours per unit, propose multi-day breakdowns, or ask the user to pick a subset of units for "this session". Agents execute at agent speed, and context-window pressure is addressed by subagent dispatch (Phase 1 Step 4), not by phased sessions. If a plan-file input is genuinely too large for a single execution, say so plainly and suggest the user return to `/ce-plan` to reduce scope — don't invent session phases as a workaround.
```

**What CE does better**: CE's anti-patterns name specific *failure modes* with their alternatives. "Re-scoping the plan into human-time phases" is a real failure mode — models often suggest splitting a plan across sessions. CE's bullet explicitly names it, explains why it's wrong (agents execute at agent speed), and gives the correct alternative (subagent dispatch for context pressure).

Flywheel's are terse (good for token cost) but less specific. "Parallel implementation - causes file conflicts" doesn't teach the model *why* parallel is bad or *when* it might be OK.

**Adoption**: Keep Flywheel's terse style but add 2-3 specific failure modes that come up in practice:

Add to `work-implementation/SKILL.md:174-179`:
```
- **Split plan into "this session" phases** — agents execute at agent speed; context pressure is handled via Ralph mode or subagent dispatch, not human-time session breaks. If a plan is genuinely too large, say so and suggest returning to plan-creation to reduce scope.
- **Ask for approval between every task** — the plan is the authority; don't renegotiate scope mid-execution. Only ask when the plan itself is ambiguous.
- **Declare "done" without running tests** — `work-implementation/references/verification-gates.md` requires evidence, not claims.
```

Cost: ~5 added lines. Benefit: catches real failure modes before they happen.

---

### 12. "BLOCKING:" Prefix Discipline

**Flywheel** (`plan-creation/SKILL.md:50`):
```
**BLOCKING:** Do NOT use Read/Grep/Glob for TARGET CODEBASE research — dispatch locator Tasks first, then feed results to analyzer Tasks.
```

**CE**: Uses inline bold and full-sentence framing:
```
**IMPORTANT: All file references in the plan document must use repo-relative paths (e.g., `src/models/user.rb`), never absolute paths**
```

**What Flywheel does better here**: The `**BLOCKING:**` prefix is a tighter signaling convention than `**IMPORTANT: ...**`. "BLOCKING" tells the model this is a gate, not a suggestion. CE's "IMPORTANT" is more ambiguous (every bold point is "important" in some sense).

**This is a Flywheel strength — no adoption needed.** In fact, CE could learn from Flywheel here.

Minor refinement: Flywheel uses `**BLOCKING:**` twice (plan-creation Phase 1 and Phase 1.5). Consistent use across all skills would help. Audit for places where "Do not X" is stated without the prefix and add it where the instruction is genuinely a gate.

---

### 13. Concrete Edit List

The specific textual changes from sections 1-12 above, listed by file for easy implementation:

**`plan-creation/SKILL.md`**:
- Lines 17-21: Replace Philosophy + Context Compaction with 5 numbered Core Principles (section 8)
- After Phase 4: Add Plan Quality Bar checklist (section 7)
- Line 3: Expand description with negative routing (section 10)

**`work-implementation/SKILL.md`**:
- Lines 174-179: Add 3 specific anti-patterns (section 11)
- Line 3: Expand description with negative routing (section 10)

**`work-implementation/references/verification-gates.md`**:
- Add System-Wide Test Check section with 5 questions (section 9)

**`work-review/SKILL.md`**:
- Lines 95-97: Rewrite severity definitions with behavioral criteria (section 1)

**`flywheel-conventions/SKILL.md`**:
- Add False-Positive Suppression section (section 4)
- Add "Lead with Observable Behavior" finding quality rule (section 5)
- Add Intent Verification cross-cutting rule (section 6)

**`agents/reviewer-*.md` (all 6)**:
- Replace Output Format sections with findings-shaped template (section 2)
- Rewrite opener sentences with method-embedded language (section 3)
- Ensure each has a "What NOT to review" section with specific cross-references to other reviewers

**Optional**:
- `brainstorm/SKILL.md` line 3: expand description with negative routing
- `debug/SKILL.md` line 3: expand description with negative routing

**Total estimated effort**: ~4-6 focused editing sessions. Most edits are tight (≤30 lines per file). The reviewer output format rewrite is the biggest — affects 6 files but with a shared template.

**Total token impact at runtime**: Net neutral to negative. Most changes replace existing text with tighter versions. The additions (principles, quality bar, FP catalog) are offset by the removals (generic reviewer output template, verbose severity definitions). Expected net: **-500 to -1500 tokens per typical session** depending on how many reviewers fire.

**Expected outcome improvements**:
- Fewer false-positive findings (FP suppression catalog)
- Findings with observable-behavior framing (easier triage)
- Structured reviewer output (enables fingerprint dedup)
- Sharper severity calls (behavioral criteria)
- Method-primed reviewers (better review quality)
- Plan self-audit via quality bar (fewer under-specified plans)
- Catches integration bugs before review (System-Wide Test Check)
- Fewer skill mis-invocations (negative routing hints)

None of these require adopting CE's architectural choices (persona catalog, validator subagents, confidence-anchor system, tracker-defer, etc.). All are pure prompt-craft improvements that preserve Flywheel's minimal-surface discipline.

---

## External References

No external documentation was fetched for this research — all findings derive from local codebase inspection of the `inspiration/compound-engineering/` tree and the `flywheel/` tree. The compound-engineering plugin's public homepage is documented as https://every.to/source-code/my-ai-had-already-fixed-the-code-before-i-saw-it and its repository is https://github.com/EveryInc/compound-engineering-plugin (referenced in `plugin.json:10-11`).

---

## Open Questions

- `ce-work` lacks an explicit session checkpoint or resume mechanism comparable to Flywheel's `.flywheel/session.md` + `<plan>.state.md`. Large plans interrupted mid-execution have no restart protocol beyond the platform task list. Whether CE considers this acceptable (because `lfg` is the autonomous path and `ce-work` is assumed interactive) or a gap is unclear from the skill content alone.
- `tracker-defer.md` is duplicated across `ce-work/`, `ce-work-beta/`, and `lfg/` — identical content per the skill self-containment rule (`AGENTS.md:1-257` — "Each skill directory is a self-contained unit"). Whether drift has occurred between copies is not directly testable from file inspection alone.
- Flywheel's `plan-review` dispatches ALL reviewers without filtering. Whether this was a deliberate simplification (vs. CE's persona catalog) or an unexplored design space is not stated in any SKILL.md or README.
- The 15 Flywheel agents are split between reviewers (6), locators (4), and analyzers (5). The `reviewer-*` agent files themselves (`.md` body, frontmatter) were not analyzed in depth — their exact prompts, model assignments, and output contracts are known only via `flywheel-conventions/SKILL.md` general rules.
- Whether Flywheel intentionally omits CE's ideation layer (`ce-ideate`) because it is assumed implicit in the user's feature request, or whether this is a future extension, is not stated.
- Neither plugin documents inter-plugin coexistence: what happens when both are installed simultaneously (would `/fly:plan` and `/ce-plan` conflict? would `compound` and `ce-compound` both auto-invoke on "that worked"?). CE's `ce-` prefix convention is framed as defensive against exactly this collision, but Flywheel does not prefix reviewer agent names (`reviewer-architecture` rather than `fly-reviewer-architecture`).

---

## Appendix: Skill Inventory

### Compound-Engineering (37 skills)

| Skill | Purpose |
|---|---|
| `ce-agent-native-architecture` | Reference skill for 8 agent-native principles |
| `ce-agent-native-audit` | Run 8-principle audit via 8 parallel Explore agents |
| `ce-brainstorm` | Collaborative requirements capture (R/A/F/AE IDs) |
| `ce-clean-gone-branches` | Script-driven branch cleanup |
| `ce-code-review` | 4-mode persona-based code review with Stage 5b validator |
| `ce-commit` | Standalone commit with convention detection |
| `ce-commit-push-pr` | Full commit → push → PR pipeline |
| `ce-compound` | Bug + knowledge track learning with auto-memory integration |
| `ce-compound-refresh` | Maintain docs/solutions/ with 5-outcome classification |
| `ce-debug` | 4-phase debug (Triage → Investigate → Root Cause → Fix) |
| `ce-demo-reel` | Capture UI demo recordings |
| `ce-dhh-rails-style` | Reference for Rails style opinions |
| `ce-doc-review` | 7-persona document review with chain linking |
| `ce-frontend-design` | Frontend design guidance |
| `ce-gemini-imagegen` | Gemini image generation |
| `ce-ideate` | 6-frame divergent ideation |
| `ce-optimize` | Iterative optimization loop |
| `ce-plan` | 5-phase planning with deepening workflow (850 lines, longest) |
| `ce-polish-beta` | Visual iteration with dev server |
| `ce-pr-description` | Generate PR description (title, body_file) |
| `ce-proof` | HITL document review via proofeditor.ai |
| `ce-release-notes` | Release notes generation |
| `ce-report-bug` | GitHub issue creation |
| `ce-resolve-pr-feedback` | Full/targeted PR thread resolution |
| `ce-session-extract` | Internal: extract skeleton/errors from session JSONL |
| `ce-session-inventory` | Internal: discover session files across platforms |
| `ce-sessions` | User-facing session search dispatcher |
| `ce-setup` | Environment diagnosis + config bootstrap |
| `ce-slack-research` | Slack organizational research |
| `ce-test-browser` | Browser test runner |
| `ce-test-xcode` | Xcode test runner |
| `ce-update` | Version check (Claude Code only) |
| `ce-work` | 4-phase implementation execution |
| `ce-work-beta` | ce-work + Codex delegation |
| `ce-worktree` | Worktree creation with env copy + dev tool trust |
| `lfg` | Full autonomous pipeline (ce-plan → ce-work → ce-code-review → ce-test-browser) |

### Flywheel (14 skills)

| Skill | Purpose |
|---|---|
| `astronomer-airflow` | Work with Airflow 3.x on Astronomer |
| `brainstorm` | 5-question dialog + 2-3 approach presentation |
| `codebase-research` | 4-phase locate→analyze research with persistent doc |
| `compound` | Sanitize + YAML + standards inference with 3-Strike integration |
| `debug` | Inline investigation + 10-iter fix loop with strike tracking |
| `flywheel-conventions` | Shared subagent rules (user-invocable: false) |
| `language-standards` | Language-specific standards (Python/TypeScript/SQL) |
| `plan-consolidation` | Merge review findings into actionable checklist |
| `plan-creation` | 7-phase planning with Context7 external validation |
| `plan-review` | All-reviewers parallel + conflict → Open Question |
| `ship` | Branch → commit → PR → invoke compound |
| `work-implementation` | Session + state + baseline files, Ralph mode, 3-Strike |
| `work-review` | All 6 reviewers parallel, plan compliance via baseline |

---

*End of research document.*
