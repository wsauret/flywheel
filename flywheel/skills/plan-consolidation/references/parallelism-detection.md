# Parallelism Detection

How to identify phases that can safely run in parallel during `/fly:work` execution.

## Philosophy

**Sequential is the default.** Only annotate parallel groups when you're confident the phases are independent. False parallelism causes merge conflicts and wasted work. False sequentiality just costs a bit of time.

## When to Annotate

Analyze the final implementation checklist for phases that meet ALL of these criteria:

### Required: File Disjointness

The phases must touch **different files and directories**. Check:

- [ ] No file appears in both phases' step lists
- [ ] No directory is the target of creation/modification in both phases
- [ ] No shared config files are modified by both (e.g., `package.json`, `tsconfig.json`, route registrations, barrel exports)

**Common shared files that break disjointness:**
- Route/module registration files (e.g., `src/routes/index.ts`, `src/app.ts`)
- Barrel export files (e.g., `src/index.ts`, `src/components/index.ts`)
- Config files (`package.json`, `tsconfig.json`, `.env`)
- Database schema files (if both phases add migrations)
- Test setup/fixture files shared between test suites

### Required: No Data Dependencies

Neither phase consumes outputs produced by the other:

- [ ] Phase A doesn't import types/functions defined in Phase B
- [ ] Phase B doesn't import types/functions defined in Phase A
- [ ] Neither phase reads files created by the other
- [ ] No shared state (database tables, config values) where one writes and the other reads

### Encouraged: Different Domains

Parallel phases work best when they're in clearly separate areas:

- Frontend vs backend
- Different modules/services with no shared interfaces
- Feature code vs documentation
- Independent test suites
- Different API endpoints that share no handlers

## Annotation Syntax

Mark parallel phases with `<!-- parallel-group: N -->` comments immediately after the phase heading:

```markdown
### Phase 2: API endpoints
<!-- parallel-group: 1 -->

- [ ] **Step 2.1: Create user endpoint...**

### Phase 3: CLI commands
<!-- parallel-group: 1 -->

- [ ] **Step 3.1: Add CLI handler...**

### Phase 4: Integration tests
<!-- No parallel annotation = sequential (depends on Phase 2 + 3) -->

- [ ] **Step 4.1: Test API + CLI together...**
```

**Rules:**
- Phases in the same `parallel-group: N` run concurrently
- Phases without an annotation run sequentially (the default)
- A parallel group's phases all start after all prior sequential/group phases complete
- A phase after a parallel group waits for ALL phases in that group to finish
- Multiple parallel groups are allowed (use incrementing N)

## Detection Procedure

After building the implementation checklist in Phase 4 (Synthesize):

1. **List each phase's file footprint** — every file referenced in its steps (created, modified, imported from)
2. **Build a dependency matrix** — for each pair of phases, check file overlap and data flow
3. **Identify candidate groups** — adjacent phases with no overlap
4. **Validate candidates** against the shared-file gotchas list above
5. **Annotate conservatively** — when in doubt, leave sequential

## Examples

### Good Parallel Candidates

```
Phase 1: Database schema     → creates src/db/migrations/, src/db/models/
Phase 2: API endpoints        → creates src/api/users.ts, src/api/auth.ts [depends: Phase 1]
Phase 3: Email templates      → creates src/templates/email/ [depends: Phase 1]
```
→ Phases 2 and 3 can be `parallel-group: 1` (both depend on Phase 1, neither touches the other's files)

```
Phase 1: Core feature         → modifies src/services/billing.ts
Phase 2: Admin dashboard      → creates src/admin/billing-view.tsx
Phase 3: Documentation        → creates docs/billing.md
```
→ Phases 2 and 3 can be `parallel-group: 1` if Phase 2 doesn't import from billing-view

### Bad Parallel Candidates

```
Phase 1: Create user model    → creates src/models/user.ts, modifies src/models/index.ts
Phase 2: Create auth service  → creates src/services/auth.ts, modifies src/models/index.ts
```
→ Both modify `src/models/index.ts` — NOT parallel-safe

```
Phase 1: Create types         → creates src/types/api.ts
Phase 2: Create handlers      → imports from src/types/api.ts
```
→ Phase 2 depends on Phase 1's output — NOT parallel-safe

## What NOT to Do

- **Don't force parallelism** — most plans are naturally sequential. Zero parallel groups is fine.
- **Don't split a phase to create parallelism** — the plan structure should reflect logical grouping, not optimization.
- **Don't parallelize phases that share barrel/index files** — the merge conflict is almost guaranteed.
- **Don't parallelize when unsure** — sequential is always safe.
