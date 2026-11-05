# Sessions Architecture Intent

This file states how Flywheel organizes sessions, conversations, child sessions, and their lifecycle.

## ARCH-SESSIONS-001: A session holds one conversation, and a workflow is not a session

Every chat, subagent, and workflow agent is a session with one identity and exactly one agent conversation, held as a durable conversation tree. A workflow identity never names or resolves as a session, and two runs of one definition are two workflows whose agents have separate sessions. Definition provenance is recorded apart from run identity.
Not: An orchestration session that owns a workflow's agents.

## ARCH-SESSIONS-002: Each session concern has exactly one authority

Session metadata alone owns a session's kind, label, lifecycle, conversation identity, workflow membership, local choices, and relationships. The conversation tree owns resumable messages; the workflow aggregate owns the run's configuration, launch binding, request, and control; and the session store owns the active runner pool and the runtime projection of live output, tokens, cost, and activity. Cross-references between these owners are pointers, never copies.
Because: Labels, lifecycle, and launch relationships are not conversational history.
Not: The conversation tree or the session store as owner of lifecycle or relationships.

## ARCH-SESSIONS-003: Persisted lifecycle has two states and one owner

Persisted session lifecycle is only active or inactive, and the session manager is its sole authority and the sole authority for session relationships. Every lifecycle change goes through the session manager, and clients read lifecycle only through protocol projections. Deletion is an action, and workflow outcome, history, parent and child links, and child supervision live with their own owners, never as session states.
Because: Extra status fields, shadow signals, or new state stores create competing lifecycle authorities.
Not: Archived, trashed, completed, or paused session states, or a status field on another store.

## ARCH-SESSIONS-005: Every session that replays is an ordinary session

Every session whose metadata replays is an ordinary loadable session. Metadata replay creates no provenance, refusal, or notice states and no separate directory lifecycle.
Not: Special lifecycle states for sessions from other builds or moved directories.

## ARCH-SESSIONS-006: Auxiliary work belongs to the session or workflow that performs it

Auxiliary work belongs to the session or workflow aggregate that performs it and never creates a synthetic session. A chat's session-scoped module hosts outlive individual turns and own the cancellation and awaited disposal of that auxiliary work. Typed execution resources belong to the agent sessions that use them, while workflow bookkeeping and work-owner controls belong to the run.
Not: A synthetic session for each auxiliary task.

## ARCH-SESSIONS-007: The session directory is disposable

Durable session state, including each conversation's checkpoint and every earlier version, lives in the project store. The session directory holds only an ephemeral process lock and disposable scratch, under the project root and in the same state generation as the project store, so retiring the generation retires it. Deleting a session removes its directory before it records the deletion and never purges immutable history.
Because: A recorded deletion whose directory survives leaves artifacts that no listed session names, while a missing directory is one a later start creates again.

## ARCH-SESSIONS-008: Each conversation owns one versioned checkpoint

Each conversation owns one typed checkpoint whose every version is a durable fact in its session's history, and the current checkpoint is the latest version regardless of branch or rewind. Each write validates the complete checkpoint and refuses an oversize value without changing anything. A learning review keys its checkpoint by its review run, and a workflow review keeps it in the workflow aggregate that owns the review.
Not: Silently truncating a checkpoint to fit its limit.

## ARCH-SESSIONS-009: Every started child has a durable child session before it runs

Every new subagent and every started workflow attempt receives its own durable child session, conversation, and run binding before it acquires a slot or a runner, and an agent that never starts creates no session. A subagent's publication binds it to the parent tool call atomically and records its task and complete instructions first; a workflow attempt's session publishes directly under the launching chat in the same commit as the attempt start, with immutable workflow and attempt membership. Workflow scheduling stays in the workflow host, outside subagent admission.
Not: Ephemeral or inline child conversations, or conversation persistence as a runtime mode.

## ARCH-SESSIONS-010: A child owns its own state, and the parent owns only the call

