# Runtime Architecture Intent

This file states how the runner host, process placement, the account service, and runtime configuration are organized.

## ARCH-RUNTIME-001: One runner host serves every agent invocation

Every agent invocation, including chat, workflow agents, subagents, direct headless tasks, benchmarks, learning reviews, and title generation, runs the same agent loop through one runner host. Each caller's differences enter through typed ports for input, tools, capabilities, persistence, observation, and result, so no caller creates a parallel loop, lifecycle, or runtime mode. A direct headless task composes that same host in the CLI process with shared bootstrap and ordered disposal. Only the chat composition supplies an ask-user port, so only a chat asks the person.

Because: Caller-specific ports express capability without parallel semantic runtimes.
Not: A runtime or mode registry that switches agent semantics per caller.

## ARCH-RUNTIME-002: The runner host consumes authorities and owns none of them

The runner host owns runner-context construction, one logical turn lease, explicit resume, interruption, settlement, and the prepared model presentation of each serving attempt. It does not own provider-request admission, workflow control, session lifecycle, durable conversation authority, benchmark policy, or capability admission: it consumes those owners through ports and mirrors none of their state.

## ARCH-RUNTIME-003: One recovery policy restarts unattended runs

One unattended recovery policy decides whether a failed run of a workflow agent, subagent, or headless task runs again from its recorded conversation, and it never retries or fails over inside a request. It is the single recovery hook of those turns, so no other layer keeps a restart count, and it counts served requests in memory without reading durable state. A run that the policy starts again keeps the limits that the failed run used: its model-call budget continues from the calls already made, and a failure that a limit ended, such as the output-limit continuation limit, stands and does not start again. A run that every candidate refused until a stated time waits as a capacity wait, which, in a run that a project executor serves, records its continuation authority before it waits (ARCH-SESSIONS-039), so the wait outlives its process; a headless task's wait lives and ends with its own process. A chat takes only the capacity wait from this policy: any other failed chat run ends, because a person decides whether to send again.

## ARCH-RUNTIME-004: Headless chat is a frontend over the production runtime

Headless chat is a frontend over the production project runtime, not a second chat composition: its commands reach the ordinary client mutation and query boundaries, and its output derives from the same session and conversation projections. The runtime owns profile admission, failover, questions, child supervision, durable history, and the decision that the agent is done. The frontend owns only framing, correlation, and input-stream lifetime, and never answers a question on the person's behalf.

## ARCH-RUNTIME-005: One account service is the sole public serving placement

One resident account service per account and lane is the sole public protocol and control placement, and each project has at most one open composition inside it, so every surface reaches the same live sessions. The account service renders nothing: the terminal, editor windows, browsers, and paired devices are all its clients. Each project composition keeps its own event store, projections, and writable fact lane, and account routing and process initiation never become project facts.

Because: One shared live session across every surface needs one runtime per project.
Not: A runtime inside the terminal process, which gives a project one runtime per open surface.

## ARCH-RUNTIME-006: Interactive production runs in three placements

Each open project runs in three placements: the account process owns the public protocol, control, the public UI sequence, passive history reads, and startup maintenance; one state Worker owns the primary store, session lifecycle, ordered writes, generation fencing, and recovery; and one lower-priority executor process owns the runner host, providers, tools, transcripts, model resolution, and conversation search. Placement and transport change without creating another logical runtime. A focused test may host a composition in-process to remove transport cost, but it substitutes placement or transport only: no production backend selector or alternative runtime semantics exists for tests, and an in-process test proves neither process isolation nor socket lifetime.

Because: Provider and store bursts must not starve public control and rendering, and a turn must outlive the client that started it.
Not: Running the runtime on the terminal's render event loop.

## ARCH-RUNTIME-007: A project's composition moves as a whole

A project's control composition, state Worker, primary store, executor generations, and working tree are always on one machine. A project runs on another machine only when that machine's runtime opens the whole composition.

Because: Write acknowledgement is one round trip per item, recovery reads the working tree and the process table, and process exit is observable only on the same machine.
Not: Running the executor on a different machine from its state Worker and primary store.

## ARCH-RUNTIME-008: Installed and dev lanes never share account state

