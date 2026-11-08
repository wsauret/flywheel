"""Build and publish the Harbor ACP agent package of one Flywheel commit.

A package holds the shim project under bench/harbor/harbor_agent/, the arm's
Flywheel config, and the runtime of one exact commit: a compressed archive of
that commit's linux-x64 Flywheel executable tree and the trial store analysis
that the shim runs in the sandbox, both built from a tree of that commit's Git
blobs. Uncommitted or untracked files never enter it, so a package never
publishes work that is not in that commit. A trial extracts the executable
and runs it, so its agent phase downloads and installs nothing, and a task
whose sandbox has no network except the model host can run it. The Claude
engine, too large for the package, comes from the PyPI wheel that the shim's
uv.lock pins, which Harbor installs in the setup phase. Every package
gets a build id derived from its inputs, so the same inputs give the same
package and the same published commit. Local and Harbor Hub runs use the same
package.

Run it with Harbor's Python, from the repository root:

    python bench/harbor/harbor_agent_package.py build \\
        --commit <sha> --config-path <repo-relative path> --config-sha256 <hex> \\
        --answer-key-rule | --no-answer-key-rule \\
        [--release-tag vX.Y.Z] --output <empty directory>
    python bench/harbor/harbor_agent_package.py publish \\
        --directory <package> --repository <owner/repo>

`--answer-key-rule` ships the benchmark's answer-key rule
(harbor_agent/flywheel_harbor_agent/benchmark-rules.md) into the trial home as
user-global instructions; `--no-answer-key-rule` leaves it out of the package.
One of them is required. Each command prints one JSON object on stdout.
"""

import argparse
import hashlib
import json
import lzma
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import tomllib
import urllib.request
import zipfile
from collections.abc import Callable
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parent.parent.parent
SHIM_SOURCE = "bench/harbor/harbor_agent"
BENCHMARK_RULES_PATH = "flywheel_harbor_agent/benchmark-rules.md"
STORE_ANALYZER_SOURCE = "bench/harbor/trial-store-analysis.ts"
STORE_ANALYZER_PATH = "store-analysis/trial-store-analysis.js"
CONFIG_NAME = "flywheel.toml"
ARCHIVE_PATH = "runtime/flywheel-linux-x64.tar.xz"
BUILD_RECORD = "BUILD.json"
MANIFEST_NAME = "harbor-agent.json"
ENTRYPOINT = "flywheel-acp"
# Harbor runs trials on linux/amd64 hosts with glibc; a musl build of Bun
# does not run there.
EXECUTABLE_TARGET = "bun-linux-x64"
# The payload tree that scripts/build-binary.ts stages for that target.
PAYLOAD_PATH = "dist/flywheel-linux-x64/build"
EXECUTABLE_NAME = "flywheel-bin"
NATIVE_PATH = "native/linux-x64"
LEGAL_FILES = ("LICENSE", "THIRD-PARTY-NOTICES.md", "THIRD-PARTY-LICENSES.txt")
# The Claude engine is about 290 MB, past Harbor's package limit. The shim's
# uv.lock pins the claude-agent-sdk wheel of PyPI that bundles the same engine,
# Harbor installs it in the setup phase, and the shim links its engine into the
# runtime; the build checks that the wheel's engine is the commit's engine. The
# payload's build.json, fonts, and web client are not kept either: a trial runs
# the executable directly in ACP mode, and build.json would state the identity
# of the whole payload tree.
OMITTED_NATIVE_FILES = frozenset({"claude"})
# The Agent SDK manifest of the commit's bun.lock names the engine that the
# commit runs, by version and by SHA-256 for each platform.
ENGINE_MANIFEST_PATH = "node_modules/@anthropic-ai/claude-agent-sdk/manifest.json"
ENGINE_PLATFORM = "linux-x64"
ENGINE_WHEEL_PACKAGE = "claude-agent-sdk"
ENGINE_WHEEL_MEMBER = "claude_agent_sdk/_bundled/claude"
WHEEL_CACHE = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "flywheel-harbor-wheels"
# A package commit names no person: the same inputs give the same commit SHA
# on every host.
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
    result = subprocess.run(["git", "--no-replace-objects", *arguments], cwd=repository, capture_output=True, env={**(env or os.environ), **_NO_TRACE2}, input=input_bytes)
    if result.returncode != 0:
        raise RuntimeError(f"git {arguments[0]} exited {result.returncode}: {os.fsdecode(result.stderr).strip()}")
    return result.stdout


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _commit_tree(repository: Path, commit: str, tree: Path) -> None:
    """Write the Git blobs of `commit` into the empty directory `tree`."""
    with tempfile.TemporaryFile() as archive:
        subprocess.run(["git", "--no-replace-objects", "archive", "--format=tar", commit], cwd=repository, check=True, stdout=archive, env={**os.environ, **_NO_TRACE2})
        archive.seek(0)
        with tarfile.open(fileobj=archive, mode="r:") as source:
            source.extractall(tree, filter="data")