A child session owns the delegated agent's conversation, runs, request evidence, usage, budget, lifecycle, scratch, recovery, and inspection surface. The parent owns only the launching tool call, its eventual result, and the live link that routes control and completion, and it never mirrors child state. Clients inspect a child through the ordinary session views. Inline subagent runs recorded before child sessions existed stay in their original facts and presentation, and Flywheel never migrates them into synthetic sessions or invents history they never retained.
Because: A parent-owned record cannot give the child independent lifecycle, scratch, recovery, or inspection without duplicating session machinery.
Not: Rebuilding a child's context from the parent transcript's card output.

## ARCH-SESSIONS-011: A workflow agent inherits its run's choices through membership

A workflow agent's membership is immutable and binds it to its run, from which it reads its auth profile and execution directory. The agent owns only its explicit local model overrides.
Not: A synchronized copy of the run's choices in each member session.

## ARCH-SESSIONS-012: A new workflow attempt is a new session; a subagent's later run is not

Each workflow retry, overflow continuation, or failed-run reopen runs in a new attempt session, and earlier attempt sessions stay immutable history, not resumable workers. Each subagent run binds to one parent session, conversation, and tool call before it executes, and a Resume after a non-completed outcome is a new run in the same child session under the original binding that never rewrites an earlier run or a settled parent result. Interrupt, planned replacement, crash recovery, and in-run provider recovery keep the current run, and a completed workflow admits no new conversation.

## ARCH-SESSIONS-013: Live ownership is distinct from immutable ancestry

A live child link exists only while the child's current binding names that parent, and the latest adoption supplies that binding without rewriting the launch. Only the live binding authorizes completion, direct-child control, settlement, and deletion. Immutable creation, link, adoption, and fork facts serve inspection and accounting, survive unlink and deletion, and tolerate missing endpoints, and live child supervision is derived runtime state.
Because: Launch, adoption, and fork lineage is history, not current ownership.

## ARCH-SESSIONS-014: Deletion follows current work ownership under one fence

Recursive and automatic deletion follow current work ownership: workflow launch bindings, immutable membership, and current child bindings, including a workflow's members and their nested children. Deletion admission, activation, and child publication serialize under one structural mutation fence, so no child publishes under a parent whose deletion was admitted, and deletion settles from leaves to root with recovery keeping the admitted target set. Automatic deletion of unused chats is an account-scheduled lifetime owner that deletes through the public delete path and never opens a dormant project for cleanup.
Not: A generic cascade over launch and fork lineage.

## ARCH-SESSIONS-015: Each child kind's owner controls its children

Each module that launches child sessions registers the owner of its child kind, which supplies the child's Stop, the parent's Resume, the child's latest cut, and its progress. The kernel finds a child from its durable launch binding, never from the parent runner's memory, and routes each control to that owner, so kernel code reads no module-owned fact. A parent controls only its own children through the kernel's process control, the dispatch tool starts children and never controls them, and progress derives from the child's own records on every read.

## ARCH-SESSIONS-016: Stop belongs to the parent's tool call

Every Stop of a subagent, a child workflow, or a background command is addressed through and terminates the parent's tool call, never through the child's chat interrupt. Stop is durable and distinct by actor. Concurrent Stop and Resume of one waiting run cannot both take effect, so neither settles or starts the wrong attempt.
Not: A child-specific Stop control or a Stop through the child's chat interrupt.

## ARCH-SESSIONS-017: Child controls run only after their call commits

Interrupt, resume, and stop of a child are not concurrency-safe and run only after the assistant message that calls them commits, so a crash never leaves a child control without its call in the parent's history. The runtime and crash recovery read a call's contract from the tool registration recorded with that call, never from its input alone.

## ARCH-SESSIONS-018: Interrupt is the one resumable cut, and its actor is a parameter

Interrupt is the one resumable cut of every agent-shaped session: a chat turn, a subagent run, and a workflow agent. It is the ordinary per-session interrupt with its actor, the person, a parent agent, or the runtime, as a parameter that its turn-end record keeps (ARCH-SESSIONS-035). Interrupt never ends background work, which keeps its own terminal Stop, and interrupt and continuation of one session take turns in one lane where the person's latest decision wins.
Not: A person-facing pause beside Interrupt, or a separate interrupt-actor field beside the turn-end record.

