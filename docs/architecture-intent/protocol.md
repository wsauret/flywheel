# Protocol Architecture Intent

This file states the runtime and client contract and the boundaries that govern how clients render runtime state.

## ARCH-PROTOCOL-001: The runtime client protocol is the only client boundary

Every client reaches runtime state only through the one typed runtime client protocol: it dispatches typed mutations and workflow operations, reads snapshots, performs bounded or query-only reads, and subscribes to live patches. No client reaches around that boundary to runtime stores, the session manager, queue internals, the database, or provider streams.

Because: A client and the runtime never share memory, so any other path is a hidden second contract that drifts.

Not: A client that reads a runtime store or the database directly for a faster view.

## ARCH-PROTOCOL-002: Clients render derived state and send actions

A client renders state that the runtime derives and sends actions to the runtime. It never owns workflow transitions, fact publication, workflow-view projection, session lifecycle or persistence, runner creation, handoff validation, or tool execution. A client derives a session's state from the protocol-fed session catalog, and its hooks own only UI composition and local input state.

## ARCH-PROTOCOL-003: The published protocol is a pure, self-contained contract

The protocol layer owns every mutation, query, patch, and snapshot shape, their schemas, the patch classification and delivery-policy table, the call-policy table, and the shared client core. It depends only on runtime-neutral foundation code, so an editor host, a browser, and an edge worker all compile against it directly. Every client and host outside the source layers compiles against the protocol layer and nothing else in the source tree, and a build gate enforces that closure.

## ARCH-PROTOCOL-004: Transports change framing, never semantics

The account-service socket, the authenticated loopback WebSocket, the relay reverse transport, and the in-process test transport are equal transports of one protocol, served by the same handlers over the same frames. A transport changes framing, admission, and lifetime, never call, cursor, or recovery semantics. A transport that crosses the untrusted relay seals every frame below the protocol under a key that only the paired ends hold, and the protocol itself carries no credential.

Because: Clients on different transports must not drift in call or recovery behavior.

Not: A relay-specific or browser-specific variant of calls, cursors, or recovery.

## ARCH-PROTOCOL-005: Each public transport has its own admission authority

The account socket requires owner-only filesystem access and the private account credential before a project selection. The project web transport binds only to loopback and requires the project's unguessable token and an exact Origin match. The relay's authority is pairing plus end-to-end sealing: the runtime admits only device keys recorded at pairing, verifies each one regardless of what the relay admitted, and the relay never reads a frame.

## ARCH-PROTOCOL-006: Protocol bytes flow only after an authenticated, ready attach

Every account socket connection authenticates, selects its canonical project, and waits for that project to become ready before it carries runtime protocol bytes. A client's call deadlines start only after the attach completes.

Because: A cold project open can run a historical migration for longer than any control-read deadline.

## ARCH-PROTOCOL-007: Hub and project addresses never mutate on a plain read

The account hub's reads never mutate project state; it wakes a project only through an exact-origin request authorized by a host-only cookie, and only a ready project redirects to its token-bearing page. A known project's own address starts that project only for a page load or a same-origin socket request and refuses cross-site requests. Known projects claim distinct stable ports, so no two share an origin or its stored browser key.

## ARCH-PROTOCOL-008: A relay control channel carries only announcements and its own client files

Each relay control channel announces one placement and the identity of the web client that its process serves, and carries nothing else except, on request, that client's phone files for the same identity. It never answers for another identity or file, and nothing on the machine listens for remote access.

## ARCH-PROTOCOL-009: One sequencer is the sole ordering authority

Every live patch carries its domain and cursor identity, a position minted by the one runtime sequencer from a global monotonic source, and its predecessor position on that cursor. Publishers supply payloads only, no read mints a position or resets a publish chain, and snapshot positions are observations. The data that a snapshot returns determines what it covers, and no workspace watermark substitutes for a transcript read. Replacing the executor never resets the account's sequencer.

