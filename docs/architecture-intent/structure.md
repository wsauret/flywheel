# Structure Architecture Intent

This file states how Flywheel's source is organized: its layers, the kernel, modules, registration, and the home of each kind of code.

## ARCH-STRUCTURE-001: Source layers depend in one direction

Source layers depend one way: infra, then protocol, then workflows, then orchestration, then clients. Infra imports nothing from the source tree, protocol imports only infra, and workflows import only infra and protocol. The CLI is the composition root: it may import every layer and holds no domain logic or UI components. Workspace members outside the source tree compile against the published protocol contract alone.

## ARCH-STRUCTURE-043: The source tree holds the binary, and other hosts are workspace members

The source tree holds the runtime and the terminal client, which compile into the Flywheel binary. A host that runs on another platform is its own workspace member beside the source tree, with its own runtime types, dependencies, and deploy. These hosts are the web client in a browser, the editor extension in the editor, the desktop app in its native window, and the relay service with its hosted phone page.
Because: The source layers, their type checks, and the release archive assume one runtime, and a host for another platform or another deploy schedule would bring foreign types and dependencies into all three.
Not: A source layer or a module for the relay or another separately deployed host.

## ARCH-STRUCTURE-002: Each layer owns one kind of concern

Infra holds logging, error utilities, output blocks, and events. Protocol holds the published wire contract and the shared client core, with no runtime composition, tool execution, or rendering. Workflows hold definitions, the compiler, workflow control and verification, typed workflow facts, attempts, projections, and handoffs, with no config, sessions, agent runtime, or rendering. Orchestration holds config, sessions, the agent runtime, runners, worker spawning, and workflow host wiring, with no rendering or workflow control policy. Clients hold presentation and input only, with no domain logic, session mutation, workflow control, or projection building.

## ARCH-STRUCTURE-003: One domain has one home

Each domain has one home, and a deep relative import shows that a file is in the wrong place. When ownership of code changes, the code moves and every import changes to the new home.

Not: A re-export, bridge file, or compatibility shim that keeps the old address alive.

## ARCH-STRUCTURE-004: Reactive state stays in client layers

Reactivity exists only in client layers. The runtime layers hold plain typed records that notify change, and clients build their UI-readable state from protocol snapshots and patches. No reactive object identity crosses the runtime boundary.

Because: Shared reactive identity would couple runtime ownership to one client's reactive graph and break every other client.

## ARCH-STRUCTURE-005: Effect owns async lifecycle only

Effect owns scoped resources, structured concurrency and cancellation, completion signals, typed runtime errors, and Effect-native streams where adopted. It does not own business logic, durable state, workflow transition policy, session authority, or client reactivity, and Flywheel is not an Effect application container. An Effect service sits beside its domain owner, calls injected callbacks instead of keeping a parallel reactive graph, and maps errors to tagged types at its boundary.

Not: A technology-named Effect directory, or an adapter that bridges Effect and client reactivity.

## ARCH-STRUCTURE-006: One schema library carries every contract

Effect Schema is the one schema and validation library for external normalization and for internal facts. No second validation library carries a Flywheel-owned contract.

## ARCH-STRUCTURE-007: The event bus notifies and stores hold readable state

The event bus delivers cross-cutting infrastructure and lifecycle notifications to every subscriber: producers emit raw events and subscribers filter them. UI-readable state lives in client stores that runtime snapshots and patches feed. Direct callbacks carry only one-to-one lifecycle signals and never form forwarding chains.

Not: Producers that filter events in advance for particular consumers.

## ARCH-STRUCTURE-008: A capability is a module unless it is kernel

The kernel is the event store, session manager, conversation and its recovery, and runner. It also includes provider admission and the failover walk, protocol core, transcript, composer, session catalog, config, and auth store. Every other capability is a module with one id, one home in each layer it reaches, and one entry in each registry it reaches.
Not: Adding a non-kernel capability directly into kernel code.

## ARCH-STRUCTURE-009: The module system is internal and static

First-party capabilities are statically imported, typed, function-bearing module descriptors composed inside one JavaScript realm. Flywheel has no external plugin interface, manifest, sandbox, loader, or dependency-injection container. A pure shared contract moves to a lower layer only when a concrete dependency benefit requires it.

