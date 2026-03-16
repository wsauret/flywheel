---
name: astronomer-airflow
description: Work with Airflow 3.x on Astronomer. Start/stop, create/trigger DAGs, read logs, run tests. Triggers on "astro", "airflow", "start airflow", "trigger dag", "dag logs".
allowed-tools:
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Bash
  - AskUserQuestion
---

# Airflow 3.x on Astronomer

Operational reference for developing, running, and debugging Airflow 3.x DAGs in an Astronomer-managed local environment.

> **Project-specific config:** If the project has a `references/repo-config.md` alongside this skill, read it first for Makefile targets, environment setup, file layout conventions, and other repo-specific details.

---

## Environment Lifecycle (Astro CLI)

| Action | Command |
|--------|---------|
| Start | `astro dev start` |
| Stop | `astro dev stop` |
| Restart | `astro dev restart` |
| Kill (full teardown) | `astro dev kill` |
| Run Airflow CLI commands | `astro dev run <subcommand>` |
| Run pytest inside container | `astro dev run pytest tests/ -v` |

**Default UI:** http://localhost:8080 (credentials: `admin` / `admin`)

### Port Conflicts

If port 8080 is already in use, stop the conflicting service first. Astro doesn't support custom webserver ports cleanly.

If port 5432 conflicts with a local Postgres, configure an alternate port in `.astro/config.yaml`.

---

## DAG Development

### DAG Decorator Pattern (Airflow 3.x)

```python
from pathlib import Path
from airflow.sdk import dag
from pendulum import datetime

@dag(
    dag_id=Path(__file__).stem,    # Use filename as DAG ID
    start_date=datetime(2025, 1, 1, tz="UTC"),
    schedule=None,
    catchup=False,
    doc_md=__doc__,                # Module docstring as docs
    tags=["example"],
)
def my_pipeline() -> None:
    ...

my_pipeline()  # Must be called at module bottom
```

Key points:
- Import `dag` from `airflow.sdk`, not `airflow.decorators`
- Always call the decorated function at module level so Airflow discovers it
- Use `Path(__file__).stem` for `dag_id` to keep IDs in sync with filenames

### .airflowignore

Airflow respects `.airflowignore` files in the `dags/` directory to exclude paths from DAG parsing. If a DAG doesn't appear in the UI or `dags list`, check this file first.

### DAG Loading and Reserializing

After creating or modifying a DAG:
1. Wait ~15 seconds for the scheduler to pick it up
2. Or force a reparse: `astro dev run dags reserialize`
3. Verify it loaded: `astro dev run dags list | grep <dag_name>`
4. Check for errors: `astro dev run dags list-import-errors`

---

## Triggering and Monitoring DAGs

### Trigger

```bash
# Simple trigger
astro dev run dags trigger <dag_id>

# Trigger with config/params
astro dev run dags trigger <dag_id> --conf '{"param_name": "value"}'
```

### Unpause

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

## Airflow 3 API Reference

### Task Context API

Airflow 3 replaces direct ORM access with a Task Context API:

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

## Testing

### Running Tests Locally

```bash
# Using pytest directly (if dependencies are installed locally)
pytest tests/ -v
pytest tests/path/test.py          # Single file
pytest tests/ -k "pattern"         # By pattern
```

### Running Tests Inside the Container

For tests that need the full Airflow environment:
```bash
astro dev run pytest tests/ -v
```

This runs inside the container with all Airflow dependencies available.

---

## Troubleshooting

### DAG Not Showing in UI or `dags list`

1. Check `.airflowignore` — is the directory excluded?
2. Check `astro dev run dags list-import-errors` — syntax or import error?
3. Wait 15 seconds and retry — scheduler may not have parsed it yet
4. Force reparse: `astro dev run dags reserialize`

### Container Not Starting

```bash
astro dev kill       # Full teardown
docker ps -a         # Check for orphan containers
astro dev start      # Fresh start
```
