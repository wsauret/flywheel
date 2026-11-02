import ast
import hashlib
import importlib.metadata
import json
from pathlib import Path
import platform
import os
import shutil
import sys
import tarfile


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def owners(manifest):
    return [name for name in manifest if name.startswith("tests/")
            or Path(name).name == "conftest.py"
            or name in ("setup.cfg", "setup.py", "pyproject.toml", "tox.ini", "pytest.ini", ".pytest.ini")]


def extract(task, workspace):
    assert sys.version_info[:3] == (3, 12, 13)
    assert platform.system() == "Darwin" and platform.machine() == "arm64"
    with tarfile.open(workspace / ".bench-home/inputs/moto.tar.gz") as archive:
        for member in archive:
            relative = Path(member.name)
            assert not relative.is_absolute() and ".." not in relative.parts
            assert member.isdir() or member.isfile()
            parts = relative.parts[1:]
            if not parts:
                continue
            target = workspace.joinpath(*parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as source, target.open("wb") as output:
                    shutil.copyfileobj(source, output)
                target.chmod(member.mode)
    manifest = json.loads((task / "source-manifest.json").read_text())
    actual = {str(path.relative_to(workspace)): path for path in workspace.rglob("*")
              if path.is_file() and ".bench-home" not in path.relative_to(workspace).parts}
    assert set(actual) == set(manifest)
    assert all(digest(actual[name]) == identity for name, identity in manifest.items())
    (workspace / ".bench-home/source-identity.json").write_text(json.dumps({
        "files": len(actual), "archiveSha256": digest(workspace / ".bench-home/inputs/moto.tar.gz"),
    }, indent=2))
    pristine = workspace / ".bench-home/pristine-grading"
    for name in owners(manifest):
        target = pristine / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(workspace / name, target)


def restore(task, workspace):
    removed = []
    # The full tests package includes the decorators imported by the original file.
    tests = workspace / "tests"
    if tests.is_symlink() or tests.is_file():
        tests.unlink()
    elif tests.exists():
        shutil.rmtree(tests)
    configs = {"pytest.ini", ".pytest.ini", "pyproject.toml", "tox.ini", "setup.cfg", "setup.py", "conftest.py"}
    for path in sorted(workspace.rglob("*")):
        relative = path.relative_to(workspace)
        if ".bench-home" in relative.parts or ".git" in relative.parts:
            continue
        if path.name in configs and (path.is_file() or path.is_symlink()):
            removed.append(str(relative))
            path.unlink()
    manifest = json.loads((task / "source-manifest.json").read_text())
    pristine = workspace / ".bench-home/pristine-grading"
    for name in owners(manifest):
        target = workspace / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(pristine / name, target)
    identities = {name: digest(workspace / name) for name in owners(manifest)}
    assert identities == {name: manifest[name] for name in identities}
    (workspace / ".bench-home/restoration.json").write_text(json.dumps({
        "owners": identities, "removed": removed,
    }, indent=2))


def snapshot(task, workspace):
    assert Path(sys.prefix).resolve() == workspace / ".bench-home/venv"
    actual = {item.metadata["Name"].lower(): item.version for item in importlib.metadata.distributions()}
    assert actual == json.loads((task / "packages.json").read_text())
    (workspace / ".bench-home/snapshot.json").write_text(json.dumps({
        "python": sys.version, "prefix": sys.prefix, "packages": actual,
    }, indent=2))


def run_pytest(task, workspace):
    # Isolated Python loads the pinned runner and its installed plugins before
    # candidate source becomes importable. No installed Moto package exists.
    import pytest
    plugins = [entry.load() for entry in importlib.metadata.entry_points(group="pytest11")]
    os.environ["PYTEST_DISABLE_PLUGIN_AUTOLOAD"] = "1"
    sys.path.insert(0, str(workspace))
    result = pytest.main(sys.argv[4:], plugins=plugins)
    identities = {}
    for name in ("moto", "moto.dynamodb.models.dynamo_type"):
        module = sys.modules.get(name)
        if module is not None:
            identities[name] = module.__file__
    (workspace / ".bench-home/candidate-imports.json").write_text(json.dumps(identities, indent=2))
    raise SystemExit(result)


def grading_snapshot(task, workspace):
    manifest = json.loads((task / "source-manifest.json").read_text())
    (workspace / ".bench-home/grading-identities.json").write_text(json.dumps({
        name: digest(workspace / name) for name in owners(manifest)
    }, indent=2))


def extracted_functions(path, names, namespace):
    nodes = [node for node in ast.parse(path.read_text()).body
             if isinstance(node, ast.FunctionDef) and node.name in names]
    assert {node.name for node in nodes} == set(names)
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(path), "exec"), namespace)