Because: Clients can reason uniformly about continuity only when one authority orders every cursor.

Not: Unsequenced event delivery, or one independent position space per publisher.

## ARCH-PROTOCOL-010: Every live domain declares delivery policy, patch content, and intake

Every client domain declares exactly one delivery policy: durable resnapshot through an authoritative bounded read, latest-collapsible replacement by the complete latest view, or query-only with no live stream. It also declares whether its patches state whole values, which are idempotent, or changes; a latest-collapsible domain always states whole values. The domain set, the policy table, and the client intake bindings are coupled at compile time, so a domain without recovery behavior or a receiver fails the build.

Because: A missing intake otherwise surfaces only as a silent stale-state bug at runtime.

## ARCH-PROTOCOL-011: Publication is on change, and every read states the domains it seeds

The account's public bus publishes a whole-value patch only when it differs from what receivers last saw on that cursor, from a patch or from a later read; a declined patch mints no position, so no receiver sees a gap. Change patches and invalidations always publish. Every query names the domains that its answer seeds, and a read resets the bus's last-published value for exactly those domains, so a value that a read computed live is never suppressed afterwards.

Because: The executor's private bus is the exception and publishes every patch, since its one reader merges patches and answers some reads from history.

## ARCH-PROTOCOL-012: Ordered intake is one shared classification with one recovery path

Every receiver, runtime and client alike, evaluates the one shared patch classification: a cursor identity mismatch or a predecessor beyond the held position is a gap, a patch at or below the held position is stale, and anything else applies, with held patches replayed in position order. A gap that cannot close within the receiver's bounds recovers by the domain's policy, and overflow, reconnection, store divergence, and freshness failure enter that same path. Only a whole-family snapshot replaces the family baseline; concrete snapshots and partial batches update only their named cursors. Held patches are bounded, and their overflow releases held data and recovers by a fresh snapshot.

Not: A client that restates ordering locally or adds an alternate patch-application path for one failure kind.

## ARCH-PROTOCOL-013: Overflow becomes an invalidation, never a dropped connection

When the runtime bus drops a patch at its pending-delivery limit, every live domain receives a cursor invalidation on the same ordered lane after the queued backlog, and recovery reads the domain's authoritative snapshot, not the last published payload. A connection's outbound queue slides, dropping its oldest frames rather than the connection, and appends one overflow invalidation that the sliding queue cannot discard. Repeated drops before a drain share one invalidation, with no reconnect and no polling timer.

Because: A client that falls behind must stay attached and catch up in place.

Not: Dropping a slow connection, or recovering from the last published payload.

## ARCH-PROTOCOL-014: A lane is the unit of attach and of seed reads

A lane is one attach of a client connection: it opens when the event subscription reaches an open socket and ends when that subscription ends. A lane's end reaches every receiver as one reconnect invalidation; the receiver voids what the lane covered, reads nothing during the break, and reads its whole view once when the next lane opens, never at construction. Every other invalidation reads at once, and a read lost with its lane reports no failure and does not retry, because the next lane reads it again.

Because: Reading during a break or at construction multiplies reads and races the attach.

## ARCH-PROTOCOL-015: A read started at lane open sees everything the lane does not carry

The runtime serves a call written after a subscription on the same connection only once that subscription is registered, failed, or exited; a call written before any subscription is served at once. So a read that starts when a lane opens covers every change that the lane does not deliver, and no position travels in the connected frame.

Not: Carrying a start position in the connected frame to stitch the first read to the lane.

## ARCH-PROTOCOL-016: Calls wait for the next lane instead of failing

While a connection is connecting or recovering, it holds each call until the next lane rather than failing it, and a best-effort call's wait counts against its deadline. When the lane opens, a session's output watch reaches the runtime before any of that session's transcript reads on the lane. A session hold that waited for the lane is dropped, because a hold lasts only as long as its connection and every holder holds again on the new lane. A mutation lost with its lane has an unknown outcome, and its owner sends it again only when the runtime answers a repeated copy as a receipt of the first.

