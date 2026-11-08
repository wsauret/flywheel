"""What a Flywheel Terminal-Bench trial runs on and records.

The ACP shim (shim.py beside this file) installs this pinned Bun release,
publishes snapshots of the running trial's store and diagnostic logs as debug
evidence, exports the trial's settled event store, publishes it and the logs
over the last snapshot, and writes the versioned run summary that
finalization reads, in a local Docker trial and on Harbor Hub alike. This
module uses only the standard library, because the package ships it without
Harbor.
"""

import hashlib
import json
import os
import secrets
import shutil
import sqlite3
import stat
import tempfile
from contextlib import ExitStack
from dataclasses import dataclass
from pathlib import Path

BUN_VERSION = "1.4.4"
BUN_RELEASE_BASE_URL = f"https://github.com/oven-sh/bun/releases/download/bun-v{BUN_VERSION}"
BUN_NPM_BASE_URL = "https://registry.npmjs.org/@oven"
# Each architecture's Bun ships twice: a GitHub release zip and an npm package
# tarball. The npm copy is the fallback when GitHub release downloads fail,
# which trial sandboxes see as runs of 504s. Each digest pins its own archive.
BUN_RELEASE_ASSETS = {
    "x86_64": (
        "bun-linux-x64.zip",
        "bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c",
        "93ca5a2abe45f3bcac6dd55baff8bb06c4ac824b70f89650b54e5c8b80dbef18",
    ),
    "aarch64": (
        "bun-linux-aarch64.zip",
        "baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e",
        "ab95e7e692a53d25a1baa98ee395a17f5f264aedfb3cb15811432d54142f70eb",
    ),
}


RUN_SUMMARY_NAME = "flywheel-run-summary.json"
# The agent-log directory that holds the trial's store and diagnostic logs in
# the layout of a project root, for `flywheel events search --project-root`.
EVIDENCE_DIR_NAME = "flywheel-evidence"


_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
# Marks the partial copy that an evidence publication renames over its file.
_PARTIAL_INFIX = ".partial-"
_DIRECTORY_FLAGS = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | _NOFOLLOW


@dataclass(frozen=True)
class DeadlineAuthority:
    cap_seconds: float | None
    task_digest: str | None
    provenance: str


@dataclass(frozen=True)
class AdapterSettlement:
    kind: str
    captured_after_cancellation: bool


@dataclass(frozen=True)
class EvidencePublication:
    sha256: str
    size: int


def _open_absolute_path(path: Path, final_flags: int, mode: int = 0o600) -> int:
    if not path.is_absolute() or ".." in path.parts or len(path.parts) < 2:
        raise RuntimeError(f"Flywheel source archive path is unsafe: {path}")
    parent_descriptor = os.open(path.anchor, _DIRECTORY_FLAGS)
    try:
        for component in path.parts[1:-1]:
            next_descriptor = os.open(component, _DIRECTORY_FLAGS, dir_fd=parent_descriptor)
            os.close(parent_descriptor)
            parent_descriptor = next_descriptor
        return os.open(path.name, final_flags | _NOFOLLOW, mode, dir_fd=parent_descriptor)
    except OSError as error:
        raise RuntimeError(f"Flywheel source archive path is unsafe: {path}") from error
    finally:
        os.close(parent_descriptor)


def _open_owned_regular_at(
    directory_descriptor: int,
    name: str,
    flags: int,
    mode: int = 0o600,
    *,
    require_safe_mode: bool = True,
    require_single_link: bool = True,
) -> int:
    try:
        descriptor = os.open(name, flags | _NOFOLLOW, mode, dir_fd=directory_descriptor)
    except FileNotFoundError:
        raise
    except OSError as error:
        raise RuntimeError(f"Flywheel source archive file is unsafe: {name}") from error
    file_stat = os.fstat(descriptor)
    if (
        not stat.S_ISREG(file_stat.st_mode)
        or file_stat.st_uid != os.getuid()
        or (require_safe_mode and file_stat.st_mode & 0o022)
        or (require_single_link and file_stat.st_nlink != 1)
    ):
        os.close(descriptor)
        raise RuntimeError(
            f"Flywheel source archive file has an unsafe type, owner, mode, or link identity: {name}"
        )
    return descriptor


