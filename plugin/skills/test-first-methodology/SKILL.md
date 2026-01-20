---
name: test-first-methodology
description: TDD and systematic debugging methodology. Use when implementing features (start at RED phase) or debugging issues (start at ROOT CAUSE phase). Triggers on "implement", "new feature", "debug", "fix bug".
allowed-tools:
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Bash
  - Task
  - TodoWrite
---

# Test-First Methodology

Combines Test-Driven Development and Systematic Debugging into a unified methodology.

## Iron Laws

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

---

## Entry Points

### New Feature / Implementation

Start at **RED** phase. Follow the full TDD cycle.

### Debug / Bug Fix

Start at **ROOT CAUSE** phase. After identifying root cause, join TDD cycle at **RED**.

---

## TDD Cycle: RED-GREEN-REFACTOR

### RED: Write Failing Test

Write ONE minimal test showing what should happen.

**Requirements:**
- Test one behavior only
- Clear, descriptive name
- Use real code (mocks only if unavoidable)

```typescript
// Good: Clear name, tests real behavior
test('rejects empty email', async () => {
  const result = await submitForm({ email: '' });
  expect(result.error).toBe('Email required');
});

// Bad: Vague name, tests mock behavior
test('test validation', () => {
  const mock = jest.fn();
  // ...
});
```

### Verify RED: Watch It Fail

**MANDATORY. Never skip.**

```bash
npm test path/to/test.test.ts
```

Confirm:
- Test **fails** (not errors)
- Failure message is expected
- Fails because feature missing (not typos)

**Test passes immediately?** You're testing existing behavior. Fix test.

### GREEN: Minimal Code

Write the **simplest** code to pass the test.

```typescript
// Good: Just enough to pass
function validateEmail(email: string): boolean {
  return email.trim().length > 0;
}

// Bad: Over-engineered
function validateEmail(email: string, options?: {
  checkMX?: boolean;
  allowPlus?: boolean;
  // YAGNI
}): boolean { ... }
```

Don't add features, refactor other code, or "improve" beyond the test.

### Verify GREEN: Watch It Pass

**MANDATORY.**

```bash
npm test path/to/test.test.ts
```

Confirm:
- Test passes
- Other tests still pass
- Output pristine (no errors, warnings)

### REFACTOR: Clean Up

After green only:
- Remove duplication
- Improve names
- Extract helpers

Keep tests green. Don't add behavior.

### Repeat

Next failing test for next behavior.

---

## Debugging: ROOT CAUSE Investigation

**BEFORE attempting ANY fix:**

### Phase 1: Gather Evidence

1. **Read error messages carefully** - Stack traces, line numbers, error codes
2. **Reproduce consistently** - Can you trigger it reliably?
3. **Check recent changes** - Git diff, new dependencies, config changes

### Phase 2: Pattern Analysis

1. **Find working examples** - Similar working code in same codebase
2. **Compare against references** - Read reference implementations COMPLETELY
3. **Identify differences** - List every difference, however small

### Phase 3: Hypothesis and Testing

1. **Form single hypothesis** - "I think X is the root cause because Y"
2. **Test minimally** - ONE variable at a time
3. **Verify before continuing** - Didn't work? Form NEW hypothesis

**If 3+ fixes fail:** Stop. Question the architecture. Ask human partner.

### Phase 4: Join TDD Cycle

Once root cause is identified:
1. Write failing test that reproduces the bug (RED)
2. Watch it fail (Verify RED)
3. Implement fix (GREEN)
4. Watch it pass (Verify GREEN)
5. Clean up (REFACTOR)

---

## State Tracking

Use this checklist to track progress:

### TDD Cycle (per feature/fix)
- [ ] RED: Test written
- [ ] RED verified: Test fails for expected reason
- [ ] GREEN: Minimal code written
- [ ] GREEN verified: All tests pass
- [ ] REFACTOR: Code cleaned

### Debugging (when fixing bugs)
- [ ] Root cause: Evidence gathered
- [ ] Pattern: Working examples found
- [ ] Hypothesis: Theory formed and tested
- [ ] Then: TDD cycle completed

---

## Red Flags - STOP and Start Over

**TDD Violations:**
- Code before test
- Test after implementation
- Test passes immediately
- Tests added "later"
- "Just this once"
- "I already manually tested it"
- "Keep as reference"

**Debugging Violations:**
- "Quick fix for now, investigate later"
- "Just try changing X and see if it works"
- "It's probably X, let me fix that"
- "I don't fully understand but this might work"
- Proposing solutions before tracing data flow
- "One more fix attempt" (when already tried 2+)

**All of these mean: STOP. Return to proper phase.**

---

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "Too simple to test" | Simple code breaks. Test takes 30 seconds. |
| "I'll test after" | Tests passing immediately prove nothing. |
| "Emergency, no time" | Systematic is FASTER than guess-and-check. |
| "Issue is simple" | Simple issues have root causes too. |
| "TDD will slow me down" | TDD faster than debugging production. |
| "Deleting X hours is wasteful" | Keeping unverified code is technical debt. |

---

## When Stuck

| Problem | Solution |
|---------|----------|
| Don't know how to test | Write wished-for API. Ask human partner. |
| Test too complicated | Design too complicated. Simplify interface. |
| Must mock everything | Code too coupled. Use dependency injection. |
| Can't find root cause | Add diagnostic instrumentation. Gather more evidence. |
| 3+ fixes failed | Question architecture. Ask human partner. |

---

## Integration

This skill integrates with:
- **executing-work** - Use during implementation phases
- **verification-before-completion** - Evidence before claims

When in doubt: Write the test first. Find the root cause first.
