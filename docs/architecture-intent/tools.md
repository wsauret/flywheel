# Tools Architecture Intent

This file states how Flywheel executes tools safely, owns the external processes they start, and mutates files.

## ARCH-TOOLS-001: Every tool call crosses one dispatch boundary

Provider-originated tool calls and Code-originated nested calls pass through one shared admission, liveness, execution, publication, and observation boundary with the same gates. Foreground, background, subagent, and workflow contexts create no alternate execution policy, and asynchronous result delivery is never permission to bypass the boundary.

## ARCH-TOOLS-002: One registry and one request plan decide the offered tools

The tool registry is the canonical tool inventory, and one request planner turns it into one immutable plan per request that is the only source for prompt inputs, dispatch, code adaptation, and history projection. A model-specific tool contract is a separate registration that shares one logical identity with its siblings, and every consumer maps a presented name to that identity through the plan, so only the model interaction profile pairs a model with a tool name. Provider wire presentation is a pure projection of the plan and cannot add an omitted tool, rename or reshape a planned tool, or replace the executable map. No consumer copies the tool map or builds a second registry: the request plan is the only tool map any consumer reads.

## ARCH-TOOLS-003: A tool input schema root is one object

Every tool input schema has one object schema at its root. Variants are one flat object with a discriminating enum field, and the handler enforces the requirements of each variant. Request planning refuses to materialize any other root.
Because: One major provider rejects a request whose tool schema root is not an object, so every session on that provider fails at its first message, while another provider tolerates it and hides the defect.
Not: A union root such as oneOf, anyOf, or allOf.

## ARCH-TOOLS-004: Concurrency safety is declared, never defaulted

Every runtime tool declares whether its calls may overlap, with no default. Safe calls overlap within a bounded per-attempt budget; an unsafe call that names its mutation targets reserves their canonical physical paths and overlaps every call whose reservation does not overlap; every other unsafe call, including one whose input failed validation or yields no usable target, waits for active calls to drain and runs alone as the fail-closed fallback. Calls are served in arrival order, and a later call never overtakes a queued one.
Because: Either default silently grants a semantic property that no tool author chose.
Not: A default concurrency classification.

## ARCH-TOOLS-005: Serialization exists only for provable local conflicts

Flywheel serializes only where a local conflict is provable and silent: file mutations serialize per target path, because a same-file write race corrupts without an error. Shell commands and network tools are concurrency-safe, because each shell call is an isolated owned process and remote services own their consistency, so residual conflicts fail loudly in the call's own output. The concurrency cap is load control, never a claim of independence, and per-resource locks supplement attempt-level admission but never replace it.
Not: Serializing every tool, which forfeits bounded parallel reads, searches, and subagents.

## ARCH-TOOLS-006: Every duration has one owner

The shared dispatcher applies an inactivity watchdog to every ordinary tool, and a timeout returns a model-readable result that keeps the tool's own account of the call and aborts the owned execution instead of freezing the turn. A tool opts out only by declaring an unbounded duration and naming another lifecycle owner, such as a user-input wait, a command with its own deadline and cancellation, or Code Mode under its host deadline; the declaration transfers timeout ownership and never authorizes an ownerless wait. A timer inside a third-party client never shares ownership: Flywheel raises it past every Flywheel owner. An agent's wait on managed work carries its own soft timeout, whose expiry returns control to the agent without changing the work's lifetime.

## ARCH-TOOLS-007: Each agent loop observes repeated call sequences once

Every agent loop owns one repeated-call observer that checks each tool batch. A repeated identical call sequence produces a private runtime notice that requires a different approach, instead of silently consuming the remaining budget; a wait that parks on live work does not count, and the observer starts its history again at each person message or Resume. The workflow budget-awareness and context-pressure observers also check each batch and speak through the same channel.

## ARCH-TOOLS-008: The module execution gate changes behavior, not ownership

