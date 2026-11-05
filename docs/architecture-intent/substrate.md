# Substrate Architecture Intent

This file states how Flywheel keeps durable history, derives projections from it, assigns one owner to each value, and recovers and retries work from that history.

## ARCH-SUBSTRATE-001: One source of truth per value

Every value has exactly one owning store, and everything downstream of it is a derived view. A value never also lives as a shadow signal, an adapter property, a registry field, or a duplicated status. State drives effects, and an effect never writes back the state it was derived from.

Because: Shadow copies drift and create update cycles that no single owner can reconcile.

## ARCH-SUBSTRATE-002: Facts and projections own durable state

Every Flywheel-owned durable value is append-only typed facts plus deterministic projections, unless another architecture statement assigns it a different authority. Each new durable value declares its fact owner, aggregate scope, projection consumers, and cache policy. New per-session runtime state is a typed fact in the project store and a projection that reads it.

Because: A mutable latest-state record cannot explain why a value exists or which evidence caused a transition.

Not: A status field, shadow record, or per-session file that is written independently of the facts it summarizes.

## ARCH-SUBSTRATE-003: Projections and caches are rebuildable views

Workflow state, session summaries, accumulated context, budgets, metrics, and inspection surfaces are projections over their owning facts. Snapshots, indexes, materialized views, persisted folds, and caches may accelerate reads, but stay rebuildable and non-authoritative. Each records the fact prefix or content identity and the code identity that built it. When it cannot prove those inputs current, it is a miss, never a conversion or a warning. A stored representation that cannot be rebuilt from its declared inputs is an authority and is governed as one. Inspection surfaces read projections and keep links to their source facts.
Not: Treating rendered output, indexes, snapshots, or runtime caches as authority because they are recorded.

## ARCH-SUBSTRATE-004: External systems of record keep their authority

An external system of record remains the authority for its own values. Flywheel records what it observed and the transitions it attempted, and never presents a recorded observation as the owned current value.

## ARCH-SUBSTRATE-005: A fact earns durability through a consumer

A record becomes a fact only when a projection, replay, resume, or recovery consumer reads it. Request audit evidence is session state that lives as long as its session. Diagnostics that nothing replays, such as raw provider stream milestones and deltas, are debug-log records that stay searchable beside the store. They are never facts or session-directory files, and no projection, report, or product behavior reads them. A new fact family names its aggregate, schema owner, causality, and projection consumers.
Because: Causal detail without a consumer turns the store into telemetry clutter and an untyped dumping ground.

## ARCH-SUBSTRATE-006: Every fact has explicit scope and parentage

The logical substrate distinguishes workspace, session, workflow, conversation, and child-run scopes wherever the distinction affects ownership or causality. Every fact has a stable aggregate, a schema owner, an actor, a causal parent where one applies, and an ordering rule. Cross-scope projections join facts through recorded identities, never through inferred timing, file names, or ambient process state. Physical storage may be shared or split across tables and aggregates.

Not: One physical global log; logical coherence and stable identities matter, not storage locality.

## ARCH-SUBSTRATE-007: Causal chains join through recorded identities

Flywheel can explain each chain from a user goal through launch, work node, assembled prompt, model request, tool or subagent result, handoff and validation, and recorded effect to the proof shown to the user. Durable facts carry the identities and request evidence that join these steps, and transitions record why they occurred, not only the resulting status. Important decisions never live only in prompts, logs, cache rows, or UI prose.

Not: A dedicated causal-graph projection.

## ARCH-SUBSTRATE-008: Nondeterministic boundaries are recorded with honest replay limits

Every boundary where nondeterminism enters records enough identity, inputs, outputs, hashes, and causality to explain what happened. These include model calls, tool calls, shell commands, file observations, network responses, user actions, and external-system transitions. An unrecorded boundary is an architectural defect. Replay at a boundary only serves the recorded result, verifies that the same request would be made, re-executes an allowed effect and records a new outcome, or stops because the boundary cannot be replayed safely. Captured text never makes an environmental side effect replayable, and runtime caches and provider continuation ids are never replay authority.
Not: Claiming that a replay of recorded history reproduces the external world byte for byte.

