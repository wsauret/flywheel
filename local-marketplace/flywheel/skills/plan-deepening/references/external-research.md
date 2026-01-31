# External Research Reference

Detailed guidance for external research during plan deepening.

## Framework Documentation Validation

### Why Validate Claims

Plans often contain assumptions like:
- "React Query handles cache invalidation automatically"
- "FastAPI supports WebSocket out of the box"
- "Prisma provides soft delete"

These MUST be verified. Invalid claims become bugs.

### Context7 Workflow

**Step 1: Resolve Library ID**
```
mcp__plugin_Flywheel_context7__resolve-library-id:
  libraryName: "react-query"
  query: "cache invalidation and automatic refetching"
```

**Step 2: Query Specific Capability**
```
mcp__plugin_Flywheel_context7__query-docs:
  libraryId: "/tanstack/query"
  query: "How does cache invalidation work? Is it automatic or manual?"
```

**Step 3: Verify with Code Examples**
Look for actual API calls that demonstrate the claimed capability.

### Fallback: WebSearch

If Context7 fails or lacks coverage:
```
WebSearch: "[library] [claimed feature] documentation 2026"
WebSearch: "[library] does it support [feature]"
```

### Output Format

```
CLAIM_INVALID:
- Claim: "Prisma supports automatic soft delete"
- Documentation says: Soft delete requires manual implementation via middleware
- Source: Prisma docs - Middleware section
- Impact: Plan needs to add soft delete middleware implementation
```

```
CLAIM_VALID:
- Claim: "React Query refetches on window focus"
- Documentation confirms: refetchOnWindowFocus is true by default
- Source: TanStack Query docs - Important Defaults
- Code example provided: [snippet from docs]
```

---

## Best Practices Research

### What to Research

For each major technical decision in the plan:

1. **Is this the recommended approach?**
   - Official docs recommendation
   - Community consensus
   - Recent (2024-2026) blog posts from experts

2. **Common pitfalls**
   - Stack Overflow common issues
   - GitHub issues on the library
   - "X mistakes to avoid" articles

3. **Performance implications**
   - Benchmarks
   - Scaling considerations
   - Memory/CPU tradeoffs

4. **Security considerations**
   - OWASP guidance
   - Library-specific security docs
   - Known vulnerabilities

### Research Sources Priority

1. **Official documentation** - Highest authority
2. **Library maintainer blogs** - High authority
3. **Respected tech blogs** (TkDodo, Kent C. Dodds, etc.) - High authority
4. **Stack Overflow accepted answers** - Medium authority
5. **General blog posts** - Use with caution, verify claims

### Output Format

```
Best Practice: Query Key Factories
Source: TkDodo blog (React Query maintainer)
Recommendation: Use factory pattern for consistent cache keys
Code Example:
  const userKeys = {
    all: ['users'] as const,
    lists: () => [...userKeys.all, 'list'] as const,
    detail: (id: string) => [...userKeys.all, 'detail', id] as const,
  }
Why: Prevents key typos, enables efficient invalidation
```

---

## Version Compatibility Check

### What to Check

1. **Peer dependencies** - Does library A require specific version of B?
2. **Breaking changes** - Did recent version change APIs we plan to use?
3. **Deprecation notices** - Are planned approaches deprecated?
4. **Runtime requirements** - Node version, Python version, etc.

### How to Check

```bash
# Check package.json / pyproject.toml for version constraints
cat package.json | jq '.dependencies'

# Check for peer dependency requirements
npm info [package] peerDependencies

# Check changelogs for breaking changes
WebSearch: "[library] changelog breaking changes v[version]"
```

### Output Format

```
VERSION_ISSUE:
- Package: @tanstack/react-query
- Plan uses: v5.x API
- Project has: v4.x installed
- Breaking changes: useQuery signature changed, removal of onSuccess
- Recommendation: Either upgrade to v5 or use v4 API
```

---

## Alternative Approaches Research

### When to Research Alternatives

- Plan makes significant architectural decisions
- Choosing between multiple libraries
- Implementing complex patterns

### What to Compare

| Aspect | Option A | Option B |
|--------|----------|----------|
| Performance | metrics | metrics |
| Bundle size | size | size |
| Learning curve | assessment | assessment |
| Community support | GitHub stars, issues | GitHub stars, issues |
| Maintenance | last release, contributors | last release, contributors |
| Our codebase fit | existing usage | would be new |

### Output Format

```
Alternative Approaches: State Management

Option A: React Query (Recommended)
- Fits plan's server-state focus
- Already used in codebase (src/hooks/useUser.ts)
- Excellent DevTools
- Smaller bundle than Redux

Option B: Redux Toolkit
- Better for complex client state
- Not currently in codebase (would add dependency)
- More boilerplate

Option C: Zustand
- Minimal API
- Not in codebase
- Less ecosystem support

Recommendation: React Query - aligns with plan's needs and existing codebase
```

---

## Skills and Learnings Check

### Check Available Skills First

Before external research, check if curated guidance exists:

```bash
# Discover all skills
ls -la ~/.claude/skills/ .claude/skills/ 2>/dev/null
find ~/.claude/plugins -name "SKILL.md" 2>/dev/null
```

If a skill covers the plan's domain, spawn a subagent to apply it.

### Check Documented Learnings

```bash
# Search for relevant past solutions
grep -r "[keyword]" docs/solutions/ 2>/dev/null
```

Learnings are institutional knowledge - always check before external research.

### Priority Order

1. Documented learnings (solved problems from this codebase)
2. Available skills (curated best practices)
3. External documentation
4. External best practices research
