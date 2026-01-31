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

### Edge Cases

- [Edge case 1]: [How to handle]
- [Edge case 2]: [How to handle]

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

### Edge Cases

- Offline handling: React Query supports `networkMode: 'offlineFirst'`
- Race conditions: Use `cancelQueries` on mutation start

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
