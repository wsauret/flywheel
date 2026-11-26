import json
import subprocess
from pathlib import Path

_original_run = subprocess.run
_output = Path(__OBSERVATIONS__)


def observed_run(*args, **kwargs):
    command = args[0] if args else kwargs.get("args")
    tracked = isinstance(command, list) and len(command) > 1 and command[1] == "interp.py"
    try:
        result = _original_run(*args, **kwargs)
    except subprocess.TimeoutExpired:
        if tracked:
            with _output.open("a") as out:
                out.write(json.dumps({"command": command, "cwd": str(Path.cwd()), "input": kwargs.get("input"), "timeout": kwargs.get("timeout"), "timed_out": True}) + "\n")
        raise
    if tracked:
        with _output.open("a") as out:
            out.write(json.dumps({"command": command, "cwd": str(Path.cwd()), "input": kwargs.get("input"), "timeout": kwargs.get("timeout"), "stdout": result.stdout, "stderr": result.stderr, "returncode": result.returncode, "timed_out": False}) + "\n")
    return result


subprocess.run = observed_run


# Each program's verdict is the upstream test's own PASSED or FAILED line. A verdict is one print call whose text
# starts with that word, so candidate output, which the test prints only inside other calls, cannot forge one.
_verdicts = Path(__VERDICTS__)
_program = None


def _verdict_print(*args, **kwargs):
    global _program
    print(*args, **kwargs)
    text = args[0] if len(args) == 1 and isinstance(args[0], str) else ""
    if text.startswith("\nTesting: "):
        _program = text[len("\nTesting: "):]
    elif _program is not None and text.startswith(("PASSED: ", "FAILED: ")):
        with _verdicts.open("a") as out:
            out.write(json.dumps({"program": _program, "status": text.split(":", 1)[0]}) + "\n")
        _program = None


def pytest_collection_modifyitems(items):
    for item in items:
        item.module.print = _verdict_print
