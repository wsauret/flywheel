<coding_guidelines>

# Flywheel CLI - Agent Instructions

**Runtime:** Bun (not Node) | **TUI:** OpenTUI + SolidJS | **Config:** TOML
**SolidJS requires the `"browser"` export condition.** `bin/flywheel` handles this via `bun --conditions=browser`.

This file is the complete guide for contributors. The maintainer also checks out a small private companion repository at the gitignored `private/` folder of the clone. Its @private/AGENTS.maintainer.md adds the rules for the maintainer's shared working tree, publication, and release readiness. That import is optional: a contributor's checkout has no `private/` folder, the import then loads nothing, and every rule a contributor needs is in this file.

## 1. Hard Rules

- MAXIMIZE *ELEGANCE*, NOT MINIMIZE CHURN! THIS IS THE MOST IMPORTANT PRINCIPLE FOR EVERY DESIGN! Always pick the design that maximizes elegance no matter how big the refactor. Better now than months down the line when there are even more dependencies in place.

- `docs/elegance.md` is Flywheel's canonical project-specific definition of elegance and the rubric for architecture audits. Read it in full when judging whether the project is maximally elegant. This file operationalizes much of that standard for coding agents, but not in full.

- Handle only reachable states. A state is reachable when a person or an external producer can cause it through a supported entry point: a client surface, the CLI, the published protocol as shipped clients use it, or an external boundary such as a provider stream, a subprocess, or the file system. A state that only a direct internal call or a test fixture can create is hypothetical: add no code for it, and do not treat a test that asserts it as a product requirement. Before you call a failure a regression, trace how a person reaches it. When a test fails on a state that no person can reach, rewrite the test around the reachable flow instead of changing the product.
- This repository opts into the living product-intent authority indexed by `docs/product-intent/README.md`. Before changing or judging user-observable Flywheel behavior, read the index and the relevant domain file. A conflict with the persisted corpus is a bug or blocker, unless the person states a different intent; then the corpus changes to match it.
- Before judging whether a subscription route follows its provider's terms, read `docs/provider-terms.md`. This covers the Claude engine route, the sign-in client IDs, the request headers that identify a client, and the use of several accounts of one provider. Flywheel follows precedent: a practice that widely used open-source agents ship publicly is acceptable. The page's section "How a review uses this page" lists the practices that the maintainer settled on that basis. A review or an audit never reports one of them as a finding, a blocker, or a risk, also when it finds provider terms that the page does not quote. Only the reopen events that the page names reopen a question.
- Repository code, comments, and documents name no other coding-agent harness. `docs/provider-terms.md` is the one place that names such projects as precedent. Credit for borrowed work goes in `THIRD-PARTY-NOTICES.md` and the license bundles, and a file or directory that a notice cites by path keeps its upstream references. The only other names allowed are external identifiers that Flywheel must spell exactly to interoperate, such as an environment variable, a header, or a model id, and benchmark arms that run another harness as the comparison treatment. `README.md` and the website home page `website/src/pages/index.astro` may name other harnesses, because they market Flywheel to their users.
- This repository opts into the living architecture-intent authority indexed by `docs/architecture-intent/README.md`. Before changing or judging Flywheel's internal organization, read the index and the relevant domain file. A conflict with the persisted corpus is a bug or blocker, unless the person states a different intent; then the corpus changes to match it. `docs/terminology.md` is the lexicon for Flywheel's terms.

- Chat captures design intent (PI-AGENT-003, ARCH-AGENCY-015), every implementation route returns a first draft (ARCH-AGENCY-020), and the agent that holds the intent revises the draft from its recorded deviations and the review's findings until it realizes the design, adding nothing beyond it (ARCH-AGENCY-021, ARCH-AGENCY-023, ARCH-AGENCY-024). Read `docs/architecture-intent/agency.md` before changing any implementer prompt, dispatch prompt, or result contract (ARCH-AGENCY-026).

