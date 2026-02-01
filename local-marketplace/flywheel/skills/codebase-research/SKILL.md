---
name: codebase-research
description: "Conduct comprehensive codebase research producing a persistent document. Use when you need to understand something BEFORE planning, or for pure exploration."
user-invocable: true
triggers: ["research", "investigate", "explore codebase"]
allowed-tools:
  - Read
  - Write
  - Grep
  - Glob
  - Bash
  - Task
  - AskUserQuestion
---

# Codebase Research Skill

Conduct comprehensive research using a two-phase locate→analyze approach that reduces context usage by 40-60%.

## Philosophy: Documentarian Mode

- Document what IS, not what SHOULD BE
- No suggestions, critiques, or recommendations
- Pure technical mapping of the existing system
- Focus on paths and references, not full file contents

---

## Input

Research question via `$ARGUMENTS`. If empty, ask user.

---

## Phase 1: Locate (Parallel, Cheap)

Spawn locator agents in parallel using haiku model:

```
Task codebase-locator: "
Find files related to: <topic>
Return paths only - no file contents.
Categorize by: implementation, tests, config, types, docs.
Max 30 paths.
"

Task pattern-locator: "
Find patterns related to: <topic>
Return file:line references only.
Group by pattern type.
Max 30 locations.
"

Task docs-locator: "
Find documentation about: <topic>
Search: README, CLAUDE.md, docs/, inline comments.
Return paths only.
Max 20 paths.
"
```

**Optional** (if user requests external research or topic is about external library):

```
Task web-searcher: "
Find documentation/articles about: <topic>
Return URLs with descriptions only - do not fetch.
Categorize: official docs, tutorials, community.
Max 10 URLs per category.
"
```

**IMPORTANT**: Run all locators in parallel (single message, multiple Task calls).

**Wait for all locators to complete.**

---

## Phase 1b: Synthesize Locator Results

Combine locator outputs:

1. **Deduplicate paths** - Same file from multiple locators = 1 entry
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

## Phase 2: Analyze (Targeted, Expensive)

Spawn analyzer agents on TOP FINDINGS ONLY using sonnet model:

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

**Optional** (if web-searcher was used):

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

**IMPORTANT**: Run analyzers in parallel where possible.

**Wait for all analyzers to complete.**

---

## Phase 3: Synthesize & Persist

### Create Research Document

Determine output path:
- If `docs/research/` exists, use it
- Otherwise, create `docs/research/` directory

Write to: `docs/research/YYYY-MM-DD-<topic-slug>.md`

```markdown
---
date: [ISO timestamp]
topic: "[Research Question]"
status: complete
git_commit: [current HEAD hash]
git_branch: [current branch]
tags: [research, <relevant-tags>]
---

# Research: [Topic]

## Research Question

[Original user query]

## Summary

[High-level findings - 3-5 sentences synthesizing all agent outputs]

## Detailed Findings

### [Component/Area 1]

[Findings with file:line references from codebase-analyzer]

### [Component/Area 2]

[Findings from pattern-analyzer]

### [Additional Areas...]

## Code References

| File | Lines | Description |
|------|-------|-------------|
| `path/to/file.ts` | 42-67 | [what it does] |
| `path/to/other.ts` | 15-30 | [what it does] |

## Patterns Identified

- **[Pattern Name]**: `file.ts:42-67` - [description]
- **[Pattern Name]**: `other.ts:89-120` - [description]

## External References (if applicable)

- [Source Title](URL) - [key takeaway]

## Open Questions

- [Question needing further investigation]
- [Uncertainty about scope or behavior]
```

### Git Commit (Optional)

If significant research was conducted:

```bash
git add docs/research/
git commit -m "research: [topic]

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Phase 4: Present & Offer Next Steps

Display summary to user (not full document).

**AskUserQuestion:**

```
Question: "Research complete and saved to docs/research/[filename]. What next?"
Options:
1. Create plan from research (Recommended) - Invoke plan-creation with research path
2. Continue researching - Ask follow-up question, append to document
3. Done for now - Exit
```

| Option | Action |
|--------|--------|
| Create plan | `Skill: plan-creation` with research document path |
| Continue | Ask follow-up, re-run locate→analyze, append to document |
| Done | Exit skill |

---

## Integration: Called by Other Skills

Other skills can invoke or check for research:

```bash
# Check for recent research on topic
RESEARCH=$(find docs/research -name "*<feature>*" -mtime -7 2>/dev/null | head -1)

if [ -n "$RESEARCH" ]; then
  # Use existing research
  Read "$RESEARCH"
else
  # Offer to run research
  AskUserQuestion: "No recent research found. Run research first?"
fi
```

---

## Context Budget

This skill is context-heavy. Monitor usage:

- **After Phase 1**: If >30 locator results, consolidate before Phase 2
- **After Phase 2**: Write findings immediately, don't hold in context
- **Always**: Prefer file:line references over quoting code

---

## 2-Action Rule for Visual Content

After ANY 2 of these operations:
- WebFetch
- Browser tool use
- Image viewing
- Search results review

**IMMEDIATELY** persist findings to the research document as text.

Visual/multimodal content doesn't persist well in context. Capture it as text before it's lost.

---

## Anti-Patterns

- **Skip locator phase** - Don't go straight to analyzers
- **Analyze everything** - Only analyze top findings from locators
- **Make suggestions** - This is documentation, not consultation
- **Return file contents** - Paths and references only
- **Forget to persist** - Always write research document
- **Hold in context** - Write to file, reference by path
