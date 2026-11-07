"""Harbor ACP entrypoint that runs `flywheel --headless --acp` inside a trial, local or on Harbor Hub.

Harbor's ACP runner starts this console script in the task sandbox and speaks
Agent Client Protocol on its stdin and stdout. Those two streams belong to the
protocol, so this shim writes its own progress to stderr only. Both streams
pass between Harbor and the Flywheel child through the shim unchanged, line
by line, so the shim sees which requests are prompts and when the child
answers one.

In order, the shim:

1. moves the auth snapshot out of the `FLYWHEEL_AUTH_SNAPSHOT` environment
   variable into a private one-use stage file;
2. installs the package's Flywheel config, the pinned Bun release, the
   package's runtime archive, and its trial store analysis, each checked
   against its recorded SHA-256;
3. runs Flywheel in the task workspace, relays the protocol, and forwards
   SIGTERM to it;
4. analyzes the trial's settled event store in a private directory and writes
   only that content-free analysis into the agent logs, then the run summary
   that finalization reads. The store itself never enters the logs, because
   Harbor scrubs secrets only in text files.

Harbor's runner closes stdin when it reads the prompt's answer, sends SIGTERM
two seconds later, and SIGKILL two seconds after that. Flywheel answers the
prompt only when its headless channel settles. So the shim holds a settled
answer, closes the child's stdin itself, lets Flywheel end, and does step 4
before it sends the answer on: the export of a settled trial runs on the
quiescent store of an ended Flywheel, before Harbor's clock starts. A SIGTERM
before a settled answer, at Harbor's agent timeout or after a cancelled turn,
is a stop of the trial. The export then runs in its own process group under a
deadline inside the two seconds, so the run summary is written before SIGKILL.

The snapshot stays readable in `/proc/<shim pid>/environ` for the whole run,
also to a process of the same user that the agent starts: removing it from
`os.environ` does not change the environment block the kernel recorded at
exec. The shim receives the snapshot as an environment variable (a Hub job
secret, or in a local Docker trial the container's own environment), so the
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
# After a settled answer Harbor closes stdin and sends SIGTERM this much later.
# The shim gives Flywheel the same time to end before it stops it.
_CHILD_EXIT_GRACE_SECONDS = 2.0
# The evidence export ends this long after the first SIGTERM, so the run
# summary lands before SIGKILL. The bound counts the child's term grace.
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


def _message(line: bytes) -> dict | None:
    try:
        message = json.loads(line)
    except ValueError:
        return None
    return message if isinstance(message, dict) else None


def prompt_answer(line: bytes, prompts: set) -> bool | None:
    """Whether one ACP line from the child answers one of the `session/prompt` request ids `prompts` as a settled turn.

    A prompt result settles the turn unless its stop reason is `cancelled`,
    which Flywheel answers only after a `session/cancel`. An error response
    also ends the prompt it answers. Returns None for a line that answers no
    prompt, such as a session update or the answer to another request.
    """
    message = _message(line)
    if message is None or "method" in message or message.get("id") not in prompts:
        return None
    if "error" in message:
        return True
    result = message.get("result")
    if isinstance(result, dict) and "stopReason" in result:
        return result["stopReason"] != "cancelled"
    return None


def _write_all(descriptor: int, line: bytes) -> None:
    view = memoryview(line)
    while view:
        view = view[os.write(descriptor, view):]


class _Relay:
    """The two protocol streams between Harbor and the Flywheel child.

    Harbor's lines go to the child as they come, and the id of each
    `session/prompt` request is noted before its line goes on, so the child
    cannot answer a prompt that the relay does not know. The child's lines go
    to Harbor as they come until the child answers a prompt as a settled
    turn. The relay then holds that answer and every later child line, and
    closes the child's stdin, as Harbor would on reading the answer, and calls
    `on_settled`. `release` sends the held lines once the run summary is
    written.
    """

    def __init__(self, child_stdin, harbor_out: int, on_settled) -> None:
        self._child_stdin = child_stdin
        self._harbor_out = harbor_out
        self._on_settled = on_settled
        self._lock = threading.Lock()
        self._prompts: set = set()
        self._input_closed = False
        self._held: list[bytes] | None = None

    @property
    def settled(self) -> bool:
        """Whether the child answered a prompt as a settled turn."""
        return self._held is not None

    def _close_input(self) -> None:
        with self._lock:
            if not self._input_closed:
                self._input_closed = True
                # A child that already exited leaves unsent bytes that the close cannot flush.
                try:
                    self._child_stdin.close()
                except BrokenPipeError:
                    pass

    def relay_input(self, source) -> None:
        for line in iter(source.readline, b""):
            message = _message(line)
            with self._lock:
                if message is not None and message.get("method") == "session/prompt":
                    self._prompts.add(message.get("id"))
                if self._input_closed:
                    continue
                try:
                    self._child_stdin.write(line)
                    self._child_stdin.flush()
                except BrokenPipeError:
                    pass
        self._close_input()

    def relay_output(self, source) -> None:
        for line in iter(source.readline, b""):
            if self._held is not None:
                self._held.append(line)
                continue
            with self._lock:
                answer = prompt_answer(line, self._prompts)
            if answer:
                self._held = [line]
                self._close_input()
                self._on_settled()
                continue
            _write_all(self._harbor_out, line)

    def release(self) -> None:
        for line in list(self._held or ()):
            _write_all(self._harbor_out, line)


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


def run(environ: dict, project_root: Path, logs_dir: Path = LOGS_DIR, package_root: Path = PACKAGE_ROOT, harbor_in=None, harbor_out: int = 1) -> int:
    """Run one trial in the task workspace `project_root` and return the exit status of the Flywheel child.

    `harbor_in` (default: this process's stdin) and the descriptor
    `harbor_out` carry the protocol to and from Harbor.
    """
    profile_sha256 = environ.get(PROFILE_SHA256_ENV)
    child: subprocess.Popen | None = None
    relay: _Relay | None = None
    # Whether the first SIGTERM came before a settled answer.
    stopped = False
    exporting = False
    sigterm_deadline = math.inf

    def on_sigterm(_signum, _frame) -> None:
        nonlocal stopped, sigterm_deadline
        sigterm_deadline = min(sigterm_deadline, time.monotonic() + _EXPORT_AFTER_SIGTERM_SECONDS)
        if exporting:
            return
        stopped = stopped or relay is None or not relay.settled
        if child is None:
            raise _Cancelled
        stop_child()

    def stop_child() -> None:
        if child is not None and child.poll() is None:
            child.terminate()
            escalation = threading.Timer(_CHILD_TERM_GRACE_SECONDS, child.kill)
            escalation.daemon = True
            escalation.start()

    def on_settled() -> None:
        # Flywheel gets the time to end that Harbor would give it after the answer.
        teardown = threading.Timer(_CHILD_EXIT_GRACE_SECONDS, stop_child)
        teardown.daemon = True
        teardown.start()

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
        analyzer = package_root / record["store_analyzer"]["path"]
        home = _install_home(work, package_root / record["flywheel_config"]["path"], profile)
        child = subprocess.Popen(
            _child_command(bin_dir, runtime, profile, stage_file),
            cwd=project_root,
            env=child_environment(environ, home, bin_dir, project_root, archive_sha256),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
        )
        relay = _Relay(child.stdin, harbor_out, on_settled)
        threading.Thread(target=relay.relay_input, args=(harbor_in or sys.stdin.buffer,), daemon=True).start()
        threading.Thread(target=relay.relay_output, args=(child.stdout,), daemon=True).start()
        status = _exit_status(child.wait())
    except _Cancelled:
        status = 143
    finally:
        # From here a SIGTERM only shortens the export deadline.
        exporting = True
        if stage_file is not None:
            shutil.rmtree(stage_file.parent, ignore_errors=True)
        publication, withheld = None, None
        if child is not None and bin_dir is not None and analyzer is not None:
            try:
                publication, withheld = _bounded_export(project_root, logs_dir, bin_dir / "bun", analyzer, lambda: sigterm_deadline)
            except Exception as error:
                withheld = f"export_failed:{type(error).__name__}"
        settlement = AdapterSettlement("harbor-cancellation", True) if stopped else AdapterSettlement("normal", False)
        _write_run_summary(
            logs_dir,
            settlement,
            DeadlineAuthority(None, None, "deadline-blind:harbor-timeout"),
            profile_sha256,
            archive_sha256,
            project_root=str(project_root),
            evidence_publication=publication,
            evidence_withheld=withheld,
        )
        if relay is not None:
            relay.release()
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
