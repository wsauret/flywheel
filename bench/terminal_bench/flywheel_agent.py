"""Harbor installed-agent adapter for ``flywheel --headless --task``.

Installs Bun inside the task container, uploads the runtime-only Flywheel source
archive with its runtime assets (both Linux ripgrep addons and the tokenizer),
and runs the headless task command.
"""

import asyncio
from contextlib import contextmanager
import errno
import fcntl
import gzip
import hashlib
import json
import os
import inspect
import re
import secrets
import shlex
import shutil
import stat
import subprocess
import tarfile
import tempfile
import time
import tomllib
import threading
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

# Harbor imports this module as bench.terminal_bench.flywheel_agent; the local
# unit tests import it as a top-level module beside its tests.
try:
    from .harbor_agent.flywheel_harbor_agent.trial_runtime import (
        BUN_RELEASE_ASSETS, BUN_RELEASE_BASE_URL, _DIRECTORY_FLAGS, _NOFOLLOW,
        AdapterSettlement, DeadlineAuthority, EvidencePublication, _backup_sqlite, _copy_descriptor,
        _deadline_fired, _export_settled_sqlite, _latest_machine_summary, _open_absolute_path,
        _open_evidence_source_regular_at, _open_owned_regular_at, _sha256_descriptor, _write_run_summary,
    )
except ImportError:
    from harbor_agent.flywheel_harbor_agent.trial_runtime import (
        BUN_RELEASE_ASSETS, BUN_RELEASE_BASE_URL, _DIRECTORY_FLAGS, _NOFOLLOW,
        AdapterSettlement, DeadlineAuthority, EvidencePublication, _backup_sqlite, _copy_descriptor,
        _deadline_fired, _export_settled_sqlite, _latest_machine_summary, _open_absolute_path,
        _open_evidence_source_regular_at, _open_owned_regular_at, _sha256_descriptor, _write_run_summary,
    )

HARNESS_DIR = "/opt/flywheel-harness"
HARNESS_STAGING_PREFIX = "/tmp/flywheel-harness-"
ROOT_BUN_DIR = "/opt/flywheel-bun"
ROOT_BUN_BIN_DIR = f"{ROOT_BUN_DIR}/bin"
RUN_LOG = "/logs/agent/flywheel.txt"
AUTH_BUNDLE_STAGE_PREFIX = "/tmp/flywheel-auth-bundle-"
ISOLATED_HOME_PREFIX = "/tmp/flywheel-home-"
AUTH_PROFILE_ENV = "FLYWHEEL_TERMINAL_BENCH_AUTH_PROFILE"
DISABLED_TOOLS_ENV = "FLYWHEEL_TERMINAL_BENCH_DISABLED_TOOLS"
SYSTEM_PROMPT_PATH_ENV = "FLYWHEEL_TERMINAL_BENCH_SYSTEM_PROMPT_PATH"
SYSTEM_PROMPT_SHA256_ENV = "FLYWHEEL_TERMINAL_BENCH_SYSTEM_PROMPT_SHA256"
PROFILE_SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
INSTALL_LOCK = "/opt/.flywheel-install.lock"
TASK_CACHE_ROOT = Path.home() / ".cache/harbor/tasks/packages"
BUN_DOWNLOAD_CACHE = "/opt/flywheel-download-cache"
STATE_DIR = "/logs/agent/state"
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
# Exact runtime files outside the allowed roots that the headless runtime loads.
# The archive takes them by exact path, so the secret-name filter does not apply
# to them. They must cover SOURCE_FILE_SET in src/infra/source-snapshot.ts.
RIPGREP_ADDON_ARCHIVE_PATHS = (
    Path("crates/ripgrep/flywheel-ripgrep.linux-arm64.node"),
    Path("crates/ripgrep/flywheel-ripgrep.linux-x64.node"),
)
TOKENIZER_ASSET_ARCHIVE_PATHS = (
    Path("crates/tokenizer/flywheel-tokenizer.wasm.zst"),
    Path("crates/tokenizer/tokenizer-prebuilt.json"),
)
RUNTIME_ASSET_ARCHIVE_PATHS = (*RIPGREP_ADDON_ARCHIVE_PATHS, *TOKENIZER_ASSET_ARCHIVE_PATHS)
# The runtime's SOURCE_FILE_SET (src/infra/source-snapshot.ts) plus bunfig.toml, less the
# tokenizer assets that RUNTIME_ASSET_ARCHIVE_PATHS carries. A member names a file or a directory.
SOURCE_ARCHIVE_MEMBERS = (
    "LICENSE", "THIRD-PARTY-LICENSES.txt", "THIRD-PARTY-NOTICES.md", "bun.lock", "bunfig.toml",
    "package.json", "scripts", "src", "tsconfig.json", "webview/build.ts", "webview/editor",
    "webview/local", "webview/package.json", "webview/phone", "webview/src", "webview/tsconfig.json",
)
_SOURCE_ARCHIVE_MEMBER_PARTS = tuple(Path(member).parts for member in SOURCE_ARCHIVE_MEMBERS)
SOURCE_ARCHIVE_SECRET_SUFFIXES = frozenset({".key", ".p12", ".pem", ".pfx"})
SOURCE_ARCHIVE_SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
RUNTIME_SOURCE_COMMIT_PATTERN = re.compile(r"^[a-f0-9]{40}$")
SOURCE_ARCHIVE_NAME = "source-archive.tar.gz"
SOURCE_ARCHIVE_LOCK_NAME = "source-archive.lock"
SOURCE_ARCHIVE_TEMP_PREFIX = "source-archive.tmp-"
SOURCE_ARCHIVE_SNAPSHOT_NAME = "source-archive.tar.gz"
SOURCE_ARCHIVE_DIGEST_NAME = "source-archive.sha256"
AGENT_OWNER_PATTERN = re.compile(r"^\d+:\d+$")
_ARCHIVE_AUTHORITIES_LOCK = threading.Lock()


@dataclass(frozen=True)
class _ArchiveAuthority:
    job_device: int
    job_inode: int
    archive_device: int
    archive_inode: int
    sha256: str

@dataclass(frozen=True)
class _PinnedRepositoryFile:
    relative_path: Path
    descriptor: int
    file_stat: os.stat_result

@dataclass(frozen=True)
class _GitBlob:
    relative_path: Path
    object_id: str
    size: int
    mode: int
    payload: bytes


@dataclass(frozen=True)
class _PinnedLogDirectories:
    job_path: Path
    agent_path: Path
    job_descriptor: int
    agent_descriptor: int

_ARCHIVE_AUTHORITIES: dict[tuple[int, int], _ArchiveAuthority] = {}
BOOTSTRAP_PROBE_COMMAND = (
    "if command -v curl >/dev/null 2>&1 "
    "&& command -v flock >/dev/null 2>&1 "
    "&& command -v unzip >/dev/null 2>&1 "
    "&& test -r /etc/ssl/certs/ca-certificates.crt; "
    "then printf 'ready\\n'; else printf 'missing\\n'; fi"
)
APT_NETWORK_OPTIONS = "-o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30"
APT_BOOTSTRAP_COMMAND = (
    f"apt-get {APT_NETWORK_OPTIONS} update "
    f"&& apt-get {APT_NETWORK_OPTIONS} install -y --no-install-recommends curl unzip ca-certificates util-linux"
)


def _require_safe_logs_dir(logs_dir: object) -> tuple[Path, Path]:
    if not isinstance(logs_dir, Path) or ".." in logs_dir.parts or len(logs_dir.parts) < 3:
        raise RuntimeError("Flywheel source archive requires logs_dir at <job>/<trial>/agent")
    normalized = logs_dir if logs_dir.is_absolute() else Path.cwd() / logs_dir
    if (
        normalized.name != "agent"
        or normalized.parent.name in ("", ".", "..")
        or normalized.parent.parent.name in ("", ".", "..")
    ):
        raise RuntimeError("Flywheel source archive requires logs_dir at <job>/<trial>/agent")
    return normalized.parent.parent, normalized




def _open_log_directories(logs_dir_value: object) -> _PinnedLogDirectories:
    job_path, agent_path = _require_safe_logs_dir(logs_dir_value)
    root_descriptor = os.open(agent_path.anchor, _DIRECTORY_FLAGS)
    current_descriptor = root_descriptor
    job_descriptor: int | None = None
    try:
        components = agent_path.parts[1:]
        job_index = len(components) - 3
        for index, component in enumerate(components):
            try:
                next_descriptor = os.open(component, _DIRECTORY_FLAGS, dir_fd=current_descriptor)
            except FileNotFoundError:
                os.mkdir(component, mode=0o700, dir_fd=current_descriptor)
                next_descriptor = os.open(component, _DIRECTORY_FLAGS, dir_fd=current_descriptor)
            except OSError as error:
                raise RuntimeError(
                    f"Flywheel source archive path contains a symlink or unsafe component: {agent_path}"
                ) from error
            if current_descriptor != root_descriptor:
                os.close(current_descriptor)
            current_descriptor = next_descriptor
            if index == job_index:
                job_descriptor = os.dup(current_descriptor)
        if job_descriptor is None:
            raise RuntimeError("Flywheel source archive requires logs_dir at <job>/<trial>/agent")
        return _PinnedLogDirectories(job_path, agent_path, job_descriptor, current_descriptor)
    except BaseException:
        if job_descriptor is not None:
            os.close(job_descriptor)
        if current_descriptor != root_descriptor:
            os.close(current_descriptor)
        raise
    finally:
        os.close(root_descriptor)






