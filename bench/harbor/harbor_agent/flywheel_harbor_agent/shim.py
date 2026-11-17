"""Harbor ACP entrypoint that runs `flywheel --headless --acp --unattended` inside a trial, local or on Harbor Hub.

Harbor's ACP runner starts this console script in the task sandbox and speaks
Agent Client Protocol on its stdin and stdout. Those two streams belong to the
protocol, so this shim writes its own progress to stderr only. Both streams
pass between Harbor and the Flywheel child through the shim unchanged, line
by line, so the shim sees which requests are prompts and when the child
answers one.

In order, the shim:

1. moves the auth snapshot out of the `FLYWHEEL_AUTH_SNAPSHOT` environment
   variable into a private one-use stage file;
2. checks the package's Flywheel config, its executable archive, its trial
   store analysis, and its benchmark rules when it has them against their
   recorded SHA-256, extracts the executable, links the Claude engine that
   the setup phase installed and checks it against the recorded SHA-256, and
   installs the config and the rules in the trial home, so the agent phase
   downloads nothing;
3. runs Flywheel in the task workspace as an unattended run, because no
   person reads a trial, relays the protocol, and forwards SIGTERM to it;
4. while Flywheel runs, publishes an evidence snapshot, its live store and its
   diagnostic logs, into `flywheel-evidence/` of the agent logs about every
   `_SNAPSHOT_INTERVAL_SECONDS`, less every file that holds a credential value
   of the auth snapshot, because Harbor scrubs secrets only in text files;
5. when Flywheel ends, analyzes the trial's settled event store in a private
   directory and writes that content-free analysis into the agent logs; then
   publishes the analyzed store and the logs over the last snapshot, under the
   same credential rule; then writes the run summary that finalization reads.

Harbor's runner closes stdin when it reads the prompt's answer, sends SIGTERM
two seconds later, and SIGKILL two seconds after that. Flywheel answers the
prompt only when its headless channel settles. So the shim holds a settled
answer, closes the child's stdin itself, lets Flywheel end, and does step 5
before it sends the answer on: the export of a settled trial runs on the
quiescent store of an ended Flywheel, before Harbor's clock starts.

At its agent timeout Harbor cancels its exec of the runner and collects the
agent logs at once; in local Docker no signal reaches the shim at all, and the
shim and Flywheel run on into the verifier phase. Whatever of step 5 a
timed-out trial runs lands after the collection, so what Harbor collects is
the last successful evidence snapshot of step 4, taken about once an
interval, with no analysis and no run summary, which finalization accepts as
a cancelled trial. A SIGTERM before a settled answer, after a
cancelled turn, is a stop of the trial: the analysis and then the publication
each run in their own process group under one deadline inside the two
seconds, so the run summary is written before SIGKILL, and a publication that
the deadline ends costs no analysis and keeps the last evidence snapshot.

The auth snapshot stays readable in `/proc/<shim pid>/environ` for the whole run,
also to a process of the same user that the agent starts: removing it from
`os.environ` does not change the environment block the kernel recorded at
exec. The shim receives the snapshot as an environment variable (a Hub job
secret, or in a local Docker trial the container's own environment), so the
boundary of the snapshot is the trial sandbox and the lifetime of its tokens.
"""

import hashlib
import importlib.util
import json
import math
import os
import secrets
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
from pathlib import Path

from .trial_runtime import (
    EVIDENCE_DIR_NAME,
    AdapterSettlement,
    DeadlineAuthority,
    EvidencePublication,
    _export_settled_sqlite,
    _write_run_summary,
    discard_partial_evidence,
    publish_debug_evidence,
    snapshot_live_evidence,
)

