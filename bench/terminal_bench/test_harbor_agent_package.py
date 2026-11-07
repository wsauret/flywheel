import gzip
import hashlib
import io
import json
import os
import re
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

try:
    from . import harbor_agent_package as package
except ImportError:
    import harbor_agent_package as package

HERMETIC_GIT_ENVIRONMENT = {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
CONFIG = b'allow_persistent_processes = true\nshell_write_guard = false\n'
CONFIG_PATH = "bench/terminal_bench/configs/arm.toml"
ARCHIVE = b"runtime archive bytes"
ANALYZER = b"// store analysis\n"


def _git(repository: Path, *arguments: str) -> str:
    return subprocess.run(["git", *arguments], cwd=repository, check=True, capture_output=True, text=True).stdout.strip()


def _repository(root: Path) -> tuple[Path, str]:
    repository = root / "repository"
    files = {
        "package.json": b'{"version": "9.8.7"}',
        f"{package.SHIM_SOURCE}/pyproject.toml": b"[project]\nname = 'shim'\n",
        f"{package.SHIM_SOURCE}/uv.lock": b"version = 1\n",
        f"{package.SHIM_SOURCE}/flywheel_harbor_agent/shim.py": b"committed shim\n",
        CONFIG_PATH: CONFIG,
        package.STORE_ANALYZER_SOURCE: ANALYZER,
    }
    for path, payload in files.items():
        (repository / path).parent.mkdir(parents=True, exist_ok=True)
        (repository / path).write_bytes(payload)
    for arguments in (["init", "-q"], ["config", "user.email", "test@example.com"], ["config", "user.name", "Test"], ["add", "."], ["commit", "-qm", "package"]):
        _git(repository, *arguments)
    return repository, _git(repository, "rev-parse", "HEAD")


def _bundle(_repository: Path, _commit: str, _archive: Path, output: Path) -> None:
    output.write_bytes(ANALYZER)


def _archive(_work: Path, archive: Path, _commit: str) -> str:
    archive.write_bytes(ARCHIVE)
    return hashlib.sha256(ARCHIVE).hexdigest()


class BuildPackageTest(unittest.TestCase):
    def setUp(self) -> None:
        environment = patch.dict(os.environ, HERMETIC_GIT_ENVIRONMENT)
        environment.start()
        self.addCleanup(environment.stop)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.repository, self.commit = _repository(self.root)

    def _build(self, name: str, config_sha256: str = hashlib.sha256(CONFIG).hexdigest(), release_tag: str | None = None) -> tuple[Path, dict]:
        output = self.root / name
        output.mkdir()
        return output, package.build_package(self.repository, self.commit, CONFIG_PATH, config_sha256, release_tag, output, build_archive=_archive, bundle_analyzer=_bundle)

    def test_packages_only_committed_blobs_and_records_their_identity(self) -> None:
        (self.repository / package.SHIM_SOURCE / "flywheel_harbor_agent" / "shim.py").write_text("uncommitted edit\n")
        (self.repository / package.SHIM_SOURCE / "flywheel_harbor_agent" / "untracked.py").write_text("untracked\n")
        output, record = self._build("first")
        files = sorted(path.relative_to(output).as_posix() for path in output.rglob("*") if path.is_file())
        self.assertEqual(files, ["BUILD.json", "flywheel.toml", "flywheel_harbor_agent/shim.py", "harbor-agent.json", "pyproject.toml", "runtime/source-archive.tar.gz", "store-analysis/trial-store-analysis.js", "uv.lock"])
        self.assertEqual((output / "flywheel_harbor_agent" / "shim.py").read_text(), "committed shim\n")
        self.assertEqual(record["flywheel_source"], {"commit": self.commit, "version": "9.8.7", "release_tag": None})
        self.assertEqual(record["runtime_archive"], {"path": "runtime/source-archive.tar.gz", "sha256": hashlib.sha256(ARCHIVE).hexdigest()})
        self.assertEqual(record["flywheel_config"]["sha256"], hashlib.sha256(CONFIG).hexdigest())
        self.assertEqual(record["store_analyzer"], {"path": package.STORE_ANALYZER_PATH, "source_path": package.STORE_ANALYZER_SOURCE, "sha256": hashlib.sha256(ANALYZER).hexdigest()})
        self.assertEqual((output / package.STORE_ANALYZER_PATH).read_bytes(), ANALYZER)
        self.assertEqual(json.loads((output / "BUILD.json").read_text()), record)
        manifest = json.loads((output / "harbor-agent.json").read_text())
        self.assertEqual(manifest["version"], f"9.8.7+{record['build_id']}")
        self.assertEqual(manifest["runtime"]["entrypoint"], ["flywheel-acp"])
        _, again = self._build("second")
        self.assertEqual(again["build_id"], record["build_id"])

    def test_refuses_a_config_that_differs_from_the_validated_bytes(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "differs from the validated config"):
            self._build("refused", config_sha256="0" * 64)

    def test_limits_refuse_symlinks_and_oversized_packages(self) -> None:
        output, _ = self._build("limits")
        self.assertEqual(package.check_package_limits(output, 8, 10_000)["files"], 8)
        with self.assertRaisesRegex(RuntimeError, "exceeds"):
            package.check_package_limits(output, 7, 10_000)
        (output / "link").symlink_to(output / "uv.lock")
        with self.assertRaisesRegex(RuntimeError, "symlink"):
            package.check_package_limits(output, 100, 10_000)


class StoreAnalyzerBundleTest(unittest.TestCase):
    """The real bundler, on a commit whose analysis imports runtime source and no packages."""

    def setUp(self) -> None:
        environment = patch.dict(os.environ, HERMETIC_GIT_ENVIRONMENT)
        environment.start()
        self.addCleanup(environment.stop)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.repository, self.commit = _repository(self.root)
        (self.repository / package.STORE_ANALYZER_SOURCE).write_text('import { value } from "../../src/value.ts"\nconsole.log(value)\n')
        _git(self.repository, "commit", "-qam", "analysis imports runtime source")
        self.commit = _git(self.repository, "rev-parse", "HEAD")

    @staticmethod
    def _archive(_repository: Path, archive: Path, _commit: str) -> str:
        # A zero gzip mtime keeps the digest, and so the build id, the same across builds.
        with gzip.GzipFile(archive, "wb", mtime=0) as gzipped, tarfile.open(fileobj=gzipped, mode="w") as tar:
            for name, payload in {"package.json": b'{"name": "fixture"}', "src/value.ts": b'export const value = "from the runtime archive"\n'}.items():
                member = tarfile.TarInfo(name)
                member.size = len(payload)
                tar.addfile(member, io.BytesIO(payload))
        return hashlib.sha256(archive.read_bytes()).hexdigest()

    def test_the_same_commit_gives_the_same_runnable_bundle_and_build_id(self) -> None:
        builds = []
        for name in ("first", "second"):
            output = self.root / name
            output.mkdir()
            record = package.build_package(self.repository, self.commit, CONFIG_PATH, hashlib.sha256(CONFIG).hexdigest(), None, output, build_archive=self._archive)
            builds.append((record, (output / package.STORE_ANALYZER_PATH).read_bytes()))
        (first_record, first_bundle), (second_record, second_bundle) = builds
        self.assertEqual(first_bundle, second_bundle)
        self.assertEqual(first_record["build_id"], second_record["build_id"])
        self.assertNotIn(b"flywheel-analyzer-", first_bundle)
        ran = subprocess.run(["bun", str(self.root / "first" / package.STORE_ANALYZER_PATH)], cwd=self.root, check=True, capture_output=True, text=True)
        self.assertEqual(ran.stdout, "from the runtime archive\n")


class RuntimeArchiveTest(unittest.TestCase):
    def setUp(self) -> None:
        environment = patch.dict(os.environ, HERMETIC_GIT_ENVIRONMENT)
        environment.start()
        self.addCleanup(environment.stop)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)

    def _commit(self, files: dict[str, bytes]) -> tuple[Path, str]:
        repository = self.root / "repository"
        for path, payload in files.items():
            (repository / path).parent.mkdir(parents=True, exist_ok=True)
            (repository / path).write_bytes(payload)
        for arguments in (["init", "-q"], ["config", "user.email", "test@example.com"], ["config", "user.name", "Test"], ["add", "."], ["commit", "-qm", "runtime"]):
            _git(repository, *arguments)
        return repository, _git(repository, "rev-parse", "HEAD")

    def _members(self, archive: Path) -> dict[str, bytes]:
        with tarfile.open(archive, "r:gz") as opened:
            return {member.name: opened.extractfile(member).read() for member in opened.getmembers()}

    def test_takes_only_committed_runtime_blobs_and_gives_the_same_bytes_again(self) -> None:
        assets = {path: b"asset" for path in package.RUNTIME_ASSET_PATHS}
        repository, commit = self._commit({"package.json": b"committed", "src/main.ts": b"source", "src/auth.json": b"secret", "docs/readme.md": b"not runtime", **assets})
        (repository / "package.json").write_bytes(b"modified worktree")
        (repository / "src" / "untracked.ts").write_bytes(b"untracked")
        first, second = self.root / "first.tar.gz", self.root / "second.tar.gz"
        digest = package.build_runtime_archive(repository, first, commit)
        self.assertEqual(package.build_runtime_archive(repository, second, commit), digest)
        self.assertEqual(first.read_bytes(), second.read_bytes())
        self.assertEqual(hashlib.sha256(first.read_bytes()).hexdigest(), digest)
        self.assertEqual(self._members(first), {"package.json": b"committed", "src/main.ts": b"source", **assets})

    def test_takes_the_tokenizer_assets_only_as_a_complete_pair(self) -> None:
        repository, commit = self._commit({"package.json": b"package", **{path: b"addon" for path in package.RIPGREP_ADDON_PATHS}, package.TOKENIZER_ASSET_PATHS[0]: b"half"})
        with self.assertRaisesRegex(RuntimeError, "missing a required runtime asset"):
            package.build_runtime_archive(repository, self.root / "archive.tar.gz", commit)

    def test_covers_the_runtime_source_file_set(self) -> None:
        source = (package.REPOSITORY_ROOT / "src/infra/source-snapshot.ts").read_text()
        declaration = re.search(r"export const SOURCE_FILE_SET = \[(.*?)\] as const", source, re.S)
        self.assertIsNotNone(declaration, "SOURCE_FILE_SET declaration moved; update this parser")
        members = re.findall(r'"([^"]+)"', declaration.group(1))
        self.assertIn("src", members)
        uncovered = [member for member in members if member not in package.RUNTIME_ASSET_PATHS and not any(Path(member).parts[:len(Path(prefix).parts)] == Path(prefix).parts for prefix in package.SOURCE_ARCHIVE_MEMBERS)]
        self.assertEqual(uncovered, [], "the runtime archive omits runtime source files")


class PublicationTargetTest(unittest.TestCase):
    def test_only_a_released_build_goes_to_main(self) -> None:
        self.assertEqual(package.publication_target("abcdef012345", None), {"branch": "build/abcdef012345", "tag": None})
        self.assertEqual(package.publication_target("abcdef012345", "v1.2.3"), {"branch": "main", "tag": "flywheel-v1.2.3-abcdef012345"})

    def test_agent_repository_may_hold_only_package_refs(self) -> None:
        package.require_package_refs_only({"HEAD": "a", "refs/heads/main": "a", "refs/heads/build/abcdef012345": "b", "refs/tags/flywheel-v1.2.3-abcdef012345": "a"})
        for foreign in ("refs/notes/ai", "refs/heads/feature", "refs/tags/v1.2.3"):
            with self.subTest(ref=foreign), self.assertRaisesRegex(RuntimeError, foreign):
                package.require_package_refs_only({"refs/heads/main": "a", foreign: "c"})


if __name__ == "__main__":
    unittest.main()
