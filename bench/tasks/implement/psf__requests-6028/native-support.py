import ast
from enum import Enum
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import re
import shutil
import sys
import tarfile
from types import SimpleNamespace


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def owners(manifest):
    return [name for name in manifest if name.startswith("tests/")
            or Path(name).name == "conftest.py"
            or name in ("setup.cfg", "setup.py", "pyproject.toml", "tox.ini", "pytest.ini", ".pytest.ini")]


def extract(task, workspace):
    assert sys.version_info[:3] == (3, 12, 13)
    assert platform.system() == "Darwin" and platform.machine() == "arm64"
    with tarfile.open(workspace / ".bench-home/inputs/requests.tar.gz") as archive:
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
        "files": len(actual), "archiveSha256": digest(workspace / ".bench-home/inputs/requests.tar.gz"),
    }, indent=2))
    pristine = workspace / ".bench-home/pristine-grading"
    for name in owners(manifest):
        target = pristine / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(workspace / name, target)


def restore(task, workspace):
    removed = []
    # test_utils imports tests.compat and tests.utils. Pytest also loads ancestor
    # configuration and conftest files, so the authority is more than one file.
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
    (workspace / ".bench-home/restoration.json").write_text(json.dumps({
        "owners": identities, "removed": removed,
    }, indent=2))


def snapshot(task, workspace):
    assert Path(sys.prefix).resolve() == workspace / ".bench-home/venv"
    actual = {item.metadata["Name"].lower().replace("_", "-"): item.version
              for item in importlib.metadata.distributions()}
    assert actual == json.loads((task / "packages.json").read_text())
    (workspace / ".bench-home/snapshot.json").write_text(json.dumps({
        "python": sys.version, "prefix": sys.prefix, "packages": actual,
    }, indent=2))


def run_pytest(task, workspace):
    # Python -I imports the pinned runner and plugins before candidate paths.
    # Fresh TMPDIR is required: extract_zipped_paths caches by basename.
    import pytest
    plugins = [entry.load() for entry in importlib.metadata.entry_points(group="pytest11")]
    os.environ["PYTEST_DISABLE_PLUGIN_AUTOLOAD"] = "1"
    temp = workspace / ".bench-home/pytest-tmp"
    temp.mkdir()
    os.environ["TMPDIR"] = str(temp)
    import tempfile
    tempfile.tempdir = None

    class Identity:
        def pytest_sessionfinish(self, session, exitstatus):
            identities = {name: module.__file__ for name in ("requests", "requests.utils")
                          if (module := sys.modules.get(name)) is not None}
            (workspace / ".bench-home/candidate-imports.json").write_text(json.dumps({
                "modules": identities, "collected": session.testscollected,
                "exitstatus": exitstatus, "pytest": pytest.__file__,
                "plugins": [plugin.__file__ for plugin in plugins],
                "tmpdir": str(temp),
            }, indent=2))

    sys.path.insert(0, str(workspace))
    raise SystemExit(pytest.main(sys.argv[4:], plugins=[*plugins, Identity()]))


def grading_snapshot(task, workspace):
    manifest = json.loads((task / "source-manifest.json").read_text())
    (workspace / ".bench-home/grading-identities.json").write_text(json.dumps({
        name: digest(workspace / name) for name in owners(manifest)
    }, indent=2))


def authority(task):
    namespace = {"Enum": Enum, "re": re, "Any": object, "TestSpec": object}
    identities = []
    references = json.loads((task / "original/harness-functions.json").read_text())
    references += json.loads((task / "original/grading-entrypoints.json").read_text())
    for reference in references:
        path = task / "original" / reference["file"]
        text = path.read_text()
        nodes = []
        for node in ast.parse(text).body:
            name = getattr(node, "name", None)
            if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name):
                name = node.targets[0].id
            if name == reference["name"]:
                nodes.append(node)
        assert len(nodes) == 1
        node = nodes[0]
        identity = hashlib.sha256(ast.get_source_segment(text, node).encode()).hexdigest()
        assert identity == reference["source_sha256"]
        exec(compile(ast.Module(body=[node], type_ignores=[]), str(path), "exec"), namespace)
        identities.append({**reference, "verified_sha256": identity})
    namespace["PARSER_REGISTRY"] = {"pytest-options": namespace["parse_log_pytest_options"]}
    return namespace, identities


def score(task, workspace):
    namespace, functions = authority(task)
    row = json.loads((task / "original/row.json").read_text())
    groups = {key: json.loads(row[key]) for key in ("FAIL_TO_PASS", "PASS_TO_PASS")}
    home = workspace / ".bench-home"
    command = json.loads((home / "pytest.command.json").read_text())
    # The exact eval.sh has output markers but no TEST_EXIT_CODE marker.
    log = namespace["START_TEST_OUTPUT"] + "\n" + command["stdout"] + command["stderr"] + "\n" + namespace["END_TEST_OUTPUT"]
    log_path = home / "eval.log"
    log_path.write_text(log)
    statuses, found = namespace["get_logs_eval"](SimpleNamespace(log_parser="pytest-options"), str(log_path))
    report = namespace["get_eval_tests_report"](statuses, groups)
    resolution = namespace["get_resolution_status"](report)
    expected = groups["FAIL_TO_PASS"] + groups["PASS_TO_PASS"]
    passed = sum(len(report[key]["success"]) for key in groups)
    grade = {
        "original_report": report, "original_resolution": resolution,
        "resolved": found and resolution == namespace["ResolvedStatus"].FULL.value,
        "original_output_found": found, "expected": groups, "statuses": statuses,
        "missing": [key for key in expected if key not in statuses],
        "errors": [key for key in expected if statuses.get(key) == "ERROR"],
        "passed": passed, "failed": len(expected) - passed, "total": len(expected),
        "classification": "invalid-output" if not found else
                          "passed" if resolution == namespace["ResolvedStatus"].FULL.value else "semantic-failure",
        "restoration": json.loads((home / "restoration.json").read_text()),
        "gradingOwnerIdentities": json.loads((home / "grading-identities.json").read_text()),
        "snapshot": json.loads((home / "snapshot.json").read_text()),
        "candidateImports": json.loads((home / "candidate-imports.json").read_text())
                            if (home / "candidate-imports.json").exists() else {},
        "sourceIdentity": json.loads((home / "source-identity.json").read_text()),
        "harnessFunctions": functions,
    }
    (home / "grade.json").write_text(json.dumps(grade, indent=2) + "\n")


if __name__ == "__main__":
    action, task_arg, workspace_arg = sys.argv[1:4]
    task, workspace = Path(task_arg).resolve(), Path(workspace_arg).resolve()
    {"extract": extract, "restore": restore, "snapshot": snapshot,
     "grading-snapshot": grading_snapshot, "score": score, "pytest": run_pytest}[action](task, workspace)
