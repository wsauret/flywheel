---
name: fly:research
description: Conduct comprehensive codebase research using locate→analyze pattern. Creates persistent research documents.
argument-hint: "[research question or topic]"
---

# Codebase Research Command

**MANDATORY FIRST ACTION — You MUST use the Skill tool to invoke the skill below BEFORE doing anything else. Do NOT read files, search code, or respond to the user first.**

**Invoke the codebase-research skill:**

```
skill: codebase-research
arguments: $ARGUMENTS
```

<input> #$ARGUMENTS </input>

## Quick Reference

This command conducts comprehensive research using a two-phase approach:

1. **Phase 1: Locate (parallel, cheap)** - Find WHERE things are
   - codebase-locator: Find file paths
   - pattern-locator: Find pattern locations
   - docs-locator: Find documentation
   - (optional) web-searcher: Find URLs

2. **Phase 2: Analyze (targeted, expensive)** - Understand HOW things work
   - Only analyze top findings from Phase 1
   - Documentarian mode: document what IS, not what SHOULD BE

3. **Phase 3: Persist** - Create research document
   - Saved to `docs/research/YYYY-MM-DD-<topic>.md`
   - Reusable by future planning sessions

## When to Use

- Before `/fly:plan` for complex features
- Pure exploration ("how does X work?")
- Understanding unfamiliar codebases
- Documenting system behavior

## Example Usage

```bash
# Research a specific topic
/fly:research authentication flow

# Research a library integration
/fly:research how Stripe payments work

# Exploratory research
/fly:research what patterns are used for error handling
```

## Output

Creates a persistent research document at `docs/research/` that can be:
- Used directly for understanding
- Fed into `/fly:plan` for implementation planning
- Referenced in future sessions
