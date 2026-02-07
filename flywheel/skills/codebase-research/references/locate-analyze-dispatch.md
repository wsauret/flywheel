# Locate & Analyze Dispatch Templates

Full dispatch templates for Phase 1 (Locate) and Phase 2 (Analyze) of codebase research.

---

## Phase 1: Locator Dispatch Templates

Spawn all locators in parallel using haiku model. Each returns paths/references only — no file contents.

### codebase-locator

```
Task codebase-locator: "
Find files related to: <topic>
Return paths only - no file contents.
Categorize by: implementation, tests, config, types, docs.
Max 30 paths.
"
```

### pattern-locator

```
Task pattern-locator: "
Find patterns related to: <topic>
Return file:line references only.
Group by pattern type.
Max 30 locations.
"
```

### docs-locator

```
Task docs-locator: "
Find documentation about: <topic>
Search: README, CLAUDE.md, docs/, inline comments.
Return paths only.
Max 20 paths.
"
```

### web-searcher (Optional)

Use only if user requests external research or topic is about an external library.

**Cache check first:** Before calling web-searcher, check for cached results:
```bash
find .flywheel/cache/external/ -name "<topic-slug>*.md" -mtime -7 2>/dev/null
```
If a recent cache hit is found, Read the cached file instead. If no cache or stale, proceed and write the result to `.flywheel/cache/external/<topic-slug>-<query-slug>.md` afterward (markdown with YAML frontmatter: `library`, `query`, `source`, `fetched`).

```
Task web-searcher: "
Find documentation/articles about: <topic>
Return URLs with descriptions only - do not fetch.
Categorize: official docs, tutorials, community.
Max 10 URLs per category.
"
```

**IMPORTANT**: Run all locators in parallel (single message, multiple Task calls). Wait for all locators to complete.

---

## Phase 1b: Synthesize Locator Results — Ranking & Selection

Combine locator outputs:

1. **Deduplicate paths** — Same file from multiple locators = 1 entry
2. **Rank by relevance**:
   - Mentioned by multiple locators = higher relevance
   - Closer path match to topic = higher relevance
   - Implementation files > test files (usually)
3. **Select for deep analysis**:
   - Top 15 file paths for codebase-analyzer
   - Top 10 pattern locations for pattern-analyzer
   - Top 5 documentation paths for docs-analyzer
   - Top 5 URLs for web-analyzer (if applicable)

If total findings < 10, may skip analyzer phase for simple topics.

---

## Phase 2: Analyzer Dispatch Templates

Spawn analyzers on TOP FINDINGS ONLY using sonnet model. Run in parallel where possible. Wait for all to complete.

### codebase-analyzer

```
Task codebase-analyzer: "
Analyze these files (from locator results):
- path/to/file1.ts
- path/to/file2.ts
- path/to/file3.ts
[... up to 15 files]

Research topic: <topic>

Document: what exists, how it works, how components interact.
DO NOT suggest improvements - documentarian mode only.
Return file:line references for all findings.
"
```

### pattern-analyzer

```
Task pattern-analyzer: "
Analyze these patterns (from locator results):
- pattern at file.ts:42
- pattern at other.ts:89
[... up to 10 locations]

Research topic: <topic>

Extract code examples with context.
DO NOT suggest alternative patterns - document what exists.
"
```

### docs-analyzer

```
Task docs-analyzer: "
Analyze this documentation (from locator results):
- docs/feature.md
- README.md section
[... up to 5 docs]

Research topic: <topic>

Extract: decisions, constraints, setup instructions, warnings.
Filter aggressively - skip tangential mentions.
"
```

### web-analyzer (Optional)

Use only if web-searcher was used in Phase 1.

```
Task web-analyzer: "
Fetch and analyze these URLs (from web-searcher):
- https://docs.example.com/...
- https://github.com/...
[... up to 5 URLs]

Research topic: <topic>

Extract: code examples, configuration, version constraints, warnings.
"
```
