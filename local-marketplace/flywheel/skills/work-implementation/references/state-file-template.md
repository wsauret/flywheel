# State File Template

The state file enables recovery if orchestrator compacts mid-execution.

## File Location

```
docs/plans/<plan-name>.state.md
```

Derived from plan path: `docs/plans/feat-user-auth.md` → `docs/plans/feat-user-auth.state.md`

---

## Initial State File

```markdown
---
plan: <plan-name>.md
status: in_progress
schema_version: 3
---

# Execution State: <Plan Name>

## Progress
- [ ] Phase 1: <description>
- [ ] Phase 2: <description>
- [ ] Phase 3: <description>

## Key Decisions
<!-- Append decisions as they are made -->

## Learnings
<!-- Discoveries that would help a future agent -->

## Code Context
<!-- Track files modified/created -->

## Blockers (if any)
<!-- Issues preventing completion of current phase -->

## Error Log
<!-- Track errors per 3-Strike Protocol (see flywheel-conventions) -->

| Error | Attempt | Approach | Outcome |
|-------|---------|----------|---------|
```

### Progress Markers

| Marker | Meaning |
|--------|---------|
| `[ ]` | Not started |
| `[x]` | Complete |
| `[~]` | Awaiting manual verification |

---

## After Phase Completion

Update progress checkbox and append context:

```markdown
## Progress
- [x] Phase 1: Foundation setup
- [~] Phase 2: Core implementation (awaiting manual verification)
- [ ] Phase 3: Integration

## Key Decisions
- Phase 1: Using repository pattern for data access
- Phase 1: Tests in `__tests__/` directory

## Learnings
- Phase 1: Existing auth uses middleware pattern in `src/middleware/auth.ts`
- Phase 1: Tests expect mock database in `__mocks__/db.ts`

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
schema_version: 3
---
```

---

## Schema Version History

| Version | Changes |
|---------|---------|
| 1 | Initial: Progress, Key Decisions, Code Context |
| 2 | Added: Learnings, Blockers, `[~]` marker for awaiting manual |
| 3 | Added: Error Log table for 3-Strike tracking |

**Migration:** v2 → v3 is backward compatible. Missing Error Log section treated as empty.

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

Separate from state file. Located at: `docs/plans/<plan-name>.context.md`

Load from context file:
- **File References** - key files to understand
- **Gotchas & Warnings** - prevent common mistakes
- **Naming Conventions** - follow exactly
