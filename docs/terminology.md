# Terminology

This glossary is the lexicon of Flywheel: each concept's canonical name, its definition, its spelling on each surface, and the synonyms it retires. Architecture intent states the naming rules that it serves: one concept has one name (ARCH-NAMING-001), the glossary owns names (ARCH-NAMING-002), a new concept is named here before its first identifier lands (ARCH-NAMING-003), retired terms do not return (ARCH-NAMING-004), and stored names are immutable data (ARCH-NAMING-005). The grammars for fact types, protocol requests, surface spelling, and identifier composition are ARCH-NAMING-007 through ARCH-NAMING-011. `bun run lint:terminology` rejects retired terms.

## Lexicon

Each entry: the canonical term, its definition, and the synonyms it retires. Retired terms do not appear in new code, docs, or UI strings.

### Substrate

- **event**: an ephemeral in-process bus message (`defineEvent`). Retires nothing; the word is banned for durable rows.
- **fact**: a durable typed row in the event store (`defineFact`). The durable row type, writer interfaces, and fact-defining file names carry the fact stem. Qualifiers `control fact` and `companion fact` are the only sanctioned adjectives. Retires: stored event (as a type name), ledger fact, audit fact (neither semantic-audit evidence nor provider request diagnostics is a durable row).
- **session.auth.profile.selected**: the session metadata fact that captures one persisted auth profile ID without credentials.
- **event store**: the SQLite store holding facts. The industry term for the storage layer is retained deliberately even though its rows are facts.
- **aggregate**: the replay partition key (`session:`, `conversation:`, `workflow:`). Docs list only keys that code produces.
- **projection**: a deterministic fold over facts, and nothing else. Config policies and rendering transforms do not use the word.
- **view**: a protocol-facing read shape sent to the TUI.
- **snapshot**: a point-in-time full-state protocol payload, as opposed to an incremental patch. Banned from durable fact names.
- **fold / replay**: fold applies one batch; replay folds a whole history. Executable workflow replay begins at the newest recognized control root; earlier control is render-only. Retires: rehydrate, catch up.
- **registry**: a mutable runtime lookup that things register into. Files named for registration export the registry they create.
- **catalog**: a published read-only list projected for display. Retires as collective nouns: roster, specs, descriptors.
- **migration**: a versioned rewrite of historical facts or files that isolates failure per session and never rewrites or deletes bytes it cannot parse.
- **content row**: one row of the session-scoped `tool_content` table, holding the canonical bytes of one distinct large tool text, keyed by session id and sha256. It commits in the same atomic append as the first fact that references it and is deleted with its session.
- **tool-content reference**: the `{ sha256, bytes, preview }` shape a durable fact or chat entry stores in place of large inline tool text. Resolving a reference to its sha256-verified exact text at a durable read seam is **hydration**; the word is distinct from fold and replay and does not revive the retired rehydrate.

### Workflow