def _write_run_summary(
    logs_dir: Path,
    settlement: AdapterSettlement,
    authority: DeadlineAuthority,
    profile_sha256: str | None = None,
    source_archive_sha256: str | None = None,
    *,
    project_root: str | None = None,
    evidence_publication: EvidencePublication | None = None,
    evidence_withheld: str | None = None,
    debug_evidence: dict | None = None,
) -> dict:
    """Publish the trial's versioned run summary into the agent logs directory.

    `evidence_withheld` names why a driver recorded no store analysis;
    finalization then sees an unexported store and refuses the trial as
    unverified. `debug_evidence` is the outcome of `publish_debug_evidence`, or
    `{"failed": <reason>}` when that publication did not complete; it never
    changes how finalization judges the trial.
    """
    evidence = {
        "version": 2,
        "adapter_settlement": settlement.kind,
        "captured_after_cancellation": settlement.captured_after_cancellation,
        "deadline_authority": {
            "provenance": authority.provenance,
            "task_digest": authority.task_digest,
            "cap_seconds": authority.cap_seconds,
        },
        "project_root": project_root,
        "execution_cwd": project_root,
        "evidence_exported": evidence_publication is not None,
        "profile_sha256": profile_sha256,
        "source_archive_sha256": source_archive_sha256,
        "evidence_sha256": evidence_publication.sha256 if evidence_publication else None,
        "evidence_size": evidence_publication.size if evidence_publication else None,
    }
    if evidence_withheld is not None:
        evidence["evidence_withheld"] = evidence_withheld
    if debug_evidence is not None:
        evidence["debug_evidence"] = debug_evidence
    destination = logs_dir / RUN_SUMMARY_NAME
    temporary = logs_dir / f".{RUN_SUMMARY_NAME}.{secrets.token_hex(8)}"
    try:
        temporary.write_text(json.dumps(evidence, sort_keys=True) + "\n")
        os.replace(temporary, destination)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
    return evidence


def _sha256_descriptor(descriptor: int) -> str:
    digest = hashlib.sha256()
    os.lseek(descriptor, 0, os.SEEK_SET)
    while chunk := os.read(descriptor, 1024 * 1024):
        digest.update(chunk)
    os.lseek(descriptor, 0, os.SEEK_SET)
    return digest.hexdigest()


def _copy_descriptor(source: int, destination: Path) -> str:
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | _NOFOLLOW, 0o600)
    digest = hashlib.sha256()
    try:
        os.lseek(source, 0, os.SEEK_SET)
        while chunk := os.read(source, 1024 * 1024):
            digest.update(chunk)
            view = memoryview(chunk)
            while view:
                written = os.write(descriptor, view)
                view = view[written:]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
        os.lseek(source, 0, os.SEEK_SET)
    return digest.hexdigest()


def _open_evidence_source_regular_at(
    directory_descriptor: int, name: str, expected_owner: int
) -> int:
    try:
        # O_NONBLOCK: a FIFO planted under a source name must not block the open before its type is checked.
        descriptor = os.open(name, os.O_RDONLY | os.O_NONBLOCK | _NOFOLLOW, dir_fd=directory_descriptor)
    except FileNotFoundError:
        raise
    except OSError as error:
        raise RuntimeError(f"Flywheel evidence source file is unsafe: {name}") from error
    file_stat = os.fstat(descriptor)
    if (
        not stat.S_ISREG(file_stat.st_mode)
        or file_stat.st_uid != expected_owner
        or file_stat.st_mode & 0o022
        or file_stat.st_nlink != 1
    ):
        os.close(descriptor)
        raise RuntimeError(f"Flywheel evidence source file is unsafe: {name}")
    return descriptor


