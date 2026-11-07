"""Build and publish the Harbor ACP agent package of one Flywheel commit.

A package holds only Git blobs of one exact commit: the shim project under
bench/terminal_bench/harbor_agent/, the arm's Flywheel config, and the runtime
archive that flywheel_agent.py builds from that commit. Uncommitted or
untracked files never enter it, so a package never publishes work that is not
in that commit. Every package gets a build id derived from its inputs, so the
same inputs give the same package and the same published commit.

Run it with Harbor's Python, from the repository root:

    python bench/terminal_bench/harbor_agent_package.py build \\
        --commit <sha> --config-path <repo-relative path> --config-sha256 <hex> \\
        [--release-tag vX.Y.Z] --output <empty directory>
    python bench/terminal_bench/harbor_agent_package.py publish \\
        --directory <package> --repository <owner/repo>

Each command prints one JSON object on stdout.
"""

import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
from collections.abc import Callable
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parent.parent.parent
SHIM_SOURCE = "bench/terminal_bench/harbor_agent"
CONFIG_NAME = "flywheel.toml"
ARCHIVE_PATH = "runtime/source-archive.tar.gz"
BUILD_RECORD = "BUILD.json"
MANIFEST_NAME = "harbor-agent.json"
ENTRYPOINT = "flywheel-acp"
# A published package commit names no person: the same inputs give the same
# commit SHA on every host.
PUBLISHER_IDENTITY = {
    "GIT_AUTHOR_NAME": "Flywheel benchmark package builder",
    "GIT_AUTHOR_EMAIL": "flywheel-benchmark@users.noreply.github.com",
    "GIT_COMMITTER_NAME": "Flywheel benchmark package builder",
    "GIT_COMMITTER_EMAIL": "flywheel-benchmark@users.noreply.github.com",
}


# A Git trace2 event target in the user's Git config can feed tooling that
# pushes its own refs, such as authorship notes, beside a push. The agent
# repository holds only package refs, so every Git call here turns trace2
# events off through Git's own environment switch, which overrides the config.
_NO_TRACE2 = {"GIT_TRACE2_EVENT": "0"}
_PACKAGE_REF = re.compile(r"refs/heads/main|refs/heads/build/[0-9a-f]{12}|refs/tags/flywheel-v\d+\.\d+\.\d+-[0-9a-f]{12}")


def _git(repository: Path, *arguments: str, env: dict | None = None, input_bytes: bytes | None = None) -> bytes:
    result = subprocess.run(["git", "--no-replace-objects", *arguments], cwd=repository, check=True, capture_output=True, env={**(env or os.environ), **_NO_TRACE2}, input=input_bytes)
    return result.stdout


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _default_archive_builder(work: Path, archive: Path, commit: str) -> str:
    try:
        from .flywheel_agent import _build_archive
    except ImportError:
        from flywheel_agent import _build_archive
    # The builder writes into its job directory under the archive's name.
    digest = _build_archive(work, archive, runtime_source_commit=commit).sha256
    (work / archive.name).rename(archive)
    return digest


