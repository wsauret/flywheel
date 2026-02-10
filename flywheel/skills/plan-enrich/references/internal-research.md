# Internal Research Reference

Detailed guidance for codebase research during plan verification.

## Existing Solutions Check

### What to Search For

When the plan proposes new functionality, search for:

1. **Direct matches** - Same feature already implemented
   ```bash
   # Search for function/class names similar to proposed
   grep -r "cache" --include="*.py" src/
   grep -r "Cache" --include="*.ts" src/
   ```

2. **Partial matches** - Related functionality that could be extended
   ```bash
   # Search for patterns the plan uses
   grep -r "redis\|memcached\|lru_cache" src/
   ```

3. **Utility functions** - Shared code that should be reused
   ```bash
   # Check common utility locations
   ls src/utils/ src/helpers/ src/lib/ shared/
   ```

### Assessment Questions

For each potential match, assess:
- **Reusability:** Can this be used as-is or with minor modifications?
- **Extension:** Can we add our feature to this existing code?
- **Replacement:** Should our new code replace this outdated version?

### Output Format

```
EXISTING_SOLUTION found:
- Path: src/services/cache_service.py
- Description: Redis-based caching with TTL support
- Reusability: HIGH - supports our use case with minor config changes
- Recommendation: Extend existing service instead of creating new
```

---

## Pattern Consistency Check

### Patterns to Verify

1. **Naming conventions**
   - File naming: `snake_case.py` vs `PascalCase.ts`
   - Class naming: `UserService` vs `user_service`
   - Function naming: `get_user` vs `getUser`

2. **Directory structure**
   - Where do services go? `src/services/` vs `app/services/`
   - Where do tests go? `tests/` vs `__tests__/` vs alongside code?
   - Where do types/interfaces go?

3. **Architectural patterns**
   - Repository pattern vs direct DB access?
   - Service layer vs fat controllers?
   - Dependency injection style?

4. **Error handling**
   - Custom exception classes?
   - Error response format?
   - Logging conventions?

### How to Discover Patterns

```bash
# Find how similar components are structured
find src -name "*service*.py" -exec head -50 {} \;

# Find existing test patterns
find tests -name "test_*.py" -exec head -30 {} \;

# Check for style guides
cat CLAUDE.md .editorconfig .prettierrc 2>/dev/null
```

### Output Format

```
PATTERN_CONFLICT found:
- Area: Error handling
- Current pattern: Uses custom AppException with error codes
- Plan proposes: Generic Exception with message strings
- Location: src/exceptions/ shows established pattern
- Recommendation: Adopt existing AppException pattern
```

---

## DRY Violation Check

### What Constitutes Duplication

1. **Exact duplication** - Same logic in multiple places
2. **Structural duplication** - Same pattern with different names
3. **Knowledge duplication** - Same business rule encoded twice

### Search Strategy

```bash
# Find similar function signatures
grep -rn "def process_" src/
grep -rn "async function handle" src/

# Find similar class structures
grep -rn "class.*Controller" src/
grep -rn "class.*Service" src/
```

### Questions to Answer

- Does proposed code duplicate existing functionality?
- Is there a shared abstraction this should use?
- Would creating this duplicate a pattern that should be centralized?

### Output Format

```
DRY_VIOLATION found:
- Proposed: New validation helpers in src/validators/user.py
- Existing: Similar validation in src/validators/common.py
- Overlap: Email validation, phone validation, required field checks
- Recommendation: Extend common.py with user-specific validators
```

---

## Integration Impact Check

### What to Analyze

1. **Direct dependencies** - What imports/uses the affected files?
2. **Indirect effects** - What depends on those dependents?
3. **Test coverage** - Which tests exercise this code?
4. **API contracts** - Will external consumers be affected?

### How to Find Dependencies

```bash
# Find what imports the affected module
grep -rn "from src.services.user import" .
grep -rn "import.*UserService" .

# Find tests for affected code
grep -rn "UserService" tests/

# Check for API route usage
grep -rn "/api/users" src/
```

### Risk Assessment Matrix

| Change Type | Risk Level | Verification Needed |
|-------------|------------|---------------------|
| New file | Low | Ensure no naming conflicts |
| Modify internal method | Medium | Unit tests for that method |
| Modify public interface | High | All consumers + integration tests |
| Delete code | Critical | Full dependency trace |

### Output Format

```
INTEGRATION_RISK found:
- Component: UserService.get_by_email()
- Consumers: 5 files import this
- Tests: 12 tests call this method
- Risk: Medium - signature change affects all consumers
- Recommendation: Add new method instead of modifying existing
```

---

## Phase 0: Learnings Discovery (Dispatch Details)

When `docs/solutions/` exists and contains files, extract keywords from the plan (module names, technologies, patterns) and search solution files. Auto-integrate the top 5 matches (no user selection required).

### Subagent Dispatch Template

For each matched solution file (up to 5), spawn:

```
Task codebase-analyzer: "Extract applicable insights from [solution_file]
for implementing [plan_topic]. Return: problem addressed, solution pattern,
applicable sections. MAX 200 words."
```

**Key insight:** Subagent contains full context, orchestrator only receives summary. This prevents context explosion.

### Learnings Integration Table

```markdown
### Learnings Applied

| Solution | Pattern | Applicable To |
|----------|---------|---------------|
| [solution_file] | [pattern summary] | [plan section] |
```

If no `docs/solutions/` directory exists, skip this phase entirely.

---

## Phase 2: Internal Research Dispatch Templates

All internal research subagents should run in parallel. Below are the exact dispatch templates for each subsection.

### 2.1 Locate Existing Solutions (Cheap Phase)

Run locators in parallel to find WHERE relevant code lives:

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

### 2.2 Analyze Findings (Targeted Phase)

Analyze top findings from locators:

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

### 2.3 DRY Violation Check Dispatch

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

### 2.4 Integration Impact Check Dispatch

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

---

## Phase 4: Per-Section Research Dispatch

Deep-dive research for each major plan section using isolated subagents.

### Section Identification Rules

Extract major sections from plan headings. **Include:**
- Technical Approach
- Implementation phases
- Architecture sections

**Exclude:**
- Status
- References
- Open Questions
- Metadata sections

**Performance cap:** Maximum ~5 sections per plan to avoid context overflow.

### Per-Section Subagent Dispatch Template

For EACH major section (up to 5). **Do NOT specify a `model` parameter** — let subagents inherit the current session's model.

```
Task Explore: "Research codebase patterns for: [section topic].

Context: This is for plan section '[section name]' which covers [brief description].

Questions:
1. What existing code patterns relate to this section?
2. Are there relevant utilities or shared components?
3. What testing patterns should we follow?

Return: relevant patterns, files, code examples. MAX 300 words summary."
```

**Key insight:** Context explosion avoided because subagent holds full research context, orchestrator only receives summary.

### Integration Format

Collect summaries from all subagents and organize by section:

```markdown
### Per-Section Research

#### [Section Name]
- **Patterns found:** [list]
- **Relevant files:** [paths with line numbers]
- **Testing approach:** [summary]
```

---

## Internal Research Checklist

Before spawning external research, verify internal research answered:

- [ ] Does similar functionality exist in our codebase?
- [ ] Does the approach fit our established patterns?
- [ ] Will this create code duplication?
- [ ] What integration risks exist?