- Every commit message follows this repository's changelog contract. Use `<type>(<scope>)?: <subject>`, with type `feat`, `fix`, `perf`, `docs`, `refactor`, `test`, `chore`, or `release`. The optional scope is lowercase. Write an imperative lowercase subject with no trailing period. About 72 characters is a readability target, not a validated limit or a reason to rewrite a commit. Reserve `feat`, `fix`, and `perf` for observable shipped-product outcomes, with subjects that stand alone as release notes. Use `chore` for CI, release-process, and repository-tooling work, including speed improvements. Add a `Changelog:` trailer when the engineering subject differs from the user-facing sentence. Pair `!` after the type with a `BREAKING CHANGE:` body paragraph stating what breaks and what the user must do. Group one complete user-visible unit per commit, including its supporting tests and refactors. Validate a draft message before committing by piping it to `bun run scripts/commit-contract.ts check-message`; `check --base <sha> --head <sha>` validates existing commits. Public release notes are generated from commit history: `bun run release` reads every commit whose header parses and drops the rest, so a header that does not parse is a release note lost.

- Startup responsiveness is load-bearing. Keep first-frame rendering, prompt input, and chat runner readiness free of noncritical synchronous work and contention. Defer optional initialization, maintenance, preloading, and views through owned background or lazy execution with contained failures. A change that can affect startup must pass `bun run test:perf`; a measured startup regression greater than 20% is never acceptable.
- Interactive clients attach through the one resident `flywheel serve` account service. It is the only production serving owner, opens isolated project compositions on demand, and owns dormant remote wake. Do not add per-project server rendezvous, serving processes, launch aliases, or a second remote coordinator.
- Local token counting uses the one committed universal tokenizer asset. Release and readiness rebuild it once from source, verify it, and reuse it in every archive. Each archive places it in the native directory of the immutable build, and the runtime loads it lazily from there. Ordinary development, startup, and token counting require neither Rust nor a tokenizer network request.
- Durable user state outlives the binary. Every change to an on-disk format, a config key, a model or provider identifier, or an auth credential shape ships in the same unit with a conversion from the previous shape, a comment stating the date after which the conversion is removed, and a test that feeds the previous shape. A reader that meets a shape it does not know says so in a warning and never silently discards or empties the user's state. Installing a newer release must never require a user to log in again, reselect a model, or repair a file. A derived database that rebuilds from the store, such as the session-summary index, the conversation search index, or the projection fold cache, is not durable user state: it keys what it keeps by the code identity or version that wrote it, and an entry it cannot prove current is a miss that rebuilds, with no conversion, dated comment, or warning.
- Flywheel supports macOS, Linux, and Windows as first-class platforms. Preserve platform-specific workarounds unless the user explicitly authorizes changing that compatibility contract. Every repository-owned Bun process launch in production code, tests, scripts, and benchmarks must state `windowsHide: true`; Windows job-object, console-hiding, ACL, path, and process-tree behavior is load-bearing. Platform compatibility tests and guards are locked acceptance contracts: when one fails after a change, fix the implementation. Never delete, skip, weaken, or rewrite the expected behavior to make it pass. If the implementation cannot satisfy the contract, stop and report a blocker.

---

## 2. Skill Packages

The method for a task is not in this file. It lives in installed skill packages that you load with the `skill` tool. Your prompt lists every installed skill by trigger. Scan those triggers, load what the work names, then act; load before you plan, not after you are stuck. Never copy a skill body back into this file, a brief, or a persona.

Reusable skills and workflow guidance apply to any target repository. Keep Flywheel development stack, architecture, paths, and validation policy here or in the development module's skills. Generic guidance may defer to repository instructions when present; it must not assume those instructions exist. Product tool and workflow contracts remain in their owning reusable packages.

When adopting prompts from other sources, copy the source verbatim and then make Flywheel-specific edits. Inspect the implementation before any runtime probe.

| Work in front of you | Skill |
|---|---|
| Figuring out how to build, change, or fix something in Flywheel (a design taking shape) | `flywheel-design` |
| Writing or changing code to a spec | `implementation` |
| Behavior change that needs tests | `test-driven-development` |
| Something is broken and the cause is unproven | `systematic-debugging` |
| Judging a diff or plan and reporting findings | `code-review` |
| Performance review principles | `performance-review-principles` |
| Data-integrity review principles | `data-integrity-review-principles` |
| Security review principles | `security-review-principles` |
| Writing TypeScript here: Bun APIs, strict types, extraction | `typescript-bun` |
| TUI state: stores, signals, memos, effects | `solid-reactivity` |
| Async lifecycle: Effect services, typed errors, fibers, disposal | `effect-lifecycle` |
| Rendering TUI output: text, layout, selection | `tui-rendering` |
| Writing or reviewing a web client surface so it never flickers or moves the reader | `webview-rendering` |
| Planning or reviewing a rendered user-facing surface: layout, styles, theming, interaction states | `interface-design` |
| Verifying the installed binary against real input | `flywheel-uat` |
| Verifying the packaged VS Code extension in a live editor | `vscode-uat` |
| Verifying the web client in a browser, on the preview page or over the relay | `webview-uat` |
| Verifying the phone app in the iOS Simulator, in Safari or installed | `ios-uat` |
| Debugging a session from its facts and diagnostic records | `session-debugging` |
| A refactor that must keep behavior unchanged across a seam | `refactor-safety-net` |
| Auditing a skill package or workflow brief prompt | `skill-prompt-audit` |

