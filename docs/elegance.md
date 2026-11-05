# Elegance

This document is Flywheel's canonical, project-specific definition of elegance and the rubric used to audit the codebase. Elegant Flywheel code works with the grain of its tools, makes ownership and causality obvious, contains no duplicated authority or speculative ceremony, and leaves each line doing load-bearing work for the intended user experience. A reader should be able to explain why every boundary and abstraction exists from the behavior or invariant it protects. Architecture intent (`docs/architecture-intent/`) owns the specific rules for how Flywheel's internals are organized: where a section below names a topic and cites statement identifiers, those statements are the authority, and this rubric judges designs and code against them.

## Stack Roles

Solid confinement to client layers and the scope of Effect: ARCH-STRUCTURE-004, ARCH-STRUCTURE-005.

## Core Thesis

**Work with the grain of your tools.**

- Bun's grain is "the runtime does it."
- Solid's grain is fine-grained reactivity.
- TypeScript's grain is structural inference.
- Effect's grain is scoped async lifecycle.

If a pattern feels ceremonious, the idiomatic solution is usually simpler.

## Tool Divisions

Each first-class tool owns one architectural job:

| Tool | Owns | Does not own |
|---|---|---|
| Bun | Runtime, subprocesses, file APIs, tests, build scripts | Wrapper layers that only rename Bun or Node APIs |
| TypeScript | Domain modeling, discriminated unions, structural inference, factory DI contracts | Runtime validation of external data without a schema |
| SolidJS | Client reactivity, where ARCH-STRUCTURE-004 allows it | Async lifecycle |
| Effect | Async lifecycle, as ARCH-STRUCTURE-005 scopes it | Everything that ARCH-STRUCTURE-005 excludes |
| OpenTUI | Terminal rendering primitives, input surfaces, display constraints | Domain state, persistence, workflow control, session policy, agent runtime policy |

## Core Motto

Maximize elegance, not minimal churn. Prefer the design that leaves the codebase simpler, more symmetric, and easier to extend, even when that requires a larger refactor now.

## Layer Boundaries

Source layers, their one-way dependency direction, and one home per domain: ARCH-STRUCTURE-001, ARCH-STRUCTURE-003.

## Decision Checklist

Run these before planning or implementing a change:

| # | Check | If violated |
|---|---|---|
| 1 | Is there exactly one source of truth for this data? | Use the existing fact, projection, domain record, TUI store, or workflow-view field. Do not copy it. |
| 2 | Store or event bus? | UI-readable state enters the TUI store through protocol data. Independent infrastructure notifications go to the bus. |
| 3 | Memo or effect? | Derived value -> memo. I/O -> effect. Signal-setting inside an effect that reads another signal usually wants a memo. |
| 4 | Async lifecycle or reactive state? | Resource lifecycle -> Effect. UI-readable state -> Solid store/signal. |
| 5 | Does this belong in orchestration or TUI? | Business logic -> orchestration. Rendering/JSX -> TUI. |
| 6 | Does this belong in workflows or orchestration? | XState workflow policy, facts, attempts, and projections -> workflows. Config, sessions, agent runtime, and production wiring -> orchestration. |
| 7 | Can TypeScript infer this? | Annotate module boundaries. Delete interior annotations the compiler does not need. |
| 8 | Is this abstraction used in 2+ places? | If not, inline it unless SRP would be harmed. |
| 9 | Is disposal ordered and awaited? | Fire-and-forget loses data. Follow ARCH-RUNTIME-029. |
| 10 | Would deleting this code change behavior? | If not, delete it. |
| 11 | Internal or external boundary? | Tolerance belongs only where ARCH-BOUNDARIES-001 allows it; data we wrote follows ARCH-BOUNDARIES-004. |

## State Ownership

