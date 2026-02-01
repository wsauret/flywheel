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