Authored workflows follow the conditional references in `workflow-authoring` for specification, implementation, and review briefs. Each brief composes its reusable method owners.

Reaching a skill: `action:"load"` returns one skill's instructions and names the files it declares, and `action:"resource"` returns one of those files. Some briefs and personas declare the skills they need as `dependencies`, so that text already sits in your prompt; loading is still your job for anything the prompt did not compose. Its owning skill, workflow, or persona composes a dependency. A dependency states one method and the shape of its own report only, so every dispatch, routing, or synthesis decision stays with the definition that composes it. Skills are for agents: a person never types a skill. Everything a person runs is a built-in slash command, and a command that needs an agent method, such as `/experiment design`, starts that skill's method as the chat's next turn. Reusable Flywheel agent methods and the references their bodies include ship under `src/agent-skills/`; a workflow states its own method in the inline briefs of its workflow file; Flywheel's own development methods (`flywheel-design`, `typescript-bun`, `effect-lifecycle`, `solid-reactivity`, `tui-rendering`, `webview-rendering`, `session-debugging`, `refactor-safety-net`, `skill-prompt-audit`, `flywheel-uat`, `vscode-uat`, `webview-uat`, and `ios-uat`) ship in the development module's bundle under `src/orchestration/modules/development/definitions/skills/` and exist only in a source run. External packages install from `~/.flywheel/skills` or the shared `~/.agents/skills`, and a skill added mid-session becomes available without a restart.

---

## 3. State Ownership

- Keep one source of truth per value. State drives effects, never the reverse, and everything downstream is a derived view (ARCH-SUBSTRATE-001).
- Add a runtime event to the `FlywheelEvent` discriminated union in `src/infra/events.ts` and update every exhaustive consumer in the same change (ARCH-SUBSTRATE-010).
- Name events with lowercase dot-delimited domain and action segments, such as `agent.run.started` (ARCH-NAMING-007).
- Producers emit raw events; subscribers filter (ARCH-STRUCTURE-007).

### Session Lifecycle

- Persist only `active | inactive`. `SessionManager` is the sole authority for persisted lifecycle state and session relationships, and every transition goes through `SessionManager.updateLifecycleState()` (ARCH-SESSIONS-003).
- Keep workflow terminal state (`paused | completed | failed`) in committed `workflow:<sessionId>` control, never in session metadata or workflow-view state (ARCH-WORKFLOWS-006).
- The session store owns the active runner pool and the runtime projection: output blocks, tokens, cost, and the derived `activity` axis. It has no persisted lifecycle state and no workflow-result authority (ARCH-SESSIONS-002).
- The UI derives `sessionState()` from the protocol-fed session catalog and never reads `SessionManager` or the session store directly (ARCH-PROTOCOL-002).
- Attach the runner of a session open in a client tab eagerly on open and again on every reattach; attaching never resumes a turn (ARCH-SESSIONS-038). A session no client shows stays paused, only an explicit user message restarts work, and completed workflows remain viewable history (PI-INTERACTION-042, PI-INTERACTION-102, PI-INTERACTION-022).
- Delete is an action, not a state. Add no `archived` or `trashed` states (ARCH-SESSIONS-003).
- Never add status fields, shadow signals, or new state stores. Read lifecycle from the owning projection (ARCH-SUBSTRATE-001, ARCH-SESSIONS-003).

---

## 4. Boundary Discipline

