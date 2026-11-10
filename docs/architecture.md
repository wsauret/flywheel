# Flywheel Architecture

Current architecture for Flywheel's terminal and web clients: how the layers compose, where state lives, how chat, workflows, and delegated subagents run, and which extension points carry new behavior.

Intended architecture is a living authority indexed by `docs/architecture-intent/README.md`, with one file per domain.

`docs/elegance.md` is the elegance rubric that judges the architecture, and `docs/terminology.md` is the glossary of its terms.

Unbuilt workflow directions are plans, not architecture records, so this document does not describe them.

Current intended user behavior is a separate living authority indexed by `docs/product-intent/README.md`. Product intent defines what the product must do even when current code does not yet comply; architecture intent defines the architecture that implements it.

## The Experience

Flywheel is a terminal-native AI development environment. You open it in a repo and start in chat. Chat can answer directly, use tools, ask follow-up questions, and launch background workflows by content or path. Every slash command is a built-in command. Skills are agent methods: a person never types one, and no command menu lists one. A built-in command that needs a method, such as `/experiment design`, starts that skill's method as the chat's next turn. Workflows have no slash commands or command-menu entries.

The product separates agent sessions from workflow orchestration:

- **Chat** - a long-lived conversational session.
- **Workflow** - a durable non-session aggregate owned through its launching-chat invocation binding. Its control schedules logical nodes and concrete attempts.
- **Workflow agent** - an ordinary child session for one started attempt, directly under the launching chat, with immutable workflow membership.
- **Subagent** - a delegated durable child with its own conversation and run state.

Workflows and subagents open from parent activity rows, never catalog rows or terminal tabs. Completed workflows are read-only; follow-up conversation belongs in the parent chat. Subagents use shared child-session ownership, nested terminal viewers, hierarchical web selection, and runtime-admitted controls (ARCH-SESSIONS-010, ARCH-PROTOCOL-050). Navigation lists chats only. Historical inline subagent facts retain their existing presentation.

Each session contains one agent conversation. Workflow orchestration selects when its members run; each member uses ordinary session resources and inspection. A workflow owns run settings and control, not a transcript or a synthetic session row.

Delegated subagents use those same primitives in durable child sessions. They remain subordinate to a parent tool call, but each child has its own conversation, lifecycle, usage, recovery, and ordinary session inspection surface.

## Layers

The durable dependency direction is:

```text
infra <- workflows <- orchestration <- tui
```

`cli` is the composition root. It imports registration roots, config/auth setup, headless mode, and the TUI launcher.

**infra** owns shared foundations that import nothing from `src/`: event bus types, logging, path resolution, atomic/debounced writes, semantic runtime event schemas/projectors, output block models, formatting, handoff schemas, LLM model helpers, auth token helpers, and the JSONL debug-log sink.

**workflows** owns workflow domain logic: YAML workflow schemas and inline briefs, compilation into verified control, strict workflow-fact replay, the pure XState transition oracle, the VM host protocol, bounded attempt execution, deterministic queue projection, the context bundle of each agent, output contracts and their validation, and agent/persona definitions. It does not know about sessions, Solid stores, OpenTUI, or rendering.

**orchestration** owns application runtime behavior: config loading, model/tier resolution, agent runtime creation, chat and workflow controllers, session manager and persistence, plain typed session records, runners, worker callbacks, resilience/reconnect handling, transcript/budget wiring, and composer history paths. It does not use Solid or render JSX.

**tui** owns terminal rendering and input handling: shell wiring, hooks, keyboard handling, modals, prompt area, output window, block components, theme providers, and OpenTUI adapters. It reads derived state and calls orchestration actions; it should not own queue, session, or agent runtime domain logic.

## Process Placement

The source-layer direction above is one axis; physical placement is another (ARCH-RUNTIME-006). One `createRunnerHost()` composition serves chat, the agents of workflows, subagents, direct headless tasks, persona benchmarks, learning reviews, and title generation. Typed ports supply each caller's input, tools, capabilities, persistence, observers, and result contract.

```text
TUI placement

OpenTUI client (main thread)
  |
  | authenticated account attach, then RuntimeClient protocol
  v
Account service (`flywheel serve`)
  owns: sole public RuntimeProtocolRpc and UI sequence, control facade,
        account/control module services, account hub, dormant relay wake,
        project creation from a repository,
        passive history for sessions with activity: absent
  |
  +-> project state Worker
  |     owns: primary SQLite writer, SessionManager, ordered recovery,
  |           bounded asynchronous state read ports
  |
  +-> lower-priority project executor process
        owns: logical runner, providers, tools, workflow execution,
              live transcript tail, model resolution, asynchronous primary reads via state Worker,
              background-Worker conversation FTS for interactive recall and transcript search
        connects: private state, output, lifecycle, and tagged control channels

Headless placement

CLI process: headless chat
  hosts: full production project runtime with standard input and output as its client
  executes: chat, whose agent launches workflows through its ordinary tool

CLI process: direct task
  hosts: shared headless bootstrap, deadline controller, stderr progress writer,
         output contract, and the same runner host
  executes: one direct task
  receives: guardian and persistent-process clients from the CLI host
```

The account event loop never constructs or invokes runners, providers, tools, heavy work, or primary SQLite. Dormant factory references may remain in static function-bearing module descriptors; factories instantiate only for the descriptor's selected `account`, `control`, or `execution` host. The state Worker is the sole primary writer and generation-recovery authority. The executor's execution state opens no primary SQLite connection; its asynchronous read port supplies captured-position pages, content, and exact state queries. The executor's local writer lane buffers atomic writes over the private state port and is not a second writer. Its conversation search index is a private derived database with an atomic watermark and bounded catch-up position, not an index on the primary append path.

The account publishes one public sequence and rebases snapshots from private state and executor inputs. Readiness never resolves a serving profile. The account seeds each executor generation with its retained `pending | none | model` chat-default projection. The first public client subscription starts one owned deferred resolution; the mandatory private output subscription does not. Exact replacements publish on that channel, and output-gap repair adopts the executor snapshot before public invalidation. Click-time work still captures its profile and provider admission. A hard stop joins and fences the executor container, closes its generation, and completes domain recovery before explicit input starts a replacement. Ambiguous file cells remain, and recovery never replays tools. The executor inherits lower OS priority before payload start; Windows uses job ownership and background priority without processor-affinity or reserved-core claims.

Passive history for sessions whose account row reports `activity: absent` is the explicit normal-priority exception: the account service reuses the existing read-only history Worker off its event loop for ordinary reads and recovery after Stop or executor failure. One account-lifetime background client lends one lazy lease per project, without startup warming or a new OS process. Queries wait for recovery and use the existing durable session detail, workflow views, file-change summary, and registered module background snapshots. The history serves no transcript: every transcript read goes to the executor, which a paused project starts for it as it does for an open tab. Budget and status come from durable session detail, not invented live activity. The account captures the public position before the read awaits, and the control facade rebases the response. Selection and passive reads never restart execution. Any executor-published activity, including idle and awaiting-user, keeps reads on the executor so the live transcript tail and settlement state remain intact. The executor owns model resolution, providers, tools, FTS, project scanning, model queries, and execution writes. Interactive recall reuses its existing bounded background Worker and creates no Worker role or operational placement. Internal module descriptors and their factories remain co-located; this placement contract requires neither external plugins nor an import ban.

Each runtime-background Worker owns its process-local diagnostics stream. The account process initializes its Worker with the account home because that Worker can serve several projects; an executor initializes its Worker with the one project root it serves. Ordered shutdown rejects new project operations, settles accepted reads and FTS work, closes the diagnostics stream, and then releases the Worker runtime.

Headless chat hosts the full production project runtime in the CLI process, without a public listener or resident account service. Its agent launches workflows as an interactive chat does, under that headless chat. An unanswered question, including an Ask-mode workflow approval, produces an input-required outcome, never invented approval. A direct headless task keeps its explicit local composition in the CLI process. It uses shared bootstrap, ordered disposal, a deadline, stderr progress, and optional JSONL output. Its version 4 JSONL contract contains only `chat.*` records and one `chat.terminal` result. Standalone composition keeps control-host notifications available. `SessionManager`, conversation trees, and workflow facts remain their durable authorities.

Provider streaming stays beside the agent loop in executor and local headless placements. `TOOL_REGISTRY` and one request planner derive every provider-visible tool surface. The account-owned persistent-process manager remains the lifetime owner while the executor borrows its private client. Focused in-process tests use the same composition without process transport; this changes placement or transport, not runtime semantics.

Every new subagent dispatch atomically creates a durable child session, live direct-child link, immutable ancestry, and run binding before execution. The child records its prompt and complete instructions before slot acquisition, then runs in the same shared runner host as its parent. The child owns its conversation, execution and usage facts, lifecycle, scratch space, queued steering, and recovery. The parent owns the launching tool call, terminal result, and live link. Chat parents, parents that are agents of a workflow, and nested-subagent parents reconcile terminal child facts through one atomic result-and-notification path.

Live ownership and immutable ancestry are separate projections. Current workflow and subagent bindings authorize control, completion, and recursive deletion. SessionManager admits deletion and fences new publication; the executor awaits kind-owned settlement before state finalizes each leaf and then its parent. Historical ancestry never authorizes deletion. Planned replacement continues only work covered by its existing handoff authority, including retained deterministic launches and initialized children awaiting dispatch. Passive crash reconstruction executes nothing. Explicit Resume continues retained work; a person's interruption withdraws automatic continuation without deleting accepted input. Stop remains terminal on the parent's launching tool call. A parent agent controls the work that it started through the kernel `process` tool: one child-session control finds each child from its durable binding and routes its list row, status, interrupt, resume, and stop to the owner of the child's kind (`ModuleChildSession`). The `subagent` tool only dispatches, and `list_sessions` lists only the sessions that the agent did not start.

The subagent tool marks its execution as child-owned viewport work. Generalized reconciliation keeps the launching card and terminal result in the parent while the child's transcript and live output remain under the child session. The TUI opens linked children in nested viewers without tabs and traverses reciprocal live lineage through depth three. Web and phone clients select linked children through ordinary session navigation and preserve that selection in browser history. Both clients derive Steer, Interrupt, Resume, Stop, Delete, and settled read-only behavior from runtime-admitted actions. Historical inline runs retain their existing parent-card presentation.

