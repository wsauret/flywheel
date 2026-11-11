# Workflows Architecture Intent

This file states how Flywheel controls workflows, runs their attempts, and verifies, replays, and recovers them.

## ARCH-WORKFLOWS-001: Explicit workflow structure is the control authority

Event sourcing is the persistence and explanation model beneath workflows, not a replacement for their explicit, inspectable structure: visible sequencing, interrupt and resume, messages, and agent-level accountability. Reactive folds and state machines may implement control, but the explicit workflow model decides what runs next.
Not: Replacing explicit workflow control with implicit reactive behavior or a generalized causal graph.

## ARCH-WORKFLOWS-002: One pure oracle decides every workflow transition

One static, synchronous, deterministic state machine is the only authority for legal workflow transitions. It performs no I/O, and the commands it lowers are data that the host executes. Production execution and verification drive the same compiler and the same machine.
Because: A separate verifier or reducer can disagree with production about reachable and terminal behavior.
Not: A verification-specific reducer, or a mutable queue whose cursor and rows encode transition policy.

## ARCH-WORKFLOWS-003: Models, workers, hooks, and timing supply evidence, not control

Within the evidence rule of ARCH-AGENCY-001, models return typed handoff or reassessment data, and the async host returns typed results. Hooks and automatic checks enter as typed, inspectable evidence. Only the oracle decides whether that evidence changes control, and the resulting facts commit before the change is visible. No model, worker, hook, or completion order chooses a control event, applies a transition, or dispatches a worker. Intent contracts and evaluation records also schedule nothing: control consumes them only through its normal verified transition boundary.
Because: Letting model output or async timing select transitions makes control non-reproducible on replay.
Not: A dedicated runtime, planner, or engine for intent and evaluation, or a hook that changes state or injects instructions without a typed record.

## ARCH-WORKFLOWS-004: Deterministic work is control, never a worker

Executable workflow nodes are agent boundaries only. Routing, dependency release, conditions, loop control, authored retries, reassessment, container opening and settlement, and terminal propagation are semantics of the workflow compiler and its closed typed control vocabulary. They never run as worker attempts or invoke a model, and container nodes hold no attempts.
Because: Modeling deterministic work as an attempt misrepresents the model boundary.
Not: A workflow node that a worker executes to route, branch, or coordinate.

## ARCH-WORKFLOWS-005: A workflow aggregate owns control and run configuration

A workflow is an orchestration aggregate that owns its control and its run configuration and holds no conversation; ARCH-SESSIONS-001 and ARCH-SESSIONS-009 own how its agents are sessions. Reverse membership and a chat's workflow listing are derived projections, not further ownership records.

## ARCH-WORKFLOWS-006: The workflow aggregate is the only workflow authority

Workflow progress, terminal state (completion, pause, and failure), Resume eligibility, publication, replay, and recovery come only from the committed control facts of the workflow aggregate. The aggregate also owns the current binding to the launching chat. Session metadata owns only member lifecycle and relationships. The published workflow state, workflow views, accumulated context, statechart state, runtime fields, provider continuations, and rendered caches are deterministic projections of that aggregate and never a recovery source or an independent terminal authority. Clients render those projections and send actions, and never advance control.
Because: Snapshots and provider state duplicate the ledger and do not survive provider changes and restarts.
Not: Persisted statechart snapshots as a recovery source.

## ARCH-WORKFLOWS-007: One operational tree is the only workflow hierarchy

Committed control derives one operational tree for every loaded workflow, including planned and conditional work, and readers and clients use only that hierarchy. Attempt rows and workflow-view state are inspection projections, never a second hierarchy, a work selector, or a recovery source. A tree change publishes in the same atomic proposal as its control change, at a cost that follows the nodes that changed, not the size of the tree.
Not: Treating attempt-row order or workflow-view state as workflow authority.

## ARCH-WORKFLOWS-008: Every control change commits as one complete guarded batch

