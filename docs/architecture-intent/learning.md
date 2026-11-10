# Learning Architecture Intent

This file states how Flywheel scopes, admits, records, and audits durable memory and skills.

## ARCH-LEARNING-001: Improvement lives in reviewable artifacts

Recorded outcomes improve Flywheel only through an attributable, reviewable change to a durable source that shapes later work. Recorded outcomes are evidence, explicit evaluation decides what changes, and one reviewable artifact carries each change forward.

Because: Hidden accumulation cannot be reviewed, evaluated, or reverted.
Not: Hidden prompt patches, opaque accumulated chat, or compacted session memory as the carrier of improvement.

## ARCH-LEARNING-002: Every learning has one canonical class

The learning system classifies each observation before it chooses storage. Each part of a signal goes to the one destination of its class. Preferences, stable context, and short lessons go to memory. Repeatable procedures go to skills. Shared repository guidance goes to its existing repository authority. Session working context goes to session notes. Enforceable invariants become code, tests, schemas, validators, tools, or definitions. Information that a current authority supplies is read fresh and never copied. Personal and general coding preferences never become skills. A repeated lesson goes to the destination of its class.
Because: Without one taxonomy, preferences become procedures, one-off facts become oversized skills, and project conventions leak into unrelated repositories.
Not: Writing a skill or changing a definition automatically whenever a failure repeats.

## ARCH-LEARNING-003: Memory and skills are fallible evidence

Memory and skills are evidence for an agent, not authority over current state. When memory or a skill disagrees with a current authority such as code, Git, or a durable projection, the current authority wins.

## ARCH-LEARNING-004: Approval scales with authority and reversibility

The proposer of a change to a durable source is not automatically its approver. The strength of the approval gate scales with the authority, reversibility, and blast radius of the change, so easily reversible low-authority context needs less ceremony than a shipping gate or a global definition. Every accepted change keeps its provenance and an undo or supersession path.

## ARCH-LEARNING-005: Learning scope is one independent property

Every memory entry and learned skill has exactly one scope, project or global, and project scope binds to the project root, never to the execution directory of a session. Scope is independent of authorship, mutation ownership, and loading state, and no one of these properties implies another.

## ARCH-LEARNING-006: Learning artifacts keep distinct authorities

Memory, skill package content, semantic-audit evidence, provider request diagnostics, and learning journal state each have one authority and never stand in for one another. The package owns its content, the pinned registry revision owns the bundled corpus, and the journal owns mutation intent. Skill and memory writes belong to the learning domain: they are not project file mutations and never enter session change review or Undo.

## ARCH-LEARNING-007: One journal attributes every learning mutation

Every learning mutation records its durable form, scope, action, origin, resulting content identity, and a mutation identity that the writer prepares. The learning journal records mutation intent before the artifact is published, so recovery can tell whether the write landed. The journal is the mutation outbox, never a second authority for package bytes, and two writes that leave the same content are distinct mutations.

## ARCH-LEARNING-008: Memory protection lives in the canonical memory store

Each memory scope has one canonical store whose entries carry their text and a protection flag; protection is never a second list or store. Only entry text counts toward the content limit of the store, and protected entries stay inside the same bounded snapshot. The memory boundary refuses autonomous replacement or removal of a protected entry.

## ARCH-LEARNING-009: Memory loads eagerly and skills load progressively

Bounded memory enters context as an eager, scope-labeled snapshot. A chat captures it when a person message starts a turn, and every agent of one workflow carries the one snapshot its workflow captured; a memory write takes effect at the next capture. A skill exposes only its routing trigger, scope, source, and package identity until selection or declared composition brings in its body and resources. Scope does not change this loading distinction.

## ARCH-LEARNING-010: The runtime publishes immutable skill registry revisions

The runtime owns the installed skill registry and publishes it as immutable whole revisions, and each request reads one revision. Runtime writes and watched changes from other processes publish through one ordered reload, and a runtime write reports success only after its revision is published. Each project's revision holds the complete bundled corpus and derives every corpus view, catalog, manifest, and composed prompt section, so no consumer keeps its own package list or body copy. A failed reload keeps the last complete revision, and removing a package requires a successful reading of its root.
Because: An editor's partial write must never delete a package or expose a shadowed install.

## ARCH-LEARNING-025: Malformed skill packages fail by origin

A malformed bundled package is a build defect. A malformed external package that never loaded is skipped with a warning.

## ARCH-LEARNING-011: Promotion moves one package

Promotion changes the scope of a package and leaves one authoritative location; it never creates an independent live copy. A project specialization of a global or bundled procedure uses a distinct skill id and declares the procedure it narrows. Two packages with one id are a precedence conflict, not a specialization.

## ARCH-LEARNING-012: Bundled skills have no learning-mutation route

Bundled skills are immutable canonical corpus that changes only through ordinary repository development and review. No learning review, cleanup classification, improvement observation, papercut, recommendation, or notification authorizes, queues, suggests, or publishes a bundled-skill change. Definition-improvement observations stay evidence about workflows and briefs under their own authority and are not a learning write path.

Because: Any such route would imply that immutable canonical content can be mutated.
Not: Routing bundled-skill improvements through learning signals.