The optional JSONL output is a closed, secret-safe machine contract derived from selected ephemeral runtime events, followed by one terminal record. It is process-attached and has no replay or durable sequence authority. It is not a projection (ARCH-PROTOCOL-061): `docs/terminology.md` reserves that term for deterministic folds over durable facts. SQLite facts remain the post-run authority.

Two consequences worth carrying into every other section of this doc:

- **"Reactive Dataflow" and "Session Infra and Derived Output" (Audit Module Stack layer 9) below describe executor-side dataflow until private output reaches the account sequencer.** The OpenTUI client is on the other side of the public `RuntimeClient` protocol; it never shares store identity with orchestration (ARCH-PROTOCOL-001). Where this doc says "the store" or "SessionStore" without qualification, that is runtime-side state, not something the TUI reads by reference.
- A TUI client that loses its account-service connection treats it as `reconnect_required` and rebuilds its view from fresh public runtime snapshots folded from authoritative SQLite facts and current executor output rather than trusting local state. The client surfaces this as workspace connection state (`create-workspace-connection-state.ts`) rather than a silent frozen UI.

## Audit Module Stack

The durable source-layer direction above is the rule for imports. For ground-up architecture audits, use the runtime/dataflow stack below. It starts at the raw LLM transport boundary and moves upward through the modules that depend on it.

```text
Provider APIs / filesystem / terminal
  -> auth, model metadata, access resolution, and profile-scoped Usage
  -> LLM transport and provider adapters
  -> internal LLM stream contract
  -> agent turn collection
  -> native tool runtime
  -> agent loop
  -> agent runner boundary
  -> chat/workflow runner adapters
  -> session infra and derived output
  -> workflow domain
  -> application controllers
  -> TUI shell and rendering
```

**0. Platform / External Substrate** is Bun, vendor SDKs, WebSocket/SSE streams, filesystem, terminal process, and credential storage. Audit timeout semantics, abort propagation, file IO durability, token refresh races, and Bun-native API usage.

**1. Auth, Model Metadata, and Access Resolution** owns credentials, access-provider selection, model family detection, model listing, context limits, output limits, and cost metadata. Key code lives in `src/infra/auth/`, `src/infra/llm/`, `src/orchestration/workflow-host/deps.ts`, `src/orchestration/agent-runtime/llm/client-factory.ts`, `src/orchestration/agent-runtime/llm/failover-client.ts`, and `src/orchestration/agent-runtime/llm/provider-availability.ts`. Audit single ownership of request admission, canonical candidate order, exact-account eligibility, strict failover boundaries, stale model metadata, and account/model mismatch handling.

Access-provider routing is automatic and universal: callers request a model and effort, never a provider, and every real request enters through `ModelClient.admitRequest()`. That boundary captures provider registry, credentials, exact-account eligibility, spend evidence, consent, allowance, fixed candidate order, and the account-bound availability view once. The returned admitted request is the sole planning and serving path; retries and failover cannot recapture policy or credentials. Candidate order is fixed by canonical spend class, numeric provider rank, the captured reset of each included account's declared expiring window, and captured account order: included subscription value, prepaid balance, automatic subscription spend, direct API spend, then aggregator spend. Catalog order is non-semantic.

`failover-client.ts` owns the admitted request's `run` callback walk. It scans the complete remaining canonical order before waiting on pending quota or service rechecks. It waits only when no candidate can serve now, then refreshes and rescans after an authority revision or lease deadline. Rejected candidates cause no client construction, probe claim, request preparation, audit opening, or provider I/O. A due recheck is claimed only after all read-only gates pass, and its fence is the only authority that can renew or conclude it. A candidate is left behind only on the named failover class, `FailoverFailure` in `provider-failure.ts`: spent quota, rate limiting, overload, an outage, or the account's refusal of the model or its extended window, after canonical work and accounting settle. The walk hands a refusal to the client's `recordModelRefusal` owner, which saves it through the model listing for the exact account generation and republishes eligibility. A failure the request or the account caused (a rejected request, an overflow, bad credentials, or an unclassified error) would repeat on every candidate, so the attempt that met it settles the request under that failure's own name and the walk never sees it. Local safety, preparation, authority, and durability failures remain strict, and cancellation stops the walk. Every prepared attempt records the exact provider and canonical account candidate that serves it.

Provider adapters are lazy and cached only by canonical account identity. Successful construction is shared and reused; rejected construction is evicted. Request admission, failover state, quota standing, and spend authorization remain request-local or authority-owned and never enter the adapter cache. `provider-availability.ts` is the process's single owner of routing quota state. It consumes current normalized profile observations without turning retained usage into fresh evidence. ChatGPT rate headers affect included mode only. Copilot finite, pooled, and unclassified observations retain their provider semantics; no reader guesses a per-seat finite allowance from a pool or an old row. Availability coordinates request-time suppression and provider service standing, while the profile Usage authority (ARCH-PROVIDERS-050) owns inspection history and freshness.

**1a. Profile-Scoped Usage** reads one protocol-v6 SQLite accounting authority per resolved auth profile. The `subscription-usage` module owns the optional inspection views, queries, refresh and reset actions, polling, and threshold notices. Accounting, provider admission evidence, and spend consent remain kernel authorities when the module is off. Separate provider-observation and immutable request-ledger families share the authority and lifecycle without deriving each other. Provider observations retain strict finite, pooled, or unclassified metrics, current readings, hourly history, freshness, alerts, and refresh coordination. The request ledger records every served request from the shared runtime path with exact candidate attribution, opaque auth-owned credential lineage distinct from account identity, tokens, and priced or unavailable evidence. Entries use UTC instants; current-month spend queries use local calendar boundaries. `usage.open`, `usage.accounts`, `usage.spend`, `usage.history`, and `usage.refresh` expose this authority through `RuntimeClient`. Refresh changes provider observations only. Usage shows Estimated billed spend and Included value separately, while provider invoices remain authoritative for actual charges. Key code lives in `src/infra/llm/usage-authority.ts`, `src/infra/llm/usage-entry.ts`, `src/orchestration/agent-runtime/usage-settlement.ts`, `src/orchestration/modules/subscription-usage/usage-projection.ts`, and `src/orchestration/modules/subscription-usage/protocol.ts`.

**2. LLM Transport / Provider Adapters** is the raw model API boundary: Anthropic, OpenAI, Google, Copilot, and ChatGPT WebSocket/SSE paths. Key code lives in `src/orchestration/agent-runtime/llm/anthropic.ts`, `openai.ts`, `google.ts`, `openai-completions.ts`, `copilot.ts`, and `chatgpt-adapter/`. Audit protocol correctness, stream event mapping, retries, watchdogs, provider quirks, cache controls, cost accounting, and abort behavior.

**3. Internal LLM Contract** normalizes providers into Flywheel's internal message, tool, and stream event model. The main contract is `LLMClient`, `Message`, `ContentBlock`, `ToolCall`, `StreamEvent`, and `StreamOptions` in `src/orchestration/agent-runtime/llm/types.ts`. Audit whether the contract is narrow enough, whether provider-specific leakage is justified, and whether event semantics are complete and stable.

**4. Assistant Turn Stream** drives one admitted request through `run` in `src/orchestration/agent-runtime/assistant-turn-stream.ts`. `assistant-turn-attempt.ts` owns one wire fold, exact attempt identity, audit, and observed usage. The agent loop supplies per-attempt tool and canonical-history settlement before accounting closure and replacement selection. Output streams immediately and tools execute eagerly; failed attempts retain actual work without replay or synthetic canonical continuation messages. Incomplete previews clear silently. Provider adapters and outer runners do not own retry loops. Audit settlement ordering, cancellation, partial history, and truthful candidate exhaustion.

**5. Native Tool Runtime** owns runtime tool definitions (input schema, prompt fields, execute handler), dispatch, policy checks, execution, output truncation, and tool result events. Key code lives in `src/orchestration/agent-runtime/agent-loop-tools.ts`, `src/orchestration/agent-runtime/tools/`, and `src/orchestration/agent-runtime/tools/tool-exposure-planner.ts` for per-turn visibility/execution. Display metadata (verbs, detail formatting, render hints) lives separately in `src/infra/tools/displays/<name>.ts` and is looked up at render time via `getToolDisplay(name)`. Audit tool isolation, write safety, concurrency assumptions, result truncation, schema clarity, and handoff-writing correctness.

**6. Agent Loop** is the core model/tool state machine. It owns context tracking, compaction, recovery, budget exhaustion, todo state, turn policy injections, and tool-based termination. Key code lives in `src/orchestration/agent-runtime/agent-loop.ts`, with per-turn assembly in `src/orchestration/agent-runtime/runtime-assembly.ts`, budget exhaustion in `src/orchestration/agent-runtime/budget-exhaust.ts`, and context-update emission in `src/orchestration/agent-runtime/context-token-anchor.ts`. Audit loop termination guarantees, context compaction invariants, hidden state, duplicate sources of truth, and recovery branches.

**7. Agent Runner Boundary** is the public runtime boundary used by the rest of Flywheel: `send`, `abort`, `interruptGeneration`, `done`, and conversation identity. Key code lives in `src/orchestration/agent-runtime/runner.ts`, `types.ts`, and `factory.ts`. The runner owns Effect lifecycle, phase, abort, interrupt, and `done` completion only; per-turn assembly delegates to `src/orchestration/agent-runtime/runtime-assembly.ts`. Provider `streamWithTools()` and `complete()` calls run in-process beside the agent loop that consumes them (ARCH-RUNTIME-006); no provider-call host process exists. Audit lifecycle ownership, abort/interrupt correctness, event emission, conversation persistence, and subagent cleanup.

**8. Runner Consumers: Chat and Workflow Worker Adapters** create runner contexts and apply different policies, prompts, handoff requirements, resume behavior, and message delivery. Key code lives in `src/orchestration/chat/session.ts`, `src/orchestration/workflow-host/agent-callback.ts`, , and `src/orchestration/runner/agent-turn.ts`. Audit shared versus divergent behavior, resume/retry semantics, connection-state handling, and turn policy boundaries.

**9. Session Infra and Derived Output** owns event bus subscribers, budget tracking, transcript writers, live output projection, throttled store sync, derived historical read paths, and cache artifacts. Key code lives in `src/orchestration/runner/output-session.ts`, `src/orchestration/session/`, and `src/infra/output/`. Audit event/store separation, ordered disposal, cache discardability, and output block projection correctness.