One module execution gate runs after input validation, deterministic execution policy, capability admission, and concurrency admission, so no stale, disabled, refused, invalid, or unadmitted call reaches it. It reads only immutable normalized call data and its runner's enabled module runtimes, with no effect authority. It gives one of three answers: allow the unchanged core path, veto with a complete reason, or replace execution with a complete function, and its failure refuses the call. A replacement runs under the dispatcher owner, watchdog, permit lifetime, publication, and observation of core execution, and the gate cannot publish, launch processes, dispatch nested calls, hold permits, or bypass earlier admission.
Not: Treating the gate as an approval step or as containment.

## ARCH-TOOLS-009: Code Mode is an ordinary tool whose nested calls admit separately

Code Mode's outer invocation holds no concurrency permit, and each nested call enters the ordinary safe, reserved-path, or exclusive admission independently. Nested calls resolve only against the exact callable map of their request, so a program can neither widen the tool map nor bypass the shared boundary. The interpreter grants the program no ambient filesystem, network, process, import, timer, or evaluation capability, and its Worker isolates the executor's event loop without being a sandbox. Code Mode admission has its own bound, separate from processor admission of shell containers.

## ARCH-TOOLS-010: The shell write-target guard catches mistakes and contains nothing

Every tool that runs arbitrary commands, in every execution mode, answers to the tree-safety, forbidden-Git, worktree-lifecycle, write-target, and read-only rules through one analyzer that enforces the allowance of PI-AGENT-068. The analyzer places write and delete targets statically before any process starts, loads at its point of use without warmup, and never decides tool availability. When analysis cannot load or complete, the command runs, the failure is recorded once, and independent command restrictions still apply. A module rule that protects paths applies its own admission to the targets this analyzer places and adds no command patterns, and the shell's own rule refuses a target the analyzer cannot place.
Because: Shell syntax routes around command patterns, so only resolved targets of recognized effects support a decision.
Not: A hardcoded command deny-list.

## ARCH-TOOLS-054: Command redirection covers only the tools it names

Command redirection toward first-class tools applies only to the tools whose affordances it names.

## ARCH-TOOLS-011: Read-only follows the persona's own grants

An agent is read-only exactly when its persona's own definition grants neither the file edit tool nor the write tool; dispatch derives the mark from the resolved persona, and the persona definition stores no extra field. A read-only agent's shell uses the same write-target analyzer with only its scratchpad and device sinks admitted, and it refuses declared mutating commands. Its shell tool presents the same schema and description as every other agent's, so all agents share one prompt-cache prefix. Read-only limits only the agent's own calls; which child agents it may dispatch follows its subagent grants and, for an agent of a workflow, the trial advisor default (PI-AGENT-044), and a granted child keeps its own persona's tools.

## ARCH-TOOLS-012: One publication path owns every file mutation

Every file mutation, from every edit presentation, the write tool, a declared mutating shell command, or an operator undo, publishes through one shared path that admits current state, prepares the durable operation, publishes under compare-and-swap, verifies readback, and settles durable facts. Parsing and planning receive text and caller-owned snapshots, enforce bounds, and return plans; they never receive a filesystem path and hold no write authority. Final targets that are symbolic links or reparse points are refused. Publication keys on the physical identity of each target while tool output and mutation history keep the logical path, and Git attribution uses the same physical identity and rejects any result outside the selected repository.
Because: One owner of filesystem authority is what lets two edit grammars and shell landings share one race guard, one record of changes, and one recovery.

## ARCH-TOOLS-013: Only Flywheel's own state is created owner-only

Files and directories that hold Flywheel's own state are created owner-only. A tool mutation of a project file applies no Flywheel permission policy of its own.

## ARCH-TOOLS-014: A multi-file mutation publishes a verified prefix and never rolls back

A multi-file mutation fully preflights before it publishes anything, then publishes in planned order and verifies each item before the next begins, and a move publishes its destination before it removes its source. Every failure therefore exposes an exact committed prefix. Prepared intent never proves that an item published, and preflight never makes separate publications atomic; only durable publication evidence proves a file effect.
Because: A cross-file rollback can overwrite user work that landed between publication and rollback.
Not: Cross-file rollback on partial failure.