A compiled build serves the installed lane and a checkout run serves the dev lane, and the running executable alone decides which, once at startup. Every lane-scoped account resource, such as discovery, the attach credential, the identity record, the start lock, the hub port, relay identity, and remote pairings, derives from the account data root and the lane, and a client dials and starts only its own lane's service. Resources that serve one device across both lanes, such as the terminal's paired-device record and each device's push subscription, are machine-wide and independent of either lane's pairings. The dev-lane service is never resident and retires soon after nothing holds it.

## ARCH-RUNTIME-009: A project is open in one process of one lane

A project is open in at most one process of a lane and in at most one lane at a time. Same-lane replacement is exclusive: the outgoing service skips recovery only by releasing its sole serving holder atomically after a durable flush, and otherwise the successor runs full recovery. Discovery records are discovery only; each open project's state generation lease is the sole guard over durable state.

## ARCH-RUNTIME-010: The account placement does no heavy work on its event loop

The account placement constructs and invokes no runners, providers, tools, or primary store connection. Its heavy account-wide work, such as update file work and startup maintenance, runs on owned Workers off the account event loop, and no project executor composes either. Imports on the account path perform no eager expensive initialization.

## ARCH-RUNTIME-011: Auxiliary Workers are bounded owned resources, not runtimes

Auxiliary Workers, such as those for history, maintenance, update installation, edit copies, model documents, Code Mode, and hard-exit timing, are owned resources inside one process lifetime, never agent runtimes or detached services, and none shares the primary write connection. One reviewed Worker construction authority and one registry of per-role generation budgets bound every role, so no restart path can create unbounded native handles. Filesystem and interpreter work run on these Workers so they never block the executor event loop.

Because: Each Worker retains a native resource for its lifetime on some platforms, so construction is a safety contract, not only retry policy.

## ARCH-RUNTIME-012: Startup protects two foreground milestones

Startup has two foreground milestones, the first interactive frame and chat runner readiness, and work that neither requires stays off their path. Views load on demand, and noncritical initialization, preloading, warming, reference publication, and maintenance run only through owned deferred or background execution with contained failures.

## ARCH-RUNTIME-013: Warming uses the admission owner that serves real sessions

Initial warming is shared per runtime, reuses its success, and permits retry after failure. Chat warming prepares the effective auth profile through the same admission owner that serves real sessions, and the first send reuses what it prepared. A provider engine pre-start prepares its request through the same request preparation that a send executes and hands the prepared request to the provider; it builds no turn, settles no usage, records nothing durable, and claims no recheck or routing state. Shutdown joins admitted warming and reference publication before it releases runtime projections.

Not: A warming-only profile selector or dependency cache.

## ARCH-RUNTIME-014: Startup status precedes the protocol and comes from one step catalog

Startup status reaches clients before the protocol serves: the account service reports process startup and any death before it can serve on its handshake output, and each accepted socket answers account attach with phases, failure, or ready before protocol framing begins. Every phase is one step of an ordered startup catalog in the published protocol; producers name only a step, and only the account service turns it into words, so a skipped step keeps its place. Concurrent callers join one start, and startup status never enters the event lane.

Because: The blocking window is exactly the time before the protocol server exists, so the event lane cannot carry it.

## ARCH-RUNTIME-015: Nothing converts durable state before a start is confirmed

An account service admits project opens, starts account module services, and starts the update coordinator only after its start is confirmed after the listen. Until then it listens and answers, writes only bookkeeping that every build reads, and an open that waits claims no project, so it neither counts as opening nor blocks a replacement. A malformed account configuration starts on defaults and never counts as a failed start.

Because: The rollback of a start returns only from a build whose service never listened, so that rollback never meets durable state the failed build converted.
Not: A migration mark that refuses the rollback after a conversion.

## ARCH-RUNTIME-016: Passive reads never start an executor; transcripts come only from the executor

Passive catalog, detail, workflow-view, change-summary, and module reads for sessions with no published execution activity are served by the account's history Worker and never acquire an executor generation. Only the executor builds a transcript, and an open tab's transcript is its runner's, so a transcript read starts or waits for an executor and the transcript is built once. Any executor-published activity keeps all of that session's reads on the executor.

Because: Browsing history must not wake lower-priority execution, and live tail and settlement state stay intact only where they are produced.

## ARCH-RUNTIME-017: Executor readiness never resolves a serving profile

Executor readiness never resolves or prepares a serving profile. The account retains the resolved chat default as pending, none, or an exact model and effort across executor generations, seeds each generation with it, and publishes it as a latest-collapsible view; tier vocabulary never crosses the client boundary. Profile choice and provider admission are captured only when the person sends or resumes work.

