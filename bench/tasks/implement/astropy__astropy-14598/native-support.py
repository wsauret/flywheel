import ast
import __future__
import hashlib
import importlib.metadata
import json
from pathlib import Path
import platform
import re
import shutil
import sys
import tarfile
from types import SimpleNamespace
from typing import Any


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def owners(manifest):
    return [
        name for name in manifest
        if "tests" in Path(name).parts or Path(name).name == "conftest.py"
        or name in ("setup.cfg", "pyproject.toml", "tox.ini")
    ]


def extract(task, workspace):
    archive_path = workspace / ".bench-home/base.tar.gz"
    with tarfile.open(archive_path) as archive:
        for member in archive:
            relative = Path(member.name)
            assert not member.issym() and not member.islnk()
            assert not relative.is_absolute() and ".." not in relative.parts
            parts = relative.parts[1:]
            if not parts:
                continue
            target = workspace.joinpath(*parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                assert member.isfile()
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as source, target.open("wb") as output:
                    shutil.copyfileobj(source, output)
                target.chmod(member.mode)
    manifest = json.loads((task / "source-manifest.json").read_text())
    actual = {
        str(path.relative_to(workspace)): path
        for path in workspace.rglob("*")
        if path.is_file() and ".bench-home" not in path.relative_to(workspace).parts
    }
    assert set(actual) == set(manifest) and len(actual) == 1876
    assert all(digest(actual[name]) == item["sha256"] for name, item in manifest.items())
    pristine = workspace / ".bench-home/pristine-grading"
    for name in owners(manifest):
        target = pristine / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(workspace / name, target)
    (workspace / ".hypothesis/examples").mkdir(parents=True)


def restore(task, workspace):
    removed = []
    for path in sorted(workspace.rglob("conftest.py")):
        relative = path.relative_to(workspace)
        if ".git" not in relative.parts and ".bench-home" not in relative.parts:
            removed.append(str(relative))
            path.unlink()
    for path in sorted(workspace.glob("astropy/**/tests"), key=lambda p: len(p.parts), reverse=True):
        if path.is_dir():
            shutil.rmtree(path)
    row = json.loads((task / "grading-config.json").read_text())
    selected_files = {
        workspace / node_id.split("::", 1)[0]
        for key in ("FAIL_TO_PASS", "PASS_TO_PASS") for node_id in json.loads(row[key])
    }
    discovery_dirs = {
        directory for path in selected_files for directory in path.parents
        if directory == workspace or workspace in directory.parents
    }
    for directory in sorted(discovery_dirs):
        for name in ("pytest.ini", ".pytest.ini", "pyproject.toml", "tox.ini", "setup.cfg"):
            path = directory / name
            if path.exists():
                removed.append(str(path.relative_to(workspace)))
                path.unlink()
    manifest = json.loads((task / "source-manifest.json").read_text())
    names = owners(manifest)
    pristine = workspace / ".bench-home/pristine-grading"
    for name in names:
        target = workspace / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(pristine / name, target)
    identities = {name: digest(workspace / name) for name in names}
    assert identities == {name: manifest[name]["sha256"] for name in names}
    (workspace / ".bench-home/restoration.json").write_text(json.dumps({
        "owners": identities, "removed": removed,
    }, indent=2))


def snapshot(task, workspace):
    import astropy.io.fits.card as card
    import astropy.io.fits._utils as utils
    import astropy.io.fits._tiled_compression._compression as compression
    assert Path(sys.prefix).resolve() == workspace / ".bench-home/python"
    assert Path(card.__file__).resolve() == workspace / "astropy/io/fits/card.py"
    for module in (utils, compression):
        assert Path(module.__file__).resolve().is_relative_to(workspace)
    actual = {item.metadata["Name"]: item.version for item in importlib.metadata.distributions()}
    actual.pop("astropy")
    assert actual == json.loads((task / "packages.json").read_text())
    generated = sorted(str(path.relative_to(workspace)) for path in workspace.rglob("*.so")
                       if ".bench-home" not in path.relative_to(workspace).parts)
    assert len(generated) == 17, generated
    output = {
        "python": sys.version, "prefix": sys.prefix, "packages": actual,
        "card": card.__file__, "native": [module.__file__ for module in (utils, compression)],
        "nativeExtensions": generated,
    }
    (workspace / ".bench-home/snapshot.json").write_text(json.dumps(output, indent=2))


def grading_snapshot(task, workspace):
    manifest = json.loads((task / "source-manifest.json").read_text())
    (workspace / ".bench-home/grading-identities.json").write_text(json.dumps({
        name: digest(workspace / name) for name in owners(manifest)
    }, indent=2))


def score(task, workspace):
    namespace = {"re": re, "Any": Any}
    original = task / "original"
    exec(compile((original / "harness-core-constants.py").read_text(), "original-constants", "exec"), namespace)
    for filename, include in (
        ("log_parsers.py", lambda node: isinstance(node, (ast.FunctionDef, ast.Assign))),
        ("harness-log-parser-utils.py", lambda node: isinstance(node, ast.FunctionDef)),
        ("grading.py", lambda node: isinstance(node, ast.FunctionDef) and node.name in (
            "test_passed", "test_failed", "get_eval_tests_report", "compute_fail_to_pass",
            "compute_pass_to_pass", "get_resolution_status")),
    ):
        nodes = [node for node in ast.parse((original / filename).read_text()).body if include(node)]
        exec(compile(ast.Module(body=nodes, type_ignores=[]), filename, "exec",
                     flags=__future__.annotations.compiler_flag), namespace)
    row = json.loads((task / "grading-config.json").read_text())
    selected = {key: json.loads(row[key]) for key in ("FAIL_TO_PASS", "PASS_TO_PASS")}
    assert [len(selected[key]) for key in selected] == [1, 175]
    spec = SimpleNamespace(repo=row["repo"], version=row["version"])
    assert namespace["MAP_REPO_TO_PARSER_PY"][row["repo"]] is namespace["parse_log_pytest_v2"]
    runtime = workspace / ".bench-home"
    result = json.loads((runtime / "pytest.command.json").read_text())
    statuses = namespace["parse_log_pytest_v2"](result["stdout"] + "\n" + result["stderr"], spec)
    report = namespace["get_eval_tests_report"](statuses, selected, eval_type=namespace["get_eval_type"](spec))
    identities = set(selected["FAIL_TO_PASS"] + selected["PASS_TO_PASS"])
    missing = sorted(identities - set(statuses))
    observations = (
        json.loads((runtime / "api.json").read_text()) if (runtime / "api.json").exists()
        else {"unavailable": "The ancillary API probe failed; its raw command result is retained."}
    )
    restoration = json.loads((runtime / "restoration.json").read_text())
    assert restoration["owners"] == {
        name: digest(runtime / "pristine-grading" / name) for name in restoration["owners"]
    }
    grading_identities = json.loads((runtime / "grading-identities.json").read_text())
    assert grading_identities == {name: digest(workspace / name) for name in grading_identities}
    f2p = len(report["FAIL_TO_PASS"]["success"])
    p2p = len(report["PASS_TO_PASS"]["success"])
    grade = {
        "original_parser_statuses": statuses, "selected_ids": selected, "grade": report,
        "f2p": namespace["compute_fail_to_pass"](report),
        "p2p": namespace["compute_pass_to_pass"](report),
        "resolution": namespace["get_resolution_status"](report),
        "passed": f2p + p2p,
        "failed": len(report["FAIL_TO_PASS"]["failure"]) + len(report["PASS_TO_PASS"]["failure"]),
        "total": sum(len(report[key][outcome]) for key in ("FAIL_TO_PASS", "PASS_TO_PASS")
                     for outcome in ("success", "failure")),
        "missing": missing, "api": observations, "restoration": restoration,
        "gradingOwnerIdentities": grading_identities,
        "snapshot": (
            json.loads((runtime / "snapshot.json").read_text()) if (runtime / "snapshot.json").exists()
            else {"unavailable": "The candidate import probe failed; its raw command result is retained."}
        ),
        "sourceSha256": (
            digest(workspace / "astropy/io/fits/card.py")
            if (workspace / "astropy/io/fits/card.py").exists()
            else {"unavailable": "The captured candidate deleted astropy/io/fits/card.py."}
        ),
    }
    (runtime / "grade.json").write_text(json.dumps(grade, indent=2))


if __name__ == "__main__":
    action, task_arg, workspace_arg = sys.argv[1:]
    task, workspace = Path(task_arg).resolve(), Path(workspace_arg).resolve()
    if action == "preflight":
        assert sys.version_info[:2] == (3, 9), "FITS requires CPython 3.9 on PATH"
        assert platform.system() == "Darwin" and platform.machine() == "arm64", (
            "The pinned wheel set is qualified only on macOS arm64"
        )
        print(json.dumps({"python": sys.version, "platform": platform.platform()}))
    else:
        {"extract": extract, "restore": restore, "snapshot": snapshot,
         "grading-snapshot": grading_snapshot, "score": score}[action](task, workspace)