## ARCH-TOOLS-015: Recovery reconciles only the item that might have landed

After a crash, at most one item of a multi-file mutation can be in doubt. Recovery reconciles only that item and retires the remainder unpublished. It settles the item as not applied only while the exact retained precondition still holds, and otherwise as indeterminate without attributing a change, because matching bytes do not prove that this publication produced them. Plans hold proof metadata and evidence references, never inline file or patch bytes.

## ARCH-TOOLS-016: Stale-read warnings never block an edit

Each agent loop keeps one in-memory ledger of what its reads and searches showed, and a publication attaches a warning when its target was never read, changed since it was read, or was read only in part that misses the replaced lines. The warning never blocks, and a verified publication refreshes the ledger. Read and search output carries ordinary line numbers and creates no editing protocol or cache authority.
Because: Flywheel has no approval gates, and compare-and-swap already refuses the one race that corrupts silently.

## ARCH-TOOLS-017: Undo rests only on exact retained evidence

Undo checks the retained evidence and the endpoint preconditions, and it refuses evidence that is omitted, truncated, sensitive, corrupt, or unavailable. A completed file change records the endpoint access metadata captured from its admitted snapshot and its verified readback as the one home of that evidence. Planned access, inherited defaults, and matching content hashes never substitute for captured access, so a change without access evidence does not prove restoration permissions.

## ARCH-TOOLS-018: Streamed-edit validation is advisory

One lazily started, runtime-owned validation worker serves every runner of a runtime generation, with globally bounded input and per-input scopes that retire with their tool input or attempt. It captures read-only snapshots and never retains path authority, publishes bytes, acquires a mutation permit, or contributes a precondition. Unavailable, failed, late, or retired advice never refuses, delays, or changes a call, and final planning, compare-and-swap publication, readback, and settlement remain the only authority. Runtime disposal awaits the worker's creation and termination, so no worker outlives its generation.
Not: One validation worker per runner, turn, or tool call.

## ARCH-TOOLS-019: Attribution observes settled publications and owns no outcome

Attribution receives only mutations whose durable publication settled, as one immutable job offered at the exactly-once terminal boundary and never awaited. A call with no changes offers nothing, and a partial publication offers only its settled prefix. Attribution state is operation-scoped memory, never a durable fact or a tool-result field, and it never changes, delays, or replaces a tool outcome.

## ARCH-TOOLS-020: Only a declared mutating shell command lands its file changes

A command declared as mutating runs in a private copy of the project as it was when the command started. An interrupted command lands nothing, and any other lands only its accepted file-content changes and removes each directory it removed once that directory is empty. Its evidence names each removed directory once and records, at every settlement, its writes to the session's own folder, which it shares instead of copying and never publishes. A plain shell command writes in place and enters no file-change record or attribution.
Because: A private copy is the only way that another agent's concurrent writes never appear in the command or get attributed to it.
Not: Diffing the shared working tree after a command, which attributes concurrent work to it.

## ARCH-TOOLS-053: A session reuses its mutating-command copy only from a clean, settled state

A session keeps its copy between its own mutating commands, and before each command it returns every entry that differs from the project to the project's state and removes what the previous command left. A copy is never used again while another command uses it, or after its command was interrupted, rejected, or handed over, or its landing did not finish. Nor is it used again after its refresh failed or found its directories replaced, or while a process its command started may still run. Where the host allows it, Linux runs a mutating command in its own process namespace, so every process the command started ends with the command.
Not: Reusing a copy across sessions.

## ARCH-TOOLS-021: A mutating command's copy never publishes repository state

A declared mutating command's copy never publishes Git objects, the index, HEAD, refs, or stash. Repository writes run as separate calls without the declaration, a Git wrapper ahead on PATH refuses repository-write modes before they run, and a semantic repository check before any file publication rejects detected changes and keeps the copy for recovery; read-only Git stays allowed. On macOS and Linux an operating-system write guard also protects the real tree, its registered worktrees, and its Git directories while the copy runs. The boundary is cooperative, not containment.

