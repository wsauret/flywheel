<coding_guidelines>
# Flywheel CLI -- Agent Instructions

## Project Overview

Flywheel CLI is a terminal UI application that executes workflow plans. It spawns AI worker processes (Claude Code, OpenCode, Droid, or its own harness), runs plan phases sequentially, and provides a rich TUI built with OpenTUI + SolidJS.

**Runtime:** Bun (not Node)
**TUI framework:** OpenTUI (`@opentui/core` + `@opentui/solid`) with SolidJS signals
**Config format:** TOML (`flywheel.toml`), not YAML
**Important:** SolidJS must resolve with the `"browser"` export condition. The `bin/flywheel` wrapper handles this with `bun --conditions=browser`.

---

## 1. Module Boundaries (most critical)

The codebase has a strict 4-module layered architecture. **Every file must live in the correct module. Every import must respect the dependency direction.** Run `bun run scripts/check-boundaries.ts` after any file addition or move.

```
src/
  protocol/        --> imports NOTHING from src/
  workflows/       --> imports only from protocol/
  orchestration/   --> imports from workflows/ + protocol/
  tui/             --> imports from orchestration/ (which re-exports what it needs)
```

**What lives where:**

| Module | What belongs here | What does NOT belong here |
|--------|-------------------|--------------------------|
| `protocol/` | Event types, handoff schemas. Pure data contracts. | Any logic, any imports from `src/`. |
| `workflows/` | Queue engine, dispatcher, evaluator, step types, shared utilities. Domain logic with no knowledge of how it's hosted. | Anything that knows about config, sessions, engines, CLI, or rendering. |
| `orchestration/` | Config loading, session management, engine registry, worker spawning, CLI entry. Composes workflow primitives into runnable pipelines. | Rendering, UI components, hooks, anything visual. |
| `tui/` | Shell, hooks, adapters, components, routes. Rendering and user interaction only. | Domain logic, session CRUD, transport resolution, queue building. |

**Violations that must never happen:**
- `tui/` importing from `workflows/` or `protocol/` directly (must go through `orchestration/`)
- `workflows/` importing from `orchestration/` or `tui/`
- `protocol/` importing from anything in `src/`
- `orchestration/` importing from `tui/`

**Where new code goes:**
- Step scaffolding/fields/prompts/hooks --> `workflows/queue/steps/<type>/`
- Hook wiring into the executor pipeline --> `orchestration/queue-orchestrator.ts`
- Shared domain utilities (used by 2+ workflow modules) --> `workflows/shared/`
- UI components and reactive hooks --> `tui/`
- Engine providers and spawners --> `orchestration/engines/` and `orchestration/worker/`

**Frozen references:** `src-legacy/` contains code not yet migrated back. `tests-legacy/` contains their tests. Neither is in `tsconfig`.

---

## 2. No God Modules -- File Size and SRP

**No source file may exceed 400 lines.** If a file grows past this during implementation, extract a responsibility before merging.

**Each file owns one concept:**

- **Types and interfaces** go in a dedicated `*-types.ts` file, not inline with logic.
- **Pure data transformations** go in `*-helpers.ts` files. Stateless, no side effects, easy to test.
- **Hooks** (SolidJS reactive logic) live in `tui/hooks/`, one hook per file. `shell.tsx` is a thin wiring layer -- it contains no business logic.
- **Callbacks and factories** that wire dependencies live in their own files (e.g., `worker-callback.ts`). The orchestrator calls them but does not contain their implementation.
- **Shared utilities** live in `workflows/shared/` when 2+ modules depend on them.

**Step types are modular and self-contained.** Every step variant is a folder under `workflows/queue/steps/` with: `fields.ts` (handoff field specs), `scaffolding.ts` (prompt assembly), and `prompts.ts` (prompt text constants). Some also have `hooks.ts` for post-completion behavior.

**Scaffolding is thin assembly, prompts hold the text.** `scaffolding.ts` registers a strategy and composes preamble/postamble from constants in `prompts.ts`. Scaffolding never contains long string literals.

**Schemas live with their owners.** Handoff schemas (cross-step) live in `protocol/handoff-schemas.ts`. Evaluator schemas live in `evaluator/schemas.ts`. Dispatcher schemas live in `dispatcher/schemas.ts`. If a schema is consumed by exactly one module, it belongs in that module.

---

## 3. DRY -- Search Before Writing

**Before writing ANY utility function, search `src/` first.** Use grep to determine whether the logic already exists, then extend and import it.

**Key shared utilities that already exist (do not duplicate):**

| Utility | Location | Replaces |
|---------|----------|----------|
| `errorMessage(err)` | `workflows/shared/error-message.ts` | `instanceof Error ? e.message : String(e)` |
| `formatDuration()` | `tui/format.ts` | Any elapsed time formatting |
| `formatCost()` | `tui/format.ts` | Any USD cost formatting |
| `SubprocessTransportBase` | `workflows/shared/subprocess-transport-base.ts` | Shared retry loop + constructor for transports |
| `log` | `workflows/shared/log.ts` | Any logger creation |
| `atomicWriteFile()` | `workflows/shared/atomic-write.ts` | Any write-then-rename pattern |
| `DebouncedWriter` | `workflows/shared/debounced-writer.ts` | Any debounced file writing |
| `raceAbort()` | `workflows/queue/abort-utils.ts` | Any AbortSignal + Promise.race pattern |
| `truncateText()` | `workflows/dispatcher/truncation.ts` | Any string truncation |

