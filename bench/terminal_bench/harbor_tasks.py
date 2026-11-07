"""Resolve a Terminal-Bench task selection through Harbor's own dataset resolution.

Harbor drops a task name that matches nothing as long as one other name
matches, so a typo would shrink a campaign without notice. This helper
resolves every name, fails on any name that matched no task, and reports each
task's agent, verifier, and environment build timeouts from its pinned
task.toml. Run it with Harbor's Python:

    python harbor_tasks.py <dataset> <ref-or-empty> <task-name>...

It prints one JSON object: {"tasks": {<name>: {"agent_timeout_sec": ...,
"verifier_timeout_sec": ..., "build_timeout_sec": ...}}}.
"""

import asyncio
import json
import sys

from harbor.job_plan import JobPlan
from harbor.models.job.config import DatasetConfig
from harbor.models.task.config import TaskConfig


async def resolve(dataset: str, ref: str | None, names: list[str]) -> dict:
    selection = DatasetConfig(name=dataset, ref=ref, task_names=names)
    tasks = await selection.get_task_configs()
    resolved = {task.get_task_id().get_name(): task for task in tasks}
    unmatched = [name for name in names if name not in resolved]
    if unmatched:
        raise SystemExit(f"task names match no task in {dataset}: {', '.join(unmatched)}")
    cached = await JobPlan.cache_tasks(tasks)
    timeouts = {}
    for name, task in resolved.items():
        config = TaskConfig.model_validate_toml((cached[task.get_task_id()].path / "task.toml").read_text())
        timeouts[name] = {
            "agent_timeout_sec": config.agent.timeout_sec,
            "verifier_timeout_sec": config.verifier.timeout_sec,
            "build_timeout_sec": config.environment.build_timeout_sec,
        }
    return {"tasks": timeouts}


if __name__ == "__main__":
    dataset, ref, *names = sys.argv[1:]
    print(json.dumps(asyncio.run(resolve(dataset, ref or None, names))))
