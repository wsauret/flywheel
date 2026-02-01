---
name: plan-verification
description: Verify plan assumptions are real, not hallucinated. Validates claims against framework docs, checks for DRY violations, confirms compatibility. Triggers on "verify plan", "validate plan", "check plan assumptions".
allowed-tools:
  - Read
  - Write
  - Grep
  - Glob
  - Bash
  - Task
  - Skill
---

# Plan Verification Skill

Verify implementation plans are grounded in reality. Two modes:
- **Internal Research** - Does this already exist? DRY violations? Fits existing patterns?
- **External Research** - Do claimed features exist? Best practices? Framework docs?

**Philosophy:** Validate before implementing. Bad assumptions in plans become bad code.

## Input

Plan path via `$ARGUMENTS`. If empty, ask user.

---

## Phase 0: Discover Relevant Learnings

Before research, check `docs/solutions/` for relevant past solutions.

```bash
ls docs/solutions/ 2>/dev/null
```

**If exists:** Search by keywords from plan (module names, technologies, patterns). Present top 3-5 matches and ask user which to include.

---

## Phase 1: Parse Plan and Extract Claims

Read plan and identify:

### Technical Claims (require validation)
- "Use [library] for [feature]" - Does the library support this?
- "Implement [pattern]" - Is this the right pattern for this case?
- "[Framework] provides [capability]" - Verify in docs

### Implementation Scope
- Technologies/frameworks mentioned
- Components to build or modify
- File paths referenced

### Research Questions
Convert claims into specific questions:
- "Does React Query support offline persistence?" (external)
- "Do we already have a caching layer?" (internal)
- "What's the recommended pattern for X in our codebase?" (internal)

---

## Phase 2: Internal Research (Codebase)

**Goal:** Prevent reinventing wheels and breaking patterns.

### 2.1 Locate Existing Solutions (Phase 1: Cheap)

First, run locators in parallel to find WHERE relevant code lives:

```
Task codebase-locator: "
Find files related to: [feature/capability]
Looking for: existing implementations, shared utilities, similar features.
Return paths only - categorize by: implementation, tests, config.
"

Task pattern-locator: "
Find patterns related to: [domain area from plan]
Looking for: naming conventions, architectural patterns, error handling.
Return file:line references only.
"
```

### 2.2 Analyze Findings (Phase 2: Targeted)

Then, analyze top findings from locators:

```
Task codebase-analyzer: "
Analyze these files (from locator results):
- [path1]
- [path2]
- [path3]

Questions:
1. Does something similar already exist?
2. Can we extend existing code instead of creating new?
3. Are there shared utilities we should use?
4. Does the proposed approach fit or conflict with existing patterns?

Flag: EXISTING_SOLUTION if found, PATTERN_CONFLICT if plan deviates.
Documentarian mode - document what exists, no suggestions.
"
```

### 2.3 DRY Violation Check

```
Task pattern-analyzer: "
Analyze these pattern locations (from locator results):
- [file:line1]
- [file:line2]

Check for potential DRY violations in plan:
Plan proposes: [list proposed new code/modules]

Questions:
1. Does any proposed code duplicate existing functionality?
2. Should this be extracted to a shared location?
3. Are there existing abstractions this should use?

Flag: DRY_VIOLATION with specific file paths if found.
"
```

### 2.4 Integration Impact Check

```
Task codebase-analyzer: "
Assess integration impact using these files:
- [files that would be modified]

Components affected: [list from plan]

Questions:
1. What else touches these files/modules?
2. Are there tests that will need updating?
3. Any potential breaking changes to existing consumers?

Flag: INTEGRATION_RISK with details.
"
```

**Run all internal research in parallel.**

---

## Phase 3: External Research (Documentation & Best Practices)

**Goal:** Validate claims and add best practices.

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

**Flag:** `CLAIM_INVALID` if documented capability doesn't match claim.

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

## Phase 4: Synthesize Findings

Wait for all research agents. Then:

### Categorize Findings

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

### Deduplicate

- Same finding from multiple sources → Higher confidence, note source count
- Conflicting findings → Convert to Open Question

---

## Phase 5: Enhance Plan Sections

For each section in the original plan, add research insights:

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

## Phase 6: Write and Present

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

---

## Internal Research Checklist

Before spawning external research, verify internal research answered:

- [ ] Does similar functionality exist in our codebase?
- [ ] Does the approach fit our established patterns?
- [ ] Will this create code duplication?
- [ ] What integration risks exist?

---

## External Research Checklist

Before synthesizing, verify external research answered:

- [ ] Do claimed library features actually exist?
- [ ] Are we using recommended patterns?
- [ ] Are technology versions compatible?
- [ ] What are the alternatives and trade-offs?

---

## Error Handling

- **Agent failure:** Log and continue; require 50% success minimum
- **Context7 failure:** Fall back to WebSearch
- **No docs/solutions:** Skip learnings phase
- **Write failure:** Display content, suggest alternative save

---

## Anti-Patterns

- **Skipping internal research** - External best practices mean nothing if we already have a solution
- **Not validating claims** - "Library X supports Y" must be verified in docs
- **Modifying original content** - Only ADD research sections
- **Resolving conflicts yourself** - Convert to Open Questions for user

---

## Detailed References

For verbose guidance, templates, and examples:
- `references/internal-research.md` - Detailed codebase research patterns
- `references/external-research.md` - Framework docs and best practices research
- `references/enhancement-format.md` - Templates for research insights sections
