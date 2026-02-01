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

## Technical Considerations

- Architecture impacts
- Performance implications
- Security considerations

## Success Criteria

### Automated Verification

- [ ] Tests pass: `make test`
- [ ] Linting passes: `make lint`
- [ ] Type checking passes: `make typecheck`

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

```markdown
## Overview

[Executive summary]

## Desired End State

[Specification of what "done" looks like + how to verify it]

**What complete looks like:**
- [Observable outcome 1]
- [Observable outcome 2]

**How to verify:**
- Automated: `make test && make lint`
- Manual: [Specific test scenarios]

## Problem Statement

[Detailed problem analysis]

## What We're NOT Doing

[Explicit out-of-scope items to prevent scope creep and set clear boundaries]

- [Out-of-scope item 1] - [brief reason]
- [Out-of-scope item 2] - [brief reason]
- [Future enhancement] - [why deferred]

## Proposed Solution

[Comprehensive solution design]

## Technical Approach

### Architecture

[Detailed technical design]

### Implementation Phases

#### Phase 1: [Foundation]

- Tasks and deliverables
- Success criteria
- Estimated effort

#### Phase 2: [Core Implementation]

- Tasks and deliverables
- Success criteria
- Estimated effort

#### Phase 3: [Polish & Optimization]

- Tasks and deliverables
- Success criteria
- Estimated effort

## Alternative Approaches Considered

[Other solutions evaluated and why rejected]

## Success Criteria

### Automated Verification

- [ ] Unit tests pass: `make test`
- [ ] Integration tests pass: `make test-integration`
- [ ] Linting passes: `make lint`
- [ ] Type checking passes: `make typecheck`
- [ ] Coverage meets threshold: `make coverage`

### Manual Verification (Acceptance Criteria)

#### Functional Requirements

- [ ] Detailed functional criteria
- [ ] User flow works end-to-end

#### Non-Functional Requirements

- [ ] Performance targets met under load
- [ ] Security requirements verified
- [ ] Accessibility standards met

### Quality Gates

- [ ] Test coverage requirements
- [ ] Documentation completeness
- [ ] Code review approval

## Success Metrics

[Detailed KPIs and measurement methods]

## Dependencies & Prerequisites

[Detailed dependency analysis]

## Risk Analysis & Mitigation

[Comprehensive risk assessment]

## Resource Requirements

[Team, time, infrastructure needs]

## Future Considerations

[Extensibility and long-term vision]

## Documentation Plan

[What docs need updating]

## Open Questions

[Questions identified during research that need resolution before implementation]

| Question | Options | Source |
|----------|---------|--------|
| [Question from research] | A: [option], B: [option] | [which agent flagged it] |
| [Trade-off identified] | A: [approach], B: [approach] | [source] |

## References & Research

### Internal References

- Architecture decisions: [file_path:line_number]
- Similar features: [file_path:line_number]
- Configuration: [file_path:line_number]

### External References

- Framework documentation: [url]
- Best practices guide: [url]
- Industry standards: [url]

### Related Work

- Previous PRs: #[pr_numbers]
- Related issues: #[issue_numbers]
- Design documents: [links]
```

---

## Context File Template

File: `plans/<plan-name>.context.md`

```markdown
---
plan: <plan-filename>.md
created: <date>
feature: "<feature description>"
research_date: <date>
codebase_version: <git commit hash when research was done>
researchers:
  - codebase-locator
  - codebase-analyzer
  - pattern-locator
  - pattern-analyzer
  - docs-locator
  - docs-analyzer
---

# Research Context: <Feature Name>

## File References

<list of specific file paths, one per line>

## Naming Conventions

- [Convention type]: [pattern observed]

## External Research

### Framework Documentation

- [URL with description]

### Best Practices

- [Best practice with source]

## Gotchas & Warnings

- [Warning about patterns or pitfalls]

## Open Questions from Research

[Questions flagged by research agents that need user decision]

- **[Question]**: [Options if applicable] (Source: [agent])

## Research Quality

- **Confidence**: High/Medium/Low
- **Last verified**: <date>
```
