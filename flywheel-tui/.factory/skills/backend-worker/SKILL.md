---
name: backend-worker
description: Implements TypeScript backend features (queue engine, schemas, persistence, executor, config) with TDD
---

# Backend Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

Features involving core queue engine logic, Zod schemas, persistence, config parsing, event types, step execution, and any non-TUI TypeScript code.

## Required Skills

None.

## File Writing Rule (CRITICAL)

**Never write files longer than 100 lines in a single Create tool call.** Split large files: create the first ~100 lines with Create, then use sequential Edit calls to append remaining sections. This applies to all file types (.ts, .tsx, .test.ts, .json, .md). If a write fails or is cancelled, break it into smaller pieces — do NOT retry the same large write.

## Work Procedure

1. **Read the feature description carefully.** Understand preconditions, expected behavior, and verification steps. Read any files mentioned in the description.

2. **Read existing patterns.** Before writing new code, read the closest existing analog:
   - For queue/execution: `src/queue/executor.ts`, `src/queue/types.ts`, `src/queue/queue.ts`
   - For schemas: `src/schemas/session.ts`, `src/schemas/handoff.ts`
   - For persistence: `src/queue/persistence.ts`, `src/session/output-persistence.ts`
   - For events: `src/events/types.ts`, `src/events/event-bus.ts`
   - For config: `src/config/loader.ts`
   - For prompts: `src/prompts/plan/` directory
   Match existing patterns exactly (factory functions, DI, Zod schemas, atomic writes).

3. **Read ADR-004** at `docs/decisions/004-queue-execution-adr.md` if the feature involves execution model decisions. Read `.factory/library/json-plan-migration.md` if the feature involves plan prompts.

4. **Write failing tests first (RED).** Create test file in `tests/`. Write tests covering all expected behaviors from the feature description. Run `bun test <file>` to confirm they fail.

5. **Implement to make tests pass (GREEN).** Write the minimal implementation. Follow existing code conventions:
   - Factory functions (`createQueue()`, `createStepExecutor()`) over classes
   - Zod schemas for all data structures
   - `Log` module for logging (never console.*)
   - Atomic writes for persistence
   - DI for testability (pass dependencies as options)

6. **Run full test suite and typecheck:**
   ```bash
   bun test
   bun run typecheck
   ```
   Both must pass with zero errors.

7. **When deleting dead code:** If the feature description says to remove old modules, delete them and update all imports. Run typecheck to catch broken references. Fix all errors. NO fallback paths — when you replace something, delete the old thing completely. No conditional imports, no backwards compatibility.

8. **Commit your work** with a descriptive message.

## Terminology Enforcement

- Use "Step" not "Phase" in all new code
- Use "Queue" not "Pipeline" for the execution container
- Use "Workflow" not "PipelineMode" for templates
- When modifying existing files, rename phase → step in that file

## Example Handoff

```json
{
  "salientSummary": "Implemented Queue data model with Step schema, mutation API (insert/remove/skip/reorder/replace), and persistence following output-persistence.ts pattern. Wrote 18 unit tests covering all mutation operations and validation. bun test (18 passing), bun run typecheck (0 errors).",
  "whatWasImplemented": "src/queue/queue.ts (Queue factory, mutation API, cursor management), src/queue/step-schema.ts (Zod schema for Step with all 8 types), src/queue/persistence.ts (atomic write/load/debounced flusher), tests/queue.test.ts (18 test cases)",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      { "command": "bun test tests/queue.test.ts", "exitCode": 0, "observation": "18 tests passing, all mutation operations and edge cases covered" },
      { "command": "bun test", "exitCode": 0, "observation": "All 47 tests passing (18 new + 29 existing)" },
      { "command": "bun run typecheck", "exitCode": 0, "observation": "No type errors" }
    ],
    "interactiveChecks": []
  },
  "tests": {
    "added": [
      {
        "file": "tests/queue.test.ts",
        "cases": [
          { "name": "creates queue from workflow template", "verifies": "VAL-QUEUE-001" },
          { "name": "step transitions pending → running → completed", "verifies": "VAL-QUEUE-002, VAL-QUEUE-003" },
          { "name": "insert step after specific ID", "verifies": "VAL-QUEUE-010" },
          { "name": "cannot remove completed step", "verifies": "VAL-QUEUE-012" },
          { "name": "max steps limit enforced", "verifies": "VAL-QUEUE-017" }
        ]
      }
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- Feature depends on TUI components that don't exist yet
- Existing module has circular dependencies that block refactoring
- Schema migration needed that would break other features
- Config change would affect other running processes