Not: Replaying every call that was in flight when a lane ended.

## ARCH-PROTOCOL-017: Residency decides what a client keeps live

A client that keeps several sessions resident has one shared residency, which is the only listener on the connection's lanes and hands each session its lanes. At a lane break, every resident session that no surface shows goes dormant: it reads nothing on the next lane and the client holds no runner and no detail on the runtime for it. A dormant session wakes when a surface shows it, first adopting any coordinate rebase withheld while it slept. Receivers that serve the whole client attach to lanes directly.

## ARCH-PROTOCOL-018: The shared client core owns all client-independent behavior

The protocol's shared client core owns the self-recovering connection with its lanes, health, and silence deadline, the held views and cursor intake, the session reading family and held detail, and the transcript store, delta application, and fold into rows, read runs, and dividers. Every client, the terminal included, uses that core and adds only presentation bindings. A rule about what the transcript contains or where a divider falls lives in the fold, never in a client.

Because: Two clients that each restate reading, recovery, or transcript rules drift apart.

Not: A per-client copy of recovery, residency, delta, or transcript-fold logic.

## ARCH-PROTOCOL-019: Background read retry has one owner in the client core

The shared held views own retry admission for background reads. A failed read that was not lost with its lane retries with backoff while the lane stays open, a lane break or disposal cancels pending retries, and the last view stays visible until a read or patch replaces it. Readers on one query transport share one failure notice that reports each read episode once, subject to the runtime-health rule in ARCH-PROTOCOL-025.

## ARCH-PROTOCOL-020: Every unary call declares lossless or best-effort delivery

Every unary runtime call is classified in one policy table. User actions and mutations are lossless and have no client-local deadline; runtime failure routing and the process watchdog own their liveness. Retryable reads are best-effort with a named bounded deadline, and a call without a delivery class is a protocol defect.

Because: A timeout cannot distinguish an action that was never delivered from one whose answer is late.

Not: Client deadlines on mutations.

## ARCH-PROTOCOL-021: The heartbeat deadline is the lane's only clock

One versioned protocol contract owns the heartbeat interval and silence deadline for every serving and client placement. The server merges heartbeats into every subscription, the client converts silence past the deadline into a failed subscription, and the transport carries no request-level ping of its own. The deadline spans many heartbeats because a heartbeat rides the same ordered lane as data.

Because: A second, stricter deadline that a slow phone cannot meet would fail a healthy lane and reconnect it from scratch.

Not: A request-level ping or per-call liveness deadline beside the lane heartbeat.

## ARCH-PROTOCOL-022: Lane backpressure is an end-to-end byte window

The client acknowledges each stream chunk once, in order, after it enters its bounded buffer, and the runtime sends a stream's batches at once while less than a fixed byte window per stream per connection is unacknowledged. A link that keeps up never waits for a round trip, and a hold takes no writer lock, so query replies on the same connection continue during it. The runtime's server protocol owns the window and the client transport owns the acknowledgements. Below the window, each transport writer waits while its socket holds more than a fixed high-water mark of unsent bytes and resumes on drain, so no transport discards or truncates a frame of an open connection.

## ARCH-PROTOCOL-023: Relay sockets prove liveness by heartbeat

Every relay socket, whether control, device, or data channel, follows the heartbeat rule with intervals and deadlines in the relay contract, and the relay answers pings without waking the machine's state. Silence is counted on the socket's own timer, a busy socket is never silent, and a data channel that ends by silence ends its lane at once. The relay watches for silence only while a device is connected, and socket liveness does not depend on durable relay storage, so no platform storage fault can end every socket of a machine.

Because: Without guaranteed traffic a wedged stream looks identical to an idle one.

## ARCH-PROTOCOL-024: Runtime failures cross as a small typed taxonomy