## ARCH-TOOLS-022: Every external process launches through an owned authority

Every ordinary external process starts through one owned launch boundary whose launcher scope is the whole launch capability that a caller holds. Persistent survival uses only the dedicated persistent-process authority, and raw platform launch stays inside a small fixed set of launch authority modules that a repository check enforces. The browser handoff is the one transfer outside Flywheel: its opener is owned as a bounded process, and only a plain http or https address reaches it.
Because: An external process bypasses its lifecycle owner when any other code launches it.
Not: A direct platform spawn or shell wrapper in ordinary production code.

## ARCH-TOOLS-023: A launch is a container owned before its payload runs

An ordinary launch is an addressable platform container, never a single process id: a process group led by a per-command supervisor on macOS and Linux, and a job object on Windows. On every platform the guardian adopts the container before the supervisor admits the payload, or the launch is refused and the payload never starts; on Windows the supervisor already runs inside its job object before adoption, so a refused ownership ends everything that job holds. The supervisor passes the launcher's own streams to the payload, so no payload byte travels through it.
Because: A payload's exit is not its container's end, and a process id is recycled.
Not: Killing or tracking a command by its root process id alone.

## ARCH-TOOLS-024: Ownership ends at proven emptiness, and release precedes publication

Every owned process settles in one order: the caller closes its inputs and admission, the container is escalated with a grace before forced termination of proven members, the container reaches proven emptiness, readers drain, the ownership lease is released, and only then is the result published. Emptiness, not the leader's exit, ends ownership: process-group membership on macOS and Linux and job membership on Windows. One absolute grace bounds a whole close, and reaching it with containers still held is an explicit unsettled outcome, never a quiet success.
Because: Releasing before publication means a caller that reuses a process id or starts a replacement never races the guardian's kill list.

## ARCH-TOOLS-025: A guardian outside the host owns containers across host death

A process guardian outside the host holds every ordinary container's lease, so a killed host leaves no ordinary work running; on macOS and Linux it also records each lease durably before answering, so the next guardian ends what a hard kill of every owner left behind. The kernel's report that the guardian exited is the only proof of its death, and that proof ends that guardian's work; a failed control channel while the guardian lives ends no lease, and the host ends that guardian instead. One guardian runs at a time, and the next launch starts a new one, so tools launch again with no service restart.

## ARCH-TOOLS-026: Process ownership decisions read only kernel facts

Every liveness, identity, and membership fact that an ownership decision rests on comes from the kernel, and no such decision starts a program. Each fact has three answers: proven absent, proven present with a matching or different identity, and no answer; only an absence or a different identity changes ownership. No answer never ends or releases work and never reads as absence, an admission that must decide at once refuses with the true reason, and each streak of unanswered checks is recorded once with a count of its repeats.

## ARCH-TOOLS-027: The container mark reaches descendants that leave the group

On macOS and Linux every launch marks its environment with its ownership token, and every process that the command starts inherits it, so a stop, an end, and a guardian's sweep also reach marked processes that left the process group. A natural payload exit settles the group alone, so an intentionally detached server keeps running, unless the launch requires strict descendant settlement, which nested launches inherit and cannot weaken. A process that clears its environment, or that a service manager starts, leaves this boundary, and Flywheel never claims that the mark contains a hostile command.

## ARCH-TOOLS-028: A stop hold delays every end but an explicit kill

A launch may declare a bounded stop hold for a payload that a signal at the wrong moment would damage. The hold travels with the launch to the launcher, the supervisor, and the guardian lease, and one emptying path honors it for every end, so no stop, close, crash recovery, or sweep signals the container while the hold stands within its bound. Close and exit deadlines grow by the longest hold they cover, and only an explicit kill command ignores holds.