## ARCH-RUNTIME-018: Generation acquisition is the one owner of executor restarts

Generation acquisition in the project's control runtime is the one owner of executor restart policy, and work is handed only a generation that reported ready. A generation that ends unasked leaves the project paused until input, an open tab, a transcript read, or a due capacity wait asks for execution, and repeated early deaths back off without refusing input. A generation's own startup error never reaches the input; only a failed recovery refuses, in the person's terms.

## ARCH-RUNTIME-019: Account-executor channels behave like pipes, never fuses

The account and an executor generation communicate over authenticated private channels for state, output, lifecycle, and control. A full queue makes the sender wait instead of rejecting or closing, a message that cannot be framed fails alone, and lost output becomes one gap that the account repairs from the store. A lost socket detaches its channel rather than closing it, and requests in flight on it fail as unknown outcomes, never replayed.

Not: Closing a channel or ending a generation on backpressure, a lost socket, or an oversized message.

## ARCH-RUNTIME-020: Process exit is the only death signal

Process exit, observed through owned-process supervision, is the only death signal; a socket close never implies death. Executor responsiveness is judged by account-side heartbeat periods in which a host sleep or an account stall adds no silence, and a wedge proof ends a generation only while something waits for it to answer. A start has no deadline while heartbeats continue, and the account records the cause of every generation end.

## ARCH-RUNTIME-021: Execution runs at lower priority inside a normal service class

The executor, its command supervisors, and tool commands run at a lower OS scheduling priority established before their payload starts, while the account process and the state Worker are not lowered. Every service registration runs the service tree at the normal interactive class, with no manager stop for elapsed time or battery state and no stop timeout shorter than the service's own drain.

Not: A background-class service registration, which throttles every descendant with no way out.

## ARCH-RUNTIME-022: Durable and diagnostic event delivery are separate lanes

Runtime event subscriptions select their event types before queue admission, and each type group keeps cross-type order through one queue. Durable fact mapping and disposable diagnostics use separate subscriptions, so streaming deltas and diagnostics never queue behind a database write. A full reliable lane pauses its source as cooperative flow control, cancellation never cancels accepted facts or skips usage settlement, and durability barriers stay separate from flow control.

## ARCH-RUNTIME-023: Client holds decide a session runner's lifetime

Each client connection holds the sessions it shows, and the account service orders each session's activations and releases on one lane, so the executor learns once when the last hold ends. The executor then ends the runner only when its turn is at rest, and a new activation cancels that end. A release never closes, renames, removes, or changes the lifecycle of a session. The close of a chat's tab adds a close at rest: the executor closes the chat as an explicit close does only once its turn is at rest, and a new activation cancels that close too, so a chat is never inactive while its runner works. Only an explicit close, Close chat, ends a chat's work at once.

Not: Ending a runner when its surface closes while a turn is in flight.

## ARCH-RUNTIME-024: Project holds decide whether a stop is a restart or a close

The account's surface registrations, including holds the service takes on a surface's behalf, decide whether a project is held, and the account sends that answer with each executor stop. A stop while the project is held is a runtime restart and keeps every session; a stop with no hold is the close of every tab. An executor that cannot know the clients, as after its service vanished or during a failed startup, keeps everything, and an unreadable conversation record counts as content.

## ARCH-RUNTIME-025: Project open and close affect only that project

A project open is one acquire-or-release boundary: a failure closes every partial bridge and channel before failure is published or a retry is permitted. Closing a project withdraws its maintenance, settles or recovers its executor, and releases its state while leaving the account's shared resources and sibling projects intact; a close that cannot settle leaves the project failed, and the next attempt retries only the owners that did not settle. Idle reaping closes a project only after its local, browser, and relay holds are gone and it reports no live work, and never stops the account service or a sibling project.

## ARCH-RUNTIME-026: Every open project owns its browser endpoint off the critical path

Every open project owns its loopback browser endpoint, whatever surface opened it. Endpoint startup begins after foreground readiness and never gates terminal admission, project shutdown joins that startup, and a failed start leaves the project serving its other clients and permits a fresh attempt.

## ARCH-RUNTIME-027: Shutdown bounds nest so the inner bound ends first

Shutdown bounds form one nested chain: an executor's own hard-exit bound lies inside the account's stop of that executor, which lies inside the account's drain bound, which lies inside the service manager's stop timeout. An executor that never reported ready has served nothing and is ended at once, outside the chain.