Runtime failures cross the client boundary as the smallest typed discriminant that clients consume, which separates Flywheel invariant violations from internal runtime failures. No call invents its own failure taxonomy.

## ARCH-PROTOCOL-025: Runtime health is derived once

The runtime publishes the executor's state and the account service's state as latest-collapsible workspace views, and the shared client core derives the one runtime health that every surface renders from those two and the connection's own health, ranked by what a person can act on. A reconnect that heals is not a health state, and a best-effort read that times out while the lane is silent is explained by the connection, not reported on its own. Recovery uses the ordinary invalidation and resnapshot path, never a parallel mechanism.

Not: Each surface deriving its own health or rendering a reconnecting state.

## ARCH-PROTOCOL-026: Protocol evolution is additive and unknown frames are skipped safely

The public event boundary and the private executor intake skip an unknown event type, cursor scope, domain, or patch kind without ending the connection, while known frames stay strictly validated and every writer validates a frame before publication. Skipping never advances a cursor, so a resulting gap recovers through the ordinary snapshot path. A client reports a skipped event once per signature and session, with only its descriptor and session identity, and that report never blocks rendering or actions.

## ARCH-PROTOCOL-027: Query results decode by discriminant

A query result crosses the wire as an opaque value that the client decodes with the codec that its discriminant selects from one table. Broad protocol unions are schemas over their direct leaf members, so decoding never stops at an empty or partial structural branch.

Not: Decoding a result by trying each member of a union in turn.

## ARCH-PROTOCOL-028: Version and bundle identity are checked only at event attach

Every client states the protocol version it speaks at every event attach, and a web client also states its bundle identity. The runtime checks the bundle identity first and then the version, and refuses a mismatch with a typed refusal that names the release and protocol version it serves. The event attach is the one message that crosses versions: its fields keep their meaning in every version, a runtime ignores attach fields it does not know, and no transport checks versions.

Because: Bundle identity goes first because a page of another bundle reloads whatever protocol it speaks.

Not: A version check in a transport preface.

## ARCH-PROTOCOL-029: Each runtime serves the web client of its own build

A runtime serves only the web client of its own build, addressed by the one identity that the build alone authors, so a page of another build fails its next asset request and reloads itself through its host. A development service builds the client inside its own source snapshot, so client edits and runtime edits change the same identity.

Not: A separately versioned web deployment.

## ARCH-PROTOCOL-030: Client replacement is one client-owned transaction

A web client answers a bundle refusal with one client-owned replacement transaction: it prepares the successor while input stays live, captures every input owner into one versioned checkpoint, and holds new input only for the final commit. A failure in preparation, storage, or the host releases the hold and leaves the live owners and saved bytes intact. The checkpoint embeds the existing reading state, hosts store it without decoding it, and unknown or malformed bytes stay saved and show a failure. Ordinary lane recovery never replaces a client.

Not: A second reading-state format for reloads, or replacing the client on ordinary reconnect.

## ARCH-PROTOCOL-031: The web client is one hosted bundle, and hosts relay its bytes

The web client is one bundle, hosted rather than ported: the editor, the machine-local browser host, and the phone's bootstrap all mount the bundle that the serving runtime built, and the web client imports no host module. A host supplies only a socket layer, a capability object, and a theme, never reconciles session or transcript state of its own, and the client branches on capability and container width, never on host identity. The editor host supervises the account service, relays the client's protocol bytes without decoding them, and answers the client's capability requests. It keeps one connection of its own only for editor notifications while the client is hidden and for editor commands such as the chat and file pickers, and that connection never reconciles chat state.

Not: Porting the client per host, or letting a host keep its own session state.

## ARCH-PROTOCOL-032: One relay device client serves every relay-reached client

The Remote module's protocol home holds the device side of the relay as one client that every client reaching a runtime through the relay uses for pairing, presence, the machine and project picker, wake, project creation, and the sealed socket. It holds no device storage; its host supplies the device key, paired machines, and last selection through one device store contract. Turning Remote off removes its contributions, and the kernel loopback browser path remains.

