---
name: plan-creation
description: Research codebase, validate external claims, and emit a work-ready spec.json for a new planning session. Single-pass creation with integrated validation via Context7 and locator/analyzer agents. Triggers on "create plan", "plan for", "write a plan". For exploratory requests where the user is unsure what to build, prefer brainstorm first. Once spec.json exists, use plan-review for evaluation or go straight to work. For a reviewed spec, use plan-consolidation to merge findings.
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

# Plan Creation Skill

Research the codebase, validate technical claims, and emit a work-ready `spec.json` in a single pass. Output validates against `flywheel/schemas/task-list.schema.json`.

## Core Principles

1. **Codebase reality first** — dispatch locators before hypothesizing patterns.
2. **Decisions, not code** — capture approach, boundaries, risks, test scenarios. Do not pre-write implementation code.
3. **Executable-from-day-one** — if you can't commit to concrete file paths or test scenarios, surface an `open_question` instead of a vague task.
4. **BLOCKING: Validate high-risk claims** — security, payments, crypto, migrations, privacy trigger external validation via Context7.

## Input

Feature description via `$ARGUMENTS`. If empty, ask user.

---

## Phase 0: Check for Existing Knowledge

Before codebase research, check existing knowledge (skip missing dirs):

1. **Standards** (`docs/standards/`) — Search by tags for reusable patterns.
2. **Solutions** (`docs/solutions/`) — Verified fixes from past work (up to 5 matches).
3. **Research** (`docs/research/`) — Recent research within 30 days:
   ```bash
   find docs/research -name "*<topic-keywords>*" -mtime -30 2>/dev/null | head -3
   ```

If relevant knowledge found, use it as starting point for Phase 1. Note findings in `context.md`.

---

## Phase 1: Understand Codebase Context

**BLOCKING:** Do NOT use Read/Grep/Glob for TARGET CODEBASE research — dispatch locator Tasks first, then feed results to analyzer Tasks. Skill references, plan artifacts, and template files are exempt.

1. **Locate (parallel):** Run locator-codebase, locator-patterns, locator-docs Tasks simultaneously. Paths only.
2. **Analyze:** Feed top 10-15 paths into an analyzer-codebase Task. Flag OPEN QUESTIONS.
3. **Also check:** `CLAUDE.md` for team conventions; recent similar features for precedent.
4. **Consolidate:** File paths with line numbers, existing patterns, team conventions, open questions.

Read `references/research-dispatch.md` before proceeding (Task dispatch templates for locators, analyzer, DRY/integration checks).

---

## Phase 1.5: Research Validation Gate

**BLOCKING:** Verify codebase research quality before drafting.

1. **File paths exist**: Spot-check 3-5 referenced paths
2. **Patterns identified**: Found relevant existing implementations?
3. **Conventions clear**: Know how this codebase handles similar features?
4. **DRY checked**: No proposed work duplicates existing code?

Minor gaps → note in `open_questions`. Significant gaps (no similar patterns) → ask user. Max 2 re-research attempts.

---

## Phase 2: Validate External Claims

Verify technical claims before they become plan assumptions. Only runs when high-risk topics detected.

Read `references/validation-research.md` before proceeding (high-risk keyword heuristic, Context7 workflow, dispatch templates).

Scan draft plan for high-risk keywords (security, payments, crypto, migrations, privacy). If any found → run external validation. Else skip.

When triggered:

1. **Framework Docs Validation** — Verify claimed library features via Context7
2. **Version Compatibility** — Check for breaking changes and deprecations
3. **Best Practices** — Look up recommended patterns

Incorporate findings into the spec. Flag `CLAIM_INVALID` or `VERSION_ISSUE` as `open_questions` if they change the approach.

---

## Phase 3: Compose and Write Artifacts

Spec is a structured JSON document validated against `flywheel/schemas/task-list.schema.json`. Namespace: plugin uses `.flywheel/plugin/sessions/`.

### Step 1: Derive session id

Format: `<slug>-<YYYY-MM-DD>` (kebab-case slug). If collision, append `-2`, `-3`, … See `references/formatting-guide.md` for the full pattern.

### Step 2: Create session directory

```bash
mkdir -p .flywheel/plugin/sessions/<session-id>
```

### Step 3: Synthesize phases and tasks

- Each phase has one clear purpose (Single Responsibility)
- Extract shared setup into an early foundation phase
- Order test steps before implementation steps within each task
- Assign concrete repo-relative file paths from locator/analyzer findings

### Step 4: Enumerate test scenarios per task

Every task lists concrete test scenarios — sentences an implementer could turn directly into test cases. If you can't write one, surface an `open_question`.

### Step 5: Compose `behavioral_contract[]`

- BC id pattern: `BC-<AREA>-<NNN>` (e.g. `BC-AUTH-001`)
- Each BC has `title`, `description`, `evidence`, `area`
- Assign `fulfills[]` arrays to the tasks that claim each BC

### Step 6: Spec Quality Bar gate

Apply the Spec Quality Bar from `flywheel-conventions`. Verify: clear file paths, enumerated test scenarios, explicit verification commands, clear dependencies, BC coverage (at-least-one task claim per BC; orphans = error per D13). Unresolved uncertainty → `open_questions[]`, not vague tasks.

