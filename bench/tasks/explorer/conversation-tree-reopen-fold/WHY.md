# Why this task exists

This question asks about the held-projection registry under a reopen pattern. The registry's own doc says a second caller gets the projection the first built, which reads as a permanent cache; the per-family bound, the absence of a pin for conversation trees, and the possible double fold after eviction are spread over several files. The answer key lives only in `manifest.json` and this file, which the trial cannot read: its corpus is the pin, restricted to `src, AGENTS.md, docs/architecture.md, docs/architecture-intent, docs/product-intent, docs/terminology.md`.

## Verification at the pinned tree

Every reference below is `path:line` at commit `74d097f9c661f2e3b1e01c1731d69b6aa8dc2039`, with a snippet that occurs on that line or range. The snippets were checked mechanically against the pinned extract.

### Fact `held-returns-existing`

A lookup for a key that is already held returns the held instance; the new caller's factory is not run.

- `src/infra/projection-registry.ts:103`: `if (existing) {`
- `src/infra/projection-registry.ts:115`: `const projection = create()`

### Fact `family-bound-eight`

The conversation-tree family holds at most 8 entries; inserting past the bound evicts the least recently used key that no owner pins.

- `src/infra/projection-registry.ts:49`: `["conversation-tree", 8],`
- `src/infra/projection-registry.ts:123`: `if (pins?.has(candidate)) continue`

### Fact `tree-not-pinned`

Conversation trees are not pinned, so the first open is evicted after eight other opens; pins exist for other families such as subagent child measures.

- `src/orchestration/session/conversation/conversation-projection.ts:158`: `return heldProjection(reader, conversationTreeKey(conversationId)`
- `src/orchestration/modules/subagents/history/child-measures.ts:84`: `pinHeldProjection(reader, key)`

### Fact `rebuild-refolds`

After eviction, the next lookup builds a new instance that folds the aggregate again from its start; eviction drops only the registry's reference.

- `src/infra/projection-registry.ts:38-41`: `and folds the aggregate again from its start.`
- `src/infra/projection-registry.ts:168`: `heldByReader.get(reader)?.get(familyOf(key))?.delete(key)`

### Fact `two-live-instances`

A holder that kept the evicted instance keeps feeding and reading it, so two instances of one key can be live at once and the aggregate is folded twice.

- `src/infra/projection-registry.ts:42`: `after an eviction two instances of one key can be live`

### Fact `replay-not-getstate`

A holder must read through replay: getState returns only the last folded state, not a fresh read.

- `src/infra/event-projection.ts:98`: `Last folded state, initially the empty state.`
- `AGENTS.md:227`: `Only an owner that feeds the projection itself through`

### Fact `release-drops-reference`

Releasing a conversation tree drops only the registry reference: a holder keeps its instance, and the next ask builds a new one.

- `src/orchestration/session/conversation/conversation-projection.ts:177`: `the next ask builds a new one.`
- `src/orchestration/session/conversation/conversation-projection.ts:179`: `releaseHeldProjection(reader, conversationTreeKey(conversationId))`

### Trap `cached-until-restart`

Wrong answer: Held projections stay cached for the whole app session, so the reopen after eight others returns the same tree without rereading history.

Why a shallow trace reaches it: The registry's doc says a second caller gets the projection the first one built.

Misleading evidence:

- `src/infra/projection-registry.ts:13`: `second caller gets the projection the first one built`

Refuted by:

- `src/infra/projection-registry.ts:49`: `["conversation-tree", 8],`
- `src/infra/projection-registry.ts:38-41`: `and folds the aggregate again from its start.`

### Trap `factory-rebuilds`

Wrong answer: Every open builds the tree from the factory it passes, so an immediate reopen with another factory yields a different tree.

Why a shallow trace reaches it: The factory is an argument of every call.

Refuted by:

- `src/infra/projection-registry.ts:103`: `if (existing) {`

### Trap `single-shared-instance`

Wrong answer: The holder of the first open sees the reopened tree's state, because the registry always shares one instance per key.

Why a shallow trace reaches it: The registry exists to share one projection per key.

Refuted by:

- `src/infra/projection-registry.ts:42`: `after an eviction two instances of one key can be live`