def _backup_sqlite(source_path: Path, destination_path: Path) -> None:
    source = sqlite3.connect(f"file:{source_path}?mode=ro", uri=True)
    destination = sqlite3.connect(destination_path)
    try:
        source.backup(destination)
        destination.commit()
    finally:
        destination.close()
        source.close()


def _export_settled_sqlite(project_root: Path, evidence_dir: Path) -> EvidencePublication:
    project_descriptor = None
    source_directory_descriptor = None
    source_descriptor = None
    sidecar_descriptors: dict[str, tuple[int, os.stat_result]] = {}
    try:
        project_descriptor = _open_absolute_path(project_root, _DIRECTORY_FLAGS)
        source_directory_descriptor = os.open(".flywheel", _DIRECTORY_FLAGS, dir_fd=project_descriptor)
        directory_stat = os.fstat(source_directory_descriptor)
        if not stat.S_ISDIR(directory_stat.st_mode) or directory_stat.st_mode & 0o022:
            raise RuntimeError("Flywheel evidence source directory is unsafe")
        try:
            source_descriptor = _open_evidence_source_regular_at(
                source_directory_descriptor,
                "flywheel.sqlite",
                directory_stat.st_uid,
            )
        except FileNotFoundError as error:
            raise RuntimeError("Flywheel evidence source database is missing") from error
        source_stat = os.fstat(source_descriptor)
        source_owner = source_stat.st_uid
        for suffix in ("-wal", "-shm"):
            name = f"flywheel.sqlite{suffix}"
            try:
                descriptor = _open_evidence_source_regular_at(
                    source_directory_descriptor,
                    name,
                    source_owner,
                )
            except FileNotFoundError:
                continue
            sidecar_stat = os.fstat(descriptor)
            if sidecar_stat.st_uid != source_owner:
                os.close(descriptor)
                raise RuntimeError(f"Flywheel evidence sidecar owner is unsafe: {name}")
            sidecar_descriptors[name] = (descriptor, sidecar_stat)
    except BaseException as error:
        for descriptor, _ in sidecar_descriptors.values():
            os.close(descriptor)
        if source_descriptor is not None:
            os.close(source_descriptor)
        if source_directory_descriptor is not None:
            os.close(source_directory_descriptor)
        if project_descriptor is not None:
            os.close(project_descriptor)
        if isinstance(error, RuntimeError):
            if "flywheel.sqlite-" in str(error):
                raise RuntimeError("Flywheel evidence sidecar is unsafe") from error
            raise
        raise RuntimeError("Flywheel evidence source path is unsafe") from error
    before_digest = _sha256_descriptor(source_descriptor)
    destination_descriptor = None
    temporary_name = f".flywheel.sqlite.{secrets.token_hex(16)}"
    try:
        evidence_stat = evidence_dir.lstat()
        if not stat.S_ISDIR(evidence_stat.st_mode) or evidence_stat.st_uid != os.getuid() or evidence_stat.st_mode & 0o022:
            raise RuntimeError("Flywheel evidence destination directory is unsafe")
        flywheel_dir = evidence_dir / ".flywheel"
        try:
            flywheel_dir.mkdir(mode=0o700)
        except FileExistsError:
            pass
        flywheel_stat = flywheel_dir.lstat()
        if not stat.S_ISDIR(flywheel_stat.st_mode) or flywheel_stat.st_uid != os.getuid() or stat.S_IMODE(flywheel_stat.st_mode) != 0o700:
            raise RuntimeError("Flywheel evidence destination directory is unsafe")
        directory_descriptor = os.open(flywheel_dir, _DIRECTORY_FLAGS)
        try:
            if (flywheel_dir / "flywheel.sqlite").exists() or (flywheel_dir / "flywheel.sqlite").is_symlink():
                raise RuntimeError("Flywheel evidence destination already exists")
            destination_descriptor = _open_owned_regular_at(
                directory_descriptor,
                temporary_name,
                os.O_RDWR | os.O_CREAT | os.O_EXCL,
            )
            private_root = Path(tempfile.mkdtemp(prefix="flywheel-evidence-"))
            try:
                os.chmod(private_root, 0o700)
                pinned_digests = {"flywheel.sqlite": _copy_descriptor(source_descriptor, private_root / "flywheel.sqlite")}
                for name, (descriptor, _) in sidecar_descriptors.items():
                    pinned_digests[name] = _copy_descriptor(descriptor, private_root / name)
                if pinned_digests["flywheel.sqlite"] != before_digest:
                    raise RuntimeError("Flywheel evidence source content changed during private copy")
                for name, (descriptor, _) in sidecar_descriptors.items():
                    if _sha256_descriptor(descriptor) != pinned_digests[name]:
                        raise RuntimeError(f"Flywheel evidence sidecar content changed during private copy: {name}")
                _backup_sqlite(private_root / "flywheel.sqlite", flywheel_dir / temporary_name)
            finally:
                shutil.rmtree(private_root, ignore_errors=True)
            destination_stat = os.fstat(destination_descriptor)
            digest = _sha256_descriptor(destination_descriptor)
            if destination_stat.st_uid != os.getuid() or stat.S_IMODE(destination_stat.st_mode) != 0o600 or destination_stat.st_nlink != 1:
                raise RuntimeError("Flywheel evidence temporary file identity changed")
            after_stat = os.fstat(source_descriptor)
            if (source_stat.st_dev, source_stat.st_ino, source_stat.st_mode, source_stat.st_uid, source_stat.st_nlink, source_stat.st_size, source_stat.st_mtime_ns, source_stat.st_ctime_ns, before_digest) != (
                after_stat.st_dev,
                after_stat.st_ino,
                after_stat.st_mode,
                after_stat.st_uid,
                after_stat.st_nlink,
                after_stat.st_size,
                after_stat.st_mtime_ns,
                after_stat.st_ctime_ns,
                _sha256_descriptor(source_descriptor),
            ):
                raise RuntimeError("Flywheel evidence source identity or content changed during export")
            current_source = _open_evidence_source_regular_at(source_directory_descriptor, "flywheel.sqlite", source_owner)
            try:
                current_stat = os.fstat(current_source)
                if (current_stat.st_dev, current_stat.st_ino) != (source_stat.st_dev, source_stat.st_ino):
                    raise RuntimeError("Flywheel evidence source pathname identity changed during export")
            finally:
                os.close(current_source)
            current_directory = os.open(".flywheel", _DIRECTORY_FLAGS, dir_fd=project_descriptor)
            try:
                current_directory_stat = os.fstat(current_directory)
                if (current_directory_stat.st_dev, current_directory_stat.st_ino) != (directory_stat.st_dev, directory_stat.st_ino):
                    raise RuntimeError("Flywheel evidence source directory identity changed during export")
            finally:
                os.close(current_directory)
            current_project = _open_absolute_path(project_root, _DIRECTORY_FLAGS)
            try:
                current_project_stat = os.fstat(current_project)
                project_stat = os.fstat(project_descriptor)
                if (current_project_stat.st_dev, current_project_stat.st_ino) != (project_stat.st_dev, project_stat.st_ino):
                    raise RuntimeError("Flywheel evidence project root identity changed during export")
            finally:
                os.close(current_project)
            for name in ("flywheel.sqlite-wal", "flywheel.sqlite-shm"):
                pinned_sidecar = sidecar_descriptors.get(name)
                if pinned_sidecar is None:
                    try:
                        unexpected_sidecar = _open_evidence_source_regular_at(
                            source_directory_descriptor, name, source_owner
                        )
                    except FileNotFoundError:
                        continue
                    os.close(unexpected_sidecar)
                    raise RuntimeError(f"Flywheel evidence sidecar appeared during export: {name}")
                descriptor, sidecar_stat = pinned_sidecar
                try:
                    current_sidecar = _open_evidence_source_regular_at(
                        source_directory_descriptor, name, source_owner
                    )
                except FileNotFoundError as error:
                    raise RuntimeError(f"Flywheel evidence sidecar disappeared during export: {name}") from error
                try:
                    current_sidecar_stat = os.fstat(current_sidecar)
                    stable_fields = ("st_dev", "st_ino", "st_mode", "st_uid", "st_nlink", "st_size")
                    if name.endswith("-wal"):
                        stable_fields += ("st_mtime_ns", "st_ctime_ns")
                    pinned_stat = os.fstat(descriptor)
                    if tuple(getattr(current_sidecar_stat, field) for field in stable_fields) != tuple(
                        getattr(sidecar_stat, field) for field in stable_fields
                    ) or (pinned_stat.st_dev, pinned_stat.st_ino) != (sidecar_stat.st_dev, sidecar_stat.st_ino):
                        raise RuntimeError(f"Flywheel evidence sidecar identity changed during export: {name}")
                finally:
                    os.close(current_sidecar)
            os.fsync(destination_descriptor)
            os.replace(temporary_name, "flywheel.sqlite", src_dir_fd=directory_descriptor, dst_dir_fd=directory_descriptor)
            os.fsync(directory_descriptor)
            published_descriptor = _open_owned_regular_at(directory_descriptor, "flywheel.sqlite", os.O_RDONLY)
            try:
                published_stat = os.fstat(published_descriptor)
                if _sha256_descriptor(published_descriptor) != digest:
                    raise RuntimeError("Flywheel evidence publication digest mismatch")
                return EvidencePublication(digest, published_stat.st_size)
            finally:
                os.close(published_descriptor)
        finally:
            if destination_descriptor is not None:
                os.close(destination_descriptor)
            try:
                os.unlink(temporary_name, dir_fd=directory_descriptor)
            except FileNotFoundError:
                pass
            os.close(directory_descriptor)
    finally:
        for descriptor, _ in sidecar_descriptors.values():
            os.close(descriptor)
        if source_descriptor is not None:
            os.close(source_descriptor)
        if source_directory_descriptor is not None:
            os.close(source_directory_descriptor)
        if project_descriptor is not None:
            os.close(project_descriptor)


