# Flywheel CLI — Agent Instructions

## Project overview

Flywheel CLI is a terminal UI application that executes workflow plans. It spawns AI worker processes (Claude or OpenCode), runs plan phases sequentially, and provides a rich TUI built with OpenTUI + SolidJS.

**Runtime:** Bun (not Node)
**TUI framework:** OpenTUI (`@opentui/core` + `@opentui/solid`) with SolidJS signals
**Config format:** TOML (`flywheel.toml`), not YAML
**Important:** SolidJS must resolve with the `"browser"` export condition. The `bin/flywheel` wrapper handles this with `bun --conditions=browser`.

## Queue Architecture

The queue engine executes a sequence of typed steps. Each step type + variant is a self-contained module under `src/queue/steps/`. Shared infrastructure lives in `src/queue/shared/`.

**Steps are modular and self-contained.** Every step variant is a folder with three files: `fields.ts` (handoff field specs), `scaffolding.ts` (prompt assembly), and `prompts.ts` (prompt text constants). Some variants also have `hooks.ts` for post-completion behavior. A step folder contains everything needed to understand that step's behavior.

**Scaffolding is thin assembly, prompts hold the text.** `scaffolding.ts` registers a strategy and composes the preamble/postamble from constants defined in `prompts.ts`. Prompt text, examples, and instructions live in `prompts.ts` -- scaffolding never contains long string literals.

**Schemas live with their owners.** Worker handoff schemas (used by all steps) live in `queue/shared/handoff-schemas.ts`. Evaluator-specific schemas live in `evaluator/schemas.ts`. Dispatcher-specific schemas live in `dispatcher/schemas.ts`. If a schema is consumed by exactly one module, it belongs in that module.

**Registration over wiring.** Step variants register their scaffolding strategy via side-effect imports (`registerScaffolding`). A single `register-all.ts` populates the registry. The orchestrator dispatches by variant key without knowing individual step implementations.

**Hooks are step-scoped.** Post-completion hooks (plan integration, sprint loops, review triage, debug loops) live in the step variant folder that owns the behavior, not in a central hooks file. The shared `createCompositeHook` composes them at the orchestrator level.

**Colocate what's used once, share what's used across steps.** If a constant, schema, or helper is consumed by a single step variant, it belongs in that variant's folder. It moves to `queue/shared/` only when two or more variants depend on it. Conventions, handoff rendering, and the scaffolding registry are genuinely shared.

**No dead code, even if tested.** If a symbol is only imported in test files and never used in production code, delete both the symbol and its tests. Tests exist to verify production behavior, not to keep unused code alive. Git history is the recovery mechanism.

**Built means wired.** A module that compiles but is never called from the production entry point does not exist. Every new module must be imported and invoked in the live application before its PR merges. If you cannot demonstrate the feature running in the TUI via tmux, it is not done.

**Unit tests prove logic, not integration.** A test suite that passes only shows the module works in isolation. It says nothing about whether the module is reachable from the running application. After wiring a feature, verify it in the live TUI -- not just in the test harness.

**Test the wiring, not just the parts.** When you connect a new module to the system, the E2E verification must exercise the actual integration path: start the TUI, trigger the feature, observe the result on screen or in logs. Calling `bun test` is necessary but never sufficient for wiring changes.

**No single-file directories.** If a directory contains exactly one file, flatten it. `src/telemetry/logger.ts` becomes `src/telemetry.ts`. The directory earns its existence when a second file joins it.

**Imports reveal misplacement.** If a file's imports all reach three or more levels up (`../../../`), it probably lives too deep. If every consumer of a module reaches across subsystem boundaries to import it, the module is in the wrong subsystem. Let import paths guide where things belong.

**One domain, one home.** Each concept (plan parsing, handoff schemas, sprint types) lives in exactly one place. No re-exports, bridge files, or compatibility shims. When a module moves, update every import -- do not leave a forwarding address.

## Agent Behavior

