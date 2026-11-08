# Providers Architecture Intent

This file states how Flywheel organizes provider composition, auth profiles, model eligibility, request admission and failover, paid-use consent, and usage accounting.

## ARCH-PROVIDERS-001: One provider is one module

Each provider is one orchestration module whose home owns everything the provider is: its definition, client factory, adapter selection, catalog fetch, login flow, token refresh, usage reader, affordability, allowance admission, and settings. A host table that would enumerate providers is a definition field instead, so adding a provider is one module and no host edit. Planning expands a metered definition into one candidate and a subscription definition into one adjacent candidate per captured credential instance.

Because: Disabling an aggregate module cannot remove one provider, and it leaves individual contributions outside admission.
Not: An aggregate provider module, or separate factory, catalog-policy, reader, or affordability tables.

## ARCH-PROVIDERS-002: Provider registration is validated composition

The enabled provider registry is the sole composition authority for routing, construction, and optional provider-observation readers. Composition validates that each contribution id equals its definition id, that ids are unique, and that every enabled provider has one factory, before planning or construction. An empty registry is legal and warns without enabling a replacement. A module consumes provider contributions, such as usage readers and reset consumers, through the composition, with no dependency from the provider to its consumer.

Because: With mutable registration, import order decides provider authority and tests can change process-global routing.
Not: Mutable or side-effect provider registration.

## ARCH-PROVIDERS-003: Custom providers come from config through the same contract

Declarative custom providers materialize from validated configuration as provider modules through the same contract as shipped providers. The config file is their only authority and the config loader is the only writer of their projection. An entry's presence is its enablement, its credentials live in the auth store under its id, and its user-authored model ids are its static membership.

## ARCH-PROVIDERS-004: Authentication is a strategy on the provider definition

Each provider definition declares one authentication strategy: API key, OAuth with a device-code or browser flow, or an external login that the owning program performs without Flywheel reading its tokens. One generic login and one generic reconnect run every flow, and a client answers a flow by its kind, never by its provider. Every singleton provider and subscription login has one canonical account identity. It owns credentials, model catalogs, and eligibility across all spend modes of that account. Request and availability identity also include the spend mode. The auth store decoder rejects unknown credential keys by name.

## ARCH-PROVIDERS-005: A provider subprocess carries only admitted requests

A provider can serve requests through a program that it runs as a subprocess, but Flywheel alone owns request assembly, retries, timeouts, stream buffering, and cancellation. The subprocess sends only admitted requests, retries nothing, never executes a tool that a model requested, yields stream liveness to Flywheel's watchdog, and starts and stops through the owned launcher. An engine that cannot start fails its request as an unavailable route.
Because: A subprocess that decides its own retries, timeouts, continuation, or cancellation separates a stream from its consumer and makes a second owner of each.
Not: A provider subprocess that owns its stream.

## ARCH-PROVIDERS-074: A Claude engine as MCP client carries only admitted MCP calls

A Claude engine that the MCP module runs as an MCP client carries only MCP tool calls that Flywheel's tool dispatch admitted, and it sends no model request. An engine for claude.ai connectors holds a Claude login. Its only Anthropic API requests are the connector list and the token counts from which Flywheel reads tool definitions.
Because: The engine reaches servers that accept Claude, while Flywheel stays the one owner of tool admission and records.
Not: An MCP engine that runs a tool that a model requested, or that sends a model request.

## ARCH-PROVIDERS-075: Degenerate repetition is resampled in place

The stream attempt detects degenerate repetition in reasoning deltas and fails the attempt with its own failure kind. The admitted request resamples that kind in place on the same candidate within its own budget, without backoff, failover, outage marks, or continuation messages, and runs the final attempt with reasoning off and detection off. The adapter decides how a model turns reasoning off; a model that cannot reasons as before.
Because: A repeating response streams steadily, so no liveness deadline ends it, and a fresh sample from the same model almost always recovers.
Not: A loop handled as a network failure or a stall timeout, a loop that advances the failover walk, or a resample that replays the looping text or adds a reminder.

## ARCH-PROVIDERS-069: An engine process is one resource from its launch, and its files belong to its session's owner

Flywheel reads the output, diagnostics, and end of each provider engine process from its launch, not from its first request, so a pre-started engine and a serving engine are one resource. A pre-started engine that ended is gone before anything asks for it. The engine's files belong to the owner of its session and are removed after that owner closes. After a crash, they are reclaimed only when that owner is proven gone.

