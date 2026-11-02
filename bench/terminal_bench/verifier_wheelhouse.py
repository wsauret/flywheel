#!/usr/bin/env python3

import argparse
import asyncio
import fcntl
import hashlib
import json
import os
import re
import shlex
import shutil
import stat
import subprocess
import sys
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Sequence

MANIFEST_VERSION = 1
DEFAULT_PLATFORMS = ("linux_x86_64", "linux_aarch64")
CONTAINER_WHEELHOUSE = "/opt/flywheel-verifier-wheelhouse"
EXACT_PIN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9,._-]+\])?==[^;\s]+$")
SHELL_OPERATORS = {"&&", "||", ";", "|"}
PLATFORM_TAGS = {
    "linux_x86_64": (
        "manylinux_2_28_x86_64",
        "manylinux_2_17_x86_64",
        "manylinux2014_x86_64",
        "manylinux_2_12_x86_64",
        "manylinux2010_x86_64",
    ),
    "linux_aarch64": (
        "manylinux_2_28_aarch64",
        "manylinux_2_17_aarch64",
        "manylinux2014_aarch64",
    ),
}
DOCKER_PLATFORMS = {
    "linux_x86_64": "linux/amd64",
    "linux_aarch64": "linux/arm64",
}


@dataclass(frozen=True)
class WheelhousePolicy:
    requirements: tuple[str, ...]
    platforms: tuple[str, ...] = DEFAULT_PLATFORMS
    python_version: str = "3.13"
    implementation: str = "cp"
    abi: str = "cp313"

    def payload(self) -> dict[str, object]:
        return {
            "version": MANIFEST_VERSION,
            "requirements": list(self.requirements),
            "platforms": list(self.platforms),
            "python_version": self.python_version,
            "implementation": self.implementation,
            "abi": self.abi,
        }

    def digest(self) -> str:
        encoded = json.dumps(self.payload(), sort_keys=True, separators=(",", ":")).encode()
        return hashlib.sha256(encoded).hexdigest()


Download = Callable[[str, str, Path], None]


def _logical_commands(source: str) -> Iterable[list[str]]:
    for line in source.replace("\\\n", " ").splitlines():
        lexer = shlex.shlex(line, posix=True, punctuation_chars=";&|")
        lexer.whitespace_split = True
        lexer.commenters = "#"
        try:
            tokens = list(lexer)
        except ValueError as error:
            raise RuntimeError(f"cannot parse verifier package command: {error}") from error
        if tokens:
            yield tokens


def _require_exact_pin(token: str, script: Path) -> str:
    if not EXACT_PIN.fullmatch(token):
        raise RuntimeError(f"{script} verifier package install must use an exact package pin, got {token!r}")
    return token


def _pip_requirements(tokens: Sequence[str], script: Path) -> list[str]:
    requirements: list[str] = []
    for index in range(len(tokens) - 1):
        if tokens[index] not in {"pip", "pip3"} or tokens[index + 1] != "install":
            continue
        for token in tokens[index + 2 :]:
            if token in SHELL_OPERATORS:
                break
            if token.startswith("-"):
                option = token.split("=", 1)[0]
                if option not in {"--break-system-packages", "--quiet", "-q", "--disable-pip-version-check", "--no-cache-dir", "--root-user-action"}:
                    raise RuntimeError(f"{script} verifier package install uses unsupported pip option {token!r}")
                continue
            requirements.append(_require_exact_pin(token, script))
    return requirements


def _uvx_requirements(tokens: Sequence[str], script: Path) -> list[str]:
    if "uvx" not in tokens:
        return []
    requirements: list[str] = []
    for index, token in enumerate(tokens):
        option = token.split("=", 1)[0]
        if option in {"--index", "--default-index", "--extra-index-url", "--index-url", "--find-links", "--python-platform", "--python-version", "--with-requirements", "--with-editable", "--requirements", "-r"}:
            raise RuntimeError(f"{script} verifier package install uses unsupported uvx option {token!r}")
        if token in {"-p", "--python"}:
            if index + 1 >= len(tokens) or tokens[index + 1] != "3.13":
                requested = tokens[index + 1] if index + 1 < len(tokens) else "<missing>"
                raise RuntimeError(f"{script} requests unsupported uvx Python {requested!r}; only 3.13 is sealed")
        elif token.startswith("--python=") and token.removeprefix("--python=") != "3.13":
            raise RuntimeError(f"{script} requests unsupported uvx Python {token.removeprefix('--python=')!r}; only 3.13 is sealed")
        elif token in {"-w", "--with"}:
            if index + 1 >= len(tokens):
                raise RuntimeError(f"{script} has a uvx {token} without a package")
            requirements.append(_require_exact_pin(tokens[index + 1], script))
        elif token.startswith("--with="):
            requirements.append(_require_exact_pin(token.removeprefix("--with="), script))
    return requirements

