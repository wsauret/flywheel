import hashlib
import json
import os
import subprocess
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
        return output, package.build_package(self.repository, self.commit, CONFIG_PATH, config_sha256, release_tag, output, build_archive=_archive)

    def test_packages_only_committed_blobs_and_records_their_identity(self) -> None:
        (self.repository / package.SHIM_SOURCE / "flywheel_harbor_agent" / "shim.py").write_text("uncommitted edit\n")
        (self.repository / package.SHIM_SOURCE / "flywheel_harbor_agent" / "untracked.py").write_text("untracked\n")
        output, record = self._build("first")
        files = sorted(path.relative_to(output).as_posix() for path in output.rglob("*") if path.is_file())
        self.assertEqual(files, ["BUILD.json", "flywheel.toml", "flywheel_harbor_agent/shim.py", "harbor-agent.json", "pyproject.toml", "runtime/source-archive.tar.gz", "store-analysis/trial-store-analysis.ts", "uv.lock"])
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