## ARCH-PROVIDERS-006: A shared engine host never takes ownership from Flywheel

A chat tree runs at most two Claude engines, the chat's own and one shared host. The host runs every other Claude call of the tree, side calls included, as one of its agents. Its agents share every value fixed at engine launch. Only a named exception with its reason, in one enforced list, starts another engine. Flywheel writes each agent's complete history before each start. Flywheel owns the agent's tools, request control, step admission, failure classification, and restart from that history, with no concurrency cap.
Not: A hook or proxy that writes a model reply.

## ARCH-PROVIDERS-073: Each host agent keeps its own definition and view

Each host agent runs on its own definition's model, effort, and working directory. A grant, depth limit, or disabled module narrows its calls and the text that it alone reads, never the text that it shares with its chat tree.

## ARCH-PROVIDERS-070: A tree's engines run only while a client shows a session that needs them

The chat's engine runs while a client shows the chat with a Claude subscription model, and the shared host runs while a shown session of its tree assigns such a model to any role. An engine stops when its need ends or the last client closes or leaves the session, also while the session's hold waits for a reattach. Running work keeps its engine until that work ends, and no engine starts for a conversation that does not exist.

## ARCH-PROVIDERS-071: The shared host isolates model failures and recovers dispatcher stalls

The host's coordinator runs on the login's cheapest working model that accepts the launch values and moves to the next model when its model fails, so it never fails an agent whose own model serves. A host dispatcher turn that stalls past its deadline closes the host, which fails its waiting agents as transient, and the next agent opens a new host. A stop ends one agent's task, never the host.

## ARCH-PROVIDERS-072: Shared-host framing is route-local, and notices keep their canonical form

The shared host carries each agent's conversation tier, and each tier that the agent's definition cannot hold unchanged, as entries of the agent's conversation. Those entries and the engine's own text are host framing, so every fork and every request that the host does not serve leaves them out and states the current tiers in its own system text. The host may deliver a runtime notice inside a parked batch's last tool result, but canonical history keeps the notice as its own entry.

## ARCH-PROVIDERS-067: A request carries the origin of each block it sends

Preparing a request records, for each block that it lowers, whether a person, the runtime, or a route's framing wrote it, while the canonical entry still states that origin. A transport that rewrites a request for its engine moves or removes only blocks that this record marks as runtime-owned, and passes every other block unchanged as the text it is. The record changes no request byte.

Because: Matching block bytes against runtime text cannot tell a person's message from a reminder that has the same bytes.
Not: A transport that recognizes runtime-owned text by its bytes.

## ARCH-PROVIDERS-068: An anticipation returns a claim, and the provider owns what the claim holds

A provider that can prepare ahead of a request returns a claim from anticipation. Whoever anticipated holds the claim and releases it: a shown session when it is hidden or a newer plan replaces it, new claims first, and a request when it settles. The provider decides what a claim holds and keeps it while any claim or running work holds it. It classifies every end of what it holds and asks the session to plan again at most once per end. Neutral code holds no engine state.
Because: A neutral mirror of a provider's engines counts units that it cannot see, and drives the provider back through it.
Not: Engine liveness, end kinds, or served flags in provider-neutral layers.

## ARCH-PROVIDERS-007: Provider credentials and evidence live in the auth profile

Provider credentials, catalog evidence, the usage authority, model preferences, and paid-use consent live in the resolved named auth profile under the account auth root, so the same provider account in two profiles shares nothing. MCP credentials stay account-global, because MCP server authorization belongs to the account and not to a provider login profile. This includes the sign-ins that the Claude engine keeps for the MCP servers that use Claude as their client, while claude.ai connectors follow the Claude logins of the resolved profile; Flywheel never reads either.

Not: A provider-wide catalog or credential cache that reads across profiles.

## ARCH-PROVIDERS-008: Profile identity is immutable and its name is metadata

A profile's identifier is immutable, and its mutable display name lives in profile metadata. A rename replaces only that metadata, so bindings, markers, environment references, credentials, and catalog evidence never move.

## ARCH-PROVIDERS-009: One profile owner resolves the effective profile

The profile manager owns the account profile catalog and default selection, and it resolves the effective profile once at each composition boundary. Consumers receive a profile identifier and never interpret the environment, bindings, or markers themselves. A project's profile binding lives in global user configuration keyed by the canonical project root, never in project-local configuration.

