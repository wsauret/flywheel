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