- **workflow**: a file that lists phases that run in order. One execution of the file is a **workflow run**; its `sessionId` identifies it, and `workflowDefinitionId` records provenance. The file lists its phases under `phases`. Retires from prose: ad hoc workflow, ad-hoc workflow, registered workflow, pipeline, epic, program (program remains a code-mode term). Retires as a module id: `adhoc-workflows` (the module is `workflows`). Retires as file keys and nouns: flow, flow entry, step record, `steps`, `after`.
- **workflow view**: the flattened read model of a workflow's phases, agents, and attempts, on every surface including facts, config, protocol, and clients. Retires: queue, except for true first-in-first-out structures such as the injection queue. The stored `queue.*` fact types keep their spelling.
- **workflow card**: the block in the parent chat's transcript that shows one workflow run: its phases, its agents, and its bar. The bar counts one unit for each agent.
- **phase**: one section of a workflow. The phases of a workflow, and the phases of a repeat, run in order. A phase has one agent, the named agents of `agents`, or one agent for each item of the list that `over` names. `over: <phase>` gives a phase one agent for each agent of the phase directly before it, and each such agent starts when the agent that it follows finishes; such phases form a **stream**. `if: <phase>` runs a phase only when that phase completed, and `if: <phase>.<field>` runs it only when that field of its output is not empty. File key `phase`, TypeScript stem `Phase`, label Phase. Clients, message addresses, and model seats name a phase by its id. Retires: step as the unit of a workflow, stage, map, group, lane, chain, concurrent span, concurrent phase, overlapping run, outline entry, entry and row as display nouns, VM phase, and phase as the name of a part of an implementation plan or of chat delivery. Sanctioned other uses: a qualified compound that names a stage of another lifecycle, such as `StreamPhase`, `RuntimeShutdownPhase`, `RetirementPhase`, `ToolLifecyclePhase`, `ToolRenderPhase`, `PasteBurstPhase`, `StreamTimeoutPhase`, `ChatGptAdapterTransportPhase`, `WriterPhase`, `AcquisitionPhase`, and `RuntimeStartupPhase`, and a module-local `Phase` type outside workflow code. Stored spellings that stay frozen and readable: the node kinds and ownership tags `step`, `phase`, `group`, `branch`, `rounds`, `while`, and `for`, and the provenance tags `while`, `for`, `then`, and `branch`, of workflow control before version 11; the tree kinds `step`, `phase`, `group`, `branch`, `chain`, and `rounds` and the fields `stages`, `stageIds`, `mapId`, and `currentLeafId` of tree facts; the id segments `:branch:` and `:stage:` of nodes that control before version 11 created; and the fact types `group.expanded`, `group.settled`, `for.*`, and `step.*`.
- **agent record**: the declaration of one agent in a workflow file: a phase of one agent, a named agent, or a phase over a list. Its key is the phase id or the named agent's id; stored nodes and attempts name it `definitionId`. Every agent of a phase over a list runs the one record of its phase. It holds the agent's brief, the persona that runs it (`persona`), and its policy (`writes`, `reads`, `name`, `model`, `effort`, `retry`). Retires: position as a noun, step record.
- **brief**: what an agent runs: its instructions and its output contract. A workflow states each brief inline with `brief:`, with `output`, `dependencies`, and `subagents` beside it. Another agent record reuses it with `runs: <name>`, where the name identifies the phase or agent that states it. `runs` defaults to the record's id. The brief id is `<workflowId>.<name>` and names the model seat `brief.<briefId>`. A subagent's brief is the assignment that its parent dispatches. A brief is not a skill and never enters the skill catalog: it composes skills through `dependencies`. The text of a person's request is the request, never a brief. Retires: step content, step file, step instructions, content id as a seat key, dispatch brief (it is a brief), task as the name of the turn that carries an agent's own work, and Assignment as a label. Stored entry ids such as `subagent-task:<conversationId>` and `workflow-step-task:` keep their spelling.
- **item**: one element of the list that a phase runs `over` or that a repeat runs `each`. Each agent of a phase over a list works on one item, or on one vote on one item. Its key is its `unique` field, or its 1-based padded position. Its label is its `label` field. `targets`, Interrupt, and Resume name such an agent by its item key. Retires: lane, and branch in prose. The `branch` field that `dedupe` and `top` add to kept and dropped entries is stored join output that agents read; it keeps its key and holds the item key or the agent id of the agent that reported the entry.
- **join**: the fold of the outputs of the agents of one phase into one output by a registered reducer, written `join: { reducer, with, write }` on a phase of named agents or on the last phase of a stream. Every phase with several agents defaults to `collect`, whether it has named agents or runs over a list. A later phase that reads a join, such as `over: reviews.kept`, waits for it. A join is the only barrier. A failed agent of a list is a disposition in the join, never a failure of the phase or the workflow. Retires: fan-in and fan-out as nouns, and group as a prose name for what a join folds.
- **repeat**: the one block of a workflow file, with its own `phases`. `repeat: { while: <phase>.<field>, max: <n>, stuck: <bool> }` runs rounds while that field is not empty. `repeat: { each: <source>.<field>, reassess: <phase> }` runs one round for each item, one after another. A repeat is not a phase: it has no agent, no attempt, and no card section of its own. `over` always means at the same time, and `each` always means one after another. Retires as file keys: `while`, `for`, `do`, `then`, `maxIterations`, `detectStuck`. Retires from prose: loop node, body step, and follow-up as a step concept; follow-up names only the conversation after a workflow completes.
- **round**: one pass of a repeat's phases. Round has no other sense: the turn entry already retires it as a turn word, the frontier's settling count is depth, and execution preparation repeats in sweeps.
- **output contract**: the closed declaration of the fields that a brief's handoff carries beside the summary. A launched workflow declares it inline beside `brief:` with `output`; no registry or name joins a brief to it. File verification also reads JSON contract paths relative to the workflow file.
- **attempt**: one try of an agent at its brief. A retry and a reassessment replacement start a new attempt. An interrupt and its Resume continue the same attempt. A subagent's run is its attempt, and `childRunId` stays its stored id. A chat has no attempts. Provider request retries use the retry stem, never attempt.
- **workflow agent**: the model-selection role of every agent that a workflow runs. Role id `workflow-agent`, label `Workflow Agent`. It is the parent seat of each brief seat `brief.<briefId>`, of each record seat `brief.<briefId>.at.<definitionId>`, and of each persona seat `brief.<briefId>.persona.<role>`. Prose names one such agent "an agent of a workflow", never "a workflow agent". Retires: step agent, `step-agent`, Step Agent, `step.<contentId>` as a seat, step seat, position seat, worker in this sense, step-worker, orchestrator as this role's label, and executable node as the executor. A config file or a stored role snapshot that names a retired seat reads as its current seat.
- **control status**: the committed workflow control state `ready | executing | paused | follow_up | completed | failed`. It is internal and never publishes. Retires: VM phase.
- **workflow state**: the published lifecycle is `idle | running | paused | completed | failed`; `idle` is the pre-launch rendering of a session whose workflow has not started. `paused` is the saved name of an interrupted or aborted workflow, never a person-facing word; interruption and abort are recorded reasons on the paused or failed state, not states, and the UI derives its labels from the reason. Internal control states carry a distinct name (control status) and never publish.
- **recovered history**: the canonical strict-first historical projection shared by transcript display and provider API context. Reviewed salvage repairs recognized shapes; a **degraded gap** represents unreadable immutable bytes without inventing executable state.
- **handoff**: the typed payload that an agent's completed attempt, or a chat turn, writes for its successors.
- **artifact contract**: the file outputs that an agent record declares in `writes`, with lifetime and supersession.
- **context bundle**: the material that an agent inherits into its context window: the request and its addenda, the launch input, the output of the phase before it, the outputs that it `reads`, live durable artifacts, and its item. A handoff is deliberate typed compaction at an agent boundary. The stored `context.*` and `step_context.*` types keep their spelling, and a new version keeps its type string. Code that assembles it lives in `src/workflows/context-bundle/`. Retires: step context, accumulated context as a bare name.
- **request addendum**: a message that an agent of a workflow read from its parent session, which every later agent reads after the original request. The commit that settles the reading attempt records it as a `step_context.input.added` fact; the seed stays verbatim. An addendum is direction unless it holds the literal heading Design intent. A person's direct message to an agent is never a request addendum. Revision names a version identity and follow-up names input after a workflow completes, so neither word names an addendum.
- **milestone**: one part of an implementation plan: its id, goal, files, changes, and a command that proves it alone. Retires phase in this sense. The reassessment contract of a repeat names the remaining items `item_id` and `item`.
- **skill**: an authored instruction package (`SKILL.md`). Skill package may appear in prose for the on-disk bundle. Retires: canonical practice package, instruction package, practice package.
- **agent skill**: a reusable skill under `src/agent-skills/` whose method or principle is independently useful to an agent outside workflow transport. Production agent skills form the production core corpus; the corpus derives from the admitted registry revision and is not a handwritten roster.
- **dependency**: a skill reached only through another skill's dependency list. Retires: ingredient.
- **persona**: a Markdown-authored subagent definition with a role and required skills. The model-facing subagent parameter uses this word. A brief lists the personas that its agent may dispatch as subagents under `subagents`; while the trial of PI-AGENT-044 runs, every agent of a workflow can also dispatch the advisor. An agent record's `persona` runs that agent as the persona: the persona's instructions, required skills, tool limits, turn limit, and model seat apply to it, as they do to a dispatched subagent of the persona, and the brief still supplies the task and the output contract.
- **designer**: the model-selection role for personas that judge rendered-interface intent. Role id `designer`, label `Designer`. The plan and code design reviewers share this role; it is not an implementation role or builder.
- **learned skill**: a skill Flywheel wrote for itself (`managed: flywheel`). Like every skill, only agents load it. Retires from prose: managed skill, curator-managed.