Because: Profile choice is account authority, and project content must not select which account credentials can read it.
Not: Letting each credential consumer resolve the profile.

## ARCH-PROVIDERS-010: A session owns its captured profile selection

Session metadata owns the auth profile of an independently configured chat or subagent and records it once when absent. Workflow members read the run's selection through membership. Account-default changes and process-local environment overrides change effective credentials without rewriting that selection or its role snapshot. An explicit switch materializes the target profile's roles and records selection and role snapshot together or not at all. Deleting a profile records its successor in the account profile store, which resolves the retired identity for every saved session. Before that session's next request, admission materializes the successor with its current role assignments.
Because: Sessions in offline or forgotten projects cannot be rewritten when a profile is deleted.
Not: Rewriting each saved session's selection at profile deletion.

## ARCH-PROVIDERS-011: Profile deletion never leaves a dangling binding

Deleting a profile first removes every project binding to it and repairs the sticky default in one durable configuration publication. It then closes Usage admission, stops observation work, waits for ledger settlement and the profile's writer, and closes the usage authority, and only then removes the profile tree. A failed publication or settlement leaves the profile in place and restores its admission; a later failure can leave an unselected profile behind but never a binding to a deleted profile.

## ARCH-PROVIDERS-012: Credentials change only through the attached runtime

Login, its answer, completion, decline, and cancel, account disconnect, and account rename are lossless protocol mutations and the only way any client, the terminal included, changes credentials. The serving runtime owns every credential write. Authorization-flow state, token exchange, and credential storage stay on the runtime's machine, and secret-bearing inputs are redacted at protocol decode.

Not: A client-side credential write, or a second authentication path for clients other than the terminal.

## ARCH-PROVIDERS-013: Each continuing sign-in settles exactly once

Every continuing sign-in flow reports progress and settles exactly once, with success or a failure message, correlated by its opaque operation id. A success that cannot be published is published as a failure that says why, and replacing a login or changing the default profile first settles the displaced operation as failed. Clients correlate only the operation they started, and a settlement never authorizes subscription spend or becomes consent truth.

## ARCH-PROVIDERS-014: The external provider owns each project's login condition

An external provider owns each project's in-memory account login condition, its question identity, its single accepted answer, and its request waiters. Auth views and login questions derive from that condition, never from notification or session-question history. Each question's opaque id is its only answer authority. An answer, including an automatic Yes, claims that exact episode once and signs in its captured profile and account. A duplicate or stale answer is ignored. Cancellation is scoped to its own question and operation, and questions and waiters stay project-local.
Not: Answering a login question against the foreground or default profile.

## ARCH-PROVIDERS-066: A refused login parks the request, not the walk

An interactive request whose external login is refused waits in its provider walk after its execution settles, outside stream deadlines, and the wait never counts as child inactivity. A successful same-account login renews the exact saved request on the same candidate without advancing failover. A headless run fails at once instead of waiting.

## ARCH-PROVIDERS-015: Auth, usage, and provider-model views are scoped and secret-free

Auth status and usage reads are scoped to defaults or one session. Profile mutations declare defaults, session, or both as one operation. The runtime resolves that scope from profile state and session metadata. A client never sends a profile id for usage, resolves profile identity, or combines responses. Provider-model state is addressed only by a provider's singleton account or by provider and an opaque, profile-bound account correlation id, and stale-sensitive mutations carry the profile and eligibility revision. Internal credential instances, routing candidates, credential lineage, provider subjects, credentials, and filesystem paths never cross the client boundary.

## ARCH-PROVIDERS-016: Model preferences are profile-local deltas

Provider-model preferences are non-secret, profile-local state keyed by canonical provider account identity, and they hold only explicit enable and disable deltas and route preferences that differ from their default. Product curation owns default membership and live account catalogs own serveability. A change persists under the profile lock before new eligibility is published, entries for removed accounts are inert, and malformed state fails closed.

Not: Silently restoring defaults when the preference state is malformed.

## ARCH-PROVIDERS-017: Serveability comes from catalog evidence

A provider definition owns model serveability through settled catalog evidence and transport capability, not through static model-id validation. Shipped providers declare no membership predicates, static baselines, canonical-alias tables, or provider defaults; exact first-party extraction, limits, metadata namespaces, evidenced wire cleanup, and an optional first-party fetch stay inside the provider contribution.

Not: Hardcoded per-provider model lists or alias tables.