## ARCH-TOOLS-029: Launch capability is scoped and closes with its owner

A launcher scope closes with the owner that opened it, ends every container it still holds, and refuses every later launch, and a nested scope closes with its parent. A scope can narrow itself to required background scheduling, which every nested scope inherits and none can widen. A close reports what it proved: a container it cannot settle stays held with its reason, and a runtime generation is replaced only after its closure proves it empty.

## ARCH-TOOLS-030: Foreground command ownership transfers only explicitly

A foreground shell command stays in its tool call until it settles, the person detaches that exact call, a planned replacement moves it, it reaches the foreground hold cap, or the turn aborts. Registration with the session registry is the ownership linearization point: before it, a turn abort ends the container, and after it, the session owns the process, its readers, and its result. A process that settles first completes as a foreground call and never becomes background work, and the transcript's controls follow the current owner.
Not: Implicit detachment as a consequence of a tool returning.

## ARCH-TOOLS-031: A background command is a service, not owed completion

A command launched in the background transfers to the session registry at once and does not hold the completion of a bounded run, while the close of its scope ends it like any owned work. An agent that must hand off cannot do so while a service it started still runs. A wait on managed work parks on every live process of the session.

## ARCH-TOOLS-033: An explicit timeout is a hard deadline across every transfer

A command's explicit timeout is bounded, starts at launch, counts only the time that its container is not held for processor time (ARCH-TOOLS-051), and stays its hard deadline after a transfer to the registry and across a handover between builds; at expiry it ends the container and publishes only after settlement. Without an explicit timeout, a transfer adds no deadline.

## ARCH-TOOLS-034: Persistence is admitted only by explicit authorization

No background request, foreground cap, detach, replacement handover, or close implicitly admits persistence; only the authorization that PI-AGENT-047 states does. Disabled policy omits the persistence opt-in from the tool schema and rejects a stale request, and a platform without a persistent contract refuses before any launch. The command-line host owns the persistent-process manager, while the runtime composition, every runtime generation, and headless runs hold ephemeral clients, and closing a client never releases persistent work.
Not: Treating detachment, session leaders, double forks, or service-manager registration as managed persistence.

## ARCH-TOOLS-035: A spool is removed only when every holder is proven gone

A persistent launch records each spool holder, the launcher and the writer, by process id and kernel start identity before its payload is admitted. A spool is removed only when every recorded holder is proven gone, by the launcher that reaps its writer or by the next persistent launch's sweep of the per-user spool root, and a spool whose holders cannot be proven gone stays.
Because: A writer cannot see its own end, since a killed process runs no cleanup and the writer does not know its output is a spool.
Not: The writer removing its own spool.

## ARCH-TOOLS-036: Each platform's process guarantee is stated, never assumed

macOS and Linux guarantee process-group ownership with the container mark, proven through the kernel's group membership. Windows guarantees a job object created before its payload, which ends with its last handle and admits no breakaway, while a persistent Windows process, which no handle may hold, is stopped through a bounded tree walk checked by creation identity that can report an unsettled outcome. Background priority lowers scheduling preference only and claims no affinity, reservation, or quota, and a processor hold stops a container's payload processes and claims no reservation or quota either. Hostile escape always requires an external sandbox, and no document or test claims parity the platforms do not have.

## ARCH-TOOLS-037: Supervisor diagnostics never enter command output

A command supervisor sends its diagnostic records through its control channel, never through the payload's output streams, and the process that launched it relays each record once to its own log. Payload bytes stay unchanged, including text that resembles a diagnostic record.

## ARCH-TOOLS-038: Package files are read only under declaration and containment

The skill tool reads packages and, under a grant, runs a package's child: its load and resource actions are read-only and concurrency-safe, and return a package's instructions or one file that the package declared when it loaded. Each read must name a declared path that still resolves inside the package to a regular file, and returns one bounded, strictly decoded window measured against the opened file, paged by offset rather than truncated or handed to a general file read. Its child-run action executes only a declared script of a package that the orchestration grant of the attempt names, after it proves that the script bytes still match the identity that was admitted, and package text never conveys that permission.
Because: An installed package is third-party content whose tree can change between discovery and read.

