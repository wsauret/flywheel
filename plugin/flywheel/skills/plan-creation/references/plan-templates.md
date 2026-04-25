# Plan Templates

Templates for different levels of plan detail. Choose based on complexity.

## MINIMAL (Quick Issue)

**Best for:** Simple bugs, small improvements, clear features

```markdown
[Brief problem/feature description]

## Acceptance Criteria

- [ ] Core requirement 1
- [ ] Core requirement 2

## Context

[Any critical information]

## MVP

### test.py
<!-- Intentionally test-first: write test before implementation -->

## References

- Related issue: #[issue_number]
- Documentation: [relevant_docs_url]
```

---

## MORE (Standard Issue)

**Best for:** Most features, complex bugs, team collaboration

```markdown
## Overview

[Comprehensive description]

## Desired End State

[Specification of what "done" looks like + how to verify it]

**Example:**
> When complete, users can reset their password via email. Verification: Run
> `make test` and manually test the "Forgot Password" flow in staging.

## Problem Statement / Motivation

[Why this matters]

## What We're NOT Doing

[Explicit out-of-scope items to prevent scope creep]

**Example:**
> - Not implementing social login (separate feature)
> - Not changing existing login flow
> - Not adding 2FA (future enhancement)

## Proposed Solution

[High-level approach]

### Implementation Steps (Test-First)

- [ ] **Step 1.1: Write tests for [behavior]**
- [ ] **Step 1.2: Implement [behavior]**
- [ ] **Step 1.3: Verify**: `make test` (and optionally `make lint`, `make typecheck`)

## Technical Considerations

- Architecture impacts
- Performance implications
- Security considerations

## Success Criteria

### Manual Verification (Acceptance Criteria)

- [ ] Feature works as expected in UI
- [ ] Performance acceptable under load
- [ ] Edge cases handled gracefully

## Success Metrics

[How we measure success]

## Dependencies & Risks

[What could block or complicate this]

## Open Questions

[Questions from research needing resolution - remove section if none]

- **[Question]**: Option A vs Option B (Source: [agent])

## References & Research

- Similar implementations: [file_path:line_number]
- Best practices: [documentation_url]
- Related PRs: #[pr_number]
```

---

## A LOT (Comprehensive Issue)

**Best for:** Major features, architectural changes, complex integrations

Uses all sections from MORE, plus these additional sections:

- **Desired End State** — Observable outcomes + automated/manual verification commands
- **What We're NOT Doing** — Explicit out-of-scope items with reasons
- **Technical Approach / Architecture** — Detailed technical design
- **Implementation Phases** — Multi-phase with test-first steps per phase (same pattern as MORE)
- **Alternative Approaches Considered** — Other solutions evaluated and why rejected
- **Success Criteria** — Automated verification (test/lint/typecheck/coverage), manual verification (functional + non-functional), quality gates
- **Risk Analysis & Mitigation**
- **Future Considerations**
- **Open Questions** — Table format: `| Question | Options | Source |`
- **References & Research** — Internal (file paths), External (docs URLs), Related (PRs/issues)

---

## Context File Template

File: `docs/plans/<plan-name>.context.md`

Purpose: Recovery artifact — lets downstream skills pick up key context without re-researching. Keep it lean.

```markdown
---
plan: <plan-filename>.md
created: <date>
feature: "<feature description>"
---

# Research Context: <Feature Name>

## Key File Paths

<list of specific file paths referenced in the plan, one per line>

## Patterns & Conventions

- [Key pattern or convention observed]

## Validation Summary

- **High-risk topics:** [list or "None"]
- **External research:** [Yes/No]
- **Issues found:** [list or "None"]

## Gotchas

- [Warning about patterns or pitfalls]
```