def _open_absolute_owned_regular(path: Path, flags: int) -> int:
    descriptor = _open_absolute_path(path, flags)
    file_stat = os.fstat(descriptor)
    if (
        not stat.S_ISREG(file_stat.st_mode)
        or file_stat.st_uid != os.getuid()
        or file_stat.st_mode & 0o022
    ):
        os.close(descriptor)
        raise RuntimeError(
            f"Flywheel source archive file has an unsafe type, owner, or mode: {path}"
        )
    return descriptor


def _require_auth_profile_selector(value: object) -> str:
    if (
        not isinstance(value, str)
        or value in (".", "..")
        or "/" in value
        or "\\" in value
        or not value.strip()
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
    ):
        raise RuntimeError(f"{AUTH_PROFILE_ENV} must be a valid Flywheel profile id or display name")
    return value


def _require_disabled_tools(value: object) -> tuple[str, ...]:
    if not isinstance(value, str):
        raise RuntimeError(f"{DISABLED_TOOLS_ENV} must be a JSON array of canonical tool names")
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"{DISABLED_TOOLS_ENV} must be a JSON array of canonical tool names") from error
    if (
        not isinstance(parsed, list)
        or any(not isinstance(name, str) or not re.fullmatch(r"[a-z][a-z0-9_]*", name) for name in parsed)
        or len(set(parsed)) != len(parsed)
    ):
        raise RuntimeError(f"{DISABLED_TOOLS_ENV} must be a unique array of safe canonical tool names")
    return tuple(parsed)


def _read_system_prompt_payload(path_value: object, sha256_value: object) -> str | None:
    if path_value is None and sha256_value is None:
        return None
    if not isinstance(path_value, str) or not path_value or not isinstance(sha256_value, str) or not re.fullmatch(r"[a-f0-9]{64}", sha256_value):
        raise RuntimeError("system prompt payload path and SHA-256 must be provided together")
    path = Path(path_value)
    try:
        file_stat = path.stat()
        if not path.is_file() or stat.S_IMODE(file_stat.st_mode) != 0o600:
            raise RuntimeError("system prompt payload must be a mode-0600 regular file")
        payload = path.read_bytes()
    except OSError as error:
        raise RuntimeError("system prompt payload is unavailable") from error
    if hashlib.sha256(payload).hexdigest() != sha256_value:
        raise RuntimeError("system prompt payload SHA-256 mismatch")
    try:
        return payload.decode("utf-8")
    except UnicodeDecodeError as error:
        raise RuntimeError("system prompt payload must contain valid UTF-8") from error


def _read_flywheel_config(path: str, sha256_value: str) -> bytes:
    """Read the arm's Flywheel config and prove it is the file the launcher validated."""
    try:
        payload = Path(path).read_bytes()
    except OSError as error:
        raise RuntimeError("Flywheel config is unavailable") from error
    if hashlib.sha256(payload).hexdigest() != sha256_value:
        raise RuntimeError("Flywheel config SHA-256 mismatch: the file changed after the launcher validated it")
    return payload


_PINNED_RUNTIME_WRITE_CHUNK_SIZE = 64 * 1024


def _require_materialization_time(deadline: float | None) -> None:
    if deadline is not None and deadline - time.monotonic() <= 0:
        raise TimeoutError("Flywheel pinned runtime materialization deadline expired")


def _create_pinned_runtime_root() -> Path:
    try:
        runtime_root = Path(tempfile.mkdtemp(prefix="flywheel-pinned-runtime-"))
        os.chmod(runtime_root, 0o700)
        root_stat = runtime_root.lstat()
        repository_root = REPO_ROOT.resolve(strict=True)
        if runtime_root.resolve().is_relative_to(repository_root):
            raise RuntimeError("Flywheel pinned runtime staging directory is inside the repository")
        if (
            not stat.S_ISDIR(root_stat.st_mode)
            or root_stat.st_uid != os.getuid()
            or stat.S_IMODE(root_stat.st_mode) != 0o700
        ):
            raise RuntimeError("Flywheel pinned runtime staging directory is unsafe")
        return runtime_root
    except BaseException as error:
        if "runtime_root" in locals():
            shutil.rmtree(runtime_root, ignore_errors=True)
        if isinstance(error, RuntimeError):
            raise
        raise RuntimeError("Flywheel pinned runtime staging directory is unavailable") from error




def _populate_pinned_runtime(runtime_root: Path, commit: str, deadline: float | None) -> None:
    blobs = _pinned_git_blobs(commit) if deadline is None else _pinned_git_blobs(commit, deadline)
    for blob in blobs:
        relative_path = blob.relative_path
        if (
            relative_path.is_absolute()
            or not relative_path.parts
            or ".." in relative_path.parts
            or "\\" in str(relative_path)
            or blob.mode not in (0o100644, 0o100755)
            or blob.size != len(blob.payload)
        ):
            raise RuntimeError("Flywheel pinned runtime blob is unsafe")
        parent = runtime_root
        for component in relative_path.parts[:-1]:
            _require_materialization_time(deadline)
            parent /= component
            try:
                parent.mkdir(mode=0o700)
            except FileExistsError:
                if not parent.is_dir() or parent.is_symlink():
                    raise RuntimeError("Flywheel pinned runtime path collides with a non-directory") from None
        target = runtime_root / relative_path
        _require_materialization_time(deadline)
        try:
            descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | _NOFOLLOW, 0o600)
        except OSError as error:
            raise RuntimeError("Flywheel pinned runtime blob path collides or is unsafe") from error
        try:
            payload = memoryview(blob.payload)
            offset = 0
            while offset < len(payload):
                _require_materialization_time(deadline)
                try:
                    written = os.write(descriptor, payload[offset : offset + _PINNED_RUNTIME_WRITE_CHUNK_SIZE])
                except InterruptedError:
                    continue
                if written == 0:
                    raise RuntimeError("Flywheel pinned runtime blob write made no progress")
                offset += written
            _require_materialization_time(deadline)
            os.fchmod(descriptor, 0o700 if blob.mode == 0o100755 else 0o600)
            _require_materialization_time(deadline)
        finally:
            os.close(descriptor)
    _require_materialization_time(deadline)


@contextmanager
def _materialized_pinned_runtime(commit: str, deadline: float | None = None):
    """Materialize verified Git blobs in a private runtime tree outside the repository."""
    runtime_root = _create_pinned_runtime_root()
    try:
        _populate_pinned_runtime(runtime_root, commit, deadline)
        yield runtime_root
    finally:
        shutil.rmtree(runtime_root, ignore_errors=True)


async def _await_task_settlement(task: asyncio.Task):
    cancellation = None
    while True:
        try:
            result = await asyncio.shield(task)
            if cancellation is not None:
                raise cancellation
            return result
        except asyncio.CancelledError as error:
            if task.done():
                if cancellation is not None:
                    raise cancellation
                raise
            if cancellation is None:
                cancellation = error


async def _kill_and_reap(process) -> None:
    if process.returncode is None:
        process.kill()
    await _await_task_settlement(asyncio.create_task(process.wait()))


def _install_environment(runtime_root: Path) -> dict[str, str]:
    home = runtime_root / ".install-home"
    config = runtime_root / ".xdg-config"
    cache = runtime_root / ".xdg-cache"
    temporary = runtime_root / ".tmp"
    for directory in (home, config, cache, temporary):
        directory.mkdir(mode=0o700)
    environment = {
        "PATH": os.environ.get("PATH", os.defpath),
        "HOME": str(home),
        "XDG_CONFIG_HOME": str(config),
        "XDG_CACHE_HOME": str(cache),
        "TMPDIR": str(temporary),
    }
    for name in ("SSL_CERT_FILE", "SSL_CERT_DIR"):
        value = os.environ.get(name)
        if value:
            environment[name] = value
    return environment


async def _export_auth_snapshot(
    selector: str,
    output: Path,
    timeout: float | None,
    runtime_source_commit: str | None = None,
    as_profile: str | None = None,
    providers: tuple[str, ...] = (),
) -> str:
    """Invoke Flywheel's host-owned snapshot boundary without exposing subprocess output.

    With `as_profile`, the snapshot carries the selected profile's credentials
    under that profile id, so a trial config's profile tables name no host profile.
    With `providers`, it carries only those credential providers' credentials.
    """
    deadline = None if timeout is None else time.monotonic() + timeout
    runtime_root = REPO_ROOT
    owns_runtime_root = runtime_source_commit is not None
    try:
        if owns_runtime_root:
            runtime_root = _create_pinned_runtime_root()
            worker = asyncio.create_task(asyncio.to_thread(_populate_pinned_runtime, runtime_root, runtime_source_commit, deadline))
            await _await_task_settlement(worker)
        export_argv = (
            "bun", "--conditions=browser", str(runtime_root / "src" / "cli" / "index.ts"), "headless", "snapshot-auth",
            "--auth-profile", selector, "--output", str(output),
            *(() if as_profile is None else ("--as-profile", as_profile)),
            *(argument for provider in providers for argument in ("--provider", provider)),
        )
        commands = (
            (("bun", "install", "--frozen-lockfile", "--ignore-scripts"), _install_environment(runtime_root)),
            (export_argv, None),
        ) if owns_runtime_root else ((export_argv, None),)
        for argv, environment in commands:
            process = await asyncio.create_subprocess_exec(
                *argv, cwd=runtime_root, stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                **({"env": environment} if environment is not None else {}),
            )
            remaining = None if deadline is None else max(0, deadline - time.monotonic())
            try:
                stdout, _stderr = await asyncio.wait_for(process.communicate(), timeout=remaining)
            except BaseException:
                await _kill_and_reap(process)
                raise
            if process.returncode != 0:
                raise RuntimeError
            if argv is export_argv:
                profile = stdout.decode("utf-8").strip()
                if not profile:
                    raise RuntimeError
                return profile
    except BaseException as error:
        if isinstance(error, asyncio.CancelledError):
            raise
        raise RuntimeError("Flywheel auth snapshot export failed") from None
    finally:
        if owns_runtime_root:
            shutil.rmtree(runtime_root, ignore_errors=True)
    raise RuntimeError("Flywheel auth snapshot export failed")


