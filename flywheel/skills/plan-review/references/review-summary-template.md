# Review Summary Template

Append this to the plan file after reviewing.

## Plan Review Summary Section

```markdown

---

# Plan Review Summary

**Plan:** [plan_path]
**Reviewed:** [date]
**Agents run:** [count] | **Responded:** [count]

## Findings Overview

| Priority | Count | Status |
|----------|-------|--------|
| P1 (Critical) | [n] | BLOCKS APPROVAL |
| P2 (Important) | [n] | Should address |
| P3 (Nice-to-have) | [n] | Optional |

## Open Questions (Requires User Decision)

**Questions flagged by reviewers and conflicts between reviewers. These MUST be resolved during consolidation before implementation.**

| # | Question | Options | Source(s) |
|---|----------|---------|-----------|
| 1 | [Question from reviewer] | A: [option], B: [option] | [agent name] |
| 2 | [Conflict between agents] | A: [agent A view], B: [agent B view] | [both agents] |
| 3 | [Trade-off identified] | A: [choice], B: [choice] | [agent name] |

**Total Open Questions:** [count from individual agents] + [count from conflicts] = [total]

## Conflicts Between Reviewers (Converted to Open Questions Above)

[List each conflict briefly - full details are in the Open Questions section]

- **[Topic]**: [Agent A] vs [Agent B] → Open Question #[n]
- **[Topic]**: [Agent A] vs [Agent B] → Open Question #[n]

## P1 Findings (BLOCKS APPROVAL)
[List each with full details]

## P2 Findings (Important)
[List each]

## P3 Findings (Nice-to-have)
[List each]

## Agent Coverage
**Provided findings:** [agent]: [count], ...
**No findings:** [agent]: "Looks good from [perspective]"
**Failed:** [agent]: [error]
```

---

## Priority Classification

| Priority | Meaning | Effect |
|----------|---------|--------|
| **P1 (Critical)** | Security vulnerabilities, data corruption risks, fundamental design flaws | BLOCKS approval |
| **P2 (Important)** | Performance issues, architectural concerns, maintainability problems | Should address |
| **P3 (Nice-to-have)** | Style suggestions, minor optimizations, documentation gaps | Optional |

---

## Deduplication Format

### Identical Findings
Same section + same issue + same action:

```markdown
### Finding 1: [Title]
**Priority:** P1 (Critical)
**Sources:** reviewer-architecture, reviewer-performance (2 agents)
**Location:** Section 3 - Database Schema
[Merged description]
```

### Similar Findings
Related topic, different specifics:

```markdown
### Theme: Performance Concerns
1. **Query optimization** (reviewer-performance): [Concern]
2. **Caching strategy** (reviewer-architecture): [Related concern]
```

### Unique Findings
Preserve standalone:

```markdown
### Finding 3: [Unique Finding]
**Priority:** P3
**Source:** reviewer-architecture
[Description]
```


