# permit-portal

Online parking permits for the Town of Ashford Vale.

- `src/permits.ts` holds permits: `SqlPermitRepo` on SQLite in production.
- `src/dates.ts` does calendar arithmetic on ISO dates (`YYYY-MM-DD`).
- `src/payments.ts` charges cards through the town's payment service.
- `src/routes.ts` is the portal's HTTP surface.
- `migrations/` holds the SQL migrations.

## Deploys

Every merge to `main` deploys at once. The deploy applies pending migrations in file-name order, then starts the new build.

## Payments

Every charge carries a reference. The payment service charges a reference once: a second charge with a reference it already accepted returns without charging again. The payment service reconciles each night and refunds any charge whose reference matches no permit record change of that day, so a charge whose permit write failed is refunded without staff action. The new-permit route relies on this: it charges, then writes the permit.

## Tests

`bun test`. `tests/sql-permit-repo.test.ts` runs `SqlPermitRepo` against an in-memory SQLite database with every migration applied; other tests use `MemoryPermitRepo` in `tests/memory-permit-repo.ts`.