### Experiments

- **experiment**: an autonomous optimization loop that changes one candidate at a time and measures it under one approved charter.
- **run**: one measured candidate in an experiment, including its measurement and keep, discard, crash, or checks-failed outcome. It is neither a workflow run nor an attempt.
- **charter**: the user-owned repository definition that fixes an experiment's objective, metrics, gates, file access, commands, baseline procedure, and search strategy before the loop starts.
- **protected path**: a path that an experiment can read but cannot write.
- **sealed path**: a path that an experiment can neither read nor write.
- **experiment view**: the protocol-facing read shape for an experiment's current segment, runs, metrics, best kept result, and confidence.

### Agent runtime

- **agent**: one execution loop instance, created by the agent runtime. It is a chat's agent, a subagent, or an agent of a workflow phase. A subagent, and an agent of a workflow, runs one brief on at most one item, and each try is an attempt. A chat's agent runs the person's conversation turn by turn, with no brief and no attempts. The agents of one phase can run different briefs on different models, efforts, and personas. The loop handle carries the agent stem without a product prefix. Retires: step agent as a separate noun, roster agent, and leaf as a prose name for an agent.
- **divider**: the rule in a transcript before a message that a person sends mid-turn, before narration that resumes after finished tool work, before an implementer dispatch that follows a completed implementer and further work by the parent, and before a command that starts a skill's method in chat. Retires: step divider, `stepBoundary`.
- **runner**: a session-level driver that owns an agent across turns (chat runner, workflow runner). Reserved for this layer alone.
- **pre-start**: the start of a provider engine for a shown session before its next request is sent. It prepares that request as a send would and sends no model request.
- **claim**: what an anticipation returns: the provider's hold on what it prepared for a request, released by whoever anticipated.
- **agent host**: the turn-lease owner wrapped around one agent. The host word is reserved for components that own an execution environment for a named occupant (workflow VM host, agent host, guardian host), never for port bundles.
- **turn**: the two tiers are the logical turn (one user input to settlement, fact domain `logical_turn` under the agent namespace) and the provider turn (one model request, `model.turn`). Retires: exchange, round; generation as a turn word (generation names only the Bun Worker incarnation).
- **activity**: the single runtime answer to what a session's agent is doing: `absent | idle | waiting | thinking | generating | executing_tools | awaiting_user`; `absent` renders a session with no live runner so the axis is total over the catalog. Retires as parallel axes: runner activity plus model phase as separate enums, agent state.
- **lifecycle**: the durable session axis, `active | inactive`.
- **interrupt**: the one resumable cut of a chat turn, a subagent attempt, or an agent of a workflow, made by a person, the parent agent of a child, or the runtime. ARCH-SESSIONS-018, PI-INTERACTION-043, PI-INTERACTION-101, PI-INTERACTION-103, PI-AGENT-020, and PI-AGENT-025 state its behavior. Requests are `chat.interrupt`, `subagent.interrupt`, and `workflow.interrupt`, and the `process` action is `interrupt`. Labels are Interrupted for a person's interrupt, Interrupted by the parent, Interrupted by the runtime, and Interrupted by an unexpected exit. The saved spellings `paused`, `pausedBy` (`person`, `agent`, or `runtime`), `subagent.paused`, and the workflow control status `paused` name an interrupt in stored data and internal control. Retires: pause as a control or label.
- **capacity wait**: an agent's wait for a stated time when every candidate is spent, which records continuation authority and continues the turn on its own when the time comes (PI-MODEL-039, PI-MODEL-063, ARCH-SESSIONS-039). Its label is Waiting for model capacity.
- **resume**: the continuation of interrupted work from exactly where it stopped, with no new message. Requests are `chat.resume`, `subagent.resume`, and `workflow.resume`; a parent agent resumes its own child with `process` (`action: "resume"`), which also starts a new attempt of a child whose run failed. A parent agent never continues a child whose latest interrupt or stop a person made: only a person continues that work. The label is Resumed. Retires: the `resume` and `retry` kinds of the subagent tool.
- **stop**: the terminal end of a child (a subagent or a workflow a parent launched) or a background command, always `background.terminate` on the parent's tool call; a parent agent stops its own child with `process` (`action: "stop"`). A chat has no stop. Labels are Stopped for a person's stop and Canceled for an agent's.
- **process**: the kernel tool for the work that an agent started: its background commands, its services, and the children that it launched (ARCH-STRUCTURE-032, ARCH-SESSIONS-015, PI-AGENT-025, PI-AGENT-080, PI-AGENT-081). Its actions are `list`, `status`, `wait`, `stop`, `interrupt`, `resume`, and `read_output`, and a child's process id is its session id.
- **list_sessions**: the kernel tool that lists the sessions of the project that an agent did not start: its parent, its siblings, and the other sessions that run now. The children that an agent started are in `process`, never in `list_sessions`.
- **message**: input that one session delivers to another session of the same project through the kernel tool `message_session`, whose `to` takes an id from `process` or from `list_sessions`. The runtime records the sender, its name and relation to the recipient, the wake hop, and the words of the person that the sender read since its last exchange with the recipient. The recipient's transcript shows it as a message row that names its sender. A message never carries a reply: a reply is a separate message in the other direction. A parent's message to its own interrupted child continues the child when the parent may continue it, as its Resume does. A person's message to any session is the one request `session.send`, and a child row's input mode is `message`. Retires: steer as the name of a message from an agent or from the person; the `steer` kind of the subagent tool; and the requests `chat.send`, `subagent.steer`, and `workflow.steer`.
- **reply wait**: the state of a session that sent a message with `wait: true` to its parent or to its own child and waits for the reply without ending its turn. `message_session` refuses a wait on any other session with `not_parent_or_child`. The session status names each session that it waits on in `replyWaits`, and clients show "Waiting on parent" or "Waiting on <name>".
- **peer**: for one session, another session that is neither its parent nor its own child, such as another root chat. A message from a peer carries the relation `sibling` or `other`, carries no authority, and cannot open a reply wait.
- **background index**: the one list of a chat's background work: the background commands the chat ran and every child it started, in start order, each child nested under the child that started it. It reads durable facts, so it is complete after a restart. It shows Active work (running, or waiting on the parent) or All work, and the prompt-bar count counts its top-level Active rows. `/bg` opens it on every client.
- **session**: the runtime container for user-visible work, keyed by `sessionId`. Chats alone occupy navigation catalog rows and tabs; workflow and subagent sessions remain child runtime containers.
- **live ownership**: the current parent binding that authorizes child control, completion, and deletion. Adoption changes this binding without rewriting the original launch.
- **ancestry**: immutable creation, link, and adoption relationships used for inspection and request accounting, never deletion authority.
- **runtime-origin invocation**: a tool invocation recorded by Flywheel for a person's launch or a migration reference, without fabricated provider identity. Stored invocations with a `headless` initiator remain readable.
- **account service**: the resident `flywheel serve` process that owns the account socket, opens isolated project compositions on demand, and serves terminal, editor, browser, and paired-phone clients. It is the only interactive serving owner.
- **Process initiation**: the explicit `on`, `off`, or `unavailable` state of the login-session installation that starts the account service. The user-facing spelling is title case. Retires: host installed, remote startup service.
- **auth profile**: a named account credential scope identified by an immutable profile ID. Session metadata persists the selected ID; the environment selector is a non-mutating effective override.
- **conversation**: the durable append-only message tree, keyed by `conversation:<conversationId>`. One stem for its classes, writers, and projections. `conversationId` means this key and nothing else; the provider continuation token is named for the provider at the adapter boundary. Retires: session tree, chat tree, thread history (branch history describes a resolved path).
- **conversation entry**: one node of the conversation tree. The runtime session record keeps the session entry name; the collision is resolved by this split.
- **transcript**: the rendered display derivation of a conversation or workflow, end to end: protocol queries, windows, stores, and docs all use the transcript stem. Retires: output history, scrollback, rendered history.
- **block**: the unit within a transcript (text, thinking, tool, system, question). Provider content units keep the content block name at the adapter boundary. Part means only a tool-output part; chunk belongs to TUI text layout; delta is the increment across stream and display.
- **composer**: the TUI text input. Frees prompt for the model sense; composer history replaces prompt history.
- **subagent**: a delegated child agent. It runs one brief, and each try is an attempt, which stored data names a run (`childRunId`). Dispatch is only the verb for starting one; facts consolidate under the `subagent` domain. Retires: task as the unit noun, subagent run as a separate concept name.
- **model family**: the API dialect (`anthropic | openai | google`). One type; duplicates retire.
- **access provider**: the credentialed route to models (billing identity). Its id is a branded type.
- **provider account**: one canonical credential account identity. A singleton account is the provider identity; a subscription account is provider identity plus its stable internal instance identity. Protocol views represent a subscription account with an opaque profile-bound account correlation ID and never expose the instance identity.
- **external login**: an access provider's login that another program owns, such as the Claude CLI's login for the Anthropic Subscription provider. The program runs the sign-in, stores the token, and refreshes it. Flywheel stores no token: it finds each account from the program's token-free account record, and that account's stable id is its instance identity. A separate home of the same OS account can hold a token-free reference to a profile login in the account's normal Flywheel home. Login and logout run the program's own commands for owned logins; Disconnect of a reference removes only the reference.
- **provider-model preference**: one profile-local explicit enable or explicit disable delta for a model under one exact provider account. Version-2 persistence keys these deltas by canonical account identity. Retires: provider-wide preference.
- **provider-model eligibility**: the effective decision that a model is eligible through one exact provider account and one auth profile. It derives from that account's provider curation, settled catalog evidence, and current explicit preference.
- **curated default**: the product-authored baseline eligibility for one provider-model pair when the account has no explicit choice. It is an input to account-specific provider-model eligibility, not user intent.
- **explicit enable**: the user's choice to make one account-model pair eligible, overriding its curated default. It is mutually exclusive with explicit disable for that pair.
- **explicit disable**: the user's choice to make one account-model pair ineligible, overriding its curated default. It is mutually exclusive with explicit enable for that pair.
- **eligibility state**: an immutable runtime-owned value keyed by auth profile ID, containing exact provider-model eligibility sets for every canonical account, their derived provider union, and one eligibility revision. Ordinary live state is not a projection because it does not fold durable facts.
- **effective provider catalog**: the published read-only picker list derived as the union of the current eligibility state's exact account sets. It is not an authority for curated defaults, explicit choices, account admission, or routing.
- **eligibility revision**: the identity of one eligibility state version, changed whenever that state's effective provider-model eligibility changes.
- **provider-model view**: the protocol-facing read shape for one canonical account. Its target is a discriminated singleton provider or subscription `{ providerId, accountCorrelationId }`, and it carries profile identity and eligibility revision without exposing an internal instance or serving-candidate identity.
- **Usage authority**: the protocol-v6 profile-scoped SQLite authority containing separate provider-observation and immutable Flywheel request-ledger families. Protocol requests use `usage.open`, `usage.accounts`, `usage.spend`, `usage.history`, `usage.refresh`, and `usage.apply_reset`. Retires: subscription usage as the whole authority, profile-wide spend ledger.
- **usage metric**: one provider-native allowance measurement identified by a stable provider-local metric key, an account or feature scope, a deterministic rank, and exact-or-unavailable timing. Its label is presentation, not identity. Retires: metric name as identity.
- **quota window**: one exact half-open provider usage interval, derived from canonical account identity, metric scope, metric key, `startMs`, and `endMs`. A reset hint without both bounds is not a quota window.
- **quota accounting**: the source-local request-ledger totals for the selected current quota window. It is `window-unavailable` or `ledger-unavailable` when exact accounting cannot be established, never an inferred zero.
- **provider observation**: provider-reported allowance, balance, reset, or billing-capacity evidence retained by the Usage authority. It is evidence for inspection, routing, and consent admission, not local request accounting.
- **request ledger**: the immutable Usage-authority family that records each served provider attempt as the profile's accounting evidence, distinct from provider observation, consent, and the invoice (ARCH-PROVIDERS-050, ARCH-PROVIDERS-051, ARCH-PROVIDERS-055, ARCH-PROVIDERS-056).
- **credential lineage**: opaque auth-owned provenance for the credential capture that served a request. It is distinct from provider account identity and contains no credential value. An external login has no stored capture, so its lineage is the account's stable id, and each account of one provider has its own.
- **adapter**: the per-provider transport layer. Retires: backend.
- **failover**: the provider-switch behavior, named in identifiers rather than only comments.
- **compaction**: the operation that starts a fresh model context after the agent saves a session-notes checkpoint. It records an explicit reset and carries no prior conversation messages or generated summary into the new context. Retires: summarize as the operation name; compact meaning terse.
- **context window**: the model's token capacity; occupancy is measured in prompt tokens. One name for the limit. Retires: context limit and context window tokens as parallel names.
- **memory**: durable preferences, facts, and lessons under the learning umbrella.
- **learning**: the umbrella for durable memory and skills, including the background review (role id `learning-review`, label `Learning Review`) and the user verb `/learn`. Retires: learning, reflect, skill-review (as the role id).
- **scope**: where learning lands, `project | global`. Retires: reach, target. The stored fact payload keys (`reach` on skill facts, `target` on memory facts) keep their historical spellings; types and prose say scope.

