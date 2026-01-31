---
name: flywheel-conventions
description: Shared conventions for Flywheel subagents. Provides token limits, output format, and severity definitions.
user-invocable: false
---

## Output Token Limits

- Research agents: Max 500 words
- Analysis agents: Max 750 words
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