## ARCH-RUNTIME-028: Account shutdown withdraws from discovery before it drains

Account shutdown first withdraws from discovery, stopping its listener and removing its identity record, so a successor can claim the address while it drains. Nothing removes the address after that, and a start removes a stale address only when its probe proves that nobody listens. The drain settles every project under the drain bound, a successor's open of a still-closing project waits for its release, and an unsettled project is reported only after every sibling has settled.

## ARCH-RUNTIME-029: Disposal is ordered and awaited

Disposal runs in order and every step is awaited: session-type cleanup, then flushing of budget, conversation, and event writers, then file handles, scopes, roots, and logs. Writer lanes, save points, and logs are data-loss boundaries. Client reactive cleanup belongs to the client's ownership roots, while processes, streams, file handles, and scopes need explicit disposal.

Not: Fire-and-forget disposal.

## ARCH-RUNTIME-030: Floating aborts are contained; other uncaught failures end the process

A floating abort on the account, executor, background, or maintenance thread is contained with one coalesced warning, because an abort proves that its owner withdrew the work. Every other uncaught failure there ends its process or Worker with one redacted record and no ordered shutdown, because the state it would stop from is not trustworthy; an executor first flushes its durable writers briefly.

## ARCH-RUNTIME-031: One replacement owner decides when a service makes way

The account service makes way for a successor through one replacement owner, for a newer installed build, a changed registration, a changed dev-lane source, a return to the lane's last proved build, or a person's restart. A service is superseded by a build only when the build it executes, read from its own executable at start, differs from the installed current build; a client's cutover request is a hint that the service checks, and no running process replaces its own executable. A replacement waits, with no deadline, only for an admitted call that has not returned and a project still opening or recovering; no running work or idle client delays it, and an executor proven wedged meanwhile is ended as after a crash.

Not: Retiring a service on protocol difference or when its connection count reaches zero.

## ARCH-RUNTIME-032: A replacement handoff is lane-scoped account state

A replacement's handoff is one lane-scoped account record naming the open projects, never a copy in each executor, and every generation that serves while it exists joins it before serving input; work admitted after the cut is never refused and receives the same cut. The successor of the same lane consumes each handoff after it listens and off the attach path, opens only projects with work to continue, a command to adopt, or a surface to serve again, and continues each owed session at most once through that session's ordinary resume. The other lane never reads it.

## ARCH-RUNTIME-033: Running commands cross a replacement and are never rerun

A planned replacement never waits for, ends, or reruns a running shell command, including a child session's; it first moves held foreground commands to the background and hands each running command, through the command's own supervisor, to the successor build's owner, which adopts it before it resumes any session. Only the command crosses: its output is a log file, and its exit status and deadline belong to its supervisor, which keeps its build declared live until the command ends. An adopting owner proves the supervisor alive before it takes the command, so a reused process id is never adopted.

Because: Waiting would keep every project and client of the account on the previous build for as long as one command runs.
Not: Waiting for running commands before a replacement.

## ARCH-RUNTIME-034: Cross-build handover state carries versions

Every record and channel word that two builds read across a replacement carries a version from its first release. A supervisor answers a word of a version it does not speak by naming the versions it does, and a reader that meets an unknown version reports it, leaves it unchanged, and offers no control that nothing could answer.

Because: Two builds read the same in-flight state across a replacement.

## ARCH-RUNTIME-035: A Windows executor container releases its members' children

A project executor's Windows container is the one container whose members' children leave it silently, and only from the moment the executor runs in it, so the executor is owned from its first instruction. Every process that leaves keeps an owner of its own and only a command's own container decides its end, so the executor's exit ends no command that a planned replacement handed over.

## ARCH-RUNTIME-036: A terminal follows the build that serves

An attached terminal follows the serving account service's announced build identity and never infers it from the installed current build while another build serves. When the serving build is current but speaks a protocol the terminal cannot, the terminal re-executes into that build after it checks the build's metadata, and a client that cannot re-execute reports it.

## ARCH-RUNTIME-037: The registered job is the only starter where it is registered

A client finds the account service or starts it. Where a service-manager registration in the login home is loaded and enabled, that job is the only starter: a client asks the manager to start it and never launches a twin beside it, and it launches the service itself only where nothing is registered and enabled. A client launch is the explicitly authorized persistent kind and uses the installed build, and a client that has begun to exit starts no service.