### Remote access

- **web client**: the one out-of-tree client, the SolidJS bundle in `webview/` that every host mounts. Retires: webview client, phone app (as a separate implementation).
- **host**: the thin file that mounts the web client with a `Socket` layer, a capability object, and a theme; the extension host and the phone host are the two. The word keeps its other reserved sense, a component that owns an execution environment for a named occupant.
- **capability**: one optional entry in the object a host hands the web client, such as opening a file or scanning a code. The client degrades by a capability's absence and never branches on host identity.
- **relay**: the hosted or self-hosted Worker that joins a paired device to a runtime placement and pumps sealed frames it cannot read. It holds presence, allowlists, and pairing windows, and no user, session, transcript, or subscription.
- **remote client**: a client attached to a runtime through the relay: the web client a paired phone or browser loads, or a terminal on another machine.
- **pairing**: the exchange, under a one-time secret shown as a QR code, in which a runtime records a device's identity key and the device records the runtime's. Pairing is the only remote credential; there are no accounts.
- **device key**: a device's Ed25519 identity. A browser holds it in browser storage as a key the page cannot export; a terminal holds it in an owner-only file beside its account's auth. Its digest is the device id.
- **device store**: what a paired device remembers, kept by its host: the device key, the name it pairs under, the machines it paired with, and the project it last chose. The relay client reads and writes it through one contract and holds no storage itself.
- **runtime identity**: an account's Ed25519 key in the pairing store; its digest is the runtime id the relay and every device know the account by.
- **placement**: one runtime process serving one project for an account, named to the relay by the project's digest. A phone chooses a placement.
- **machine placement**: the one placement an account service announces for itself, named to the relay by the runtime id. A paired device attaches to it to create a project from a repository, and a picker never lists it as a project.
- **control channel**: the outbound WebSocket a placement holds to the relay while paired, carrying admission and `open` frames and never protocol frames.
- **sealed channel**: a relay data channel after both ends completed the signed ephemeral key agreement; every frame on it is AES-GCM ciphertext under a per-direction key and counter.

