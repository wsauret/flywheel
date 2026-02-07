# External Research Reference

Detailed guidance for external research during plan verification.

## Framework Documentation Validation

### Why Validate Claims

Plans often contain assumptions like:
- "React Query handles cache invalidation automatically"
- "FastAPI supports WebSocket out of the box"
- "Prisma provides soft delete"

These MUST be verified. Invalid claims become bugs.

### Cache Check (Before Context7 Calls)

Before calling Context7, check for cached results. Read `references/external-cache.md` for the full cache format spec and TTL logic.

```bash
find .flywheel/cache/external/ -name "<library-slug>*.md" -mtime -7 2>/dev/null
```

If a recent cache hit is found, Read the cached file instead of calling Context7. If no cache or stale, proceed with Context7 and write the result to cache afterward.

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

---

## Research Decision Heuristic

**Before running external research, determine if it is needed.**

### High-Risk Topics (ALWAYS require external research)

Scan plan for these keywords -- if found, external research is REQUIRED:

- **Security:** authentication, authorization, auth, OAuth, JWT, CORS, XSS, CSRF, SQL injection, encryption, hashing, passwords, secrets, API keys
- **Payments:** payment, billing, stripe, checkout, subscription, PCI
- **Crypto:** cryptography, signing, certificates, TLS, SSL
- **Migrations:** database migration, data migration, schema change, breaking change
- **Privacy:** PII, GDPR, CCPA, personal data, user data, privacy

### Research Decision Logic

```
IF any high-risk topic detected:
  -> RUN external research (all subsections: docs validation, best practices, version compat, alternatives)
  -> Log decision: "High-risk topic detected: [topic]. Running external research."

ELSE:
  -> SKIP external research
  -> Log decision: "No high-risk topics. Local research sufficient."
```

**Rationale:** High-risk topics have evolving best practices and security considerations that change frequently. Local codebase patterns may be outdated.

### Log Research Decision

Add to plan output:

```markdown
## Research Decision
- **Topic risk level:** [HIGH/LOW]
- **High-risk topics found:** [list or "None"]
- **Decision:** [Run external research / Skip external research]
- **Rationale:** [Brief reason]
```

---

## Dispatch Templates for External Research

### 3.1 Framework Documentation Validation

For each framework/library claim in the plan:

```
# Resolve library ID
mcp__plugin_Flywheel_context7__resolve-library-id:
  libraryName: "[library name]"
  query: "[specific capability claimed]"

# Query docs to validate
mcp__plugin_Flywheel_context7__query-docs:
  libraryId: "[resolved ID]"
  query: "Does [library] support [claimed feature]? Show API and examples."
```

**Flag:** `CLAIM_INVALID` if documented capability does not match claim.

### 3.2 Best Practices Research (Locate then Analyze)

First, find relevant URLs:

```
Task web-searcher: "
Find documentation and best practices for: [technical approach in plan]
Search: official docs, tutorials, community patterns.
Return URLs with descriptions only - do not fetch.
"
```

Then analyze top results:

```
Task web-analyzer: "
Fetch and analyze these URLs (from web-searcher):
- [url1]
- [url2]
- [url3]

Extract for: [technical approach in plan]
1. Is this the recommended approach for [use case]?
2. Common pitfalls to avoid
3. Performance considerations
4. Security implications

Return: Concrete recommendations with code examples.
"
```

### 3.3 Version Compatibility Check

```
Task web-analyzer: "
Fetch and analyze version compatibility docs:
- [framework docs URL]
- [changelog URL]

Questions:
1. Do the proposed versions work together?
2. Any deprecation warnings for planned approaches?
3. Breaking changes in recent versions?

Flag: VERSION_ISSUE if incompatibilities found.
"
```

### 3.4 Alternative Approaches Research

```
Task web-searcher: "
Find alternative approaches for: [core technical decision in plan]
Search: comparison articles, framework docs, community discussions.
Return top 5 URLs with descriptions.
"

Task web-analyzer: "
Analyze these URLs (from web-searcher):
- [url1]
- [url2]

Extract:
1. What are the main alternatives?
2. Trade-offs between approaches?
3. When is each approach recommended?

Return: Comparison table with recommendations.
"
```

**Run all external research in parallel.**

---

## Quarantine Rules for External Results

**CRITICAL:** External research results go in a separate "External Research (Unverified)" section.

**Why quarantine?**
- External sources may be outdated
- Code examples may have security issues
- Patterns may not match codebase conventions

**Do NOT:**
- Integrate external code directly into implementation steps
- Auto-execute external code examples
- Trust security advice without verification

See the "External Research Quarantine" section in `enhancement-format.md` for the full quarantine template.

---

## External Research Checklist

Before synthesizing, verify external research answered:

- [ ] Do claimed library features actually exist?
- [ ] Are we using recommended patterns?
- [ ] Are technology versions compatible?
- [ ] What are the alternatives and trade-offs?