Because: Static descriptors give owner types at compile time without a loader, and a public plugin surface would freeze internal contracts.

Not: A public plugin interface or a manifest-driven loader for first-party modules.

## ARCH-STRUCTURE-010: The installed catalog is the one source of module truth

The published protocol vocabulary names every module id that a config, a selection, or a client can carry. The installed catalog alone defines each module's dependencies, contributions, execution gates, and empty-domain warnings, and no subsystem keeps a second copy of them. The catalog validates its own structure before use, and duplicate ids, colliding contributions or gates, dependencies on unregistered modules, and dependency cycles are internal defects.

Not: A separate feature-flag list that repeats module identity and dependency data beside the catalog.

## ARCH-STRUCTURE-011: The catalog has a credential half and a capability half

Orchestration owns the shipped catalog in two registries: one holds every module that claims a credential provider id, and the other holds every other module and composes both into one frozen installed catalog. Installed provider and credential vocabularies derive from the credential half alone, so a login loads provider definitions and never a tool or the full module graph. A credential claim outside the credential half, or a credential-half module that claims none, is refused.

Because: Auth actions load at a client's first login, and the whole module graph on that path costs startup.

## ARCH-STRUCTURE-012: The first read fixes each catalog half

An entry may install an override of either catalog half before the first read. The first read fixes that half for the process. A second install, or an install after a read, is a defect. A launch that does not need composition leaves the optional module graph unloaded.

## ARCH-STRUCTURE-013: Development tooling is a module that releases never install

Every capability that exists only for developing Flywheel is a contribution of the development module. Only the source entry adds the development catalog, so a release excludes it because its entry never names it. No other code branches on the build kind to expose a tool or a definition.

Because: The bundler keeps a statically imported catalog even behind a build-time constant, so absence from the entry is the only exclusion that holds.

Not: Excluding development tooling with a build-time flag or a development-build check.

## ARCH-STRUCTURE-014: Contributions are owner-typed and closed

A module declares one id, its dependencies, its availability, and owner-typed contributions and hooks. Orchestration defines the closed map of contribution domains, so a module cannot contribute an unknown bag or create a reverse dependency. A contribution is a narrow, host-owned structural value, never a planner or client implementation union.

## ARCH-STRUCTURE-015: Observers observe, transformers chain, and gates are singletons

An observer hook cannot replace a value or veto control flow: its return is ignored, each failure is isolated, delivery continues, and it causes only the side effects its seam supplies. Transformers form deterministic ordered chains. A gate is a singleton per seam, a duplicate gate is a startup error, an absent gate adds no wrapper, and the seam owner defines the gate's power and position.

## ARCH-STRUCTURE-016: Catalog position has no meaning

Composition sorts module ids and contribution identities, uses declared numeric order for transformers, and rejects collisions. Canonical module order for persistence and display is lexicographic by id. A semantic order, such as the delivery order of a chain of observers, is declared inside one cohesive contribution.

Because: Source order is not policy, and import order would otherwise decide authority.

Not: Deriving delivery or routing order from the position of a module in a list.

## ARCH-STRUCTURE-017: Behavior arrives by registration and hosts name no module

New behavior registers with its owning system instead of adding a case to a switch in another layer. Each layer has one static module registry with no module-specific branches. Every host composes from contributions. The command host exposes kernel primitives only, and kernel commands use the module command shape. The tool planner, runtime read and mutation routing, health checks, and each client host read registries. Adding a command, tool, health check, or view therefore adds no host routing case.
Not: A switch over module ids in kernel, host, or registry code.

## ARCH-STRUCTURE-018: Module homes split by layer

A module's protocol home holds its cursor domains, snapshot and patch codecs, queries, mutations, and pure row selectors, with no runtime state. Its orchestration home holds its descriptor, runtime, process service, tools, projections, facts, command handlers, and command-line verbs, with no rendering. Its client homes hold its strip, surfaces, and presence in that client, with no domain logic.

## ARCH-STRUCTURE-019: A module owns its whole implementation

A module owns its complete implementation in its per-layer homes, and no consumer reaches into another module's internals. Shared primitives and lower workflow facts stay in the lowest lawful layer and name no optional owner. A typed host seam or behavioral contribution that carries the minimum authority a consumer needs replaces every cross-module implementation import.