- Be liberal at external boundaries and strict inside Flywheel. A boundary adapter normalizes external input (user config, provider streams, LLM tool-call arguments, network responses, SDK callbacks, CLI subprocess output) once into Flywheel's canonical typed shape, or surfaces a clear typed error (ARCH-BOUNDARIES-001).
- Use `safeParse` only for external-boundary normalization or the reviewed historical recovery boundary. Use `parse` for all current writes, workflow control, and post-recovery execution (ARCH-BOUNDARIES-001).
- Never put `.default()` on a schema field that the current producer always sets (ARCH-BOUNDARIES-004).
- Read history through the one strict-first recovery boundary, whose recovered history feeds both transcript display and provider API context (ARCH-SUBSTRATE-012). Recorded tool results remain context and are never redispatched (ARCH-SUBSTRATE-038).
- Keep unreadable bytes immutable. They never block workspace startup, other sessions, or future appends; only a project-wide SQLite or project-directory open failure is a startup failure (ARCH-SUBSTRATE-013).
- Hold secrets (API keys, OAuth tokens, credentials) as `Redacted.Redacted` everywhere in memory. Unwrap with `Redacted.value` only at the provider-call adapter or one explicit serialization boundary through a plain `to*`/`from*` DTO, and never put a secret in logs, traces, errors, or snapshots (ARCH-BOUNDARIES-009).
- Keep provider attribution and session identity in fields separate from prompt-cache keys. A cache-disabled request, including compaction, keeps the session headers it needs and emits no prompt-cache key (ARCH-PROVIDERS-026).
- Prune model config only against the complete authoritative schema or registry, never the slots of a partial read. Correct destructive pruning at its completeness boundary; never disable pruning (ARCH-RUNTIME-069).

---

## 5. Validation

**Always use `bun run` scripts - avoid invoking tools directly.**

**A dependency change ships whole.** A unit that adds, removes, or upgrades a package commits `package.json` and `bun.lock` together, and `bun install --frozen-lockfile` must pass on the result. Its handoff to the user states that checkouts need `bun install`. `bun run install:local` runs `bun install --frozen-lockfile` before it builds, so a pull that changes dependencies never breaks the local install.

**Never set an outer shell or tool timeout on the repository's core `bun run` validation commands, including `test`, `lint`, `check:*`, and their focused variants.** These scripts own their failure aggregation, duration budgets, diagnostics, and hang guards. Let them finish so they can report every failure. If a command does not settle, inspect its live output and process state, then stop it only after identifying the hang; do not use a speculative deadline that can discard the final report.

**`bun run lint`, `bun run test`, every `bun run test:integration:*` mode, and `bun run test:perf` share one validation lane per user per machine.** One of them runs at a time; a later arrival waits in order and prints who holds the lane, and its own duration budgets start only once it is admitted. Two sessions or worktrees never run gates side by side, so never bypass the lane by invoking the underlying runners or `bun test` over the whole suite directly.

Validate ordinary changes with unit tests and a focused end-to-end script that exercises the changed behavior through its real boundary. Write temporary scripts in the session scratchpad and run them outside the shared validation lane. Do not wrap an integration suite in a script to bypass the lane. Run integration suites rarely, primarily for release readiness, not as routine proof that a change works. Outside release readiness, run one only when explicitly requested or when a named evidence gap cannot be closed by unit tests and a focused script. Explain that gap before occupying the lane.

Launch a scratch script that imports `src/` with `bun --env-file=.env.test`, or call `Log.suppress()` in it, so its diagnostics stay out of the person's account log.

| Command | When to run | What it does |
|---|---|---|
| `bun run test` | Before committing a unit | Fast unit suite |
| `bun run test:integration:no-api` | Release readiness; rarely for an explicit request or an evidence gap that focused checks cannot close | Every file under `tests/integration/` except `providers/`; needs no credentials and costs nothing |
| `bun run lint` | Before committing a unit | TypeScript for `src` and separately for `tests` and `scripts`, oxlint including SolidJS reactivity, unused exports, file and naming limits, safety comments, terminal I/O, owned-process launches, and doc coherence |
| `bun run check:boundaries` | After adding/moving files | Source-layer and client-host dependency enforcement |
| `bun run lint:module-containment` | After changing a module, registry, module home, protocol domain, or fact family | Fails registry/home drift, foreign imports into module homes, and module-owned vocabulary outside its owner; `scripts/module-containment-allowlist.ts` is permanently empty |
| `bun run test:perf` | After a change that can affect startup | Builds the host archive and measures startup (empty store, large store, and a remote first attach through a loopback relay) against absolute budgets and the published baseline in one run; startup regressions above 20% fail. Run it alone on the machine; a concurrent gate inflates both |