## ARCH-PROVIDERS-018: Saved catalog evidence is fenced by credential generation

A valid catalog saved for the exact canonical account and credential generation is admission evidence with no age limit: preparation publishes it at once and starts one owned background replacement. Credential generation fences cache reads, replacement, deletion, and publication, but never defines membership or storage identity. A catalog read serves the shared model metadata document that the process holds and never reaches the network; only the owned metadata refresh does.

## ARCH-PROVIDERS-019: Model identity fields stay separate

Each usable provider row derives one stable canonical model identity from shared cleanup and the grammar its contribution evidences. When a contribution declares its wire ids move between snapshots, the row uses the shared metadata snapshot identity. Aggregation keys, exact wire ids, route classes, and data-use classes stay separate fields, and moving aliases stay unresolved. The shared model metadata map validates and enriches rows but is never general membership, and missing map evidence never removes a usable row.

## ARCH-PROVIDERS-020: The model catalog owns tokenizer identity

Tokenizer identity belongs to the model catalog, not to the access provider: only a canonical member of the Anthropic catalog resolves a Claude tokenizer identity. Request admission resolves it from the catalog document that the process already holds and never waits on the network. The identity follows the model through admission and failover, and provider aliases, wire model identifiers, and access-provider selection cannot choose another tokenizer.

Not: Letting the access provider or a wire model alias select the tokenizer.

## ARCH-PROVIDERS-021: Eligibility is one immutable decision per profile

Provider-model eligibility is one immutable, pure decision per auth profile. It reads serveability, settled catalog evidence, and that profile's account-keyed enable and disable deltas. It holds exact eligible-model sets per canonical account and one revision that each change advances. The serving runtime prepares and publishes that decision as one value; provider and picker availability are derived unions, never stored. The complete discovered inventory stays inside the provider-settings owner, and no runtime selection, role, tier, pricing, or request path receives it. Clients, auth status, runners, roles, and selected models are consumers, never eligibility authorities.

## ARCH-PROVIDERS-022: Catalog evidence is not routing

The effective catalog, the eligibility decision, and the picker union are read-only views; none becomes the provider registry, the credential authority, or a routing authority. Routing combines the captured registry, connection context, serveability, and the request's captured eligibility. An explicit enable is subordinate to serveability and bypasses only picker curation filters.

Because: User intent cannot make a provider serve a model that it cannot address, authenticate, or admit.
Not: Treating the effective catalog as the router, or letting an explicit enable override serveability.

## ARCH-PROVIDERS-023: The model client admits each request exactly once

Every real provider request, including compaction and embedded model work, passes through one model-client admission. Admission captures the registry, immutable credentials, exact-account eligibility, training-route permission, paid-use consent, included-allowance evidence, fixed candidate order, and account-bound availability together. That capture alone governs planning, construction, retries, and failover, and no later step recaptures it. Each prepared attempt records the provider and account that served it. Later publications of profile, account, preference, selection, or configuration affect only later requests. Changing selection, module composition, config revision, or profile before dispatch discards the prepared request. A committed session profile switch invalidates reusable captures before it settles.
Not: Candidate-list admission diagnostics standing in for the identity that actually served an attempt.

## ARCH-PROVIDERS-024: Model selection is captured per request

Each model request owns the selection that PI-MODEL-021 fixes for it: it captures its effective model, reasoning effort, and provider options together against one captured profile connection. The request, its tool calls, and every general child that it dispatches read that capture, never the runner's initial selection or a later settings read.

## ARCH-PROVIDERS-025: The runtime owns each session's serving model seat

Each session's roles reading carries its assignments and a runtime-owned serving seat, resolved with the runner's rules, that states the selection for its next request. The reading is transient and adds no durable model-binding record. A model-assignment save answers by reading the saved seat again through the roles reading's capture, and says when the saved model does not serve and which selection serves, if any. The runtime records the serving-selection notices of PI-MODEL-056 as display-only system entries in the session's conversation.
Not: A client that computes the serving model from role inheritance.

## ARCH-PROVIDERS-026: Request identity is separate from prompt-cache keys

Provider attribution and session identity travel in fields separate from prompt-cache keys. A cache-disabled request, including compaction, still carries the session identity it needs without emitting a prompt-cache key. The prompt-cache key names the cache group that shares a prefix, the chat tree of the request, and never one conversation, so every agent and side call of a tree reaches the same provider cache.