**10. Workflow Domain** owns compilation, control facts, strict replay, pure XState transitions, attempts, the async host protocol, handoffs, context, and deterministic views. `src/workflows/vm/` owns control; `src/workflows/run-facts.ts` defines run companions. The workflows module registers their readers and runtime contributions. Audit that `workflow:<workflowId>` is the sole run/control aggregate, run settings survive control-root replacement, and committed starts publish member sessions before execution. The host executes oracle commands and awaits settlement; it never selects transitions.

**11. Application Orchestration** owns session manager/store, the runtime supervisor and per-session chat actors, workflow controller, model selection, foreground/background sessions, and resume behavior. Key code lives in `src/orchestration/session-store/store.ts`, `src/orchestration/session/manager.ts`, `src/orchestration/app-service/runtime-supervisor.ts`, and `src/orchestration/workflow-host/controller.ts`. Audit lifecycle authority, active/inactive correctness, deferred chat persistence, foreground delivery paths, and resume behavior.

**12. TUI Shell and Presentation** owns OpenTUI/Solid shell wiring, hooks, keyboard handling, command dispatch, modals, output window, and block renderers. Key code lives in `src/tui/`, especially `src/tui/shell.tsx`. Audit that domain logic stays out of the UI, reactive derivations stay pure, text selection constraints are preserved, keyboard routing is coherent, and session views stay consistent.

The main contracts worth treating as audit boundaries are `StreamEvent`, `FlywheelEvent`, `RuntimeEvent`, `Agent`, `OutputBlock`, committed workflow control, VM proposals, the concrete-attempt queue projection, handoff payloads, and `SessionView`.

## Definition-Driven Workflows

Workflow behavior is data-driven:

- Reusable agent methods live in `src/agent-skills/<id>/SKILL.md`, and the shared references their bodies include live in `src/agent-skills/references/`. A brief composes a method by canonical id through `dependencies`.
- A chat agent writes a workflow file and launches it by content or path. The session's `scratch/workflows/` directory holds the launched copy. A workflow's `phases` run in order. A phase runs one agent, the named agents of `agents`, or one agent for each item of the list that `over` names, and a stream phase (`over: <phase>`) follows the phase over a list before it item by item; a `join` folds the agents' outputs through a named reducer, and `if` runs a phase only when an earlier phase completed or a field of its output is not empty. A `repeat` runs its own `phases` in rounds, `while` a field is not empty or once for `each` item of a list. Each phase of one agent, named agent, and phase over a list is an agent record: its inline `brief` or in-file `runs` reference, the persona that runs it (`persona`), and its policy. An optional `input` contract declares the structured launch input in the output field grammar, and `over: input.<field>` runs one agent for each item of one of its lists. A file in the step grammar before phases loads through the converter in `src/workflows/retired-step-grammar/`.
- `src/workflows/brief.ts` resolves only inline briefs. A phase or agent states `brief`, with `output`, `dependencies`, and `subagents` beside it. Another record reuses it through `runs: <name>`, which defaults to the record's id. Its brief id is `<workflowId>.<name>`. File-launch admission requires inline contracts. File verification also reads contract paths relative to the workflow file. `src/workflows/workflows/contracts/implementation-plan.json` serves only the retired conversion.
- `src/workflows/definition-registry.ts` builds one project's skill and persona owner and exports `createProjectDefinitionRegistry`. It loads bundled skill roots, external skill packages, and personas into immutable revisions. It holds no brief resources or workflow folders.
- Join reducers live in `src/workflows/reducers/`: `reducer.ts` holds the reducer contract, each reducer has its own file or a registry entry, and `registry.ts` is the one table of versioned pure reducers. Each reducer declares its parameters, their decoder, the load-time check of each field that a parameter names, and its output contract from its parameters, the contracts around the join, and the width, which compilation pins on the list or phase; a coverage reducer also projects its coverage from its output, and a selecting reducer projects what it kept and dropped. `collect.ts` and `coverage.ts` hold the reducers that summarize every slot, `dedupe.ts`, `top.ts`, and `quorum.ts` hold the selecting reducers, and `list-selection.ts` holds the list reading and the kept, dropped, and failed contract that `dedupe@1`, `dedupe@2`, and `top@1` share. The client words for a selection live once in `src/protocol/client/workflow-progress.ts`. A phase's `join` names a reducer by id, compilation pins its latest version, and `flywheel workflow reducers` lists each reducer with its parameters. A new reducer is a new registry entry or a new version, never an edit of a version that a running join pinned.
- Output contracts compile in `src/workflows/output-contract/`: the closed field grammar, the envelope, the citation check, the postamble, the generic renderer, and the `handoff.written` and `handoff.validated` facts. No registry or name joins a brief to its contract.

The compiler resolves a definition and worker contracts into verified control with logical nodes, attempts, dependencies, bounded policies, and definition identity. Control enters `workflow:<workflowId>` at publication. Raw XState derives transitions from committed control; definitions remain source material and workflow views remain projections.

## Sessions

Sessions contain agent conversations. A `sessionId` identifies one chat, subagent, or workflow-agent session. A `workflowId` identifies durable orchestration outside the session model. `workflowDefinitionId` records the definition that produced the run, never its runtime identity.

Sessions have three kinds:

- **Chat sessions** persist conversation history as a durable append-only tree projected from SQLite `chat.tree.created` and `chat.entries.appended` facts into `conversation:<conversationId>`, plus metrics and an optional `providerConversationId` provider-side continuation/cache token in session metadata facts. chat transcript is derived from the tree at read time.
- **Workflow-agent sessions** persist one attempt conversation and its execution, usage, lifecycle, local model choices, and immutable membership. Run settings and control remain in the workflow aggregate.
- **Subagent sessions** persist one or more bound subagent runs, a durable conversation tree, child-owned execution and usage facts, lifecycle, scratch space, queued messages, and recovery inputs. Each run binds to one parent session, dispatching conversation, and parent tool call before execution.

A session owns one conversation tree. Subagent runs reuse their child's tree; each started workflow attempt receives a separate member session and tree. Session detail, budget, status, and output use `sessionId`. Workflow control, run detail, views, and live membership use `workflowId`.

Session relationships have two meanings. Current workflow and subagent bindings authorize completion, control, settlement, and leaf-first deletion. Immutable creation, link, and adoption ancestry supports inspection and exact request accounting but never authorizes deletion. Adoption changes the live binding without rewriting the original launch. Independent forks survive parent deletion, and ancestry readers tolerate missing historical endpoints.

Current persisted session state is intentionally small:

```text
active <-> inactive
```

`active` means a live in-memory runner exists or is expected to exist in this process. `inactive` means there is no live runner; the session is history or resumable state on disk. Workflow completion, pause, failure, and crash recovery are represented by committed workflow-control facts plus session activity, not by adding more session states.

The `SessionManager` is the authority for persisted session state. On startup it recovers stale `active` sessions to `inactive`, because any previous process-local runner is gone. The `SessionStore` is the process-local runner pool and runtime projection: output blocks, cost, tokens, context percentage, model activity, connection state, and runner references live there while the session is active. The UI derives the current view from the store when present, otherwise from SQLite session metadata, budget, queue, chat tree, workflow facts, and derived history.

## Session Artifacts

Per-session runtime state lives in `.flywheel/flywheel.sqlite` as typed facts. `.flywheel/sessions/<sessionId>/` contains only the ephemeral `owner.pid` lock and the disposable `scratch/` workspace.

| Authority | Purpose |
|---|---|
| Session index projection (folds `session:<sessionId>` metadata facts) | Kind, label, lifecycle, conversation identity, local settings, direct parent, immutable workflow membership, and accounting ancestry. SessionManager owns session relationships; navigation lists chats only. |
| Conversation tree projection (folds `conversation:<conversationId>`) | One append-only conversation per session, projected from `chat.tree.created` and `chat.entries.appended`. It supplies canonical model context and transcript history for chats, subagents, and workflow agents. |
| Fork diff projection (folds `session.forked` facts from `session:<sessionId>`) | Fork branch points and diff bases projected from `session.forked` facts. Chat forks still copy the conversation tree (ARCH-SESSIONS-042), but the copied entry prefix and SQLite event prefix are durable typed facts. |
| `workflow:<workflowId>` fact stream | Run registration, settings, current launch binding, and control. Strict control replay owns the graph, attempts, frontier, charges, and outcome; run facts survive control-root replacement. No session row or persisted XState snapshot represents the run. |
| Workflow-view projection (folds `queue.*` companions from `workflow:<workflowId>`) | Deterministic attempt rows, status, ordering, retry provenance, and mutation explanations. Derived membership joins real session and history ids. Views never select execution. |
| Definition lineage projection (folds `definition.*` and `workflow.compiled` from `workflow:<workflowId>`) | Recorded definitions, briefs, semantic hashes, canonical request identity, and compiled phase shape. |
| File mutation facts (`file.changed`, `file.artifact.recorded`, and `file.mutation.*` from `session:<sessionId>`) | File mutations and tool-owned file snapshot artifacts. Write/edit tools record path, content hashes, previews, and tool/model causation here; file-mutation recovery and the diff-stat summary read them back. |
| Workflow context projection (folds `context.*` companions from `workflow:<workflowId>`) | Canonical input and accumulated context, including addressed direction and writer-owned handoff contracts. |
| Handoff projection (folds `handoff.written` and `handoff.validated` from `workflow:<workflowId>`) | Canonical payload, attempt identity, hash, preview, and validation issues. |
| `.flywheel/sessions/<sessionId>/owner.pid` | Ephemeral process lock. Not persisted state. |
| `.flywheel/sessions/<sessionId>/scratch/` | Disposable agent scratchpad workspace for scratch scripts and temp files. Not state: nothing projects from it, and it is deleted with the session. Startup maintenance removes each entry outside `notes/` that is larger than 100 MB and that nobody wrote to for 3 days. |
| `.flywheel/flywheel.sqlite` | Workspace event store for typed session/runtime facts and deterministic projections. Contains `event` (the durable fact log), `event_sequence` (per-aggregate append ordering), `tool_content` (session-scoped content-addressed ordinary text, immutable chunks, and manifest pages keyed `(session_id, sha256)`), and the conversation recall FTS index. Ordinary text above the inline threshold uses `{ sha256, bytes, preview }` references and commits with its referencing facts; readers verify exact text at hydration. Chunked evidence stages independently, and the writer proves its complete closure before committing a small referencing settlement. There is deliberately no `projection_checkpoint` or `projection_state` table: every projection in this table folds from the `event` log on read, so it cannot drift from that log. |
| `.flywheel/log/<timestamp>-<pid>-<threadId>-<uuid>.jsonl` | Global (cross-session) JSONL diagnostics stream, one file per writing thread of a process launch, shared by every session of the project and written by `infra/debug-log.ts`. `Log.*` calls (`infra/log.ts`) land here as `log.<level>` records. A thread opens its file at its first record that passes its tier, so a launch that records nothing leaves no file, and a Worker thread writes its own file beside its process's main thread. Each record is one synchronous, unfsynced write, so a record is in the file when the call returns, in call order, and only a host crash or a power loss can lose it; a record never makes its caller fail, and it is secret-redacted. A writer rolls to a new file at 64 MiB. Retention runs in the background after a file opens, never removes the newest file of each thread of a running process, deletes other files 7 days after their last write, and then deletes them oldest first until the directory holds at most 512 MiB and 256 files. The byte budget is eight times the roll size, so while fewer than eight writers run, the rest of the budget keeps closed files. A process that exited unexpectedly has its files renamed `*.unexpected-exit.jsonl`, and those go only after every ordinary file. A file written before 2026-09-23 has no thread id in its name, and retention reads all of that process's files as one writer. Raw `model.stream.*` telemetry and the workflow link breadcrumb live here, never message content. No behavioral path reads it. There is no per-session log mirror. See Diagnostics below. |
| Provider request audit projection (folds provider request audit facts from `session:<sessionId>`) | Session-lifetime request evidence: `prompt.assembled`, `tool_surface.selected`, `model.requested`, `model.request.dispatched`, `model.response_received`, `model.usage.recorded`, context-application facts, and `model.stream.summary.recorded`. Includes the system prompt body once per hash and durable conversation owner, tool schemas, omitted tools, message and prompt hashes plus the tree pointer used for reconstruction, provider-session and durable-conversation identities, cache/provider options, response identity, duration, failure outcome, usage, and aggregate thinking-stall evidence. Raw provider-wire, watchdog, and normalized stream events stay in the JSONL debug log and age out with log retention. |
| Subagent run projection (folds `child_run.*` and `subagent.*` facts from `session:<sessionId>`) | Inspectable subagent run view projected from `child_run.created`, `subagent.prompted`, and `subagent.completed` facts. `child_run.created` stamps `conversationId` beside `modelRequestId`, so recovery reads its own facts. Includes prompt, composed task instructions, tool scope, model, parent tool/model request causation, completion status, and result byte count/hash/preview. No transcript or handoff file pointer -- the result metadata is embedded in the completion fact. |