def score(task, workspace):
    original = task / "original"
    namespace = {"Any": object}
    exec(compile((original / "constants.py").read_text(), "original/constants.py", "exec"), namespace)
    extracted_functions(original / "log_parsers.py", ["parse_log_pytest"], namespace)
    extracted_functions(original / "grading.py", [
        "test_passed", "test_failed", "get_eval_tests_report",
        "compute_fail_to_pass", "compute_pass_to_pass", "get_resolution_status",
    ], namespace)
    row = json.loads((original / "task-row.json").read_text())
    home = workspace / ".bench-home"
    command = json.loads((home / "pytest.command.json").read_text())
    # Original grading.py:54-70 rejects TESTS_TIMEOUT before parsing any partial
    # PASSED output; get_eval_report:230-248 keeps resolved=False in that case.
    statuses = {} if command["timedOut"] else namespace["parse_log_pytest"](command["stdout"])
    report = namespace["get_eval_tests_report"](statuses, row)
    resolution = namespace["get_resolution_status"](report)
    expected = row["FAIL_TO_PASS"] + row["PASS_TO_PASS"]
    missing = [key for key in expected if key not in statuses]
    errors = [key for key in expected if statuses.get(key) == "ERROR"]
    restoration = json.loads((home / "restoration.json").read_text())
    assert restoration["owners"] == {name: digest(home / "pristine-grading" / name)
                                     for name in restoration["owners"]}
    identities = json.loads((home / "grading-identities.json").read_text())
    assert identities == {name: digest(workspace / name) for name in identities}
    grade = {
        "original_report": report, "original_resolution": resolution,
        "expected": {key: row[key] for key in ("FAIL_TO_PASS", "PASS_TO_PASS")},
        "statuses": statuses, "missing": missing, "errors": errors,
        "passed": sum(statuses.get(key) in ["PASSED", "XFAIL"] for key in expected),
        "failed": sum(statuses.get(key) not in ["PASSED", "XFAIL"] for key in expected),
        "total": len(expected), "resolved": resolution == namespace["ResolvedStatus"].FULL.value,
        "classification": "tests-timeout" if command["timedOut"] else
                          "missing-or-runtime-error" if missing or errors else
                          "passed" if resolution == namespace["ResolvedStatus"].FULL.value else "semantic-failure",
        "restoration": restoration, "gradingOwnerIdentities": identities,
        "snapshot": json.loads((home / "snapshot.json").read_text()),
        "candidateImports": json.loads((home / "candidate-imports.json").read_text())
                            if (home / "candidate-imports.json").exists() else {},
        "sourceIdentity": json.loads((home / "source-identity.json").read_text()),
    }
    (home / "grade.json").write_text(json.dumps(grade, indent=2) + "\n")


if __name__ == "__main__":
    action, task_arg, workspace_arg = sys.argv[1:4]
    task, workspace = Path(task_arg).resolve(), Path(workspace_arg).resolve()
    {"extract": extract, "restore": restore, "snapshot": snapshot,
     "grading-snapshot": grading_snapshot, "score": score, "pytest": run_pytest}[action](task, workspace)
