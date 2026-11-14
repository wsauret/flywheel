# Why this task exists

This question asks for a condition: whether a child whose link record is unreadable still counts in its parent's usage stats. The lineage fold takes child edges from two fact types, its unreadable-fact hook drops silently, and a sibling family records the same kind of violation, so the obvious answers are wrong. The answer key lives only in `manifest.json` and this file, which the trial cannot read: its corpus is the pin, restricted to `src, AGENTS.md, docs/architecture.md, docs/architecture-intent, docs/product-intent, docs/terminology.md`.

## Verification at the pinned tree

Every reference below is `path:line` at commit `74d097f9c661f2e3b1e01c1731d69b6aa8dc2039`, with a snippet that occurs on that line or range. The snippets were checked mechanically against the pinned extract.

### Fact `two-edge-sources`

The launch lineage is one fold that takes child edges from two fact types: the link fact, parsed strictly, and the creation fact, decoded with a replay decoder.

- `src/orchestration/session/session-subtree.ts:37`: `const fact = parseProjectionFact(event, parseSessionMetadataFact)`
- `src/orchestration/session/session-subtree.ts:41`: `const fact = decodeSessionMetadataFactForReplay(`

### Fact `unreadable-routed`

An unreadable link fact raises a schema-mismatch violation that the projection routes to the family's unreadable-fact hook instead of failing the fold; other failures still throw.

- `src/infra/event-projection.ts:478`: `|| error.eventPosition !== event.position) throw error`
- `src/infra/event-projection.ts:479`: `return definition.reduceUnreadableFact(state, event, error)`

### Fact `lineage-drops-silently`

The lineage family's unreadable-fact hook returns the state unchanged, and the lineage state has no error field, so nothing records the skip.

- `src/orchestration/session/session-subtree.ts:67`: `reduceUnreadableFact: (state) => state,`
- `src/orchestration/session/session-subtree.ts:21-24`: `interface LineageDraft {`

### Fact `creation-undefined`

An unreadable creation record that fails both the current and the salvage decoder decodes to undefined, which the reducer ignores.

- `src/orchestration/session/session-metadata-facts.ts:297`: `try { return parseSessionMetadataFact(value) }`
- `src/orchestration/session/session-metadata-facts.ts:299-313`: `const fact = decodeSalvage(value)`

### Fact `creation-restores-edge`

A readable creation record that names a parent adds the same edge, so the child stays in the tree when only its link record is unreadable; it drops out only when the creation record gives no edge too.

- `src/orchestration/session/session-subtree.ts:49`: `const parent = fact.payload.launchedFrom?.parentSessionId`
- `src/orchestration/session/session-subtree.ts:50`: `if (parent) addChild(state, parent, event.sessionId)`

### Fact `stats-from-subtree`

The usage stats replay the lineage and take the session's subtree, so a child absent from the subtree is absent from the stats.

- `src/orchestration/modules/subscription-usage/session-stats.ts:223`: `const current = await heldSessionLineage(reader).replay()`
- `src/orchestration/modules/subscription-usage/session-stats.ts:225`: `const next = sessionSubtree(current, sessionId)`

### Fact `fork-contrast`

By contrast, the fork summary family's unreadable-fact hook records the violation message in its state.

- `src/orchestration/session/session-fork-summary.ts:41`: `reduceUnreadableFact: (state, event, violation)`
- `src/orchestration/session/session-fork-summary.ts:43`: `errors: [...current.errors, violation.message],`

### Trap `link-decides`

Wrong answer: The child drops out of the stats whenever its link record is unreadable.

Why a shallow trace reaches it: The lineage's unreadable-fact hook discards the link record.

Misleading evidence:

- `src/orchestration/session/session-subtree.ts:67`: `reduceUnreadableFact: (state) => state,`

Refuted by:

- `src/orchestration/session/session-subtree.ts:50`: `if (parent) addChild(state, parent, event.sessionId)`

### Trap `fold-fails`

Wrong answer: One unreadable record makes the lineage fold fail, so the stats show an error.

Why a shallow trace reaches it: The projection throws on a schema mismatch.

Misleading evidence:

- `src/infra/event-projection.ts:478`: `|| error.eventPosition !== event.position) throw error`

Refuted by:

- `src/infra/event-projection.ts:479`: `return definition.reduceUnreadableFact(state, event, error)`

### Trap `warning-shown`

Wrong answer: The skipped record is reported to the person as a warning, as durable readers do for unknown shapes.

Why a shallow trace reaches it: A sibling projection family records violations, and the repository requires a warning for unknown durable shapes.

Refuted by:

- `src/orchestration/session/session-subtree.ts:67`: `reduceUnreadableFact: (state) => state,`
