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

- Give every statement one stable identifier of the form `ARCH-<DOMAIN>-<NNN>` and one canonical domain file. Keep the identifier through wording changes and file moves. Never use a number again, also after its statement is removed.
- Start each domain file with the title `# <Domain> Architecture Intent` and one intro sentence `This file states <what the domain covers>.`, in the words of the domain's entry under Domains. The statements follow, with no other heading.
- Write each statement as a heading `## ARCH-<DOMAIN>-<NNN>: <title>` followed by one concise, present-tense rule of at most 100 words, in sentences of at most 35 words. A statement states one rule, so split independent rules into separate statements.
- After the rule, a statement may carry one line `Because: <one sentence>` and one line `Not: <one rejected alternative>`. Add them only when a reader without them is likely to propose the rejected design again.
- Name boundaries, owners, invariants, layers, and modules. Do not name functions, types, file paths, fact versions, or other implementation details, and do not record history, delivery mechanics, or acceptance criteria. A statement holds no inline code and no path-like token.
- Add a statement only when no current statement owns the rule. Rewrite the current statement when its intended meaning changes. Git history is the archive of prior wording.
- When a changed intent contradicts or narrows any other statement, rewrite each of those statements so that it states the current intent on its own terms. Do not keep the old wording and add an exception or a pointer to the changed statement.
- When a statement breaks a cap, split it. The statement keeps its identifier for the rule that its title names. Each other rule becomes a new statement with its own identifier, and every citation of that rule moves to the new identifier. Move the rationale to the `Because:` line and the rejected alternative to the `Not:` line, and drop the rest.
- Do not edit the corpus for work that only restores or preserves current intent.
- Code, tests, and documents cite a statement by its identifier. Put the identifier in parentheses at the end of the sentence that it explains. A document that defers a topic to the statements names the topic, then lists the identifiers.

## Domains

Each entry is a bullet `- [<Domain name>](<domain file>.md): <what the domain covers>.`, in alphabetical order.

- [Agency](agency.md): how agents, evidence, and deterministic code divide authority over intent, work, and completion.
- [Boundaries](boundaries.md): how Flywheel normalizes external input, keeps its own state strict, and handles secrets.
- [Context](context.md): how Flywheel assembles model-visible context, keeps it inspectable, and compacts it.
- [Directories](directories.md): how the account, project, and execution directory authorities divide Flywheel's state and path meaning, and how a project is selected.
- [Distribution](distribution.md): how Flywheel builds and publishes releases, installs builds, and activates and collects them on an account.
- [Learning](learning.md): how Flywheel scopes, admits, records, and audits durable memory and skills.
- [Naming](naming.md): how Flywheel names its concepts and the grammars for facts, requests, and identifiers.
- [Protocol](protocol.md): how the runtime and client contract and the client rendering boundaries are organized.
- [Providers](providers.md): how Flywheel organizes provider composition, auth profiles, model eligibility, request admission and failover, paid-use consent, and usage accounting.
- [Runtime](runtime.md): how the runner host, process placement, the account service, and runtime configuration are organized.
- [Sessions](sessions.md): how Flywheel organizes sessions, conversations, child sessions, and their lifecycle.
- [Structure](structure.md): how Flywheel's source is organized: its layers, the kernel, modules, registration, and the home of each kind of code.
- [Substrate](substrate.md): how Flywheel keeps durable history, derives projections from it, assigns one owner to each value, and recovers and retries work from that history.
- [Tools](tools.md): how Flywheel executes tools safely, owns the external processes they start, and mutates files.
- [Workflows](workflows.md): how Flywheel controls workflows, runs their attempts, and verifies, replays, and recovers them.
