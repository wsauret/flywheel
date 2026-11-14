# plan-quality-parking-permits: control

This fixture seeds no defect. The plan is complete, its steps are in a safe order, and every claim it makes about the code holds. It contains choices that a reflexive plan reviewer tends to flag; each is correct here.

## Tempting findings that are wrong

- "Charging before saving can take money for a renewal that is never written." README.md documents the nightly reconciliation that refunds any charge whose reference matches no permit change that day, and postNewPermit already relies on it. The plan follows the project's stated pattern with a renewal reference.
- "A double click charges twice." Both requests use the reference `permit:<id>:renew:<today>`, and README.md says the payment service charges a reference once. Both saves write the same new expiry, so the result is one renewal and one charge.
- "The new expiry should count from today" or "the grace period gives free days." REQUEST.md rule 3 says 12 months after the old expiry, also in the grace period; the plan does exactly that and tests it.
- "addMonths breaks on 29 February." It clamps a missing day to the month end, its doc comment states the leap-day case, tests/dates.test.ts asserts 2028-02-29 to 2029-02-28, and the plan adds the same case for renewals.
- "Phase 1 ships a column before any code uses it" or "the migration and the reader are in the wrong order." The migration and the code that reads and writes the column are in the same phase, and the deploy applies migrations before the new build starts (README.md). The column is nullable, so existing rows need no backfill and phase 1 is safe to deploy alone.
- "The route tests use the in-memory repository, so the SQL is not tested." The SQL change is all in phase 1 and is tested in tests/sql-permit-repo.test.ts against SQLite with every migration; the route and rule tests cover logic that has no SQL of its own, which is the project's stated test split.
- "SqlPermitRepo.save may not write the new field." The plan adds it to both the INSERT and the ON CONFLICT update, and save already writes every column today, as key_files says.
- "Business permits are not handled." They are refused with the town-hall message, which is what the out-of-scope line asks.
- "Where does today come from?" The plan adds today() to PortalDeps as the town's calendar date and states it; tests pass fixed dates.
