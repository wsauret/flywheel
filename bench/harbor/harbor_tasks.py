"""Resolve a Harbor task selection through Harbor's own dataset resolution.

Harbor drops a task name that matches nothing as long as one other name
matches, so a typo would shrink a campaign without notice. This helper
resolves every name, fails on any name that matched no task, and reports each
task's agent, verifier, and environment build timeouts and the network mode
of its agent phase from its pinned task.toml. Run it with Harbor's Python:

    python harbor_tasks.py <dataset> <ref-or-empty> <task-name>...

It prints one JSON object: {"tasks": {<name>: {"agent_timeout_sec": ...,
"verifier_timeout_sec": ..., "build_timeout_sec": ...,
"agent_network_mode": "public" | "no-network" | "allowlist"}}}.

    python harbor_tasks.py --list <dataset> <ref-or-empty>

lists every task of the pinned dataset without downloading any, as one JSON
object: {"tasks": [<name>, ...]}.
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
            # Harbor's own resolution: an explicit [agent] policy, else the environment's baseline.
            "agent_network_mode": (config.agent.explicit_phase_policy() or config.environment.resolve_baseline()).network_mode.value,
        }
    return {"tasks": timeouts}


async def list_tasks(dataset: str, ref: str | None) -> dict:
    tasks = await DatasetConfig(name=dataset, ref=ref).get_task_configs()
    return {"tasks": sorted(task.get_task_id().get_name() for task in tasks)}


if __name__ == "__main__":
    if sys.argv[1] == "--list":
        dataset, ref = sys.argv[2:]
        print(json.dumps(asyncio.run(list_tasks(dataset, ref or None))))
    else:
        dataset, ref, *names = sys.argv[1:]
        print(json.dumps(asyncio.run(resolve(dataset, ref or None, names))))
