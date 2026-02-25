---
name: astronomer-airflow
description: Work with the local Astronomer Airflow environment. Start/stop, create/trigger DAGs, read logs, run tests. Triggers on "astro", "airflow", "start airflow", "trigger dag", "dag logs".
---

# Astronomer Airflow Local Development

Operational reference for working with the Astronomer-managed Airflow environment in `airflow/`.

---

## Quick Reference

| Action | Command | Working dir |
|--------|---------|-------------|
| Full setup + start | `make run` | `airflow/` |
| Start only (no setup) | `make start` | `airflow/` |
| Stop | `make stop` | `airflow/` |
| Full teardown | `make kill` | `airflow/` |
| Restart | `make restart` | `airflow/` |
| Run unit tests | `make test` | `airflow/` |
| Lint | `make lint` | `airflow/` |
| Format | `make format` | `airflow/` |
| Type check | `make type-check` | `airflow/` |

**UI:** http://localhost:8080 (credentials: `admin` / `admin`)
**Postgres:** `postgresql://localhost:5435/postgres` (credentials: `postgres:postgres`)

---

## Starting the Environment

**Always use `make run`** — not `make start` or `astro dev start` directly.

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

### Port Conflicts

If port 5432 is in use (common with local Postgres), Astro is already configured to use port **5435** in `.astro/config.yaml`. Do not change this — it avoids conflicts.

If port 8080 is in use, stop the conflicting service first. Astro doesn't support custom webserver ports cleanly.

### AWS SSO

The Makefile uses `AWS_SSO_PROFILE` (default: `data_dev_sso`) to refresh tokens. The `astro` AWS profile sources credentials from `data_dev_sso`.

If SSO refresh fails:
1. Run `aws sso login --profile data_dev_sso` manually
2. Then `make run`

The refresh loop auto-stops when Airflow stops or after 6 hours. Check status: `make aws-sso-status`.

---

## DAG Development

### File Placement

- DAGs go in `airflow/dags/<pipeline_name>/`
- **Never put DAGs in `dags/examples/`** — this directory is listed in `dags/.airflowignore` and is completely ignored by Airflow at runtime
- The examples directory is for reference code only, not for deployed DAGs
- DAGs placed directly in `dags/` (not in a subdirectory) will work but don't follow the convention

### .airflowignore

`dags/.airflowignore` excludes directories from DAG parsing. Currently excludes:
- `examples` — reference DAGs, not deployed

If a DAG doesn't show up in the UI or `dags list`, check this file first.

### DAG Conventions

```python
from pathlib import Path
from airflow.sdk import dag
from pendulum import datetime

@dag(
    dag_id=Path(__file__).stem,    # Always use filename as DAG ID
    start_date=datetime(2025, 1, 1, tz="America/Los_Angeles"),
    schedule=None,
    catchup=False,
    doc_md=__doc__,                # Module docstring as docs
    tags=["extract"],              # Must be from APPROVED_TAGS
)
def my_pipeline() -> None:
    ...

my_pipeline()  # Must be called at module bottom
```

### APPROVED_TAGS

Tags must come from the approved list in `tests/test_dags.py`. Check there before adding new tags. Common tags: `extract`, `daily`, `property data`, `finance`, `dlt`, `example`.

### DAG Loading

After creating or modifying a DAG:
1. Wait ~15 seconds for the scheduler to pick it up
2. Or force: `astro dev run dags reserialize` (noisy output, but forces reload)
3. Check it loaded: `astro dev run dags list | grep <dag_name>`
4. Check for errors: `astro dev run dags list-import-errors`

---

## Triggering and Monitoring DAGs

### Trigger a DAG

```bash
# Simple trigger
astro dev run dags trigger <dag_id>

# Trigger with config/params
astro dev run dags trigger <dag_id> --conf '{"param_name": "value"}'
```

### Unpause a DAG

New DAGs start paused by default:
```bash
astro dev run dags unpause <dag_id>
```

### Check Task States

