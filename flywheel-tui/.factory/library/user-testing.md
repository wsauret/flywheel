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
- Evaluator structured issues: `tests/evaluator-structured-issues.test.ts`, `tests/evaluator.test.ts`
- Issue gating: `tests/issue-gating.test.ts`, `tests/unified-execution-loop.test.ts`
- Cross-cutting (evaluator-gating): `tests/integration/handoff-flow.test.ts`, `tests/issue-gating.test.ts`, `tests/unified-execution-loop.test.ts`
- Validation auto-injection: `tests/milestone-tracker.test.ts`, `tests/execution-loop-milestone-injection.test.ts`
- Scrutiny validation: `tests/scrutiny-validation.test.ts`
- Behavioral validation: `tests/behavioral-validation.test.ts`
- Validation state: `tests/validation-state.test.ts`
- End-of-session gate: `tests/validation-state.test.ts` (checkEndOfSessionGate tests)
- Cross-cutting (validation-execution): `tests/execution-loop-milestone-injection.test.ts`, `tests/behavioral-validation.test.ts`, `tests/validation-state.test.ts`

## Flow Validator Guidance: Sprint E2E Testing (tmux)

**Testing approach:** Sprint E2E assertions (VAL-E2E-001 through VAL-E2E-005) are verified by running Flywheel in Sprint mode via tmux on a simple test project and inspecting timing, artifacts, and logs.

**Setup:**
1. Create a clean git project in `/tmp/flywheel-sprint-val/` with `package.json`, `tsconfig.json`, `README.md`, `flywheel.toml`
2. Configure `flywheel.toml` with `skip_approval_gates = true`, sonnet model, and `[sprint]` section with desired max_iterations
3. Kill any existing tmux sessions before starting

**Running sprint mode:**
1. Start Flywheel TUI in tmux: `tmux new-session -d -s flywheel-sprint -x 120 -y 40 'cd /Users/wsauret/Documents/GitHub/flywheel/flywheel-tui && FLYWHEEL_PROJECT_CWD=/tmp/flywheel-sprint-val FLYWHEEL_SKIP_APPROVAL_GATES=true bin/flywheel'`
2. Wait 3s, verify launcher screen appears
3. Send `/start add a hello world function with tests` Enter
4. Wait 2s, select option 5 (Sprint)
5. Record start timestamp
6. Poll every 10s for completion
7. Record end timestamp, calculate total duration

**Artifact locations (all relative to `/tmp/flywheel-sprint-val/`):**
- Verification scripts: `.flywheel/verify/*.sh` or `.flywheel/verify/*.ts`
- Handoff files: `.flywheel/handoffs/*.json` (check for `verification_script_path` and `iteration_number`)
- Log files: `.flywheel/log/*.log`

**What to check per assertion:**
- VAL-E2E-001: Sprint completed within 5 minutes, verification script exists and passed
- VAL-E2E-002: Sprint iterated (>1 handoff file), second attempt incorporated feedback
- VAL-E2E-003: Sprint exhausted iterations, escalated to full pipeline (check log for escalation events)
- VAL-E2E-004: User cancellation (send Escape twice), clean shutdown, no orphaned processes
- VAL-E2E-005: Log file has zero ERROR lines after successful sprint

**Latency optimization:** The E2E milestone focuses on minimizing sprint latency. Measure and report total wall-clock time for trivial features. Target: under 5 minutes. If exceeding target, investigate prompt size, evaluator overhead, and worker startup time.

## Flow Validator Guidance: E2E Pipeline (tmux)

**Testing approach:** E2E assertions (VAL-E2E-001 through VAL-E2E-007) are verified by running a full Flywheel pipeline (plan → work → review) via tmux on a simple test project and then inspecting the produced artifacts.

**Setup:**
1. Create a clean git project in `/tmp/flywheel-e2e-val/` with `package.json`, `README.md`, `flywheel.toml`
2. Configure `flywheel.toml` with `skip_approval_gates = true`, sonnet model, short timeouts
3. Kill any existing `flywheel-e2e-val` tmux sessions before starting

**Running the pipeline:**
1. Start Flywheel TUI in tmux: `tmux new-session -d -s flywheel-e2e-val -x 120 -y 40 'cd /Users/wsauret/Documents/GitHub/flywheel/flywheel-tui && FLYWHEEL_PROJECT_CWD=/tmp/flywheel-e2e-val FLYWHEEL_SKIP_APPROVAL_GATES=true bin/flywheel'`
2. Wait 3s, verify launcher screen appears
3. Send `/start create a simple hello world function in hello.ts with tests in hello.test.ts` Enter
4. Wait 2s, select option 3 (Plan + Work + Review)
5. Poll every 15s for completion (look for "Completed" or idle state)
6. Timeout at 25 minutes

**Artifact locations (all relative to `/tmp/flywheel-e2e-val/`):**
- Handoff files: `.flywheel/handoffs/*.json`
- Stage context: `.flywheel/stage-context.json`
- Validation contract: `.flywheel/plans/*validation-contract.md`
- Plan files: `.flywheel/plans/*.md` (check for `## Milestone:` markers)
- State files: `.flywheel/plans/*.state.md`
- Validation state: `validation-state.json` (project root)
- Log files: `.flywheel/log/*.log`

**What to check per assertion:**
- VAL-E2E-001: Pipeline completed (saw plan, work, review states), no ERROR lines in log
- VAL-E2E-002: At least one handoff JSON has `decisions` or `warnings` field
- VAL-E2E-003: `.flywheel/stage-context.json` exists and has cumulative data arrays
- VAL-E2E-004: A `*validation-contract.md` file exists with `VAL-` prefixed IDs
- VAL-E2E-005: A plan `.md` file contains `## Milestone:` marker
- VAL-E2E-006: Log file contains "milestone validation triggered" or "Scrutiny:" or "Validation:" phase names
- VAL-E2E-007: `validation-state.json` exists with `assertions` object

**Isolation:** Only one E2E pipeline can run at a time (single tmux session). Uses `/tmp/flywheel-e2e-val/` as isolated project directory. Does not modify the flywheel-tui source.

**Gotchas:**
- The TUI uses Claude Code workers — requires valid claude CLI auth (OAuth, not API key)
- Pipeline takes 10-25 minutes depending on API response times
- Handoff file content depends on worker behavior — not all handoffs will have all fields (review handoffs use different schema)
- If the pipeline stalls, check the log file for WARN/ERROR lines
- The `FLYWHEEL_PROJECT_CWD` env var tells Flywheel to operate on the test project instead of its own directory