Not: A client-launched service beside a registered job, which holds the address while the job parks or respawns against it.

## ARCH-RUNTIME-038: Only a proven login home registers or changes a registration

Process initiation registers the service with the platform service manager only when the account home is the login home; an isolated account home registers nothing and reports initiation unavailable. A running service writes, reloads, or re-registers its own registration only when its manager started it and the login home is proven, and an unanswered proof is never remembered.

Because: A registration made from another home would run against the login home under the label and hub address that the login account's service holds.

## ARCH-RUNTIME-039: Registration changes never cut running work

Only an installation a person asked for creates a missing registration; an update refreshes an existing registration and never creates one, and a healthy running service is left undisturbed. A changed registration applies without cutting running work: no process inside the service's own tree stops or unloads its own job, and a stop that a step needs is performed by a transient service-manager job outside the tree. Uninstall and turning Process initiation off share one path.

## ARCH-RUNTIME-040: Only a proven-gone holder is reclaimed

A start lock, holder record, or owner record is reclaimed or swept only when its holder is proven gone; a holder the kernel does not answer for, or a record that cannot be read, still holds. Residency and manager-start decisions rest on what the kernel and service manager state, never on a probe that can fail open.

## ARCH-RUNTIME-041: One exit-code contract drives every service manager

One exit-code contract tells every service manager whether to start the service again: a start that must not run again exits as success, a retirement for a successor or a refusal that can clear exits with a dedicated restart code, and any other failure exits as an error. Flywheel ends its own process tree on stop, so no registration lets the manager kill the tree or stop the whole service for one process's out-of-memory end.

Not: A control-group kill on stop, which ends persistent work and kills executors in the middle of their drain.

## ARCH-RUNTIME-042: Only a build's own start failures park its service

Every start of the installed account service counts itself toward its build's rollback before command composition loads and takes the count back when it ends for a cause that is not its build's, such as another owner already serving, a busy port or lock, or a signal; a failure after the listen never counts toward that rollback. A start that fails before it listens or within its first minute of serving joins the lane's failing streak, and a sustained failing streak parks the lane's job until a start serves, but a self-clearing refusal or a build that the release rollback can still replace never parks. A parked service runs one start per client start request, and repeats of one park condition coalesce into one count.

## ARCH-RUNTIME-043: Update work has one account owner, off startup and render

The account service composes one update coordinator for the account, which runs whether or not a project is open, and no project executor, client component, or detached daemon owns update work. Checks begin only after the start is confirmed and a deferral passes, byte-heavy file work runs on an owned Worker that starts only for an admitted install or a collection with something to remove, and an install's commands launch in a guardian generation of the account service that the job opens and closes. Disposal awaits the timer's cancellation, the job in flight, its processes, and the removal of uncommitted staging; the manual update command composes the same coordinator for one run.

Because: An executor's exit would cut an install, and an account with no open project would never update.
Not: Update work in each project runtime.

## ARCH-RUNTIME-044: The account service runs startup maintenance one job at a time

Each open project admits one startup maintenance job after its foreground readiness, and the account service runs the jobs one at a time in one-shot Workers. A job reads the store read-only and writes only through its project's state Worker, runs deterministic maintenance before optional cleanup, contains cleanup failure, and is withdrawn and joined when its project closes.

Because: Maintenance contends for the store's write lock, so readiness comes first and jobs never overlap.

## ARCH-RUNTIME-045: The account service owns the login-shell PATH

The account service learns the login shell's PATH once, after it listens and off the attach path, through the owned command authority at background priority within a bound, and reads only PATH from the probe. Each executor generation receives that PATH on its lifecycle channel and never probes itself. A failure is not kept, so a generation that opens while PATH is unknown asks the account to probe again, and a PATH once found is kept for the service's life.

Because: A service started by a service manager has only that manager's minimal PATH, so only the login shell's PATH resolves the same binaries on every launch lane.

## ARCH-RUNTIME-046: Shell load is admitted by processor use, not by container count

No project runtime bounds how many shell containers run. Each project executor registers every shell container it launches or adopts with the account's processor admission (ARCH-TOOLS-051) until its owned exit observes an empty container or it hands its command to the next build, and the account releases every container of an executor generation that closes. Stop, Detach, and owner shutdown never wait for admission, and admission changes no ownership, persistence, or containment.
Not: A per-project count of shell containers, which bounds no processor use and queues cheap commands behind idle services.

