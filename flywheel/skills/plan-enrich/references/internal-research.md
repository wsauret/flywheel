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
