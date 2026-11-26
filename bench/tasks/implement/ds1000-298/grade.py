import ast
import hashlib
import importlib.util
import json
import multiprocessing as mp
from multiprocessing.managers import SyncManager
import os
from pathlib import Path
import socket
import sys
import textwrap
import time
from typing import List


root = Path(__file__).resolve().parent
spec = json.loads(Path(sys.argv[1]).read_text())
module_spec = importlib.util.spec_from_file_location("execution", root / "execution.py")
execution = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(execution)
record = json.loads((root / "record.json").read_text())
authority = (root / "test_ds1000.py").read_text()
tree = ast.parse(authority)
postprocess_node = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "postprocess")
postprocess_bytes = "".join(authority.splitlines(keepends=True)[postprocess_node.lineno - 1:postprocess_node.end_lineno])
namespace = {"List": List}
exec(postprocess_bytes, namespace)
solution = Path(spec["workspace"]) / "solution.py"
raw = solution.read_text() if solution.exists() else ""
code = namespace["postprocess"](raw)
assert (root / "code_context.py").read_bytes() == record["code_context"].encode()
case_ids = [1, 2, 3]


def case_program(case_id):
    """The original code context with the body of one iteration of its test_execution loop.
    Each case runs alone, so a failing case does not hide later ones. test_string is not run:
    a loop in the completion is not a grading failure here."""
    return record["code_context"] + textwrap.dedent(f"""
        code = {code!r}
        test_input, expected_result = generate_test_case({case_id})
        test_env = {{"test_input": test_input}}
        exec(exec_context.replace("[insert]", code), test_env)
        assert exec_test(test_env["result"], expected_result)
        """)


programs = {case_id: case_program(case_id) for case_id in case_ids}

# The upstream nested worker needs fork on Darwin. TCP avoids AF_UNIX path limits
# and retains authenticated proxies after the worker changes its directory.
mp.set_start_method("fork", force=True)
original_factory = mp.Manager
managers = []
before = sorted(Path(os.environ["TMPDIR"]).iterdir())


def manager_factory():
    manager = SyncManager(address=("127.0.0.1", 0), ctx=mp.get_context("fork"))
    manager.start()
    managers.append((manager, manager._process, manager.address))
    return manager


def valid(result):
    return (type(result) is dict and set(result) == {"passed", "result", "completion_id"}
            and type(result["passed"]) is bool and type(result["result"]) is str
            and type(result["completion_id"]) is int and result["completion_id"] == 298
            and result["passed"] == (result["result"] == "passed")
            and (result["result"] == "passed" or result["result"] == "timed out"
                 or result["result"].startswith("failed: ")))


mp.Manager = manager_factory
started = time.monotonic()
cases = []
try:
    for case_id, program in programs.items():
        case_started = time.monotonic()
        result = execution.check_correctness(program, timeout=120, completion_id=298)
        if not valid(result):
            raise RuntimeError("invalid original check_correctness result")
        cases.append({"id": f"case-{case_id}", "originalCaseId": case_id, "official": result,
                      "seconds": time.monotonic() - case_started,
                      "programSha256": hashlib.sha256(program.encode()).hexdigest()})
finally:
    mp.Manager = original_factory
    for manager, process, address in managers:
        manager.shutdown()

lifecycles = []
for manager, process, address in managers:
    with socket.socket() as connection:
        closed = connection.connect_ex(address) != 0
    lifecycles.append({
        "address": address, "pid": process.pid, "exitcode": process.exitcode,
        "listenerClosed": closed, "aliveAfterShutdown": process.is_alive(),
        "inheritedAuthkey": manager._authkey == mp.current_process().authkey,
    })
output = {
    "cases": cases, "seconds": time.monotonic() - started,
    "managerLifecycle": lifecycles, "factoryRestored": mp.Manager is original_factory,
    "noActiveChildren": not mp.active_children(),
    "ownedTmpUnchanged": before == sorted(Path(os.environ["TMPDIR"]).iterdir()),
    "startMethod": mp.get_start_method(), "timeoutSecondsPerCase": 120,
    "caseObservation": "Each original case runs in its own check_correctness call, so every case is observed. The original test_string loop-token check is not run.",
    "rawCompletionSha256": hashlib.sha256(raw.encode()).hexdigest(),
    "postprocessedCompletionSha256": hashlib.sha256(code.encode()).hexdigest(),
    "authority": {name: hashlib.sha256((root / name).read_bytes()).hexdigest()
                  for name in ["execution.py", "test_ds1000.py", "record.json", "code_context.py"]},
    "postprocessOriginalBytesSha256": hashlib.sha256(postprocess_bytes.encode()).hexdigest(),
}
Path(spec["resultPath"]).write_text(json.dumps(output, indent=2) + "\n")
print(json.dumps({case["id"]: case["official"]["passed"] for case in cases}), flush=True)