## ARCH-RUNTIME-047: Engine child-completion notices never reach the parent

When children of one chat tree share an engine process (ARCH-PROVIDERS-006), the engine's own child-completion notices never reach the parent or the engine's dispatcher; completion reaches the parent only through Flywheel's completion reconciliation.

Because: Each child notice reaches a running parent as new input, so a parent cannot share a process whose own notices start turns.

## ARCH-RUNTIME-048: Module process services are built in dependency order

A module can declare a process-scoped service that one owner constructs in dependency order when activation reaches it (ARCH-STRUCTURE-027), and a module reaches another module's service only through that module's exported handle after declaring the dependency. Optional monitoring starts after kernel authorities exist, not during construction. At shutdown the owner closes admission and disposes every instance once in reverse dependency order before the event store writer closes, and one disposal failure does not stop the others.

## ARCH-RUNTIME-049: Portable services serve every composition that builds runners

A service whose factory reads only the portable kernel declares itself portable, and every composition that builds runners, interactive or headless, constructs it through the same activation walk. A headless run awaits each portable service's startup settlement before its first request; the interactive runtime never waits on a settlement.

Because: Headless runs, their workflow agents, and their subagents must reach the same module services as interactive sessions.

## ARCH-RUNTIME-050: Service placement comes from the one catalog

One installed catalog declares each module service's operational host as account, control, or execution. Each host gives a service only the ports of that host, and a disabled factory is never called.

Not: A separate module registry for each host placement.

## ARCH-RUNTIME-051: Account services reconcile on declared inputs

An account-lifetime service declares the configuration inputs its constructor reads. Reconciliation keeps each selected instance, with its live project resources, while those inputs stay unchanged, and a selection or input change disposes only the affected instances before constructing their replacements. A service that cannot start is contained to its module: the account service keeps serving without it, records the cause once, and hands the cause to that module in every open project, which states it where the module's state already shows. The failed service retries when its inputs or selection change.

## ARCH-RUNTIME-052: One notification service per serving host

The account composition of an interactive project owns the one notification service, and an executor forwards the notify seam to it; a standalone execution host owns the same service over its local store. Shutdown stops producers first, then settles the notification sink and publisher before the store writer closes, and a notification durability failure blocks a successful shutdown result.

Not: A second notification service inside each executor.

## ARCH-RUNTIME-053: The Remote module contributes one account-lifetime relay service

While enabled and paired, the Remote module contributes one account-lifetime relay service that announces each project's state and the machine placement, routes remote wake and remote creation through the canonical account project lifecycle, and serves admitted device channels without another coordinator. A relay service that cannot start leaves the local surfaces served, and turning the module off closes its channels and releases only its project holds.

## ARCH-RUNTIME-054: Modules register transports without the kernel naming them

A module registers a transport listener before serving starts or after a live enable, and releasing the registration closes its serving on disable. The kernel builds one fresh protocol serving over each socket layer, shares the handler set, and counts every attached client for the idle reaper without naming a module.

## ARCH-RUNTIME-055: Reviews and observers are composition generations

Chat reviews and observers are owned generations of the selected composition, and each optional factory or callback failure is contained independently. Retiring a generation stops new delivery, joins admitted hooks and reviews, and disposes its resources, and a module observer releases the old runtime instance before it observes the new one.

## ARCH-RUNTIME-056: One config projection owns ordinary configuration reads

One runtime config projection is the resident authority for ordinary configuration reads, and it decodes canonical config bytes through one pure decode boundary that changes no file, store, resource, or subscriber. Conversion of retired config shapes, including module-selection vocabulary, happens before that decode under the config ownership lock, preserves the old intent, and publishes in one atomic, byte-idempotent rewrite. Ambiguous, malformed, or unclassifiable bytes are refused without changing one byte, and a failed conversion publishes nothing. Runtime code keeps no second decoder, normalized config cache, or startup-threaded config copy.

Because: Each feature that decodes its own copy invents its own freshness, malformed-input, and publication semantics.
Not: A config decoder or cache per feature.

## ARCH-RUNTIME-057: Config publications are immutable revisions with a closed status set

The config projection publishes immutable snapshots with monotonic revisions, a source identity, warnings, diagnostics, and one status from a closed set: missing, valid, malformed, or disposed. A malformed publication carries the fallback that PI-INTERACTION-076 requires and records which fallback is in force, and an invalid module selection alone retains the last valid selection for only its own fields while every other valid setting applies. A reread equal to the current publication does not republish, and disposal retains the final value and refuses later mutation.

