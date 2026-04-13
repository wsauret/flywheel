<coding_guidelines>
# Flywheel CLI -- Agent Instructions

**Runtime:** Bun (not Node) | **TUI:** OpenTUI + SolidJS | **Config:** TOML
**SolidJS requires `"browser"` export condition** — `bin/flywheel` handles this via `bun --conditions=browser`.

---

## 1. Module Boundaries

```
src/
  cli/             --> composition root, imports from everything
  infra/           --> shared foundation, imports NOTHING from src/
  workflows/       --> imports only from infra/
  orchestration/   --> imports from workflows/ + infra/
  tui/             --> imports from orchestration/ + infra/
```

Run `bun run scripts/check-boundaries.ts` after any file addition or move.

| Module | Owns | Never contains |
|--------|------|----------------|
| `cli/` | Entry point, wires all layers | Domain logic, UI components |
| `infra/` | Logging, error utils, output blocks, events | Logic that imports from `src/` |
| `workflows/` | Queue engine, dispatcher, evaluator, step types | Config, sessions, engines, rendering |
| `orchestration/` | Config, sessions, engines, worker spawning | Rendering, UI, hooks |
| `tui/` | Shell, hooks, adapters, components | Domain logic, session CRUD, queue building |

**New code:** Steps → `workflows/queue/steps/<type>/`. Hooks → `tui/hooks/`. Shared utils → `workflows/shared/`. Engines → `orchestration/engines/`.

`src-legacy/` and `tests-legacy/` are frozen archives, not in `tsconfig`.

---

## 2. File Size and SRP

**No file over 400 lines.** Extract before merging.

- Types → `*-types.ts`. Helpers → `*-helpers.ts` (stateless). Hooks → `tui/hooks/`, one per file.
- `shell.tsx` is thin wiring — no business logic.
- Step variants are self-contained folders: `fields.ts`, `scaffolding.ts`, `prompts.ts`, optionally `hooks.ts`.
- Scaffolding assembles; prompts hold text. No long strings in scaffolding.
- Schemas live with their owners. Single-consumer schemas stay in their module.
- No barrel re-exports. Import directly from the owning file.

---

## 3. DRY

**Search `src/` before writing any utility.** Key shared utilities:

| Utility | Location |
|---------|----------|
| `errorMessage(err)` | `infra/error-message.ts` |
| `formatDuration()`, `formatCost()` | `infra/format.ts` |
| `invokePooled()` | `workflows/shared/invoke-pooled.ts` |
| `log` | `infra/log.ts` |
| `atomicWriteFile()` | `workflows/shared/atomic-write.ts` |
| `DebouncedWriter` | `workflows/shared/debounced-writer.ts` |
| `raceAbort()` | `workflows/queue/abort-utils.ts` |
| `applyBudgetTruncation()` | `workflows/dispatcher/truncation.ts` |

Colocate single-use code. Move to `shared/` only when a second consumer appears.

---

## 4. Registration Over Wiring

New behavior via registration, not switch edits:
- Step types → `registerScaffolding()` in `steps/register-all.ts`
- Commands → `CommandRegistry` in `orchestration/command-registry.ts`
- Output formatting → Map dispatch in `adapters/output-formatter.ts`
- Engines → module-private `register()` at import time in `orchestration/engines/core/registry.ts`

Hooks are step-scoped (live in the step folder, composed via `createCompositeHook`).

---

## 5. Dependency Injection

High-level modules depend on abstractions. `executor.ts` takes `StepExecutorOptions`. `workflow-runner.ts` takes `WorkflowRunnerOverrides`. `bun-spawner.ts` takes `projectCwd` as param. Pass deps through options objects — never import concretions from high-level modules.

---

## 6. State

**One source of truth per value. State drives effects, never the reverse.**

```
Do: actions.stopWorkflow("completed") → timer stops via createEffect reacting to status
Not: timer.stop(); actions.stopWorkflow("completed")  // imperative side-channel

Do: actions.setModelActivity("thinking") → spinner derives from store
Not: this.modelActivity = "thinking"; this.onModelActivityChange?.("thinking")
```

**Session lifecycle: `active | paused | completed`.** Session manager is the sole authority.
- **Registry** = runner pool. Holds runtime data (outputBlocks, tokens, cost, modelActivity). No `status` field, no `result` field, no lifecycle state.
- **UI** derives state via `sessionState()`: registry presence = active, else reads `manager.getState()`.
- **Delete is an action**, not a state. No `archived` or `trashed` states.
- **Never add status fields, shadow signals, or new state stores.** Read `sessionState()`, write `manager.updateState()`.

**No parallel state.** If a value exists in the store, it doesn't also live as a property on an adapter, a field on a registry entry, and a signal in a hook. Downstream representations are derived views.

**No leaked mutable refs.** Keep internal tracking private, expose only derived accessors.

---

## 7. Dead Code and Refactoring

- **No dead code**, even if tested. Delete symbol + tests. Git is the archive.
- **No speculative code.** Add it when a phase needs it, not before.
- **No migration code, no backward compatibility.** No external users. Delete old code, write new code clean. Old data is invalid. Git history is the recovery mechanism.
- **Exports match consumers.** Every export has a non-test consumer in `src/`.
- **Built means wired.** If it compiles but isn't called from the production entry point, it doesn't exist. Verify in the live TUI, not just tests.

---

## 8. TypeScript

- Bun, ES2022, strict mode (`noUncheckedIndexedAccess`, `noImplicitOverride`).
- ESM with `.js` extensions on local imports. `type` imports for type-only usage.
- No `any` (use `unknown`), no `Function`, no `// @ts-ignore`.
- Exported functions: explicit return types. Internal: inference fine.
- Zod for external data validation. Temporal API for dates.

---

## 9. Agent Behavior

- Test changes by running code. Fix errors before moving on.
- Fix linter errors and warnings before moving on.
- No comments unless explaining new logic. No emojis.
- Never mock in production code. Always wire new code into the system.
- **Never use the Write tool on existing files.** Use Edit for modifications; Write is only for creating new files.

---

## 10. Tests

```bash
bun run test                   # unit (<10s) — ALWAYS this, never bare `bun test`
bun run test:integration       # real subprocesses, real I/O
bun run test:e2e               # full TUI via tmux
```

**Always run `bun run test` with no pipes, greps, or filters.** The script pre-filters to `--only-failures` — read the full output directly. Do not `| tail`, `| grep "(fail)"`, or otherwise post-process. The raw output is designed to be scannable.

| Tier | Location | Speed |
|------|----------|-------|
| Unit | `tests/*.test.ts`, `tests/{schemas,handoff,evaluator,tui}/` | <10s |
| Integration | `tests/integration/` | Minutes |
| E2E | `tests/e2e/` | 30+ min |

**Unit tests must NOT:** make API calls, spawn real processes, use `setTimeout` >30ms, run tmux, or create files in the project directory (use `/tmp/`).

New test subdirs must be added to the glob in `package.json`.

- Test observable behavior, not implementation details.
- Shared fixtures in `tests/fixtures/`.
- Fix failing or slow tests immediately — never dismiss as pre-existing.

---

## 11. TUI Verification

After changes under `src/tui/`, verify in live TUI. See [docs/tmux-uat-guide.md](docs/tmux-uat-guide.md).

E2E regression: `tests/e2e/run-all.sh`. Every new TUI feature must add or extend an E2E module.

---

## Import Rules

```
Imports reveal misplacement — deep relative paths mean the file is in the wrong place.
One domain, one home. No re-exports, bridge files, or compatibility shims.
When a module moves, update every import — no forwarding addresses.
```
</coding_guidelines>