SNAPSHOT_ENV = "FLYWHEEL_AUTH_SNAPSHOT"
PROFILE_SHA256_ENV = "FLYWHEEL_HARBOR_PROFILE_SHA256"
LOGS_DIR = Path("/logs/agent")
PACKAGE_ROOT = Path(__file__).resolve().parent.parent
BUILD_RECORD = "BUILD.json"
# The executable at the root of the extracted archive. A compiled build
# resolves its `browser` export condition at build time, and with
# BUN_BE_BUN=1 it runs a script as Bun does.
EXECUTABLE_NAME = "flywheel-bin"
# The package of the wheel that carries the Claude engine, which Harbor installs
# in the setup phase, and the path where a compiled Flywheel finds the engine.
CLAUDE_ENGINE_PACKAGE = "claude_agent_sdk"
CLAUDE_ENGINE_PATH = "native/linux-x64/claude"
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
# Harbor collects a timed-out trial's agent logs while Flywheel runs, so this
# bounds how old its evidence is. A snapshot costs one short process and a
# copy of a store of a few megabytes.
_SNAPSHOT_INTERVAL_SECONDS = 15.0
# A shorter value would match ids and words of the store, not secrets.
_MIN_CREDENTIAL_LENGTH = 12


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
    for entry in (record["runtime_archive"], record["flywheel_config"], record["store_analyzer"], *([record["benchmark_rules"]] if record["benchmark_rules"] else [])):
        if _sha256_file(package_root / entry["path"]) != entry["sha256"]:
            raise RuntimeError(f"package file does not match its build record: {entry['path']}")
    return record


def snapshot_credential_values(snapshot: dict) -> dict[str, str]:
    """Each credential value of the auth snapshot `snapshot`, mapped to the kind of field that held it.

    The snapshot reader of the runtime refuses every field it does not know,
    so these are all of its secrets: each credential's API `key` or OAuth
    `access` and `refresh` token, singleton or in a subscription collection,
    and the `access` of every token of each token login. Lineage ids, account identities, and
    labels name the account, not its access, and the store records them.
    """
    credentials = [
        record.get("credential", record)
        for value in snapshot.get("credentials", {}).values()
        for record in (value if isinstance(value, list) else [value])
    ]
    found = {
        credential[name]: f"{credential['type']}.{name}"
        for credential in credentials
        for name in ("key", "access", "refresh")
        if name in credential
    }
    found.update({
        login["access"]: "external_login.access"
        for logins in snapshot.get("externalLogins", {}).values()
        for login in logins
    })
    return {value: kind for value, kind in found.items() if len(value) >= _MIN_CREDENTIAL_LENGTH}