async def _cleanup_remote_paths(agent, environment, command: str) -> None:
    try:
        await asyncio.wait_for(
            agent.exec_as_agent(environment, command=command, timeout_sec=5),
            timeout=5,
        )
    except BaseException as agent_cleanup_error:
        try:
            await asyncio.wait_for(
                agent.exec_as_root(environment, command=command, timeout_sec=5),
                timeout=5,
            )
        except BaseException as root_cleanup_error:
            root_cleanup_error.add_note(
                f"Agent cleanup also failed: {type(agent_cleanup_error).__name__}: {agent_cleanup_error}"
            )
            raise


async def _settle_remote_cleanup(cleanup) -> tuple[asyncio.CancelledError | None, BaseException | None, object | None]:
    task = asyncio.create_task(cleanup)
    cancellation = None
    while True:
        try:
            result = await asyncio.shield(task)
            return cancellation, None, result
        except asyncio.CancelledError as error:
            if task.cancelled():
                return cancellation, error, None
            if cancellation is None:
                cancellation = error
        except BaseException as error:
            return cancellation, error, None






def _validate_archive_manifest_file(
    archive_file, expected_paths: tuple[Path, ...]
) -> bool:
    expected_names = tuple(item.as_posix() for item in expected_paths)
    if len(expected_names) != len(set(expected_names)):
        raise RuntimeError("Flywheel source archive manifest contains duplicate expected paths")
    archive_file.seek(0)
    try:
        with tarfile.open(fileobj=archive_file, mode="r:gz") as archive:
            names: list[str] = []
            for member in archive:
                canonical_name = PurePosixPath(member.name).as_posix()
                if (
                    not member.isfile()
                    or member.name.startswith("/")
                    or canonical_name != member.name
                    or ".." in PurePosixPath(member.name).parts
                ):
                    return False
                names.append(member.name)
    except (gzip.BadGzipFile, EOFError, OSError, tarfile.TarError):
        return False
    finally:
        archive_file.seek(0)
    return len(names) == len(set(names)) and set(names) == set(expected_names)




def _cleanup_stale_archive_temps(job_descriptor: int) -> None:
    for name in os.listdir(job_descriptor):
        if not name.startswith(SOURCE_ARCHIVE_TEMP_PREFIX):
            continue
        file_mode = os.stat(name, dir_fd=job_descriptor, follow_symlinks=False).st_mode
        if not (stat.S_ISREG(file_mode) or stat.S_ISLNK(file_mode)):
            raise RuntimeError(f"Flywheel source archive temporary path is unsafe: {name}")
        os.unlink(name, dir_fd=job_descriptor)


def _fsync_directory_descriptor(descriptor: int) -> None:
    try:
        os.fsync(descriptor)
    except OSError as error:
        if error.errno not in (errno.EINVAL, errno.ENOTSUP):
            raise

def _normalize_archive_member(member: tarfile.TarInfo) -> tarfile.TarInfo:
    member.uid = 0
    member.gid = 0
    member.uname = ""
    member.gname = ""
    member.mtime = 0
    member.pax_headers = {}
    if member.isfile():
        member.mode = 0o755 if member.mode & 0o111 else 0o644
    return member


def _open_repository_root(repository_root: Path | None = None) -> int:
    try:
        root = REPO_ROOT if repository_root is None else repository_root
        return os.open(root.resolve(strict=True), _DIRECTORY_FLAGS)
    except OSError as error:
        raise RuntimeError("Flywheel source archive repository root is unsafe") from error


def _open_repository_file(repository_root_descriptor: int, relative_path: Path) -> int:
    if relative_path.is_absolute() or not relative_path.parts or ".." in relative_path.parts:
        raise RuntimeError(f"Flywheel source archive path is unsafe: {relative_path}")
    parent_descriptor = os.dup(repository_root_descriptor)
    try:
        for component in relative_path.parts[:-1]:
            next_descriptor = os.open(component, _DIRECTORY_FLAGS, dir_fd=parent_descriptor)
            os.close(parent_descriptor)
            parent_descriptor = next_descriptor
        descriptor = os.open(relative_path.name, os.O_RDONLY | _NOFOLLOW, dir_fd=parent_descriptor)
    except OSError as error:
        raise RuntimeError(f"Flywheel source archive path is unsafe: {relative_path}") from error
    finally:
        os.close(parent_descriptor)
    file_stat = os.fstat(descriptor)
    if (
        not stat.S_ISREG(file_stat.st_mode)
        or file_stat.st_uid != os.getuid()
        or file_stat.st_nlink != 1
        or file_stat.st_mode & 0o022
    ):
        os.close(descriptor)
        raise RuntimeError(
            f"Flywheel source archive path has an unsafe type, owner, mode, or link identity: {relative_path}"
        )
    return descriptor


def _pin_repository_files(
    relative_paths: tuple[Path, ...], repository_root: Path | None = None
) -> tuple[_PinnedRepositoryFile, ...]:
    repository_root_descriptor = _open_repository_root(repository_root)
    pinned: list[_PinnedRepositoryFile] = []
    try:
        for relative_path in relative_paths:
            descriptor = _open_repository_file(repository_root_descriptor, relative_path)
            pinned.append(
                _PinnedRepositoryFile(relative_path, descriptor, os.fstat(descriptor))
            )
    except BaseException:
        _close_pinned_repository_files(tuple(pinned))
        raise
    finally:
        os.close(repository_root_descriptor)
    return tuple(pinned)


def _close_pinned_repository_files(pinned: tuple[_PinnedRepositoryFile, ...]) -> None:
    for source in pinned:
        os.close(source.descriptor)


def _repository_file_identity(file_stat: os.stat_result) -> tuple[int, ...]:
    return (
        file_stat.st_dev,
        file_stat.st_ino,
        file_stat.st_mode,
        file_stat.st_uid,
        file_stat.st_gid,
        file_stat.st_nlink,
        file_stat.st_size,
        file_stat.st_mtime_ns,
        file_stat.st_ctime_ns,
    )


def _require_stable_pinned_files(pinned: tuple[_PinnedRepositoryFile, ...]) -> None:
    for source in pinned:
        if _repository_file_identity(os.fstat(source.descriptor)) != _repository_file_identity(
            source.file_stat
        ):
            raise RuntimeError(
                f"Flywheel source archive selected inode changed during archive read: {source.relative_path}"
            )



def _require_repository_paths_match_pinned_files(
    pinned: tuple[_PinnedRepositoryFile, ...],
) -> None:
    repository_root_descriptor = _open_repository_root()
    try:
        for source in pinned:
            reopened_descriptor = _open_repository_file(
                repository_root_descriptor, source.relative_path
            )
            try:
                if _repository_file_identity(
                    os.fstat(reopened_descriptor)
                ) != _repository_file_identity(source.file_stat):
                    raise RuntimeError(
                        f"Flywheel source archive selected path was remapped: {source.relative_path}"
                    )
            finally:
                os.close(reopened_descriptor)
    finally:
        os.close(repository_root_descriptor)

def _write_pinned_source_tar(tar_file, pinned: tuple[_PinnedRepositoryFile, ...]) -> None:
    tar_file.seek(0)
    tar_file.truncate()
    _require_stable_pinned_files(pinned)
    try:
        with tarfile.open(fileobj=tar_file, mode="w", format=tarfile.PAX_FORMAT) as archive:
            for source in pinned:
                member = tarfile.TarInfo(source.relative_path.as_posix())
                member.size = source.file_stat.st_size
                member.mode = stat.S_IMODE(source.file_stat.st_mode)
                os.lseek(source.descriptor, 0, os.SEEK_SET)
                with open(source.descriptor, "rb", closefd=False) as source_file:
                    archive.addfile(_normalize_archive_member(member), source_file)
    finally:
        _require_stable_pinned_files(pinned)
    tar_file.flush()

def _is_source_archive_path_allowed(path: Path) -> bool:
    lower_parts = tuple(part.casefold() for part in path.parts)
    lower_name = lower_parts[-1]
    lower_suffix = Path(lower_name).suffix
    typescript_source = lower_suffix in {".ts", ".tsx"}
    explicit_client_secret = any(
        marker in lower_name for marker in ("client_secret", "client-secret", "clientsecret")
    )
    credential_name = not typescript_source and any(
        marker in lower_name
        for marker in (
            "api_key", "api-key", "apikey", "service-account", "service_account",
            "serviceaccount", "private-key", "private_key",
        )
    )
    credential_prefix = not typescript_source and any(
        lower_name.startswith(prefix) for prefix in ("auth", "credentials", "secret", "token")
    )
    private_key_name = any(
        lower_name.startswith(name)
        for name in ("id_rsa", "id_dsa", "id_ecdsa", "id_ed25519")
    )
    secret_name = (
        lower_name == ".env"
        or lower_name.startswith(".env.")
        or lower_name in {".envrc", ".npmrc", ".netrc", "netrc"}
        or private_key_name
        or explicit_client_secret
        or credential_name
        or credential_prefix
        or lower_suffix in SOURCE_ARCHIVE_SECRET_SUFFIXES
        or "secrets" in lower_parts
    )
    if secret_name:
        return False
    return any(path.parts[:len(member)] == member for member in _SOURCE_ARCHIVE_MEMBER_PARTS)