Every workflow proposal commits as one atomic batch, guarded by the expected aggregate sequence, that carries its semantic facts and all companions together. A sequence conflict discards the whole candidate and rebuilds from durable facts. Projections, runtime state, and clients never see a proposal before its full batch commits.

## ARCH-WORKFLOWS-009: Workflows load by content or path and carry no registry

A workflow loads from its content or a path, never through a definition catalog, and each brief and its output contract sit inline in the file. A brief belongs to its workflow and never enters the skill catalog; it composes skills as dependencies. Definitions are source data; runtime workflow authority is the workflow aggregate, never the authored file, view rows, or output blocks.
Not: A named workflow catalog or a name-keyed brief registry.

## ARCH-WORKFLOWS-010: Output contracts have one closed grammar and bind by content hash

Brief output contracts share one closed field grammar, compiler, envelope and citation check, acceptance, and later-agent rendering. Each contract compiles once, and each handoff is checked against its brief's compiled contract before recording. A handoff that fails after correction is recorded with its issues. A module consuming agent output is built from the admitted composition before workers start. It selects outputs by compiled contract hash and adds only checks a contract cannot state. It reconciles consumed outputs from committed facts, so a crash after commit recovers. A declared path field gets existence and syntax checks only, not containment.
Because: The tools that access a file own containment.
Not: A name-keyed contract registry that modules extend with custom checks, or selecting outputs by brief name.

## ARCH-WORKFLOWS-011: One ordered walk of one grammar serves every reader

The phase grammar is the one authored workflow form, and one ordered walk of its phases serves validation, agent resolution, briefs, identity, compilation, and verification. Node identities and order follow phase positions. An older authored grammar loads through one converter into the phase grammar, and the definition keeps what the converter read so identity can still prove a run it launched.

## ARCH-WORKFLOWS-012: One structural admission verdict serves every stage

Structural admission is one pure check over compiled control: dependencies, cycles, ownership, joins, and the worst-case attempt count against the run's attempt limit and the ceiling. Compilation, publication, list expansion, reassessment, verification, and load-time validation use that same check, and recovery replays admitted control instead of judging it again. The attempt limit alone bounds a run; compiled control stores no per-container budget.

## ARCH-WORKFLOWS-013: Definitions are captured at admission

Admission resolves a workflow's definition once and captures one preassembled revision of its skills and personas, and execution uses only that revision; no layer below admission looks up a workflow by id. A run never reads its file again: Resume, recovery, and runner start rebuild the definition from the run's recorded definition, and reloads affect only later admissions.

## ARCH-WORKFLOWS-014: Definition identity separates graph, policy, content, and contract

Definitions, briefs, output contracts, tool surfaces, model assignments, rubrics, and acceptance criteria have stable, versioned identities. Every run and definition consumer records each exact contract identity it used, so file drift never hides a historical run's contract. Identity hashes the canonical graph apart from each agent's policy, effective brief content, and output contract. Oracle version, composed skill membership, and reachable personas are further identities. Display names and descriptions affect no identity. A change only to composed skill or brief content is adopted through a recorded, sequence-guarded fact. Other changes are rejected as drift before a worker starts, without changing control.

## ARCH-WORKFLOWS-015: A launch originates only from an attested chat tool call

A workflow launch requires an existing host-attested chat conversation and the model tool call that requested it, and the run commits with its launching-chat binding before execution. The client protocol has no workflow launch operation, and the command catalog publishes no workflow or brief. Adoption by another chat changes the run binding and member parentage atomically while preserving original provenance.
Not: A client-side launch mutation, a slash launch, or an originless runtime launch.

## ARCH-WORKFLOWS-016: Ask-mode confirmation admits exactly one launch

In Ask mode the host verifies and claims, once and before publication, an answered launch decision from the same conversation that is bound to the same real path and definition hash. A missing, rejected, mismatched, or consumed decision refuses the launch. The decision authorizes that one launch and no other tool or effect.

