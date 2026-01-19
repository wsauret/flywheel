---
name: compounding
description: Document solved problems using parallel subagents. Captures solutions while context is fresh. Triggers on "that worked", "it's fixed", "document this", "compound".
allowed-tools:
  - Read
  - Grep
  - Glob
  - Task
  - Skill
  - AskUserQuestion
---

# Compounding Skill

Coordinate parallel subagents to document recently solved problems. Creates structured documentation in `docs/solutions/` for future reference.

**Why "compound"?** Each documented solution compounds your team's knowledge. First time solving a problem takes research. Document it, and the next occurrence takes minutes.

## Input

Optional context hint via `$ARGUMENTS`. If empty, extract from conversation history.

---

## Preconditions

Before proceeding:
- Problem has been solved (not in-progress)
- Solution has been verified working
- Non-trivial problem (not simple typo)

---

## Phase 1: Launch Parallel Subagents

Run ALL these agents simultaneously:

### Context Analyzer
```
Task general-purpose: "Extract from conversation: problem type, component, symptoms. Return YAML frontmatter skeleton."
```

### Solution Extractor
```
Task general-purpose: "Analyze investigation steps. Identify root cause. Extract working solution with code examples."
```

### Related Docs Finder
```
Task Explore: "Search docs/solutions/ for related documentation. Find cross-references and similar issues."
```

### Prevention Strategist
```
Task general-purpose: "Develop prevention strategies. Create best practices guidance. Generate test cases if applicable."
```

### Category Classifier
```
Task general-purpose: "Determine optimal docs/solutions/ category. Suggest filename based on slug."
```

---

## Phase 2: Invoke compound-docs Skill

After parallel agents complete, delegate to compound-docs skill:

```
skill: compound-docs
```

Pass collected context from parallel agents:
- YAML frontmatter from Context Analyzer
- Solution content from Solution Extractor
- Cross-references from Related Docs Finder
- Prevention content from Prevention Strategist
- File path from Category Classifier

---

## Phase 3: Optional Specialized Review

Based on problem type, invoke applicable agents:

| Problem Type | Agents |
|-------------|--------|
| performance_issue | performance-oracle |
| security_issue | security-sentinel |
| database_issue | data-integrity-guardian |
| Code-heavy issues | code-simplicity-reviewer, architecture-strategist |

---

## Phase 4: Present Results

```
✓ Parallel documentation generation complete

Subagent Results:
  ✓ Context Analyzer: Identified [problem_type] in [module]
  ✓ Solution Extractor: Extracted [N] code fixes
  ✓ Related Docs Finder: Found [N] related issues
  ✓ Prevention Strategist: Generated test cases
  ✓ Category Classifier: docs/solutions/[category]/

File created:
- docs/solutions/[category]/[filename].md

What's next?
1. Continue workflow (recommended)
2. Link related documentation
3. Add to Required Reading
4. View documentation
5. Other
```

---

## Key Principles

### Parallel for Speed
All initial agents run simultaneously. Don't serialize what can be parallelized.

### Delegate to compound-docs
The compound-docs skill handles YAML validation, file creation, and cross-referencing. This skill coordinates.

### Knowledge Compounds
```
Build → Test → Find Issue → Research → Improve → Document → Validate → Deploy
    ↑                                                                      ↓
    └──────────────────────────────────────────────────────────────────────┘
```

Each unit of engineering work should make subsequent units easier.

---

## Error Handling

### Agent Failures
- Log failure with agent name and error
- Continue with remaining agents
- compound-docs skill can proceed with partial context

### Missing Context
- If conversation history lacks solution details, ask user
- Don't guess at root cause or solution
- Better to ask than document incorrectly

### compound-docs Skill Failures
- If YAML validation fails, present errors to user
- Allow correction and retry
- Don't lose collected context on failure

---

## Anti-Patterns

- Don't document trivial fixes (typos, obvious errors)
- Don't document without verified working solution
- Don't skip parallel agents to save time
- Don't create vague documentation without code examples
- Don't forget cross-references to related issues

---

## Auto-Triggers

- "that worked"
- "it's fixed"
- "working now"
- "problem solved"
