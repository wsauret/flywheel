# Enhancement Format Reference

Templates and examples for adding research findings to plan sections.

## Enhancement Summary Template

Add this at the TOP of the plan, right after the title:

```markdown
## Enhancement Summary

**Deepened on:** [YYYY-MM-DD]
**Sections enhanced:** [count]

### Research Coverage
- **Internal research:** [count] checks (existing solutions, patterns, DRY, integration)
- **External research:** [count] queries (Context7, best practices, versions, alternatives)
- **Learnings applied:** [count] from docs/solutions/

### Key Findings

**Blockers:**
- [CLAIM_INVALID / VERSION_ISSUE items that must be resolved]

**Warnings:**
- [DRY_VIOLATION / PATTERN_CONFLICT / INTEGRATION_RISK items]

**Enhancements:**
- [Best practices and improvements discovered]

### Open Questions

| # | Question | Options | Source |
|---|----------|---------|--------|
| 1 | [Decision point from research] | A: [opt], B: [opt] | [agent] |
| 2 | [Conflict between findings] | A: [approach], B: [approach] | [agents] |

### Applied Learnings
- [Learning title]: Applied to [section]

---
```

## Research Validation Section Template

Add this AFTER each original plan section:

```markdown
### Research Validation

**Claims Validated:**
- [Claim from section]: Confirmed via [Context7/docs/source]
- [Another claim]: Confirmed via [source]

**Issues Found:**
- `CLAIM_INVALID`: [Description] - [Recommendation]
- `PATTERN_CONFLICT`: [Description] - [Recommendation]

**Existing Solutions:**
- Found: [path/to/existing/code]
- Assessment: [Can reuse / Should extend / Different purpose]

### Best Practices

- **[Practice name]:** [Explanation] (Source: [agent/docs])
  ```[language]
  // Example implementation
  ```

- **[Another practice]:** [Explanation] (Source: [agent/docs])

### Security Considerations

- [Security item]: [Why it matters and how to address]

### Performance Considerations

- [Performance item]: [Impact and recommendation]

### Implementation Details

Code examples and concrete patterns from research:

```[language]
// Source: [URL or Context7 library ID]
// File: [suggested path/to/file.ts]
[concrete code example]
```

**Usage notes:**
- [Important considerations for this code]

### Edge Cases

| Scenario | Handling | Source |
|----------|----------|--------|
| [Edge case 1] | [How to handle] | [Research source] |
| [Edge case 2] | [How to handle] | [Research source] |

### References

- [Official documentation URL]
- [Relevant blog post]
- [Related GitHub issue]
```

## Example: Before and After

### Original Plan Section (UNCHANGED)

```markdown
## Technical Approach

Use React Query for data fetching with optimistic updates. Cache user data
for 5 minutes to reduce API calls.
```

### After Enhancement

```markdown
## Technical Approach

Use React Query for data fetching with optimistic updates. Cache user data
for 5 minutes to reduce API calls.

### Research Validation

**Claims Validated:**
- "React Query supports optimistic updates": Confirmed via TanStack Query docs
- "Can configure cache duration": Confirmed - use `staleTime` option

**Issues Found:**
- `EXISTING_SOLUTION`: Similar caching exists in `src/hooks/useApiCache.ts`
  - Assessment: Different approach (custom vs React Query) - proceed with plan but deprecate old
- `PATTERN_CONFLICT`: Current codebase uses SWR, not React Query
  - Recommendation: Discuss migration strategy before implementation

### Best Practices

- **Query Key Factories:** Use factory pattern for cache key consistency (Source: TkDodo blog)
  ```typescript
  const userKeys = {
    all: ['users'] as const,
    detail: (id: string) => [...userKeys.all, 'detail', id] as const,
  }
  ```

- **Optimistic Update Pattern:** Cancel queries before optimistic update (Source: TanStack docs)
  ```typescript
  onMutate: async (newData) => {
    await queryClient.cancelQueries({ queryKey: userKeys.all })
    const previous = queryClient.getQueryData(userKeys.all)
    queryClient.setQueryData(userKeys.all, (old) => [...old, newData])
    return { previous }
  }
  ```

### Security Considerations

- Don't include sensitive data in query keys (they appear in DevTools)
- Consider `gcTime` for sensitive user data to clear from memory

### Performance Considerations

- `staleTime: 5 * 60 * 1000` aligns with plan (5 minutes)
- Consider `refetchOnWindowFocus: false` for stable data

### Implementation Details

```typescript
// Source: TanStack Query docs
// File: src/hooks/useUsers.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

export const useUsers = () => {
  return useQuery({
    queryKey: userKeys.all,
    queryFn: fetchUsers,
    staleTime: 5 * 60 * 1000, // 5 minutes per plan
  })
}
```

**Usage notes:**
- Import from `@tanstack/react-query`, not `react-query` (v5 naming)
- Wrap app in `QueryClientProvider`

### Edge Cases

| Scenario | Handling | Source |
|----------|----------|--------|
| Offline mode | Use `networkMode: 'offlineFirst'` | TanStack docs |
| Race conditions | Call `cancelQueries` before optimistic update | TkDodo blog |
| Cache invalidation | Use `invalidateQueries` after mutations | TanStack docs |

### References

- https://tanstack.com/query/latest/docs/react/guides/optimistic-updates
- https://tkdodo.eu/blog/practical-react-query
```