Always test your changes by running the code. Then fix any errors that arise.
If you write new code and the linter has an error or warning, you must fix the code before moving on.
Do not add comments when editing a file unless they explain the new logic in the code you are adding.
Do not ever use emojis in your code.

## Coding Rules

DRY - Reuse existing code instead of writing it from scratch. Use grep to determine whether the logic already exists and extend that implementation instead then import it.
SOLID - Always follow the solid principles, especially single responsibility. It makes code composable and reusable making it easier to follow DRY.
Never mock anything. Never use a placeholder. Never omit code.
Always fully wire any new code into the system! Verify the wiring by running the TUI and exercising the feature end-to-end. Unit tests alone do not prove wiring -- if you cannot trigger it from the running app, it is unwired.

## Using TypeScript

We are using Node 20+ with TypeScript targeting ES2022, please code everything according to modern ES standards.
Use ESM modules (import/export), not CommonJS (require/module.exports).
All imports must include the `.js` extension for local files (e.g., `import { foo } from './bar.js'`).
Do not use scoped imports unless there is a non-negligible performance benefit, prefer putting imports at the top of the file.
Document any complex logic with concise comments.
Prefer template literals for string manipulation.
Prefer hardcoding values over inventing new environment variables.
Use Temporal API (from @js-temporal/polyfill) for date handling, not Date objects.
Use Zod for runtime validation of external data.
Use the strictest TypeScript settings: strict mode, noUncheckedIndexedAccess, noImplicitOverride are all enabled.
Avoid using `// @ts-ignore` or `// @ts-expect-error` comments unless there is no other feasible alternative. Instead fix the TypeScript violations.
Use `type` imports for type-only imports (e.g., `import type { Foo } from './foo.js'` or `import { type Foo, bar } from './foo.js'`).
Always use the most descriptive type hints possible and feel free to import from libraries to give more accurate type hints.
Do not use `any` as the type. Instead use a descriptive or union type. If truly needed, prefer `unknown` and narrow the type.
Do not use `Function` as a type. Use specific function signatures instead.
Use union types with `|` for optional/nullable types (e.g., `string | null`).
We use ESLint with typescript-eslint for linting. Run `npm run lint` to check for issues and `npm run lint:fix` to auto-fix.
We use tsc for type checking and cannot use any code with type checking errors. Run `npm run typecheck` to verify. Always fix type checking errors and ensure your code is fully typed.
Exported functions should have explicit return types; internal functions can rely on inference.

## Writing Tests

Use `npm test` to run the full test suite.
Use `npm run test:watch` for watch mode during development.
Use `npx vitest run tests/path/to/test.test.ts` to run a specific test file.
Always write unit tests for new functionality and maintain existing test coverage when we refactor.
Test the observable behavior, you should be verifying what the system does, not how it does it. This means you should only test public interfaces not private ones.
Use `describe` blocks to group related tests and `it` blocks for individual test cases.
Use Vitest's built-in assertions (expect, toEqual, toBeCloseTo, toThrow, etc.).
Create helper functions and mocks within test files for clarity and reusability.
Use shared test fixtures whenever possible so that we follow DRY. Put them in `tests/fixtures/`.
Avoid coupling the tests to implementation so that they continue to work after refactoring the internals.
Focus the tests on the meaning of the code. They should document expected behavior clearly.
Use async/await patterns for testing async code with proper error handling.

## Running Tests

```bash
cd flywheel-tui
bun test                   # all tests
bun test tests/foo.test.ts # single file
```

**Fix failing tests, don't just say they're pre-existing.** If you find a failing test, fix it. Don't waste time trying to show it was already broken.

## Testing the TUI with tmux

Always do extensive UAT after any change. The TUI is a full-screen interactive application — use tmux to run it in a detached session, send keystrokes, and read screen output.

**When someone asks you to "test the TUI", "verify the UI works", or "make sure your changes work in the actual app", this is what they mean.** Do not skip this step!

### Setup and primitives

tmux must be installed (`brew install tmux` on macOS). A test plan is at `tests/fixtures/two-phase-plan.md`.

