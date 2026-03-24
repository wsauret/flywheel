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
- Relevant test files for this milestone:
  - `tests/engine-dispatcher-commands.test.ts` — engine command construction
  - `tests/dispatcher-subprocess-transport.test.ts` — subprocess transport
  - `tests/dispatcher-sdk-transport.test.ts` — SDK transport
  - `tests/evaluator-transport.test.ts` — evaluator transport
  - `tests/evaluator-production-wiring.test.ts` — evaluator wiring
  - `tests/verify-dispatcher.test.ts` — verify script tests
  - `tests/dispatcher.test.ts` — existing dispatcher tests
  - `tests/evaluator.test.ts` — existing evaluator tests
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