def take_snapshot(environ: dict) -> tuple[Path, str, dict[str, str]]:
    """Move the snapshot from `environ` into a private stage file.

    Returns the stage file, the snapshot's profile id, and its credential
    values (`snapshot_credential_values`), which the shim keeps in memory only
    to withhold evidence that holds one. The variable leaves `environ` before
    anything else reads it, so no child process inherits it.
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
    return stage_file, profile, snapshot_credential_values(snapshot)


def link_claude_engine(runtime: Path, engine_sha256: str) -> Path:
    """Link the Claude engine of the installed `claude-agent-sdk` wheel at `<runtime>/native/linux-x64/claude`, where Flywheel finds it.

    The package is found, not imported: its Python dependencies are not
    installed. Raises when the wheel or its engine is missing, or when the
    linked engine's SHA-256 differs from `engine_sha256`, the engine of the
    packaged commit, so a trial never runs another engine.
    """
    spec = importlib.util.find_spec(CLAUDE_ENGINE_PACKAGE)
    if spec is None or not spec.submodule_search_locations:
        raise RuntimeError(f"the {CLAUDE_ENGINE_PACKAGE} wheel, which carries the Claude engine, is not installed")
    engine = Path(spec.submodule_search_locations[0]) / "_bundled" / "claude"
    if not engine.is_file():
        raise RuntimeError(f"the installed {CLAUDE_ENGINE_PACKAGE} wheel holds no Claude engine at {engine}")
    link = runtime / CLAUDE_ENGINE_PATH
    link.symlink_to(engine)
    if _sha256_file(link) != engine_sha256:
        raise RuntimeError("the installed Claude engine differs from the engine of the packaged commit")
    return link


def _install_runtime(work: Path, archive: Path, engine_sha256: str) -> Path:
    """Extract the executable archive `archive` into `<work>/runtime`, link the Claude engine into it, and return that directory."""
    runtime = work / "runtime"
    runtime.mkdir()
    with tarfile.open(archive, "r:xz") as source:
        source.extractall(runtime, filter="data")
    link_claude_engine(runtime, engine_sha256)
    return runtime


def _install_home(work: Path, config: Path, profile: str, benchmark_rules: Path | None, image_home: Path) -> Path:
    """Make the trial home `<work>/home`, which the Flywheel child and every command it runs take as HOME.

    It holds Flywheel's account state for the trial and links every other
    entry of `image_home`, the home of the task image's user, so the caches,
    toolchains, and user installs that tools find under HOME (`~/go`,
    `~/.cargo`, `~/.rustup`, `~/.cache`, `~/.local`) are the image's own.
    Removing the trial home removes only the links.
    """
    home = work / "home"
    (home / ".flywheel" / "auth" / "profiles" / profile).mkdir(mode=0o700, parents=True)
    shutil.copyfile(config, home / ".flywheel" / "flywheel.toml")
    # A benchmark's answer-key rule reaches the agent as user-global
    # instructions of the trial home only, so Flywheel's own prompt never states it.
    if benchmark_rules is not None:
        (home / ".agents").mkdir()
        shutil.copyfile(benchmark_rules, home / ".agents" / "AGENTS.md")
    for entry in image_home.iterdir():
        if not os.path.lexists(home / entry.name):
            (home / entry.name).symlink_to(entry)
    return home


def task_workspace() -> Path:
    """The task workspace that Harbor's runner sends as the session/new cwd.

    Harbor's generated launcher changes into the package directory and then
    execs this entrypoint, so the shim's own cwd is the package. The runner
    that started the launcher runs in the workspace and sends that cwd in
    session/new, so the shim reads the workspace from its parent's cwd.
    """
    return Path(os.readlink(f"/proc/{os.getppid()}/cwd"))


def child_environment(environ: dict, home: Path, runtime: Path, project_root: Path, archive_sha256: str) -> dict:
    """The Flywheel child's environment: the task's own variables with the shim's run settings.

    The task image's PATH stays, as in the local adapter, less the shim's own
    virtual environment that Harbor's launcher puts first.
    """
    environment = {key: value for key, value in environ.items() if key not in (SNAPSHOT_ENV, PROFILE_SHA256_ENV, "VIRTUAL_ENV")}
    shim_bin = str(Path(sys.executable).parent)
    image_path = ":".join(entry for entry in environ.get("PATH", _BASE_PATH).split(":") if entry != shim_bin)
    environment.update({
        "HOME": str(home),
        "PATH": f"{runtime}:{image_path}",
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


def export_evidence(project_root: Path, private: Path, logs_dir: Path, executable: Path, analyzer: Path) -> tuple[EvidencePublication | None, str | None]:
    """Analyze the settled store and write the analysis to `<logs_dir>/flywheel-store-analysis.json`.

    The store is captured into the private directory `private`, at
    `.flywheel/flywheel.sqlite`, and analyzed there by the packaged trial store
    analysis, whose output holds counts, booleans, ids, and the store's digest,
    never content. The capture stays for `publish_debug_evidence`. Returns the
    identity of the analyzed store bytes, or None and the reason no analysis
    was recorded.
    """
    publication = _export_settled_sqlite(project_root, private)
    # The analysis's diagnostics stay out of the logs: an error message can quote store content.
    analysis = subprocess.run(
        [str(executable), str(analyzer), str(private / ".flywheel" / "flywheel.sqlite")],
        cwd=private, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        env={"PATH": _BASE_PATH, "HOME": str(private), "BUN_BE_BUN": "1"},
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


def _export_main(request: dict) -> dict:
    publication, withheld = export_evidence(Path(request["project_root"]), Path(request["private"]), Path(request["logs_dir"]), Path(request["executable"]), Path(request["analyzer"]))
    return {"withheld": withheld} if publication is None else {"sha256": publication.sha256, "size": publication.size}


def _publish_main(request: dict) -> dict:
    return publish_debug_evidence(Path(request["store"]), [Path(directory) for directory in request["log_directories"]], Path(request["destination"]), request["credential_values"])


def _snapshot_main(request: dict) -> dict:
    return snapshot_live_evidence(Path(request["project_root"]), [Path(directory) for directory in request["log_directories"]], Path(request["destination"]), request["credential_values"])


# The steps that run in a process group of their own, by the subcommand that runs each.
_STEPS = {"export-evidence": _export_main, "publish-evidence": _publish_main, "snapshot-evidence": _snapshot_main}


def _command(step: str) -> list[str]:
    return [sys.executable, "-m", "flywheel_harbor_agent.shim", step]


def _remove_analysis(logs_dir: Path) -> None:
    for path in (logs_dir / ANALYSIS_NAME, *logs_dir.glob(f".{ANALYSIS_NAME}.*")):
        path.unlink(missing_ok=True)


def _bounded(step: str, request: dict, deadline, discard) -> tuple[dict | None, str | None]:
    """Run the step `step` of `_STEPS` on `request` in its own process group and kill the group at `deadline()`.

    `deadline` returns a monotonic time and can move earlier while the step
    runs. Returns the step's JSON result, or None and why it gave none,
    `<verb>_deadline` or `<verb>_failed:exit_<status>` (the verb is the first
    word of `step`), after `discard()` removes what the step left in the logs.
    """
    verb = step.split("-")[0]
    payload = json.dumps(request).encode()
    # `-m` puts its cwd first on sys.path, which is how the step imports this package.
    process = subprocess.Popen(_command(step), cwd=PACKAGE_ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, start_new_session=True)
    while True:
        remaining = deadline() - time.monotonic()
        if remaining <= 0:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            discard()
            return None, f"{verb}_deadline"
        try:
            # A retried communicate keeps its input and output; the short wait lets a SIGTERM move the deadline.
            stdout, _ = process.communicate(payload, timeout=min(remaining, 0.1))
            break
        except subprocess.TimeoutExpired:
            payload = None
    if process.returncode != 0:
        discard()
        return None, f"{verb}_failed:exit_{process.returncode}"
    return json.loads(stdout), None


def _bounded_export(project_root: Path, private: Path, logs_dir: Path, executable: Path, analyzer: Path, deadline) -> tuple[EvidencePublication | None, str | None]:
    """`export_evidence` under `_bounded`. A killed export leaves no analysis in the logs, so the summary records the analysis as withheld."""
    request = {"project_root": str(project_root), "private": str(private), "logs_dir": str(logs_dir), "executable": str(executable), "analyzer": str(analyzer)}
    result, reason = _bounded("export-evidence", request, deadline, lambda: _remove_analysis(logs_dir))
    if result is None:
        return None, reason
    if "withheld" in result:
        return None, result["withheld"]
    return EvidencePublication(result["sha256"], result["size"]), None


def _exit_status(returncode: int) -> int:
    return 128 - returncode if returncode < 0 else returncode


def _child_command(executable: Path, profile: str, stage_file: Path) -> list[str]:
    return [
        str(executable), "--headless", "--acp", "--unattended", "--allow-persistent-processes",
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

    snapshots_stop = threading.Event()

    def discard_partial() -> None:
        # A killed publication runs no cleanup of its own, and Harbor can collect the logs at any moment.
        discard_partial_evidence(logs_dir / EVIDENCE_DIR_NAME)

    def publish_snapshots(request: dict) -> None:
        # Records a change of outcome only: the first failure of a kind, and the recovery with its count.
        failure, failures = None, 0
        while not snapshots_stop.wait(_SNAPSHOT_INTERVAL_SECONDS):
            started = time.monotonic()
            # Stopping the snapshots ends the one in flight, which leaves the evidence whole.
            _, reason = _bounded("snapshot-evidence", request, lambda: -math.inf if snapshots_stop.is_set() else min(sigterm_deadline, started + _SNAPSHOT_INTERVAL_SECONDS), discard_partial)
            if snapshots_stop.is_set():
                return
            if reason is not None and reason != failure:
                _log(f"evidence snapshot failed: {reason}")
            elif reason is None and failure is not None:
                _log(f"evidence snapshots resumed after {failures} failed")
            failure, failures = reason, failures + 1 if reason is not None else 0

    def on_settled() -> None:
        # Flywheel gets the time to end that Harbor would give it after the answer.
        teardown = threading.Timer(_CHILD_EXIT_GRACE_SECONDS, stop_child)
        teardown.daemon = True
        teardown.start()

    signal.signal(signal.SIGTERM, on_sigterm)
    stage_file: Path | None = None
    credential_values: dict[str, str] = {}
    # Resolved, because the evidence publication opens the home's log directory
    # through no link, and the temporary root can be one (macOS's /var).
    work = Path(tempfile.mkdtemp(prefix="flywheel-runtime-")).resolve()
    archive_sha256: str | None = None
    executable: Path | None = None
    analyzer: Path | None = None
    snapshots: threading.Thread | None = None
    status = 1
    try:
        stage_file, profile, credential_values = take_snapshot(environ)
        evidence_request = {
            "log_directories": [str(project_root / ".flywheel" / "log"), str(work / "home" / ".flywheel" / "log")],
            "destination": str(logs_dir / EVIDENCE_DIR_NAME),
            # Each step reads the values from its stdin pipe, never from an argument or a file.
            "credential_values": credential_values,
        }
        record = read_build_record(package_root)
        archive_sha256 = record["runtime_archive"]["sha256"]
        _log(f"build {record['build_id']} source {record['flywheel_source']['commit']}")
        runtime = _install_runtime(work, package_root / record["runtime_archive"]["path"], record["claude_engine"]["sha256"])
        executable = runtime / EXECUTABLE_NAME
        analyzer = package_root / record["store_analyzer"]["path"]
        benchmark_rules = package_root / record["benchmark_rules"]["path"] if record["benchmark_rules"] else None
        home = _install_home(work, package_root / record["flywheel_config"]["path"], profile, benchmark_rules, Path(environ["HOME"]))
        child = subprocess.Popen(
            _child_command(executable, profile, stage_file),
            cwd=project_root,
            env=child_environment(environ, home, runtime, project_root, archive_sha256),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
        )
        relay = _Relay(child.stdin, harbor_out, on_settled)
        threading.Thread(target=relay.relay_input, args=(harbor_in or sys.stdin.buffer,), daemon=True).start()
        threading.Thread(target=relay.relay_output, args=(child.stdout,), daemon=True).start()
        snapshots = threading.Thread(target=publish_snapshots, args=({**evidence_request, "project_root": str(project_root)},), daemon=True)
        snapshots.start()
        status = _exit_status(child.wait())
    except _Cancelled:
        status = 143
    finally:
        # From here a SIGTERM only shortens the export deadline.
        exporting = True
        snapshots_stop.set()
        if snapshots is not None:
            snapshots.join()
        if stage_file is not None:
            shutil.rmtree(stage_file.parent, ignore_errors=True)
        publication, withheld, debug_evidence = None, None, None
        if child is not None and executable is not None and analyzer is not None:
            private: Path | None = None
            try:
                private = Path(tempfile.mkdtemp(prefix="flywheel-evidence-")).resolve()
                publication, withheld = _bounded_export(project_root, private, logs_dir, executable, analyzer, lambda: sigterm_deadline)
            except Exception as error:
                withheld = f"export_failed:{type(error).__name__}"
                if private is None:
                    debug_evidence = {"failed": f"publish_failed:{type(error).__name__}"}
            if private is not None:
                request = {**evidence_request, "store": str(private / ".flywheel" / "flywheel.sqlite")}
                try:
                    # A publication that the deadline ends leaves whole files, each its own or the last snapshot's.
                    result, reason = _bounded("publish-evidence", request, lambda: sigterm_deadline, discard_partial)
                    debug_evidence = result if result is not None else {"failed": reason}
                except Exception as error:
                    debug_evidence = {"failed": f"publish_failed:{type(error).__name__}"}
                finally:
                    shutil.rmtree(private, ignore_errors=True)
        credential_values.clear()
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
            debug_evidence=debug_evidence,
        )
        if child is not None:
            # The evidence holds the store and logs, so the graded tree loses only Flywheel's own state, whose scratch
            # scripts a grader that walks the workspace would judge as the task's files. This runs before the answer
            # reaches Harbor, which grades only after it. rmtree refuses a link, so a planted `.flywheel` link stays.
            shutil.rmtree(project_root / ".flywheel", ignore_errors=True)
        if relay is not None:
            relay.release()
        shutil.rmtree(work / "home", ignore_errors=True)
    return status


def main() -> None:
    if len(sys.argv) == 2 and sys.argv[1] in _STEPS:
        print(json.dumps(_STEPS[sys.argv[1]](json.load(sys.stdin))))
        return
    environ = dict(os.environ)
    os.environ.pop(SNAPSHOT_ENV, None)
    sys.exit(run(environ, task_workspace()))


if __name__ == "__main__":
    main()