def write_executable_archive(payload: Path, archive: Path) -> None:
    """Write the kept files of the executable payload tree `payload` to `archive` as a reproducible tar.xz.

    The archive holds the executable, the legal files, and every native file
    of the target except OMITTED_NATIVE_FILES, by sorted relative path, with
    zero owners and times and mode 0755 or 0644 by the file's execute bit, so
    the same payload always gives the same bytes. Raises when a kept path is
    missing or is not a regular file.
    """
    native = payload / NATIVE_PATH
    members = [EXECUTABLE_NAME, *LEGAL_FILES, *(path.relative_to(payload).as_posix() for path in native.rglob("*") if not path.is_dir() and path.relative_to(native).parts[0] not in OMITTED_NATIVE_FILES)]
    with lzma.open(archive, "wb", preset=9 | lzma.PRESET_EXTREME) as compressed, tarfile.open(fileobj=compressed, mode="w|", format=tarfile.PAX_FORMAT) as tar:
        for name in sorted(members):
            path = payload / name
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode):
                raise RuntimeError(f"executable payload entry is not a regular file: {name}")
            member = tarfile.TarInfo(name)
            member.size = info.st_size
            member.mode = 0o755 if info.st_mode & 0o111 else 0o644
            with path.open("rb") as source:
                tar.addfile(member, source)


def bundle_store_analyzer(tree: Path, output: Path) -> None:
    """Bundle the trial store analysis of the installed commit tree `tree` into the one file `output`.

    A trial whose turn Harbor cancels runs the analysis within 1.6 seconds
    after SIGTERM, and under amd64 emulation on an arm64 host Bun needs about
    2.4 seconds on one CPU to load its `src/` imports one by one, against
    about 1.5 seconds for one prebuilt file. Bun runs in the tree with
    relative paths, so the bundle names no build folder and the same commit
    gives the same bytes.
    """
    # Bundling msgpackr's optional native addon would inline the build
    # folder as its `__dirname`. msgpackr loads the addon in a try block, so
    # left external it is absent in the trial, as it was when inlined.
    subprocess.run(["bun", "build", "--target=bun", "--external", "msgpackr-extract", STORE_ANALYZER_SOURCE, "--outfile", str(output.resolve())], cwd=tree, check=True, stdout=subprocess.DEVNULL)


def read_engine_manifest(tree: Path) -> dict:
    """The Claude engine that the installed commit tree `tree` runs on linux-x64: `{cli_version, sha256}`."""
    manifest = json.loads((tree / ENGINE_MANIFEST_PATH).read_text())
    return {"cli_version": manifest["version"], "sha256": manifest["platforms"][ENGINE_PLATFORM]["checksum"]}


def locked_engine_wheel(lock: bytes) -> dict:
    """The one claude-agent-sdk wheel that the shim's uv.lock `lock` pins: `{url, sha256}`."""
    packages = [entry for entry in tomllib.loads(lock.decode())["package"] if entry["name"] == ENGINE_WHEEL_PACKAGE]
    wheels = [wheel for entry in packages for wheel in entry.get("wheels", [])]
    if len(wheels) != 1:
        raise RuntimeError(f"the shim's uv.lock must pin exactly one {ENGINE_WHEEL_PACKAGE} wheel; it pins {len(wheels)}")
    return {"url": wheels[0]["url"], "sha256": wheels[0]["hash"].removeprefix("sha256:")}