## ARCH-SUBSTRATE-009: Meaning arrives only by appending

Correction, supersession, retry, re-specification, and recovery are new facts, never edits to recorded history. A different future forks from a coherent prefix and appends. Git history is not a substitute for runtime causality.

## ARCH-SUBSTRATE-010: Runtime events are one closed union

Runtime events form one closed discriminated union in the shared foundation layer, and every consumer of it is exhaustive. A new event extends the union and every exhaustive consumer in the same change.

## ARCH-SUBSTRATE-011: Known facts are decoded once by their schema

A reader of a known fact decodes it once through its schema and reads typed fields.

Because: Hand extraction validates and discards, then derives again what the schema already defines.

## ARCH-SUBSTRATE-012: History crosses one strict-first recovery boundary

Historical facts cross one reviewed recovery boundary: strict parsing first, then only family-owned salvage rules, then typed degraded gaps that preserve chronology for bytes that stay unreadable, without inventing parentage or executable evidence. Recovery never changes stored parentage, and the one recovered history feeds both transcript display and provider context.

Because: Separate recovery paths for display and execution would let the transcript and the model disagree about the readable past.

Not: Separate tolerant readers for display and for provider context.

## ARCH-SUBSTRATE-013: Unreadable history is immutable and blocks nothing

Bytes that cannot be decoded are never rewritten, retired, deleted, or replaced by a reader or a migration, and recovery projects typed gaps around them. Startup and passive reads do not mutate the store, and a session-local decode or migration failure never blocks workspace startup, another session, or later appends; the session catalog records it as a per-session error. Only a failure to open the project-wide store or the project directory is a startup failure, because no session boundary exists below it.

Not: Rewriting or deleting unreadable facts to repair a session.

## ARCH-SUBSTRATE-014: Project notification history is the one disposable domain

Project notification history is the one durable state exempt from the immutability of unreadable history, because it holds no user work, executable control, or replay evidence used outside notification presentation. Before runtime readers open the store, its owner folds the whole history strictly, and on any failure it discards the whole history and its sequence authority at once and starts empty.

Because: Malformed notification history must never block startup, and discarding it loses nothing a person depends on.

Not: Repairing individual rows, publishing a partial projection, or keeping sibling notifications.

## ARCH-SUBSTRATE-015: The rendered transcript is derived

Every agent transcript is derived at read time from its session's conversation and execution facts, and live output is an in-memory tail over the same logical transcript. No rendered-output cache, persisted output block, final transcript snapshot, or server-owned layout measurement is a durable authority or recovery source. A workflow has no transcript of its own, and its presentation contributes only header and navigation.

Because: A presentation copy makes convergence and repair load-bearing.

Not: A durable rendered-output index or a separate durable transcript for workflows.

## ARCH-SUBSTRATE-016: Projections are registered, held, and advanced

Every projection registers its lifetime with the projection registry. It is never built per call. Its key names its family and every id it closes over, and nothing else. A key part that the fold never reads splits one owner into duplicate folds. A held projection may start from a persisted fold of its own key and placement that proves itself current (ARCH-SUBSTRATE-003, ARCH-SUBSTRATE-046), then advance. A reader that does not feed a projection reads it by replay, which folds only new facts and sees other processes' commits. Only the owner that feeds a projection reads its current state directly.
Because: Rebuilding a projection discards its cursor and repeats history.
Not: Constructing a projection inside a request or change handler.

## ARCH-SUBSTRATE-017: Hot paths read live owners and do work bounded by the change

