# Architecture Intent

This directory is the Flywheel repository's living authority for intended architecture. It states how Flywheel's internals must be organized independently of current code, delivery plans, and history. Repositories that use Flywheel do not inherit this policy unless they declare their own architecture-intent authority.

An architecture-intent statement can describe an organization that the implementation does not yet satisfy. Code and plans are judged against the recorded statement, not the reverse. A statement that the code does not meet is recorded structural debt.

## Authority boundaries

- Product intent (`docs/product-intent/`) states what experience the product must provide.
- Architecture intent states how Flywheel's internals must be organized to provide it.
- `docs/elegance.md` states the elegance rubric that judges both.
- Designs and plans state what change is approved for delivery.
- Code and tests provide implementation and evidence. They do not define architecture intent by themselves.

A statement belongs here only when a user cannot observe it. A rule that a person can observe through a client, the CLI, or an installed file belongs in product intent.

## Corpus contract

- Give every statement one stable identifier of the form `ARCH-<DOMAIN>-<NNN>` and one canonical domain file. Keep the identifier through wording changes and file moves.
- Write each statement as a heading `## ARCH-<DOMAIN>-<NNN>: <title>` followed by a concise, present-tense rule of at most 100 words, in sentences of at most 35 words.
- After the rule, a statement may carry one line `Because: <one sentence>` and one line `Not: <one rejected alternative>`. Add them only when a reader without them is likely to propose the rejected design again.
- Name boundaries, owners, invariants, layers, and modules. Do not name functions, types, file paths, fact versions, or other implementation details, and do not record history, delivery mechanics, or acceptance criteria.
- Add a statement only when no current statement owns the rule. Rewrite the current statement when its intended meaning changes. Git history is the archive of prior wording.
- When a changed intent contradicts or narrows any other statement, rewrite each of those statements so that it states the current intent on its own terms. Do not keep the old wording and add an exception or a pointer to the changed statement.
- Do not edit the corpus for work that only restores or preserves current intent.
- Code, tests, and documents cite a statement by its identifier.

## Domains

- [Agency](agency.md): how agents, evidence, and deterministic code divide authority over intent, work, and completion.
- [Boundaries](boundaries.md): external input normalization, strict internal state, and secret handling.
- [Context](context.md): model-visible context assembly, inspectability, and compaction.
- [Directories](directories.md): account, project, and execution directory authorities and project selection.
- [Distribution](distribution.md): binary builds, releases, installation, and update activation.
- [Learning](learning.md): durable memory and skill scope, consent, and audit.
- [Naming](naming.md): concept naming and the grammars for facts, requests, and identifiers.
- [Protocol](protocol.md): the runtime and client contract and client rendering boundaries.
- [Providers](providers.md): provider admission, accounting, and paid-use consent.
- [Runtime](runtime.md): the runner host, process placement, the account service, and runtime configuration.
- [Sessions](sessions.md): sessions, conversations, child sessions, and their lifecycle.
- [Structure](structure.md): source layers, the kernel, modules, registration, and code homes.
- [Substrate](substrate.md): durable history, projections, state ownership, recovery, and retry.
- [Tools](tools.md): tool execution safety, external processes, and file mutation.
- [Workflows](workflows.md): workflow control, attempts, and verification.
