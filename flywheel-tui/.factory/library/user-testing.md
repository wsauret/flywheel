---
title: "User Testing Guide"
summary: "Testing conventions, tools, and setup for user testing validation"
tags: [testing, validation, user-testing]
---

# User Testing Guide

## Environment

- **Runtime:** Bun (not Node)
- **Test command:** `bun test` (runs all 4321+ tests)
- **Typecheck command:** `bun run typecheck` (runs tsc --noEmit)
- **TUI launch:** `bin/flywheel` (requires `--conditions=browser` flag, handled by wrapper)
- **No external services required.** TUI runs locally. Workers spawned as subprocesses.

## Testing Tools

### Unit/Integration Tests (bun test)
Most assertions in this project are verified via test output. The test suite covers:
- Queue execution engine (`tests/step-executor.test.ts`)
- Queue mutations and schemas (`tests/queue.test.ts`, `tests/queue-schema.test.ts`)
- Guardrails (`tests/guardrails.test.ts`)
- Feature quality gates (`tests/feature-quality-gates.test.ts`)
- Plan prompts and JSON parsing (`tests/plan-prompts.test.ts`, `tests/plan-json-parser.test.ts`)
- Shell queue wiring (`tests/shell-queue-wiring.test.ts`)
- Workflow definitions (`tests/workflows.test.ts`)

### File System Checks
Some assertions verify deletion of legacy files:
- `src/controller/plan-parser.ts` should NOT exist
- `src/state/` directory should NOT exist
- `src/schemas/state.ts` should NOT exist

### TUI Testing (tuistory)
VAL-JSON-006 and VAL-CROSS-001 require TUI interaction via tmux.
- The TUI uses OpenTUI + SolidJS
- Start with: `bin/flywheel`
- tmux session name: use unique names per test to avoid conflicts

## Validation Concurrency

### Surface: bun test
Max concurrent validators: 3
Rationale: `bun test` runs all tests in a single process. Multiple concurrent test runs could interfere with each other if they use shared temp dirs. However, targeted test file runs are safe in parallel since each test creates its own isolated fixtures.

### Surface: file system check
Max concurrent validators: 5
Rationale: Read-only file existence checks, no shared state.

### Surface: tuistory
Max concurrent validators: 1
Rationale: TUI testing requires exclusive tmux access and terminal rendering. Only one TUI instance should run at a time.

## Flow Validator Guidance: bun test

### Isolation Rules
- Each subagent should run specific test files, not the full suite
- Test files use isolated temporary directories for fixtures
- No shared database or state between test files
- Safe to run different test files concurrently

### Boundaries
- Do NOT modify any source code or test files
- Only READ test output and verify assertions pass
- Run tests with `bun test <specific-test-file>` format

## Flow Validator Guidance: file system

### Isolation Rules
- Read-only checks — no shared state concerns
- Use `ls`, `test -f`, `test -d`, and `rg` for verification
- Do NOT create or delete any files

## Flow Validator Guidance: tuistory

### Isolation Rules
- Only one TUI instance at a time
- Use unique tmux session names
- Clean up tmux sessions after testing
- Do NOT modify source code during testing