A hot path runs per store change, per fact batch, per tick, per live subscription, or per member of a loop. It reads the state its owner already keeps live instead of adding a durable reader. Its cost per change is proportional to what changed, never to member count or history length, and it advances a kept fold from its last position instead of reading an aggregate from its start. Only one-shot paths, such as an explicit person command, a migration, recovery, or startup, read an aggregate in full, and never once per item of a loop.
Because: A durable read per member inside a change handler is quadratic over a run and starves commits.
Not: A cache keyed by sequence that reads everything again when the sequence moves.

## ARCH-SUBSTRATE-018: The state Worker is the only primary writer

The state Worker is the only live owner and writer of a project's primary store. The executor opens no primary connection. Its reads cross the state Worker's asynchronous port. Its local writes are a bounded transport buffer, and each atomic item commits in the state Worker and is acknowledged only after commit. Auxiliary Workers may hold read-only readers, but every write they make crosses the state Worker.
Because: Every connection competes for one database write lock, so a separate connection is not separate access.
Not: A second writer connection for maintenance or for the executor.

## ARCH-SUBSTRATE-019: A local read is never older than the store at the call

A read that the executor answers from its local window of committed facts is never older than a read of the store at the time of the call. A foreign commit, a notification gap, or a detached transport re-anchors the window, a read that the window cannot answer exactly goes to the state Worker, and a closed transport ends the window.

## ARCH-SUBSTRATE-020: Search and summary indexes and the fold cache are separate derived databases

The session-summary index, the conversation full-text index, and the projection fold cache are separate rebuildable databases derived from primary facts, which remain the only authority, and each belongs to its store's state generation. None adds an index to the primary store or work to the primary append path. Index replay is bounded, yields between pages, and never blocks the reads that their Worker serves, and malformed history degrades only its own session's scope.

## ARCH-SUBSTRATE-021: An oversized durable request is a local persistence refusal

Each complete durable request is measured before admission, and each durable payload crosses the state boundary once. An indivisible request above the limit is a typed local persistence refusal that states its size, the limit, and whether publication had started or settled. It is never reported as a provider failure.

## ARCH-SUBSTRATE-022: Session content has one content-addressed byte owner

One content-addressed store, keyed by session and content hash, owns every byte of large session content, such as recorded tool output. Facts and conversation entries carry bounded typed references, and content commits in the same atomic append as the first fact that references it, so a reference never exists without its bytes. Writers prove each reference at append and readers verify exact content when they restore it. Content belongs to its session and leaves the store with it, so no reference counting exists.

Not: A second byte owner, a separate lifecycle store, or a periodic collector.

## ARCH-SUBSTRATE-023: Large display evidence is chunked and settled by closure

Large display evidence such as patches is stored as immutable bounded chunks in the session content store, and a settlement names a root only after its complete hash-and-length closure is proven. Per-file settlement owns applied evidence independently of the tool result, and every other record carries references, never another copy. Derived display content never authorizes Undo.

Because: Whole-patch rows are indivisible and unbounded, and a copy in a result becomes a second authority.

## ARCH-SUBSTRATE-024: In-flight state is a hold, not history

A value that exists only so that an interrupted operation can finish is an in-flight hold: it has one live version and is never a fact source. If only the writing process reads it back, it lives in memory. If another process must finish the operation, it lives in a companion hold store beside the log, guarded against concurrent writers. A hold is written before its protected action. It is retired in the same commit as the fact that records the outcome, even when that fact lands in another session. Deleting a session clears its holds.
Because: Recording one live value as append-only facts accumulates unreachable revisions and then needs a second mechanism to delete them.
Not: Storing in-flight progress as fact revisions with a later terminal fact that only makes earlier rows unreachable.

## ARCH-SUBSTRATE-025: Every fact family declares its retention shape

Every durable fact family declares in one registry whether it is history or replace-only. Read surfaces consult a history family's settled rows. They consult only a replace-only family's newest row, and its superseded rows are pruned as loss-free dead weight. A terminal fact that enriches the record is history. One that only makes earlier rows unreachable marks an in-flight hold, which does not belong in the log. An undeclared family is a defect, so no family accumulates by omission.

