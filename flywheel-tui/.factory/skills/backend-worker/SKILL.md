---
name: backend-worker
description: Implements TypeScript backend features with TDD, targeting dispatcher/evaluator transport optimization
---

# Backend Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

Features involving TypeScript source changes to the dispatcher, evaluator, engine, or config subsystems. All features in this mission use this worker type.

## Required Skills

None.

## Work Procedure

### 1. Understand the Feature

Read the feature description, preconditions, expectedBehavior, and verificationSteps carefully. Then read all source files referenced in the feature description to understand the current state.

Read `AGENTS.md` in the mission directory for architecture context, CLI flags per engine, and coding conventions. Read `.factory/library/architecture.md` for the transport pattern.

### 2. Write Tests First (TDD Red Phase)

Before writing any implementation code:
- Create or update test files in `tests/` following existing test patterns
- Write tests that cover each item in `expectedBehavior`
- Tests MUST fail initially (red phase) — verify by running `bun test <test-file>`
- For command construction tests: verify exact flags, order, and values
- For config flow tests: verify default behavior and override behavior
- For parsing tests: test both OpenCode NDJSON and Claude Code plain text output

Name test files following the existing pattern: `tests/<feature-area>.test.ts`

### 3. Implement the Feature (TDD Green Phase)

Write the minimum code to make tests pass:
- Follow existing patterns in the codebase (transport interfaces, engine provider patterns)
- Use the engine registry (`src/engines/core/registry.ts`) — do not hardcode engine commands
- Use `Bun.which()` to check engine binary availability before spawning
- Use the `Log` module for logging — NEVER use console.error/warn/debug
- Keep changes focused on the feature scope — do not refactor unrelated code

### 4. Run Full Test Suite

Run `bun test` and ensure ALL tests pass (2840+ existing + new tests). If existing tests break, your changes have unintended side effects — fix them before proceeding.

### 5. Manual Verification

For features that modify command construction:
- Log or print the constructed command in a test to visually verify it looks correct
- Verify that worker commands are NOT affected (check phase-executor still builds commands the same way)

For features that modify the verify-dispatcher script:
- Run `bun run scripts/verify-dispatcher.ts --help` (or equivalent) to verify the script loads
- If the feature involves real API calls, note in the handoff that live testing requires the engine CLI to be installed

### 6. Run Typecheck

Run `bunx tsc --noEmit` to verify no type errors were introduced.

## Example Handoff

```json
{
  "salientSummary": "Refactored SubprocessTransport to use engine registry for command building. Added Claude Code route with --tools '', --model, --system-prompt, --no-session-persistence, --effort low flags. Added OpenCode route with --model flag. Wrote 12 tests covering both engines, defaults, config overrides, and error cases. bun test passes (2852 tests), typecheck clean.",
  "whatWasImplemented": "Engine-aware SubprocessTransport in src/dispatcher/subprocess-transport.ts. Added buildDispatcherCommand() to both engine providers in src/engines/providers/claude/index.ts and src/engines/providers/opencode/index.ts. Updated EngineCommandOptions type to support dispatcher mode. Wired config.dispatcher.model through auto-detect.ts as actual CLI flag. Default model: 'sonnet' (claude) / 'anthropic/claude-sonnet-4-6' (opencode).",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      { "command": "bun test tests/dispatcher-transport.test.ts", "exitCode": 0, "observation": "12 tests passing, covers claude command building, opencode command building, default model, config override, error on missing binary" },
      { "command": "bun test", "exitCode": 0, "observation": "2852 tests passing across 114 files (12 new)" },
      { "command": "bunx tsc --noEmit", "exitCode": 0, "observation": "No type errors" }
    ],
    "interactiveChecks": []
  },
  "tests": {
    "added": [
      {
        "file": "tests/dispatcher-transport.test.ts",
        "cases": [
          { "name": "builds claude command with --tools '' and --model", "verifies": "Claude Code dispatcher flags are correct" },
          { "name": "builds opencode command with --model", "verifies": "OpenCode dispatcher flags are correct" },
          { "name": "defaults to sonnet model when not configured", "verifies": "Default model behavior" },
          { "name": "uses config dispatcher.model as --model flag", "verifies": "Config override flows to CLI" },
          { "name": "throws clear error when engine binary not found", "verifies": "Graceful error handling" }
        ]
      }
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- The engine CLI behavior differs from what's documented in AGENTS.md (e.g., `--tools ""` doesn't actually work)
- The EngineCommandOptions type needs changes that would break the worker spawn path
- The existing test suite has failures unrelated to your changes (pre-existing)
- Config schema changes would break backward compatibility
- The OpenCode SDK API doesn't support model parameter passing
