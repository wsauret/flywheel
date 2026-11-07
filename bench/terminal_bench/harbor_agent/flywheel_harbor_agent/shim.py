"""Harbor ACP entrypoint that runs `flywheel --headless --acp` inside a hosted trial.

Harbor's ACP runner starts this console script in the task sandbox and speaks
Agent Client Protocol on its stdin and stdout. Those two streams belong to the
protocol, so this shim writes its own progress to stderr only and hands both
streams unchanged to the Flywheel child.

In order, the shim:

1. moves the auth snapshot out of the `FLYWHEEL_AUTH_SNAPSHOT` environment
   variable into a private one-use stage file;
2. installs the package's Flywheel config, the pinned Bun release, and the
   package's runtime archive, each checked against its recorded SHA-256;
3. runs Flywheel in the task workspace and forwards SIGTERM to it;
4. exports the trial's settled event store into the agent logs only when the
   store holds no credential bytes of the snapshot, and writes the run summary
   that finalization reads.

Harbor's runner closes stdin when the prompt turn settles, sends SIGTERM two
seconds later, and SIGKILL two seconds after that. The export of step 4 runs
in its own process under a deadline inside that window, so the run summary is
always written before SIGKILL.
"""

import hashlib
import io
import json
import math
import os
import platform
import shutil
import signal
import sqlite3
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
    _copy_descriptor,
    _export_settled_sqlite,
    _write_run_summary,
)

SNAPSHOT_ENV = "FLYWHEEL_AUTH_SNAPSHOT"
PROFILE_SHA256_ENV = "FLYWHEEL_TB_PROFILE_SHA256"
LOGS_DIR = Path("/logs/agent")
PACKAGE_ROOT = Path(__file__).resolve().parent.parent
BUILD_RECORD = "BUILD.json"
# The snapshot fields that hold secret bytes, for API keys and OAuth tokens.
_SECRET_FIELDS = frozenset({"key", "access", "refresh"})
# Shorter strings carry no credential and would match unrelated store bytes.
_MIN_SECRET_LENGTH = 8
_BASE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
# Harbor sends SIGKILL two seconds after SIGTERM; the child gets most of that.
_CHILD_TERM_GRACE_SECONDS = 1.0
# The evidence export ends this long after the child exits, or this long after
# the first SIGTERM, whichever is earlier, so the run summary lands before
# SIGKILL. The SIGTERM bound counts the child's term grace.
_EXPORT_BUDGET_SECONDS = 2.5
_EXPORT_AFTER_SIGTERM_SECONDS = 1.5
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
    for entry in (record["runtime_archive"], record["flywheel_config"]):
        if _sha256_file(package_root / entry["path"]) != entry["sha256"]:
            raise RuntimeError(f"package file does not match its build record: {entry['path']}")
    return record


