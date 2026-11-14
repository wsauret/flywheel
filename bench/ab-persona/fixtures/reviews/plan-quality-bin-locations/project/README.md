# stockroom

The picking service of the Harbor Supply warehouse. Pickers print a pick list for each order and walk the aisles with it.

- `src/items.ts` holds the item repository: `SqlItemRepo` is the production implementation on SQLite.
- `src/picklist.ts` renders the printed pick list.
- `src/routes.ts` is the HTTP surface of the warehouse terminals.
- `src/db.ts` opens the database and applies migrations.
- `migrations/` holds the SQL migrations.

## Deploys

Every merge to `main` deploys to production at once. The deploy applies the pending migrations in `migrations/`, in file-name order, and then starts the new build. The pick list is in use around the clock.

## Tests

`bun test`. `tests/picklist.test.ts` renders pick lists from `MemoryItemRepo` in `tests/memory-item-repo.ts`. `tests/sql-item-repo.test.ts` runs `SqlItemRepo` against an in-memory SQLite database with every migration applied.