Because: Coupling the two forces a choice between losing identity and caching a request that must stay uncached.
Not: Deriving session identity from the prompt-cache key.

## ARCH-PROVIDERS-027: Prompt-prefix holds belong to request admission

Request admission decides when a workflow attempt's first model request reaches the provider, not the workflow host. The hold key is the prompt prefix that the serving route states it can share between conversations, so a route that cannot share a prefix never holds a request. Chats and subagents never take the hold.

Because: Only request admission knows the serving route and the exact prompt that decide whether two requests share a cached prefix.
Not: Staggering attempt starts in workflow admission.

## ARCH-PROVIDERS-028: Provider streams have no local concurrency cap

Flywheel puts no local concurrency cap on provider streams: every admitted request starts its stream at once, and the provider's own rate limits are the only limit. A declared retry-after delays only the in-place retry of the request that received it; provider-wide availability is a separate authority.

Not: A local stream semaphore, or a provider-wide pause driven by one request's retry-after.

## ARCH-PROVIDERS-029: Provider liveness counts only provider time

Provider liveness deadlines count only the time during which the provider adapter is being consumed. The caller's processing of a yielded event, including local backpressure, pauses a deadline without losing its remaining network wait, and a paused deadline never suppresses cancellation or terminal usage settlement.

## ARCH-PROVIDERS-031: Candidate order is a fixed function of spend class and rank

Candidate order is a fixed, pure function of spend mode, provider rank, and included-account order, never of catalog, declaration, or list position. Spend classes always order included value before prepaid, automatic, direct API, and aggregator spend, and they order fallback without adding authorization. Exact-account admission filters that order, and a preference among offerings, such as a free standard route or a contributor route, chooses within one candidate and never reorders candidates. Included accounts order by the reset evidence captured for their declared expiring windows, and among equal resets the chat tree's host login goes first, before captured account order.
Because: Source order is not policy.
Not: List-position routing.

## ARCH-PROVIDERS-032: The admitted request's walk is the only retry owner

One admitted request owns the ordered walk over its candidates and every retry and failover inside the request, and adapters make one wire attempt each time they are asked. Each exact route is selected at most once, and in-place retries and same-account login recovery keep that selection. Cancellation and local safety or durability failures stop the request, and an explicit model reassignment is a separate runner transition.

Not: Retry loops inside provider adapters.

## ARCH-PROVIDERS-033: Only the named failover class advances after work starts

Before provider work starts, captured authentication, compatibility, authorization, availability, quota, proven unaffordability, or a route this machine cannot run can skip a candidate. After work starts, only the named failover class advances the walk: spent quota, throttling, overload, a provider-stated outage, or an account's refusal of a model or its extended window. Authentication rejection, provider rejection, malformed requests, and unknown failures end under their own classification, and no classification invents a quota or service observation. The walk scans the whole remaining order and waits only when no candidate can serve now and a relevant recheck is pending.

## ARCH-PROVIDERS-034: Candidate rejection has no side effects

Static candidate checks run before construction, and a rejected candidate creates no adapter, claims no probe, opens no audit, prepares no prompt, and sends no request. A due recheck is claimed only after every read-only gate passes, and only the claim's fence can conclude or renew it.

## ARCH-PROVIDERS-035: A failed attempt settles before the walk advances

A failed provider attempt settles before any retry or replacement: emitted assistant content, observed tool calls, and completed results are kept, request audit and usage close, and quota or outage publication completes. The replacement reads the advanced conversation and never redispatches historical tool calls, and no synthetic user or system instruction enters canonical history. The outer runner does not rebuild for provider fallback.

## ARCH-PROVIDERS-036: Provider clients are lazy and cache only transport

Only a candidate selected after every admission gate and probe claim is constructed. The model client caches successful adapters by canonical account identity, shares concurrent construction per key, and evicts a rejected construction. An adapter holds transport state only; admission, candidate order, quota standing, spend authorization, and failover state are request-local and never cached.

Because: Configuration and chain creation must not authenticate, poll quota, or construct providers that selection never reaches.
Not: Eager client construction.

## ARCH-PROVIDERS-037: Affordability judges the prepared request

Request content is prepared once per revision, and affordability, audit, and dispatch consume that revision without rebuilding it. Provider affordability is an optional contribution, evaluated after candidate-specific preparation and before construction, that refuses only when current provider-owned balance or allowance and provider-owned pricing prove the prepared request unaffordable. Planning never invokes it, and it never substitutes an empty request for missing evidence.