One source of truth per value, durable state as facts and projections, and the owner of each kind of state: ARCH-SUBSTRATE-001, ARCH-SUBSTRATE-002, ARCH-SUBSTRATE-015, ARCH-SUBSTRATE-017, ARCH-SUBSTRATE-022, ARCH-SUBSTRATE-023, ARCH-WORKFLOWS-006, ARCH-SESSIONS-001, ARCH-SESSIONS-006, ARCH-SESSIONS-043, ARCH-CONTEXT-013, ARCH-CONTEXT-014, ARCH-LEARNING-006, ARCH-LEARNING-010, ARCH-DIRECTORIES-014, ARCH-PROVIDERS-031, ARCH-PROVIDERS-033, ARCH-PROVIDERS-038, ARCH-PROVIDERS-063, ARCH-PROTOCOL-063, PI-AGENT-010.

## Postel Boundary Discipline

Liberal external boundaries, strict internal state, historical recovery, and durable user state: ARCH-BOUNDARIES-001, ARCH-BOUNDARIES-002, ARCH-BOUNDARIES-004, ARCH-BOUNDARIES-005, ARCH-BOUNDARIES-006, ARCH-SUBSTRATE-013, ARCH-SUBSTRATE-014, ARCH-SUBSTRATE-027, ARCH-SUBSTRATE-030, ARCH-SUBSTRATE-031, ARCH-DIRECTORIES-007, ARCH-PROVIDERS-039, UPD-003, UPD-023, PI-CAP-011.

## Secret Handling

Redaction, the one serialization crossing, and external logins: ARCH-BOUNDARIES-009, ARCH-BOUNDARIES-012, ARCH-BOUNDARIES-013, ARCH-PROVIDERS-066, PI-MODEL-027.

## Retry and Idempotency

The conversation as the retry ledger, the one provider fallback owner, and unattended recovery: ARCH-SUBSTRATE-038, ARCH-SUBSTRATE-037, ARCH-PROVIDERS-032, ARCH-RUNTIME-003, ARCH-CONTEXT-010, PI-MODEL-031.

## Reactive Architecture

Where reactivity may live: ARCH-STRUCTURE-004.
How client stores, memos, and effects divide ownership: ARCH-PROTOCOL-063.
Reactive cleanup belongs to ownership roots: ARCH-RUNTIME-029.

| Primitive | Role |
|---|---|
| `createStore` / `createSignal` | Client source of truth |
| `createMemo` | Derived state |
| `createEffect` | I/O boundary |
| `batch()` | Coalesced writes |
| `createRoot` | Ownership scope outside component trees |

Avoid reactive diamonds: if a memo reads both an original signal and a store that an effect derives from that signal, it can observe stale intermediate states. Derive directly from the original source or collapse the dependency path.

## Event Bus vs Store

Bus notifications versus readable store state, and event naming: ARCH-STRUCTURE-007, ARCH-NAMING-007.

## Session Lifecycle

The two persisted lifecycle states and their one owner: ARCH-SESSIONS-003.

## Definition and Registration

Behavior arrives by registration, and workflows carry no registry: ARCH-STRUCTURE-017, ARCH-WORKFLOWS-009.

## Skill Packages

The instruction stack, progressive disclosure of packages, registry revisions, commands that start an agent method, and external package trust: ARCH-CONTEXT-016, ARCH-CONTEXT-030, ARCH-LEARNING-005, ARCH-LEARNING-010, ARCH-BOUNDARIES-008, ARCH-TOOLS-038, PI-AGENT-028, PI-AGENT-037, PI-AGENT-038.

## Harness Minimalism

Agent-facing features use existing observable primitives: ARCH-AGENCY-006.

## TypeScript Discipline

Use inference over annotation. Exported functions and module boundaries get explicit return types; interior variables should usually infer.

Prefer discriminated unions over optional fields. Narrow on `kind`, `type`, or another required discriminator.

Use `effect/Schema` for validation (part of core `effect` in v4; there is no Zod in the codebase). Where tolerant and strict parsing belong: ARCH-BOUNDARIES-001, ARCH-BOUNDARIES-004.

Use `satisfies` when validating object shape without widening.

No `any`, no `Function`, no `// @ts-ignore`. Use `unknown` and narrow.

