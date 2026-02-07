# Verification Claims Guide

How to flag assumptions and external claims for later validation in plan-enrich.

## Purpose

During plan creation, you will encounter claims about external libraries, performance characteristics, version compatibility, and best practices. **Do NOT validate these yourself** — flag them for the plan-enrich verification phase.

## Claims to Verify Section Template

Add this section to the plan when any external assumptions are made:

```markdown
## Claims to Verify

The following assumptions should be validated in plan-enrich:

- [ ] "React Query supports offline persistence" - verify in docs
- [ ] "Redis pub/sub handles 10k connections" - verify performance claims
- [ ] "Next.js 14 has stable server actions" - verify version compatibility
```

## What Counts as a Claim

Flag anything that:
- References external library capabilities you haven't confirmed in the codebase
- Makes performance or scalability assertions
- Assumes version-specific features
- Cites best practices from external sources
- References API behavior not visible in existing code

## What Does NOT Need Flagging

- Patterns you observed directly in the codebase
- Conventions documented in CLAUDE.md or project READMEs
- Standard language features
- Information the user explicitly provided