```bash
astro dev run tasks states-for-dag-run <dag_id> "<run_id>"
```

The `run_id` comes from the trigger output (e.g., `manual__2026-02-23T20:09:18.414828+00:00`).

### Reading Task Logs

The `airflow tasks logs` subcommand does **not exist** in Airflow 3. Read logs directly from the container:

```bash
# Find the scheduler container name
docker ps --format '{{.Names}}' | grep scheduler

# List available log files for a task
docker exec <scheduler_container> find /usr/local/airflow/logs -name "*.log" -path "*<task_id>*"

# Read the log
docker exec <scheduler_container> cat "/usr/local/airflow/logs/dag_id=<dag_id>/run_id=<run_id>/task_id=<task_id>/attempt=1.log"
```

Log format is JSON (one entry per line). Key fields:
- `event` — the log message
- `level` — info/warning/error
- `logger` — `task.stdout` for print() output, `task` for framework messages

### Searching Scheduler Logs

For scheduler-level events (task scheduling, DAG run state changes):
```bash
docker logs <scheduler_container> 2>&1 | grep "<search_term>"
```

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

### Test Structure

Tests mirror the DAG structure:
```
tests/dags/<pipeline_name>/
├── jobs/
│   └── test_<module>.py
└── test_<pipeline>_pipeline.py
```

Each test directory needs `__init__.py` for pytest discovery.

### Integration Tests

Require environment credentials (e.g., `ORDWAY_CREDENTIALS` in `.env`):
```bash
make test-integration
```

### Astro Container Tests

For tests that need the full Airflow environment:
```bash
astro dev run pytest tests/ -v
```

This runs inside the container with all Airflow dependencies available.

---

## Airflow 3 API Notes

### Task Context API

In Airflow 3, the task context API replaces direct ORM access:

```python
# OLD (Airflow 2) — does NOT work in Airflow 3
upstream_ti = context["dag_run"].get_task_instance(task_id)

# NEW (Airflow 3) — use Task Context API
task_states = context["ti"].get_task_states(
    dag_id=context["dag_run"].dag_id,
    run_ids=[context["dag_run"].run_id],
    task_ids=[upstream_task_id],
)
```

**Return structure of `get_task_states()`:**
```python
# Returns: dict[str, dict[str, str]]
# Structure: {run_id: {task_id: state_string}}
{
    "manual__2026-02-23T20:09:18+00:00": {
        "my_task": "failed"
    }
}
```

- Keys at top level are `run_id` strings
- Values are dicts of `{task_id: state}`
- State values are **plain strings** (e.g., `"failed"`, `"success"`, `"running"`)
- Navigate with: `task_states.get(run_id, {}).get(task_id)`

Other Task Context API methods:
- `ti.get_dagrun_state()` — get the DAG run state
- `ti.get_dr_count()` — get DAG run count
- `ti.xcom_pull()` / `ti.xcom_push()` — XCom access

### Exception Types

```python
from airflow.exceptions import AirflowFailException  # NOT airflow.sdk.exceptions
```

`AirflowFailException` lives in `airflow.exceptions`, not `airflow.sdk.exceptions`.

---

## Troubleshooting

### DAG not showing in UI or `dags list`

1. Check `dags/.airflowignore` — is the directory excluded?
2. Check `astro dev run dags list-import-errors` — syntax or import error?
3. Wait 15 seconds and retry — scheduler may not have parsed it yet
4. Force reparse: `astro dev run dags reserialize`

### AWS SSO Token Errors in Logs

Symptom: `TokenRetrievalError: Error when retrieving token from sso: Token has expired and refresh failed`

Fix: You started Airflow with `make start` instead of `make run`, or SSO expired.
```bash
make kill
make run
```

### Port 5432 Already in Use

Local Postgres conflicts with Astro's Postgres. The project is configured to use port 5435 — don't change `.astro/config.yaml`.

### Container Not Starting

```bash
make kill        # Full teardown
docker ps -a     # Check for orphan containers
make run         # Fresh start
```