## Finding Categorization Guide

### Blockers (MUST resolve before implementation)

- `CLAIM_INVALID` - Plan relies on non-existent library features
- `VERSION_ISSUE` - Incompatible versions that would break at runtime

### Warnings (SHOULD address before implementation)

- `DRY_VIOLATION` - Creating duplicate code
- `PATTERN_CONFLICT` - Deviating from established codebase patterns
- `INTEGRATION_RISK` - Changes that may break existing functionality
- `EXISTING_SOLUTION` - Similar code already exists (could reuse)

### Enhancements (Nice to incorporate)

- Best practices from research
- Performance optimizations
- Security hardening
- Edge case handling

## Open Questions Format

Questions that need user decision before implementation:

```markdown
| # | Question | Options | Source |
|---|----------|---------|--------|
| 1 | Migrate from SWR to React Query? | A: Full migration, B: Use both, C: Stick with SWR | Internal research |
| 2 | Cache invalidation strategy? | A: Time-based (5min), B: Event-based, C: Hybrid | External research |
| 3 | Where to put shared hooks? | A: src/hooks/, B: src/lib/query/, C: Feature folders | Pattern check |
```

Do NOT resolve these yourself. Present to user during consolidation.

---

## External Research Quarantine

**External research results are quarantined in a separate section for human review before integration.**

### Why Quarantine?

External sources may contain:
- Outdated information (library APIs change)
- Incorrect examples (copy-paste bugs in blogs)
- Security anti-patterns (StackOverflow answers)
- Version mismatches (code for different framework version)

### External Research Section Template

Add this section AFTER internal research findings:

```markdown
## External Research (Unverified)

**Source:** [Web search / Context7 / Documentation URL]
**Fetched:** [YYYY-MM-DD]

> **Warning:** This content is from external sources and has not been verified against the current codebase. Review before incorporating into implementation.

### [Topic 1]

**Source:** [URL or Context7 library ID]
**Relevance:** [Why this was searched]

**Key Claims:**
- [Claim 1]: [Summary]
- [Claim 2]: [Summary]

**Code Examples:**
```[language]
// Source: [URL]
// WARNING: Verify compatibility before use
[code from external source]
```

**Recommended Verification:**
- [ ] Test code example in isolation
- [ ] Verify API compatibility with current versions
- [ ] Check for security implications

### [Topic 2]
...
```

### Integration Guidelines

**DO:**
- Include source URLs for all external content
- Mark all external code as "unverified"
- Add verification checklists for code examples
- Note the fetch date (external content may go stale)

**DON'T:**
- Integrate external code directly into implementation steps
- Assume external patterns match codebase conventions
- Trust security advice without verification
- Auto-execute external code examples

### Promotion to Validated Content

During plan-review or implementation, external content can be promoted:

```markdown
**Validated:** [YYYY-MM-DD]
**Validated by:** [human / test / code review]
**Integrated into:** [section name]
```

---

## Phase 5: Synthesize Findings (Detailed)

Wait for all research agents. Then categorize, generate open questions, and deduplicate.

### Finding Categorization

**Blockers (must resolve before implementation):**
- `CLAIM_INVALID` - Plan relies on non-existent features
- `VERSION_ISSUE` - Incompatible technology versions

**Warnings (should address):**
- `DRY_VIOLATION` - Code duplication identified
- `PATTERN_CONFLICT` - Deviates from codebase patterns
- `INTEGRATION_RISK` - May break existing functionality

**Enhancements (incorporate into plan):**
- Best practices from external research
- Code examples from documentation
- Security/performance recommendations

### Generate Open Questions

Convert conflicts and decisions into questions:

| Question | Options | Source |
|----------|---------|--------|
| [Decision point] | A: [option], B: [option] | [agent] |

### Deduplication Rules

- Same finding from multiple sources -> Higher confidence, note source count
- Conflicting findings -> Convert to Open Question

---

## Phase 6: Per-Section Enhancement Format

For each section in the original plan, add research insights using this template:

```markdown
## [Original Section - UNCHANGED]

### Research Validation

**Claims Validated:**
- [Claim]: Confirmed via [source]

**Issues Found:**
- [BLOCKER/WARNING]: [Description] - [Recommendation]

### Best Practices Added

- [Practice]: [Why and how] (Source: [agent])

### Code Examples

```[language]
// [path/to/file]
[concrete implementation example]
```

### References

- [Documentation URL]
```

**CRITICAL:** Never modify original content. Only add research sections.

---

## Phase 7: Write and Present (Detailed)

### Write Enhanced Plan

```bash
cp [plan_path] [plan_path].backup
```

Write enhanced plan back to SAME file with:
1. Enhancement Summary at top (findings, open questions, coverage)
2. Original sections preserved
3. Research Validation subsections added

### Update Context File

Append to `[plan_path].context.md`:
- Research coverage statistics
- Key findings summary
- Open questions generated

### Present Options

**AskUserQuestion:** "Verification data added to plan. What next?"

| Option | Action |
|--------|--------|
| Run review (Recommended) | Invoke `skill: plan-review` |
| Done for now | Display path and exit |