def _git_source_paths(arguments: list[str]) -> tuple[Path, ...]:
    result = subprocess.run(
        ["git", "ls-files", "-z", *arguments],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
    )
    paths: list[Path] = []
    for raw_path in result.stdout.split(b"\0"):
        if not raw_path:
            continue
        path = Path(os.fsdecode(raw_path))
        if path.is_absolute() or not path.parts or ".." in path.parts or "\\" in str(path):
            raise RuntimeError(f"Flywheel source archive path is unsafe: {path}")
        paths.append(path)
    if len(paths) != len(set(paths)):
        raise RuntimeError("Flywheel source archive Git path list contains duplicates")
    return tuple(paths)




def _tracked_worktree_path_exists(path: Path) -> bool:
    if path.is_absolute() or not path.parts or ".." in path.parts:
        raise RuntimeError(f"Flywheel source archive path is unsafe: {path}")
    repository_root_descriptor = _open_repository_root()
    parent_descriptor = os.dup(repository_root_descriptor)
    try:
        for component in path.parts[:-1]:
            try:
                next_descriptor = os.open(component, _DIRECTORY_FLAGS, dir_fd=parent_descriptor)
            except OSError as error:
                raise RuntimeError(f"Flywheel source archive path is unsafe: {path}") from error
            os.close(parent_descriptor)
            parent_descriptor = next_descriptor
        try:
            os.stat(path.name, dir_fd=parent_descriptor, follow_symlinks=False)
        except FileNotFoundError:
            return False
        except OSError as error:
            raise RuntimeError(f"Flywheel source archive path is unsafe: {path}") from error
        return True
    finally:
        os.close(parent_descriptor)
        os.close(repository_root_descriptor)


def _is_untracked_source_archive_path_safe(path: Path) -> bool:
    repository_root_descriptor = _open_repository_root()
    try:
        try:
            descriptor = _open_repository_file(repository_root_descriptor, path)
        except RuntimeError:
            return False
        os.close(descriptor)
        return True
    finally:
        os.close(repository_root_descriptor)


def _source_archive_paths() -> tuple[Path, ...]:
    # Git tracking is the source trust root. Name-based secret checks remain defense in depth.
    tracked_paths = tuple(
        path
        for path in _git_source_paths(["--cached"])
        if _is_source_archive_path_allowed(path) and _tracked_worktree_path_exists(path)
    )
    untracked_paths = tuple(
        path
        for path in _git_source_paths(
            [
                "--others",
                "--exclude-standard",
                "--",
                *SOURCE_ARCHIVE_MEMBERS,
            ]
        )
        if _is_source_archive_path_allowed(path) and _is_untracked_source_archive_path_safe(path)
    )
    if set(tracked_paths) & set(untracked_paths):
        raise RuntimeError("Flywheel source archive path cannot be both tracked and untracked")
    return tuple(sorted((*tracked_paths, *untracked_paths), key=lambda path: path.as_posix()))

def _remaining_git_timeout(deadline: float | None) -> float | None:
    if deadline is None:
        return None
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise RuntimeError("Flywheel pinned runtime Git object query failed")
    return remaining


def _git_object_command(arguments: list[str], *, input_bytes: bytes | None = None, deadline: float | None = None) -> bytes:
    try:
        result = subprocess.run(
            ["git", "--no-replace-objects", *arguments], cwd=REPO_ROOT, input=input_bytes,
            check=True, capture_output=True, timeout=_remaining_git_timeout(deadline),
        )
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        raise RuntimeError("Flywheel pinned runtime Git object query failed") from None
    return result.stdout


def _resolve_runtime_source_commit(requested_sha: object, deadline: float | None = None) -> str:
    if not isinstance(requested_sha, str) or not RUNTIME_SOURCE_COMMIT_PATTERN.fullmatch(requested_sha):
        raise ValueError("runtime_source_commit must be an exact lowercase 40-hex commit SHA")
    resolved = os.fsdecode(_git_object_command(["rev-parse", "--verify", f"{requested_sha}^{{commit}}"], deadline=deadline)).strip()
    if resolved != requested_sha:
        raise RuntimeError("Flywheel pinned runtime commit did not resolve canonically")
    return resolved