## ARCH-SUBSTRATE-026: Retired-data deletion is bounded and never compacts beside a live project

Deletion of retired fact families runs in bounded state operations that each delete one chunk of one family, with pauses between them, so the state Worker serves other work in between. No path beside a live project compacts the whole store; reclaiming space belongs to an exclusive store owner or an explicit maintenance command.

## ARCH-SUBSTRATE-027: Historical rewrites validate first and isolate failure

A migration rewrites history only after it parses and validates it, and it isolates failure per session. It preserves meaning, and byte identity where the format records it. A semantic adoption first decodes every candidate against the current schema. Then, before any reader opens the store, one transaction rewrites the candidates and appends the fact that states the adoption. A failed adoption refuses the whole workspace and completes nothing.

## ARCH-SUBSTRATE-047: A stored fact shape changes in place only by adoption or a representation-only pass

Inside a readable state generation, a stored fact shape changes in place only by semantic adoption or by a representation-only pass. Neither form permits reader fallbacks, ad hoc repair during replay, or a semantic rewrite without recorded evidence. A representation-only pass moves between two valid current shapes, appends nothing, and leaves an unconverted store fully readable.

## ARCH-SUBSTRATE-028: An open with nothing new runs no migration pass

A module's historical migrations declare their phase and order. The kernel records which passes have examined history up to which position, so an open with no new fact and no new pass runs no pass.

## ARCH-SUBSTRATE-030: State generation retirement is declared, never inferred

A release states the disposition of every state generation it knows. Only a declared incompatible generation is retired whole, with its disposable artifacts, and the project then starts an empty current generation. Undeclared, corrupt, or unreadable generations fail closed with their layout untouched, and a generation newer than the release produces a named start refusal. Replacement happens only while no other process owns the generation and checks again that it is licensed at each destructive step. Its staged and held-aside bytes are crash-recovery files beside the store that no reader consults, and they are deleted once the replacement publishes.
Because: Inferring disposability from a failed parse would delete user history on a reader bug.
Not: Treating held-aside bytes as an archive, or retiring a generation on the word of a manifest alone.

## ARCH-SUBSTRATE-031: Session retirement requires a complete proof

Startup retires a session only when strict metadata replay fails, no tombstone exists, no recoverable session identity exists, and no metadata is newer than the running binary; any false condition preserves the exact bytes. Artifact deletion precedes the store transaction, and the next startup retries an interrupted retirement idempotently.

Not: Claiming atomic publication across the file system and the store.

## ARCH-SUBSTRATE-032: Recovery claims at open and repairs lazily behind a write gate

Opening a project or closing a generation claims only the sessions that a proven-gone owner left active. It records each owed recovery and pauses those sessions, keeping any capacity wait that a session owes. Claiming reads no history and waits for no repair. A recovery gate repairs an owed session before the first append or guarding read that touches it. Remaining repairs run in the background, and every other session recovers lazily at its own load, so reopening never scales with history. A session whose history this release cannot read stays paused.

## ARCH-SUBSTRATE-036: Accepted input is durable before a reader sees it

Accepted session messages, queued person messages, and accepted completion notices are each held durably before any loop reads them. The append that consumes one retires its hold in the same commit, so a crash never loses or duplicates accepted input. Input that arrives while a turn runs enters one next-turn mailbox that is consumed only after the current save point. Duplicate suppression keeps only a process-local hash.
Not: A second durable message ledger for deduplication.

## ARCH-SUBSTRATE-037: Crash recovery records actions, never unfinished prose

Tool calls, tool results, and file mutations commit as they happen, so a process that dies mid-turn loses only that turn's prose. The interruption record's identity derives from the interruption boundary, so concurrent recoverers write one record. Flywheel never re-executes an uncommitted tool call and never promises exactly-once delivery for external effects in that window.