Not: A per-client relay implementation, or device storage inside the shared relay client.

## ARCH-PROTOCOL-033: Protocol domains are declared once, and every installed module has a protocol runtime

The kernel declares its domains in the protocol core, and a module declares its domains, queries, and mutations once in its protocol home against the generic module protocol contract, each declaration carrying its whole delivery policy. The protocol registry derives every table from the declarations and imports only pure schema values, so every client can hold it, and the runtime routes each read and mutation by discriminant with no module case. Composition constructs each installed module's protocol runtime, disabled or not. External hosts reach only a module's published protocol contract, never its runtime or rendering code.

Because: Disabling a module must not make its retained history unreadable in any client.

Not: Constructing protocol runtimes only for enabled modules.

## ARCH-PROTOCOL-034: Modules reach a client only through its slot map

A module reaches a client only through the slot map: declarative intro and status rows computed by pure selectors in its protocol home, a strip above the composer, surfaces opened by id, a terminal presence hook, and a web toolbar badge. Its terminal and web client homes each export one module object that the client's one module registry lists. The client's slot host names no module, renders every registered contribution through one reader over its intake, and contains a render failure to its slot.

Not: A client host that branches on a module id.

## ARCH-PROTOCOL-035: An unknown module selection admits module contributions

An unknown module selection is not an opt-out: every client admits a module's surfaces and contributions until a published selection excludes it, so a runtime-published command can open its surface while the selection is still loading. A known exclusion removes the module's contributions and closes its open surfaces. Host-owned acquisition and bug-report surfaces remain available before the first connection.

Not: Hiding every module contribution until the selection loads.

## ARCH-PROTOCOL-036: The module projection that clients receive is display-only

The runtime publishes the selected modules, the derived Workflows mode, catalog warnings, and configuration errors in the secret-free runtime config snapshot. Clients render that projection and never derive capability authority or make safety decisions from it.

## ARCH-PROTOCOL-037: Commands cross as published descriptors that the runtime executes

The runtime publishes every built-in command, kernel and module alike, as a descriptor under a catalog revision. The descriptor carries the command's one name, its aliases, its menu position, and an optional nested or contextual target of the surface it opens; clients keep no copy of a command's name or order, and only commands that act on the terminal itself stay terminal built-ins. A client invokes one through a lossless invocation that carries the descriptor id, the argument text, and the revision it rendered; the runtime refuses a stale revision, executes the handler in the composition that published it, and answers one closed outcome. A client never executes a module handler or special-cases a command id, and a command whose whole effect is opening one client surface names that surface in its descriptor and opens without a round trip.

## ARCH-PROTOCOL-038: Skills never cross the protocol as commands

The protocol carries no skill invocation and publishes no skill in the command catalog. A command that starts a method resolves the skill from the registry the runtime owns inside its handler and commits the rendered context as the session's next turn, and no package id or body crosses from the client. The turn renders through the ordinary transcript path, with no private display channel.

## ARCH-PROTOCOL-039: The protocol transports, never redefines, config and consent semantics

Runtime config snapshots and mutations, and subscription-spend consent, cross the protocol as typed delivery only. The runtime config authority owns decoding, revision, mutation, application, and settlement, and the consent authority owns rederivation and mutation validity. Consent writes echo opaque envelope ids, the profile, and the authority incarnation and revision; the client's cursor position that they also carry is review context, never the compare-and-set authority.

Not: Using the client's cursor position as the consent compare-and-set.

## ARCH-PROTOCOL-040: Clients never own profile state

Clients render the runtime's scoped auth and provider-model views and send scoped profile and exact-account mutation requests, under the scoping rules of ARCH-PROVIDERS-015. A client persists no profile state and keeps no current-profile, eligibility, or provider-union value of its own.

## ARCH-PROTOCOL-041: Usage reads pin a generation and need the module