def _pinned_git_blobs(commit: str, deadline: float | None = None) -> tuple[_GitBlob, ...]:
    selectors = (*SOURCE_ARCHIVE_MEMBERS, *(path.as_posix() for path in RUNTIME_ASSET_ARCHIVE_PATHS))
    output = _git_object_command(["ls-tree", "-rz", "--full-tree", commit, "--", *selectors], deadline=deadline)
    selected: dict[Path, tuple[str, int, int]] = {}
    try:
        for record in output.split(b"\0"):
            if not record:
                continue
            metadata, raw_path = record.split(b"\t", 1)
            raw_mode, object_type, raw_oid = metadata.split(b" ", 2)
            path = Path(os.fsdecode(raw_path))
            if path.is_absolute() or not path.parts or ".." in path.parts or "\\" in str(path):
                raise ValueError
            if object_type != b"blob" or raw_mode not in (b"100644", b"100755"):
                raise RuntimeError(f"Flywheel pinned runtime entry is not a regular blob: {path}")
            if path in selected:
                raise RuntimeError("Flywheel pinned runtime Git tree contains duplicate paths")
            if path in RUNTIME_ASSET_ARCHIVE_PATHS or _is_source_archive_path_allowed(path):
                selected[path] = (raw_oid.decode("ascii"), int(raw_mode, 8), 0)
    except (ValueError, UnicodeError) as error:
        raise RuntimeError("Flywheel pinned runtime Git tree response is malformed") from None
    # Commits before 2026-09-07 predate the local tokenizer and do not import it,
    # so they may lack both tokenizer files. A commit with only one of them is broken.
    missing = set(RUNTIME_ASSET_ARCHIVE_PATHS) - set(selected)
    if missing and missing != set(TOKENIZER_ASSET_ARCHIVE_PATHS):
        raise RuntimeError("Flywheel pinned runtime commit is missing a required runtime asset")
    requests = b"".join(f"{oid}\n".encode("ascii") for oid, _, _ in selected.values())
    try:
        process = subprocess.Popen(["git", "--no-replace-objects", "cat-file", "--batch"], cwd=REPO_ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            stdout, _ = process.communicate(requests, timeout=_remaining_git_timeout(deadline))
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
            raise
    except (OSError, subprocess.TimeoutExpired):
        raise RuntimeError("Flywheel pinned runtime Git object read failed") from None
    if process.returncode != 0:
        raise RuntimeError("Flywheel pinned runtime Git object read failed")
    cursor = 0
    blobs: list[_GitBlob] = []
    for path, (expected_oid, mode, _) in selected.items():
        newline = stdout.find(b"\n", cursor)
        if newline < 0:
            raise RuntimeError("Flywheel pinned runtime Git batch response is malformed")
        try:
            oid, object_type, raw_size = stdout[cursor:newline].decode("ascii").split(" ")
            size = int(raw_size)
        except (UnicodeError, ValueError):
            raise RuntimeError("Flywheel pinned runtime Git batch response is malformed") from None
        start, end = newline + 1, newline + 1 + size
        if oid != expected_oid or object_type != "blob" or end >= len(stdout) or stdout[end:end + 1] != b"\n":
            raise RuntimeError("Flywheel pinned runtime Git object identity, type, or size mismatch")
        payload = stdout[start:end]
        if len(payload) != size:
            raise RuntimeError("Flywheel pinned runtime Git object size mismatch")
        blobs.append(_GitBlob(path, oid, size, mode, payload))
        cursor = end + 1
    if cursor != len(stdout):
        raise RuntimeError("Flywheel pinned runtime Git batch response has trailing bytes")
    return tuple(sorted(blobs, key=lambda blob: blob.relative_path.as_posix()))


def _write_git_blob_tar(tar_file, blobs: tuple[_GitBlob, ...]) -> None:
    import io
    tar_file.seek(0)
    tar_file.truncate()
    with tarfile.open(fileobj=tar_file, mode="w", format=tarfile.PAX_FORMAT) as archive:
        for blob in blobs:
            member = tarfile.TarInfo(blob.relative_path.as_posix())
            member.size = blob.size
            member.mode = blob.mode
            archive.addfile(_normalize_archive_member(member), io.BytesIO(blob.payload))
    tar_file.flush()



def _sha256_fileobj(source) -> str:
    source.seek(0)
    digest = hashlib.sha256()
    for chunk in iter(lambda: source.read(1024 * 1024), b""):
        digest.update(chunk)
    source.seek(0)
    return digest.hexdigest()




def _create_job_temporary_file(job_descriptor: int, suffix: str) -> tuple[str, object]:
    for _ in range(100):
        name = f"{SOURCE_ARCHIVE_TEMP_PREFIX}{secrets.token_hex(16)}{suffix}"
        try:
            descriptor = os.open(
                name,
                os.O_RDWR | os.O_CREAT | os.O_EXCL | _NOFOLLOW,
                0o600,
                dir_fd=job_descriptor,
            )
        except FileExistsError:
            continue
        return name, os.fdopen(descriptor, "w+b")
    raise RuntimeError("Flywheel source archive cannot allocate a temporary file")


def _build_archive(
    job_dir: Path,
    archive_path: Path,
    job_descriptor: int | None = None,
    runtime_source_commit: str | None = None,
) -> _ArchiveAuthority:
    blobs = _pinned_git_blobs(runtime_source_commit) if runtime_source_commit is not None else None
    source_paths = tuple(blob.relative_path for blob in blobs) if blobs is not None else _source_archive_paths()
    expected_paths = source_paths if blobs is not None else (*source_paths, *RUNTIME_ASSET_ARCHIVE_PATHS)
    pinned = () if blobs is not None else _pin_repository_files(expected_paths)
    owns_job_descriptor = job_descriptor is None
    if job_descriptor is None:
        job_descriptor = os.open(job_dir.resolve(strict=True), _DIRECTORY_FLAGS)
    tar_name: str | None = None
    pending_name: str | None = None
    try:
        tar_name, temporary_tar = _create_job_temporary_file(job_descriptor, ".tar")
        pending_name, temporary_archive = _create_job_temporary_file(job_descriptor, ".tar.gz")
        with temporary_tar, temporary_archive:
            _write_git_blob_tar(temporary_tar, blobs) if blobs is not None else _write_pinned_source_tar(temporary_tar, pinned)
            _gzip_reproducibly_files(temporary_tar, temporary_archive)
            os.fchmod(temporary_archive.fileno(), 0o444)
            temporary_archive.flush()
            os.fsync(temporary_archive.fileno())
            if not _validate_archive_manifest_file(temporary_archive, expected_paths):
                raise RuntimeError("Flywheel source archive build produced an invalid archive")
            digest = _sha256_fileobj(temporary_archive)
            held_stat = os.fstat(temporary_archive.fileno())
            if blobs is None:
                _require_repository_paths_match_pinned_files(pinned)
                if _source_archive_paths() != source_paths:
                    raise RuntimeError("Flywheel source archive path selection changed during archive build")
            os.rename(
                pending_name,
                archive_path.name,
                src_dir_fd=job_descriptor,
                dst_dir_fd=job_descriptor,
            )
            pending_name = None
            canonical_stat = os.stat(
                archive_path.name, dir_fd=job_descriptor, follow_symlinks=False
            )
            if (
                not stat.S_ISREG(canonical_stat.st_mode)
                or (canonical_stat.st_dev, canonical_stat.st_ino)
                != (held_stat.st_dev, held_stat.st_ino)
            ):
                os.unlink(archive_path.name, dir_fd=job_descriptor)
                raise RuntimeError("Flywheel source archive canonical identity changed")
            job_stat = os.fstat(job_descriptor)
            authority = _ArchiveAuthority(
                job_device=job_stat.st_dev,
                job_inode=job_stat.st_ino,
                archive_device=held_stat.st_dev,
                archive_inode=held_stat.st_ino,
                sha256=digest,
            )
        _fsync_directory_descriptor(job_descriptor)
        return authority
    finally:
        _close_pinned_repository_files(pinned)
        for temporary_name in (tar_name, pending_name):
            if temporary_name is not None:
                try:
                    os.unlink(temporary_name, dir_fd=job_descriptor)
                except FileNotFoundError:
                    pass
        if owns_job_descriptor:
            os.close(job_descriptor)


def _trusted_archive_authority(job_descriptor: int) -> _ArchiveAuthority | None:
    job_stat = os.fstat(job_descriptor)
    key = (job_stat.st_dev, job_stat.st_ino)
    with _ARCHIVE_AUTHORITIES_LOCK:
        authority = _ARCHIVE_AUTHORITIES.get(key)
    if authority is None:
        return None
    try:
        descriptor = _open_owned_regular_at(
            job_descriptor,
            SOURCE_ARCHIVE_NAME,
            os.O_RDONLY,
            require_single_link=False,
        )
    except FileNotFoundError:
        return None
    try:
        archive_stat = os.fstat(descriptor)
        if stat.S_IMODE(archive_stat.st_mode) != 0o444:
            return None
        if (archive_stat.st_dev, archive_stat.st_ino) != (
            authority.archive_device,
            authority.archive_inode,
        ):
            return None
    finally:
        os.close(descriptor)
    return authority


def _require_replaceable_canonical(job_descriptor: int) -> None:
    try:
        mode = os.stat(
            SOURCE_ARCHIVE_NAME, dir_fd=job_descriptor, follow_symlinks=False
        ).st_mode
    except FileNotFoundError:
        return
    if stat.S_ISLNK(mode) or not stat.S_ISREG(mode):
        raise RuntimeError(
            f"Flywheel source archive file is unsafe: {SOURCE_ARCHIVE_NAME}"
        )


def _write_digest_sidecar_at(agent_descriptor: int, digest: str) -> None:
    if not SOURCE_ARCHIVE_SHA256_PATTERN.fullmatch(digest):
        raise RuntimeError("Flywheel source archive identity is malformed")
    sidecar_descriptor = _open_owned_regular_at(
        agent_descriptor,
        SOURCE_ARCHIVE_DIGEST_NAME,
        os.O_WRONLY | os.O_CREAT,
        mode=0o600,
    )
    os.ftruncate(sidecar_descriptor, 0)
    with os.fdopen(sidecar_descriptor, "w") as sidecar:
        sidecar.write(f"{digest}\n")


def _prepare_trial_snapshot(logs_dir_value: object, runtime_source_commit: str | None = None) -> tuple[Path, str]:
    directories: _PinnedLogDirectories | None = None
    try:
        directories = _open_log_directories(logs_dir_value)
        job_stat = os.fstat(directories.job_descriptor)
        authority_key = (job_stat.st_dev, job_stat.st_ino)
        lock_descriptor = _open_owned_regular_at(
            directories.job_descriptor,
            SOURCE_ARCHIVE_LOCK_NAME,
            os.O_RDWR | os.O_CREAT,
        )
        try:
            fcntl.flock(lock_descriptor, fcntl.LOCK_EX)
            authority = _trusted_archive_authority(directories.job_descriptor)
            if authority is None:
                _cleanup_stale_archive_temps(directories.job_descriptor)
                _require_replaceable_canonical(directories.job_descriptor)
                authority = _build_archive(
                    directories.job_path,
                    directories.job_path / SOURCE_ARCHIVE_NAME,
                    directories.job_descriptor,
                    runtime_source_commit=runtime_source_commit,
                )
                with _ARCHIVE_AUTHORITIES_LOCK:
                    _ARCHIVE_AUTHORITIES[authority_key] = authority
            canonical_descriptor = _open_owned_regular_at(
                directories.job_descriptor,
                SOURCE_ARCHIVE_NAME,
                os.O_RDONLY,
                require_single_link=False,
            )
            try:
                canonical_stat = os.fstat(canonical_descriptor)
            finally:
                os.close(canonical_descriptor)
            if (canonical_stat.st_dev, canonical_stat.st_ino) != (
                authority.archive_device,
                authority.archive_inode,
            ):
                raise RuntimeError("Flywheel source archive canonical identity changed")
            try:
                os.link(
                    SOURCE_ARCHIVE_NAME,
                    SOURCE_ARCHIVE_SNAPSHOT_NAME,
                    src_dir_fd=directories.job_descriptor,
                    dst_dir_fd=directories.agent_descriptor,
                    follow_symlinks=False,
                )
            except FileExistsError:
                pass
            snapshot_descriptor = _open_owned_regular_at(
                directories.agent_descriptor,
                SOURCE_ARCHIVE_SNAPSHOT_NAME,
                os.O_RDONLY,
                require_single_link=False,
            )
            try:
                snapshot_stat = os.fstat(snapshot_descriptor)
            finally:
                os.close(snapshot_descriptor)
            if (snapshot_stat.st_dev, snapshot_stat.st_ino) != (
                authority.archive_device,
                authority.archive_inode,
            ):
                raise RuntimeError(
                    "Flywheel source archive trial snapshot does not match the canonical archive"
                )
            _write_digest_sidecar_at(directories.agent_descriptor, authority.sha256)
            snapshot_path = directories.agent_path / SOURCE_ARCHIVE_SNAPSHOT_NAME
            visible_descriptor = _open_absolute_owned_regular(snapshot_path, os.O_RDONLY)
            try:
                visible_stat = os.fstat(visible_descriptor)
            finally:
                os.close(visible_descriptor)
            if (visible_stat.st_dev, visible_stat.st_ino) != (
                authority.archive_device,
                authority.archive_inode,
            ):
                raise RuntimeError("Flywheel source archive visible snapshot identity changed")
            return snapshot_path, authority.sha256
        finally:
            fcntl.flock(lock_descriptor, fcntl.LOCK_UN)
            os.close(lock_descriptor)
    except OSError as error:
        job_path, _ = _require_safe_logs_dir(logs_dir_value)
        raise RuntimeError(
            f"Flywheel source archive is unavailable in job directory: {job_path}"
        ) from error
    finally:
        if directories is not None:
            os.close(directories.agent_descriptor)
            os.close(directories.job_descriptor)




def _gzip_reproducibly_files(source, destination) -> None:
    """Compress a tar with a stable gzip header and exact payload bytes."""
    source.seek(0)
    destination.seek(0)
    destination.truncate()
    with gzip.GzipFile(
        filename="", mode="wb", compresslevel=9, fileobj=destination, mtime=0
    ) as compressed:
        shutil.copyfileobj(source, compressed)
    destination.flush()
    source.seek(0)
    destination.seek(0)


def _resolve_deadline_authority(
    logs_dir: Path, dataset: object, task_cache: Path = TASK_CACHE_ROOT
) -> DeadlineAuthority:
    if not isinstance(dataset, str) or dataset.count("/") != 1:
        return DeadlineAuthority(None, None, "deadline-blind:dataset-identity-ambiguous")
    configured_org = dataset.split("/", 1)[0]
    trial_name = logs_dir.parent.name
    if trial_name.count("__") != 1 or not trial_name.split("__", 1)[0]:
        return DeadlineAuthority(None, None, "deadline-blind:trial-path-malformed")
    try:
        lock = json.loads((logs_dir.parent / "lock.json").read_text())
        task = lock["task"]
        task_identity = task["name"]
        digest = task["digest"]
        if not isinstance(task_identity, str) or task_identity.count("/") != 1:
            raise ValueError("task identity")
        org, task_name = task_identity.split("/", 1)
        if org != configured_org or task_name != trial_name.split("__", 1)[0]:
            raise ValueError("task authority")
        if not isinstance(digest, str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
            raise ValueError("task digest")
        config = tomllib.loads(
            (task_cache / org / task_name / digest.removeprefix("sha256:") / "task.toml").read_text()
        )
        timeout = config["agent"]["timeout_sec"]
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or timeout <= 0:
            raise ValueError("agent timeout")
        return DeadlineAuthority(float(timeout), digest, "executed-task-digest")
    except (OSError, UnicodeError, json.JSONDecodeError, tomllib.TOMLDecodeError, KeyError, TypeError, ValueError):
        return DeadlineAuthority(None, None, "deadline-blind:executed-task-metadata-unavailable")






def _evidence_export_command(project_root: str) -> str:
    definitions = (_open_absolute_path, _open_owned_regular_at, _open_evidence_source_regular_at, _sha256_descriptor, _copy_descriptor, _backup_sqlite, _export_settled_sqlite)
    program = "\n".join((
        "import hashlib, json, os, secrets, shutil, sqlite3, stat, sys, tempfile",
        "from dataclasses import dataclass",
        "from pathlib import Path",
        f"_NOFOLLOW = {repr(_NOFOLLOW)}",
        f"_DIRECTORY_FLAGS = {repr(_DIRECTORY_FLAGS)}",
        inspect.getsource(EvidencePublication),
        *(inspect.getsource(definition) for definition in definitions),
        "print(json.dumps(_export_settled_sqlite(Path(sys.argv[1]), Path(sys.argv[2])).__dict__, sort_keys=True))",
    ))
    state_dir = shlex.quote(STATE_DIR)
    return f"umask 077 && mkdir -m 700 -- {state_dir} && python3 -c {shlex.quote(program)} {shlex.quote(project_root)} {state_dir}"



def build_task_command(
    instruction: str,
    profile: str,
    auth_snapshot: str,
    disabled_tools: tuple[str, ...] = (),
    deadline_seconds: int | None = None,
    system_prompt: str | None = None,
) -> str:
    """Build a Bash-owned headless command and export settled durable evidence."""
    deadline_flag = "" if deadline_seconds is None else f"--deadline-seconds {deadline_seconds} "
    disabled_flags = "".join(f"--disable-tool {shlex.quote(name)} " for name in disabled_tools)
    system_prompt_flag = "" if system_prompt is None else f"--system-prompt {shlex.quote(system_prompt)} "
    script = (
        f'export PATH="{ROOT_BUN_BIN_DIR}:$PATH" && export FLYWHEEL_PROJECT_ROOT="$PWD" && '
        f"bun --conditions=browser {HARNESS_DIR}/src/cli/index.ts "
        f"--headless --allow-persistent-processes --auth-profile {shlex.quote(profile)} "
        f"--auth-snapshot {shlex.quote(auth_snapshot)} {disabled_flags}{deadline_flag}{system_prompt_flag}--task {shlex.quote(instruction)} "
        f"2>&1 | tee {RUN_LOG}; status=${{PIPESTATUS[0]}}; exit \"$status\""
    )
    return f"/bin/bash -o pipefail -c {shlex.quote(script)}"


def _cleanup_install_command(
    stage,
    publish,
    backup,
    final=HARNESS_DIR,
    *,
    lock_path=INSTALL_LOCK,
    owner="root:root",
) -> str:
    paths = (
        stage,
        publish,
        backup,
        final,
        lock_path,
        f"{backup}.publication",
        Path(final) / ".flywheel-install-publication",
    )
    stage_q, publish_q, backup_q, final_q, lock_q, publication_marker_q, final_marker_q = (
        shlex.quote(str(path)) for path in paths
    )
    owner_q = shlex.quote(owner)
    return (
        f"set -eu; umask 077; touch {lock_q}; chown {owner_q} {lock_q}; chmod 600 {lock_q}; "
        f"exec 9<> {lock_q}; flock -x 9; restore=1; "
        f"if test -e {backup_q} || test -L {backup_q}; then "
        f"if (test -e {publication_marker_q} || test -L {publication_marker_q}) "
        f"&& (test -e {final_q} || test -L {final_q}); then restore=0; "
        f"if test -f {publication_marker_q} && test -f {final_marker_q} "
        f"&& cmp -s {publication_marker_q} {final_marker_q}; then restore=1; fi; fi; "
        f"if test \"$restore\" -eq 1; then rm -rf -- {final_q}; mv -- {backup_q} {final_q}; "
        f"else rm -rf -- {backup_q}; fi; fi; "
        f"rm -rf -- {stage_q} {publish_q} {backup_q} {publication_marker_q}"
    )


def _install_transaction_command(
    stage,
    publish,
    backup,
    digest: str,
    *,
    final=HARNESS_DIR,
    bun_dir=ROOT_BUN_DIR,
    lock_path=INSTALL_LOCK,
    release_base_url=BUN_RELEASE_BASE_URL,
    release_assets=BUN_RELEASE_ASSETS,
    owner="root:root",
    bun_download_cache: str | None = None,
    fail_after_final_move: bool = False,
) -> str:
    paths = (
        stage,
        publish,
        backup,
        final,
        lock_path,
        f"{backup}.publication",
        Path(final) / ".flywheel-install-publication",
    )
    stage_q, publish_q, backup_q, final_q, lock_q, publication_marker_q, final_marker_q = (
        shlex.quote(str(path)) for path in paths
    )
    publish_marker_q = shlex.quote(str(Path(publish) / ".flywheel-install-publication"))
    bun_bin_dir_q = shlex.quote(str(Path(bun_dir) / "bin"))
    bun_work_q = shlex.quote(f"{publish}.bun")
    owner_q = shlex.quote(owner)
    digest_q = shlex.quote(digest)
    architecture_cases = []
    for architecture, (asset, asset_digest) in release_assets.items():
        architecture_cases.append(
            f"{shlex.quote(architecture)}) asset={shlex.quote(asset)}; "
            f"asset_sha256={shlex.quote(asset_digest)} ;;"
        )
    architecture_case = " ".join(architecture_cases)
    release_url_q = shlex.quote(release_base_url.rstrip("/"))
    failure_seam = "false; " if fail_after_final_move else ""
    if bun_download_cache is None:
        bun_download = f'curl -fsSL --retry 3 --connect-timeout 30 --max-time 120 "{release_url_q}/$asset" -o {bun_work_q}/bun.zip; '
    else:
        cache_q = shlex.quote(bun_download_cache)
        bun_download = (
            f"install -d -m 700 {cache_q}/$architecture; cache_zip={cache_q}/$architecture/$asset_sha256.zip; "
            f"cache_lock={cache_q}/$architecture/$asset_sha256.lock; touch \"$cache_lock\"; chmod 600 \"$cache_lock\"; "
            f"exec 8<>\"$cache_lock\"; flock -x 8; "
            f"if ! test -f \"$cache_zip\" || ! printf '%s  %s\\n' \"$asset_sha256\" \"$cache_zip\" | sha256sum -c -; then "
            f"cache_stage={cache_q}/$architecture/.$asset_sha256.$$.zip; "
            f"curl -fsSL --retry 3 --connect-timeout 30 --max-time 120 \"{release_url_q}/$asset\" -o \"$cache_stage\"; "
            f"printf '%s  %s\\n' \"$asset_sha256\" \"$cache_stage\" | sha256sum -c -; chmod 400 \"$cache_stage\"; "
            f"mv -- \"$cache_stage\" \"$cache_zip\"; fi; cp -- \"$cache_zip\" {bun_work_q}/bun.zip; "
        )
    return (
        f"set -eu; umask 077; touch {lock_q}; chown {owner_q} {lock_q}; chmod 600 {lock_q}; "
        f"exec 9<> {lock_q}; flock -x 9; committed=0; publication_started=0; "
        f"cleanup() {{ status=$?; trap - EXIT HUP INT TERM; "
        f"if test \"$committed\" -ne 1 && test \"$publication_started\" -eq 1; then "
        f"rm -rf -- {final_q}; "
        f"if test -e {backup_q} || test -L {backup_q}; then mv -- {backup_q} {final_q}; fi; fi; "
        f"rm -rf -- {stage_q} {publish_q} {bun_work_q} {publication_marker_q}; exit \"$status\"; }}; "
        f"trap cleanup EXIT HUP INT TERM; "
        f"case \"$(uname -m)\" in {architecture_case} *) printf 'Unsupported Bun architecture: %s\\n' \"$(uname -m)\" >&2; exit 1 ;; esac; "
        f"rm -rf -- {publish_q} {backup_q} {bun_work_q} {publication_marker_q}; mkdir -m 700 -- {publish_q} {bun_work_q}; "
        + bun_download
        + f"printf '%s  bun.zip\\n' \"$asset_sha256\" | (cd {bun_work_q} && sha256sum -c -); "
        f"unzip -q {bun_work_q}/bun.zip -d {bun_work_q}/unpacked; "
        f"install -d -m 755 {bun_bin_dir_q}; install -m 755 {bun_work_q}/unpacked/${{asset%.zip}}/bun {bun_work_q}/bun; "
        f"mv -- {bun_work_q}/bun {bun_bin_dir_q}/bun; "
        f"chown -R {owner_q} {stage_q}; cp {stage_q}/harness.tar.gz {publish_q}/harness.tar.gz; "
        f"chmod 400 {publish_q}/harness.tar.gz; printf '%s  harness.tar.gz\\n' {digest_q} | (cd {publish_q} && sha256sum -c -); "
        f"tar xzf {publish_q}/harness.tar.gz -C {publish_q}; rm -- {publish_q}/harness.tar.gz; "
        f"cd {publish_q}; PATH={bun_bin_dir_q}:$PATH bun install --frozen-lockfile --ignore-scripts; "
        f"chown -R {owner_q} {publish_q}; chmod -R u=rwX,go=rX {publish_q}; "
        f"printf '%s\n' {backup_q} > {publication_marker_q}; cp -- {publication_marker_q} {publish_marker_q}; "
        f"chmod 600 {publication_marker_q} {publish_marker_q}; publication_started=1; "
        f"if test -e {final_q} || test -L {final_q}; then mv -- {final_q} {backup_q}; fi; "
        f"mv -- {publish_q} {final_q};"
        f"{failure_seam}committed=1; rm -rf -- {backup_q} {publication_marker_q} {final_marker_q}; "
        f"trap - EXIT HUP INT TERM; rm -rf -- {stage_q} {bun_work_q}"
    )


class FlywheelHeadless(BaseInstalledAgent):
    SUPPORTS_ATIF: bool = False
    _source_archive_sha256: str | None = None
    _harness_staging_dir: str | None = None

    dataset: str | None = None

    def __init__(self, *args, dataset: str | None = None, flywheel_model: str | None = None, bun_download_cache: str | None = None, runtime_source_commit: str | None = None, profile_sha256: str | None = None, project_root_mode: str = "task_workspace", evidence_export: str = "settled_sqlite", persistent_processes: bool = True, flywheel_config_path: str | None = None, flywheel_config_sha256: str | None = None, trial_auth_profile: str | None = None, credential_providers: list[str] | None = None, **kwargs):
        super().__init__(*args, **kwargs)
        self.dataset = dataset
        if flywheel_model is not None and (not isinstance(flywheel_model, str) or not flywheel_model or flywheel_model.strip() != flywheel_model):
            raise ValueError("Flywheel model must be a non-empty canonical model name")
        self.flywheel_model = flywheel_model
        # The launcher validated the config, read its pinned chat model, and
        # named the profile id that its profile tables use; the trial takes all three together.
        config_kwargs = (flywheel_config_path, flywheel_config_sha256, trial_auth_profile)
        if any(value is not None for value in config_kwargs):
            if not isinstance(flywheel_config_path, str) or not Path(flywheel_config_path).is_absolute() or not isinstance(flywheel_config_sha256, str) or not PROFILE_SHA256_PATTERN.fullmatch(flywheel_config_sha256):
                raise ValueError("flywheel_config_path must be absolute and flywheel_config_sha256 exactly 64 lowercase hexadecimal characters")
            if not isinstance(trial_auth_profile, str) or not re.fullmatch(r"[a-z][a-z0-9-]*", trial_auth_profile):
                raise ValueError("trial_auth_profile must be a lowercase profile id")
            if flywheel_model is not None:
                raise ValueError("the Flywheel config pins the chat model; flywheel_model must be absent")
            if not isinstance(credential_providers, list) or not credential_providers or not all(isinstance(provider, str) and re.fullmatch(r"[a-z][a-z0-9_]*", provider) for provider in credential_providers):
                raise ValueError("credential_providers must list the config's credential provider ids")
        self.flywheel_config_path = flywheel_config_path
        self.flywheel_config_sha256 = flywheel_config_sha256
        self.trial_auth_profile = trial_auth_profile
        self.credential_providers = tuple(credential_providers or ())
        if profile_sha256 is not None and (not isinstance(profile_sha256, str) or not PROFILE_SHA256_PATTERN.fullmatch(profile_sha256)):
            raise ValueError("profile_sha256 must be exactly 64 lowercase hexadecimal characters")
        self.profile_sha256 = profile_sha256
        self._machine_summary = None
        if project_root_mode != "task_workspace" or evidence_export != "settled_sqlite" or persistent_processes is not True:
            raise ValueError("Terminal-Bench execution contract requires task workspace project root, settled SQLite export, and enabled persistence")
        if bun_download_cache not in (None, BUN_DOWNLOAD_CACHE):
            raise ValueError(f"Bun download cache must be {BUN_DOWNLOAD_CACHE}")
        self.bun_download_cache = bun_download_cache
        self.runtime_source_commit = None if runtime_source_commit is None else _resolve_runtime_source_commit(runtime_source_commit)
    @staticmethod
    def name() -> str:
        return "flywheel-headless"

    def get_version_command(self) -> str | None:
        return None

    async def install(self, environment: BaseEnvironment) -> None:
        token = secrets.token_hex(16)
        self._harness_staging_dir = f"{HARNESS_STAGING_PREFIX}{token}"
        self._source_archive_sha256 = None
        publish_dir = f"{Path(HARNESS_DIR).parent}/.flywheel-harness-{token}"
        backup_dir = f"{Path(HARNESS_DIR).parent}/.flywheel-harness-backup-{token}"
        cleanup_command = _cleanup_install_command(
            self._harness_staging_dir, publish_dir, backup_dir
        )
        try:
            bootstrap = await self.exec_as_root(
                environment,
                command=BOOTSTRAP_PROBE_COMMAND,
                timeout_sec=30,
            )
            if (bootstrap.stdout or "").strip() != "ready":
                await self.exec_as_root(
                    environment,
                    command=APT_BOOTSTRAP_COMMAND,
                    env={"DEBIAN_FRONTEND": "noninteractive"},
                    timeout_sec=300,
                )

            await self._upload_harness(environment)
            digest = self._source_archive_sha256
            if digest is None or not SOURCE_ARCHIVE_SHA256_PATTERN.fullmatch(digest):
                raise RuntimeError("Flywheel source archive identity is unavailable after upload")

            await self.exec_as_root(
                environment,
                command=_install_transaction_command(
                    self._harness_staging_dir,
                    publish_dir,
                    backup_dir,
                    digest,
                    bun_download_cache=self.bun_download_cache,
                ),
                timeout_sec=600,
            )
        finally:
            await self.exec_as_root(environment, command=cleanup_command)

    async def _upload_harness(self, environment: BaseEnvironment) -> None:
        """Upload the job's exact harness archive into a private staging directory."""
        snapshot_path, digest = await asyncio.to_thread(
            _prepare_trial_snapshot, getattr(self, "logs_dir", None), self.runtime_source_commit
        )
        self._source_archive_sha256 = digest
        if self._harness_staging_dir is None:
            self._harness_staging_dir = f"{HARNESS_STAGING_PREFIX}{secrets.token_hex(16)}"
        stage = shlex.quote(self._harness_staging_dir)
        await self.exec_as_agent(
            environment,
            command=f"umask 077 && rm -rf -- {stage} && mkdir -m 700 -- {stage}",
        )
        await environment.upload_file(str(snapshot_path), f"{self._harness_staging_dir}/harness.tar.gz")
        # Root verifies these bytes before extraction and dependency installation.

    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        if self._source_archive_sha256 is None:
            raise RuntimeError("Flywheel source archive identity is unavailable; install must complete before run")
        if not SOURCE_ARCHIVE_SHA256_PATTERN.fullmatch(self._source_archive_sha256):
            raise RuntimeError("Flywheel source archive identity must be exactly 64 lowercase hexadecimal characters")
        started = time.monotonic()
        logs_value = getattr(self, "logs_dir", None)
        logs_dir = Path(logs_value) if logs_value is not None else None
        authority = _resolve_deadline_authority(logs_dir, self.dataset) if logs_dir else DeadlineAuthority(None, None, "deadline-blind:logs-directory-unavailable")
        deadline_at = None if authority.cap_seconds is None else started + authority.cap_seconds
        token = secrets.token_hex(16)
        auth_stage = f"{AUTH_BUNDLE_STAGE_PREFIX}{token}"
        auth_file = f"{auth_stage}/auth.json"
        config_file = f"{auth_stage}/flywheel.toml"
        quoted_file = shlex.quote(auth_file)
        quoted_config = shlex.quote(config_file)
        isolated_home = f"{ISOLATED_HOME_PREFIX}{token}"
        quoted_stage = shlex.quote(auth_stage)
        quoted_home = shlex.quote(isolated_home)
        settlement = AdapterSettlement("other-failure", False)
        primary_error = None
        project_root = None
        evidence_publication = None
        try:
            async with asyncio.timeout_at(deadline_at):
                selector = _require_auth_profile_selector(os.environ.get(AUTH_PROFILE_ENV))
                disabled_tools = _require_disabled_tools(os.environ.get(DISABLED_TOOLS_ENV))
                system_prompt = _read_system_prompt_payload(os.environ.get(SYSTEM_PROMPT_PATH_ENV), os.environ.get(SYSTEM_PROMPT_SHA256_ENV))
                flywheel_config = None if self.flywheel_config_path is None else _read_flywheel_config(self.flywheel_config_path, self.flywheel_config_sha256)
                await self.exec_as_root(
                    environment,
                    command=f"umask 077 && rm -rf -- {quoted_stage} && mkdir -m 700 -- {quoted_stage}",
                )
                with tempfile.TemporaryDirectory(prefix="flywheel-auth-bundle-") as local_stage:
                    local_file = Path(local_stage) / "auth.json"
                    export_remaining = None if deadline_at is None else deadline_at - time.monotonic()
                    exported_profile = await _export_auth_snapshot(selector, local_file, export_remaining, self.runtime_source_commit, as_profile=self.trial_auth_profile, providers=self.credential_providers)
                    profile = self.trial_auth_profile or exported_profile
                    quoted_profile = shlex.quote(profile)
                    await environment.upload_file(str(local_file), auth_file)
                    if flywheel_config is not None:
                        local_config = Path(local_stage) / "flywheel.toml"
                        local_config.write_bytes(flywheel_config)
                        local_config.chmod(0o600)
                        await environment.upload_file(str(local_config), config_file)
                configured_user = getattr(environment, "default_user", None)
                if configured_user is None:
                    owner_result = await self.exec_as_agent(
                        environment,
                        command="printf '%s:%s' \"$(id -u)\" \"$(id -g)\"",
                    )
                    owner = (owner_result.stdout or "").strip()
                    if not AGENT_OWNER_PATTERN.fullmatch(owner):
                        raise RuntimeError("Harbor agent user identity is unavailable")
                else:
                    owner = str(configured_user)
                quoted_owner = shlex.quote(owner)
                await self.exec_as_agent(
                    environment,
                    command=(
                        f"umask 077 && rm -rf -- {quoted_home} && mkdir -m 700 -- {quoted_home} "
                        f"&& mkdir -p -m 700 -- {quoted_home}/.flywheel/auth/profiles/{quoted_profile}"
                    ),
                )

                staged_files = (quoted_file,) if flywheel_config is None else (quoted_file, quoted_config)
                await self.exec_as_root(
                    environment,
                    command="set -eu; " + "".join(
                        f"test -f {path}; ! test -L {path}; "
                        f"test \"$(stat -c '%h' -- {path})\" -eq 1; chmod 600 -- {path}; "
                        for path in staged_files
                    ) + f"chown {quoted_owner} -- {' '.join(staged_files)} {quoted_stage}",
                )
                if flywheel_config is not None:
                    await self.exec_as_agent(
                        environment,
                        command=f"umask 077 && cp -- {quoted_config} {quoted_home}/.flywheel/flywheel.toml",
                    )
                root_result = await self.exec_as_root(environment, command="pwd -P")
                project_root = (root_result.stdout or "").strip()
                if not project_root.startswith("/") or "\n" in project_root or "\x00" in project_root:
                    raise RuntimeError("Harbor task workspace identity is unavailable")
                remaining = None if deadline_at is None else deadline_at - time.monotonic()
                if remaining is not None and remaining <= 0:
                    raise TimeoutError("Flywheel task deadline expired during adapter preparation")
                graceful_deadline = None if remaining is None else max(1, int(remaining - 105))
                command = build_task_command(instruction, profile, auth_file, disabled_tools, graceful_deadline, system_prompt)
                env = {
                    "HOME": isolated_home,
                    "PATH": f"{ROOT_BUN_BIN_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                    "BASH_ENV": "/dev/null",
                    "ENV": "/dev/null",
                    "SHELL": "/bin/bash",
                    "FLYWHEEL_SOURCE_ARCHIVE_SHA256": self._source_archive_sha256,
                }
                if os.environ.get("FLYWHEEL_TOOL_LIFECYCLE_TRACE") == "1":
                    env["FLYWHEEL_TOOL_LIFECYCLE_TRACE"] = "1"
                # A Flywheel config is the one source of the chat model and effort;
                # an environment override would outrank it.
                if flywheel_config is None:
                    env["FLYWHEEL_CHAT_EFFORT"] = os.environ.get("FLYWHEEL_CHAT_EFFORT", "max")
                    if self.flywheel_model:
                        env["FLYWHEEL_CHAT_MODEL"] = self.flywheel_model
                env = {key: value for key, value in env.items() if value}
                exec_kwargs = {"command": command, "env": env}
                if remaining is not None:
                    exec_kwargs["timeout_sec"] = remaining
                try:
                    await self.exec_as_agent(environment, **exec_kwargs)
                    self._machine_summary = _latest_machine_summary(logs_dir / "flywheel.txt") if logs_dir else None
                    summary = self._machine_summary
                    kind = "flywheel-deadline" if _deadline_fired(summary) else "normal"
                    settlement = AdapterSettlement(kind, False)
                except asyncio.CancelledError:
                    settlement = AdapterSettlement("harbor-cancellation", True)
                    raise
                except BaseException as error:
                    if isinstance(error, (asyncio.TimeoutError, TimeoutError)) or type(error).__name__ == "AgentTimeoutError":
                        settlement = AdapterSettlement("adapter-timeout", True)
                    raise
        except asyncio.CancelledError as error:
            primary_error = error
            settlement = AdapterSettlement("harbor-cancellation", True)
            raise
        except BaseException as error:
            primary_error = error
            if isinstance(error, (asyncio.TimeoutError, TimeoutError)):
                settlement = AdapterSettlement("adapter-timeout", True)
            raise
        finally:
            secondary_errors = []
            if project_root is not None:
                export_cancellation, export_error, export_result = await _settle_remote_cleanup(
                    self.exec_as_root(environment, command=_evidence_export_command(project_root))
                )
                if export_error is None and export_cancellation is None:
                    try:
                        publication = json.loads((export_result.stdout or "").strip())
                        evidence_publication = EvidencePublication(publication["sha256"], publication["size"])
                        if not isinstance(publication["sha256"], str) or not PROFILE_SHA256_PATTERN.fullmatch(publication["sha256"]) or not isinstance(publication["size"], int) or publication["size"] <= 0:
                            raise ValueError("invalid evidence publication identity")
                    except (AttributeError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
                        secondary_errors.append(("Settled evidence export", RuntimeError("evidence publication identity is invalid")))
                else:
                    secondary_errors.append(("Settled evidence export", export_error or export_cancellation))
            cleanup_command = f"rm -rf -- {quoted_stage} {quoted_home}"
            cleanup_cancellation, cleanup_error, _ = await _settle_remote_cleanup(
                _cleanup_remote_paths(self, environment, cleanup_command)
            )
            if cleanup_error is not None:
                secondary_errors.append(("Benchmark auth cleanup", cleanup_error))
            cancellation_after_success = cleanup_cancellation if primary_error is None else None
            if cancellation_after_success is not None:
                primary_error = cancellation_after_success
                settlement = AdapterSettlement("harbor-cancellation", True)
            elif cleanup_cancellation is not None and not isinstance(primary_error, asyncio.CancelledError):
                primary_error.add_note("Cancellation was deferred until benchmark auth cleanup settled")
            if logs_dir is not None:
                try:
                    _write_run_summary(
                        logs_dir,
                        settlement,
                        authority,
                        self.profile_sha256,
                        self._source_archive_sha256,
                        machine_summary=self._machine_summary,
                        project_root=project_root,
                        evidence_publication=evidence_publication,
                    )
                except BaseException as error:
                    secondary_errors.append(("Run summary publication", error))
            if primary_error is None and len(secondary_errors) == 1:
                raise secondary_errors[0][1]
            if primary_error is None and secondary_errors:
                raise BaseExceptionGroup("Terminal-Bench finalization failed", [error for _, error in secondary_errors])
            for label, error in secondary_errors:
                primary_error.add_note(f"{label} also failed: {type(error).__name__}: {error}")
            if cancellation_after_success is not None:
                raise cancellation_after_success

    def populate_context_post_run(self, context: AgentContext) -> None:
        summary = self._machine_summary
        if summary is None or not isinstance(summary.get("usage"), dict):
            return
        usage = summary["usage"]
        cost = usage.get("costUsd")
        if isinstance(cost, (int, float)):
            context.cost_usd = float(cost)
        n_input = usage.get("inputTokens")
        n_cache = usage.get("cacheReadTokens")
        n_output = usage.get("outputTokens")
        if isinstance(n_input, int) and isinstance(n_cache, int):
            context.n_input_tokens = n_input + n_cache
            context.n_cache_tokens = n_cache
        if isinstance(n_output, int):
            context.n_output_tokens = n_output