## ARCH-RUNTIME-058: One general watcher, and every change notice is a reread hint

The config owner holds the only general watch of the canonical config file, and a filesystem notification is an invalidation hint that causes a fresh reread, never content or ordering authority. A one-shot command constructs the same owner with watching off and disposes it, and the account service keeps one watch whose hints refresh its own watcher-free owner and the update policy. No domain keeps its own watch or a refresh callback that decodes its own copy.

Because: Filesystem events can coalesce, reorder, or name an intermediate write.
Not: Using filesystem event payloads as configuration, or one watcher per feature.

## ARCH-RUNTIME-059: The owner queue comes before the cross-process config lock

Refresh, publication, mutation, subscriber settlement, and disposal are serialized in the config owner's process-local queue. Work enters that queue first and then acquires the cross-process config ownership lock, and no code waits for the owner queue while it holds the lock.

Because: The reverse order lets two processes deadlock.

## ARCH-RUNTIME-060: Config mutations compare and swap against fresh bytes

Every config mutation states the value it expects, or that the setting is not authored, and applies only when a fresh reread under the ownership lock matches. A stale expectation, a decode failure, or a failed write publishes nothing; a committed write publishes exactly one revision from the committed bytes, and a later durability warning rides on that publication without rolling it back.

Because: A client value can diverge from a stale or failed cross-process mutation.
Not: Optimistic client state for configuration.

## ARCH-RUNTIME-061: Each auth profile solely owns its configuration overlay

Role settings, attribution policy, training-route permission, and the provider settings each provider module declares live only in one auth profile's overlay; there is no account-wide layer and no fallback between profiles. Environment overrides apply only to the effective profile of the process and never write config.

Not: An account-wide role or provider-setting layer that profiles fall back to.

## ARCH-RUNTIME-062: Every setting declares one application mode

The setting catalog assigns every authored setting exactly one application mode: live, next request, replace resource, use-time revalidation, or next use. A mutation is acknowledged only after live and replace-resource subscribers settle, and a replaced resource is disposed only after its replacement is published. A subscriber owns its own domain effect and resource lifecycle, never config authority: its failure returns committed-but-degraded and never rewrites config or rolls back a revision.

## ARCH-RUNTIME-063: One provider request captures one config revision

Each provider request captures one immutable config revision, holding the effective profile and frozen next-request policy, before prompt, tool, provider, and resource planning. All attempts and failover inside that request use the capture, and a later request can capture a newer revision. A config publication never cancels work in flight.

Not: Capturing config once per logical user turn.

## ARCH-RUNTIME-064: Modules own their configuration sections

A module owns one retained section of the configuration file, declaring its schema and default, its diagnostic owner, its application mode, whether it carries secrets, and the issues it explains in its own words. The kernel schema, loader, setting definitions, and configuration reference compose every installed module's section and name none. The loader decodes a section whether or not its module is on, so a disabled module's bytes keep their meaning.

## ARCH-RUNTIME-065: Module settings travel generically

A module can declare UI-safe settings, and the generic config projection and mutation carry, validate, and write them with an expected-value check. Only the declaring module interprets a setting's meaning; the kernel honours the module's resulting refusal and judges nothing itself. Secret sections never enter the projection, and the Settings surface derives provider status only from the secret-free auth projection.

## ARCH-RUNTIME-066: Safety decisions read the file, not the resident snapshot

Module admission and final update activation never treat the resident config snapshot as permission; each validates canonical bytes read under the config ownership lock and completes its decision before releasing it. Admission mints an immutable grant for the operation's required modules from that observation, uses the retained valid selection when the bytes are invalid, and enables every module when no valid selection was ever observed. The watcher refreshes the display projection but never admits work.

Because: A publication and a protected operation can race, and invalid input is not an opt-out.
Not: Authorizing a safety decision from the resident snapshot or the client snapshot.

## ARCH-RUNTIME-067: Admission takes no lock for an unchanged file

Because every writer publishes a new file by rename, admission reuses the selection its last locked reread decoded while the published file identity is unchanged, and takes no lock. A refused read and a missing file are never reused. A confirmed watch bounds how long another process's change can take to reach admission, and without a confirmed watch admission examines the file identity at each use; final update activation always rereads.