The strict compiler flags are on and load-bearing: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`. Under `noUncheckedIndexedAccess` an indexed access is `T | undefined` - branch or guard it. `exactOptionalPropertyTypes` is deliberately off: it surfaces ~300 low-signal `{ x?: T }`-vs-`{ x: T | undefined }` errors for negligible bug-catching; revisit only with a specific motivating bug.

Casts and non-null assertions are the exception, not a tool. No `as Type` (other than `as const`) and no `!` without a `// SAFETY:` comment naming the invariant that makes it sound. Branch, parse, or restructure first; a cast is the last resort for an invariant TypeScript genuinely cannot express (a registry-erasure or branding seam).

## Interface Design

Use factory functions with explicit dependency injection:

- `createSessionManager(deps)`
- `createWorkflowRunner(opts)`
- `createAgentRuntime(deps)`
- `createWorkflowVmHost(deps)`
High-level modules depend on narrow abstractions. A wrapper is justified when it enables polymorphism, lifecycle ownership, or test injection. A wrapper that only repeats a Bun or SDK interface is ceremony.

Deep modules should expose simple interfaces. If a consumer needs internal knowledge to use a module correctly, the interface is too shallow.

## Bun as Runtime

Bun is the framework:

- `Bun.spawn()` over `child_process`, and only inside a process-launch authority: ordinary production code starts an external process through `spawnOwned`, `runOwnedCommand`, or `openExternalUrl` (ARCH-TOOLS-022), while explicitly authorized survival uses only `src/infra/persistent-subprocess.ts`; no caller uses a raw launch primitive of its own
- `Bun.file()` where it fits
- Bun test runner through `bun run test`
- Bun bundler/build scripts

Before adding a dependency, check whether Bun, Solid core, Effect, or the standard library already owns the capability.

## Effect Integration

Effect owns async lifecycle only and is colocated with its domain owner: ARCH-STRUCTURE-005.

## Disposal and Lifecycle

Ordered, awaited disposal and attribution that follows publication: ARCH-RUNTIME-029, ARCH-TOOLS-019.

## TUI Rendering Boundary

Clients render derived state and send actions: ARCH-PROTOCOL-002.

## Code Quality

### SOLID

We follow SOLID, resolved through this project's constraints.

**Single Responsibility.** Extract when the unit owns non-trivial cohesive logic. Inline trivial forwarding.

**Dependency Inversion.** Use DI when it creates a useful seam for tests, runtime selection, or lifecycle ownership. Do not wrap Bun APIs just to rename them.

**Interface Segregation.** Pass the smallest interface that satisfies the caller.

**Open/Closed.** Prefer extension through registration and discriminated unions. When adding a union member, update exhaustive consumers.

### Conciseness

- No abstraction for a single use unless SRP genuinely applies.
- No callback chains that just forward.
- No backward-compatibility shims.
- Delete dead code immediately.
- No speculative code - add a capability when a phase needs it, not before.
- Built means wired: every export has a non-test consumer in `src/`, and code that compiles but is never reached from the production entry point does not exist. Verify in the live TUI, not only in tests.
- No mocks or fakes in production code - wire new code into the real system; mocks live only in tests.
- Cohesion over line count: split a file when it carries more than one reason to change or forces a reader to hold unrelated concepts (AGENTS.md sets the operational 600-code-line backstop; blank and comment lines do not count).
- Sparse syntax, dense behavior.

### Comments

Comments explain why a primitive or boundary exists, not what the next line does.

JSDoc the public surface of deep/domain modules and boundary APIs - the symbols a caller drives through types and hover and should not have to read the body to use. Do not JSDoc-restate a well-named, well-typed signature: this is an application, not a published library, so the test for any comment is "does it add what the signature can't" - a why, an invariant, a contract, or a safety note.

## Testing

Use project scripts:

- `bun run test` after changes
- `bun run lint` after changes
- `bun run check:boundaries` after file additions or moves

Unit tests should not call external APIs or spawn heavyweight UI flows. Integration and E2E tests own real subprocesses, I/O, and TUI behavior. New TUI behavior needs live TUI verification.

Tests should cover observable behavior, not implementation details. Each contract has one owner test at the strongest boundary that can observe it; another layer tests the same contract only for a distinct risk that owner cannot reach.

