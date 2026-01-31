# Consolidated Plan Template

Use this structure for the final consolidated output.

```markdown
# [Plan Title]

## Status
- **Created:** [date from original plan]
- **Deepened:** [date from Enhancement Summary]
- **Reviewed:** [date from Review Summary]
- **Consolidated:** [today's date]
- **Ready for:** /fly:work

## Executive Summary

[1-2 paragraph synthesis of what this plan accomplishes. Pull from original plan overview, enhanced with key insights from deepening.]

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
  - Research insight: [Relevant finding - be specific]
  - Review note: [If any finding applies to this step]
  - Code reference: [If a code example applies]

- [ ] **Step 1.2: [Concrete action]**
  - Anti-pattern to avoid: [Specific warning]
  - Edge case: [What to handle]

### Phase 2: [Name]

- [ ] **Step 2.1: [Concrete action]**
  [Continue pattern...]

### Phase N: [Final Phase]

- [ ] **Step N.1: [Final action]**
- [ ] **Verification: Run tests and confirm all acceptance criteria**

## Technical Reference

### Best Practices to Follow

[Consolidated from all Research Insights - deduplicated, organized by topic]

1. **[Topic 1]**
   - [Practice] (Source: [agent/section])

2. **[Topic 2]**
   - [Practice] (Source: [agent/section])

### Anti-Patterns to Avoid

[Consolidated from Research Insights + Review findings]

1. **[Anti-pattern]**: [Why it's problematic]
2. **[Anti-pattern]**: [Why it's problematic]

### Code Examples

[Key code snippets from Research Insights, organized by topic]

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

## Appendix: Raw Research & Review Data

<details>
<summary>Original Enhancement Summary</summary>

[Copy the Enhancement Summary section from deepening verbatim]

</details>

<details>
<summary>Original Review Summary</summary>

[Copy the Plan Review Summary section from reviewing verbatim]

</details>

<details>
<summary>Full Research Insights by Section</summary>

[Copy all Research Insights subsections verbatim, preserving structure]

</details>
```

---

## Context File Update Template

Append this to the existing context file after consolidation:

```markdown
## Consolidation [YYYY-MM-DD HH:MM]

### Actions Performed
- Resolved [N] open questions with user input
- Restructured into actionable checklist format
- Integrated [X] research insights into implementation steps
- Incorporated [Y] review findings
- Created Technical Reference section
- Preserved raw data in Appendix

### Decisions Made
[List each decision from Phase 3]
- [Topic 1]: [Choice] ([user choice / delegated])
- [Topic 2]: [Choice] ([user choice / delegated])

### Synthesis Statistics
- **Total checklist items:** [count]
- **Implementation phases:** [count]
- **Best practices consolidated:** [count]
- **Anti-patterns documented:** [count]
- **Code examples preserved:** [count]

### Plan Status
- **P1 findings:** [count] ([all addressed / N blocking])
- **P2 findings:** [count] (incorporated)
- **P3 findings:** [count] (deferred)
- **Conflicts:** [count] ([all resolved / N pending])

### Ready for Implementation
- **Status:** [Ready for /fly:work | Blocked by P1 findings | Blocked by unresolved conflicts]
- **Recommended next step:** [/fly:work [plan_path] | Address blocking items first]
```