## ARCH-TOOLS-039: Autonomy and containment are separate

Flywheel has no general allow, ask, or deny policy language, per-tool approval, or bypass mode. Prompt guidance, command redirection, write-target analysis, the read-only rule, skill scope, the module execution gate, and workflow launch confirmation are mistake guards or domain decisions, never containment, and recorded facts give accountability after execution, not prevention. Containment comes only from an external environment boundary, and a change to this model requires a new architectural decision based on a different audience or deployment requirement.
Because: Pre-invocation approval conflicts with hands-off operation and cannot contain an agent that runs arbitrary processes.
Not: A general pre-invocation approval system or a hardcoded command deny-list.

## ARCH-TOOLS-040: A preview budget never truncates the returned value

A preview budget limits only what a preview shows. It never truncates the value a tool returns; an oversized result is retained by the ordinary tool-output boundary. A tool that drops part of its output marks each dropped run where it occurred, counted against the original, and hands that boundary the full payload, or a file it already retained with its measured size and digest; only that boundary names the recovery file.

## ARCH-TOOLS-041: Workspace traversal follows directory links and stops at protected roots

Agent workspace listing and directory search follow only directory links and never admit linked regular files to walked content search. Runtime assembly derives one set of protected roots, the credential-bearing account storage, and discovery stops before it enters one through a link, while an explicitly requested root stays reachable; walks leave out the pruned directories of the search rule set, which include the project state directory. One bounded native worker owner serves list and search: deadlines return promptly, a permit is held until its worker exits, and acquisition is bounded by the call's deadline.

## ARCH-TOOLS-042: A Code Mode Worker is reused only when nothing of the earlier invocation can reach it

Code Mode invocations run on a bounded pool of reusable Workers with fair admission across sessions, and a Worker runs one invocation at a time. A Worker serves a later invocation only after its program returned on its own and a reset dropped every pending bridge call and measured a fresh heap baseline; every other ending terminates the Worker, and a terminated Worker is never leased again. On every exit an invocation detaches its bridge, returns or ends its Worker, and aborts and joins every nested call before its result settles, and the host owns the one execution deadline. A Worker shares the process, its memory, and its native resources, so its heap budget is a sampled watchdog, not a hard cap.
Not: Treating a Code Mode Worker as a security sandbox or its heap budget as an enforced limit.

## ARCH-TOOLS-043: Git AI attribution is isolated runtime infrastructure

Git AI attribution is runtime infrastructure, not a selectable module, a durable fact family, a retry authority, or a tool-execution gate. Each project runtime owns one attribution service keyed by its canonical repository, which serializes checkpoints through one bounded lane, invokes Git AI only through owned commands, and isolates every discovery, launch, timeout, status, cancellation, and disposal failure from tool behavior. Request admission supplies it an immutable profile and transcript capture, so a later configuration or profile change cannot relabel a captured request.
Not: Modeling attribution as a tool-execution gate or a module.

## ARCH-TOOLS-044: A tool states its policy once, and the serving model selects its registration

A tool declares its action, category, persona grant, clone inheritance, and order once, and a tool with a shell registration also declares the command and directory of each call. Each registration of a tool declares one presentation with its wire shape, its provider-visible name, and a description for each wire form it can take. For each exposed name, the serving model's admission selects exactly one registration, which dispatch uses and history and the request audit record. Settings, grants, allowlists, gate call data, hooks, prompt assembly, and history readers name a tool, never a registration, and resolve a recorded or provider-visible name to it through the registry.
Not: Rewriting one registration in place for each model.

## ARCH-TOOLS-056: Every caller resolves the interaction profile through serving-model policy

Interaction profile resolution is serving-model policy, shared by chat, workflow workers, subagents, retries, capped requests, failover, and direct headless tasks. A literal headless system prompt reaches the provider byte for byte, without profile guidance or provider notes.