## ARCH-SESSIONS-019: One predicate decides whether a parent may continue its child

One admission predicate decides both whether a parent may resume its child and whether a parent's message continues it: the parent may continue every cut that a person did not make. Behind a person's interrupt or Stop, the parent's Resume refuses and its message stays held. Rules test for the runtime actor, never for the person.

## ARCH-SESSIONS-020: A child runs only under its direct parent's live runtime

Every subagent run, including a Resume, a parent's message, and a planned-replacement continuation, runs in the shared runner host through its direct parent's live host, borrowing the parent's execution environment, child slots, and foreground command control while keeping its own session identity, role, and profile. Without a matching live parent host, Resume refuses, and a child ends when its parent's host closes. An unsettled run without continuation authority becomes crash-interrupted and inactive, and its binding, saved task, capabilities, limits, conversation, and queued input supply resume authority.
Because: The session actor, runner host, and durable run binding already own continuation and recovery.
Not: A private host, adoption path, child-specific coordinator, or child process for a subagent.

## ARCH-SESSIONS-021: No automatic retry of a child

A new run of a child is new delegated work that only an explicit Resume by the parent or a person starts. Crash recovery leaves an interrupted run alone, marks an unsettled run crash-interrupted, and waits; a run that a capacity wait owes continuation continues as the same run when its time comes. In-run recovery from provider faults and stalls reruns the generation from the recorded conversation inside the same run.
Because: Resume availability is a capability, not permission to retry.
Not: Automatic retry that starts a new run after a failure or crash.

## ARCH-SESSIONS-022: Child completion is reconciled from durable authorities

Child completion derives from the child's terminal run facts, the run binding, and the parent conversation's tool state. Reconciliation settles a pending parent tool call and holds the model-visible notification in one atomic publication keyed by the child runs it covers, for every kind of parent. A completion stays owed until its keyed entry commits into the parent conversation, failed delivery is scheduled again, and recovery never runs the child again to recover a result.
Not: A parallel deduplication table or delivery receipt for completions.

## ARCH-SESSIONS-023: One outstanding-work set governs waits and handoff

A session's background registry holds its running work and its owed results as one outstanding-work set, which waits, automatic completion, and handoff readiness all read. A child that its parent or the runtime interrupted leaves that set, so no wait parks on it and it blocks no handoff, while a child that a person interrupted stays in it. No interrupted child blocks a replacement. ARCH-TOOLS-031 states how background commands enter the set.

## ARCH-SESSIONS-024: Handoff admission is one verdict at stream start

A subagent or workflow agent decides handoff admission once, when the handoff call starts streaming. With no outstanding work, admission closes every kind of input and new background work, and the recorded verdict governs execution without a second readiness check. Once the handoff result is durable, the agent loop ends without ordinary turn-end policy.

## ARCH-SESSIONS-027: One kernel boundary delivers session input

Every direct message to a session, from a person, its direct parent, or another session, takes one kernel delivery boundary that targets the exact session through its registered live control. A person's send names only the session, and the runtime routes it to the owner of the session's kind. Consumed input becomes exactly one canonical user entry at the next save point of the same run.
Not: A separate send per session kind, or a child-specific message channel.

## ARCH-SESSIONS-028: Workflow input crosses a separate work-owner boundary

Input addressed to a workflow crosses a work-owner boundary distinct from session delivery, never a session alias. Parent or person direction becomes an addressed addendum that each covered agent reads once, and peer information is consumed by one reader. With no live control, accepted session input stays durable for authorized continuation and never transfers to an unrelated workflow sibling.

## ARCH-SESSIONS-029: The sender's identity reaches only the provider request

The sender's identity is added only to the provider request, and the stored entry keeps the message text alone. Submission identities likewise never enter provider message bodies.

## ARCH-SESSIONS-030: Submission identities survive merging and recovery