## ARCH-PROVIDERS-038: Availability partitions never alias

Availability owns routing suppression only. Account quota and account-mode availability are keyed by the effective auth profile and the exact candidate, which is the account and its spend mode. One account or mode never suppresses another. Provider service outages are keyed by provider and shared across profiles. A durable outage mark rests only on a failure that the provider stated, never on a lost connection.

## ARCH-PROVIDERS-039: The shared availability authority fails closed and never replaces itself

The account-wide availability authority is decoded strictly, and its protocol version is part of its durable identity, so processes with incompatible semantics use different authorities without stranding older binaries. An authority that states a foreign version fails closed: the process keeps its own observations and commits none. Nothing quarantines, renames, or rebuilds the shared authority, and contention or I/O failures cost only the durability of that one observation.

Because: Other processes hold the authority, so one that replaces itself under them becomes two authorities that spend an account each believes it meters.
Not: Rebuilding or quarantining an unreadable shared availability store.

## ARCH-PROVIDERS-040: Subscription paid use requires recorded consent, never evidence

Authentication of an account with included quota authorizes that included quota only. A subscription prepaid or automatic-billing candidate is admitted only when the profile-local consent authority records an accepted decision for its exact paid-use envelope. Provider usage evidence, its freshness, balance, or enablement, local request accounting, OAuth settlement, fallback order, and notification history never grant, revoke, or restrict that consent.

Because: A funded balance or enabled billing describes capability, not the person's permission to spend.
Not: Treating subscription login, provider-reported paid capacity, or a usage reading as permission to bill or as a gate on accepted paid use.

## ARCH-PROVIDERS-041: Paid-use envelopes are exact per profile, account, and mode

A paid-use envelope identifies the resolved auth profile, the provider, the stable credential instance, a versioned one-way digest of the account subject, and one mode, prepaid or automatic, which are independent and default off. A token refresh that keeps all of these keeps the envelope and its decision; a change to any of them is a different envelope with no decision. The consent authority stores no credential values, tokens, or raw account subjects.

Not: One profile-wide billing toggle, which collapses distinct providers, accounts, and modes into one unsafe grant.

## ARCH-PROVIDERS-042: One profile-local consent authority stores decisions only

Each auth profile holds one durable consent authority with an immutable incarnation and a monotonic revision. It stores only accepted or declined decisions keyed by envelope identity; unreviewed is the absence of a decision, and review need derives from positive current evidence plus an absent decision. One profile writer lock excludes concurrent mutations, and one atomic publication commits decision changes with the next revision.

Because: Storing evidence beside decisions creates parallel state that can preserve authorization after evidence or identity changed.
Not: Persisting an explicit unreviewed state or provider evidence in the consent authority.

## ARCH-PROVIDERS-043: Envelopes derive from verified identity and supported modes

Every paid mode that a provider declares as supported yields an envelope for every verified account with included quota. The envelopes derive from verified auth identity before any usage read and sort by account, then prepaid before automatic. Missing mode evidence is an explicit unknown value that is information only: it never restricts editing, acceptance, revocation, or admission.

## ARCH-PROVIDERS-044: Consent mutations are stale-safe and write only reviewed envelopes

A consent mutation binds the resolved profile, the account generation, the authority incarnation and revision, and the complete envelope set that the client saw, and it names the reviewed envelopes and the accepted subset. Under the profile writer lock, the runtime derives the set again and revalidates current credential identity before one atomic publication that updates only reviewed envelopes; any change rejects the whole mutation with no partial decision. Only the active profile is reviewed, and hidden sibling-account decisions stay unchanged.

## ARCH-PROVIDERS-045: Each request captures paid-use authorization once

Each provider request captures the durable consent decisions for its verified identities, without reading usage evidence, and binds each accepted authorization to its exact envelope, profile, authority incarnation, and revision. That capture governs the complete candidate walk or stream, and a later consent or policy change affects only the next request. A reused capture is a derived optimization, valid only while the consent-authority content and the verified account generation are unchanged; usage publications and evidence freshness never affect reuse.

## ARCH-PROVIDERS-046: Unconsented paid modes are skipped without new routing state

Paid subscription permission fails closed: a declined or unreviewed envelope skips only that exact mode before provider construction, creates no retry, suppression, or planner state, and does not change route order. Whether an accepted paid candidate can be served is the provider's decision, and a provider refusal follows the ordinary quota failover path with the provider's reason.

