---
name: codebase-research
description: "Conduct comprehensive codebase research producing a persistent document. Use when you need to understand something BEFORE planning, or for pure exploration."
user-invocable: true
triggers: ["research", "investigate", "explore codebase"]
allowed-tools:
  - Read
  - Write
  - Grep
  - Glob
  - Bash
  - Task
  - AskUserQuestion
---

# Codebase Research Skill

Conduct comprehensive research using a two-phase locate-then-analyze approach that reduces context usage by 40-60%.

## Philosophy: Documentarian Mode

- Document what IS, not what SHOULD BE
- No suggestions, critiques, or recommendations
- Pure technical mapping of the existing system
- Focus on paths and references, not full file contents

---

## Input

Research question via `$ARGUMENTS`. If empty, ask user.

---

## Phase 0: Check for Existing Research

Before starting new research, check if recent research already covers this topic:

```bash
find docs/research -name "*<topic-slug>*" -mtime -14 2>/dev/null | head -3
```

If matches found, read the YAML frontmatter (`topic`, `tags`) to assess relevance. If a strong match exists:

**AskUserQuestion:** "Found recent research: `[filename]` ([N] days old). Reuse, refresh, or start new?"
- **Reuse (Recommended)** — Read existing doc, skip to Phase 4 (present)
- **Refresh** — Use existing doc as starting point, re-run locate/analyze to update
- **Start new** — Proceed normally

If no matches or no `docs/research/` directory, proceed to Phase 1.

---

## Phase 1: Locate (Parallel, Cheap)

Spawn locator agents in parallel (haiku model) to find files, patterns, and docs related to the topic. Each returns paths/references only — no file contents. Optionally spawn a web-searcher for external library topics.

Locators: `codebase-locator`, `pattern-locator`, `docs-locator`, `web-searcher` (optional).

Read `references/locate-analyze-dispatch.md` before proceeding — it contains the full dispatch templates with parameters and constraints for all locators.

**IMPORTANT**: Run all locators in parallel (single message, multiple Task calls). Wait for all to complete.

---

## Phase 1b: Synthesize Locator Results

Deduplicate paths across locators, rank by relevance (multi-locator hits rank higher), and select the top findings for deep analysis. Skip analyzer phase if total findings < 10.

Read `references/locate-analyze-dispatch.md` before proceeding — the "Ranking & Selection" section specifies exact selection counts per analyzer.

---

## Phase 2: Analyze (Targeted, Expensive)

Spawn analyzer agents (sonnet model) on TOP FINDINGS ONLY from Phase 1b. Each analyzer reads the actual files/URLs and extracts structured findings in documentarian mode.

Analyzers: `codebase-analyzer`, `pattern-analyzer`, `docs-analyzer`, `web-analyzer` (optional).

Read `references/locate-analyze-dispatch.md` before proceeding — it contains the full dispatch templates with parameters and constraints for all analyzers.

**IMPORTANT**: Run analyzers in parallel where possible. Wait for all to complete.

---

## Phase 3: Synthesize & Persist

Write findings to `docs/research/YYYY-MM-DD-<topic-slug>.md`. Optionally git-commit the research document.

Read `references/research-document-template.md` before proceeding — it contains the full output document format with YAML frontmatter, all required sections, and the git commit template.

---

## Phase 4: Present & Offer Next Steps

Display a summary to the user (not the full document). Offer three options: create a plan from the research, continue researching, or exit.

Read `references/research-document-template.md` before proceeding — the "Present & Offer Next Steps" section contains the AskUserQuestion format and option-action mapping.

---

## Integration: Called by Other Skills

Other skills can check for recent research before starting work, and invoke this skill if none exists.

Read `references/research-document-template.md` before proceeding — the "Integration" section contains the bash lookup pattern for finding existing research.

---

## Context Budget

This skill is context-heavy. Monitor usage:

- **After Phase 1**: If >30 locator results, consolidate before Phase 2
- **After Phase 2**: Write findings immediately, don't hold in context
- **Always**: Prefer file:line references over quoting code

---

## 2-Action Rule for Visual Content

After ANY 2 of these operations:
- WebFetch
- Browser tool use
- Image viewing
- Search results review

**IMMEDIATELY** persist findings to the research document as text.

Visual/multimodal content doesn't persist well in context. Capture it as text before it's lost.

---

## Anti-Patterns

- **Skip locator phase** — Don't go straight to analyzers
- **Analyze everything** — Only analyze top findings from locators
- **Make suggestions** — This is documentation, not consultation
- **Return file contents** — Paths and references only
- **Forget to persist** — Always write research document
- **Hold in context** — Write to file, reference by path