### Step 7: Write `spec.json`

Path: `.flywheel/plugin/sessions/<session-id>/spec.json`

Required top-level fields: `schema_version: 1`, `plan_id`, `summary` (100–5000 chars), `goal`, `origin`, `context`, `behavioral_contract`, `phases`, `success_criteria`. See `flywheel/schemas/task-list.schema.json` for the authoritative shape.

**BLOCKING: `context` must use the schema shape** — not a free-form object. Exactly three arrays:

```json
{
  "key_files": ["scratch-app/app.py — Flask app + route handler", "scratch-app/tests/test_hello.py — pytest case"],
  "patterns": ["Flask route decorator for minimal HTTP handlers", "Flask test client in pytest for route coverage"],
  "gotchas": ["Green-field repo: pip must be installed before running tests"]
}
```

Narrative research (stack choice, rationale, codebase survey) belongs in the `context.md` sidecar (Step 8), NOT in spec.json's `context` block.

**BLOCKING: `phases[].tasks[]` must use the schema shape**. No extra fields — `additionalProperties: false` rejects anything unknown. Each phase shape:

```json
{
  "id": "phase-1",
  "goal": "Land the hello route and a smoke test.",
  "depends_on": [],
  "files": ["scratch-app/app.py", "scratch-app/tests/test_hello.py"],
  "tasks": [
    {
      "id": "t1",
      "description": "Create Flask app with GET /hello returning 'hello world'.",
      "files": ["scratch-app/app.py"],
      "test_scenarios": [
        "GET /hello returns 200 with body 'hello world'",
        "POST /hello returns 405 method not allowed"
      ],
      "fulfills": ["BC-HELLO-001"]
    }
  ],
  "verification": "cd scratch-app && pytest tests/test_hello.py -q",
  "manual_verification": null
}
```

**BLOCKING: DO NOT** add `name`, `verification_commands`, or any other field to a task — the schema rejects them. Use `description` for the narrative; put verification at the phase level, not the task level. `test_scenarios[]` are plain strings (one scenario per entry; include expected behavior in the string). `files[]` entries are plain repo-relative paths (no " (new)" suffixes, no annotations).

**Origin block on creation:**

```json
{
  "created_by": "plan-creation",
  "findings_path": null
}
```

### Step 8: Write `context.md` sidecar

Path: `.flywheel/plugin/sessions/<session-id>/context.md`

Record research findings as structured prose with `research-date` and `codebase-version` metadata for staleness tracking. Kept outside spec.json so the spec stays machine-consumable.

### Step 9: Write `session.json`

Path: `.flywheel/plugin/sessions/<session-id>/session.json`

Fields: `schema_version: 1`, `session_id`, `slug`, `status: "active"`, `started_at` (ISO 8601), `last_checkpoint_at: null`, `active_skill: "plan-creation"`, `baseline_hash: null`. On exit, set `active_skill: null`.

### Step 10: Update `.flywheel/plugin/active.json`

```json
{ "schema_version": 1, "session_id": "<session-id>" }
```

### Step 11: Print summary

Print the spec's `summary` field + next-steps hint.

---

## Phase 4: Present & Next Steps

**AskUserQuestion:** "Spec ready at `.flywheel/plugin/sessions/<id>/spec.json`. What next?"

| Option | Action |
|--------|--------|
| Run review (Recommended) | Invoke `skill: plan-review` |
| Proceed to work | Invoke `skill: work-implementation` |
| Done for now | Display path and exit |

---

## Error Handling

- **Agent failure:** Log and continue with available findings
- **Missing CLAUDE.md:** Note conventions may be incomplete
- **No similar patterns found:** Ask user for guidance on approach
- **Context7 failure:** Fall back to WebSearch for external validation
- **Write failure:** Create `.flywheel/plugin/sessions/<id>/` with `mkdir -p`, report errors
- **Session id collision past `-9`:** Error out — user probably has a stuck session

---

## Anti-Patterns

- **BLOCKING: Write code** — research and planning ONLY. If tempted to code, add it to the spec instead
- **Skip codebase research** — even "simple" features benefit from understanding patterns
- **Read target codebase files directly instead of dispatching analyzers** — use the locate→analyze pattern
- **Skip locators and go straight to analyzers with assumed paths** — locators discover; analyzers analyze
- **Emit a vague task instead of an open_question** — surface uncertainty
- **Omit file references** — include paths (never absolute)
- **Skip AskUserQuestion** — user must choose next step
- **BLOCKING: Skip external validation for high-risk topics** — security, payments, migrations MUST be validated against docs
- **Run external validation for everything** — only high-risk topics warrant the token cost
- **BLOCKING: Emit an orphan BC** — every BC needs at-least-one task claim (D13)

---

## Detailed References

- `references/research-dispatch.md` — Full Task dispatch templates for Phase 1 locate/analyze/DRY/integration pattern
- `references/validation-research.md` — High-risk heuristic, Context7 workflow, external validation dispatch templates
- `references/formatting-guide.md` — Session id format, directory layout, artifact filenames, collision behavior