def take_snapshot(environ: dict) -> tuple[Path, str, frozenset[str]]:
    """Move the snapshot from `environ` into a private stage file.

    Returns the stage file, the snapshot's profile id, and the secret strings
    the snapshot holds. The variable leaves `environ` before anything else
    reads it, so no child process inherits it.
    """
    content = environ.pop(SNAPSHOT_ENV, None)
    if not content:
        raise RuntimeError(f"{SNAPSHOT_ENV} is unset or empty")
    snapshot = json.loads(content)
    profile = snapshot.get("profile")
    if not isinstance(profile, str) or not profile:
        raise RuntimeError("auth snapshot names no profile")
    stage = Path(tempfile.mkdtemp(prefix="flywheel-auth-bundle-"))
    stage_file = stage / "auth.json"
    descriptor = os.open(stage_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as output:
        output.write(content)
    return stage_file, profile, frozenset(_secret_strings(snapshot.get("credentials")))


def _secret_strings(value: object):
    if isinstance(value, dict):
        for key, item in value.items():
            if key in _SECRET_FIELDS and isinstance(item, str) and len(item) >= _MIN_SECRET_LENGTH:
                yield item
            else:
                yield from _secret_strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from _secret_strings(item)


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


def store_holds_secret(path: Path, secrets_: frozenset[str]) -> bool:
    """Whether a SQLite file holds any of `secrets_`, in its raw bytes or in any stored value.

    The value scan finds a secret that SQLite split across overflow pages,
    which the byte scan cannot see whole.
    """
    raw = path.read_bytes()
    encoded = [secret.encode() for secret in secrets_]
    if any(secret in raw for secret in encoded):
        return True
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        tables = [row[0] for row in connection.execute("select name from sqlite_master where type = 'table'")]
        for table in tables:
            quoted = table.replace('"', '""')
            for row in connection.execute(f'select * from "{quoted}"'):
                for value in row:
                    if isinstance(value, str) and any(secret in value for secret in secrets_):
                        return True
                    if isinstance(value, bytes) and any(secret in value for secret in encoded):
                        return True
    finally:
        connection.close()
    return False


def export_evidence(project_root: Path, logs_dir: Path, secrets_: frozenset[str]) -> tuple[EvidencePublication | None, str | None]:
    """Export the settled store into `<logs_dir>/state/.flywheel/flywheel.sqlite`.

    The store is captured, compacted, and scanned in a private directory, so
    bytes that hold a credential never enter the logs that Harbor uploads.
    Returns the publication, or None and the reason the store stays out.
    """
    private = Path(tempfile.mkdtemp(prefix="flywheel-evidence-"))
    try:
        _export_settled_sqlite(project_root, private)
        compacted = private / "compacted.sqlite"
        connection = sqlite3.connect(private / ".flywheel" / "flywheel.sqlite")
        try:
            # VACUUM INTO writes only live pages, so freed pages that once held
            # credential bytes are not published.
            connection.execute("vacuum into ?", (str(compacted),))
        finally:
            connection.close()
        if store_holds_secret(compacted, secrets_):
            return None, "credential_bytes"
        destination = logs_dir / "state" / ".flywheel"
        destination.mkdir(mode=0o700, parents=True)
        (logs_dir / "state").chmod(0o700)
        published = destination / "flywheel.sqlite"
        descriptor = os.open(compacted, os.O_RDONLY)
        try:
            digest = _copy_descriptor(descriptor, published)
        finally:
            os.close(descriptor)
        return EvidencePublication(digest, published.stat().st_size), None
    finally:
        shutil.rmtree(private, ignore_errors=True)


def _export_command() -> list[str]:
    return [sys.executable, "-m", "flywheel_harbor_agent.shim", _EXPORT_COMMAND]


def _bounded_export(project_root: Path, logs_dir: Path, secrets_: frozenset[str], deadline) -> tuple[EvidencePublication | None, str | None]:
    """Run `export_evidence` in its own process and kill it at `deadline()`.

    `deadline` returns a monotonic time and can move earlier while the export
    runs. A killed export leaves no store in the logs, so the summary records
    the store as withheld. The secrets reach the export on its stdin, never in
    its argv or environment.
    """
    request = json.dumps({"project_root": str(project_root), "logs_dir": str(logs_dir), "secrets": sorted(secrets_)}).encode()
    # `-m` puts its cwd first on sys.path, which is how the export imports this package.
    export = subprocess.Popen(_export_command(), cwd=PACKAGE_ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    while True:
        remaining = deadline() - time.monotonic()
        if remaining <= 0:
            export.kill()
            export.wait()
            shutil.rmtree(logs_dir / "state", ignore_errors=True)
            return None, "export_deadline"
        try:
            # A retried communicate keeps its input and output; the short wait lets a SIGTERM move the deadline.
            stdout, _ = export.communicate(request, timeout=min(remaining, 0.1))
            break
        except subprocess.TimeoutExpired:
            request = None
    if export.returncode != 0:
        shutil.rmtree(logs_dir / "state", ignore_errors=True)
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
    cancelled = False
    exporting = False
    sigterm_deadline = math.inf

    def on_sigterm(_signum, _frame) -> None:
        nonlocal cancelled, sigterm_deadline
        sigterm_deadline = min(sigterm_deadline, time.monotonic() + _EXPORT_AFTER_SIGTERM_SECONDS)
        if exporting:
            return
        cancelled = True
        if child is None:
            raise _Cancelled
        if child.poll() is None:
            child.terminate()
            escalation = threading.Timer(_CHILD_TERM_GRACE_SECONDS, child.kill)
            escalation.daemon = True
            escalation.start()

    signal.signal(signal.SIGTERM, on_sigterm)
    stage_file: Path | None = None
    secrets_: frozenset[str] = frozenset()
    work = Path(tempfile.mkdtemp(prefix="flywheel-runtime-"))
    archive_sha256: str | None = None
    status = 1
    try:
        stage_file, profile, secrets_ = take_snapshot(environ)
        record = read_build_record(package_root)
        archive_sha256 = record["runtime_archive"]["sha256"]
        _log(f"build {record['build_id']} source {record['flywheel_source']['commit']}")
        bin_dir = _install_bun(work)
        runtime = _install_runtime(work, package_root / record["runtime_archive"]["path"], bin_dir)
        home = _install_home(work, package_root / record["flywheel_config"]["path"], profile)
        child = subprocess.Popen(
            _child_command(bin_dir, runtime, profile, stage_file),
            cwd=project_root,
            env=child_environment(environ, home, bin_dir, project_root, archive_sha256),
        )
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
        if child is not None:
            try:
                publication, withheld = _bounded_export(project_root, logs_dir, secrets_, lambda: min(export_ends, sigterm_deadline))
            except Exception as error:
                withheld = f"export_failed:{type(error).__name__}"
        settlement = AdapterSettlement("harbor-cancellation", True) if cancelled else AdapterSettlement("normal", False)
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
    publication, withheld = export_evidence(Path(request["project_root"]), Path(request["logs_dir"]), frozenset(request["secrets"]))
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