## ARCH-TOOLS-045: Tool contributions settle against the planned set

A tool factory answers the tool, an omission reason, named sub-omissions, or a refinement that settles the tool against the planned set. A registration declares its interaction contract (the file edit grammar it presents), provider-visible name, allowlist identity, and capabilities, so the planner names no module. Tools that exist only inside the code projection arrive through a code-tools contribution that the planner folds under the code registration, so neither the planner nor the code module names a tool server.

## ARCH-TOOLS-046: One module owns the runtime-invocation tool

Exactly one installed module contributes the runtime-invocation tool: its provider-visible name, its execution facets, and the call input that each recorded invocation of any version stands for. Kernel tool-execution, tool-result, transcript, and child-reconciliation readers read that one installed owner and do not name the tool.

## ARCH-TOOLS-047: Persistent launch and stop follow each platform's contract

On macOS and Linux a persistent process runs under the shared supervisor as a detached group leader with a retained control channel and no guardian watch, and its stop is a request over that channel, never a signal from the host to its group; a stop that does not settle within its bound reports unsettled and can be retried. Flywheel's own project runtime is the one self-managed persistent launch, and an unsupported platform refuses before spool creation or launch. ARCH-TOOLS-036 states the Windows contract.
Because: A process that must outlive Flywheel cannot be held by a handle that dies with Flywheel.

## ARCH-TOOLS-048: Special launch authorities stay bounded

The terminal-successor authority starts only the build that a terminal follows where the platform cannot replace a process image, sharing the shell's foreground job and terminal, and it is not a general launch surface. The Windows private-directory authority admits private roots through native security interfaces that refuse before private data is written, caches only the immutable account access list, and uses bounded system commands only for read-only verification.

## ARCH-TOOLS-049: A consent mutation without an Ask User surface is refused at its tool

A mutation that requires consent, in a request that has no Ask User surface, is refused at its tool boundary, and the refusal advertises no recovery tool that the request cannot use. Ask User decision variants derive from the final planned owner tools, so an allowlist never advertises a decision for an omitted operation.

## ARCH-TOOLS-050: A remote call without an answer has an unknown outcome

A remote call that ends without an answer has an unknown outcome. Its result says that the effect may have completed and must be checked before the call repeats, and a Code Mode result names each nested call that still runs.

## ARCH-TOOLS-051: Processor admission is measured, never declared

Independent of agent and workflow caps, one governor in the account service measures the processor demand of each owned command container, its ready threads, against a budget of the machine's logical core count. While Flywheel's processor-heavy containers exceed that budget, it holds the newest by stopping their payload processes, never their supervisor, and releases the oldest held one when budget frees. A held or blocked container has no ready threads and frees budget, so a hold never deadlocks running work. A container that a chat's own turn starts is never held and counts toward the budget.
Because: On a saturated machine every command slows and none finishes, and processor time then measures only each container's share of the machine, not its demand.
Not: Launch-time command slots or a cost that the agent declares, because a command's cost is unknown before it runs.

## ARCH-TOOLS-052: One rule set bounds every agent file search

One search rule set owns the limits of every agent file search: a limit on the processor time that a search spends, a wall-clock backstop for a search that only waits on reads, and the pruned directories, which are fixed artifact names and the directories that the repository's ignore rules exclude, with a directory that the call names always reachable. The search and list tools apply it in process and count the processor time of every thread that works on a search. On macOS and Linux, the agent shell applies it through shims that run the person's own search programs, and a shim adds only exclusions and the limit: it never translates one program into another or shapes its output. A depth-first walk cannot skip a directory, so its shim leaves the pruned directories out of the results instead.
Because: A wall-clock limit on a shell program also counts the pipe that it filters and the load that it shares, so it kills narrow searches and filters of long commands.
Not: Redirecting grep to rg, because the two programs read the same flags and patterns differently and the result is silently wrong.