def _read_regular_at(directory_descriptor: int, name: str, owner: int) -> bytes:
    descriptor = _open_evidence_source_regular_at(directory_descriptor, name, owner)
    try:
        chunks = []
        while chunk := os.read(descriptor, 1024 * 1024):
            chunks.append(chunk)
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def _write_new_at(directory_descriptor: int, name: str, content: bytes) -> None:
    descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | _NOFOLLOW, 0o600, dir_fd=directory_descriptor)
    try:
        view = memoryview(content)
        while view:
            view = view[os.write(descriptor, view):]
    finally:
        os.close(descriptor)


def _private_directory_at(parent_descriptor: int, name: str) -> int:
    """Open the directory `name` of `parent_descriptor`, made mode 0700 when it is missing, without following a link; raises unless it is this user's and private."""
    try:
        os.mkdir(name, 0o700, dir_fd=parent_descriptor)
    except FileExistsError:
        pass
    descriptor = os.open(name, _DIRECTORY_FLAGS, dir_fd=parent_descriptor)
    directory_stat = os.fstat(descriptor)
    if directory_stat.st_uid != os.getuid() or stat.S_IMODE(directory_stat.st_mode) != 0o700:
        os.close(descriptor)
        raise RuntimeError(f"Flywheel evidence destination directory is unsafe: {name}")
    return descriptor


