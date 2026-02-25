# Project-Specific Airflow Configuration

Repo-specific setup, conventions, and tooling for the local Astronomer Airflow environment in `airflow/`.

---

## Makefile Commands

All commands run from the `airflow/` directory.

| Action | Command | Notes |
|--------|---------|-------|
| Full setup + start | `make run` | **Preferred** — runs all setup steps before starting |
| Start only (no setup) | `make start` | Skips dependency install, env checks, and SSO |
| Stop | `make stop` | |
| Full teardown | `make kill` | |
| Restart | `make restart` | |
| Run unit tests | `make test` | Skips integration tests |
| Run integration tests | `make test-integration` | Requires env credentials |
| Lint | `make lint` | |
| Format | `make format` | |
| Type check | `make type-check` | |

### Why `make run` Instead of `make start`

`make run` performs the full setup sequence:
1. Checks required tools (docker, astro, aws, uv, make)
2. Installs Python dependencies via `uv sync`
3. Creates `.env` from `.local/.env.example` if missing
4. Verifies AWS profiles exist (`astro` profile required)
5. Refreshes AWS SSO token and starts background refresh loop (every 45 min)
6. Starts Airflow containers via `astro dev start`

`make start` skips steps 1-5, which means:
- No AWS SSO token refresh — DAGs that use Secrets Manager will fail to parse
- DAGs using `Variable.get()` with AWS Secrets Manager backend will show SSO token errors
- The background SSO refresh loop won't be started

---

## AWS SSO

The Makefile uses `AWS_SSO_PROFILE` (default: `data_dev_sso`) to refresh tokens. The `astro` AWS profile sources credentials from `data_dev_sso`.

If SSO refresh fails:
1. Run `aws sso login --profile data_dev_sso` manually
2. Then `make run`

The refresh loop auto-stops when Airflow stops or after 6 hours. Check status: `make aws-sso-status`.

### SSO Token Errors in Logs

Symptom: `TokenRetrievalError: Error when retrieving token from sso: Token has expired and refresh failed`

Fix: You started Airflow with `make start` instead of `make run`, or SSO expired.
```bash
make kill
make run
```

---

## Ports

| Service | Port | Notes |
|---------|------|-------|
| Airflow UI | 8080 | Default |
| Postgres | 5435 | Configured in `.astro/config.yaml` to avoid conflict with local Postgres on 5432 |

**Postgres connection:** `postgresql://localhost:5435/postgres` (credentials: `postgres:postgres`)

Do not change the Postgres port in `.astro/config.yaml` — it exists to avoid conflicts.

---

## File Layout

```
airflow/
├── dags/
│   ├── .airflowignore          # Excludes directories from DAG parsing
│   ├── examples/               # Reference code only — IGNORED by Airflow
│   └── <pipeline_name>/        # One directory per pipeline
├── tests/
│   ├── test_dags.py            # DAG validation (approved tags, etc.)
│   └── dags/<pipeline_name>/
│       ├── jobs/
│       │   └── test_<module>.py
│       └── test_<pipeline>_pipeline.py
```

- **Never put DAGs in `dags/examples/`** — listed in `.airflowignore`, completely ignored at runtime
- DAGs placed directly in `dags/` (not in a subdirectory) will work but don't follow convention
- Each test directory needs `__init__.py` for pytest discovery

---

## DAG Conventions

### Timezone

Use `America/Los_Angeles` for `start_date`:
```python
start_date=datetime(2025, 1, 1, tz="America/Los_Angeles")
```

### Approved Tags

Tags must come from the approved list in `tests/test_dags.py`. Check there before adding new tags. Common tags: `extract`, `daily`, `property data`, `finance`, `dlt`, `example`.

---

## Testing

### Unit Tests

```bash
# From airflow/ directory
make test                          # All tests (skips integration)
uv run pytest tests/ -v            # Verbose
uv run pytest tests/path/test.py   # Single file
uv run pytest tests/ -k "pattern"  # By pattern
```

### Integration Tests

Require environment credentials (e.g., `ORDWAY_CREDENTIALS` in `.env`):
```bash
make test-integration
```
