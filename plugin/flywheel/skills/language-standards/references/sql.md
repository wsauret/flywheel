# SQL Language Standards

## Query Structure

- Lowercase everything — keywords, identifiers, functions, types, literals
- Trailing commas in select lists (less diff noise)
- One clause per line for readability
- Use explicit `inner join` — never bare `join` (hides intent) or comma-separated implicit joins
- Explicit `as` for all aliases
- Always alias tables in multi-table queries; use meaningful aliases (not single letters)
- Qualify columns with table alias when joining multiple tables
- Use CTEs (`with` clauses) for complex queries over deeply nested subqueries
- Use window functions (`row_number`, `rank`, `lag`/`lead`) over self-joins for ranking and sequencing. Always include `order by` in the `over` clause.
- `where` filters rows before aggregation, `having` filters after. Never use `having` for non-aggregate conditions.

## Performance

- Always consider index usage: avoid functions on indexed columns in `where` clauses
- Use `exists` over `in` for subqueries with large result sets
- Avoid `select *` -- list specific columns
- Use `limit` / pagination for large result sets
- Prefer `union all` over `union` when duplicates are acceptable
- Watch for N+1 query patterns in application code
- Use `explain analyze` to verify query plans before deploying
- Avoid correlated subqueries when a `join` achieves the same result
- Be aware of implicit type casting invalidating index usage

## Safety

- Always use parameterized queries -- never string interpolation for values
- Include `where` clauses on `update` and `delete` (flag missing `where` as P1)
- Use transactions for multi-statement operations that must be atomic
- Use `coalesce` for NULL fallbacks. Prefer `not exists` over `not in` with nullable columns.
- Test migrations with rollback procedures
- Use `if exists` / `if not exists` for idempotent DDL

## Naming Conventions

- Tables: plural snake_case (`user_accounts`, `order_items`)
- Columns: singular snake_case (`created_at`, `user_id`)
- Foreign keys: `<referenced_table_singular>_id` (e.g., `user_id`)
- Indexes: `idx_<table>_<columns>` (e.g., `idx_users_email`)
- Constraints: `<type>_<table>_<description>` (e.g., `uq_users_email`, `fk_orders_user`)

## Schema Design

- Always include `created_at` and `updated_at` timestamps
- Use appropriate column types (don't store dates as strings)
- Add `not null` constraints where the domain requires it
- Define foreign key constraints explicitly
- Use check constraints for domain validation
- Prefer narrow, normalized tables over wide denormalized ones (denormalize only for measured performance needs)

## Migration Patterns

- Always write reversible migrations (up AND down)
- Add columns as nullable first, backfill, then add `not null` constraint
- Never rename columns directly in production -- add new, migrate data, drop old
- Add indexes concurrently when possible (`create index concurrently`)
- Test migrations against production-sized datasets before deploying
- Keep migrations small and atomic -- one concern per migration

## Anti-Patterns to Flag

- String concatenation for query building (SQL injection risk -- P1)
- Missing `where` on `update`/`delete` (P1)
- `select *` in production queries
- Implicit joins (comma syntax)
- Missing indexes on frequently queried columns
- Storing JSON blobs when relational structure is appropriate
- N+1 queries in application loops
- Using `offset` for deep pagination (use keyset/cursor pagination instead)
- Mixing DDL and DML in the same transaction (some databases don't support this safely)

## Debugging Checklist

When investigating SQL issues, check:
- Missing or unused indexes (`explain analyze` output)
- Lock contention from long-running transactions
- Implicit type casting causing full table scans
- NULL handling: `= null` vs `is null`, `not in` with NULLs
- Timezone mismatches between application and database
- Connection pool exhaustion from unclosed connections
- Deadlocks from inconsistent lock ordering across transactions