### Learning evidence

- **semantic audit**: the independent model judgment that compares one complete writer-prepared skill candidate with the complete bundled corpus from one pinned registry revision. Its closed judgment is bound deterministically into **semantic-audit evidence**, the request-local, content-bound admission evidence for that exact candidate, revision, outcome, and any selected canonical bundled package identity. The store checks it under lock and discards it after settlement. ARCH-LEARNING-013 owns its behavior.
- **complete bundled corpus**: every immutable bundled skill package in one pinned registry revision. Ordinary content-admission semantic audit compares against this corpus, including the skills of installed module bundles and same-id packages hidden by installed precedence.
- **production core corpus**: the exact revision-derived set of production agent skills, represented by one aggregate identity and an exact sorted package manifest. Historical core cleanup compares project learned skills with this corpus and excludes the skills of module bundles.
- **learning journal**: the consent and mutation outbox of the learning stores. It records mutation intent and consent before publication; it is not semantic-audit evidence or provider request diagnostics.

- **core cleanup campaign**: one durable project-scoped cleanup of learned skills against one exact production-core identity and manifest. Missing completion audits every current core package; added or changed core packages reopen their classifications; force audits all current core packages. Its completion authority is the newest `skill.cleanup.completed` fact; the campaign lease and its deferral cooldowns are in-flight state in the companion table, guarded by compare-and-swap rather than recorded as facts.
- **core cleanup classification**: one of `independent | specialization | conflict | uncertain` for one exact learned candidate against one exact production core package. It is campaign evidence, not content-admission semantic-audit evidence or learning-journal state; any resulting skill mutation still enters the learning journal before publication.
- **skills cleanup**: the user-facing and operational label for running a core cleanup campaign. Retires: skill migration and registry cleanup for this operation.