`tsconfig.json` covers `src` only, so `tests` and `scripts` are type-checked by their own project (`tsconfig.tests.json`) through `lint:test-types`. Both must stay free of type errors.

Run these commands bare. Do not pipe them through `head`, `tail`, `grep`, or any other output filter. They already pre-filter their output to failures, so read the complete output directly.

These gates bind the session that owns the change. A delegated subagent runs only the verification its brief names, at most once before handoff; the dispatching session owns the suite-level gates above.

| Tier | Location | Speed |
|---|---|---|
| Unit | `tests/unit/` | Seconds |
| Integration | `tests/integration/` | Minutes |
| Live UAT | `src/orchestration/modules/development/definitions/skills/flywheel-uat/SKILL.md` | Several minutes |

**Unit tests must NOT:** make API calls, spawn real processes, use `setTimeout` >30ms, drive the live TUI, create files in the project directory or under a literal `/tmp` (use a directory under `tmpdir()`), or leave anything in the temporary directory. Remove every temporary entry in `afterEach`, `afterAll`, or `finally`; `temporaryDirectories()` and `fileTemporaryDirectory()` in `tests/helpers/directories.ts` do it for you. `bun run test` and every `bun run test:integration:*` mode give each test process its own TMPDIR and fail when anything is left in it. `tests/preload.ts` refuses every `fetch` and `WebSocket` to a host other than this machine from a test file outside `tests/integration/`, and fails the test that made the request with its URL and caller; fake the network at the seam the product exposes, such as an injected `modelsClient`. Every `bun test` process also loads `.env.test`, so git in a test reads no global or system git configuration, and no background service that such configuration starts can write into a temporary repository after the test removed it. A literal `/tmp` path bypasses that guard, so the oxlint rule `flywheel/no-tmp-literal-path` rejects one anywhere under `tests/`; a fake path uses a root that does not exist, such as `/scratch`. Any test that cannot stay fast and hermetic belongs under `tests/integration/`.

A new test must protect behavior that no existing test already asserts; extend the owning test instead of adding a sibling. The `test-driven-development` package owns this authoring gate.

Fix all errors and warnings from `bun run lint` before moving on unless the failure is demonstrably unrelated to your current work.

Every lint suppression in production code must stay on one line and include `-- <reason>`. A suppression is boundary documentation, not a way to hide debt. Use `boundary:` when an external or runtime boundary makes the exception unavoidable.

Fix slow tests immediately, something has gone wrong if the test suite is taking > 20 seconds to run.

### TUI Verification

Styled rendering tests inspect color and blink metadata, not only plain text.

After any change affecting behavior or rendering, verify the live TUI yourself and cite the observed pane output. Load the `flywheel-uat` package. It always drives the installed binary (`bun run install:local`), never `bun run dev` and never `bin/flywheel`, and a scripted regression harness does not substitute for it. If a change only touches internals with no user-visible TUI behavior, say why live verification is not applicable.

Test and UAT TUI launches use `FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS=1` to suppress automatic auth and paid-use dialogs without changing authentication, paid permissions, recorded answers, or manual dialogs. Set `0` explicitly when testing automatic dialogs; never dismiss those questions as readiness recovery. Refer to the canonical `flywheel-uat` package for the launch contract and exception pattern.

---

## 6. Writing Comments and Documents

- Everything you write should use the rules of ASD-STE100 Simplified Technical English so that it is clear and unambiguous.

- Let the code explain what it does. Do not restate obvious control flow or syntax in comments. Use comments to explain hidden context: rationale, constraints, invariants, tradeoffs, or surprising behavior.

- Document contracts at the boundary. Public functions and APIs should explain expected behavior, inputs, outputs, side effects, and failure modes.

- Prefer clearer code over more comments. Rename, refactor, or introduce better abstractions when the code itself can carry the meaning.

- Do not use emojis or em-dashes anywhere.

- When writing documents do not use artificial line breaks to wrap text, let it wrap naturally.

---

## 7. Module Boundaries

Source layers depend in one direction (ARCH-STRUCTURE-001):

```text
src/
  cli/             --> composition root, imports from everything
  infra/           --> shared foundation, imports NOTHING from src/
  protocol/        --> published client contract, imports only from infra/
  workflows/       --> imports only from infra/ + protocol/
  orchestration/   --> imports from workflows/ + protocol/ + infra/
  tui/             --> imports from orchestration/ + protocol/ + infra/
```

