# Architecture

Four layers. Each may import only from the layers listed for it.

- `src/domain/` holds the stock rules as pure functions over domain types. It imports nothing from the other layers.
- `src/db/` holds the repositories. It maps rows to domain types and imports only from `src/domain/`.
- `src/http/` holds the routes: parse the request, call `src/db/` and `src/domain/`, render the response.
- `src/jobs/` holds the scheduled jobs. A job calls `src/db/` and `src/domain/`, never `src/http/`.

Every stock rule (what is available, what is low, what must be reordered) lives in `src/domain/`, so the routes and the jobs apply the same rule.