## ARCH-PROVIDERS-047: Allowance, affordability, and seat ceilings gate included candidates only

Included allowance, affordability checks, and profile-local pooled-seat ceilings can remove an included subscription candidate but never refuse an accepted prepaid or automatic candidate. A pooled-seat ceiling is included-only routing policy, not a consent decision or a monetary limit.

## ARCH-PROVIDERS-048: Explicit paid credentials bypass the consent authority

Direct API keys and aggregator credentials authorize paid paths by their presence and never enter the consent authority. Included subscription quota bypasses the consent gate. So does an external account that its engine explicitly classifies as usage-only. It routes as one metered candidate under its subscription account identity and derives no envelopes or questions. Its stored consent decisions remain. A plan name, billing platform, or missing allowance window never establishes that classification. Free-plan classification (PI-MODEL-038) is a separate exact-account eligibility fact that the provider's reported plan establishes. It removes the account from candidates and never routes it as metered.

## ARCH-PROVIDERS-049: A notification is never consent or admission authority

A notification presents a condition that another owner decides, such as auth attention, unsafe auth storage, or an unreviewed paid mode. Dismissing or resolving it never grants consent or changes request admission; those stay with their owning authorities, which derive the notification from their current state.

## ARCH-PROVIDERS-050: One profile Usage authority holds two independent evidence families

Each resolved auth profile owns exactly one durable Usage authority, separate from project event stores and provider availability state. It holds provider observations and an immutable Flywheel request ledger as separate evidence families that share one lifecycle but never derive, create, rewrite, or delete each other. Provider refresh runs independently of ledger append and recovery, and ledger settlement never invents or updates provider observations.

Because: Provider readings describe external allowance state, while the ledger records which candidate served each request; neither can stand in for the other.
Not: Using session-scoped request audit as the profile ledger, which cannot serve one cross-project timeline with profile lifecycle and range queries.

## ARCH-PROVIDERS-051: Evidence, local accounting, and invoices are separate authorities

Provider observations govern inspection, alerts, included-allowance evidence, and when to ask a paid-use question, but establish nothing for paid admission. The request ledger governs local accounting and budgets and estimates served usage without granting consent. The provider invoice remains authoritative for actual charges, discounts, taxes, and credits.

Because: Rate-card estimates cannot prove provider-side discounts, taxes, credits, or final charges.
Not: Treating local estimates as invoice authority.

## ARCH-PROVIDERS-052: Provider metric timing is exact or unavailable

Every normalized provider metric has a stable provider-local key, an explicit account or feature scope, and a deterministic rank; its display label is never identity. Its timing is exact half-open bounds only when provider-native fields determine both bounds without inference, and otherwise it is unavailable, which can keep a reset hint for display and routing but supports no quota accounting. Flywheel never infers a start bound from calendar boundaries, sampling time, reset cadence, labels, or earlier observations.

Because: A reset id or end instant does not establish a start, and a guessed window makes approximate timing look exact.
Not: Treating calendar months or reset hints as provider quota windows.

## ARCH-PROVIDERS-053: Quota windows have derived identity and never pool

A quota window's identity derives from the canonical provider account identity, metric scope, metric key, and exact bounds, and is never persisted as a parallel identity. Each current account-scoped window is reported independently: overlapping windows are never summed or reduced to one, sibling accounts never pool, and feature-scoped metrics stay visible observations outside whole-account accounting.

Not: Pooling usage across accounts or metric scopes.

## ARCH-PROVIDERS-054: Quota accounting reads only source-local included ledger entries

Local quota accounting for a window sums only immutable ledger entries of that exact source whose occurrence falls inside the window's bounds and that served included, subscription-equivalent use. It never subtracts provider balances, compares successive provider percentages, or reconciles against provider reports. When no exact current window or no readable ledger exists, accounting is explicitly unavailable, never zero.

Because: Provider balances and allowance deltas do not identify which Flywheel request incurred usage.
Not: Deriving request accounting from provider observations.

## ARCH-PROVIDERS-055: Ledger entries attribute their source and aggregate by canonical source

Each ledger entry records one provider attempt that may have been served. It carries its exact serving-candidate attribution or an explicit unattributed state, its spend mode, credential lineage, model, tokens, and price evidence. It classifies its value as subscription-equivalent or real spend. Each entry states its coverage as complete, partial with lower bounds, or unmeasured. A detail that the provider did not report is recorded as unreported, never as zero. A refusal before a response started has no entry. Aggregation groups by canonical source identity, so a credential replacement never splits one account window. Lineage stays for provenance only.