The runtime pins each usage operation's resolved scope (ARCH-PROVIDERS-015) to the acquired generation. Session statistics read the attached project's facts without provider I/O or a profile lease. Raw credit identifiers never enter protocol views, and every Usage read is refused while the module is disabled.

## ARCH-PROTOCOL-042: Generation readings are summary values

A session's own average generation speed is a value of the derived session summary, advanced once per recorded stream summary. Budget, detail, catalog, and broadcast answers read it from the summary and never fold a session's history on demand.

Because: Folding history per demanded session puts full replays on budget answers, and a client that shows many sessions turns them into an unbounded retry loop.

## ARCH-PROTOCOL-043: Update state is an account view in every workspace

Update state is account-global: the account's one coordinator publishes it with the effective policy into every open project's workspace as one domain, it is never session state, and no update request reaches a project executor. That domain is every client's sole source for update notices, status, and the setting, and clients render what it publishes without deriving it from the policy or reading release notes themselves. Every client takes update status words from the shared client core.

Not: A foreground session notice, or a second client copy of the update policy.

## ARCH-PROTOCOL-044: Project notifications reach clients as whole episode changes

Project notifications reach clients as a durable-resnapshot workspace domain whose patches carry a raised episode whole and a resolution or dismissal by source and episode identity, so a client folds terminal state without inferring it. The action vocabulary stays closed, targeted auth actions carry only opaque account identity, and dismissal is one lossless mutation of one exact episode.

## ARCH-PROTOCOL-045: Invalidation domains anchor their reads before awaiting

The changes and background domains publish invalidations, not copies of their state. A summary or index read captures its cursor position before it awaits durable data, so an invalidation that arrives during the read stays newer than the returned anchor. Their publishers read no history except where sessions sit in the launch tree, and do not depend on a live runner. A change that a launched session records also invalidates the changes domain of every session that launched it, because a session's review folds the session and every session it launched, in one held fold per reviewed session that reads the facts of all its members in one query and folds a joining member's history once. A client reads such an index only while it shows it, and unavailable durable metadata is an error, never an empty summary.

## ARCH-PROTOCOL-046: Review validity is proven by exact source identity

The full changes review returns each file's exact latest edit source identity with its review projection, and a lossless Viewed mutation echoes that identity, which the runtime refuses when any concurrent session write invalidates the proof. A Viewed record names one exact edit and belongs to the session whose review records it, so a later edit by a session it launched shows the file unviewed again. Summary reads are best-effort, while Viewed and confirmed Undo are lossless.

Not: Validating a review by list revision or content hash.

## ARCH-PROTOCOL-047: Session detail is held, never polled

Only the account's project control publishes session detail, as whole-row replacements. A connection holds a session's detail while it shows the session or reads one snapshot, and each hold ends only by its own release or the end of the connection. The publisher reads only held sessions, reads one again only when an input of its row can have changed, never on ordinary conversation appends, runs one read at a time, and publishes only rows that differ from what holders last received. Detail patches never reseed status, budget, workflow, or output domains.

Not: A per-parent child-list domain or periodic polling of detail.

## ARCH-PROTOCOL-048: Children use ordinary session surfaces

The runtime exposes a child session through ordinary session projections, transcript reads, and admitted mutations, with no child-specific transcript or card contract; the child owns its viewport, and cards and activity rows link it instead of copying its transcript into the parent. The session catalog carries chats only, and that rule is enforced at its producer, never by filtering in each client. Workflow cards read workflow domains, never synthetic session rows, and client placement of a child changes navigation only, never runner, transcript, or lifecycle authority.

Because: The child is a real session, so ordinary projections are its single source of truth.

Not: A child-specific transcript or card model.

## ARCH-PROTOCOL-049: Clients hold child detail through passive resolution

A bare child id resolves through passive detail. Clients hold roots and child chains before snapshotting, release cursors with their last hold, and ignore patches for unheld sessions without fetching. Every client renders agent conversations in one shared child-session body, and workflow code supplies only header and navigation chrome.