def cached_wheel(wheel: dict, cache: Path) -> Path:
    """The wheel `wheel` in the cache directory `cache`, under its SHA-256, downloaded once and checked against it."""
    path = cache / f"{wheel['sha256']}.whl"
    if path.is_file():
        return path
    cache.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=cache, suffix=".partial", delete=False) as partial:
        try:
            with urllib.request.urlopen(wheel["url"]) as response:
                shutil.copyfileobj(response, partial)
            partial.close()
            if _sha256_file(Path(partial.name)) != wheel["sha256"]:
                raise RuntimeError(f"the wheel at {wheel['url']} differs from its uv.lock hash")
            os.replace(partial.name, path)
        finally:
            Path(partial.name).unlink(missing_ok=True)
    return path


def claude_engine_record(engine: dict, lock: bytes, cache: Path = WHEEL_CACHE) -> dict:
    """The build record of the Claude engine `engine` that the commit runs, with the wheel that the shim's uv.lock `lock` pins.

    Refuses a wheel whose bundled engine differs from the commit's engine,
    because the shim would then refuse every trial.
    """
    wheel = locked_engine_wheel(lock)
    with zipfile.ZipFile(cached_wheel(wheel, cache)) as archive, archive.open(ENGINE_WHEEL_MEMBER) as bundled:
        digest = hashlib.sha256()
        for chunk in iter(lambda: bundled.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != engine["sha256"]:
        raise RuntimeError(
            f"the commit runs Claude engine {engine['cli_version']} ({ENGINE_PLATFORM} sha256 {engine['sha256']}), but the {ENGINE_WHEEL_PACKAGE} wheel that "
            f"{SHIM_SOURCE}/uv.lock pins bundles another engine (sha256 {digest.hexdigest()}). Pin the {ENGINE_WHEEL_PACKAGE} release of PyPI that bundles "
            f"engine {engine['cli_version']} in {SHIM_SOURCE}/pyproject.toml and run `uv lock` there. PyPI may have no such release for some engine versions."
        )
    return {**engine, "wheel": wheel}


def build_runtime(repository: Path, commit: str, archive: Path, analyzer: Path) -> dict:
    """Build the runtime of `commit`: its executable archive at `archive` and its store analysis bundle at `analyzer`.

    Both come from one tree of the commit's blobs with the packages of its own
    `bun.lock`, as a release build of that commit makes them. Returns the
    Claude engine that the commit runs (`read_engine_manifest`).
    """
    with tempfile.TemporaryDirectory(prefix="flywheel-runtime-build-") as directory:
        tree = Path(directory)
        _commit_tree(repository, commit, tree)
        subprocess.run(["bun", "install", "--frozen-lockfile"], cwd=tree, check=True, stdin=subprocess.DEVNULL, stdout=sys.stderr)
        subprocess.run(["bun", "run", "scripts/build-binary.ts", f"--target={EXECUTABLE_TARGET}"], cwd=tree, check=True, stdin=subprocess.DEVNULL, stdout=sys.stderr)
        write_executable_archive(tree / PAYLOAD_PATH, archive)
        bundle_store_analyzer(tree, analyzer)
        return read_engine_manifest(tree)


def build_package(
    repository: Path,
    commit: str,
    config_path: str,
    config_sha256: str,
    answer_key_rule: bool,
    release_tag: str | None,
    output: Path,
    build: Callable[[Path, str, Path, Path], dict] = build_runtime,
    wheel_cache: Path = WHEEL_CACHE,
) -> dict:
    """Write the package of `commit` into the empty directory `output` and return its build record.

    The package carries the benchmark rules file only when `answer_key_rule`
    is true; the record names it under `benchmark_rules`, else null. Refuses a
    commit whose arm config bytes differ from `config_sha256`, because the
    launcher validated those bytes and the package must run them, and a
    commit whose Claude engine differs from the wheel's (`claude_engine_record`).
    """
    if any(output.iterdir()):
        raise RuntimeError(f"package output directory is not empty: {output}")
    shim_paths = [path for path in os.fsdecode(_git(repository, "ls-tree", "-r", "--name-only", "-z", commit, "--", SHIM_SOURCE)).split("\0") if path]
    if not shim_paths:
        raise RuntimeError(f"commit {commit} holds no Harbor agent package source under {SHIM_SOURCE}")
    shim_files, benchmark_rules = {}, None
    for path in sorted(shim_paths):
        relative = Path(path).relative_to(SHIM_SOURCE).as_posix()
        if relative == BENCHMARK_RULES_PATH and not answer_key_rule:
            continue
        payload = _git(repository, "cat-file", "blob", f"{commit}:{path}")
        target = output / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)
        if relative == BENCHMARK_RULES_PATH:
            benchmark_rules = {"path": relative, "sha256": _sha256(payload)}
        else:
            shim_files[relative] = _sha256(payload)
    if answer_key_rule and benchmark_rules is None:
        raise RuntimeError(f"commit {commit} holds no benchmark rules at {SHIM_SOURCE}/{BENCHMARK_RULES_PATH}")
    config = _git(repository, "cat-file", "blob", f"{commit}:{config_path}")
    if _sha256(config) != config_sha256:
        raise RuntimeError(f"the arm config {config_path} at commit {commit} differs from the validated config; commit it first")
    (output / CONFIG_NAME).write_bytes(config)
    archive, analyzer = output / ARCHIVE_PATH, output / STORE_ANALYZER_PATH
    archive.parent.mkdir()
    analyzer.parent.mkdir()
    claude_engine = claude_engine_record(build(repository, commit, archive, analyzer), (output / "uv.lock").read_bytes(), wheel_cache)
    archive.chmod(0o644)
    archive_sha256, analyzer_sha256 = _sha256_file(archive), _sha256_file(analyzer)
    flywheel_version = json.loads(_git(repository, "cat-file", "blob", f"{commit}:package.json"))["version"]
    identity = {"commit": commit, "runtime_archive_sha256": archive_sha256, "flywheel_config_sha256": config_sha256, "store_analyzer_sha256": analyzer_sha256, "shim_files": shim_files, "benchmark_rules": benchmark_rules}
    build_id = _sha256(json.dumps(identity, sort_keys=True).encode())[:12]
    record = {
        "schema_version": 3,
        "build_id": build_id,
        "flywheel_source": {"commit": commit, "version": flywheel_version, "release_tag": release_tag},
        "runtime_archive": {"path": ARCHIVE_PATH, "sha256": archive_sha256},
        "flywheel_config": {"path": CONFIG_NAME, "source_path": config_path, "sha256": config_sha256},
        "store_analyzer": {"path": STORE_ANALYZER_PATH, "source_path": STORE_ANALYZER_SOURCE, "sha256": analyzer_sha256},
        "benchmark_rules": benchmark_rules,
        "claude_engine": claude_engine,
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
    build.add_argument("--answer-key-rule", required=True, action=argparse.BooleanOptionalAction)
    build.add_argument("--release-tag")
    build.add_argument("--output", required=True, type=Path)
    publish = commands.add_parser("publish")
    publish.add_argument("--directory", required=True, type=Path)
    publish.add_argument("--repository", required=True)
    arguments = parser.parse_args()
    if arguments.command == "build":
        record = build_package(REPOSITORY_ROOT, arguments.commit, arguments.config_path, arguments.config_sha256, arguments.answer_key_rule, arguments.release_tag, arguments.output)
        print(json.dumps({**record, "limits": validate_package(arguments.output)}))
        return
    record = json.loads((arguments.directory / BUILD_RECORD).read_text())
    committer_date = os.fsdecode(_git(REPOSITORY_ROOT, "show", "-s", "--format=%cI", record["flywheel_source"]["commit"])).strip()
    print(json.dumps(publish_package(arguments.directory, arguments.repository, committer_date)))


if __name__ == "__main__":
    sys.exit(main())
