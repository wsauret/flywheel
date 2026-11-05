# Context Architecture Intent

This file states how Flywheel assembles model-visible context, keeps it inspectable, and compacts it.

## ARCH-CONTEXT-001: Every context source has one owner

Everything that enters a model request comes from one owning source, such as a conversation, a workflow context projection, a definition, a package, a project file, the memory store, the tool surface, or a runtime setting. The owner decides the source's content and contract. Prompt assembly selects and renders sources; it never becomes a second authority for their content.

Not: prompt-specific stores that copy source content for assembly.

## ARCH-CONTEXT-002: One shared assembly path per domain

Every model request goes through its domain's shared context assembly and the request-audit boundary. The active branch is projected deterministically into the runtime's message history, and every resumable caller, chat, subagent, and workflow agent alike, uses that one assembly path; a provider-side continuation token can shorten a request but is never semantic history and never replaces the conversation tree. A local filter or a separate prompt path that changes model-visible context without recording the decision is a second context authority and is forbidden.

Not: An ephemeral conversation cache for child execution.

## ARCH-CONTEXT-003: Hidden authority is forbidden

Hooks, automatic checks, background tasks, and runtime coordination can attach evidence, reject an invalid transition, or produce a recorded notification, but they never change the next prompt invisibly. Anything that becomes model-visible crosses the normal context or conversation boundary with provenance, as a typed fact, a durable conversation entry, or an attributable tool result. Runtime coordination can stage work, but it is not a private prompt channel.

## ARCH-CONTEXT-004: Provenance travels with selection

A selected source carries enough provenance to identify what supplied it and which version or content identity was used, so that two different files, package revisions, definitions, tool surfaces, facts, or settings are distinguishable. Bulk prompt content is content-addressed and deduplicated per conversation. Context transformer records hold only stable application, transformer, seam, order, outcome, and input and output hash identities, never copied prompt, message, memory, tool-schema, or replacement bytes, and a context application records its ordered transformer sequence once for later requests to reference.

Not: storing every full prompt independently, which makes storage grow quadratically with repeated conversation prefixes.

## ARCH-CONTEXT-005: Durability claims match the boundary

A boundary either retains the content it selected, or a source that reproduces it, or reports exactly what it did not retain. A content hash names bytes only when Flywheel retained them; otherwise it is evidence of identity, not of recoverability. An unavailable result that names the gap is an honest outcome and is never replaced by a best-effort reconstruction presented as exact.

Not: treating every boundary as fully reconstructible, because some runners deliberately keep ephemeral working conversations.

## ARCH-CONTEXT-006: Request audit is per provider request

One audit identity covers one provider request, and every retry and provider fallback is a distinct request. Request audit evidence is recorded durably before the request is dispatched. Audit evidence never holds credential-like values or arbitrary provider extension bytes.

## ARCH-CONTEXT-007: Reconstruction is verification

Request reconstruction rebuilds the prompt from the unchanged durable conversation and recorded transformations, and checks the result against the recorded identity. A mismatch is a failed verification. A missing conversation, source body, or transformation record produces an unavailable result that names the gap.

## ARCH-CONTEXT-008: A transport that changes a request states its changes

A transport that changes a request after Flywheel prepared it records each addition by part, kind, and position without its content, and lists the requests that it sent by itself. An addition that the transport did not state is marked as not recorded. Text that a provider engine adds to an agent's request is recorded in that agent's canonical history as hidden system-origin entries, so the request that a provider received stays inspectable and reproducible. A transport that serves several agents in one process attributes each request that it sent, and each failure that the service returned, to the agent that it served by the engine's own per-request key or the service's request id, never by order of announcement.

## ARCH-CONTEXT-009: Only recorded conversation content is model history

A rendered pane or live output buffer is not model history unless its owning domain records it as such. Display-only entries, cache markers, and retry bookkeeping are not model-visible conversation content. No fabricated assistant tool call or unmatched tool result ever enters provider history. Runtime-originated activity, such as a workflow invocation that the runtime starts, is anchored to an ordinary conversation entry and renders from its own facts only on branches that hold that anchor, and a change of its result refreshes the row without a new conversation entry.

## ARCH-CONTEXT-010: Exclusion and transformation are recorded