Not: Activity-edge polling, or a parent children-list stream that duplicates detail ownership.

## ARCH-PROTOCOL-050: Controls derive from runtime admission, never navigation

Navigation holds belong to root chats; a child viewer holds read resources, not a runner claim, and closing it releases only the viewer. Messages, Stop, interrupt, resume, deletion, and read-only settlement derive from runtime-admitted actions and status, never from navigation, presentation state, or result text. Every client derives a child's controls and its Stopped or Canceled label from that admission.

## ARCH-PROTOCOL-051: Returned input has no per-child draft store

Input returned from a finished child belongs to the parent's existing draft owner and to the sending window's locally owned submission identity. No per-child draft store exists.

Not: A per-child draft store that keeps a finished child's unsent words.

## ARCH-PROTOCOL-052: Workflow display and addressing derive from the one tree in the shared client

The shared client core derives a workflow card's phases, progress, coverage, selection, and agent views, and resolves message, Interrupt, and Resume addresses, from the one operational tree. Every surface uses that same derivation and resolver, and no client recomputes coverage or selection or keeps its own copy of workflow status.

## ARCH-PROTOCOL-053: The runtime owns an activity's start time

One runtime status projection owns the displayed activity's start time and sends it with the activity in every status view, shared across snapshots and clients; output updates and client attachment never reset it. Clients count elapsed time from that runtime time, never from the turn's start or their own observation.

## ARCH-PROTOCOL-054: Transcript output has one absolute coordinate

Historical output derives from the authoritative conversation and workflow facts, and active output is the uncommitted tail of that same transcript. One read path serves windows across the durable prefix and the live tail, deltas are minted in absolute coordinates at their write boundary, and recovery resolves exact block identities rather than content, timestamps, or old indices. A delta that does not apply against the held base is a divergence that recovers from the bounded authority, and the live tail is a serving tier, not a replay authority.

Because: Separate coordinates force offset translation, seeding, and restitching at every boundary movement.

Not: Separate durable and live coordinates, full-transcript snapshot recovery, or an in-memory replay ring or second output index without a measured requirement.

## ARCH-PROTOCOL-055: A transcript row keeps one identity from live to durable

Before a message publishes public output, its owner reserves the conversation entry identity it will commit under, and the live projection, any held record, and the final append carry that identity. Rows derive their identity from the entry and its canonical part position, so live and replayed rows reconcile in place, and a terminal correction replaces bytes without removing the row. Queued messages with reserved identities stay separate through delivery and restart, even when one request consumes several.

## ARCH-PROTOCOL-056: Output ships as the smallest true change from what clients hold

Every output change ships as the smallest true change from the copy that the session's clients last received, measured by one owner of the shipped copies per output cursor through which every publisher ships in one synchronous step. An edit ships as a delta only when every read of the block gives the same base as the delta copy; otherwise the block ships whole, and while a read is in flight every change ships whole. Appends, sliding windows, and pushes name their base so redelivery is idempotent, and nothing on the wire scales with a stream's accumulated state per change.

## ARCH-PROTOCOL-057: Output deltas reach only watching connections, and invalidations reach all

A transcript store states a watch on its session on each lane before it reads it, and a connection states its whole watch set at once, which the account restates to each executor generation ahead of later calls and on each reattach. The runtime sends output deltas only to watching connections, and the executor measures and publishes deltas only for the union of watched sessions, forgetting shipped copies of a session that leaves it. Output invalidations are never filtered, so a dormant session that wakes still hears a rebase. An executor that has received no watch statement ships every session's output.

## ARCH-PROTOCOL-058: Status settlement names real output publications

A settled status names only an output position that a real public publication of that session's committed output reached. When the runtime cannot prove that, it marks the status as needing recovery, and a client clears the mark only with its own authoritative tail read started after it saw the mark. Reads mint no public positions.