def _replace_at(directory_descriptor: int, name: str, content: bytes) -> None:
    partial = f".{name}{_PARTIAL_INFIX}{secrets.token_hex(8)}"
    try:
        _write_new_at(directory_descriptor, partial, content)
        os.replace(partial, name, src_dir_fd=directory_descriptor, dst_dir_fd=directory_descriptor)
    except OSError:
        try:
            os.unlink(partial, dir_fd=directory_descriptor)
        except FileNotFoundError:
            pass
        raise


def _remove_at(directory_descriptor: int, name: str) -> None:
    try:
        if stat.S_ISDIR(os.stat(name, dir_fd=directory_descriptor, follow_symlinks=False).st_mode):
            # rmtree with dir_fd removes the tree through descriptors and never follows a link inside it.
            shutil.rmtree(name, dir_fd=directory_descriptor)
        else:
            os.unlink(name, dir_fd=directory_descriptor)
    except FileNotFoundError:
        pass


def discard_partial_evidence(destination: Path) -> None:
    """Remove the partial copies that a killed or failed publication left in `destination`, and keep its whole files.

    Each directory is opened without following a link. Where a directory is
    missing or is a link, nothing was published through it, so this removes
    nothing there.
    """
    with ExitStack() as descriptors:
        try:
            directory = _open_absolute_path(destination, _DIRECTORY_FLAGS)
            descriptors.callback(os.close, directory)
            for name in (".flywheel", "log"):
                directory = os.open(name, _DIRECTORY_FLAGS, dir_fd=directory)
                descriptors.callback(os.close, directory)
                for entry in os.listdir(directory):
                    if _PARTIAL_INFIX in entry:
                        _remove_at(directory, entry)
        except (OSError, RuntimeError):
            pass


