"""Harbor ACP entrypoint that runs `flywheel --headless --acp` inside a hosted trial.

Harbor's ACP runner starts this console script in the task sandbox and speaks
Agent Client Protocol on its stdin and stdout. Those two streams belong to the
protocol, so this shim writes its own progress to stderr only. The Flywheel
child reads stdin directly; its stdout passes through the shim unchanged,
line by line, so the shim sees when the child answers the prompt.

In order, the shim:

1. moves the auth snapshot out of the `FLYWHEEL_AUTH_SNAPSHOT` environment
   variable into a private one-use stage file;
2. installs the package's Flywheel config, the pinned Bun release, the
   package's runtime archive, and its trial store analysis, each checked
   against its recorded SHA-256;
3. runs Flywheel in the task workspace, relays its output, and forwards
   SIGTERM to it;
4. analyzes the trial's settled event store in a private directory and writes
   only that content-free analysis into the agent logs, then the run summary
   that finalization reads. The store itself never enters the logs, because
   Harbor scrubs secrets only in text files.

Harbor's runner closes stdin when the prompt is answered, sends SIGTERM two
seconds later, and SIGKILL two seconds after that. Flywheel answers the prompt
only when its headless channel settles, so a SIGTERM is a stop of the trial
only when the child had not answered the prompt when it came: Flywheel's
teardown after a settled turn can outlast the two seconds. The export of step
4 runs in its own process group under a deadline inside that window, so the
run summary is always written before SIGKILL.

The snapshot stays readable in `/proc/<shim pid>/environ` for the whole run,
also to a process of the same user that the agent starts: removing it from
`os.environ` does not change the environment block the kernel recorded at
exec. The shim receives the job secret as an environment variable, so the
boundary of the snapshot is the trial sandbox and the lifetime of its tokens.
"""

import hashlib
import io
import json
import math
import os
import platform
import secrets
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.request
import zipfile
from pathlib import Path

from .trial_runtime import (
    BUN_RELEASE_ASSETS,
    BUN_RELEASE_BASE_URL,
    AdapterSettlement,
    DeadlineAuthority,
    EvidencePublication,
    _export_settled_sqlite,
    _write_run_summary,
)

SNAPSHOT_ENV = "FLYWHEEL_AUTH_SNAPSHOT"
PROFILE_SHA256_ENV = "FLYWHEEL_TB_PROFILE_SHA256"
LOGS_DIR = Path("/logs/agent")
PACKAGE_ROOT = Path(__file__).resolve().parent.parent
BUILD_RECORD = "BUILD.json"
# The agent-log file that holds the trial store analysis; the host analyzer
# reads it under this name (TRIAL_STORE_ANALYSIS_NAME).
ANALYSIS_NAME = "flywheel-store-analysis.json"
_BASE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
# Harbor sends SIGKILL two seconds after SIGTERM. The child gets this much of
# that window: the store holds every committed fact whatever ends the child.
_CHILD_TERM_GRACE_SECONDS = 0.5
# The evidence export ends this long after the child exits, or this long after
# the first SIGTERM, whichever is earlier, so the run summary lands before
# SIGKILL. The SIGTERM bound counts the child's term grace.
_EXPORT_BUDGET_SECONDS = 2.5
_EXPORT_AFTER_SIGTERM_SECONDS = 1.6
_EXPORT_COMMAND = "export-evidence"


class _Cancelled(Exception):
    """Harbor ended the agent phase before the Flywheel child started."""


def _log(message: str) -> None:
    print(f"flywheel-acp: {message}", file=sys.stderr, flush=True)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_build_record(package_root: Path) -> dict:
    """Read the package's build record and check every file it names by digest."""
    record = json.loads((package_root / BUILD_RECORD).read_text())
    for entry in (record["runtime_archive"], record["flywheel_config"], record["store_analyzer"]):
        if _sha256_file(package_root / entry["path"]) != entry["sha256"]:
            raise RuntimeError(f"package file does not match its build record: {entry['path']}")
    return record


