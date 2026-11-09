# Product Intent

This directory is the Flywheel repository's living authority for intended product behavior. It states what users must experience independently of current code, implementation architecture, delivery plans, and historical rationale. Repositories that use Flywheel do not inherit this policy unless they declare their own product-intent authority.

A product-intent statement can describe behavior that the implementation does not yet satisfy. Code and plans are judged against the recorded statement, not the reverse.

## Authority boundaries

- Product intent states what experience the product must provide.
- Architecture intent (`docs/architecture-intent/`) states how Flywheel's internals are organized.
- Designs and plans state what change is approved for delivery.
- Code and tests provide implementation and evidence. They do not define product intent by themselves.

## Corpus contract

- Give every statement one stable identifier of the form `PI-<DOMAIN>-<NNN>` and one canonical domain file. Keep the identifier through wording changes and file moves. Never use a number again, also after its statement is removed.
- Start each domain file with the title `# <Domain> Product Intent` and one intro sentence `This document states the current intended experience for <what the domain covers>.`, in the words of the domain's entry under Domains. The statements follow, with no other heading.
- Write each statement as a heading `## PI-<DOMAIN>-<NNN>: <title>` followed by one concise, present-tense, user-observable rule of at most 100 words, in sentences of at most 35 words. A statement states one rule, so split independent rules into separate statements.
- Exclude implementation, rationale, history, acceptance criteria, file paths, and delivery mechanics, so a statement carries no `Because:` or `Not:` line, no inline code, and no path-like token. Name a setting or a command that a person uses in words.
- Add a statement only when no current statement owns the behavior. Rewrite the current statement when its intended meaning or behavior changes. Git history is the archive of prior wording.
- When a changed intent contradicts or narrows any other statement, rewrite each of those statements so that it states the current intent on its own terms. Do not keep the old wording and add an exception or a pointer to the changed statement.
- When a statement breaks a cap, split it. The statement keeps its identifier for the rule that its title names. Each other rule becomes a new statement with its own identifier, and every citation of that rule moves to the new identifier. Drop rationale, history, and other detail that this contract excludes.
- Do not edit the corpus for work that only restores or preserves current intent.
- Code, tests, and documents cite a statement by its identifier. Put the identifier in parentheses at the end of the sentence that it explains. A document that defers a topic to the statements names the topic, then lists the identifiers.

## Domains

Each entry is a bullet `- [<Domain name>](<domain file>.md): <what the domain covers>.`, in alphabetical order.

- [Agent methods](agent-methods.md): Flywheel's built-in agent methods and repository-specific extensions.
- [Capabilities](capabilities.md): optional modules, what turning one off removes, and the development module.
- [Interaction](interaction.md): text entry, keyboard controls, surface-specific input behavior, launch and project selection, command-line conventions, and settings and configuration files.
- [Local access](local-access.md): opening a project's sessions in a browser on the machine that runs the runtime.
- [Model access](model-access.md): authentication, authorization, provider configuration, model eligibility, selection, routing, and failover.
- [Remote access](remote-access.md): pairing, the relay, sealed channels, and the phone client.
- [Updates](updates.md): installation integrity, replacement, and release activation.
