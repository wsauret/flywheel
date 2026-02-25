# SQL Language Standards

## Query Structure

- Use uppercase for SQL keywords (`SELECT`, `FROM`, `WHERE`, `JOIN`)
- One clause per line for readability
- Use explicit `JOIN` syntax, never comma-separated implicit joins
- Always alias tables in multi-table queries
- Use meaningful aliases (not single letters unless obvious)
- Use CTEs (`WITH` clauses) for complex queries over deeply nested subqueries

## Performance

- Always consider index usage: avoid functions on indexed columns in WHERE clauses
- Use `EXISTS` over `IN` for subqueries with large result sets
- Avoid `SELECT *` -- list specific columns
- Use `LIMIT` / pagination for large result sets
- Prefer `UNION ALL` over `UNION` when duplicates are acceptable
- Watch for N+1 query patterns in application code
- Use `EXPLAIN ANALYZE` to verify query plans before deploying
- Avoid correlated subqueries when a JOIN achieves the same result
- Be aware of implicit type casting invalidating index usage

## Safety

- Always use parameterized queries -- never string interpolation for values
- Include `WHERE` clauses on `UPDATE` and `DELETE` (flag missing WHERE as P1)
- Use transactions for multi-statement operations that must be atomic
- Test migrations with rollback procedures
- Use `IF EXISTS` / `IF NOT EXISTS` for idempotent DDL

## Naming Conventions

- Tables: plural snake_case (`user_accounts`, `order_items`)
- Columns: singular snake_case (`created_at`, `user_id`)
- Foreign keys: `<referenced_table_singular>_id` (e.g., `user_id`)
- Indexes: `idx_<table>_<columns>` (e.g., `idx_users_email`)
- Constraints: `<type>_<table>_<description>` (e.g., `uq_users_email`, `fk_orders_user`)

## Schema Design

- Always include `created_at` and `updated_at` timestamps
- Use appropriate column types (don't store dates as strings)
- Add NOT NULL constraints where the domain requires it
- Define foreign key constraints explicitly
- Use check constraints for domain validation
- Prefer narrow, normalized tables over wide denormalized ones (denormalize only for measured performance needs)

## Migration Patterns

- Always write reversible migrations (up AND down)
- Add columns as nullable first, backfill, then add NOT NULL constraint
- Never rename columns directly in production -- add new, migrate data, drop old
- Add indexes concurrently when possible (`CREATE INDEX CONCURRENTLY`)
- Test migrations against production-sized datasets before deploying
- Keep migrations small and atomic -- one concern per migration

## Anti-Patterns to Flag

- String concatenation for query building (SQL injection risk -- P1)
- Missing WHERE on UPDATE/DELETE (P1)
- `SELECT *` in production queries
- Implicit joins (comma syntax)
- Missing indexes on frequently queried columns
- Storing JSON blobs when relational structure is appropriate
- N+1 queries in application loops
- Using `OFFSET` for deep pagination (use keyset/cursor pagination instead)
- Mixing DDL and DML in the same transaction (some databases don't support this safely)

## Debugging Checklist

When investigating SQL issues, check:
- Missing or unused indexes (`EXPLAIN ANALYZE` output)
- Lock contention from long-running transactions
- Implicit type casting causing full table scans
- NULL handling: `= NULL` vs `IS NULL`, `NOT IN` with NULLs
- Timezone mismatches between application and database
- Connection pool exhaustion from unclosed connections
- Deadlocks from inconsistent lock ordering across transactions