## Anti-Patterns

| Pattern | Why it is wrong | Instead |
|---|---|---|
| Signal inside an effect that reads another signal | Manual derived-state sync | `createMemo` |
| `{ current: T }` shared ref-bag | Hidden mutable architecture | Named object with methods or store field |
| Callback chain A -> B -> C where B forwards | Indirection without ownership | A writes store, C reads store |
| Optional fields representing a union | Compiler cannot enforce variants | Discriminated union |
| Business logic inside `createEffect` | Effects are I/O boundaries | Pure function or memo plus effect for I/O |
| Wrapper that re-exports a Bun API | No depth | Call Bun directly |
| Interior type annotations the compiler infers | Noise | Delete annotation |
| Pre-filtering events before emitting | Couples producer to consumers | Emit raw, subscriber filters |
| A view that rereads or refolds durable history, or reads each member, on every change | Quadratic cost that grows with members and history and starves commits | Read the owner's live state; advance a held fold from its last position |
| `dispose()` without `await` | Data loss | ARCH-RUNTIME-029 |
| Store value duplicated in signal/ref/adapter field | Two sources of truth | Read from the authority |
| `src/effect/` technology namespace | Hides domain ownership | ARCH-STRUCTURE-005 |
| `catch(unknown)` at Effect boundary | Loses typed error information | ARCH-STRUCTURE-005 |
| Class-level `AbortController` for runtime lifecycle | Unstructured cancellation | `Fiber`; bridge to AbortController only at signal APIs |
| Memo reads both source and effect-derived store | Reactive diamond/stale intermediate state | Derive from one dependency path |
| `safeParse` on data we wrote | Tolerance where loudness is required | ARCH-BOUNDARIES-001 |
| `?? defaultValue` on a field the writer always sets | Silent corruption past a producer bug | ARCH-BOUNDARIES-004 |
| `flatMap(x => x ? [x] : [])` over a projection | Drops malformed rows without notice | ARCH-BOUNDARIES-004 |
| `.default(...)` on a Schema field the writer always sets | Schema lies about the producer contract | ARCH-BOUNDARIES-004 |
| `safeParse` / `?? undefined` on an owned fact in a reader | Softens an owned-data invariant into silent degradation | Decode once via `parseProjectionFact` (ARCH-BOUNDARIES-004) |
| Hand-extracting fields from a known fact with `asString`/`asNumber` | Validate-and-discard: the schema exists, the reader re-derives it | Parse the fact into its typed shape once; read typed fields |
| Parallel idempotency key / dedup record / attempt "resumed" marker | Second source of truth for what already ran | ARCH-SUBSTRATE-038 |
| Repair/normalize/legacy branches on internal data | Hides writer drift | ARCH-BOUNDARIES-001 |
| Optional options field guarded by a runtime `X requires Y` throw | The requirement is invisible at every construction site, so the untested path crashes on its first live request | Require the field on the type the constructor accepts; a completion seam produces that type (`RunnableAgentOptions`) |
| `try { ... } catch { return [] }` reading our own SQLite or session disk | Silent empty state on real corruption | Throw; the substrate is broken |
| "Backward compatibility" framing for internal schemas | Treats an internal storage shape as a public API | Migrate or invalidate stored state; preserve only user data that would otherwise be materially lost |
| Provider/model quirks handled after canonicalization | Leaks external mess into internal code | ARCH-BOUNDARIES-002 |
| Rejecting recoverable LLM/provider syntax damage before normalization | Treats nondeterministic external systems as if they owed us internal invariants | ARCH-BOUNDARIES-002 |
| Package body copied into `AGENTS.md`, a brief, or a persona | Second source of truth for one procedure | Declare `requiredSkills`, or let the model load the package |
| Dependency package that dispatches, routes findings, or synthesizes for its host | Couples one method to one orchestration, so a second host cannot compose it | The dependency states the method and its own report; the composing definition owns orchestration |
| New always-loaded instruction block for a case-by-case need | Unbounded prompt growth for context most turns do not use | A skill package advertised by its trigger |
