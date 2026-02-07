# Research Dispatch Templates

Task dispatch templates for Phase 1 codebase research. Use the locate→analyze pattern: run locators in parallel first (cheap, broad), then analyze top findings (targeted, deep).

## Locators (Run in Parallel)

Locators find WHERE relevant code lives. Run all three simultaneously.

### Codebase Locator

```
Task codebase-locator: "
Find files related to: <feature>
Looking for: similar features, shared utilities, configuration.
Categorize by: implementation, tests, config, types.
Return paths only.
"
```

### Pattern Locator

```
Task pattern-locator: "
Find patterns related to: <feature>
Looking for: naming conventions, architectural patterns, testing patterns.
Return file:line references only.
"
```

### Docs Locator

```
Task docs-locator: "
Find documentation about: <feature>
Search: README, CLAUDE.md, docs/, inline comments.
Return paths only.
"
```

## Analyzer (Targeted, After Locators)

Run after locator results are available. Feed the top 10-15 paths from all locators.

### Codebase Analyzer

```
Task codebase-analyzer: "
Analyze these files (from locator results):
- [top 10-15 paths]

Document:
1. Existing implementations of similar features
2. File structure and naming conventions
3. Architectural patterns used
4. Testing patterns for similar components

Return: file paths with line numbers (e.g., src/services/auth.ts:42)
Flag OPEN QUESTIONS for ambiguities or multiple valid approaches.
Documentarian mode - document what exists, no suggestions.
"
```

## Additional Checks

After running the analyzer, also check:
- `CLAUDE.md` for team conventions
- Recent similar features for precedent

## Consolidation

After all research completes, consolidate findings into:
- File paths with line numbers
- Existing patterns to follow
- Team conventions
- OPEN QUESTIONS about approach
