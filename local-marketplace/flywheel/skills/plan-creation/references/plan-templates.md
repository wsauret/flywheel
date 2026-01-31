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

## Problem Statement / Motivation

[Why this matters]

## Proposed Solution

[High-level approach]

## Technical Considerations

- Architecture impacts
- Performance implications
- Security considerations

## Acceptance Criteria

- [ ] Detailed requirement 1
- [ ] Detailed requirement 2
- [ ] Testing requirements

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

## Problem Statement

[Detailed problem analysis]

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

## Acceptance Criteria

### Functional Requirements

- [ ] Detailed functional criteria

### Non-Functional Requirements

- [ ] Performance targets
- [ ] Security requirements
- [ ] Accessibility standards

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
researchers:
  - repo-researcher
  - web-researcher
  - git-history-researcher
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