Every submitted input carries one opaque client submission identity, and merged queued inputs keep all of theirs. The committed message records those identities, so recovery replaces local rows by identity, never by matching text, and a resent send answers success (ARCH-SUBSTRATE-038). A chat open can likewise name its chat identity so that a repeated open converges on one chat.

## ARCH-SESSIONS-031: Unread input returns to its sender without becoming model input

When a recipient ends, input that no intended reader can consume settles: parent input can ride the terminal result, and each other session sender receives one durable notice. A successful handoff withdraws unread human input before recovery can adopt it and keeps it as a display-only notice in the root chat, with a pending return that only a lossless atomic claim naming a submission identity of the sending window can release. An unclaimed return stays claimable until the session is deleted, and returned input never becomes child or parent model input.
Not: Reservations, takeovers, or a separate replay domain for returned input.

## ARCH-SESSIONS-032: Reply waits exist only between parent and child

A reply wait exists only between a session and its direct parent or its own child, and the runtime refuses any other wait, and any wait that would close a cycle, before it delivers anything. A wait is one item of the waiter's outstanding work, so the run cannot complete while it is open. Its durable hold is the session's one record of open waits, which a successor run registers again.
Because: A wait between any other sessions parks one session on work that the other owns.

## ARCH-SESSIONS-033: The peer wake bound derives from history

The wake limit's hop count derives from each turn's inputs in recorded history: a person's message and a launch reset it, a peer message advances it, and parent-child exchanges and answered reply waits do not. Neither an interrupt nor background work resets a chain, and a resumed loop never holds a higher hop than the live loop held.
Not: A separate durable hop counter.

## ARCH-SESSIONS-034: No commit splits a tool exchange

The turn owner alone declares when a conversation writer is inside a turn, and a save point within the turn never ends it. Only an idle writer appends directly and runs interruption recovery. Notices that arrive mid-turn and module-owned held work commit only when no tool call awaits results, the turn ends, or the writer is idle.
Because: An empty buffer after the tool-call barrier is not the end of the turn, and recovery must never mistake a live turn's results for a dead process's.

## ARCH-SESSIONS-035: Turn ends are recorded in the conversation

A turn that ends without an answer records one turn-end entry where it ended, naming its reason and, for an interrupt, its actor. An exchange that the runtime answers itself records a settled entry that closes only that exchange. Resumability and every client's interrupted, crashed, and resumed state derive from these records, never from what began a process end or whether a stop finished, and the live parked loop and the durable conversation hold the same record.

## ARCH-SESSIONS-036: New turn-end spellings degrade to a known reason

A new turn-end reason or actor is spelled so that an older release reads it as the nearest reason it knows, and an older release reads an unknown record as a crash that admits Resume. The stored entry never changes.

## ARCH-SESSIONS-038: Attachment and passive reads never continue work

A session that a client shows has its runner attached on open and on every reattach, and a session that no client shows stays paused unless continuation authority owes it continuation: a planned replacement, or a capacity wait whose time has come. Startup, catalog, detail, transcript, render, and runner attachment append nothing and start no model request; attachment may start the provider engine processes that the session needs, which send none. A turn cut while it waited on background work parks again when it attaches. Outside continuation authority, only an explicit act of the person, a message, Resume, or an answer to a pending question, continues execution.
Not: Resuming interrupted work as a side effect of attaching a runner.

## ARCH-SESSIONS-039: Continuation authority records authority, not progress

A planned replacement records one durable continuation authority, never progress, for each session it interrupts, children included, before it interrupts work, and ordinary shutdown records none. Only the successor that consumes it resumes those sessions through their owning hosts, nested children after their parents, and a person's whole-session interrupt withdraws any continuation authority without discarding accepted input. A capacity wait records one durable continuation authority that names its continue time before it waits, and its continuation, a person's message, an interrupt, or a Stop withdraws it. The resident account service owns that wake, also after a restart or sleep, and continues the session through its owning host, opening a closed project through the canonical account project lifecycle.
Because: Conversations, retained input, and committed child control already show what ran.
Not: A dispatch ledger or resumed marker beside the conversation.

