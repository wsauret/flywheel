# User Testing

Testing surface, required testing skills/tools, and resource cost classification.

**What belongs here:** How to test the user-facing surface, tools needed, concurrency limits.

---

## Validation Surface

This mission modifies internal engine code (schemas, execution loop, evaluator, dispatcher, handoff consumers). The primary validation surfaces are:

1. **Unit tests** (`bun test`) — all schema, logic, and integration testing
2. **Type checking** (`bunx tsc --noEmit`) — type safety verification
3. **E2E via tmux** — final milestone only, tests full pipeline with TUI

## Validation Concurrency

- **Unit tests**: Bun runs tests in parallel by default. Machine has 11 cores, 36GB RAM. No concurrency limits needed.
- **E2E tmux tests**: Sequential only (one tmux session at a time). Each run takes 5-15 minutes depending on API response times.

## Tools
- `bun test` — unit and integration tests
- `bunx tsc --noEmit` — type checking
- `tmux` — E2E TUI testing (see project AGENTS.md for patterns)
- No browser testing needed (no web UI changes)

## Flow Validator Guidance: Unit Tests

**Testing approach:** All handoff-context milestone assertions are verified through unit tests and code/schema inspection. There is no user-facing UI surface to test.

**Isolation:** Each flow validator subagent can safely run `bun test <specific-test-file>` in parallel — Bun's test runner handles file-level parallelism. Subagents should NOT run the full test suite simultaneously (resource contention); instead, run only the specific test files relevant to their assertion group.

**Shared state boundaries:** No shared state concerns — all tests are pure unit tests with no database, no filesystem side effects (tests mock/cleanup as needed), and no network calls.

**How to verify an assertion:**
1. Find the relevant test file(s) covering the assertion's behavior
2. Run those specific tests: `bun test <path-to-test-file>`
3. Inspect test names and assertions to confirm they match the validation contract assertion
4. If needed, inspect source code to verify schema/implementation details
5. Record: test file, test names, pass/fail status, and key observations

**Key test files by area:**
- Handoff projections: `tests/schemas/handoff.test.ts`, `tests/handoff/consumers.test.ts`, `tests/integration/handoff-flow.test.ts`
- Content quality: `tests/schemas/handoff.test.ts`
- Stage context: Look for `stage-context` in test filenames
- Knowledge library: Look for `library` or `knowledge` in test filenames, also check prompt builder tests
- Skill feedback: `tests/schemas/handoff.test.ts`
- Boundaries: Look for `boundaries` or `config` in test filenames, also check prompt tests