## ARCH-WORKFLOWS-017: Launch publishes the whole run in one batch

One launch path publishes run registration and settings, the parent invocation binding, definition lineage, the verbatim request seed with its decoded structured input, initialized control, and the initial views in one atomic batch. Every check, including input decoding, runs before the first durable write, so a refused launch creates no run, invocation, session, or fact.

## ARCH-WORKFLOWS-018: The request seed is immutable and direction is context only

The launch request seed never changes, and execution and indexed history read that one canonical request. Generated titles, renames, continuation messages, and private session replies never replace it. Direction to a workflow, which ARCH-SESSIONS-028 delivers, is context only and changes no control or planning record. When no canonical request is readable, Resume fails clearly and the workflow stays paused.

## ARCH-WORKFLOWS-019: One host path owns async workflow lifecycle

One workflow host is the only production path that executes workflow commands, awaits atomic commits, starts attempt workers, and disposes owned resources in order, and it owns the transient runner lifetime outside the session store. Control schedules, starts, resumes, and continues attempts only through the run's host, never through subagent dispatch or subagent slot admission. It interrupts exactly the workers that committed control no longer runs, interrupts all of them only when the host itself fails, and awaits every worker settlement before a later finalizer runs.

## ARCH-WORKFLOWS-020: Each workflow member owns its own runtime inside the run's host

No workflow member gets an independent runner, and each member owns its own event lane, conversation writer, budget, output, background work, and teardown. A workflow member publishes its assembled runtime and decides whether work remains only after its own nested children register, and those children continue after it. Continuation never crosses a person's interrupt or Stop.

## ARCH-WORKFLOWS-021: Workers are bounded and persistence-free

A worker receives one bounded request and returns one typed outcome. The attempt runner owns prompt assembly, the worker call, handoff capture, and outcome classification, and has no interface to change control or persist workflow facts. Outcome classification reads typed fields only; no consumer reads summary, warning, or output prose to learn what happened.

## ARCH-WORKFLOWS-022: An attempt commits before its worker exists

An attempt's start, with the member session that ARCH-SESSIONS-009 describes, commits before any worker is acquired or provider work begins, and its outcome with every companion commits before anything is published. Preflight and drift checks complete before worker acquisition, and a failed or conflicting commit starts no worker.

## ARCH-WORKFLOWS-023: A worker conversation begins with its brief

Every worker conversation commits its brief before any retained operator input, and repeated Resume keeps the first committed brief. Recovery never creates a worker conversation that holds operator input alone, and a failed admission or startup never discards retained operator text.

## ARCH-WORKFLOWS-024: One resolution serves a workflow agent's display, editing, and requests

One resolution combines the run's inherited profile, directory, and role choices with the agent's explicit overrides, and display, editing, and request selection all use it. ARCH-SESSIONS-011 owns which choices the agent inherits and which it owns.

## ARCH-WORKFLOWS-025: Result order never changes the outcome

Results commit one at a time in arrival order, and every order reaches the same node states, joins, and context. Each proposal reads only committed control, and each attempt reads only the bundle frozen for it when its node could start, so a parallel sibling that finishes mid-run is invisible to it. Each logical node runs at most one attempt at a time.

## ARCH-WORKFLOWS-026: A list expands once per run from a frozen source

A list expands once in each run, from a frozen source, into its items under one join; only expansion shapes a list, and only a repeat adds rounds. A refused expansion records only the refusal and the run's failure, and the graph keeps no partial change. Expansion stays within the declared width, the attempt limit, and the worst case that admission counted.

## ARCH-WORKFLOWS-027: Joins fold through pinned, pure reducers

A join folds its slots through a versioned, pure reducer from one closed registry. Compilation pins the reducer version, its parameters, and its output contract on the node. A later reducer version never changes a running join. Replay folds the join again and compares it to the recorded output. A reducer that reports coverage or selection derives it from its own output.