**Dependency direction (one-way):** infra <- protocol <- workflows <- orchestration <- tui.

- Import nothing from `src/` except `src/protocol/` in the three workspace members outside it (ARCH-STRUCTURE-001, ARCH-STRUCTURE-043, ARCH-PROTOCOL-003, ARCH-PROTOCOL-031): `webview/` (the web client, with host shells in `webview/local/` and `webview/editor/`), `vscode/` (the editor host, which takes the host contract from `src/protocol/client/`), and `relay/` (the phone host and the relay Worker).
- `bun run check:boundaries` enforces all three, and `bun run lint:relay` type-checks both relay deployables against their own runtimes. `bun run lint:webview` adds the client's stylesheet gate: colours, font sizes, z-indexes, and container widths come only from `webview/src/styles/tokens.css` and its width ladder (ARCH-PROTOCOL-064).
- Keep every client surface (terminal, desktop web, phone web, and editor) mounted while the thing it shows exists. UI state belongs to the surface and stays local, and network updates patch it in place (PI-INTERACTION-062, ARCH-PROTOCOL-062). Stability takes precedence over showing new data sooner. For the web method and guard tests, load the `webview-rendering` package before you change a web client surface.
- Run `bun run check:boundaries` after any file addition or move.
- Render ordinary TUI action buttons with `src/tui/components/button.tsx`, never a copy of its styling in a new clickable box; callers own actions, keyboard routing, and progress text. Tabs, selectable rows, header chrome, and transcript-inline Stop/Detach keep their specialized rendering (ARCH-PROTOCOL-065).

Each layer and module home owns one kind of concern (ARCH-STRUCTURE-002, ARCH-STRUCTURE-018, ARCH-WORKFLOWS-010), and each layer has one static module registry (ARCH-STRUCTURE-017):

| Module | Owns | Never contains |
|---|---|---|
| `cli/` | Entry point, wires all layers; kernel nouns, module nouns compose from the catalog | Domain logic, UI components |
| `infra/` | Logging, error utils, output blocks, events | Logic that imports from `src/` |
| `protocol/` | The published wire contract: schemas, `RuntimeProtocolRpc`, call policies, shared client core | Runtime composition, tool execution, rendering |
| `workflows/` | Definitions, compiler, raw XState control and verification, typed workflow facts, concrete attempts and projections, handoffs | Config, sessions, agent runtime, rendering |
| `workflows/output-contract/` | Output contracts of briefs: the closed field grammar, the compiler, the envelope and citation check, acceptance, rendering for later agents, and the output facts | A name-keyed contract registry, orchestration machinery, module-specific checks |
| `orchestration/` | Config, sessions, agent runtime, runners, worker spawning, workflow host wiring | Rendering, UI, hooks, XState policy |
| `tui/` | Shell, hooks, adapters, components | Domain logic, session CRUD, workflow control, workflow-view projection building |
| `protocol/modules/<id>.ts` | One module's cursor domains, snapshot and patch codecs, queries, mutations, and pure row selectors | Runtime state, Bun APIs |
| `orchestration/modules/<id>/` (or `orchestration/modules/<id>.ts`) | One module's descriptor, runtime, process service, tools, projections, facts, and command handlers | Rendering, another module's runtime |
| `tui/modules/<id>/`, `webview/src/modules/<id>/` | One module's strip, surfaces, and presence in that client | Domain logic, another module's views |
| `protocol/modules.ts`, `orchestration/credential-provider-modules.ts` with `orchestration/modules.ts`, `tui/modules.ts`, `webview/src/modules.ts` | The module registries: one static list per layer, with the orchestration list split so a login loads only the modules that claim a credential provider id | Module-specific branches |

**New code:**