def build_package(
    repository: Path,
    commit: str,
    config_path: str,
    config_sha256: str,
    release_tag: str | None,
    output: Path,
    build_archive: Callable[[Path, Path, str], str] = _default_archive_builder,
) -> dict:
    """Write the package of `commit` into the empty directory `output` and return its build record.

    Refuses a commit whose arm config bytes differ from `config_sha256`,
    because the launcher validated those bytes and the package must run them.
    """
    if any(output.iterdir()):
        raise RuntimeError(f"package output directory is not empty: {output}")
    shim_paths = [path for path in os.fsdecode(_git(repository, "ls-tree", "-r", "--name-only", "-z", commit, "--", SHIM_SOURCE)).split("\0") if path]
    if not shim_paths:
        raise RuntimeError(f"commit {commit} holds no Harbor agent package source under {SHIM_SOURCE}")
    shim_files = {}
    for path in sorted(shim_paths):
        payload = _git(repository, "cat-file", "blob", f"{commit}:{path}")
        relative = Path(path).relative_to(SHIM_SOURCE).as_posix()
        target = output / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)
        shim_files[relative] = _sha256(payload)
    config = _git(repository, "cat-file", "blob", f"{commit}:{config_path}")
    if _sha256(config) != config_sha256:
        raise RuntimeError(f"the arm config {config_path} at commit {commit} differs from the validated config; commit it first")
    (output / CONFIG_NAME).write_bytes(config)
    archive = output / ARCHIVE_PATH
    archive.parent.mkdir()
    with tempfile.TemporaryDirectory(prefix="flywheel-package-archive-") as work:
        archive_sha256 = build_archive(Path(work), archive, commit)
    archive.chmod(0o644)
    if _sha256(archive.read_bytes()) != archive_sha256:
        raise RuntimeError("runtime archive bytes do not match the digest its builder reported")
    flywheel_version = json.loads(_git(repository, "cat-file", "blob", f"{commit}:package.json"))["version"]
    identity = {"commit": commit, "runtime_archive_sha256": archive_sha256, "flywheel_config_sha256": config_sha256, "shim_files": shim_files}
    build_id = _sha256(json.dumps(identity, sort_keys=True).encode())[:12]
    record = {
        "schema_version": 1,
        "build_id": build_id,
        "flywheel_source": {"commit": commit, "version": flywheel_version, "release_tag": release_tag},
        "runtime_archive": {"path": ARCHIVE_PATH, "sha256": archive_sha256},
        "flywheel_config": {"path": CONFIG_NAME, "source_path": config_path, "sha256": config_sha256},
        "shim_files": shim_files,
    }
    (output / BUILD_RECORD).write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")
    manifest = {
        "schema_version": 1,
        "id": "flywheel",
        "version": f"{flywheel_version}+{build_id}",
        "protocol": "acp",
        "runtime": {"kind": "python-uv", "python": "3.12", "project": ".", "lockfile": "uv.lock", "entrypoint": [ENTRYPOINT]},
    }
    (output / MANIFEST_NAME).write_text(json.dumps(manifest, indent=2) + "\n")
    return record


def check_package_limits(directory: Path, max_files: int, max_bytes: int) -> dict:
    """Check the regular-file, symlink, file-count, and size limits Harbor applies to a fetched source."""
    files, size = 0, 0
    for path in directory.rglob("*"):
        info = path.lstat()
        if stat.S_ISDIR(info.st_mode):
            continue
        if not stat.S_ISREG(info.st_mode):
            raise RuntimeError(f"agent package holds a symlink or special file: {path.relative_to(directory)}")
        files += 1
        size += info.st_size
    if files > max_files or size > max_bytes:
        raise RuntimeError(f"agent package exceeds Harbor's source limits: {files} files, {size} bytes")
    return {"files": files, "bytes": size}


def validate_package(directory: Path) -> dict:
    """Validate the package with Harbor's own manifest model and source limits."""
    from harbor.agents.installed.acp import AcpAgent
    from harbor.models.agent.acp_source import AcpSourceManifest

    manifest_bytes = (directory / MANIFEST_NAME).read_bytes()
    if len(manifest_bytes) > AcpAgent._MAX_MANIFEST_BYTES:
        raise RuntimeError("agent package manifest exceeds Harbor's manifest size limit")
    AcpSourceManifest.model_validate_json(manifest_bytes)
    for required in ("pyproject.toml", "uv.lock"):
        if not (directory / required).is_file():
            raise RuntimeError(f"agent package lacks {required}")
    return check_package_limits(directory, AcpAgent._MAX_SOURCE_FILES, AcpAgent._MAX_SOURCE_BYTES)


def publication_target(build_id: str, release_tag: str | None) -> dict:
    """Where a package goes in the agent repository.

    Only a package of a published release goes to `main`, with a tag naming
    the Flywheel version and the build. Every other package goes to its own
    `build/<id>` branch and never to `main`.
    """
    if release_tag is None:
        return {"branch": f"build/{build_id}", "tag": None}
    return {"branch": "main", "tag": f"flywheel-{release_tag}-{build_id}"}


def _remote_refs(url: str, *patterns: str) -> dict[str, str]:
    listed = subprocess.run(["git", "ls-remote", url, *patterns], check=True, capture_output=True, text=True, env={**os.environ, **_NO_TRACE2}).stdout
    return {ref: sha for sha, ref in (line.split("\t") for line in listed.splitlines() if line)}


