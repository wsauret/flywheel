---
name: language-standards
description: Language-specific standards and idioms for Python, TypeScript, and SQL. Load when reviewing, implementing, or debugging code to apply the right conventions for the language at hand.
user-invocable: false
---

## Purpose

Provides language-specific guidance for any agent that needs to understand or enforce coding standards. This is not limited to code review -- use it whenever language idioms, patterns, or pitfalls are relevant.

## When to Load This Skill

- **Reviewing code**: Apply language standards as part of quality, performance, pattern, or architecture review
- **Implementing features**: Follow language idioms and conventions when writing new code
- **Debugging**: Reference common pitfalls and anti-patterns to identify root causes faster
- **Planning**: Understand language constraints and patterns when designing solutions

## Language Dispatch

Identify the primary language(s) involved, then read the corresponding reference(s):

| Language | Reference | Key Topics |
|----------|-----------|------------|
| Python | `references/python.md` | Type hints, pythonic patterns, testing, performance, anti-patterns |
| TypeScript | `references/typescript.md` | Type safety, modern patterns, testing, performance, anti-patterns |
| SQL | `references/sql.md` | Query structure, performance, safety, schema design, migration patterns |

## Usage Rules

- **Read only what you need** -- do not load all references preemptively
- **Multi-language code**: If code spans languages (e.g., Python with SQL queries, TypeScript API with SQL), read all applicable references
- **Focus by mode**: Each reference has sections organized by concern. Skim the full reference but focus on the sections relevant to your current task (e.g., a performance reviewer should focus on Performance sections, a debugger on Anti-Patterns)