- Make a new capability a module unless ARCH-STRUCTURE-008 lists it as kernel, and give it one line in each registry it reaches.
- The home for each kind of code (module protocol, runtime, and client homes; workflow templates with inline briefs and output contracts; hooks; runner stacks; migrations; skills) is the routing list in `docs/architecture.md` under "Where New Code Lives". Read it before adding a file.
- Keep the module-containment allowlist empty (ARCH-STRUCTURE-020). Module facts, retained history readers, and historical migrations compose from the installed catalog even while the module is disabled; new capability work composes from enabled admission (ARCH-STRUCTURE-029).
- The kernel owns migration ordering and workspace exclusion, not module transformations (ARCH-SUBSTRATE-045).
- Give each domain one home. Deep relative imports mean the file is in the wrong place; when a module moves, update every import, with no re-exports, bridge files, compatibility shims, or forwarding addresses (ARCH-STRUCTURE-003).
- Put a capability that exists only for developing Flywheel in `src/orchestration/modules/development/`, which a release never installs. Nothing in `src/` branches on `isDevelopmentBuild()` to expose a tool or a definition (ARCH-STRUCTURE-013).
- Add behavior by registration, not by editing a switch (ARCH-STRUCTURE-017). First-party modules and their tools register through `src/orchestration/modules.ts`, or `src/orchestration/credential-provider-modules.ts` for a module that claims a credential provider id, and one descriptor under `src/orchestration/modules/`. Commands register at the TUI command dispatch and controller boundary; the other registries are listed in the `typescript-bun` package.
- A module's optional per-runner runtime is constructed only while the module is enabled, and tool factories, exposure and execution gates, and prompt fragments read it through the module's typed handle from `{ kernel, modules }` deps (ARCH-STRUCTURE-027). A module's optional process-scoped service is declared the same way and built once per process in dependency order (ARCH-RUNTIME-048).
- State a condition that a person should see through the composition's notify seam, never by naming the notifications module (ARCH-STRUCTURE-034).
- Runtime and workflow hooks are typed callbacks on their owning boundary (ARCH-STRUCTURE-042). A hook that affects model-visible context or durable state must be inspectable and recorded (ARCH-CONTEXT-003).
- Register every projection's lifetime with `src/infra/projection-registry.ts`, and never build one per call: wrap the construction in `heldProjection(reader, key, () => createEventProjection(...))`, where the key names the family and every id the factory closes over (ARCH-SUBSTRATE-016). `createEventProjection` initializes lazily on its first awaited operation, and rebuilding it discards its cursor and repeats history.
- Read a registered projection with `replay()`. Only an owner that feeds the projection itself through `apply()` reads `getState()` (ARCH-SUBSTRATE-016).
- `bun run lint:projections` checks projection construction and unfed `getState()` reads through source-text patterns. These checks do not prove registration or freshness through aliases, helpers, or arbitrary source formatting.

Advance derived state; never recompute it (ARCH-SUBSTRATE-017). A hot path is code that runs per store change, per stored-fact batch, per tick, per live subscription, or per member, item, or agent of a loop. Every hot path follows three rules:

1. Read the owning live state: the session store entry, the summary index and its pushes, or a registered projection through `replay()`. A new durable read on a hot path states, in a comment at the call, why no owner can serve it.
2. Do work bounded by the change, never by the number of members, items, or history entries.
3. Fold once, then advance. Never read an aggregate from its start and fold it again on a hot path, under any spelling: `createEventProjection`, `read({ aggregateId })` or `readSlice` with no lower position bound followed by a reduce, or a cache keyed by sequence that rereads everything when the sequence moves. A one-shot path (an explicit person command, a migration pass, recovery, startup) may read in full, but never once per item of a loop. Never add a hot path to the one-shot ledger `scripts/aggregate-read-allowlist.ts`.

A change to a hot path ships with a work-count test at its owner: drive N changes over M members and assert the reads or state requests per change, which must not grow with M or with history length. Count them with `countStateRequests` from `tests/helpers/state-requests.ts`. Wall time is not that test.

The aggregate-read part of `bun run lint:projections` parses `src/**/*.ts` and `src/**/*.tsx` with the shared tree-sitter loader. It flags unbounded `readSlice`, `capturedFacts`, and `readCapturedFacts` queries outside a syntactic `heldProjection` ancestor. It also checks `read` and `readTolerant` when every visible query key belongs to `FactQuery`. Queries resolve through object literals, lexical `const` bindings, spreads, conditional alternatives, and TypeScript expression wrappers. Every visible alternative must carry a defined `afterPosition`, `fromSeq`, `positions`, `limit`, `toolUseIds`, or `parentToolUseIds` bound; `beforePosition` alone does not count. The loop rule flags these reads and the named durable-request methods in `scripts/aggregate-reads.ts`, including `readPage` and `capturePosition`, inside `for...of`, `for...in`, or the listed array-iteration callbacks in the same function. Reviewed exceptions live in `scripts/aggregate-read-allowlist.ts`; unmatched exceptions fail.