## ARCH-WORKFLOWS-028: Continuation work keeps its charge lineage

Every attempt that continues earlier work links to the charge lineage of that work (ARCH-SESSIONS-012). Such attempts include a recovery restart, a Resume of failed work, a rerun of a reader of changed work, and a continuation after context overflow. Lineage, not a fresh count, decides retry, insertion, and attempt-limit accounting. Superseded items and rounds stay as history and count toward no limit.

## ARCH-WORKFLOWS-029: Blocked work settles only through lineage-linked correction

A stored blocked attempt is durable and immutable and never becomes a success. Only its authored reassessment can create lineage-linked corrective work that settles it, and a node completes only when it holds no uncorrected blocked attempt.

## ARCH-WORKFLOWS-030: Resume records its rerun closure

A Resume that reruns the readers of changed work derives which agents read which outputs once, from the run's pinned definitions. It records that map in its proposal so the oracle computes the closure and replay sees the same input. Control itself holds no read relationships.
Because: Compiled edges follow phase order, so a closure derived from them also reruns unrelated later work.
Not: Computing the rerun closure from compiled phase-order edges.

## ARCH-WORKFLOWS-031: Every Resume requests a new module grant

A person's interrupt ends a workflow's admitted work, so every Resume, including a live Resume of an interrupted agent, requests a new module grant for the definition content it runs before it continues anything. A live Resume runs the skill and persona revision its run captured, and a Resume that starts the runner again captures the current revision and adopts or rejects each change as ARCH-WORKFLOWS-014 states. A refused Resume starts nothing and leaves the workflow paused, and a message to an interrupted agent waits for the grant without being refused.

## ARCH-WORKFLOWS-032: Replay re-derives each proposal with its recorded semantics

Strict replay selects the semantics of each stored proposal from its recorded encoding and re-derives it with the production oracle, comparing order, identities, and positions. Historical behavior stays in frozen readers, never in current writers, and replay never rewrites expected facts or accepts another version's evidence. New proposals always use the current encoding.

## ARCH-WORKFLOWS-033: The newest control root fences history

Executable replay starts at the newest recognized control root, selected before its payload is decoded, and every reader, cold or incremental, uses that same boundary. A malformed or unsupported newest root is a fence and never revives an older valid prefix, and a complete recovery root also fences older context. The bytes before the fence stay unchanged.
Not: Falling back to an older readable control prefix when the newest root cannot decode.

## ARCH-WORKFLOWS-034: Only a person's explicit action makes degraded control executable

A workflow whose control history is degraded becomes executable only when an explicit user action publishes one complete recovery bootstrap atomically. Passive reads, detail views, background notifications, and Resume never publish a bootstrap, start a worker, or invent executable state. Recovery preserves the recorded workflow, agent, attempt, and conversation identities and never re-executes a recorded tool result.

## ARCH-WORKFLOWS-035: Completion stays owed until the parent acknowledges it

A workflow's terminal result and notification stay owed until durable parent reconciliation acknowledges them, and the host and its work registration are not released before that. One rendering produces both the live notification and the durable parent entry, so they never disagree about the verdict, the coverage, or which handoffs fit. A Stop commits the parent call's result first and requests reconciliation and teardown without waiting for the parent's turn.
Not: Separate renderings for the notification and the durable parent entry.

## ARCH-WORKFLOWS-036: Clients see a workflow through workflow cursors and its member sessions

Workflow state reaches clients through workflow-scoped cursors, and a chat lists its bound runs through a session-scoped domain. A workflow id is never an output target: an agent's status, transcript, budget, and changes use the ordinary session domains of its member session, and clients render it with the ordinary child-session body. The changes domain of the launching chat also holds its agents' changes, because a session's review folds the session and every session it launched (ARCH-PROTOCOL-045). Passive workflow holds acquire no session residence and run no agent, and live workflow patches carry only the agents that moved.
Not: A second workflow transcript reader or a workflow-scoped output tail.
