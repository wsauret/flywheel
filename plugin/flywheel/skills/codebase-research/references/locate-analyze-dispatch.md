# Locate & Analyze Dispatch Templates

Full dispatch templates for Phase 1 (Locate) and Phase 2 (Analyze) of codebase research.

---

## Phase 1: Locator Dispatch Templates

Spawn all locators in parallel using haiku model. Each returns paths/references only — no file contents.

### locator-codebase

```
Task locator-codebase: "
Find files related to: <topic>
Return paths only - no file contents.
Categorize by: implementation, tests, config, types, docs.
Max 30 paths.
"
```

### locator-patterns

```
Task locator-patterns: "
Find patterns related to: <topic>
Return file:line references only.
Group by pattern type.
Max 30 locations.
"
```

### locator-docs

```
Task locator-docs: "
Find documentation about: <topic>
Search: README, CLAUDE.md, docs/, inline comments.
Return paths only.
Max 20 paths.
"
```

### locator-web

```
Task locator-web: "
Find documentation/articles about: <topic>
Return URLs with descriptions only - do not fetch.
Categorize: official docs, tutorials, community.
Max 15 URLs per category.
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
   - Top 15 file paths for analyzer-codebase
   - Top 10 pattern locations for analyzer-patterns
   - Top 5 documentation paths for analyzer-docs
   - Top 10 URLs for analyzer-web

If total findings < 10, may skip analyzer phase for simple topics.

---

## Phase 2: Analyzer Dispatch Templates

Spawn analyzers on TOP FINDINGS ONLY using sonnet model. Run in parallel where possible. Wait for all to complete.

### analyzer-codebase

```
Task analyzer-codebase: "
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

### analyzer-patterns

```
Task analyzer-patterns: "
Analyze these patterns (from locator results):
- pattern at file.ts:42
- pattern at other.ts:89
[... up to 10 locations]

Research topic: <topic>

Extract code examples with context.
DO NOT suggest alternative patterns - document what exists.
"
```

### analyzer-docs

```
Task analyzer-docs: "
Analyze this documentation (from locator results):
- docs/feature.md
- README.md section
[... up to 5 docs]

Research topic: <topic>

Extract: decisions, constraints, setup instructions, warnings.
Filter aggressively - skip tangential mentions.
"
```

### analyzer-web

```
Task analyzer-web: "
Fetch and analyze these URLs (from locator-web):
- https://docs.example.com/...
- https://github.com/...
[... up to 10 URLs]

Research topic: <topic>

Extract: code examples, configuration, version constraints, warnings.
"
```