### Tools and modules

- **tool**: a model-callable runtime function. Per-layer type names mark their layer explicitly rather than inventing new nouns.
- **tool call**: one invocation of a tool. The canonical id is `toolUseId`: durable fact payload schemas and session launch metadata store that key, so it is the spelling the substrate already speaks, and a different in-memory name would split the codebase into two vocabularies. Provider wire spellings (`tool_call_id`, `tool_use_id`) map at the adapters. Session metadata replay normalizes the previous v3 launch spelling once at its historical boundary. Retires internally: toolCallId.
- **tool action**: the permission category a tool exercises (`file_write`, `shell_exec`). Scoping keys use the action names.
- **tool registration**: one executable form of a tool, identified by the registration id that conversation history and the request audit record. A tool states its policy (action, category, persona grant, clone inheritance, and order) once, and the serving-model interaction profile selects one of its registrations for each request. Settings, persona grants, allowlists, and gates name the tool, never a registration. Example: the `edit` tool has the `edit` and `apply_patch` registrations.
- **file edit**: the logical model-facing source-file editing capability. Capability action `file_edit`, one tool `edit`. **file edit presentation**: the registration of that tool that one request uses, selected by the serving-model profile before request assembly and declaring its own wire shape. Retires: file-edit protocol, file edit contract.
- **string edit**: the file edit that uniquely replaces supplied text in one strict UTF-8 file. Tool name `edit`, TypeScript stem `StringEdit`. Retires: replacement tool and replace tool for source files; `replace` remains valid for memory CRUD and unrelated ordinary prose.
- **apply patch**: the file edit that applies one bounded V4A patch across admitted files. Tool name `apply_patch`, TypeScript stem `ApplyPatch`.
- **retained file authority**: the TypeScript-owned physical parent handle plus canonical target and admitted byte/access snapshot held from admission through publication or release. TypeScript stem `RetainedFileEditAuthority`. Retires: file edit cache and `FileReadCache`.
- **file mutation**: one logical direct-tool change that can publish one or more ordered file results and records terminal facts under `file.mutation.*`. TypeScript stem `FileMutation`.
- **file mutation operation**: the recoverable ordered publication checkpoint for one file mutation. In-flight kind `file.mutation`; TypeScript stem `FileMutationOperation`; each cell stores proof metadata and one cursor, never file bytes.
- **module**: a selectable feature bundle (skills module, bash module). Config key and protocol domain use the module stem; the Settings section is Modules. Retires: capability module, capability (in this sense), plugin (reserved for external plugin systems), features, core-tools, runtime-tools, harness capability.
- **capability**: an admission grant that scopes what a context may do (capability access, capability grant). This is the word's only meaning. The guardian's byte token is the guardian token; service ports are ports.
- **gate**: a seam that can refuse or replace an operation, always qualified (module gate, concurrency gate). Locks are not gates.
- **hook**: an owner-typed module seam callback (observer, transformer, gate are the three hook kinds). Solid reactive helpers are not hooks in type names; `use-*` files export reactive accessors and `create-*` files export factories.
- **MCP server**: an external tool provider. The manager's port types are ports, not capabilities.

