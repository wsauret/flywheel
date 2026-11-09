---
description: Use when designing changes in the Flywheel repository.
dependencies:
  - design
---

# Flywheel Design

Extend the composed design method with Flywheel's two living intent authorities: product intent (`docs/product-intent/`) for what users experience, and architecture intent (`docs/architecture-intent/`) for how Flywheel's internals are organized.

## Intent

Apply these steps to each corpus. A proposal can touch both.

1. Read the corpus `README.md` and every domain file relevant to the proposal: product intent for user-visible behavior, architecture intent for internal organization.
2. Compare the proposal with recorded intent. Search the whole corpus for every statement that the proposal contradicts, narrows, or extends, not only the statement that owns the rule. Classify the effect on each affected statement as `clarified` (the same intent, stated more clearly) or `changed` (different required behavior or rule), and add `new` for a rule that no statement owns. A corpus with no affected statement is `unchanged` when it governs the changed area, and `not applicable` when it does not govern that area.
3. When the proposal conflicts with recorded intent, show each conflicting statement and ask whether the user is approving an intent change, unless the user already stated the different intent. Do not silently reinterpret or replace it.
4. For `clarified`, `changed`, or `new`, include the smallest present-tense statement in the design, in that corpus's format. Preserve stable statement identifiers.
5. Treat approval of the complete design as approval of the wording of its stated intent update. When the person who approves the design is not the maintainer, the maintainer must already have agreed to each statement update, whether `clarified`, `changed`, or `new`, as `CONTRIBUTING.md` requires. Without that agreement, say that the statement update needs the maintainer, and start no delivery route. Persist the approved wording before any implementation route starts, or before design-only completion.
6. Apply each corpus's lifecycle contract when deciding whether approved work changes a statement. Do not create a second lifecycle rule in the design.

## Design result extension

Add **Product intent** and **Architecture intent** inside the Design intent part, after **Approach and key decisions**; a recorded statement is fixed intent, never illustration. For each, list every affected statement identifier with its disposition and exact proposed wording, or state the corpus disposition `unchanged` or `not applicable`.

## Stop condition

Do not start a delivery route while its approved design conflicts with either persisted corpus. The approving design agent writes the intent update, including any statement that a later pass finds still contradicts the approved intent; downstream agents do not reinterpret or replace recorded intent.