Content that is withheld from the model, truncated, summarized, compacted, superseded, masked, or lowered across incompatible model contracts carries a recorded decision and reason, not a silent filter. A recorded transformation keeps enough identity that reconstruction can replay the same provider-facing history from the unchanged conversation. Each canonical tool call keeps the registration that produced it, and outbound history lowers calls from registrations that the pinned request does not hold into neutral operation context with their recorded results, while the durable conversation stays exact and request evidence records what was lowered. A provider's refusal of conversation content is repaired by the agent loop and never retried by the walk or the runner: the loop appends one decision entry whose note replaces the withheld content for the model, every later request applies the decisions its branch holds, and each decision withholds a new part of a finite set.

Not: Failing over to another provider on a content refusal.

## ARCH-CONTEXT-011: Stale tool masking is a reversible request-time tier

Stale tool-result masking changes only the outgoing provider request, never the durable conversation, and records enough audit metadata to explain the assembled request. Masking decisions persist across process restarts and are not recomputed in a way that breaks the cached request prefix. Compaction restarts masking from the fresh context. Reference material that defines project or architectural policy, the instructions of a loaded skill, and the person's answers to the agent's questions are never masked.

## ARCH-CONTEXT-012: Compaction is a recorded reset

Compaction is a recorded context reset with no summarizer request, and an interrupt withdraws it only before its append is accepted. Only a run that holds the scoped checkpoint authority and tools resets, and no other run truncates its own context in place. Voluntary idle compaction belongs to the chat runtime and resets only after a successful checkpoint write. Its deadline comes only from a minimum cache lifetime that the provider states for the request that served.
Because: A deadline guessed from a model name resets chats whose cache is still present or misses ones that expired.

## ARCH-CONTEXT-013: Working context has distinct owners and lifetimes

Permanent guidance lives in project instructions or its architecture authority, durable cross-session facts live in memory, and current working context lives in each conversation's one typed checkpoint. None of these copies another. Historical generated summaries remain readable conversation entries and are not checkpoint state. Scratch files are disposable staging and never hold working context as an authority.

## ARCH-CONTEXT-014: A checkpoint belongs to its conversation

The checkpoint tools bind to the owning conversation, and no tool input selects another conversation. Every child holds them beside handoff whatever its persona grants, because they belong to the child surface rather than to the parent's grant, and a continuation adds them without rewriting the stored grant. Children report through handoffs.

## ARCH-CONTEXT-016: Large optional context is disclosed progressively

Large references, manuals, documentation, provider notes, and package bodies enter context only when the model or a definition selects them. A roster may advertise package triggers in their authors' words within admission limits, and a person cuts its cost by uninstalling packages. Small bounded context, such as a memory snapshot, loads eagerly when that is the simpler measured design. A rule enters the always-loaded instruction kernel only when every turn needs it.
Not: Eagerly injecting every available reference.

## ARCH-CONTEXT-030: Packages reach context only through declared paths

A package reaches context only through declared composition, model loading, or a user command. Its body is never copied into the instruction kernel, a brief, or a persona. Loading renders one canonical package context, grants no authority, creates no active-package state, and causes no reinjection. A declaration that names an uninstalled package is a definition error.

## ARCH-CONTEXT-017: Learned context is fallible evidence

User-global and project instructions, memory, and loaded skills are point-in-time evidence, not authority over current code, configuration, external state, or user intent. An agent verifies them before relying on them. The context domain owns their selection, rendering, attribution, exclusion, and inspection; the learning domain owns what they contain and who may change them.

## ARCH-CONTEXT-018: Agents share one stable prompt prefix

Every workflow agent and subagent gets one generic handoff schema and one stable system-prompt tier, and every agent and side call of a chat tree gets byte-identical tools, descriptions and schemas included. An agent's own material, its brief, instructions, context bundle, output contract, and the advertised tools that its grant refuses, goes in its opening user turn on every route, never in the system prompt. A fork does not copy another agent's grant. Material shared by one workflow or session, such as approved parent intent or the dispatchable persona catalog, renders once in the session tier after the stable prefix.
Because: tools come first in a cached request, so a per-agent tool set or system prompt breaks cache reuse across siblings.
Not: narrowing an agent's tool set by persona instead of refusing ungranted calls at execution.

## ARCH-CONTEXT-019: Workflow context flows in one direction

Workflow context is a projection of facts that their writers own, such as handoffs and the live durable artifacts after supersession. Prompt assembly renders this projection and keeps no other workflow context store, and an agent never receives stale durable copies.

## ARCH-CONTEXT-020: A stream agent is a scoped recipient