This syntax check is not complete coverage of the derived-state rule. It does not follow helper calls, imported queries, mutable query objects, aliased or computed method names, or receiver types. Unresolved queries and spreads, and opaque bound values, are trusted; their runtime values can still be unbounded. Counted `for` and `while` loops are excluded as paging or retry syntax. It cannot identify a caller's cadence, prove that a bound advances, or prove that a `heldProjection` ancestor owns the read. Review callers and use work-count tests to cover these blind spots.

---

## 8. Flywheel Invariants

No package owns these; they are this system's own substrate rules.

| Pattern | Instead | Statement |
|---|---|---|
| Deterministic work modeled as an executable workflow node | Typed XState control event and `workflow:<sessionId>` fact proposal; deterministic nodes never invoke a model | ARCH-WORKFLOWS-004 |
| Hand-extracting fields from a known fact with `asString`/`asNumber` | Decode the fact once via `parseProjectionFact`; read typed fields | ARCH-SUBSTRATE-011 |
| Parallel idempotency key / dedup record / attempt "resumed" marker | The event-sourced conversation is the ledger; a retry replays it, never re-runs | ARCH-SUBSTRATE-038 |
| A tool input schema whose root is a union (`oneOf`, `anyOf`, `allOf`) or anything other than one `type: "object"` schema | One flat object with a discriminating enum field such as `kind` or `action`; the handler enforces per-variant requirements; `materializeToolInputSchema` refuses any other root and the planner test materializes every registration | ARCH-TOOLS-003 |
| A direct raw external-process launch or shell wrapper in production code | Ordinary launches use `spawnOwned`, `runOwnedCommand`, or `openExternalUrl`; explicitly authorized survival uses only `src/infra/persistent-subprocess.ts`; raw launch stays in the authority modules listed by `bun run lint:owned-processes` (`scripts/check-owned-process-launches.ts`), which enforces it | ARCH-TOOLS-022 |

---

## 9. Session Folder Layout and Debugging

Durable per-session state, including each conversation's typed checkpoint and every earlier version, lives in `.flywheel/flywheel.sqlite` as facts; diagnostics are JSONL records under `.flywheel/log/`. The session directory holds only the `owner.pid` lock and disposable `scratch/`. Legacy Markdown notes are imported into checkpoint Working notes on first use. When debugging a session, start with `flywheel events search` (`bun run events:search` in the source tree).

### Instrumentation

Instrument every decision so that a person can tell what happened, when, and why, and keep the logs storage-neutral. Every diagnostic record you add or touch follows these rules:

- One INFO record per decision, state change, or finished unit of work, with the evidence it rested on. Every kill, restart, refusal, replacement or update step, registration change, and exit is recorded once (ARCH-RUNTIME-076).
- Per-call, per-request, and per-iteration paths log at DEBUG. `loggedOperation` in `src/infra/operation-log.ts` writes a start and done pair as one done record with its duration, above DEBUG only past `slowMs` or on failure (ARCH-RUNTIME-076).
- No content in a record: ids, byte counts, hashes, and kinds only. Conversation text, tool output, prompts, and file content live in `.flywheel/flywheel.sqlite`, which `flywheel events search` reads (ARCH-RUNTIME-075).
- Repeats coalesce: the first occurrence of a condition records, and later repeats become one count reported when the condition ends or changes. `coalesceRepeats` in `src/infra/repeat-coalescer.ts` does this, and an owner whose failures repeat routes them to it through the `onFailure` option of `loggedOperation` (ARCH-RUNTIME-077).
- `src/infra/diagnostics-registry.ts` decides every record family's tier: `info`, `debug`, or `notable`, which reaches the default level only for a record its producer marks failed or slow. An unregistered type is DEBUG, `bun run lint:diagnostics` enforces the registry, and `tests/integration/local/diagnostics-volume-budget.test.ts` fails when steady-state log volume grows (ARCH-RUNTIME-078).

The folder layout, the fact and debug-log split, content-addressed tool text, the in-flight-state rule, the store maintenance commands, and the diagnostics mechanics are in `docs/architecture.md`, "Session Artifacts" and its "Diagnostics" part. Read them when adding per-session state, a fact family, or a diagnostic record. When debugging a session, load the `session-debugging` package.

</coding_guidelines>
