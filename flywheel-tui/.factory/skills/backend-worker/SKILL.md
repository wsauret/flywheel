---
name: backend-worker
description: Implements TypeScript backend features with TDD, targeting prompt templates, evaluator alignment, and validation infrastructure
---

# Backend Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

Features involving TypeScript source changes to schemas, execution logic, prompt templates, evaluator alignment, dispatcher projections, and validation infrastructure. All implementation features in this mission use this worker type.

## Required Skills

None.

## Work Procedure

### 1. Understand the Feature

Read the feature description, preconditions, expectedBehavior, and verificationSteps carefully.

Read all source files referenced in the feature description and the AGENTS.md architecture notes to understand the current state.

Read `.factory/library/architecture.md` for existing patterns.

### 2. Write Tests First (TDD Red Phase)

**For new behavior:** Write failing tests before implementation.
**For refactoring/cleanup with no new behavior:** Existing tests serve as the safety net. Verify they pass before AND after changes. You may skip writing new tests if no new behavior is being added.

Before writing any implementation code (when adding new behavior):
- Create or update test files in `tests/` following existing patterns
- Write tests that cover each item in `expectedBehavior`
- Tests MUST fail initially (red phase) — verify by running `bun test <test-file>`
- For schema tests: test both valid and invalid inputs, backward compatibility
- For execution loop tests: use the existing mock patterns from `tests/unified-execution-loop.test.ts`
- For prompt tests: verify prompt content includes/excludes expected strings

Name test files following the existing pattern: `tests/<feature-area>.test.ts`

### 3. Implement the Feature (TDD Green Phase)

Write the minimum code to make tests pass:
- Follow existing patterns in the codebase (transport interfaces, schema patterns, execution loop hooks)
- Use Zod for all schema definitions, following `.strict()` pattern for handoff schemas
- Use the `Log` module for logging — NEVER use console.error/warn/debug
- Use `atomicWrite` for shared state files (stage context, validation state)
- Keep changes focused on the feature scope — do not refactor unrelated code

### 4. Run Full Test Suite

Run `bun test` and ensure ALL tests pass (3359+ existing + new tests). If existing tests break, your changes have unintended side effects — fix them.

### 5. Run Typecheck

Run `bunx tsc --noEmit` to verify no type errors were introduced.

### 6. Verify Manually

For schema features:
- Verify the schema accepts valid examples and rejects invalid ones in tests
- Verify backward compatibility with existing data formats

For execution loop features:
- Verify the new logic integrates with existing hooks and doesn't break the execution flow
- Check that the revision loop, approval gates, and phase chaining still work

For prompt features:
- Verify prompt output contains the expected new sections
- Verify prompt does NOT break existing template structure

### 7. Write to Knowledge Library

If you discovered ports, env vars, gotchas, or architectural patterns during implementation, write them to `.factory/library/architecture.md` or create a new topic file in `.factory/library/` before completing.

## Example Handoff

```json
{
  "summary": "Widened evaluator handoff projection to include warnings and decisions fields. Added 8 tests covering schema parsing, backward compat, and consumer projection. bun test passes (3367 tests), typecheck clean.",
  "artifacts": {
    "files_created": ["tests/handoff-projections.test.ts"],
    "files_modified": [
      "src/schemas/evaluator.ts",
      "src/schemas/handoff.ts",
      "src/handoff/consumers.ts",
      "src/controller/execution-loop.ts"
    ],
    "commands_run": ["bun test", "bunx tsc --noEmit"]
  },
  "decisions": [
    "Made warnings and decisions optional in EvaluatorHandoffData to preserve backward compat",
    "Used .pick() from WorkerHandoffSchema to keep evaluator projection DRY"
  ],
  "warnings": [],
  "verification": {
    "tests_passed": true,
    "test_output_summary": "3367 tests passing across 133 files. 8 new tests in handoff-projections.test.ts covering: evaluator gets warnings, evaluator gets decisions, dispatcher gets decisions/warnings/commands/files, backward compat with old handoffs, schema failure fallback."
  },
  "files_to_review": ["src/handoff/consumers.ts", "src/controller/execution-loop.ts"],
  "skillFeedback": {
    "followedProcedure": true,
    "deviations": [],
    "suggestedChanges": []
  }
}
```

## When to Return to Orchestrator

- Feature depends on code from a feature that hasn't been implemented yet (precondition not met)
- Existing test suite has failures unrelated to your changes (pre-existing failures)
- Schema changes would break backward compatibility in ways not covered by the feature description
- The feature is too large for a single session and needs splitting