Not: Accepting another client's snapshot, a running read, or a workspace watermark as settlement proof.

## ARCH-PROTOCOL-059: Large bodies stay out of transcript rows

A live tool body over the inline limit leaves its row with a line count, and a user message row carries an image count, not image bytes; a client reads such a body on demand. A body whose identity has retired returns an explicit missing result that the client never keeps as a body. Long streaming text splits into bounded appends applied in order.

## ARCH-PROTOCOL-060: Transcript recovery protects the reader's span

Before the shared store commits or trims a window, the client supplies whether the reader follows the live end and the identities of the visible blocks. Recovery for a reader away from the live end asks for that protected span, and the runtime returns every surviving protected block in one contiguous interval at one snapshot position; budgets and the resident bound trim surrounding rows, never the protected span. A page omission is not deletion evidence, an incomplete or failed response leaves the presentation non-current, and only authoritative absence retires a protected block.

## ARCH-PROTOCOL-061: Headless machine output is an ephemeral stream, not a projection

A direct task's machine-output stream is an ephemeral, process-attached stream derived from selected runtime events and ending in exactly one terminal result. It has no replay, resume, or durable sequence authority and is never a projection; durable facts remain the authority for post-run inspection.

## ARCH-PROTOCOL-062: Client UI state is surface-owned and patched in place

UI state is owned by the client surface that shows it, never by the runtime or the shared client core. Network data patches that state in place and never replaces it. PI-INTERACTION-062 states the behavior a person observes.

Not: Replacing surface state with a fresh snapshot after reconnect.

## ARCH-PROTOCOL-063: Client effects track causes, not the state they reconcile

A client store reflects domain slices fed by the protocol, not component trees. A client effect's tracked reads are its input contract: an effect that writes a target never also tracks that target, reconciliation is idempotent, and a fresh but semantically equal object from a snapshot or patch is never new authority. Pure derivation is a memo, not an effect.

Because: Runtime snapshots routinely republish unchanged meaning under fresh identity, and an effect that tracks its own target feeds back into itself.

## ARCH-PROTOCOL-064: Web styling values come from one token source

The web client's colours, font sizes, z-index layers, and container widths come only from its one design-token stylesheet and its width ladder.

Not: Literal colour or size values in component styles.

## ARCH-PROTOCOL-065: Terminal action buttons have one styling owner

Ordinary terminal action buttons render through one shared button component that owns padding, default colours, and hover and focus highlighting; callers own the action, keyboard routing, and progress text. Tabs, selectable rows, header chrome, and transcript-inline controls keep their specialized rendering.

Not: Copying button styling into a new clickable box.

## ARCH-PROTOCOL-066: Setting presentation crosses from the one setting catalog

Every client reads each setting's label, section, order, and control kind from the one setting catalog that defines the setting. No client types its own setting labels or row lists; a client chooses only how a row looks and whether a row that describes another client's host is shown.

Not: Per-client copies of setting labels kept in step by a drift test.

## ARCH-PROTOCOL-067: Size limits are application limits that every transport carries

Every limit on what one message can hold is an application limit, derived from what the receiver can use, and the sender refuses input past it with its reason before anything reaches a transport. Framing and reassembly carry every complete message up to those limits, and split it into frames when needed, so that each frame with its header stays within the frame and queue budgets. Only the reassembly ceiling lies above the largest message that those limits admit, so it fails only a runaway producer.

Because: A transport that closes on an oversize frame reaches the person as a reconnect instead of as a reason.
Not: A frame cap as the only size limit a person can meet.

## ARCH-PROTOCOL-068: Pending questions cross from the durable question projection

Every client derives the question it docks at the prompt from the durable question projection, which committed question facts alone advance, never from transcript rows or runner state. The transcript's question row settles from the same committed answer, skip, or withdrawal on every settlement path, and a settlement that the runtime refuses returns its reason to the client.

Not: A dock derived from live transcript rows, which stays after a settlement that the live display never received.
