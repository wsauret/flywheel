# User Testing

Testing surface, required testing skills/tools, and resource cost classification.

**What belongs here:** How to validate the mission output through its real user surface.

---

## Validation Surface

### Primary: verify-dispatcher script
- Path: `scripts/verify-dispatcher.ts`
- Run: `bun run scripts/verify-dispatcher.ts [--engine=claude|opencode] [--transport=sdk|cli] [--verbose]`
- Validates: dispatcher response, schema conformance, timing
- Saves artifacts to `.flywheel/verify-dispatcher/`

### Secondary: Unit tests
- Run: `bun test`
- Validates: command construction, config flow, parsing, error handling

### Tertiary: TUI via tmux
- The full TUI can be tested via tmux to verify end-to-end dispatcher flow
- Start: `tmux new-session -d -s flywheel -x 120 -y 40 'cd /Users/wsauret/Documents/GitHub/flywheel/flywheel-tui && bin/flywheel'`
- Test: `/start <description>` triggers the dispatcher as part of the pipeline
- Note: TUI testing requires real API calls and takes several minutes

## Validation Concurrency

### verify-dispatcher script
- Resource cost: minimal (one subprocess at a time)
- Max concurrent: 5 (limited by API rate limits, not local resources)

### bun test
- Resource cost: ~2GB RAM for full test suite
- Max concurrent: 1 (single bun test process)

### TUI via tmux
- Resource cost: ~500MB (TUI + spawned engine process)
- Max concurrent: 2 (but typically 1 for focused testing)

## Flow Validator Guidance: Unit Tests (bun test)

**Isolation rules:**
- Run `bun test` once from the repo root — do NOT run tests in parallel or from different directories
- The test suite is self-contained; no external services or API calls required
- Test files are in `tests/` directory at repo root
- Relevant test files for evaluator-retry-and-revision milestone:
  - `tests/evaluator-retry.test.ts` — evaluator retry logic fix (VAL-RETRY-*)
  - `tests/revision-infrastructure.test.ts` — config, events, sessionId, PhaseExecutor resumeSessionId (VAL-REV-002, 007, 009, 010)
  - `tests/revision-loop.test.ts` — core revision loop in execution loop (VAL-REV-001, 003-006, 008, 011-018, VAL-CROSS-001)
  - `tests/evaluator.test.ts` — existing evaluator tests (should still pass)
  - `tests/evaluator-activation.test.ts` — existing evaluator activation tests (should still pass)
- Relevant test files for evaluator-prompt-alignment milestone:
  - `tests/evaluator-alignment.test.ts` — workflow criteria, task context, evaluator prompt (VAL-ALIGN-*)
- Relevant test files from prior milestones (regression):
  - `tests/engine-dispatcher-commands.test.ts` — engine command construction
  - `tests/dispatcher-subprocess-transport.test.ts` — subprocess transport
  - `tests/dispatcher-sdk-transport.test.ts` — SDK transport
  - `tests/evaluator-transport.test.ts` — evaluator transport
  - `tests/evaluator-production-wiring.test.ts` — evaluator wiring
  - `tests/dispatcher.test.ts` — existing dispatcher tests
  - `tests/engines.test.ts` — engine registry tests

**What to check:**
- All tests pass (`bun test` exit code 0)
- For each assertion, find the specific test(s) that verify it by examining test file contents
- Check test names match assertion requirements (e.g., "engine-aware transport selection" tests for VAL-DISP-001)

## Flow Validator Guidance: verify-dispatcher Script

**Isolation rules:**
- Run from repo root: `cd /Users/wsauret/Documents/GitHub/flywheel/flywheel-tui`
- Script path: `scripts/verify-dispatcher.ts`
- Run with `bun run scripts/verify-dispatcher.ts [flags]`
- Artifacts saved to `.flywheel/verify-dispatcher/`
- Each run is independent; no shared state between runs

**What to check:**
- `--help` shows engine flag documentation (VAL-SCRIPT-001)
- `--engine=claude` and `--engine=opencode` both accepted (VAL-SCRIPT-001)
- Output includes timing data like "Dispatcher responded in X.Xs" (VAL-SCRIPT-002)
- For live API tests: response validates against DispatcherDecisionSchema (VAL-DISP-005, VAL-CROSS-002)
- `--dry-run` can verify assembly without API calls

**Important:** Live API tests require the engine CLI to be installed and API keys configured. If an engine is not available, the script should fail gracefully.

## Flow Validator Guidance: Research Output Validation

**Isolation rules:**
- Run from repo root: `cd /Users/wsauret/Documents/GitHub/flywheel/flywheel-tui`
- Validator script: `scripts/validate-research-output.ts`
- Test harness: `scripts/test-research-harness.ts`
- Fixtures in `tests/fixtures/research/`

**What to check for research output validation (VAL-RQ-*):**
- Validator script exists and runs: `bun run scripts/validate-research-output.ts <file> --variant plan|standalone`
- Returns JSON with per-criterion pass/fail
- Good fixtures pass; bad fixtures fail expected criteria
- Test suite: `bun test tests/research-output-validation.test.ts`

**What to check for real output validation (VAL-RO-*):**
- Test harness exists and runs: `bun run scripts/test-research-harness.ts --mode plan --description '<text>' --cwd <path>`
- Harness spawns real workers (MAKES REAL API CALLS)
- Captures output and validates against the research output validator
- Run against minimal fixture: `--cwd tests/fixtures/research-target/`
- Run against flywheel-tui: `--cwd .`

**Important:** Real output validation requires Claude or OpenCode CLI installed and API keys configured. Each run takes 2-5 minutes.

**What to check for prompt template changes (VAL-RP-*):**
- `bun test tests/workflows.test.ts` — prompt routing tests
- `bun test tests/prompts.test.ts` — prompt content tests
- Inspect prompt output for correct conventions and step-specific content

**What to check for evaluator alignment (VAL-EA-*):**
- `bun test tests/evaluator-alignment.test.ts` — alignment tests
- Research workflow validationCriteria are research-oriented, task-adaptive

## Flow Validator Guidance: eval-prompts Script

**Isolation rules:**
- Run from repo root: `cd /Users/wsauret/Documents/GitHub/flywheel/flywheel-tui`
- Script path: `scripts/eval-prompts.ts`
- Run with `bun run scripts/eval-prompts.ts [flags]`
- Artifacts saved to `.flywheel/eval-prompts/<run-id>/`
- Each run is independent; no shared state between runs
- Resource cost: moderate (6 LLM calls for 3 scenarios × 2 transports, plus 6 judge calls)
- Max concurrent: 1 (serial scenario execution within the script)

**What to check for VAL-PROMPT-001:**
- Script exists at scripts/eval-prompts.ts with --engine, --baseline, --compare, --verbose, --help flags
- Fixture file exists at scripts/eval-prompts-fixtures.ts with 3 scenarios (simple, complex, edge)
- Running --baseline captures golden outputs to .flywheel/eval-prompts/baseline/
- Running --compare loads baseline and prints comparison delta
- Judge scores are captured for dispatcher (clarity, completeness, actionability) and evaluator (accuracy, thoroughness, usefulness)

**What to check for VAL-PROMPT-004:**
- All 3 scenarios produce schema_valid: true for both dispatcher and evaluator
- The summary.json shows 0 schema validation failures

**Important:** Live API tests require claude or opencode CLI installed and API keys configured.
