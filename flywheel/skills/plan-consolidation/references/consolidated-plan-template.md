# Consolidated Plan Template

Use this structure for the final consolidated output.

```markdown
# [Plan Title]

## Status
- **Created:** [date from original plan]
- **Reviewed:** [date from Review Summary]
- **Consolidated:** [today's date]
- **Ready for:** /fly:work

## Executive Summary

[1-2 paragraph synthesis of what this plan accomplishes. Pull from original plan overview, enhanced with key review findings.]

## Decisions Made

[Questions resolved during consolidation - only include if questions were asked]

| Decision | Choice | Rationale |
|----------|--------|-----------|
| [Topic 1] | [Option chosen] | [User preference / Delegated to assistant] |
| [Topic 2] | [Option chosen] | [Rationale] |

## Critical Items Before Implementation

[Only include this section if P1 findings or unresolved conflicts exist]

### P1 Findings (MUST Address)
- **[Finding title]** (Source: [agent])
  - Issue: [Description]
  - Resolution: [How it's addressed in the checklist below, OR "BLOCKS IMPLEMENTATION"]

### Unresolved Conflicts
- **[Topic]**
  - Option A: [Description] (Supported by: [agents])
  - Option B: [Description] (Supported by: [agents])
  - **Decision needed before:** [Which phase this blocks]

## Implementation Checklist

### Phase 1: [Name]

- [ ] **Step 1.1: [Concrete action]**
  - Review note: [If any finding applies to this step]
  - Code reference: [If a code example applies]

- [ ] **Step 1.2: [Concrete action]**
  - Anti-pattern to avoid: [Specific warning]
  - Edge case: [What to handle]

- [ ] **Step 1.3: Verify — Tests pass for this phase**

### Phase 2: [Name]

- [ ] **Step 2.1: [Concrete action]**
  [Continue pattern...]

- [ ] **Step 2.2: Verify — Tests pass for this phase**

### Phase 3: [Name]

- [ ] **Step 3.1: [Concrete action]**
  [Continue pattern...]

- [ ] **Step 3.2: Verify — Tests pass for this phase**

## Technical Reference

### Best Practices to Follow

[Consolidated from plan content and review findings - deduplicated, organized by topic]

1. **[Topic 1]**
   - [Practice] (Source: [agent/section])

2. **[Topic 2]**
   - [Practice] (Source: [agent/section])

### Anti-Patterns to Avoid

[Consolidated from review findings]

1. **[Anti-pattern]**: [Why it's problematic]
2. **[Anti-pattern]**: [Why it's problematic]

### Code Examples

[Key code snippets from plan, organized by topic]

**[Topic/Purpose]:**
```[language]
// [File path where this would go]
[code example]
```

### Security Considerations

- [ ] [Security item 1]
- [ ] [Security item 2]

### Performance Considerations

- [ ] [Performance item 1]
- [ ] [Performance item 2]

## Review Findings Summary

### Addressed in Plan

| Finding | Priority | Resolution | Checklist Location |
|---------|----------|------------|-------------------|
| [Finding] | P1 | [How addressed] | Phase X, Step Y |
| [Finding] | P2 | [How addressed] | Phase X, Step Y |

### Deferred Items

[P3 items that are nice-to-have but not blocking]

- **[P3 Finding]**: [Why deferred] - Consider for future iteration

### Resolved Conflicts

- **[Topic]**: Chose [Option X] because [rationale]

---

## Appendix: Raw Review Data

<details>
<summary>Original Review Summary</summary>

[Copy the Plan Review Summary section from reviewing verbatim]

</details>
```


