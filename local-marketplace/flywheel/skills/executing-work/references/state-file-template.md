# State File Template

The state file enables recovery if orchestrator compacts mid-execution.

## File Location

```
plans/<plan-name>.state.md
```

Derived from plan path: `plans/feat-user-auth.md` → `plans/feat-user-auth.state.md`

---

## Initial State File

```markdown
---
plan: <plan-name>.md
status: in_progress
schema_version: 1
---

# Execution State: <Plan Name>

## Progress
- [ ] Phase 1: <description>
- [ ] Phase 2: <description>
- [ ] Phase 3: <description>

## Key Decisions
<!-- Append decisions as they are made -->

## Code Context
<!-- Track files modified/created -->
```

---

## After Phase Completion

Update progress checkbox and append context:

```markdown
## Progress
- [x] Phase 1: Foundation setup
- [ ] Phase 2: Core implementation
- [ ] Phase 3: Integration

## Key Decisions
- Phase 1: Using repository pattern for data access
- Phase 1: Tests in `__tests__/` directory

## Code Context
- Created: `src/services/auth.ts`
- Modified: `src/routes/index.ts`
```

---

## Completed State

```markdown
---
plan: <plan-name>.md
status: completed
schema_version: 1
---
```

---

## Recovery Process

If orchestrator compacts mid-execution:

1. New instance reads state file
2. Finds first unchecked phase in Progress
3. Loads Key Decisions for context
4. Resumes execution from that phase

**No work is lost.**

---

## Context File

Separate from state file. Located at: `plans/<plan-name>.context.md`

Load from context file:
- **File References** - key files to understand
- **Gotchas & Warnings** - prevent common mistakes
- **Naming Conventions** - follow exactly