def _remote_commit(url: str, ref: str) -> str | None:
    return _remote_refs(url, ref).get(ref)


def require_package_refs_only(refs: dict[str, str]) -> None:
    """Refuse an agent repository that holds any ref beyond package refs."""
    foreign = sorted(ref for ref in refs if ref != "HEAD" and not _PACKAGE_REF.fullmatch(ref))
    if foreign:
        raise RuntimeError(f"the agent repository holds refs that are not package refs: {', '.join(foreign)}")


def publish_package(directory: Path, repository: str, source_committer_date: str) -> dict:
    """Publish the package to `repository` (owner/repo) and return the pushed ref and commit.

    A ref that already holds the same package is reused; a ref that holds a
    different package is refused.
    """
    record = json.loads((directory / BUILD_RECORD).read_text())
    target = publication_target(record["build_id"], record["flywheel_source"]["release_tag"])
    url = f"https://github.com/{repository}.git"
    with tempfile.TemporaryDirectory(prefix="flywheel-package-publish-") as work_name:
        work = Path(work_name)
        environment = {**os.environ, **PUBLISHER_IDENTITY, "GIT_AUTHOR_DATE": source_committer_date, "GIT_COMMITTER_DATE": source_committer_date,
                       "GIT_DIR": str(work / "git"), "GIT_WORK_TREE": str(directory), "GIT_INDEX_FILE": str(work / "index")}
        _git(work, "init", "-q", "--bare", str(work / "git"))
        _git(directory, "add", "--all", "--force", ".", env=environment)
        tree = os.fsdecode(_git(directory, "write-tree", env=environment)).strip()
        existing_ref = f"refs/tags/{target['tag']}" if target["tag"] else f"refs/heads/{target['branch']}"
        existing = _remote_commit(url, existing_ref)
        if existing is not None:
            _git(directory, "fetch", "-q", url, existing, env=environment)
            existing_tree = os.fsdecode(_git(directory, "rev-parse", f"{existing}^{{tree}}", env=environment)).strip()
            if existing_tree != tree:
                raise RuntimeError(f"{repository} {existing_ref} already holds a different package")
            require_package_refs_only(_remote_refs(url))
            return {"repository": repository, "ref": existing_ref, "commit": existing, **target}
        parents: list[str] = []
        if target["tag"]:
            main = _remote_commit(url, "refs/heads/main")
            if main is not None:
                _git(directory, "fetch", "-q", url, main, env=environment)
                parents = ["-p", main]
        source = record["flywheel_source"]
        message = f"Flywheel {source['version']} at {source['commit']}, build {record['build_id']}\n"
        commit = os.fsdecode(_git(directory, "commit-tree", "--no-gpg-sign", tree, *parents, env=environment, input_bytes=message.encode())).strip()
        refspecs = [f"{commit}:refs/heads/{target['branch']}"]
        if target["tag"]:
            refspecs.append(f"{commit}:refs/tags/{target['tag']}")
        _git(directory, "push", "-q", url, *refspecs, env=environment)
        require_package_refs_only(_remote_refs(url))
        return {"repository": repository, "ref": existing_ref, "commit": commit, **target}


def main() -> None:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build")
    build.add_argument("--commit", required=True)
    build.add_argument("--config-path", required=True)
    build.add_argument("--config-sha256", required=True)
    build.add_argument("--release-tag")
    build.add_argument("--output", required=True, type=Path)
    publish = commands.add_parser("publish")
    publish.add_argument("--directory", required=True, type=Path)
    publish.add_argument("--repository", required=True)
    arguments = parser.parse_args()
    if arguments.command == "build":
        record = build_package(REPOSITORY_ROOT, arguments.commit, arguments.config_path, arguments.config_sha256, arguments.release_tag, arguments.output)
        print(json.dumps({**record, "limits": validate_package(arguments.output)}))
        return
    record = json.loads((arguments.directory / BUILD_RECORD).read_text())
    committer_date = os.fsdecode(_git(REPOSITORY_ROOT, "show", "-s", "--format=%cI", record["flywheel_source"]["commit"])).strip()
    print(json.dumps(publish_package(arguments.directory, arguments.repository, committer_date)))


if __name__ == "__main__":
    sys.exit(main())