def publish_debug_evidence(store: Path, log_directories: list[Path], destination: Path, credential_values: dict[str, str]) -> dict:
    """Copy the store `store` and every `.jsonl` file of `log_directories` into `destination`, over what an earlier publication left there.

    The copies take the layout of a project root, `.flywheel/flywheel.sqlite`
    and `.flywheel/log/`, so `flywheel events search --project-root
    <destination>` reads them. Each copy replaces its earlier version whole,
    so a reader of `destination` at any moment sees whole files. A source
    that is missing keeps its earlier copy; a source that is withheld loses
    it. `credential_values` maps each credential value of the trial's auth
    snapshot to the kind of field that held it; a file whose bytes hold one
    is not copied. Every source is opened without following links and must be
    a regular, single-link file of its directory's owner that nobody else can
    write. After the copies, every other entry of `destination` is examined
    again without following links: a regular file of this user whose name and
    bytes hold no credential value stays, and every other entry is removed.

    Returns `{"published": [...], "withheld": {...}}`: the relative paths
    copied, and by relative path (or by source directory) why each other
    source was not, `credential:<kind>` or `unsafe_source`, and why each
    removed entry was, `credential:<kind>` or `unsafe_entry`. A source whose
    name holds a credential value is keyed by a numbered placeholder, never
    by its name. Raises when a directory of `destination` is a link or is not
    this user's private directory, so nothing is written through a planted
    link.
    """
    needles = [(value.encode(), kind) for value, kind in credential_values.items()]

    def credential_in(data: bytes) -> str | None:
        return next((kind for value, kind in needles if value in data), None)

    published: list[str] = []
    withheld: dict[str, str] = {}

    def summary_path(prefix: str, name: str) -> tuple[str, str | None]:
        # A name reaches the summary and the evidence tree, so a name that holds a credential is keyed by a placeholder.
        kind = credential_in(os.fsencode(name))
        if kind is None:
            return f"{prefix}{name}", None
        return f"{prefix}<withheld name {len(withheld) + 1}>", f"credential:{kind}"

    with ExitStack() as descriptors:
        def held(descriptor: int) -> int:
            descriptors.callback(os.close, descriptor)
            return descriptor

        parent = held(os.open(destination.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)))
        root = held(_private_directory_at(parent, destination.name))
        flywheel = held(_private_directory_at(root, ".flywheel"))
        log = held(_private_directory_at(flywheel, "log"))
        written: dict[int, set[str]] = {flywheel: set(), log: set()}
        sources = [(store.parent, [store.name], flywheel, ".flywheel/"), *((directory, None, log, ".flywheel/log/") for directory in log_directories)]
        for directory, names, target, prefix in sources:
            try:
                source = held(_open_absolute_path(directory, _DIRECTORY_FLAGS))
            except RuntimeError as error:
                if not isinstance(error.__cause__, FileNotFoundError):
                    withheld[f"{directory}/"] = "unsafe_source"
                continue
            owner = os.fstat(source).st_uid
            for name in names or sorted(entry for entry in os.listdir(source) if entry.endswith(".jsonl")):
                path, reason = summary_path(prefix, name)
                if reason is None:
                    try:
                        content = _read_regular_at(source, name, owner)
                    except FileNotFoundError:
                        continue
                    except RuntimeError:
                        reason = "unsafe_source"
                    else:
                        kind = credential_in(content)
                        reason = None if kind is None else f"credential:{kind}"
                if reason is not None:
                    withheld[path] = reason
                    _remove_at(target, name)
                    continue
                _replace_at(target, name, content)
                written[target].add(name)
                published.append(path)
        # The tree outlives a publication, so each entry that this one did not
        # write is examined again: an earlier copy whose source is now missing,
        # a partial copy that a killed publication left, or an entry that a
        # trial process planted. Only a regular file of this user that passes
        # the credential check stays.
        for directory, prefix, kept in ((root, "", {".flywheel"}), (flywheel, ".flywheel/", {"log", *written[flywheel]}), (log, ".flywheel/log/", written[log])):
            for name in sorted(set(os.listdir(directory)) - kept):
                if _PARTIAL_INFIX not in name:
                    path, reason = summary_path(prefix, name)
                    if reason is None:
                        try:
                            kind = credential_in(_read_regular_at(directory, name, os.getuid()))
                        except FileNotFoundError:
                            continue
                        except RuntimeError:
                            reason = "unsafe_entry"
                        else:
                            if kind is None:
                                continue
                            reason = f"credential:{kind}"
                    withheld[path] = reason
                _remove_at(directory, name)
    return {"published": published, "withheld": withheld}


