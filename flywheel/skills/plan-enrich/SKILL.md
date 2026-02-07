---
name: plan-enrich
description: Single-pass verification AND enrichment of implementation plans. Validates claims against framework docs, checks for DRY violations, confirms compatibility, and adds research insights. Triggers on "enrich plan", "verify plan", "validate plan", "deepen plan".
allowed-tools:
  - Read
  - Write
  - Grep
  - Glob
  - Bash
  - Task
  - Skill
---

# Plan Enrich Skill

Verify AND enrich implementation plans in a single pass. Two modes:
- **Internal Research** - Does this already exist? DRY violations? Fits existing patterns?
- **External Research** - Do claimed features exist? Best practices? Framework docs?

**Philosophy:** Validate before implementing. Bad assumptions in plans become bad code. Enrich with research insights to improve implementation quality.

## Input

Plan path via `$ARGUMENTS`. If empty, ask user.

---

## Phase 0: Discover Existing Knowledge

Search in priority order (highest confidence first):

**0a. Standards** (`docs/standards/`) — Pre-validated reusable patterns. Extract keywords from the plan, search standards by tags and `applies_to` fields. Load matching standards as context.

**0b. Solutions** (`docs/solutions/`) — Verified fixes from past work. Search solution files and auto-integrate the top 5 matches via subagents.

**0c. Research** (`docs/research/`) — Recent investigations (may be stale). Check for relevant research within 14 days:
```bash
find docs/research -name "*<topic-keywords>*" -mtime -14 2>/dev/null | head -3
```

Read `references/internal-research.md` before proceeding -- it contains the subagent dispatch template and learnings integration table format (see "Phase 0: Learnings Discovery" section).

Skip any directory that doesn't exist.

---

## Phase 1: Parse Plan and Extract Claims

Read the plan and identify three categories:

1. **Technical Claims** -- statements that require validation (e.g., "Use [library] for [feature]", "[Framework] provides [capability]")
2. **Implementation Scope** -- technologies, components to build/modify, file paths referenced
3. **Research Questions** -- convert claims into specific questions tagged as internal or external (e.g., "Does React Query support offline persistence?" = external; "Do we already have a caching layer?" = internal)

---

## Phase 2: Internal Research (Codebase)

**Goal:** Prevent reinventing wheels and breaking patterns. Run all internal research in parallel.

**Before dispatching:** If Phase 0a loaded existing research, use it to scope the internal research — skip areas already covered, focus on gaps.

| Subsection | Purpose | Flag on Finding |
|------------|---------|-----------------|
| 2.1 Locate Existing Solutions | Find WHERE relevant code lives (cheap) | -- |
| 2.2 Analyze Findings | Assess reuse/extension/conflict (targeted) | `EXISTING_SOLUTION`, `PATTERN_CONFLICT` |
| 2.3 DRY Violation Check | Detect proposed code that duplicates existing | `DRY_VIOLATION` |
| 2.4 Integration Impact Check | Identify what else touches affected files | `INTEGRATION_RISK` |

Read `references/internal-research.md` before proceeding -- it contains all dispatch templates for codebase-locator, pattern-locator, codebase-analyzer, pattern-analyzer, and integration impact subagents.

---

## Phase 3: External Research (Documentation & Best Practices)

**Goal:** Validate claims and add best practices. Only run when high-risk topics are detected.

Read `references/external-research.md` before proceeding -- it contains the research decision heuristic (keyword scan), dispatch templates for all four subsections, and quarantine rules.

**Subsections (when triggered):**

| Subsection | Purpose | Flag on Finding |
|------------|---------|-----------------|
| 3.1 Framework Docs Validation | Verify claimed library features via Context7 | `CLAIM_INVALID` |
| 3.2 Best Practices Research | Locate then analyze recommended patterns | -- |
| 3.3 Version Compatibility | Check for breaking changes and deprecations | `VERSION_ISSUE` |
| 3.4 Alternative Approaches | Compare trade-offs of technical decisions | -- |

**3.5 Quarantine:** All external results go in a separate "External Research (Unverified)" section. Never integrate external code directly into implementation steps.

Run all external research in parallel.

---

## Phase 4: Per-Section Research

**Goal:** Deep-dive codebase research for each major plan section (up to 5) using isolated subagents.

Read `references/internal-research.md` before proceeding -- it contains the section identification rules, per-section subagent dispatch template, and integration format (see "Phase 4: Per-Section Research Dispatch" section).

Collect summaries from all subagents and organize by section with patterns found, relevant files, and testing approach.

---

## Phase 5: Synthesize Findings

Wait for all research agents. Categorize findings as Blockers, Warnings, or Enhancements. Generate open questions from conflicts. Deduplicate across sources.

Read `references/enhancement-format.md` before proceeding -- it contains the finding categorization guide, open questions format, and deduplication rules (see "Phase 5: Synthesize Findings" section).

---

## Phase 6: Enhance Plan Sections

For each section in the original plan, add research insights (claims validated, issues found, best practices, code examples, references). **Never modify original content -- only add research sections.**

Read `references/enhancement-format.md` before proceeding -- it contains the per-section enhancement template, the before/after example, and the enhancement summary template to place at the top of the plan.

---

## Phase 6.5: Standards Inference (Optional)

After all research is complete, check if a strong recurring pattern emerged that multiple plan sections rely on. If so:

**AskUserQuestion:** "Research found a recurring pattern: [description]. Capture as a reusable standard in `docs/standards/`?"
- **Yes** — Draft standard per `docs/standards/README.md` format, user confirms content
- **Skip (Recommended)** — Continue without creating a standard

Only suggest when the pattern is clearly reusable across projects, not just repeated within this plan.

---

## Phase 7: Write and Present

1. Back up the plan file, then write the enhanced plan back to the SAME path
2. Append research coverage stats to `[plan_path].context.md`
3. Present options: run `plan-review` (recommended) or exit

Read `references/enhancement-format.md` before proceeding -- it contains the write/present details and the context file update format (see "Phase 7: Write and Present" section).

---

## Error Handling

- **Agent failure:** Log and continue; require 50% success minimum
- **Context7 failure:** Fall back to WebSearch
- **No docs/solutions:** Skip learnings phase
- **Write failure:** Display content, suggest alternative save

---

## Anti-Patterns

- **Skipping internal research** - External best practices mean nothing if we already have a solution
- **Not validating claims** - "Library X supports Y" must be verified in docs
- **Modifying original content** - Only ADD research sections
- **Resolving conflicts yourself** - Convert to Open Questions for user

---

## Detailed References

| Reference | Contents | When to Read |
|-----------|----------|--------------|
| `references/internal-research.md` | Codebase search patterns, dispatch templates for Phases 0/2/4, DRY/pattern/integration checks, internal research checklist | Before Phases 0, 2, 4 |
| `references/external-research.md` | Research decision heuristic, high-risk keyword list, Context7 and web research dispatch templates, quarantine rules, external research checklist | Before Phase 3 |
| `references/external-cache.md` | Cache format spec, TTL logic, cache-check procedure for Context7/web results | Before Phase 3 (cache check) |
| `references/enhancement-format.md` | Enhancement summary template, per-section validation template, finding categorization, open questions format, write/present details, quarantine template | Before Phases 5, 6, 7 |
