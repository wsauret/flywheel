---
name: flywheel-conventions
description: Shared conventions for Flywheel subagents. Tool discipline, output format, research patterns.
user-invocable: false
---

## Tool Discipline

**Never use Bash for operations that have a dedicated tool.**

- **Content search**: Use **Grep**, not `grep`/`rg` via Bash
- **File search**: Use **Glob**, not `find`/`ls` via Bash
- **File reading**: Use **Read**, not `cat`/`head`/`tail` via Bash

Bash is only for: git commands, `bun` commands, and system operations with no dedicated tool.

---

## Output Rules

**Limits**: Locators 500 words. Analyzers 1500. Reviewers 1500.

**Format**: Structured sections (End Goal, Key Findings, Files Identified). Paths only, never file contents. Flag ambiguities with "OPEN QUESTION:".

**Severity**: P1 = blocks deploy / security / data loss. P2 = fix before merge. P3 = suggestion.

**References**: Always `path/to/file.ts:42-67`, never "in the auth module."

---

## Research Agent Behavior

**Documentarian mode** (locators + analyzers): Document what IS, not what SHOULD BE. No suggestions, critiques, or recommendations.

**Read files fully**: Use Read WITHOUT limit/offset. Partial reads cause hallucination.

---

## Dispatch Patterns (for orchestrators)

### Locator → Analyzer (two-pass research)

1. **Locators first** — run in parallel
   - `locator-codebase`, `locator-patterns`, `locator-docs` (haiku)
   - `locator-web` (sonnet — query crafting needs stronger reasoning)
   - No Read tool — return paths/URLs only
   - Pass search context inline (locators can't read files)

2. **Analyzers second** — targeted, use sonnet
   - `analyzer-codebase`, `analyzer-patterns`, `analyzer-docs`
   - Feed only the top 15 findings from locators
   - Pass file paths, not content (analyzers have Read)
   - Documentarian mode — no suggestions

### Model inheritance

Implementation subagents (`general-purpose`, `Explore`, `Plan`) inherit the parent model — never set `model`. Only research agents (locators, analyzers) use explicit models.

### Input context

Pass file paths (not content) to Read-capable agents. Content inline to locators. Phase-only plan excerpts, not full plans. Under 100 lines where possible.

---

## Error Protocol

3 strikes then escalate:
1. **Diagnose** — read error, identify root cause, targeted fix
2. **Alternative** — different method/tool/approach. Never repeat same failing action.
3. **Rethink** — question assumptions, search for solutions
4. **Escalate** — log attempts, explain to user, ask for guidance