def take_snapshot(environ: dict) -> tuple[Path, str]:
    """Move the snapshot from `environ` into a private stage file.

    Returns the stage file and the snapshot's profile id. The variable leaves
    `environ` before anything else reads it, so no child process inherits it.
    """
    content = environ.pop(SNAPSHOT_ENV, None)
    if not content:
        raise RuntimeError(f"{SNAPSHOT_ENV} is unset or empty")
    profile = json.loads(content).get("profile")
    if not isinstance(profile, str) or not profile:
        raise RuntimeError("auth snapshot names no profile")
    stage = Path(tempfile.mkdtemp(prefix="flywheel-auth-bundle-"))
    stage_file = stage / "auth.json"
    descriptor = os.open(stage_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as output:
        output.write(content)
    return stage_file, profile


def _install_bun(work: Path) -> Path:
    asset = BUN_RELEASE_ASSETS.get(platform.machine())
    if asset is None:
        raise RuntimeError(f"unsupported Bun architecture: {platform.machine()}")
    name, expected_sha256 = asset
    with urllib.request.urlopen(f"{BUN_RELEASE_BASE_URL}/{name}", timeout=120) as response:
        payload = response.read()
    if hashlib.sha256(payload).hexdigest() != expected_sha256:
        raise RuntimeError("Bun release digest mismatch")
    bin_dir = work / "bun" / "bin"
    bin_dir.mkdir(parents=True)
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        (bin_dir / "bun").write_bytes(archive.read(f"{name.removesuffix('.zip')}/bun"))
    (bin_dir / "bun").chmod(0o755)
    return bin_dir


def _install_runtime(work: Path, archive: Path, bin_dir: Path) -> Path:
    runtime = work / "runtime"
    runtime.mkdir()
    with tarfile.open(archive, "r:gz") as source:
        source.extractall(runtime, filter="data")
    install_home = work / "install-home"
    install_home.mkdir(mode=0o700)
    subprocess.run(
        ["bun", "install", "--frozen-lockfile", "--ignore-scripts"],
        cwd=runtime, check=True, stdin=subprocess.DEVNULL, stdout=sys.stderr,
        env={"PATH": f"{bin_dir}:{_BASE_PATH}", "HOME": str(install_home)},
    )
    return runtime


def _install_store_analyzer(runtime: Path, package_root: Path, entry: dict) -> Path:
    """Place the packaged trial store analysis at its repository path in the runtime, where its imports resolve."""
    analyzer = runtime / entry["source_path"]
    analyzer.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(package_root / entry["path"], analyzer)
    return analyzer


def _install_home(work: Path, config: Path, profile: str) -> Path:
    home = work / "home"
    (home / ".flywheel" / "auth" / "profiles" / profile).mkdir(mode=0o700, parents=True)
    shutil.copyfile(config, home / ".flywheel" / "flywheel.toml")
    return home


def task_workspace() -> Path:
    """The task workspace that Harbor's runner sends as the session/new cwd.

    Harbor's generated launcher changes into the package directory and then
    execs this entrypoint, so the shim's own cwd is the package. The runner
    that started the launcher runs in the workspace and sends that cwd in
    session/new, so the shim reads the workspace from its parent's cwd.
    """
    return Path(os.readlink(f"/proc/{os.getppid()}/cwd"))


def child_environment(environ: dict, home: Path, bin_dir: Path, project_root: Path, archive_sha256: str) -> dict:
    """The Flywheel child's environment: the task's own variables with the shim's run settings.

    The task image's PATH stays, as in the local adapter, less the shim's own
    virtual environment that Harbor's launcher puts first.
    """
    environment = {key: value for key, value in environ.items() if key not in (SNAPSHOT_ENV, PROFILE_SHA256_ENV, "VIRTUAL_ENV")}
    shim_bin = str(Path(sys.executable).parent)
    image_path = ":".join(entry for entry in environ.get("PATH", _BASE_PATH).split(":") if entry != shim_bin)
    environment.update({
        "HOME": str(home),
        "PATH": f"{bin_dir}:{image_path}",
        "SHELL": "/bin/bash",
        "BASH_ENV": "/dev/null",
        "ENV": "/dev/null",
        "FLYWHEEL_PROJECT_ROOT": str(project_root),
        "FLYWHEEL_SOURCE_ARCHIVE_SHA256": archive_sha256,
    })
    return environment


def prompt_answer(line: bytes) -> bool | None:
    """Whether one ACP line from the child answers a request as a settled turn.

    A prompt result settles the turn unless its stop reason is `cancelled`,
    which Flywheel answers only after a `session/cancel`. An error response
    also ends the request it answers. Returns None for a line that answers
    nothing, such as a session update.
    """
    try:
        message = json.loads(line)
    except ValueError:
        return None
    if not isinstance(message, dict) or "id" not in message or "method" in message:
        return None
    if "error" in message:
        return True
    result = message.get("result")
    if isinstance(result, dict) and "stopReason" in result:
        return result["stopReason"] != "cancelled"
    return None


def _relay_output(source, answered: list[bool]) -> None:
    """Copy the child's stdout to this process's stdout and keep the last answer in `answered[0]`.

    The answer is noted before its line goes out, so it is current before
    Harbor can read the line and send SIGTERM.
    """
    for line in iter(source.readline, b""):
        answer = prompt_answer(line)
        if answer is not None:
            answered[0] = answer
        view = memoryview(line)
        while view:
            view = view[os.write(1, view):]


def export_evidence(project_root: Path, logs_dir: Path, bun: Path, analyzer: Path) -> tuple[EvidencePublication | None, str | None]:
    """Analyze the settled store and write only the analysis to `<logs_dir>/flywheel-store-analysis.json`.

    The store is captured into a private directory and analyzed there by the
    packaged trial store analysis, whose output holds counts, booleans, ids,
    and the store's digest, never content. Returns the identity of the
    analyzed store bytes, or None and the reason no analysis was recorded.
    """
    private = Path(tempfile.mkdtemp(prefix="flywheel-evidence-"))
    try:
        publication = _export_settled_sqlite(project_root, private)
        # The analysis's diagnostics stay out of the logs: an error message can quote store content.
        analysis = subprocess.run(
            [str(bun), str(analyzer), str(private / ".flywheel" / "flywheel.sqlite")],
            cwd=private, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            env={"PATH": _BASE_PATH, "HOME": str(private)},
        )
        if analysis.returncode != 0:
            return None, f"analysis_failed:exit_{analysis.returncode}"
        row = json.loads(analysis.stdout)
        if row.get("store") != {"sha256": publication.sha256, "size": publication.size}:
            return None, "analysis_identity_mismatch"
        temporary = logs_dir / f".{ANALYSIS_NAME}.{secrets.token_hex(8)}"
        temporary.write_text(json.dumps(row, sort_keys=True) + "\n")
        os.replace(temporary, logs_dir / ANALYSIS_NAME)
        return publication, None
    finally:
        shutil.rmtree(private, ignore_errors=True)


def _export_command() -> list[str]:
    return [sys.executable, "-m", "flywheel_harbor_agent.shim", _EXPORT_COMMAND]


def _remove_analysis(logs_dir: Path) -> None:
    for path in (logs_dir / ANALYSIS_NAME, *logs_dir.glob(f".{ANALYSIS_NAME}.*")):
        path.unlink(missing_ok=True)


def _bounded_export(project_root: Path, logs_dir: Path, bun: Path, analyzer: Path, deadline) -> tuple[EvidencePublication | None, str | None]:
    """Run `export_evidence` in its own process group and kill the group at `deadline()`.

    `deadline` returns a monotonic time and can move earlier while the export
    runs. A killed export leaves no analysis in the logs, so the summary
    records the evidence as withheld.
    """
    request = json.dumps({"project_root": str(project_root), "logs_dir": str(logs_dir), "bun": str(bun), "analyzer": str(analyzer)}).encode()
    # `-m` puts its cwd first on sys.path, which is how the export imports this package.
    export = subprocess.Popen(_export_command(), cwd=PACKAGE_ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, start_new_session=True)
    while True:
        remaining = deadline() - time.monotonic()
        if remaining <= 0:
            os.killpg(export.pid, signal.SIGKILL)
            export.wait()
            _remove_analysis(logs_dir)
            return None, "export_deadline"
        try:
            # A retried communicate keeps its input and output; the short wait lets a SIGTERM move the deadline.
            stdout, _ = export.communicate(request, timeout=min(remaining, 0.1))
            break
        except subprocess.TimeoutExpired:
            request = None
    if export.returncode != 0:
        _remove_analysis(logs_dir)
        return None, f"export_failed:exit_{export.returncode}"
    result = json.loads(stdout)
    if "withheld" in result:
        return None, result["withheld"]
    return EvidencePublication(result["sha256"], result["size"]), None


def _exit_status(returncode: int) -> int:
    return 128 - returncode if returncode < 0 else returncode


def _child_command(bin_dir: Path, runtime: Path, profile: str, stage_file: Path) -> list[str]:
    return [
        str(bin_dir / "bun"), "--conditions=browser", str(runtime / "src" / "cli" / "index.ts"),
        "--headless", "--acp", "--allow-persistent-processes",
        "--auth-profile", profile, "--auth-snapshot", str(stage_file),
    ]


def run(environ: dict, project_root: Path, logs_dir: Path = LOGS_DIR, package_root: Path = PACKAGE_ROOT) -> int:
    """Run one hosted trial in the task workspace `project_root` and return the exit status of the Flywheel child."""
    profile_sha256 = environ.get(PROFILE_SHA256_ENV)
    child: subprocess.Popen | None = None
    # The child's last answer, and whether the first SIGTERM came before a settled one.
    answered = [False]
    stopped = False
    exporting = False
    sigterm_deadline = math.inf

    def on_sigterm(_signum, _frame) -> None:
        nonlocal stopped, sigterm_deadline
        sigterm_deadline = min(sigterm_deadline, time.monotonic() + _EXPORT_AFTER_SIGTERM_SECONDS)
        if exporting:
            return
        stopped = stopped or not answered[0]
        if child is None:
            raise _Cancelled
        if child.poll() is None:
            child.terminate()
            escalation = threading.Timer(_CHILD_TERM_GRACE_SECONDS, child.kill)
            escalation.daemon = True
            escalation.start()

    signal.signal(signal.SIGTERM, on_sigterm)
    stage_file: Path | None = None
    work = Path(tempfile.mkdtemp(prefix="flywheel-runtime-"))
    archive_sha256: str | None = None
    bin_dir: Path | None = None
    analyzer: Path | None = None
    status = 1
    try:
        stage_file, profile = take_snapshot(environ)
        record = read_build_record(package_root)
        archive_sha256 = record["runtime_archive"]["sha256"]
        _log(f"build {record['build_id']} source {record['flywheel_source']['commit']}")
        bin_dir = _install_bun(work)
        runtime = _install_runtime(work, package_root / record["runtime_archive"]["path"], bin_dir)
        analyzer = _install_store_analyzer(runtime, package_root, record["store_analyzer"])
        home = _install_home(work, package_root / record["flywheel_config"]["path"], profile)
        child = subprocess.Popen(
            _child_command(bin_dir, runtime, profile, stage_file),
            cwd=project_root,
            env=child_environment(environ, home, bin_dir, project_root, archive_sha256),
            stdout=subprocess.PIPE,
        )
        threading.Thread(target=_relay_output, args=(child.stdout, answered), daemon=True).start()
        status = _exit_status(child.wait())
    except _Cancelled:
        status = 143
    finally:
        # From here a SIGTERM only shortens the export deadline.
        exporting = True
        export_ends = time.monotonic() + _EXPORT_BUDGET_SECONDS
        if stage_file is not None:
            shutil.rmtree(stage_file.parent, ignore_errors=True)
        publication, withheld = None, None
        if child is not None and bin_dir is not None and analyzer is not None:
            try:
                publication, withheld = _bounded_export(project_root, logs_dir, bin_dir / "bun", analyzer, lambda: min(export_ends, sigterm_deadline))
            except Exception as error:
                withheld = f"export_failed:{type(error).__name__}"
        settlement = AdapterSettlement("harbor-cancellation", True) if stopped else AdapterSettlement("normal", False)
        _write_run_summary(
            logs_dir,
            settlement,
            DeadlineAuthority(None, None, "deadline-blind:hosted-harbor-timeout"),
            profile_sha256,
            archive_sha256,
            project_root=str(project_root),
            evidence_publication=publication,
            evidence_withheld=withheld,
        )
        shutil.rmtree(work / "home", ignore_errors=True)
    return status


def _export_main() -> None:
    request = json.load(sys.stdin)
    publication, withheld = export_evidence(Path(request["project_root"]), Path(request["logs_dir"]), Path(request["bun"]), Path(request["analyzer"]))
    print(json.dumps({"withheld": withheld} if publication is None else {"sha256": publication.sha256, "size": publication.size}))


def main() -> None:
    if sys.argv[1:] == [_EXPORT_COMMAND]:
        _export_main()
        return
    environ = dict(os.environ)
    os.environ.pop(SNAPSHOT_ENV, None)
    sys.exit(run(environ, task_workspace()))


if __name__ == "__main__":
    main()