### Observability

- **provider request audit**: the session-lifetime fact set for one model request, including prompt assembly, tool-surface selection, request and response evidence, usage, and the aggregate stream summary. Reconstruction and diagnostic projections replay it. Raw stream events remain debug-log telemetry.
- **telemetry**: provider stream timing only. The aggregate summary is durable when a session projection reads it; raw provider, watchdog, and normalized stream observations are diagnostics. UI performance measurements are diagnostics, and diagnostic keys never take the dotted shape of fact types.
- **debug log**: the retention-bounded JSONL diagnostics stream under `.flywheel/log/` (`*.jsonl`), written by `infra/debug-log.ts`; `Log.*` calls land there as `log.<level>` records. No projection, replay, resume, recovery, or product behavior reads it. Retires: text log, verbose log.

### Config, CLI, UI, directories

- **config**: the TOML file, its schema, and everything persisted (`flywheel.toml`, the config writer). Retires: preferences, options (for this concept).
- **setting**: one user-adjustable row as presented in the Settings modal. Each setting has one id (ARCH-NAMING-009). Retires: the parallel row id, store key, and key fields.
- **CLI grammar**: space-separated `noun verb` subcommands (`flywheel events search`, `flywheel skills list`, `flywheel mcp add`, `flywheel auth login`, `flywheel events maintain`). The directory flag is `--project-root` everywhere. Retires: colon-delimited subcommands, bare `maintain`, `--base-dir`.
- **modal**: any overlay the TUI stacks (modal stack, open-modal verbs). Retires: dialog.
- **command menu**: the list a bare `/` opens on any client. Retires: slash menu, slash popup.
- **Authentication**: the surface `/auth` opens, where a person connects providers and accounts. Retires: Providers and Auth as its name.
- **toast**: a transient auto-dismissing message. **notice**: a persistent message until resolved, which is also the name of the presentation channel. Retires: banner, and card as a name for a notice.
- **pane**: a split region; **viewport**: the scrolling region of the output window; **tab**: a session slot in the tab bar.
- **directory authorities**: `userDataRoot`, `projectRoot`, `executionCwd` (ARCH-DIRECTORIES-001, ARCH-NAMING-013). No aliases: base dir, workspace root, project dir, and root dir retire.
- **workspace**: the project-scoped durable state and its protocol scope literal. The handoff validation directory is the handoff staging directory; the per-session disposable directory is scratch.