Not: Adopting the partial turn, which needs ownership gates and races across processes.

## ARCH-SUBSTRATE-038: The conversation is the retry ledger

The event-sourced conversation is the ledger of what already ran. A retried attempt or turn resumes by replaying committed state and never runs it again, and a tool call whose result is committed stays in replayed history and is not executed again.

Because: A parallel record is a second source of truth for what already ran.

Not: A separate idempotency key, dedup record, or attempt resumed marker.

## ARCH-SUBSTRATE-040: Durable process records name a process by kernel identity

Every durable record that names a process stores the pid, the kernel start stamp, and the boot where the platform has one, never the process group. A process that cannot read its own identity still takes its locks and loses only protection against pid reuse. Records are published whole, so no writer leaves an empty claim or holder.

## ARCH-SUBSTRATE-041: Notification history is append-only facts with one projection

Project notifications are durable presentation history in one append-only project aggregate owned by the project-notifications module. Raised, resolved, and dismissed facts are the sole authority, and one strict projection rebuilt from them is the only mutable runtime representation. Clients and other consumers never persist notification status or copies of its presentation.

Because: A mutable current-notification table loses causal history and makes retries ambiguous.

Not: A mutable current-notification table.

## ARCH-SUBSTRATE-042: A notification episode is separate from its condition

A producer gives each condition one stable, secret-free source identity. Each raise of an inactive source records one episode with its own immutable identity and timestamps. Raising a still-active source is an idempotent retry that answers the active episode. Resolution and dismissal are independent observations that each name the source and the exact episode, and resolution frees the source, so a recurrence is a new episode. Visibility depends only on dismissal and a fixed lifetime from creation, and expiry is a read-time predicate that never appends a fact.
Because: Expiry is fully derivable from immutable creation time, and one status field would make resolution and dismissal mutually exclusive.
Not: One status field that holds resolved and dismissed, or an appended expiry fact.

## ARCH-SUBSTRATE-043: Notification replay is strict and writes are sequence-guarded

The notification journal replays its aggregate strictly and stops on malformed facts, sequence gaps, duplicate active sources or episodes, and transitions with no exact raised target. Every write is guarded by the next aggregate sequence, and a conflict reconciles the unread suffix before any new decision, so retries and concurrent writers behave deterministically.

## ARCH-SUBSTRATE-044: Crash recovery invents no turn and gives no standing orders

An incomplete assistant message from a dead process stays canonical history at a continuation or tail boundary, without an invented user turn. Its interruption record separates tools with a recorded result from tools that were only called, and a turn that stopped on a question gets no such record. Restored queued user words return as user entries, and restored background notifications return as model-visible system entries. Only recorded continuation authority (ARCH-SESSIONS-039) continues a recovered turn, never a history entry.
Because: Claiming that a call without a recorded result ran would steer the resuming model to skip work that never happened, and a standing order to continue would outlive its turn.

## ARCH-SUBSTRATE-045: The kernel orders migrations and modules transform

The kernel owns the order in which historical migrations run and the exclusion of the workspace while they run. Each module owns only the transformation of its own facts and never schedules or locks history itself.

## ARCH-SUBSTRATE-046: Every rewrite of stored facts advances its scope's rewrite generation

In the same transaction as any update or deletion of a fact, the primary store itself advances the rewrite generation of that fact's aggregate and family. So no maintenance, migration, or recovery path can skip it. Deleting an aggregate always advances its generation. A derived database that reuses folded state proves that its scope's generation is unchanged since its first folded fact. It ignores a deletion of rows of a replace-only family inside a living aggregate. Such a deletion removes only rows that no fold keeps, which are superseded rows and versions that the current code cannot fold.
Because: A rewrite path that must remember to announce itself is one forgotten line from a silently stale cache.
Not: An appended statement fact per rewrite, which representation-only passes and history discards do not write.