## ARCH-SESSIONS-040: Session close is the ordinary-work boundary

Session close stops new admission, aborts foreground and queued shell operations, hands running managed commands to the next build when the close belongs to a planned replacement, waits for every admitted dispatch to settle, ends every remaining registry task, and closes the host shell runtime only after its active work settles. Settlement callbacks, which close later completion notifications, drain last, and one failed callback never stops the others. Runtime-generation disposal and final host disposal close ordinary work in the same order before they release the process guardian, and no close reports settlement while the shell runtime still has active work.

## ARCH-SESSIONS-042: A fork carries complete causal state and publishes only when valid

A fork begins at a coherent committed boundary and inherits every durable state slice that can affect later context, including the conversation checkpoint, or explicitly invalidates and rebuilds that slice, and resume does the same by verifying a complete durable prefix. A fork writes the selected branch into a new conversation and validates it before it publishes the destination session and fork relationship, so a failure leaves no half-listed session, and a fork point that would orphan tool-call structure is refused. Workflow-agent conversations are resumable but are not chat forks.
Not: Forking only the conversation messages while keeping incompatible workflow, handoff, file, or tool state.

## ARCH-SESSIONS-043: A side conversation never writes into the main conversation

A side question runs on a copy of the chat's live context and appends nothing to the main conversation. Its bounded history is the one runtime-only conversation, owned by a session-scoped module host and ended by that host's disposal, while its request usage and inspection stay durable. Only an explicit keep action publishes it as an independent chat, before any navigation can show it.

## ARCH-SESSIONS-044: The runtime sets each message's producer

Each message has one durable producer that the runtime sets from the tool context and the model never sets. A parent's message is delivered only after the session authority rechecks the durable direct-parent binding, and delivery decides delivered, held, or refused from recipient state and producer provenance alone.
Not: Sender identity supplied by the model.

## ARCH-SESSIONS-045: Human provenance is explicit, never inferred

A person's message carries explicit human provenance on its canonical entry through queued recovery and compaction. A user role alone never establishes it, and unmarked history stays unknown. Completion notices and background notifications are system-origin input and never count as a person's turn.

## ARCH-SESSIONS-046: Turn-end records are facts, never instructions

Interrupt and crash records are model-visible facts, never instructions to continue. An interrupt record says that a tool call may have partially executed only when the turn's last results include an interrupted result. Recovery writes a crash record for an open turn before any other write lands in the session, and writes none over a branch that already ends at a turn-end record or for a settled workflow attempt.

## ARCH-SESSIONS-047: Each session owns an append-only conversation tree

Each session owns its own append-only conversation tree whose entries have stable identity, parentage, time, and a discriminated kind. The tree carries model-visible messages, display-only entries, compaction entries with explicit reconstruction boundaries, branch summaries, and leaf movement. Compaction and fork never destructively rewrite source history.
Because: Branching, compaction, display-only filtering, and save points become destructive rewrites in a flat log.
Not: A flat message log, or one project-wide tree that couples session durability and conflates session relationships with conversation parentage.

## ARCH-SESSIONS-048: Concurrent appends chain off the leaf they guarded

Several writers can extend one conversation. Every append that extends the active branch chains its entries off the leaf of the state that its sequence guard read, so a concurrent commit fails the guard and the append rebuilds from the newer leaf. No append attaches to a leaf that no longer ends the branch.
Because: An append to a stale leaf drops another writer's entry off the active branch.

## ARCH-SESSIONS-049: Turns commit at save points

A user turn commits before its provider request begins. Assistant output and tool plumbing accumulate in the writing process and commit as one validated batch at a save point (ARCH-SESSIONS-034); the store append is the durability boundary, and the in-memory projection advances only after it succeeds. Unflushed output is visible only to the writing process, forks and compaction operate on committed history, and ordered disposal performs a final flush.
Not: Fire-and-forget disposal of the conversation, which loses data.
