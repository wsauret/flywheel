# plan-quality-bin-locations: seeded defect rationale

## column-read-before-migration (phase-1/t1, phase-2/t1, constraints)

The plan puts the pick list first "because pickers gain from it at once", which reads like a sensible delivery choice. Phase-1/t1 makes `SqlItemRepo.linesForOrder` select `i.bin_code`. The column does not exist: migrations/001_items.sql creates `items` with `sku` and `name` only, and the plan adds the column in phase-2/t1. The plan's own constraint says each phase is one merge and deploys on its own, and README.md says every merge deploys at once and the pick list is in use around the clock. Between the two deploys, every pick-list request fails with "no such column: i.bin_code". The migration belongs in phase 1, before or with the first reader. The "-" for items without a bin is about NULL values, not about a missing column, which makes the plan look as if it had thought about the gap.

## sql-changes-tested-only-through-memory-repo (phase-1/t1, phase-1/t2, phase-2/t2, phase-2/t3)

All SQL lives in `SqlItemRepo`, and the plan changes it twice: a new selected column and mapping, and a new UPDATE. The only test of phase-1/t1 is "the project type-checks", which cannot see a column name inside a SQL string. Every behavioral scenario runs through `MemoryItemRepo`, which returns what the test stored, and phase 1 verifies with `bun test tests/picklist.test.ts` alone. README.md names `tests/sql-item-repo.test.ts` as the harness that runs `SqlItemRepo` against SQLite with every migration, and the plan adds nothing to it. A typo in `bin_code`, a forgotten mapping, or an UPDATE with swapped parameters passes every planned test. This is also why the plan's tests cannot see the first defect: a phase-1 SQL scenario would fail at once.

## What is intended

- The bin-code format check in src/bins.ts matches the request; the regular expression is correct.
- NULL for "no bin" and "-" on the pick list are what the request asks.
- MemoryItemRepo really stores whole PickLine values, so the claim in phase-1/t1 holds; the existing pick-list test data gains `binCode` as part of the files phase-1/t2 lists.
- The existing tests/sql-item-repo.test.ts compares selected fields, so the new field does not break it.