An agent of a stream receives exactly the shared bundle that its list froze, its own predecessor's handoff, person addenda, and its own item, and never a sibling item. Item records reach workflow scope only through the list's one post-join entry after the join settles, so settlement order never changes what any agent receives. One expansion serves both later agents and the parent, so both read the same result, and each record a recipient does not see is listed with its reason.

## ARCH-CONTEXT-021: Writer file evidence comes from recorded mutations

File evidence shown for a writer agent comes only from the mutations that its own tool calls and the child sessions those calls launched recorded, never from the working tree's uncommitted state.

## ARCH-CONTEXT-022: Standing modes are stated as recorded turn reminders

A module states a standing mode beside the person's turns as hidden, recorded, system-origin statements: one when the mode starts holding, periodic reminders while it holds, and one when it stops. The conversation history alone decides the next statement, so a resumed, forked, or compacted conversation decides correctly, and a disabled module still delivers its stop statement.

Because: guidance read only in the system prompt was not followed reliably against competing rules.

## ARCH-CONTEXT-023: External invocation adaptation is attributable

An external skill package remains the source of its upstream instruction bytes. Flywheel adapts an invocation only at the host boundary, and the adaptation identifies the package revision and keeps the unmodified upstream bytes separate from each host-rendered addition. Reconstruction recovers the source and the invocation separately, and a combined hash never implies that host additions came from upstream.

## ARCH-CONTEXT-024: The project root bounds project instructions

The project root bounds which project instructions are authoritative. When the execution directory is inside the project root, the contained instruction chain from the root to that directory loads; when it is outside, only the project-root chain loads, and loading never walks into an enclosing or unrelated repository.

## ARCH-CONTEXT-025: Instruction sources are selections with identity-checked reads

User-global and project instruction files and their explicit imports are source selections, not recursive discovery: they follow links, keep the logical path for attribution, resolve nested imports from the canonical target, and deduplicate by canonical target. A project-scoped source cannot reach, through an alias, account-home content outside the project, Flywheel-owned state, or dotenv credentials. The authorized file identity must still hold for the opened file before any bytes enter model context, and every omitted import of one load is reported in one diagnostic without changing the authored text. A discovered instruction file that cannot be read, is not a regular file, is not valid UTF-8, or changes during the read is omitted with its logical path and reason, and its labelled section states that it is unavailable; a failed instruction source never fails the run.

## ARCH-CONTEXT-026: Request context is assembled once and evidenced before provider I/O

Request admission computes the request-stable prompt, the module transformer chain's result, and the provider tool definitions once, and each attempt reuses them and adds only attempt-local provider notes. Before provider I/O, one immutable prepared-attempt record binds the interaction profile, executable tool registrations, prompt hash, schemas, omissions, transformer identity, models, catalog and pricing provenance, tokenizer, and provider, and neither an adapter nor profile projection can change it after admission.

## ARCH-CONTEXT-027: A compaction reset records its boundary and reopens context in one commit

A compaction entry records its source leaf boundary and the replaced context size and never rewrites earlier messages, and reconstruction continues from it with the later branch entries. The reset opens fresh context in the same commit with one recorded opening message that holds the current checkpoint, the unattended brief when the run has one, the save state (saved, not saved, or empty), and recovery instructions, and the transcript shows that message as the compaction report. While a planned compaction waits for its save, only the checkpoint tools run. A missing or cross-branch source boundary is an invariant violation.

## ARCH-CONTEXT-028: Deliberation persists byte-exact and is never rendered

The durable conversation holds everything needed to rebuild the next request, including provider deliberation byte-exact with the serving attribution that same-provider replay reads. Deliberation replays only to the access provider, API, and model that produced it: one shared lowering of provider history withholds all other deliberation from the request, sends blocks marked as user-facing progress as assistant text, and records what it withheld in the request evidence, and the context estimate applies the same rule. Display projections never render deliberation, and provider blocks marked as user-facing progress keep their signed envelope and render as assistant text.

Because: Provider signatures bind to the original bytes and the producing model, a rebuilt context must replay what the live loop held, and a model reads another model's deliberation in plain assistant text as its own visible reply.

Not: Stripping or masking provider reasoning at write time, or demoting foreign deliberation to assistant text.

## ARCH-CONTEXT-029: One admission budget bounds context between requests

One context admission budget bounds what enters the next request between requests: tool results of a batch and subagent results delivered with it draw from the headroom that the next planned save needs, so content that lands below the compaction trigger never pushes the save request past the context window. Reads keep their exemption only inside the fixed share of the window. Each finalized result records the bound in force, so recovery replays the same bound.