## ARCH-STRUCTURE-020: Module containment has no exceptions

Registry identity, protocol ownership, canonical homes, imports into module homes, and module-owned vocabulary are enforced with an exception ledger that stays empty. A module's vocabulary includes its tool names and capability phrases in Flywheel-owned model text. Outside the module's own text, they appear only under a capability check for them. Adding a capability means adding its home and its declarations.

Not: An allowance entry for a foreign import into a module home.

## ARCH-STRUCTURE-022: Module command-line nouns compose from the catalog

A module contributes its command-line noun and verbs through the catalog, and its verbs are the one place outside the CLI layer that writes to the terminal. The composition root writes only kernel nouns by hand and composes every module noun from the installed catalog, so it recognizes a noun before it knows a project.

## ARCH-STRUCTURE-023: Every fact family has one declared owner

The registry that records a fact family's retention shape also records its one owner, the kernel or one module. A module's families are defined in that module's home and carry the type prefixes the module declares. Only the owner's homes, the registry, and the kernel readers that present or prune every family name them.

## ARCH-STRUCTURE-024: The module selection names only what a person turned off

Every writer and every client control of the module selection expresses it as the set of modules that a person turned off, and every other installed module is on. No component keeps or sends a complete set of enabled modules.

Because: A stored list of enabled modules silently turns off every default-on module that ships after the list was written.

Not: A complete enabled snapshot, or a second opt-in polarity behind a risk confirmation.

## ARCH-STRUCTURE-025: The stated selection persists and the effective selection composes

Persistence keeps the person's stated selection, and composition and admission read the effective selection derived from it, in which a module whose dependency is off or unavailable is also off. Flywheel never cascades a disable into the stored selection and never rewrites an invalid one. A module's own selection policy decides validity.

Because: Cascading or repairing would guess the person's intent and hide dependency errors.

Not: Writing dependents off when their dependency turns off.

## ARCH-STRUCTURE-026: A module reaches the product only through its contributions

Every effect of a module, including model tools, prompt guidance, commands, providers, settings rows, observers, transformers, gates, reviews, maintenance, and other automatic work, comes from one typed catalog contribution. Composition reads the live effective selection, so an off module contributes nothing and its hidden protocol views answer empty from the next snapshot.

Not: Per-subsystem enable flags kept in step with the module selection.

## ARCH-STRUCTURE-027: Module activation is live and lazy

A selection change applies at runtime without a restart. Composition constructs a module's per-runner runtime once per runner only while the module is enabled, and the module's tool factories, exposure and execution gates, and prompt fragments read that instance through the module's typed handle. A module's process-scoped service is built when the module first becomes enabled, not at startup, and activation completes before the changed module surface is published.

## ARCH-STRUCTURE-028: One composition value per selection

Composition yields one frozen value for each installed catalog, disabled-module set, and custom-provider generation, with the tool registry derived from it kept beside it. Every reader of one selection receives the same value, so a selection change reaches every composition-keyed cache in the process, while a runner keeps the registry it captured when it was created.

## ARCH-STRUCTURE-029: History composes from the installed catalog

Turning a module off keeps its installed data and durable history. Fact schemas, retained history readers, and historical migrations compose from the complete installed catalog whatever the selection, and they grant no permission for new module work, which composes only from enabled admission. Read-only inspection, stop controls, deletion, and historical rendering of an off module's records stay with their retained-data owners.

Because: A disabled module still owns history that must stay readable.

## ARCH-STRUCTURE-030: A known module that is not installed keeps its meaning

A module id that the protocol vocabulary knows but the installed catalog does not hold is known and not installed. The selection accepts it, catalog rows report it as not installed, and composition ignores it, so a selection written in a source run keeps its meaning in a release and back.

## ARCH-STRUCTURE-031: Module definitions load when installed and show when enabled

A module's skill and persona definitions load whenever the module is installed, and each one requires its module, so turning the module off hides them without unloading them. A bundled method that only one module's capability can run ships in that module's definitions. A persona's declared tools are a ceiling, so a module that is off removes its tools from the persona and never hides the persona. Workflow files have no catalog membership.