## ARCH-PROVIDERS-056: The profile ledger precedes its session mirror

Settlement first checkpoints the complete ledger draft in the session, then appends it to the exact profile ledger. It then publishes session usage and budget records with the checkpoint's retirement. Appends are idempotent by attempt, so an identical replay is a no-op and a differing entry conflicts. Startup replays interrupted checkpoints before new provider work. The pre-wire checkpoint is the attempt's complete unmeasured record. Recovery skips checkpoints whose attempt still runs in this process. One path settles every served model request. Session budgets and profile usage derive from that one entry, so the session is never a second ledger.
Because: A session mirror that could precede its ledger entry lets budgets and profile accounting disagree after a crash.

## ARCH-PROVIDERS-057: Usage authority changes are atomic and fail closed

Every usage authority migration runs in place as one transaction that commits or rolls back whole, preserves the authority's incarnation and existing rows, and fails closed on foreign, malformed, or newer versions. Each successful provider report replaces its snapshot, history sample, threshold state, and revision in one transaction, and a failed report keeps the last successful evidence and updates only failure and freshness state. A schema change keeps every structure that an admitted older writer of the same version still writes, because running processes stay pinned to their build across updates.

## ARCH-PROVIDERS-058: Quota, spend, and provider history are distinct reads

Exact-window account quota, explicit-range spend from the profile request ledger, and independently ranged provider-observation history are separate runtime reads, each with explicit unavailable states. No client treats one range as another's period or splices provider history into ledger accounting.

Because: A calendar month can cross several rolling provider windows or split one.
Not: One merged usage read that blends ledger spend with provider observations.

## ARCH-PROVIDERS-059: Profile observation work runs on fenced generations

The profile service pool owns one immutable generation per leased profile that captures its identity, accounts, readers, thresholds, credentials, and module composition. Same-account refreshes join within a process and are coordinated across processes by a profile-scoped lease, and generation and lease fences reject stale completions. Shutdown and profile deletion share one generation close.

## ARCH-PROVIDERS-060: Only interactive runtimes poll provider observations

Only the enabled Usage module in an interactive runtime polls provider observations. Headless and child runtimes still settle served requests into the ledger but never poll. Explicit auth refresh and provider admission refresh only the evidence they require. An ordinary check reads an account only when its evidence is stale. After a read that gave no evidence, an ordinary check waits a bounded back-off before it reads that account again. Disabling the module stops polling at once while already admitted work settles.
Because: Without the throttle, an account whose reads fail costs one provider read per model request.

## ARCH-PROVIDERS-061: Threshold alerts are observation state delivered once

Threshold crossings are provider-observation state in the profile usage authority. Alert delivery claims a pending alert, states the project notification through the composition's notify seam, and then completes the claim, so a crossing is delivered once across processes.

## ARCH-PROVIDERS-062: Reset credits stay inside the provider and Usage boundary

Banked reset credits are provider-observation evidence. Each provider contribution owns its optional reset consumer beside its usage reader. The generic Usage service captures that consumer for the exact account and never constructs one. A credit application targets an opaque account source and the reviewed authority incarnation and revision. The usage authority selects the exact credit and records a durable in-flight checkpoint before any provider call. It owns the provider idempotency key across uncertain results and ends with an observation refresh. Raw credit identifiers never enter the request ledger, spend accounting, or the client protocol.
Not: Predicting from usage readings or provider hints whether a limit can reset, because the provider's redeem outcome is the sole applicability authority.

## ARCH-PROVIDERS-063: Usage is persisted once, where it was performed

Request usage and cost persist only in the session or workflow auxiliary aggregate that performed the request, and roll up once: ancestor totals sum the direct totals of distinct eligible descendants, never intermediate subtree totals. Workflow budget policy counts its members and auxiliary usage but not nested subagents, while display totals include every descendant once. Historical usage without proven attribution stays an explicit residual, never reassigned, and unavailable prices, errors, and context-window observations stay visible and local to their session.

## ARCH-PROVIDERS-064: Session statistics derive from session records and owning projections

Session statistics cover the selected session and its immutable descendant ancestry across every profile that served them. They derive from session records and the owning tool-execution projection, copy no tool content, create no second accounting ledger, count each measured attempt and descendant once, and never backfill history.
