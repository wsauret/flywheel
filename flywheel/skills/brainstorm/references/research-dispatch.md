# Research Dispatch Templates

Detailed dispatch templates for Phase 1 (Silent Research) and Phase 1.5 (Research Review).

---

## Phase 1.1: Locate (Parallel, Cheap)

Run all locators in parallel to gather broad context quickly:

```
Task codebase-locator: "Find files related to: <feature_idea>. Return paths only."
Task pattern-locator: "Find patterns related to: <feature_idea>. Return file:line refs."
Task docs-locator: "Find docs about: <feature_idea>. Return paths only."
Task web-searcher: "Find best practices for: <feature_idea>. Return URLs only." [15s timeout]
```

## Phase 1.2: Analyze Top Findings (Targeted)

```
Task codebase-analyzer: "
Analyze top 10 files from locators for: <feature_idea>
Document existing patterns, constraints, naming conventions.
"
```

**Extract for internal use:**
- Relevant existing patterns
- Technical constraints
- Similar implementations
- Naming conventions
- Best practices

---

## Phase 1.5: Research Review Presentation Format

Present a summary (NOT raw findings) to the user:

```
Research Summary for: [Feature]

Scope Identified: [3-5 bullets]
Key Files: [paths with purpose]
Patterns Discovered: [pattern: description]
Potential Concerns: [risks]
```

**AskUserQuestion options:**
- Approve and proceed
- Add focus area - Need more investigation
- Redirect research - Wrong direction

Maximum 2 re-research cycles.

---

## Phase 2: Understanding Confirmation Template

Before exploring approaches, confirm understanding:

```
I understand we're solving:

**Problem:** [1-2 sentences]
**For:** [audience]
**Success looks like:** [outcome]
**Out of scope:** [explicit boundaries]

Is this accurate?
```

---

## Phase 2.5: Past Solutions Lookup

Check `docs/solutions/` for relevant past solutions:

```bash
grep -l "<keyword>" docs/solutions/**/*.md 2>/dev/null
```

**If matches found (max 3-5):**

```
Relevant Past Solutions:

1. **[Title]** (path)
   - Symptom: [from frontmatter]
   - Why relevant: [connection to problem]
```

Ask if learnings should inform approach selection.

**If no matches:** Proceed silently.