Because: Taking the lock writes and syncs to disk on the calling thread, and admission runs on hot paths.

## ARCH-RUNTIME-068: A module disable is an admission decision, not an interruption

Every seam reads the live module selection, which changes only after validated policy adopts a config change, and turning a module off removes its contributions, settings, commands, and observers at once while its protocol runtime answers empty and refuses mutations. Admitted work settles with its captured modules, schemas, and gates, and every new operation requests a new grant. An activated service instance stays owned until runtime shutdown. The agents of one shared engine host settle with the module capture that the host took when it opened; a module turned off while that host runs stays advertised there and refuses its calls.

Not: Cancelling running work when its module turns off.

## ARCH-RUNTIME-069: Model-config pruning reads the complete authoritative schema

Model-config pruning removes deprecated and unknown keys only against the complete authoritative schema or registry, never against the slots that a partial read requested. Destructive pruning is corrected at its completeness boundary, and pruning is never disabled.

Not: Turning pruning off to stop it deleting keys that a partial read did not know.

## ARCH-RUNTIME-070: The configuration reference is generated from the setting catalog

The configuration reference is generated deterministically from the setting catalog and the public schema, never written by hand.

## ARCH-RUNTIME-071: Startup reads the paired-device store only when it must

A terminal launch reads the paired-device store only when it is about to ask the person which project to open or to refuse the account home, so an established project opens without reading it.

Because: Startup responsiveness is load-bearing, and an established project needs nothing from the device store.

## ARCH-RUNTIME-072: A handed-over command is adopted once and completes once

The successor's host for the same conversation adopts each command handed over by a replacement (ARCH-RUNTIME-033) before its first model request, and the executor keeps every command that no attached chat adopts as the one durable record of a command that runs with no host holding it. Exactly one consumer retires each handover, and the consumer that retires an ended command holds its completion for the conversation in the same step. Publications are keyed by command, so a repeated delivery adds nothing, and a held completion is the one path a background outcome takes into a conversation with no running turn.

## ARCH-RUNTIME-073: Role and root-command selection precede composition

The executable selects internal roles and root help or version before application composition loads, and interactive runtimes complete required migrations and legacy cleanup before registries are built.

## ARCH-RUNTIME-074: One account-level owner clones remote projects

One account-level clone owner creates a project from a device-named repository through an owned command into a new folder that Flywheel names, so a device never names a path on the machine. The clone runs with the machine's own git credentials and no terminal prompts, Flywheel never holds a git token, and the clone outlives the device channel that asked for it.

## ARCH-RUNTIME-075: Diagnostic records carry identities, never content

A diagnostic record carries ids, byte counts, hashes, and kinds, never conversation content, tool output, prompt text, file content, or model-written text, and it is secret-redacted. One piece of information has one home: the content lives in the project store, which the debugging search merges with the diagnostics into one timeline, so a diagnostic names a fact by its identity instead of restating its payload.

Because: A copied message or payload makes the diagnostics stream a second, unbounded store of the content.

## ARCH-RUNTIME-076: One record marks each decision, and per-call paths stay below the default level

Each decision, state change, or finished unit of work writes one record at the default level with the evidence it rested on, and every kill, termination, restart, replacement step, registration change, update outcome, and refusal that a person could ask about names its cause once. A record whose rate scales with calls, requests, tokens, stream events, reads, store changes, or tool calls stays below the default level, and a start and its end are one completion record with its duration that reaches the default level only when the work failed or ran slow. Steady-state volume is a guarded budget: an idle service writes nothing, and a turn's records do not grow with its tool calls.

Because: A per-call record at the default level can fill the disk, and a full disk makes the store refuse model turns.

## ARCH-RUNTIME-077: Repeated conditions coalesce into one count

The first occurrence of a condition records in full, and its repeats within a window become one count that is reported when the window closes or the condition ends, through one coalescing mechanism per process. A condition that recurs across processes keeps its count in its durable record, and a condition that holds for every request records only when it changes.

## ARCH-RUNTIME-078: One registry decides how loud each record family is

One diagnostics registry assigns every typed record family one tier: informational, notable, which reaches the default level only for a record that its producer marks failed or slow, or debug. A producer never chooses the level of a typed family, an undeclared family records at debug, and the registry and its producers agree in both directions. Work that nothing awaits records its failure once, through the handler that owns it.

Not: A producer that raises its own records to the default level because one record looks useful on its own.