**Colocate what's used once, share what's used across modules.** A constant, schema, or helper consumed by a single step variant belongs in that variant's folder. It moves to `shared/` only when a second consumer appears.

**No barrel re-exports.** Consumers import directly from the owning file. No `index.ts` re-export files that exist solely to shorten import paths.

---

## 4. Registration Over Wiring (OCP)

New behavior is added by **registration**, not by editing dispatch switches.

- **Step types** register via `registerScaffolding()` side-effect imports in `steps/register-all.ts`. Adding a step type never requires editing `executor.ts` or `step-runner.ts`.
- **Shell commands** register via `CommandRegistry` in `tui/hooks/command-registry.ts`. Adding a command never requires editing `shell.tsx`.
- **Output formatting** for new tool types uses the Map-based dispatch table in `adapters/output-formatter.ts`.
- **Engine providers** register via `registerEngine()` in `orchestration/engines/core/registry.ts`.

**Hooks are step-scoped.** Post-completion hooks (plan integration, sprint loops, review triage, debug loops) live in the step variant folder that owns the behavior, not in a central hooks file. `createCompositeHook` composes them at the orchestrator level.

---

## 5. Dependency Injection

High-level modules depend on abstractions, not concretions:

- `executor.ts` accepts dependencies via `StepExecutorOptions` (types in `executor-types.ts`). It never imports transport implementations.
- `workflow-runner.ts` accepts `WorkflowRunnerOverrides` for injecting test doubles.
- `chat.ts` accepts an optional `spawner` parameter.
- `bun-spawner.ts` accepts `projectCwd` as a parameter -- never reads `process.cwd()`.

When wiring new features, pass dependencies through existing options objects. Do not add global imports to concrete implementations from high-level modules.

---

## 6. Dead Code and Wiring Rules

**No dead code, even if tested.** If a symbol is only imported in test files and never used in production code, delete both the symbol and its tests. Git history is the recovery mechanism.

**No speculative code.** Do not add functions, types, or exports "for future use." If a future phase needs it, that phase adds it.

**Exports match consumers.** Every exported symbol must have at least one non-test consumer in `src/`.

**`src-legacy/` is the archive.** Dead code goes to `src-legacy/`, not to a comment block.

**Built means wired.** A module that compiles but is never called from the production entry point does not exist. Every new module must be imported and invoked in the live application before merging. If you cannot demonstrate the feature running in the TUI via tmux, it is not done.

**Unit tests prove logic, not integration.** A passing test suite says nothing about whether the module is reachable from the running app. After wiring a feature, verify it in the live TUI -- not just in the test harness.

---

## 7. TypeScript Conventions

- Runtime: Bun on Node 20+, TypeScript targeting ES2022, strict mode enabled (`noUncheckedIndexedAccess`, `noImplicitOverride`).
- ESM modules (`import`/`export`), not CommonJS. All local imports must include `.js` extension.
- `type` imports for type-only usage: `import type { Foo }` or `import { type Foo, bar }`.
- No `any` (use `unknown` and narrow). No `Function` (use specific signatures). No `// @ts-ignore` unless no alternative exists.
- Union types for optional/nullable: `string | null`.
- Exported functions: explicit return types. Internal functions: inference is fine.
- Prefer template literals, hardcoded values over env vars, top-level imports over scoped.
- Zod for runtime validation of external data. Temporal API (from `@js-temporal/polyfill`) for dates.
- ESLint with typescript-eslint: `npm run lint` / `npm run lint:fix`. tsc for type checking: `npm run typecheck`.

---

## 8. Agent Behavior

- Always test changes by running the code, then fix any errors that arise.
- Fix linter errors and warnings before moving on.
- Do not add comments unless they explain new logic you are adding.
- Do not use emojis in code.
- Never mock anything in production code (mocks are for tests only when absolutely necessary).
- Always fully wire new code into the system. Unit tests alone do not prove wiring.

---

## 9. Writing and Running Tests

```bash
cd flywheel-tui
bun test                   # all tests
bun test tests/foo.test.ts # single file
```

- Write unit tests for new functionality. Maintain coverage when refactoring.
- Test observable behavior (what the system does), not implementation details (how it does it).
- Use `describe`/`it` blocks, Vitest assertions, async/await for async code.
- Shared fixtures go in `tests/fixtures/`. DRY applies to tests too.
- Avoid coupling tests to implementation -- they should survive internal refactors.
- **Fix failing tests, don't say they're pre-existing.** If you find a failing test, fix it.

---

## 10. TUI Verification with tmux

After any change under `src/tui/`, verify in the live TUI. See **[docs/tmux-uat-guide.md](docs/tmux-uat-guide.md)** for the full tmux setup, test sequences, and cleanup checklist.

**Key rules:**
- Never run UAT in the project directory (use a temp dir).
- Check log files for errors even if the TUI looks correct visually.
- Clean up all artifacts (sessions, files, tmux session) when done.

---

## Quick Reference: Import Rules

```
Imports reveal misplacement. If a file's imports all reach 3+ levels up (../../../),
it probably lives too deep. Let import paths guide where things belong.

One domain, one home. Each concept lives in exactly one place.
No re-exports, bridge files, or compatibility shims.
When a module moves, update every import -- do not leave a forwarding address.
```
</coding_guidelines>