def _read_safe_script(script: Path) -> str:
    if script.is_symlink():
        raise RuntimeError(f"selected verifier script is unsafe: {script}")
    absolute = script.resolve(strict=True)
    descriptor = os.open(absolute.anchor, os.O_RDONLY | os.O_DIRECTORY)
    try:
        for index, part in enumerate(absolute.parts[1:]):
            final = index == len(absolute.parts) - 2
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
            if not final:
                flags |= os.O_DIRECTORY
            next_descriptor = os.open(part, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = next_descriptor
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1 or info.st_mode & 0o022:
            raise RuntimeError(f"selected verifier script is unsafe: {script}")
        with os.fdopen(os.dup(descriptor), "rb") as file:
            return file.read().decode("utf-8")
    except UnicodeDecodeError as error:
        raise RuntimeError(f"selected verifier script is not UTF-8: {script}") from error
    finally:
        os.close(descriptor)


def extract_requirements(test_scripts: Sequence[Path]) -> tuple[str, ...]:
    requirements: set[str] = set()
    for script in test_scripts:
        source = _read_safe_script(script)
        for tokens in _logical_commands(source):
            requirements.update(_pip_requirements(tokens, script))
            requirements.update(_uvx_requirements(tokens, script))
    if not requirements:
        raise RuntimeError("selected verifier scripts declare no supported pinned Python package requirements")
    return tuple(sorted(requirements))


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _manifest(policy: WheelhousePolicy, directory: Path) -> dict[str, object]:
    files = []
    for path in sorted(directory.glob("*.whl"), key=lambda item: item.name):
        files.append({"name": path.name, "size": path.stat().st_size, "sha256": _sha256(path)})
    if not files:
        raise RuntimeError("verifier wheelhouse download produced no wheels")
    return {"policy": policy.payload(), "files": files}


def _manifest_bytes(manifest: dict[str, object]) -> bytes:
    return (json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n").encode()


def validate_wheelhouse(directory: Path, policy: WheelhousePolicy) -> None:
    if directory.is_symlink() or not directory.is_dir():
        raise RuntimeError(f"verifier wheelhouse is not a regular directory: {directory}")
    manifest_path = directory / "manifest.json"
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise RuntimeError(f"verifier wheelhouse manifest is missing: {manifest_path}")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError(f"verifier wheelhouse manifest is invalid: {error}") from error
    if manifest.get("policy") != policy.payload():
        raise RuntimeError("verifier wheelhouse policy does not match the selected task requirements")
    records = manifest.get("files")
    if not isinstance(records, list) or not records:
        raise RuntimeError("verifier wheelhouse manifest has no files")
    expected_names: set[str] = {"manifest.json"}
    for record in records:
        if not isinstance(record, dict):
            raise RuntimeError("verifier wheelhouse manifest has an invalid file record")
        name = record.get("name")
        size = record.get("size")
        digest = record.get("sha256")
        if not isinstance(name, str) or Path(name).name != name or not name.endswith(".whl"):
            raise RuntimeError("verifier wheelhouse manifest has an unsafe file name")
        path = directory / name
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise RuntimeError(f"verifier wheelhouse file is not a single-link regular file: {name}")
        if info.st_mode & 0o222:
            raise RuntimeError(f"verifier wheelhouse file is writable: {name}")
        if info.st_size != size:
            raise RuntimeError(f"verifier wheelhouse size mismatch: {name}")
        if _sha256(path) != digest:
            raise RuntimeError(f"verifier wheelhouse digest mismatch: {name}")
        expected_names.add(name)
    actual_names = {path.name for path in directory.iterdir()}
    if actual_names != expected_names:
        raise RuntimeError("verifier wheelhouse contains files outside its manifest")
    if manifest_path.stat().st_mode & 0o222:
        raise RuntimeError("verifier wheelhouse manifest is writable")
    if directory.stat().st_mode & 0o222:
        raise RuntimeError("verifier wheelhouse directory is writable")

def _private_cache_root(cache_root: Path) -> None:
    cache_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = cache_root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise RuntimeError(f"verifier wheelhouse cache root must be an owner-private directory: {cache_root}")


def _remove_stage(stage: Path) -> None:
    if not stage.exists():
        return
    if stage.is_symlink():
        stage.unlink()
        return
    stage.chmod(0o700)
    for path in stage.rglob("*"):
        if not path.is_symlink():
            path.chmod(0o700 if path.is_dir() else 0o600)
    shutil.rmtree(stage)


def prepare_wheelhouse(cache_root: Path, policy: WheelhousePolicy, download: Download) -> Path:
    _private_cache_root(cache_root)
    target = cache_root / policy.digest()
    published = target / "wheelhouse"
    lock_path = cache_root / f"{policy.digest()}.lock"
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(lock_path, flags, 0o600)
    with os.fdopen(descriptor, "a+b") as lock:
        lock_info = os.fstat(lock.fileno())
        if not stat.S_ISREG(lock_info.st_mode) or lock_info.st_uid != os.geteuid() or lock_info.st_nlink != 1:
            raise RuntimeError("verifier wheelhouse lock is unsafe")
        os.fchmod(lock.fileno(), 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        for abandoned in cache_root.glob(f".{policy.digest()}.*"):
            _remove_stage(abandoned)
        if target.exists():
            try:
                validate_wheelhouse(published, policy)
                return published
            except RuntimeError:
                _remove_stage(target)
        stage = cache_root / f".{policy.digest()}.{uuid.uuid4().hex}"
        content = stage / "wheelhouse"
        stage.mkdir(mode=0o700)
        content.mkdir(mode=0o700)
        try:
            for platform in policy.platforms:
                for requirement in policy.requirements:
                    download(requirement, platform, content)
            for path in content.iterdir():
                info = path.lstat()
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or not path.name.endswith(".whl"):
                    raise RuntimeError(f"verifier wheel download produced an unsafe artifact: {path.name}")
                path.chmod(0o444)
            manifest_path = content / "manifest.json"
            manifest_path.write_bytes(_manifest_bytes(_manifest(policy, content)))
            manifest_path.chmod(0o444)
            content.chmod(0o555)
            validate_wheelhouse(content, policy)
            os.replace(stage, target)
            return published
        except BaseException:
            _remove_stage(stage)
            raise


def pip_downloader(policy: WheelhousePolicy, python: str) -> Download:
    def download(requirement: str, platform: str, destination: Path) -> None:
        command = [
            python,
            "-m",
            "pip",
            "--isolated",
            "download",
            "--index-url",
            "https://pypi.org/simple",
            "--dest",
            str(destination),
            "--only-binary=:all:",
        ]
        for tag in PLATFORM_TAGS.get(platform, (platform,)):
            command.extend(("--platform", tag))
        command.extend([
            "--python-version",
            policy.python_version,
            "--implementation",
            policy.implementation,
            "--abi",
            policy.abi,
            "--retries",
            "10",
            "--timeout",
            "30",
            requirement,
        ])
        try:
            subprocess.run(command, check=True, stdout=sys.stderr)
        except subprocess.CalledProcessError:
            docker_platform = DOCKER_PLATFORMS.get(platform)
            if docker_platform is None:
                raise
            fallback = [
                "docker",
                "run",
                "--rm",
                "--platform",
                docker_platform,
                "--user",
                f"{os.geteuid()}:{os.getegid()}",
                "--env",
                "HOME=/tmp",
                "--mount",
                f"type=bind,source={destination.resolve()},target=/wheelhouse",
                "python:3.13-bookworm",
                "python",
                "-m",
                "pip",
                "--isolated",
                "wheel",
                "--index-url",
                "https://pypi.org/simple",
                "--wheel-dir",
                "/wheelhouse",
                "--no-cache-dir",
                "--retries",
                "10",
                "--timeout",
                "30",
                requirement,
            ]
            subprocess.run(fallback, check=True, stdout=sys.stderr)

    return download


async def selected_test_scripts(dataset: str, task_names: Sequence[str], n_tasks: int | None, task_cache: Path) -> list[Path]:
    from harbor.registry.client.package import PackageDatasetClient

    metadata = await PackageDatasetClient().get_dataset_metadata(dataset)
    requested = {name if "/" in name else f"terminal-bench/{name}" for name in task_names}
    selected = [task for task in metadata.task_ids if not requested or f"{task.org}/{task.name}" in requested]
    if requested:
        found = {f"{task.org}/{task.name}" for task in selected}
        missing = sorted(requested - found)
        if missing:
            raise RuntimeError(f"dataset does not contain selected tasks: {', '.join(missing)}")
    if n_tasks is not None:
        selected = selected[:n_tasks]
    scripts = []
    task_cache = task_cache.resolve(strict=True)
    for task in selected:
        if task.org != "terminal-bench" or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", task.name):
            raise RuntimeError(f"dataset contains an unsafe task identity: {task.org}/{task.name}")
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", task.ref):
            raise RuntimeError(f"dataset task is not content-pinned: {task.org}/{task.name}@{task.ref}")
        revision = task.ref.removeprefix("sha256:")
        script = task_cache / task.name / revision / "tests" / "test.sh"
        _read_safe_script(script)
        scripts.append(script)
    if not scripts:
        raise RuntimeError("dataset selection contains no verifier scripts")
    return scripts


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Prepare a sealed offline wheelhouse for selected Harbor verifiers.")
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--task-cache", type=Path, required=True)
    parser.add_argument("--task-name", action="append", default=[])
    parser.add_argument("--n-tasks", type=int)
    parser.add_argument("--cache-root", type=Path, default=Path.home() / ".cache" / "flywheel" / "terminal-bench" / "verifier-wheelhouse")
    parser.add_argument("--download-python", default=os.environ.get("FLYWHEEL_VERIFIER_WHEELHOUSE_PYTHON", "python3"))
    return parser


def main() -> int:
    args = _parser().parse_args()
    scripts = asyncio.run(selected_test_scripts(args.dataset, args.task_name, args.n_tasks, args.task_cache))
    policy = WheelhousePolicy(extract_requirements(scripts))
    wheelhouse = prepare_wheelhouse(args.cache_root, policy, pip_downloader(policy, args.download_python))
    print(wheelhouse.resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