### Evaluation

- **verify**: to check that a definition is sound (a workflow compiles, an anchor resolves).
- **validate**: to check that a payload matches its schema. OAuth's code verifier is boundary vocabulary and exempt.
- **benchmark**: an evaluation harness under `bench/` or the development module's benchmark tool; its nouns (variant, judge, scoring) are already singular.
- **design intent**: the approved design the user accepts in chat: purpose, feature set, key decisions, non-goals, constraints with rejected alternatives, verification expectations, and recorded product intent. Approval fixes it; only the user changes it (ARCH-AGENCY-015). It appears under the literal heading `Design intent` on every surface that carries it: the design result, session notes, workflow launch description, subagent briefs, and reviewer prompts. Retires in this sense: high-level intent, user intent as the tier name.
- **implementation design**: every choice an implementation route makes beneath the approved design: milestones and their order, file lists, decomposition, directives, and local shapes. The specification artifact records it, and the implementer revises it with a recorded deviation. Retires: low-level design.
- **first draft**: the result an implementation route returns to the agent that holds the design intent. It is evidence, never completion; the intent holder revises it from its recorded deviations and the review's findings until it realizes the design intent.
- **deviation**: one recorded difference between implementation design and what was implemented, with its reason and evidence. The brief's output contract or the subagent completion summary carries it. Drift remains prose for the aggregate of deviations.

## Reserved words

Each word below carries exactly one meaning in Flywheel-owned naming. Boundary vocabulary (Bun `Worker`, SolidJS context, OAuth verifier, Effect runner types) is exempt where the external API owns the word.

| Word | Sole meaning |
|---|---|
| agent | an execution loop instance; a subagent or an agent of a workflow runs one brief |
| runner | a session-level driver |
| worker | a Bun Worker thread placement |
| host | owner of an execution environment for a named occupant |
| capability | an admission grant |
| module | a selectable feature bundle |
| command | a slash command |
| tool call | one tool invocation (id: toolUseId) |
| attempt | one try of an agent at its brief |
| phase | one section of a workflow; a qualified compound such as `StreamPhase` names a stage of another lifecycle (refer to the phase entry) |
| brief | an agent's instructions and output contract |
| join | the fold of the outputs of a phase's agents; the JavaScript `Array.join` and `path.join` are boundary vocabulary |
| round | one pass of a repeat |
| queue | a true first-in-first-out structure |
| context | the model context window; context bundle for what an agent inherits |
| compaction | session-notes checkpoint followed by a context reset |
| conversation | the durable message tree |
| session | the runtime container |
| transcript | the rendered display derivation |
| block | a transcript unit |
| part | a tool-output part |
| chunk | TUI text layout |
| delta | a stream or display increment |
| event | an ephemeral bus message |
| fact | a durable row |
| projection | a fold over facts |
| view | a protocol-facing read shape |
| snapshot | a full-state protocol payload |
| registry | a mutable runtime lookup |
| catalog | a published read-only list |
| gate | a refusing or replacing seam |
| hook | an owner-typed module seam callback |
| audit | an evidence-producing inspection, always qualified as semantic audit or provider request audit; never the learning journal |
| telemetry | provider stream timing |
| scope | where learning lands |
| history | the composer's input history |
| shell | the TUI root component |
| workspace | project-scoped durable state |
| generation | a Bun Worker incarnation |
| daemon | the detached IDE runtime process |
| verify | definition soundness checking |
| validate | schema conformance checking |