## ARCH-STRUCTURE-044: One availability decides every use of a definition

One owner decides whether a skill or persona definition is available. A persona is available when its module is enabled and its agent type is on. A skill is available when its module is enabled and every agent type that it declares is available. The skill catalog, skill loads, skill commands, the persona roster, dispatch, workflow launch, an agent that runs as a persona, and the model settings read this one availability. No reader treats the installed persona list as the list of types that can run.
Because: a reader that takes the installed list offers or runs a type that another surface refuses.
Not: a separate check of the turned-off types at each reader.

## ARCH-STRUCTURE-041: Definition loading is kernel; optional reconciliation is declared

Definition loading does not depend on Learning. Installed definition roots and their reload watch are kernel loading infrastructure, and mandatory definition loading continues while the Learning module or any other optional module is off. Optional reconciliation is a declared preparation contribution that obtains fresh admission at startup and at each reload, writes only through the writer its host passes, honors cancellation, and joins its admitted writes before disposal.

## ARCH-STRUCTURE-032: Kernel tools are never module contributions

The handoff, process, session-messaging, and session-listing tools are kernel registrations, because they expose runtime settlement and host services, not selectable capabilities. They never appear as module contributions, protocol or settings rows, or persisted selections. Every other tool family belongs to exactly one selectable module, and no umbrella identity such as a core tool set is a catalog identity.

## ARCH-STRUCTURE-033: Admission inputs are kernel and their inspection is a module

Profile connections, the profile request ledger, provider-observation generations, the provider observations that admission requires, and paid-use consent are kernel authorities, because request settlement, availability, and paid-use admission need them while every optional module is off. An explicit provider refresh is an auth action that does not depend on the usage module. The optional usage module owns only usage inspection, polling, threshold alerts, and every usage client surface, and it reads accounting through a kernel port without a second pool or ledger. Providers contribute their observation readers and reset consumers through composition and declare no dependency on the usage module.

Because: A module toggle must never disable admission, accounting, or consent.

Not: Placing the ledger, the observation pool, or spend consent inside the usage module.

## ARCH-STRUCTURE-034: Producers state conditions through the notify seam

A kernel or module producer states a condition that a person should see as a raise, resolve, or reconcile through the composition's notify seam. The seam hands it to every enabled observer, and the notifications module records it. A producer never reads the notification journal or names the notifications module.
Because: A kernel producer must keep working when the notifications module is off.
Not: Giving producers the journal so that each decides its own raises and resolves.

## ARCH-STRUCTURE-040: The notify seam reports whether a statement landed

The notify seam settles only after every enabled observer applied the input, and it rejects with an observer's failure; with no enabled observer it answers at once and records nothing. A producer that must know its statement landed awaits the answer and sends again, and a producer that does not act on a failure contains it and coalesces repeats.

## ARCH-STRUCTURE-035: Descriptors import no third-party SDK

A module descriptor, its auth and catalog contributions, and a provider's description of model limits and prices import no third-party SDK. A module loads such an SDK at the first use that needs it.

Because: The account service and the project executor import the whole catalog before chat input is ready.

## ARCH-STRUCTURE-036: Infra keeps open identities and orchestration supplies the vocabulary

Infra owns the generic module descriptor, structurally open provider and credential identities, and pure parameterized provider selection. Orchestration provider contributions are the only source of the strict installed vocabularies, which composition roots inject at persistence, protocol, and config boundaries to reject unknown identities.

Because: Infra cannot import orchestration provider modules, and a copy of their metadata in infra would be a second authority.

Not: An infra-owned provider population or fallback list.

## ARCH-STRUCTURE-039: Kernel session tools follow runtime state, not the module selection

Handoff exposure derives only from handoff capture, and process exposure derives only from enabled background producers or an active task. Session messaging and session listing are present in every session of a project composition, whatever its persona allowlist says, and session listing shows only sessions that the caller did not start.

## ARCH-STRUCTURE-042: Hooks are typed callbacks on their owning boundary

A runtime or workflow hook is a typed callback that its owning boundary declares and calls. Tool dispatch adds a post-call hook only where a concrete consumer reads it. A hook that affects model-visible context or durable state follows ARCH-CONTEXT-003.
