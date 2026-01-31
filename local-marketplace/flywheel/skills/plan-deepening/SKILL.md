---
name: plan-deepening
description: Enhance plans with internal and external research. Validates claims, checks for DRY violations, and adds best practices. Triggers on "deepen plan", "enhance plan", "research plan".
allowed-tools:
  - Read
  - Write
  - Grep
  - Glob
  - Bash
  - Task
  - Skill
---

# Plan Deepening Skill

Enhance implementation plans through systematic research. Two modes:
- **Internal Research** - Does this already exist? DRY violations? Fits existing patterns?
- **External Research** - Do claimed features exist? Best practices? Framework docs?

**Philosophy:** Validate before implementing. Bad assumptions in plans become bad code.

## Input

Plan path via `$ARGUMENTS`. If empty, ask user.

**Subagent Dispatch:** Follow guidelines in `CLAUDE.md` - never send file contents, request compaction format.

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

### 2.1 Existing Solutions Check

```
Task repo-researcher: "
Search codebase for existing implementations related to: [feature/capability]

Questions:
1. Does something similar already exist?
2. Can we extend existing code instead of creating new?
3. Are there shared utilities we should use?

Flag: EXISTING_SOLUTION if found, with path and assessment of reusability.
"
```

### 2.2 Pattern Consistency Check

```
Task repo-researcher: "
Analyze codebase patterns for: [domain area from plan]

Questions:
1. How do we currently handle [similar concern]?
2. What naming conventions exist for [component type]?
3. Does the proposed approach fit or conflict with existing patterns?

Flag: PATTERN_CONFLICT if plan deviates from established patterns.
"
```

### 2.3 DRY Violation Check

```
Task repo-researcher: "
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
Task repo-researcher: "
Assess integration impact of plan:

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

### 3.2 Best Practices Research

```
Task web-researcher: "
Research best practices for: [technical approach in plan]

Focus on:
1. Is this the recommended approach for [use case]?
2. Common pitfalls to avoid
3. Performance considerations
4. Security implications

Return: Concrete recommendations with code examples.
"
```

### 3.3 Version Compatibility Check

```
Task web-researcher: "
Check version compatibility for: [technology stack from plan]

Questions:
1. Do the proposed versions work together?
2. Any deprecation warnings for planned approaches?
3. Breaking changes in recent versions?

Flag: VERSION_ISSUE if incompatibilities found.
"
```

### 3.4 Alternative Approaches Research

```
Task web-researcher: "
Research alternative approaches for: [core technical decision in plan]

Questions:
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

```
Question: "Plan deepened. What next?"
Options:
1. View diff - Show what changed
2. Run review - Get reviewer feedback
3. Start work - Begin implementation
4. Deepen more - Additional research on specific sections
```

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