```bash
# Start (kill stale session first)
tmux kill-session -t flywheel 2>/dev/null
tmux new-session -d -s flywheel -x 120 -y 40 \
  'cd /path/to/flywheel-tui && bin/flywheel'
sleep 2

# Read screen (what the user sees, minus colors)
tmux capture-pane -t flywheel -p              # full screen
tmux capture-pane -t flywheel -p | tail -5    # prompt area only

# Send text
tmux send-keys -t flywheel 'some text' Enter

# Special keys
tmux send-keys -t flywheel Escape      # Escape
tmux send-keys -t flywheel Tab         # Tab
tmux send-keys -t flywheel Up          # Arrow up / Down / Left / Right
tmux send-keys -t flywheel BSpace      # Backspace
tmux send-keys -t flywheel C-u         # Ctrl+U (clear input line)
tmux send-keys -t flywheel C-c         # Ctrl+C (stop/exit)

# Timing: sleep 0.5 for keystrokes, 1-2 for state transitions, 3-5 for process starts

# Clean up
tmux kill-session -t flywheel 2>/dev/null
```

If the TUI exits or crashes, the tmux session is destroyed. Just re-run the setup commands.

### Common test sequences

**1. Verify idle screen:**

```bash
tmux capture-pane -t flywheel -p
# Expect: branding header, ASCII art, starter chooser, session sidebar (if >= 90 cols), prompt
```

**2. Start a pipeline with `/start` (recommended E2E UAT):**

```bash
# With description — skips description question, shows mode picker directly
tmux send-keys -t flywheel '/start add a hello world endpoint' Enter
sleep 2
tmux capture-pane -t flywheel -p
# Expect: QuestionPrompt with 4 pipeline mode options:
#   1. Just Plan  2. Plan + Work  3. Plan + Work + Review (recommended)  4. Full Pipeline

tmux send-keys -t flywheel '3'
sleep 3
tmux capture-pane -t flywheel -p
# Expect: working view with pipeline running (plan -> work -> review in telemetry bar)
```

Without a description, `/start` first asks "What do you want to build?" as a direct text input — just type and press Enter.

**3. Stop a running workflow:**

```bash
tmux send-keys -t flywheel Escape   # first Esc shows hint
sleep 1
tmux send-keys -t flywheel Escape   # second Esc stops
sleep 2
tmux capture-pane -t flywheel -p    # should show completed/idle view
```

**4. Return to idle / test sidebar:**

```bash
tmux send-keys -t flywheel '/new' Enter
sleep 1
tmux capture-pane -t flywheel -p
# Expect: idle screen; sidebar lists previous session with its lifecycle state
```

### What to verify after making TUI changes

After modifying any file under `src/tui/`, always:

1. Run `bun test` to ensure unit tests pass
2. Start the TUI in tmux
3. Test the specific feature you changed
4. Test adjacent interactions (e.g., if you changed a modal, also test opening and closing it, keyboard shortcuts within it, and that the view behind it restores correctly)
5. **Check the log files for errors** — session logs live inside `.flywheel/sessions/<id>/` (transcript.jsonl, telemetry.json, logs/subprocess/*.jsonl). The root `.flywheel/log/` only covers app-level logging between sessions. Check both locations for `ERROR` or `WARN` lines — errors there indicate problems even if the TUI appeared to work visually.
6. **Clean up ALL artifacts** — delete every file and session created during the tmux test (plans, sessions, worktrees, source files, test fixtures). Never leave behind files that were created solely for manual testing.
7. Clean up the tmux session

```bash
# After running a tmux TUI test, check for logged errors:
# App-level log (startup, between sessions):
ls -t .flywheel/log/*.log | head -1 | xargs cat | grep -E '^(ERROR|WARN)'
# Session-level logs (the main logs during a run):
cat .flywheel/sessions/*/transcript.jsonl | grep -i error
cat .flywheel/sessions/*/logs/subprocess/*.jsonl | grep -i error
```
