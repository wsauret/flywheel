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
assembly_node = next(node for node in ast.walk(tree) if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "test_program" for target in node.targets))
assembly_bytes = "".join(authority.splitlines(keepends=True)[assembly_node.lineno - 1:assembly_node.end_lineno])
solution = Path(spec["workspace"]) / "solution.py"
raw = solution.read_text() if solution.exists() else ""
code = namespace["postprocess"](raw)
scope = {"p": record, "answers": {298: code}, "id": 298}
exec(textwrap.dedent(assembly_bytes), scope)
program = scope["test_program"]
assert (root / "code_context.py").read_bytes() == record["code_context"].encode()
(root / "official-program.py").write_text(program)

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


mp.Manager = manager_factory
started = time.monotonic()
try:
    result = execution.check_correctness(program, timeout=120, completion_id=298)
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
if (type(result) is not dict or set(result) != {"passed", "result", "completion_id"}
        or type(result["passed"]) is not bool or type(result["result"]) is not str
        or type(result["completion_id"]) is not int or result["completion_id"] != 298
        or result["passed"] != (result["result"] == "passed")
        or not (result["result"] == "passed" or result["result"] == "timed out"
                or result["result"].startswith("failed: "))):
    raise RuntimeError("invalid original check_correctness result")
output = {
    "official": result, "seconds": time.monotonic() - started,
    "managerLifecycle": lifecycles, "factoryRestored": mp.Manager is original_factory,
    "noActiveChildren": not mp.active_children(),
    "ownedTmpUnchanged": before == sorted(Path(os.environ["TMPDIR"]).iterdir()),
    "startMethod": mp.get_start_method(), "timeoutSeconds": 120,
    "originalCaseIds": [1, 2, 3],
    "caseObservation": "IDs identify original cases, not individually observed execution. Failure can stop before later cases or test_string.",
    "originalEntrypoints": ["test_execution", "test_string"],
    "rawCompletionSha256": hashlib.sha256(raw.encode()).hexdigest(),
    "postprocessedCompletionSha256": hashlib.sha256(code.encode()).hexdigest(),
    "authority": {name: hashlib.sha256((root / name).read_bytes()).hexdigest()
                  for name in ["execution.py", "test_ds1000.py", "record.json", "code_context.py"]},
    "assemblyOriginalBytesSha256": hashlib.sha256(assembly_bytes.encode()).hexdigest(),
    "postprocessOriginalBytesSha256": hashlib.sha256(postprocess_bytes.encode()).hexdigest(),
    "programSha256": hashlib.sha256(program.encode()).hexdigest(),
}
Path(spec["resultPath"]).write_text(json.dumps(output, indent=2) + "\n")
print(json.dumps({"completion_id": 298, "passed": result["passed"]}), flush=True)
