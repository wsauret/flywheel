Review this completed change.

CHANGE: uncommitted working-tree changes in these files only (use `git diff -- <path>`; read untracked files in full): src/orchestration/modules/subagents/history/child-measures.ts, src/orchestration/modules/subagents/history/tool-summary.ts, src/infra/prefix-view.ts (new), src/orchestration/session/tool-execution-projection.ts (the `ToolCallCount`/`countToolCall` change only), the `subagent-measure` entry in `HELD_PER_FAMILY` in src/infra/projection-registry.ts (ignore the rest of that file, which belongs to the fold-cache unit), tests/unit/orchestration/modules/subagents/tool-summary.test.ts, tests/unit/orchestration/modules/subagents/child-measures.test.ts (new), tests/unit/orchestration/session/tool-execution-identity-projection.test.ts.

PROJECT CONTEXT PATHS: AGENTS.md section 7 hot-path rules (in your instructions); docs/architecture-intent/substrate.md (ARCH-SUBSTRATE-016, -017); docs/guides/elegance.md.

Intent (unit D4 of the approved design in your request context): subagent card measures become a held, cacheable projection with exact figures. Before, `createChildMeasureReader` seeded each child from position 0 with a serial page loop on every executor start (1.4 to 2 s for 75 subagents).

Design as built: each child is `heldProjection(reader, "subagent-measure:<child>", () => createEventProjection(...))`, read with `replay()`; children catch up concurrently; `HELD_PER_FAMILY` bounds the family at 256. A shared append-only index with per-state prefix views (`src/infra/prefix-view.ts`) lets a published state keep its counts while later folds append, with O(1) work per change; `ToolCallCount.calls` became a `PrefixView`. Entries past a view's size are dropped before an append so a restored copy (from the fold cache) folds on correctly.

ASSIGNED CLAIMS (verify; report evidence):
1. Figures are exactly what the previous reader produced for every card (tool counts, completion ids, measures), including the CorruptEventRowError rejection for an undecodable row.
2. A published state never changes after a later fold, and a structured-clone copy of an older state (as the cache restores it) folds on to the same result as a full rebuild.
3. `prefixAppend` dropping entries past the view's size cannot drop an entry that a newer live state still sees (for example, two held instances of the same key, or an evicted instance and a new one sharing the index).
4. The work-count tests prove per-change work does not grow with child count or history, and measuring cards twice reads each child's history once.
5. `member-totals.ts` and every other `countToolCall` caller keep their behavior with the new `PrefixView` shape.

Classify each deviation (prefix view placed in infra instead of inside ToolCallCount; one existing test changed to list view keys) as consistent with the intent or drift, with evidence. Use `<path>:<line>` locations. Run focused tests if useful; never stash or revert; do not write repository files. Return prose findings, one block each with Title, Severity, Location, Failure, Fix, or state No findings. Failure format: `<Principle name>. <Intent>. <Observation>. <Reasoning>.` Keep `UNVERIFIED` tags. Hardening findings name a reachable trigger or cap at P3.