The session directory (`.flywheel/sessions/<sessionId>/`) contains only the ephemeral `owner.pid` lock and the disposable `scratch/` workspace (ARCH-SESSIONS-007). Everything else is in SQLite or the debug log, and the workspace event store at `.flywheel/flywheel.sqlite` survives session deletion. The `session-debugging` development skill holds the `events search` debugging flow over both sources.

```text
<projectRoot>/.flywheel/
  flywheel.sqlite                                              # project event store
  log/
    <timestamp>-<pid>-<threadId>-<uuid>.jsonl                  # diagnostics, one file per writing thread of a launch
    <timestamp>-<pid>-<threadId>-<uuid>.unexpected-exit.jsonl  # the same, kept for a process that exited unexpectedly
  sessions/<sessionId>/
    owner.pid                                                  # ephemeral process lock
    scratch/                                                   # disposable agent scratch
      notes/<conversationIdHex>/*.md                           # legacy notes, imported into the checkpoint on first use
```

Further per-session facts:

- Handoffs create no files. The workflow host records the handoff of each workflow agent as a `handoff.written` fact; a subagent's handoff is captured in memory by the dispatching runner, folded into the parent's completion notification, and recorded in the subagent completion fact.
- Ordinary tool text above `TOOL_CONTENT_INLINE_MAX_BYTES` (2048 bytes) is stored once per distinct text per session in `tool_content`. Readers hydrate its references to sha256-verified text at the read seams: the conversation fold, tool projections, nested-fact hydration, and the FTS insert. Smaller texts stay inline, and historical inline payloads remain readable.
- `session.intent.inherited` records, once in a subagent's publication batch, the approved design intent that the subagent inherits. `src/orchestration/session/child-session-publication.ts` writes it and `src/orchestration/session/conversation-checkpoint.ts` reads it. The subagent's system prompt renders it in the session tier, so no context reset removes it, and a subagent that the child dispatches inherits it when the child's own checkpoint holds no approved intent.
- A checkpoint write above 24,576 UTF-8 bytes is refused with its size and the limit (ARCH-SESSIONS-008). Legacy Markdown notes are imported verbatim into Working notes on first use, even when the conversion exceeds the limit, and are retained but no longer own working context.
- Startup maintenance records `idle scratch entry removed` with the session id, entry name, and bytes for each scratch entry it removes.

Store maintenance commands:

- `flywheel events maintain --prune-retired` deletes historical rows of the retired fact families and vacuums the store.
- `flywheel events maintain --prune-superseded` deletes the rows that a newer row of the same live value replaced, as the retention registry declares (ARCH-SUBSTRATE-025), then deletes ordinary tool text that no remaining fact references, keeps session-lifetime chunked-role nodes, and vacuums the store.
- `flywheel events maintain --dedup-tool-content` is the one-time, idempotent migration that rewrites historical inline tool text into content rows and references. It ends with a forced vacuum when it rewrote facts, because in-place rewrites leave page slack that the freelist threshold cannot see; run it at a quiet moment.

**In-flight state is not a fact** (ARCH-SUBSTRATE-024, ARCH-SUBSTRATE-037). A hold that only the writing process reads back stays in memory, such as the unfinished turn a runner streams. A hold that another process must finish goes in the `in_flight` companion table: `putInFlight` writes it when the operation begins, and an `inFlight` write that rides the append recording the outcome retires it. Neither goes in the log.

**Adding per-session state.** Agent working context uses the scoped checkpoint tools; every compactable runtime, including workflow agents, subagents, and learning reviews, holds all three tools and the checkpoint guidance, and a runtime without them stops at the context limit instead of compacting. Do not add files for state. A value that no projection replays goes to the debug log. Only a value that a projection, replay, resume, or recovery path reads back becomes durable: add a typed fact to its owner's `*-facts.ts` module and a projection in the owner's home that reads it from SQLite (see "Where New Code Lives"). Only session-owned kernel state uses `src/orchestration/session/` (ARCH-SUBSTRATE-005).

The shared file-publication boundary retains display evidence per accepted file. Its settlement facts name that evidence even when the final tool result cannot be saved. Results, checkpoints, and notices contain bounded metadata and references. TUI and webview Edit views, Session Changes, and Undo read paged file lists and byte windows rather than whole patches. A long line spans UTF-8 chunks; byte windows can split a character, and the shared reader reconstructs exact bytes without replacement characters. Missing or corrupt content shows "Change evidence is unavailable" without erasing file-change history. Exact Undo requires complete eligible evidence and endpoint checks; Git AI attribution receives exact settled before/after bytes, not display patches.

Chunked-role `tool_content` nodes remain for the session lifetime, including unsuccessful stages and indirect children. Ordinary text pruning does not remove them. Requested derived net patches share this content store and its reader, but do not become Undo authority. Distinct derived bytes add session-lifetime storage; identical bytes deduplicate. `clear_session` atomically deletes staged, applied, and derived content with the session deletion fact. There is no second byte owner, lifecycle store, or periodic tree collector. Skill and memory writes and journals remain domain-owned: only their display artifacts use this reference primitive, with no project mutation facts, Session Changes, or Undo.

Inline mutation evidence written before 2026-10-16 is normalized at the family recovery boundary. Remove this conversion after 2027-04-16. Normalization runs beside the writer before cross-process encoding, leaves historical facts immutable, and converts mutable finalized-result cells atomically. Unknown or malformed evidence remains immutable and produces a typed degraded gap or unavailable-evidence result, never empty history.

SQLite replacement is gated by measured writer failure, not speculation. The repeatable gate is `FLYWHEEL_EVENT_STORE_STRESS=1 bun test tests/integration/event-store-writer-inthread.test.ts`, which drives realistic high-volume payloads through the writer lane and asserts the load target: at least 5,000 facts/sec for 60 seconds, p95 commit ack latency <= 100ms, p99 <= 250ms, WAL <= 512MB, checkpoint <= 500ms, and no duplicate IDs or sequence gaps. Append-log-first ingestion or a non-SQLite dependency is justified only after that topology fails the numeric SLA after targeted fixes.

Resumable conversation history flows through the durable conversation tree, keyed `conversation:<conversationId>` (ARCH-SESSIONS-047). The same path serves chat and workflow workers: the runner reads the durable active branch via `walkContextBranchFromLeaf` and `buildSessionContext` (`src/orchestration/session/conversation/conversation-tree-context.ts`), which honors compaction reconstruction, omits `displayOnly` entries from the model-visible context, and rewrites branch summaries into virtual user messages. Chat mints a stable `conversationId` for its tree; `ChatSessionState` is the single authority for `providerConversationId` (the distinct provider-side continuation/cache identifier). Save points (`ConversationTreeWriter.flushSavePoint`) bound when in-turn writes become durable; `commitUserTurn` is durable before the provider request begins. The tree's batch append (`ConversationTreeStorage.appendEntries`) validates the full batch against a working index and commits it as one `chat.entries.appended` SQLite fact, with a `chat.reasoning.reported` fact in the same transaction when its assistant messages carry the reasoning tokens their provider reported, so a completed turn lands atomically. The count is its own fact because an earlier build's fold reads only the fact types it knows: that build still reads every entry. Fork is a publish-bounded primitive: the target tree facts are written and validated before the `session.created` and `session.forked` facts are appended, so a crash before publish leaves no listable session.

The rendered transcript is not read from an independent durable output index. Each agent's transcript folds its own conversation and execution facts. Workflow cards and headers read run/control projections separately. Live `OutputSession` mints output deltas for the owning session. No rendered-output cache facts are written.

Workspace preparation runs the workflows module's registered `workflow-agent-session-ownership` conversion after adoption. Each stored workflow converts transactionally into run registration and member sessions. Complete conversation, execution, auxiliary recovery, and content units move only with proven ownership; unreadable bytes and unallocated usage remain explicit. Imported resource identities retain scratch and note paths. Admitted deletions keep their target set, and a second open performs no conversion. The conversion does not invoke tools.

### Diagnostics

