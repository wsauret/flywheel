---
name: flywheel-conventions
description: Shared conventions for Flywheel subagents. Provides token limits, output format, severity definitions, and research patterns.
user-invocable: false
---

## Output Token Limits

- Locator agents: Max 500 words
- Analyzer agents: Max 750 words
- Research agents: Max 500 words
- Reviewer agents: Max 1,000 words

## Required Output Format

Return findings using compaction format:
- Paths only (never full file contents)
- Structured sections (End Goal, Approach, Key Findings, Files Identified)
- Flag ambiguities with "OPEN QUESTION:"

## Severity Definitions

- **P1 (Critical)**: Blocks deployment, security vulnerability, data loss risk
- **P2 (Important)**: Should fix before merge, affects functionality
- **P3 (Nice to have)**: Improvement suggestions, style nits

---

## Documentarian Mode (Research Agents)

All research agents (locators AND analyzers) operate in Documentarian Mode:

- Document what IS, not what SHOULD BE
- No suggestions, critiques, or recommendations
- No root cause analysis unless explicitly asked
- Pure technical mapping of the existing system

This keeps research output clean and compact, free of opinion pollution.

---

## File:Line Reference Discipline

All research output MUST include specific file:line references:

**Good**: `src/services/auth.ts:42-67` - Authentication middleware
**Bad**: "in the auth module" or "somewhere in handlers/"

Precise references enable navigation and reduce follow-up research.

---

## Read Files Fully

When analyzer agents read files:

- Use Read WITHOUT limit/offset parameters
- Read entire files, not partial excerpts
- Never guess about content you haven't read

Partial reads cause hallucination. Read fully once, not partially multiple times.

---

## Locator vs Analyzer Pattern

When spawning research agents:

1. **First pass: Locators** (parallel, cheap)
   - Use codebase-locator, pattern-locator, docs-locator
   - No Read tool - paths only
   - Model: haiku (fast, cheap)
   - Run in parallel

2. **Second pass: Analyzers** (targeted, expensive)
   - Only on top 15 findings from locators
   - Use codebase-analyzer, pattern-analyzer, docs-analyzer
   - Model: sonnet (thorough)
   - Documentarian mode

This two-pass approach reduces context usage by 40-60%.

---

## Research Agent Matrix

| Agent | Model | Tools | Purpose |
|-------|-------|-------|---------|
| codebase-locator | haiku | Grep, Glob, LS | Find WHERE files live |
| pattern-locator | haiku | Grep, Glob, LS | Find WHERE patterns exist |
| docs-locator | haiku | Grep, Glob, LS | Find WHERE docs live |
| web-searcher | haiku | WebSearch | Find URLs (no fetch) |
| codebase-analyzer | sonnet | Read, Grep, Glob | Understand HOW code works |
| pattern-analyzer | sonnet | Read, Grep, Glob | Extract code examples |
| docs-analyzer | sonnet | Read, Grep, Glob | Extract doc insights |
| web-analyzer | sonnet | WebFetch, Read | Deep web content analysis |

---

## Scope Discipline

Build only what's asked. These principles are defined in specific skills - this section consolidates references:

- **YAGNI ruthlessly**: `brainstorm/SKILL.md` (defer until needed)
- **No extras**: `work-implementation/SKILL.md` (don't add features beyond request)
- **Code simplicity**: `code-simplicity-reviewer` agent (post-implementation review)

When in doubt, do less. Premature abstraction costs more than duplication.

---

## Pre-Implementation Readiness

Before starting implementation, confirm readiness. See Pre-Flight Check in `work-implementation/references/verification-gates.md`.

Quick self-check: Problem understood? Approach fits patterns? No obvious duplicates?

---

## Input Context Discipline

When dispatching to subagents, minimize input tokens:

- **Agents WITH Read tool** (analyzers, reviewers): Pass file paths, not content. The agent can Read files itself.
- **Agents WITHOUT Read tool** (locators): Pass content inline — they cannot read files.
- **Plan excerpts in dispatch**: Paste only the current phase, not the entire plan.
- **Keep dispatched context under 100 lines** where possible.

**Exception:** `work-implementation` explicitly passes plan content (not paths) to subagents — this is correct because subagents start with fresh context and need the plan text.

---

## Token Efficiency: Input + Output

Flywheel controls token usage from both sides:

**Output controls** (existing):
- Word limits per agent tier: Locators 500, Analyzers 750, Reviewers 1000

**Input controls** (new):
- Skill core SKILL.md files kept under 200 lines; detail in `references/`
- Pass paths (not content) for Read-capable agents
- Phase-only excerpts in dispatch, not full plans
- Lazy-load references via "Read `references/X.md` before proceeding" directives

**Target**: 40-60% context utilization with both input and output contributing to efficiency.

---

## 3-Strike Error Protocol

When a subagent or operation fails:

**Attempt 1: Diagnose & Fix**
- Read error message carefully
- Identify root cause
- Apply targeted fix

**Attempt 2: Alternative Approach**
- If same error recurs, try different method/tool/approach
- NEVER repeat the exact same failing action

**Attempt 3: Broader Rethink**
- Question assumptions
- Search for solutions
- Consider whether the plan needs updating

**After 3 Failures: Escalate**
- Log all attempts in state file Error Log
- Explain what was tried to user
- Ask for guidance

### Error Log Table Format

Track errors in state file:

| Error | Attempt | Approach | Outcome |
|-------|---------|----------|---------|
| [error message] | 1 | [what you tried] | [result] |