def snapshot_live_evidence(project_root: Path, log_directories: list[Path], destination: Path, credential_values: dict[str, str]) -> dict:
    """Publish the store and the logs of a trial that still runs into `destination`, as `publish_debug_evidence` does.

    SQLite's online backup copies one committed state of the store at
    `<project_root>/.flywheel/flywheel.sqlite`, its WAL included, while
    Flywheel still writes it, into a private directory, and that copy is
    published. The pinned-descriptor checks of `_export_settled_sqlite` hold
    only for a store that no longer changes, so a snapshot is debug evidence
    and never the store that an analysis judges. Before Flywheel makes its
    store, a snapshot publishes the logs only.
    """
    private = Path(tempfile.mkdtemp(prefix="flywheel-snapshot-")).resolve()
    try:
        store = private / "flywheel.sqlite"
        try:
            source_directory = _open_absolute_path(project_root / ".flywheel", _DIRECTORY_FLAGS)
        except RuntimeError as error:
            if not isinstance(error.__cause__, FileNotFoundError):
                raise
        else:
            try:
                # The backup opens the store by name, so the name is checked first as an export checks it.
                os.close(_open_evidence_source_regular_at(source_directory, "flywheel.sqlite", os.fstat(source_directory).st_uid))
                _backup_sqlite(project_root / ".flywheel" / "flywheel.sqlite", store)
            except FileNotFoundError:
                pass
            finally:
                os.close(source_directory)
        return publish_debug_evidence(store, log_directories, destination, credential_values)
    finally:
        shutil.rmtree(private, ignore_errors=True)