The rules that govern every diagnostic record are ARCH-RUNTIME-075 (no content), ARCH-RUNTIME-076 (one record per decision; per-call paths below the default level), ARCH-RUNTIME-077 (repeats coalesce), and ARCH-RUNTIME-078 (one registry decides each family's tier). The mechanics:

- `src/infra/diagnostics-registry.ts` is the registry. `DebugLog.record` drops a record whose type's tier does not reach the current level, and `bun run lint:diagnostics` fails when a producer writes a type that the registry does not declare or the registry declares a type that nobody writes. A thread therefore opens no file when nothing passes its tier.

| Tier | What earns it |
|---|---|
| INFO | One record per decision, state change, or finished unit of work. A projection replay from the start over a large event count also records at INFO, because a rebuild on every store change is the replay starvation it keeps visible. |
| Notable | A family whose record matters only when the work failed, stalled, or ran slow. Its producer marks those records `notable`, and only they reach the default level. `model.stream.completed`, the one record of a provider request, is notable. |
| DEBUG | Everything else: per call, request, stream event, token, read, store change, projection catch-up, and fact write. |

- `loggedOperation` and `loggedSyncOperation` in `src/infra/operation-log.ts` record `start` at DEBUG and one completion with its duration. Pass `level: "debug"` for a hot-path operation, or `slowMs` so that the completion reaches INFO only when it ran slow; `logCompletion` is the same pattern for a caller that times its own work. Pass `onFailure` to route repeating failures through a coalescer. An abort (`isAbortError`) records `interrupted` at the completion level, because an abort is an outcome; a failure records at ERROR, or at WARN with `failureLevel: "warn"` only when the caller recovers on its own.
- `coalesceRepeats` in `src/infra/repeat-coalescer.ts` is the one coalescing mechanism in a process. Its users include event loop stalls, relay control channel interruptions, executor channel detach episodes, failed queries of a lost connection, a background read that fails the same way on every read, a contained floating abort, an unanswered guardian identity probe, an emptying of a command's container that does not settle, a session message sent again to the same recipient within 30 seconds, and a terminal transcript whose reading position fights the person's scrolling or whose rows keep unmounting before their heights reach the height index (`src/tui/output-window/output-window-scroll-anomalies.ts`). A parked account service lane counts across processes in its durable records instead (ARCH-RUNTIME-042).
- `recordBackgroundFailure` records work that nothing awaits: once at WARN with its detail, at ERROR for an `InvariantViolation`, and at DEBUG for an abort. Only aborts are contained (ARCH-RUNTIME-030), so every floating promise that can reject with anything else needs a handler.
- `relayProcessDiagnostic` writes a record relayed from another process, such as a guardian's or an executor's termination decision, with its own level and fields and its writer's time as `sourceTs`, never as a text field that holds a serialized record (ARCH-TOOLS-037).
- Prefer one summary record per request over per-event records: `model.stream.summary.recorded` carries the stream gap analysis that the per-event family would otherwise be read for.
- The sink warns when an INFO or notable family crosses `HIGH_VOLUME_TYPE_RECORDS` in one launch, because call rate is not statically knowable. That warning is a defect in the tier.
- `FLYWHEEL_LOG_LEVEL=DEBUG` turns on `log.debug` records and every DEBUG-tier and notable-tier family at once.
- The outbound event queue tracks its high-water mark passively whenever a frame is offered and warns `runtime event queue heavy load` once at 1,000 and once at 1,500 queued frames per connection, with depth, high-water mark, capacity, remaining capacity, and time since subscription. The subscribed, heavy-load, overflow, and unsubscribed records share a `streamId`, and the unsubscribed record keeps the lifetime high-water mark and the headroom at that peak. Queue capacity counts frames, not bytes; remeasure frame sizes and retained memory before raising it.
- `tests/integration/local/diagnostics-volume-budget.test.ts` runs an account service with an open project and a fixture provider. After startup it must write no record for a minute; the first scripted turn, with tool calls and a pasted message, must stay under its byte budget and carry none of the pasted text; a later turn with eight tool calls must write exactly the records the test allows a turn, and no more records or bytes than the first turn.

## Agent Runtime

Flywheel has one logical agent runtime contract with multiple process placements. There is no provider registry, runtime registry, selectable execution backend, or user-facing backend selector. The composition root builds an `AgentFactory` from config/auth dependencies, and orchestration passes that factory wherever model work can occur.

```ts
interface AgentFactory {
  (options: AgentOptions): Agent
}

interface Agent {
  send(text: string): void
  end(): void
  abort(): void
  interruptGeneration?(): boolean
  readonly done: Promise<AgentRunResult>
}
```

Each open project runs in three placements (ARCH-RUNTIME-006). The account process owns the public protocol, control, and passive history reads. One state Worker owns the primary store, session lifecycle, ordered writes, and recovery, and it is the only primary writer (ARCH-SUBSTRATE-018). One lower-priority executor process owns the runner host, providers, tools, and transcripts. `SessionManager` remains the authority for `active`/`inactive`.

Provider `streamWithTools()` and `complete()` calls execute in-process beside the agent loop that consumes them; there is no spawned provider-call host.

The runtime resolves access per request, exposes native tools, and emits raw events. Chats, subagents, and workflow agents use session-owned durable conversation context. Ephemeral auxiliary calls can use an in-process cache, never as durable history. The agent loop receives assembled messages rather than owning conversation persistence (ARCH-RUNTIME-002, ARCH-SESSIONS-002).

`Agent` wraps raw runners so orchestration talks to a stable boundary: `send`, `abort`, `end`, `interrupt`, and `done`.

Every model request is attributable. `src/orchestration/agent-runtime/llm/provider-request-audit.ts` records the replayable request boundary as session facts: assembled prompt, selected tool surface, model request metadata, aggregate stream summary, provider response identity, duration, failure outcome, and usage. Raw provider, watchdog, and normalized stream observations go only to the retention-bounded JSONL debug log. `events search` presents both sources on one debugging timeline, while reconstruction, cache analysis, usage accounting, and workflow efficiency read only SQLite facts. The per-turn tool surface is decided by `src/orchestration/agent-runtime/tools/tool-exposure-planner.ts`, which returns a plan with `visible`, `executable`, and `omitted: [{ name, reason }]` so the audit records can name what the model saw and why anything was dropped. Background work tracked during a chat turn goes through `src/orchestration/agent-runtime/background-work.ts`. The registry is runtime-only - any model-visible result derived from a notification flows through durable channels: SQLite chat tree facts, SQLite session runtime facts, and SQLite subagent run facts.

## Chat Flow

When the TUI starts, `FlywheelShell` starts a chat. Every start opens a new chat, and the runtime records it when it opens, so the catalog can list it. The runtime removes an empty chat when its tab closes or when a stop finds that no client holds its project, so opening and closing an unused chat does not leave an orphaned session record. A stop that a client holds the project through keeps the empty chat for the tab that attaches it again (ARCH-RUNTIME-024).

On a chat message:

1. `useCommands` (`src/tui/hooks/use-commands.ts`) handles slash commands first through `dispatchSlashCommand`. Non-command text goes to the active chat as a `session.send` dispatch on `RuntimeClient`.
2. In the project's executor process, the chat mutation handler (`src/orchestration/app-service/chat-mutations.ts`) routes the mutation to the runtime supervisor, which activates the session when needed and serializes the send through the per-session actor mailbox (`runtime-supervisor.ts`, `session-runtime-actor.ts`). The chat persists on first send.
3. The actor ensures a `ChatRunner` via `createChatRunner` (`src/orchestration/chat/runner.ts`), which composes the environment (config, auth, model, session infrastructure, output wiring, and the `ConversationTreeWriter` rooted at this chat's `conversation:<conversationId>` tree) and returns the single session owner from `createChatSession` (`src/orchestration/chat/session.ts`).
4. That owner reconstructs the model-visible message history from the durable tree via `walkContextBranchFromLeaf` and `buildSessionContext`, creates an agent runner through `Agent` with those messages as resume context, and wires events into `OutputSession`. `commitUserTurn` durably appends the new user entry before the provider request starts; assistant and tool_result entries buffer through `enqueueMessage` and land together on `flushSavePoint` at turn boundary.
5. `OutputSession` parses/dispatches agent events into output blocks, then schedules a throttled store sync.
6. `runAgentTurn()` and resilience handling reconnect transient stream failures, surface provider failures, and reset connection state.
7. On disposal, the chat runner awaits a final `flushSavePoint` so no in-flight save-point batch is lost.

Chat sessions answer questions and launch workflows through the admitted workflow tool. SessionManager atomically publishes run registration, the parent invocation, and the current binding before execution. Launches retain host-attested evidence and Ask confirmation. The terminal keeps the parent foreground; a web workflow screen keeps the launching chat served.

## Workflow Flow

When a chat agent writes and launches a workflow:

1. **Tool dispatch** - the chat calls the workflow tool with content or a file path. Content is saved in the session's `scratch/workflows/` directory. A path outside that directory is copied there. The tool admits the saved file.
2. **Dependency preparation** - `prepareWorkflowDeps()` loads config, resolves auth, creates the agent runner factory, and lists available models.
3. **Compile and publish** - `prepareWorkflowLaunch()` compiles the definition. The writer atomically publishes run registration and settings, the parent invocation and binding, request seed, and initialized control. It creates no workflow session.
4. **Runner setup** - the executor's workflow-host collection owns the run's transient host outside SessionStore. Run bookkeeping resources remain distinct from each member's execution resources.
5. **Host setup** - orchestration supplies the worker callback and other boundary dependencies to `createWorkflowVmHost()`. This is the one async host for the workflow. The host owns interruption, waiting, commits, and ordered disposal; it does not choose transitions. Its control surface returns Promises and typed failures, and the owning resource `Scope` stays in orchestration.
6. **Strict preflight** - the host strictly replays `workflow:<workflowId>`, checks definition identity, reconstructs XState control, and derives views and context. No persisted queue or machine snapshot is authority.
7. **Drive and commit** - the oracle returns declarative commands. The host commits complete batches and starts every admitted ready attempt through existing workers. Each result commits separately through the expected-sequence boundary. Conflict handling replays committed facts.
8. **Parent settlement** - paused control leaves the parent call pending. Completion remains owed until parent reconciliation acknowledges its durable result and notification admission. Stop records its result before teardown. Ownership, recovery, Stop, and deletion also apply to zero-agent workflows.

## Attempt Lifecycle

A concrete attempt of an agent runs in this order:

1. **Replay** - strict replay folds the SQLite workflow facts into committed control. Raw XState reconstructs an in-memory snapshot from that control; no machine snapshot or attempt list is loaded as authority.
2. **Select** - the pure transition oracle verifies readiness and emits a declarative prepare-attempt command for one concrete attempt. Dependency release, conditions, repeats, retries, reassessment, and terminal propagation are deterministic control decisions.
3. **Commit start** - the structural publication authority validates the run's current launching chat and deletion fence. One guarded transaction commits attempt control, an ordinary workflow-agent session with immutable membership, its conversation, the direct chat child link, and explicit local settings if present. Only then can the worker attach resources or start provider work.
4. **Assemble request** - the attempt runner reads the agent's resolved brief and compiled output contract and calls the context projection's `getContext()` with the attempt's recipient scope: the workflow scope, or an item of a list with the shared bundle that its list froze. It renders the context bundle in `src/workflows/context-bundle/`: exactly one user-request section, the immediate transient handoff as `## Output of the Phase Before` when present, and the live durable artifact index as `## Inherited Artifacts` after writer-declared supersession. It enriches the combined handoff bodies once, then assembles the brief, scaffolding, handoff guidance, and optional chat context. Each handoff and artifact body shows every stored field, which `src/workflows/output-contract/render.ts` formats without decoding the payload again.
5. **Run worker** - the existing attempt runner attaches resources under the committed member session id. It owns that member's event lane, conversation writer, budget, output, background work, and status. It returns a typed outcome without workflow-control authority and never enters subagent slot admission.
6. **Validate outcome** - the attempt boundary captures and validates the handoff, classifies failures, and converts an accepted reassessment handoff into a typed proposal over read-only committed control. The outcome remains uncommitted evidence at this stage.
7. **Propose next control** - the pure oracle accepts or rejects the typed outcome. It deterministically applies list expansion, repeat rounds, authored retry control, reassessment, frontier changes, or terminal propagation. A worker never selects the corresponding XState event or applies these changes.
8. **Commit completion companions** - one atomic SQLite batch contains the attempt outcome and control semantics, handoff write and validation facts, exactly one successful-handoff `context.accumulated` fact with the writer's pinned transient/durable contracts, newly flattened workflow-view-projection facts, and the terminal `workflow.control.committed` marker. The context projection derives durable supersession and immediate-edge relay from that fact. Proposed state and workflow-view rows stay invisible until the complete batch commits.
9. **Continue from committed state** - the host feeds the commit acknowledgement back to the oracle, publishes the committed projection changes, and requests the next legal command. Resume uses the same strict replay path and preserves committed conversation history without rerunning committed tool results.

## Reactive Dataflow

Agent output enters the system as normalized raw facts and events, and crosses the process/thread boundary from "Process Placement" above partway through. The runtime-side half:

```text
Agent (in the runtime worker)
  -> Agent
  -> EventBus events
  -> OutputSession
  -> StructuredOutputBuilder (mints a typed OutputBlockChange at the write site -- upsert or
     append-content -- instead of diffing snapshots; rare structural rewrites degrade to a
     `fullResync` flag rather than reindexing)
  -> SessionStore (this process's per-session entries; runtime-side state only)
  -> app-service output projection (drains the write-site changes and projects them into
     wire form)
  -> shipped-output owner (holds the copy of each block and streaming entry the session's
     clients last received, measures each change against it, and publishes one
     `output.delta` of drops, edits, and whole blocks on the session's output cursor via the
     shared RuntimeUiPatchSequencer -- the same mint+broadcast path session-summary patches
     use; the kept-command output projection ships through the same owner, and the
     owner serves each output read, since a read can run ahead of the deltas)
```

Then the wire hop -- the `RuntimeClient` protocol over the worker channel -- carries the sequenced, cursor-tagged patch to the OpenTUI client, where the client-side half picks up:

```text
shared family intake, bound by create-ordered-patch-receiver or by the session
  reading family (per-cursor gap tracking; holds and replays out-of-order patches;
  requests a bounded resync window on a detected gap)
  -> transcript store intake / per-session caches
  -> frontend projection / shell-state derived memos
  -> OpenTUI components
```

`OutputSession` is shared by chat and workflow rendering. Worker output, tool calls, subagents, budget updates, and queue lifecycle events render through the same output stream. Output deltas are minted once, at the point of write, and only sequenced/coordinate-shifted/published downstream -- no layer between the builder and the wire reconstructs a delta by comparing two full snapshots.

The event bus is for cross-cutting infrastructure and lifecycle notifications:

```text
EventBus
  -> SessionFactWriter
  -> SessionBudgetStore (SQLite budget projection)
  -> SessionEventAdapter
  -> stream observers
  -> queue lifecycle subscribers
```

The store is for state the UI reads. Event subscribers compute derived runtime projections, then mutate the store. The frontend projection is an explicit coalescing contract: telemetry-only facts do not emit snapshot changes unless they alter UI-visible metrics, and burst catch-up is rate-limited before OpenTUI sees invalidations. The TUI reads `SessionView` derived from the live store or persisted SQLite facts/projections; the rendered transcript is folded from source facts before any cache is trusted. Runner hosts never bypass this path with presentation-filtered UI updates.

Workflow rows follow the same runtime protocol without becoming control state:

```text
SQLite workflow fact batch
  -> strict committed-control replay
  -> flattenWorkflowView (logical nodes and concrete attempts -> deterministic rows)
  -> SQLite queue projection
  -> workflow view and live projections
  -> RuntimeClient snapshot/patch
  -> TUI store and OpenTUI components
```

The row order, derived status, mutation explanation, and compatibility queue cursor are inspection data. They cannot select a transition or survive as a second recovery substrate. Model and effort overlays are runtime-only presentation data; the committed attempt and its definition provenance remain the source for every row.

## Context and Isolation

Flywheel uses three workflow isolation tiers:

- **Control oracle** - raw XState is a synchronous, pure transition function over strictly replayed committed control and a typed event. It verifies legality and returns declarative commands. It performs no I/O.
- **Async host** - one `createWorkflowVmHost()` instance owns bounded command execution, worker interruption, atomic SQLite publication, conflict replay, and ordered disposal of the resources orchestration acquires in its `Scope`. It executes oracle commands but never chooses a transition.
- **Worker** - an autonomous agent runner receives one bounded concrete-attempt request and returns one typed outcome. Reviewer, implementer, and explorer subagents are worker tools. Workers have no queue, transition, or persistence authority.

Continuity across attempts comes from structured handoff facts and context projections, not a shared conversation. Each attempt session owns one tree. Overflow and failed-run reopen create continuation attempts and sessions with recorded charge lineage. Earlier sessions remain history and add no logical agents to progress. Historical follow-up sessions remain readable, but completed workflows admit no new follow-up turns.

Direct session messages reach only their recipient, including a parent's reply. Workflow-target direction retains whole, item, or named-agent coverage. Peer workflow information retains one-reader delivery; it is not direction. A workflow is not an answering agent and admits no reply wait. Typed work dependencies let parent waits account for workflow members without treating the workflow as a session.

Each request has one durable accounting owner: its performing session or workflow auxiliary aggregate. Workflow token policy includes members and auxiliary usage, excluding nested subagents; display totals include descendants once. Unallocated historical usage remains an explicit residual. Workflow-agent identity and scratch guidance occupy the conversation prompt tier, preserving the shared stable/session prefix and first-request prefix hold.

## Skill Packages

A skill package is authored instructions for one class of work: a directory holding `SKILL.md` (YAML frontmatter plus body) and optional support files. Packages are context, not control. Loading one runs nothing and changes no state; the caller that loaded it does the work.

Ownership follows the layer direction:

```text
src/workflows/skill-source-inventory.ts          the bundled agent-skill root and the bundled source kinds
src/workflows/skill-schema.ts                    package shape, frontmatter normalization, immutable revisions and derived corpus views
src/workflows/skills.ts                          discovery across roots, precedence, admission
src/workflows/skill-context.ts                   resource declaration and reads
src/workflows/skill-render.ts                    canonical rendering, dependency composition
src/workflows/definition-registry.ts             the published registry revision and its reload
src/orchestration/app-service/definition-root-watcher.ts      watches installed roots and publishes one debounced atomic reload; optional owner reconciliation runs through its admitted callback
src/orchestration/agent-runtime/tools/skill.ts    the model's read-only load/resource tool
src/infra/tools/displays/skill.ts                 that tool's display identity
```

Sources rank highest precedence first: project and account Flywheel stores, the cross-harness `~/.agents/skills` store, then Flywheel's bundled roots. Reusable agent methods come from `src/agent-skills/`, and installed modules add their definition bundles. The generated build manifest carries the agent root and its flat reference namespace into the binary. The first external source that holds a package id wins over its bundled package, and the loser stays visible as shadowed provenance in the rendered header. A malformed external package is skipped with a warning because it is untrusted user input; a malformed bundled package throws because it is a build bug. Source-root kind derives core-corpus membership but never changes package identity.

Three callers reach a package, and all three render the same canonical context: a provenance header carrying id, version, source, body sha256, byte count, declared resources, and related ids, followed by the body byte-for-byte.

| Caller | Path | Selection |
|---|---|---|
| Model | `src/orchestration/agent-runtime/tools/skill.ts`, granted per turn by `src/orchestration/agent-runtime/tools/tool-exposure-planner.ts` | The model reads the complete trigger catalog in its prompt guidelines, then calls `load` or `resource`. The tool reads the registry accessor on every call, so a reload that lands mid-turn is observable without a new exposure plan. |
| Definition | `src/workflows/context-bundle/prompt-assembly.ts` for the agents of a workflow, `src/orchestration/modules/subagents/execution/tool.ts` for personas | A brief's `dependencies` and a persona's `requiredSkills` compose the declared packages in declaration order ahead of the definition's own instructions, from one revision the caller passes: `src/orchestration/workflow-host/factory.ts` reads the registry once per workflow run and hands the same revision to the attempt runner and to every worker runner, so no deterministic composition reads the live registry. A brief that names an uninstalled package is a startup definition error, `src/workflows/vm/definition-identity.ts` pins the rendered-context hash of every package that an agent of the workflow requires, directly or through a persona that the agent can dispatch, so an edited package reports as drift, and a persona that names an uninstalled package fails the persona registry assembly in `src/workflows/agents/registry.ts`. |
| Command | A built-in command's handler, such as `/experiment design` in `src/orchestration/modules/experiments/experiment-command.ts`, calls the command session's `startMethod`, which resolves the skill through `skillMethod` in `src/orchestration/app-service/skill-method.ts` | The runtime resolves the skill from its own availability snapshot, renders the canonical context with the person's argument text, and commits it as the session's next chat turn under the command's label. A person never names a skill: the command does. |

The immutable revision also publishes the complete bundled corpus and derives the production core corpus from the agent-root packages; a module's definition bundle stays in the bundled corpus and out of the core. Its canonical core manifest and aggregate identity are revision views, not parallel runtime lists. Deterministic parity checks compare direct, persona, and workflow composition from source mode with one freshly built production executable.

Personas stay lean because of the second row: a reviewer carries its own short lens and declares the packages that lens needs, instead of shipping every project convention in its prompt.

Definition availability decides which skills and personas an agent is offered. One owner, `src/orchestration/app-service/definition-availability.ts`, derives it from two inputs: the module selection, and the agent types that `[subagents] disabled_types` turns off (ARCH-STRUCTURE-044). A persona whose type is off is unavailable, and so is a skill that declares one; a persona that only grants the type stays available without it. The subagent roster and dispatch, workflow launch and run-as, the skill catalog, and the model settings all read this owner. The `type:<id>` capability term holds exactly for the types that it offers, so text that needs a type renders only while that type is on (ARCH-CONTEXT-033).

Flywheel's canonical packages are not vendored exact-source packs. Pinned, byte-faithful third-party packs are planned work behind their own family-scoped loaders; those packs are immutable and pinned to an upstream commit. The registry described here admits Flywheel's own bundled packages plus whatever the user installs. Neither surface loads the other's catalog.

### Progressive Package Loading Evidence

Each row states one behavior of progressive package loading, the Flywheel surface that owns it, and the tests that hold it.

| Flywheel implementation | Executable evidence |
|---|---|
| The complete trigger catalog plus the scan-then-load rule in the tool's prompt guidelines (`src/orchestration/agent-runtime/tools/skill.ts`). The catalog has no category layer, caps each trigger, and advertises every installed skill, so the catalog is the discovery surface. | `tests/unit/orchestration/agent-runtime/tools/skill.test.ts` "advertises compact metadata and the scan-then-load rule, never a body", "advertises every installed skill, however large the roster"; `tests/unit/workflows/built-in-skills.test.ts` "advertises every installed skill's trigger line" |
| Exposure decides advertisement: `src/orchestration/agent-runtime/tools/tool-exposure-planner.ts` grants `skill` with its catalog only when the revision holds model-invocable packages, and records a typed omission reason otherwise. | `tests/unit/orchestration/agent-runtime/tools/tool-exposure-planner.test.ts` "omits skill when no skill registry is wired", "omits skill when every installed skill is model-disabled", "grants skill after allowlist filtering and advertises its roster" |
| One `skill` tool with the actions `load` and `resource`, declared read-only and concurrency-safe, with uncapped output because a package body is author-bounded text. | `tests/unit/orchestration/agent-runtime/tools/skill.test.ts` suites "skill tool loading" and "skill tool resources" |
| No listing action: the complete catalog is advertised in the system prompt and re-planned per request from the live registry, so a runtime listing tier would only repeat text already in context. An unknown `skill_id` error names candidate ids as the recovery. | `tests/unit/orchestration/agent-runtime/tools/skill.test.ts` "rejects an unknown action, including the retired list action", "reads the live registry on every call"; `tests/unit/workflows/built-in-skills.test.ts` "advertises every installed skill's trigger line" |
| Precedence resolves once at load, so a revision holds one package per id and records the shadowed source; `disable-model-invocation` keeps a package out of the model's catalog; resources come from a depth-bounded walk of contained regular files rather than fixed directory names; the load result carries source, version, sha256, byte count, and the declared resource list. | `tests/unit/workflows/definitions/skill-loader.test.ts` "prefers the first source on name collisions and records the shadowed source", "declares only contained regular files as resources"; `tests/unit/orchestration/agent-runtime/tools/skill.test.ts` "returns the canonical body with source, version, and content evidence", "reports an unknown skill id as a model-visible error", "never loads a model-disabled skill", "refuses an undeclared resource path", "refuses a declared resource that is too large to load whole"; `tests/unit/workflows/skill-context.test.ts` "rejects a declared file that became a symlink out of the package" |
| Package format: frontmatter `name`, `description`, and `version`, then a class-level procedure body rather than project-level notes. The format is normalized once at the boundary: recoverable variation is repaired and unknown frontmatter fields are ignored. | `tests/unit/workflows/definitions/skill-loader.test.ts` "normalizes metadata variation and ignores unknown frontmatter fields", "keeps the body verbatim and identifies it by sha256 and byte count"; `tests/unit/workflows/built-in-skills.test.ts` "installs exactly the canonical set", "advertises one concise unique trigger per package", "carries a substantial body behind every trigger" |
| No package publishes a slash command. A typed skill id, `/learned.<id>`, or a frontmatter alias is an unknown command in every client, and nothing is sent; frontmatter `user-invocable` and `aliases` are accepted and ignored. | `tests/unit/tui/commands/command-dispatch.test.ts` "answers a typed skill id, a learned skill, or a former skill alias as an unknown command, and sends nothing"; `webview/src/app/composer-submission.test.ts` "a typed skill id, a learned skill, or a former skill alias is an unknown command: refused, kept, and never sent" |
| No cache and no snapshot file. The watcher publishes each reload as one whole immutable revision, a reload that could not read a package the current revision holds keeps the last complete one, and one call observes one revision. | `tests/integration/orchestration/modules/learning/definition-reconciliation.test.ts` "publishes each reload as a whole new revision", "keeps the valid skills when a malformed package is installed", "keeps an installed skill when its SKILL.md is replaced with a malformed one", "coalesces a burst of file events into one reload"; `tests/unit/workflows/definitions/skill-loader.test.ts` "publishes a new immutable revision on reload", "keeps the published package when its SKILL.md is replaced with a malformed one" |

Whatever the caller, a loaded body is ordinary durable history rather than harness-private state: the skill tool returns the body with its sha256 as an ordinary tool result (`tests/unit/orchestration/agent-runtime/tools/skill.test.ts` "returns the canonical body with source, version, and content evidence"), and a recorded request reconstructs from the conversation alone (`tests/unit/orchestration/session/provider-request-audit-reconstruction.test.ts` "reconstructs verifiably after a later compaction (folds to the recorded leaf, not the live branch)"). The registry deliberately has no category taxonomy or focus-mode demotion, no snapshot cache, no usage counters, no organization mirrors, no stacked invocation, and no package writes: this tool is read-only by contract, and package generation is planned work outside this registry. Live verification of all three callers in the installed binary belongs to the release UAT pass, not to these tests.

## TUI Shell

`src/tui/shell.tsx` is a composition site. It creates shell state, modals, command dispatch, keyboard handling, prompt history, foreground switching, and header/output/prompt layout. The session store is runtime-side state; the shell reads protocol-fed session caches through `RuntimeClient`.

Important hooks and components:

- `shell-state` derives foreground chat data, output, pending questions, lifecycle, and held per-session domains for child viewers.
- `use-commands` routes slash commands and chat messages. Workflow launch is an agent tool call, not a client command.
- `use-chat-mode` dispatches chat interrupt, close, compaction, and question answers over `RuntimeClient`.
- Controls derive from held detail through `src/protocol/client/session-controls.ts`. Root chat Resume remains a key hint. A workflow card's header places its admitted Interrupt, Resume, or Restart and its Stop.
- `use-session-modal`, `create-dialog-modals`, and `use-help-dialog` own modal and dialog state.
- `create-keyboard-handler` owns global key handling.
- `OutputWindow` and block components render output blocks; individual block components should remain display-only.
- `ChildSessionBody` owns the ordinary child conversation surface, including status, transcript, composer, models, background actions, and nested children. Subagent and workflow-agent chrome compose that same body. Workflow modules supply the card, two-band header, Back origin, history selection, and forward-only agent navigation. Children ask their parent, not the person. Terminal Escape pops navigation without interrupting.
- The session picker lists chats only. Exact child ids resolve through detail and open the root chat plus nested viewers. Saved child routes retain only the leaf and reconstruct live ancestry.

The TUI does not mutate workflow control, workflow-view rows, or session persistence directly. It calls orchestration actions, and the store/view updates flow back through reactive data.

The shared web client follows the same ownership boundary. A linked child card selects the child's ordinary session instead of expanding child output inline. Session rows list chats only. The command panel uses the runtime-admitted actions of the selected child for Stop and Delete, offers no Close for a child, and keeps settled child sessions available for history. Browser and phone navigation record selected-session changes in the screen stack and browser history.

## Where New Code Lives

A new capability is a module unless it is kernel (`AGENTS.md` names the kernel). Each kind of code has one home; `bun run lint:module-containment` reconciles registries, canonical homes, imports, and owned vocabulary, while `bun run check:boundaries` enforces source-layer and client-host dependency direction.

Module protocol domains, queries, mutations, and row selectors -> `protocol/modules/<id>.ts`, registered in `protocol/modules.ts`
Module descriptor, runtime, process service, tools, projections, facts, and command handlers -> `orchestration/modules/<id>/`, registered in `orchestration/credential-provider-modules.ts` when the module claims a credential provider id, otherwise in `orchestration/modules.ts`
Module terminal strip and surfaces -> `tui/modules/<id>/`, registered in `tui/modules.ts`
Module web strip and surfaces -> `webview/src/modules/<id>/`, registered in `webview/src/modules.ts`
Web client host shells -> `webview/local/` for the page the runtime serves to a browser, `webview/editor/` for the shell the extension loads from the runtime's build, `webview/phone/` for the shell the phone's hosted bootstrap (`relay/app/`) loads from the machine through the relay; `webview/build.ts` builds every shell into `webview/dist/<host>/` and writes the client's one identity to `webview/dist/client.json` last, which the runtime reads once and every host page states; shapes that cross to a host built from another tree -> `src/protocol/client/host-contract.ts`, `src/protocol/client/editor-host.ts`, and the phone bootstrap's handoff in `src/protocol/modules/remote/phone-bootstrap.ts`; the device side of the relay that every relay-attached client shares (pairing, presence, wake, and the sealed attach) -> `src/protocol/modules/remote/relay-client.ts`, over the device store contract its host implements in `src/protocol/modules/remote/relay-device.ts`; the machine and project picker's shapes and states every client draws -> `src/protocol/modules/remote/machine-picker.ts`; the reader's place across a client reload -> `src/protocol/client/reading-state.ts`
Module fact families -> `orchestration/modules/<id>/facts.ts`, owned by the module in `src/infra/fact-retention-registry.ts` and prefixed as the descriptor declares
Workflow files -> the launching session's `scratch/workflows/`; briefs and launch contracts -> inline in that file
Output contract grammar, compiler, envelope, acceptance, rendering for later agents, and output facts -> `workflows/output-contract/`
Hooks -> `tui/hooks/`
Shared workflow utils -> `workflows/shared/`
Workflow VM control, facts, attempts, and projections -> `workflows/vm/` plus the workflow-view projection in `workflows/view/` and the context bundle of each agent in `workflows/context-bundle/`
Agent runtime tools -> `orchestration/agent-runtime/tools/`
Model metadata and benchmark tier readers -> `infra/llm/`; the `models` tool fetches Terminal-Bench 4.0 and BenchLM.ai only on demand, with a daily last-good cache at `<userDataRoot>/models/benchmark-tiers.json`. Exact slug joins and a small exception map replace curated model membership. Registered first-party catalogs define the recent-model comparison scope in `orchestration/config/model-score-scope.ts`. Benchmark data never enters a build asset or the prompt prefix.
Experiment loop state, policy, and settlement -> `orchestration/modules/experiments/`
Chat runner stack -> `orchestration/chat/`
Shared runner turn machinery (chat and workflow) -> `orchestration/runner/`
Durable learning stores, package publication, reviews, and reconciliation -> `orchestration/modules/learning/`
Workflow host wiring and agent callbacks -> `orchestration/workflow-host/`
Workflow run configuration, ownership contributions, passive reads, and conversion -> `orchestration/modules/workflows/`; run fact schemas -> `workflows/run-facts.ts`; workflow domains -> `protocol/modules/workflows.ts`
Workflow membership and atomic member publication -> `orchestration/session/workflow-membership.ts` and `orchestration/session/workflow-publication.ts`; membership shape -> `infra/session-workflow-membership.ts`
Shared child execution resources and imported legacy-note/scratch resolution -> `orchestration/session/child-execution-resources.ts` and `orchestration/session/conversation-resources.ts`
Ordinary child conversation body -> `tui/components/child-session-body.tsx` and `webview/src/app/conversation-body.tsx`; workflow header and navigation -> each client's workflows module home
Runtime session store (runner pool and runtime projection) -> `orchestration/session-store/`
Durable session facts and projections -> `orchestration/session/`
Conversation checkpoints, their versioned facts, and legacy-note conversion -> `orchestration/session/conversation-checkpoint.ts`, `orchestration/session/conversation-checkpoint-facts.ts`, and `orchestration/session/checkpoint-note-conversion.ts`
Module historical fact migrations -> `orchestration/modules/<id>/migrations/`, declared through the installed catalog
Kernel migration engine and kernel fact migrations -> `orchestration/migrations/`
Auth profile file conversions (a previous credential, preference, or catalog file shape) -> `infra/auth/`, beside the store that owns the file and composed by `infra/auth/auth-profile-normalization.ts`, each carrying its removal date
Auth profile conversions of a provider's own earlier stored state -> `orchestration/modules/provider-<id>/`, declared as the definition's `profileConversions` with their phase and run by `infra/auth/auth-profile-normalization.ts`, each carrying its removal date
Module client presence -> `tui/modules/<id>/` and `webview/src/modules/<id>/`, listed in `tui/modules.ts` and `webview/src/modules.ts`; declarative rows come from the module's protocol home
Module command-line verbs -> `orchestration/modules/<id>/cli/`, declared as the descriptor's `cli` contribution; `src/cli/subcommands.ts` types kernel nouns only
Module config sections -> `orchestration/modules/<id>/`, declared as the descriptor's `config` contribution and read through `configSection`; `src/orchestration/config/` composes them from the catalog and names none
Model providers -> `orchestration/modules/provider-<id>/` (definition, client factory, catalog fetch, OAuth flow, usage reader, affordability, allowance, settings); hosts compose the auth flag table, key check, login registry, and provider settings from definition fields and name no provider; the kernel materializes dynamic `[custom_providers]` entries in `orchestration/custom-provider-modules.ts`
Development tooling (the benchmark tool and service, Flywheel's own agent methods, the `flywheel dev` verbs) -> `orchestration/modules/development/`; `src/orchestration/development-modules.ts` lists it and only the source entry `scripts/source-cli.ts` installs that list, so `src/cli/index.ts` and every release never name it
Reusable agent methods -> `agent-skills/<id>/SKILL.md`
An agent method that only one module can run -> that module's definition bundle, `orchestration/modules/<module>/definitions/skills/<id>/SKILL.md`, declared as a `definitions` contribution of kind `bundle`; a release embeds every shipped bundle, so the method leaves with its module and its default still diffs

## Registration Patterns

Built-in definitions have one registration point for each domain. Consumers derive lookup tables, schemas, presentation, and behavior from these collections instead of maintaining parallel lists:

- Built-in TUI commands register in the collection returned by `buildCommandDefinitions()` in `src/tui/commands/command-definitions.ts`. Skills and workflows publish no command.
- Runtime event types register in `RUNTIME_EVENT_DEFINITIONS` in `src/infra/runtime-event-types.ts`. Event subscribers attach to the relevant event types after this collection defines their schemas, actors, and durable mappings.
- Settings register in `SETTING_DEFINITIONS` in `src/orchestration/config/setting-definitions.ts`; config schema fields, persistence behavior, and settings presentation derive from the definitions that apply to each consumer.
- Runtime configuration is decoded once into the immutable runtime config projection (ARCH-RUNTIME-056, ARCH-RUNTIME-057). One general watcher treats filesystem events as hints and rereads canonical bytes; subscribers own domain effects, request paths capture one revision, and safety-sensitive module admission and update activation still revalidate under their owning locks.
- Skills and personas load through `src/workflows/definition-registry.ts`. Workflow files load only through content or path launch, and each brief is inline. Account and project workflow folders do not load; their files remain unchanged, with one warning per folder.
- Agent tools register in `TOOL_REGISTRY` in `src/orchestration/agent-runtime/tools/tool-registry.ts`. The request planner derives provider schemas, prompt guidance, dispatch, code adaptation, and omission evidence from that inventory and the active typed surfaces. Display identity, detail extraction, and diff materialization remain a separate infra contract looked up by canonical tool name. Every registration's input schema root is one `type: "object"` schema; a union root (`oneOf`, `anyOf`, `allOf`) is banned because providers reject it, so variants are one flat object with a discriminating enum field.
- Skills load through one registry from reusable packages under `src/agent-skills/`, installed module bundles, and the external stores. No package publishes a slash command; model invocation and deterministic dependency composition are separate policies.
- First-party module contributions register in `CREDENTIAL_PROVIDER_MODULES` in `src/orchestration/credential-provider-modules.ts` when the module claims a credential provider id, and in `SHIPPED_OTHER_MODULES` in `src/orchestration/modules.ts` otherwise; `SHIPPED_MODULES` composes both, the auth actions read the credential provider registry alone, and the same descriptor catalog selects account, control, and execution hosts, and `accessProviderRegistry` derives provider definitions, factories, and optional provider-observation readers from one enabled composition.

Exhaustive consumer decisions remain switches where a discriminated union requires complete rendering or event handling, such as `SessionEventAdapter` and block rendering. Adding a definition can require an update to these consumers, but the switch is not a second registration point and must not contain domain policy.

## Design Constraints

- **SQLite facts are the workflow ledger.** They are the only durable publication authority and the only replay source. Owned workflow facts parse strictly; no persisted queue object, VM snapshot, provider conversation, or worker-local state can replace them. A named startup migration may rewrite a known staged fact representation in one transaction when invalidation would destroy user work; it appends the typed fact that states the semantic adoption, and that appended fact, never the rewrite, is what changes replay.
- **Raw XState is the pure transition oracle.** It receives committed control and one typed event, verifies the legal transition, and returns a declarative command or fact proposal. It performs no I/O and Effect never selects an event or transition.
- **One async host owns workflow lifecycle.** One `createWorkflowVmHost()` instance executes declarative commands, awaits atomic commits and bounded workers, handles interruption and conflicts, and disposes resources in order. Effect interrupts the in-flight worker; the host awaits that worker's settlement before any later finalizer runs.
- **Attempt boundaries are atomic.** Attempt start commits running control and its projection companions before worker execution. Attempt completion commits control, handoff, context, workflow-view-projection, and outcome companions as one batch before publication.
- **Workers are bounded and persistence-free.** A worker receives one concrete-attempt request and returns one typed outcome. It cannot advance control, mutate workflow-view rows, write workflow facts, or dispatch another attempt.
- **Queue rows are a deterministic projection.** Every row derives from a committed concrete attempt and is consumed through the existing runtime snapshot/patch protocol. Row order, status, cursor, and ephemeral model/effort overlays are presentation data, not workflow authority.
- **The rendered transcript is derived.** Each agent's transcript folds its own session conversation and execution facts. Workflow views supply the card and header, not a second conversation reader. No rendered-output cache facts are written.
- **Session manager owns persisted lifecycle.** The store is runtime projection; the manager owns `active` and `inactive`.
- **Events are notifications; stores are UI state.** If the UI reads it, project it into the store. If independent infrastructure reacts to it, emit an event.
- **Handoffs are the contract between agents.** They are validated, persisted, and used for evaluation, context bundles, and the workflow result delivered to its parent.
- **Skills are context, not control.** A package is instructions the model or a definition loads. It cannot advance workflow control, mutate workflow-view rows, or write facts, and loading one activates nothing.
- **One logical agent runtime and runner host.** Every agent invocation uses `createRunnerHost()` with typed caller ports. Interactive production separates account control, the sole state Worker, and a lower-priority executor process; production headless runtime work retains its local CLI composition; focused tests may substitute placement or transport only.
- **Options-object DI keeps seams testable.** Runners, the workflow host, persistence, workers, and model/auth resolution accept dependencies rather than importing high-level concretions.
- **Disposal is ordered.** Runners stop, output/budget/transcript writers flush, and handles close through centralized resource cleanup.
- **File size is enforced.** `scripts/check-file-sizes.ts` runs as part of `bun run lint` and fails on any `.ts`/`.tsx` file in `src/` or `tests/` over 600 lines of code; blank and comment lines do not count. Markdown in `docs/` is exempt.
