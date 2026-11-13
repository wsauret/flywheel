# plan-elegance-loyalty-tier: seeded defect rationale

## stored-tier-derivable (phase-2/t1, phase-2/t2, phase-2/t3)

The tier is a pure function of the points balance: `tierFor(points)` in src/tiers.ts computes it from `TIERS`, and checkout already calls `discountFor(tierFor(customer.pointsBalance))`. The plan adds a `tier` column, a `tier` field on `CustomerRow` and `Customer`, a backfill that restates the thresholds as a SQL `CASE`, and code in both balance writers that recomputes and stores the tier. Now the same fact has two homes, the balance and the stored tier, and they agree only while every writer remembers to update both. A threshold change in `TIERS` would also leave every stored tier stale until another migration runs. The plan presents this as making "checkout and the receipt read one value", which sounds like consolidation, but the one value already exists: the receipt can call `tierFor(customer.pointsBalance)` exactly as checkout does. All of phase 2 is removable; the badge needs only phase 3 with a derived tier.

## tiers-reexport-shim (phase-1/t2)

Phase 1 moves the tier rules and, in t1, updates the only two importers of src/tiers.ts: src/checkout.ts and tests/tiers.test.ts. Task t2 then keeps src/tiers.ts as a re-export "so that existing imports of ./tiers keep working while callers move", with removal deferred to a later cleanup. No caller is left to move: README.md states the service is deployed alone and nothing outside the repository imports its modules, and the package is private. The shim is a compatibility path with no consumer and a forwarding address that serves nobody; the move should delete the file.

## What is intended

- Moving the rules to src/loyalty/ is the loyalty team's request and is not a defect.
- `tierLabel` in src/loyalty/tiers.ts is the badge text; it lives with the tier names it maps, and the receipt is its caller.
- The badge line and its test in phase 3 are the feature.