## ARCH-LEARNING-013: Autonomous skill content requires a semantic audit

An autonomous learning review writes memory directly. Every autonomous mutation that adds or reactivates model-visible skill content requires a semantic audit of the complete resulting candidate before admission. This covers create, rewrite, patch, support-file addition, and restore. A background actor never edits repository files or session notes.
Because: Project scope limits reach but does not prevent duplicated, contradictory, or falsely specialized model-visible procedure.
Not: Letting autonomous reviews write project skills directly.

## ARCH-LEARNING-014: The pinned bundled corpus is the comparison authority

A semantic audit compares the candidate with the complete immutable bundled corpus of one pinned skill registry revision, including every bundled package that an installed package with the same id shadows. Installed precedence affects selection only. Admission depends on no network index, remote embedding store, or external taxonomy.

Because: An installed package with the same id can shadow a bundled package and hide it from a comparison based on the installed catalog.
Not: Comparing the candidate only with the installed catalog.

## ARCH-LEARNING-015: One fresh isolated child owns each audit

A semantic audit starts only after the writer prepares the complete candidate. One fresh, isolated child owns exactly one audit: it receives only the candidate and the complete pinned corpus, has no tools, inherits no conversational evidence as authority, and returns one response within the request limit.

Because: Self-approval and inherited context are not independent evidence.
Not: Reusing the proposing agent or its conversation to judge the candidate.

## ARCH-LEARNING-016: Audit outcomes are closed and fail closed

A semantic audit has four outcomes: independent, specialization, conflict, and uncertain, and only verified independent or canonical-first specialization evidence (ARCH-LEARNING-017) admits a mutation. Transport failure, malformed or extra output, more than one turn, request-limit overflow, and an incomplete request become uncertain and refuse. Flywheel never truncates or samples the corpus, retries into another authority, or infers a favorable result. The audit is a model judgment that deterministic code binds but never replaces.

Because: No similarity threshold proves semantic independence or conflict, and a second retrieval system would add a parallel authority.
Not: Deciding independence with deterministic similarity or embeddings.

## ARCH-LEARNING-017: Specialization is the first declared dependency

A candidate is admitted as a specialization only when its first declared dependency is the selected bundled skill and dependency resolution proves that this dependency is the exact bundled package of the pinned revision. The declared dependency remains the one composition authority, and audit evidence creates no parallel relationship.

Because: Semantic resemblance does not define composition.
Not: Inferring specialization from similarity.

## ARCH-LEARNING-018: Admission evidence is content-bound and request-local

Audit evidence binds the exact whole-package identity of the candidate, the pinned registry revision, the closed outcome, and for a specialization the exact canonical id and package identity. The skill store checks the evidence again under the package mutation locks, and only a passing check opens the journal entry and then publishes bytes. The evidence is discarded after the mutation settles and never becomes mutation attribution or a journal record.

Because: A stale audit, a concurrent package change, or a changed bundled revision must not borrow evidence prepared for another mutation.

## ARCH-LEARNING-019: Interactive and user-directed skill paths keep their own contracts

Interactive global skill mutations do not bypass package ownership, containment, stale-plan checks, durable attribution, recovery, or a required semantic audit. User-directed archive, removal, pruning, and promotion keep their ownership, attribution, and recovery rules and need no content-admission audit, because they add no model-visible content. The semantic audit governs autonomous admission and does not override deliberate user-authored content.

Not: Making the learning system guard against deliberate user-authored conflict with bundled skills.

## ARCH-LEARNING-020: Historical cleanup classifies against the production core corpus

Historical cleanup of project learned skills is a campaign separate from content admission, and it compares eligible project candidates only with the production core corpus, which excludes the skills of module bundles. Each fresh, tool-less, one-turn child owns one core package and classifies the complete candidate set, which is split into deterministic shards only when it does not fit. The full core-by-candidate matrix is required before any mutation: conflict or an invalid specialization archives a candidate, independent, valid specialization, and uncertain retain it, and an incomplete or malformed result aborts the campaign.

## ARCH-LEARNING-021: Historical cleanup is fenced and revalidated before it archives

The cleanup campaign runs under one renewable claim recorded in the project's durable history, holds no package lock or database transaction across model work, and stops child work when it loses the claim. Its completion records the core-corpus identity and exact manifest, so an equal manifest runs no model work and only added or changed core packages reopen classification. Before it archives, it validates the core manifest, the candidates, and workflow protection again, archives serially through the ordinary journaled archive path, and records completion only after a final check proves the expected retained set.

## ARCH-LEARNING-024: Dependency packages are host-neutral

A dependency states one method and its own report shape. It never states who dispatches it, how findings route, or what is synthesized. The same package thus reads correctly in a brief, a persona, or a chat turn. A persona declares the packages its lens always needs and otherwise carries only short role instructions.
Not: A dependency package that dispatches, routes findings, or synthesizes for its host.

## ARCH-LEARNING-026: Only a chat host runs the background learning review

Only a chat host runs the background learning review. A workflow agent and a subagent have no review host, counter, or review fork.
Because: Workflow-agent reviews rarely save anything, and later work rarely loads what they save.
Not: A per-agent trigger, interval, or signal gate for workflow agents.
