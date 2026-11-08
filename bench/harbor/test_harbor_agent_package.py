import hashlib
import io
import json
import lzma
import os
import subprocess
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

try:
    from . import harbor_agent_package as package
except ImportError:
    import harbor_agent_package as package

HERMETIC_GIT_ENVIRONMENT = {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
CONFIG = b'allow_persistent_processes = true\nshell_write_guard = false\n'
CONFIG_PATH = "bench/harbor/configs/arm.toml"
ARCHIVE = b"runtime archive bytes"
ANALYZER = b"// store analysis\n"
RULES = b"# Benchmark rules\n"
ENGINE = b"claude engine bytes"


def _wheel(engine: bytes) -> bytes:
    """A claude-agent-sdk wheel that bundles `engine`."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as wheel:
        wheel.writestr(zipfile.ZipInfo(package.ENGINE_WHEEL_MEMBER, (2020, 1, 1, 0, 0, 0)), engine)
    return buffer.getvalue()


WHEEL = _wheel(ENGINE)
WHEEL_SHA256 = hashlib.sha256(WHEEL).hexdigest()
WHEEL_URL = "https://files.example/claude_agent_sdk-1.0.0-py3-none-manylinux_2_17_x86_64.whl"
LOCK = f'version = 1\n\n[[package]]\nname = "claude-agent-sdk"\nversion = "1.0.0"\nwheels = [{{ url = "{WHEEL_URL}", hash = "sha256:{WHEEL_SHA256}" }}]\n'.encode()
ENGINE_MANIFEST = {"cli_version": "2.0.0", "sha256": hashlib.sha256(ENGINE).hexdigest()}


def _git(repository: Path, *arguments: str) -> str:
    return subprocess.run(["git", *arguments], cwd=repository, check=True, capture_output=True, text=True).stdout.strip()


def _repository(root: Path) -> tuple[Path, str]:
    repository = root / "repository"
    files = {
        "package.json": b'{"version": "9.8.7"}',
        f"{package.SHIM_SOURCE}/pyproject.toml": b"[project]\nname = 'shim'\n",
        f"{package.SHIM_SOURCE}/uv.lock": LOCK,
        f"{package.SHIM_SOURCE}/flywheel_harbor_agent/shim.py": b"committed shim\n",
        f"{package.SHIM_SOURCE}/{package.BENCHMARK_RULES_PATH}": RULES,
        CONFIG_PATH: CONFIG,
        package.STORE_ANALYZER_SOURCE: ANALYZER,
    }
    for path, payload in files.items():
        (repository / path).parent.mkdir(parents=True, exist_ok=True)
        (repository / path).write_bytes(payload)
    for arguments in (["init", "-q"], ["config", "user.email", "test@example.com"], ["config", "user.name", "Test"], ["add", "."], ["commit", "-qm", "package"]):
        _git(repository, *arguments)
    return repository, _git(repository, "rev-parse", "HEAD")


def _runtime(_repository: Path, _commit: str, archive: Path, analyzer: Path) -> dict:
    archive.write_bytes(ARCHIVE)
    analyzer.write_bytes(ANALYZER)
    return ENGINE_MANIFEST


class BuildPackageTest(unittest.TestCase):
    def setUp(self) -> None:
        environment = patch.dict(os.environ, HERMETIC_GIT_ENVIRONMENT)
        environment.start()
        self.addCleanup(environment.stop)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.repository, self.commit = _repository(self.root)
        # The wheel cache already holds the pinned wheel, so no build downloads it.
        self.cache = self.root / "wheels"
        self.cache.mkdir()
        (self.cache / f"{WHEEL_SHA256}.whl").write_bytes(WHEEL)

    def _build(self, name: str, config_sha256: str = hashlib.sha256(CONFIG).hexdigest(), answer_key_rule: bool = True, runtime=_runtime) -> tuple[Path, dict]:
        output = self.root / name
        output.mkdir()
        return output, package.build_package(self.repository, self.commit, CONFIG_PATH, config_sha256, answer_key_rule, None, output, build=runtime, wheel_cache=self.cache)

    def test_packages_only_committed_blobs_and_records_their_identity(self) -> None:
        (self.repository / package.SHIM_SOURCE / "flywheel_harbor_agent" / "shim.py").write_text("uncommitted edit\n")
        (self.repository / package.SHIM_SOURCE / "flywheel_harbor_agent" / "untracked.py").write_text("untracked\n")
        output, record = self._build("first")
        files = sorted(path.relative_to(output).as_posix() for path in output.rglob("*") if path.is_file())
        self.assertEqual(files, ["BUILD.json", "flywheel.toml", "flywheel_harbor_agent/benchmark-rules.md", "flywheel_harbor_agent/shim.py", "harbor-agent.json", "pyproject.toml", "runtime/flywheel-linux-x64.tar.xz", "store-analysis/trial-store-analysis.js", "uv.lock"])
        self.assertEqual((output / "flywheel_harbor_agent" / "shim.py").read_text(), "committed shim\n")
        self.assertEqual(record["flywheel_source"], {"commit": self.commit, "version": "9.8.7", "release_tag": None})
        self.assertEqual(record["runtime_archive"], {"path": "runtime/flywheel-linux-x64.tar.xz", "sha256": hashlib.sha256(ARCHIVE).hexdigest()})
        self.assertEqual(record["benchmark_rules"], {"path": package.BENCHMARK_RULES_PATH, "sha256": hashlib.sha256(RULES).hexdigest()})
        self.assertEqual(record["flywheel_config"]["sha256"], hashlib.sha256(CONFIG).hexdigest())
        self.assertEqual(record["store_analyzer"], {"path": package.STORE_ANALYZER_PATH, "source_path": package.STORE_ANALYZER_SOURCE, "sha256": hashlib.sha256(ANALYZER).hexdigest()})
        self.assertEqual((output / package.STORE_ANALYZER_PATH).read_bytes(), ANALYZER)
        self.assertEqual(record["claude_engine"], {**ENGINE_MANIFEST, "wheel": {"url": WHEEL_URL, "sha256": WHEEL_SHA256}})
        self.assertEqual(json.loads((output / "BUILD.json").read_text()), record)
        manifest = json.loads((output / "harbor-agent.json").read_text())
        self.assertEqual(manifest["version"], f"9.8.7+{record['build_id']}")
        self.assertEqual(manifest["runtime"]["entrypoint"], ["flywheel-acp"])
        _, again = self._build("second")
        self.assertEqual(again["build_id"], record["build_id"])

    def test_a_package_without_the_answer_key_rule_leaves_out_the_rules_file_and_is_another_build(self) -> None:
        _, with_rule = self._build("with")
        output, record = self._build("without", answer_key_rule=False)
        self.assertFalse((output / package.BENCHMARK_RULES_PATH).exists())
        self.assertIsNone(record["benchmark_rules"])
        self.assertEqual(record["shim_files"], with_rule["shim_files"])
        self.assertNotEqual(record["build_id"], with_rule["build_id"])

    def test_refuses_a_config_that_differs_from_the_validated_bytes(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "differs from the validated config"):
            self._build("refused", config_sha256="0" * 64)

    def test_refuses_a_commit_whose_claude_engine_differs_from_the_pinned_wheel_and_names_the_engine_it_needs(self) -> None:
        other = {"cli_version": "2.0.1", "sha256": hashlib.sha256(b"another engine").hexdigest()}

        def runtime(repository: Path, commit: str, archive: Path, analyzer: Path) -> dict:
            _runtime(repository, commit, archive, analyzer)
            return other

        with self.assertRaisesRegex(RuntimeError, r"runs Claude engine 2\.0\.1 .* bundles another engine .* Pin the claude-agent-sdk release of PyPI that bundles engine 2\.0\.1"):
            self._build("mismatch", runtime=runtime)

    def test_downloads_a_wheel_once_into_its_cache_and_refuses_one_that_differs_from_its_lock_hash(self) -> None:
        cache = self.root / "fresh-cache"
        served = self.root / "served.whl"
        wheel = {"url": served.as_uri(), "sha256": WHEEL_SHA256}
        served.write_bytes(_wheel(b"tampered engine"))
        with self.assertRaisesRegex(RuntimeError, "differs from its uv.lock hash"):
            package.cached_wheel(wheel, cache)
        self.assertEqual(list(cache.iterdir()), [])
        served.write_bytes(WHEEL)
        self.assertEqual(package.cached_wheel(wheel, cache).read_bytes(), WHEEL)
        served.unlink()
        self.assertEqual(package.cached_wheel(wheel, cache).read_bytes(), WHEEL)

    def test_limits_refuse_symlinks_and_oversized_packages(self) -> None:
        output, _ = self._build("limits")
        self.assertEqual(package.check_package_limits(output, 9, 10_000)["files"], 9)
        with self.assertRaisesRegex(RuntimeError, "exceeds"):
            package.check_package_limits(output, 8, 10_000)
        (output / "link").symlink_to(output / "uv.lock")
        with self.assertRaisesRegex(RuntimeError, "symlink"):
            package.check_package_limits(output, 100, 10_000)


class StoreAnalyzerBundleTest(unittest.TestCase):
    """The real bundler, on the tree of a commit whose analysis imports runtime source and no packages."""

    def setUp(self) -> None:
        environment = patch.dict(os.environ, HERMETIC_GIT_ENVIRONMENT)
        environment.start()
        self.addCleanup(environment.stop)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.repository, _ = _repository(self.root)
        (self.repository / "src").mkdir()
        (self.repository / "src" / "value.ts").write_text('export const value = "from the runtime source"\n')
        (self.repository / package.STORE_ANALYZER_SOURCE).write_text('import { value } from "../../src/value.ts"\nconsole.log(value)\n')
        _git(self.repository, "add", ".")
        _git(self.repository, "commit", "-qm", "analysis imports runtime source")
        self.commit = _git(self.repository, "rev-parse", "HEAD")

    def test_the_same_commit_gives_the_same_runnable_bundle_of_its_committed_source(self) -> None:
        (self.repository / "src" / "value.ts").write_text('export const value = "uncommitted"\n')
        bundles = []
        for name in ("first", "second"):
            tree = self.root / f"flywheel-runtime-build-{name}"
            tree.mkdir()
            package._commit_tree(self.repository, self.commit, tree)
            package.bundle_store_analyzer(tree, self.root / f"{name}.js")
            bundles.append((self.root / f"{name}.js").read_bytes())
        self.assertEqual(bundles[0], bundles[1])
        self.assertNotIn(b"flywheel-runtime-build-", bundles[0])
        ran = subprocess.run(["bun", str(self.root / "first.js")], cwd=self.root, check=True, capture_output=True, text=True)
        self.assertEqual(ran.stdout, "from the runtime source\n")


class ExecutableArchiveTest(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)

    def _payload(self, name: str) -> Path:
        """A payload tree as scripts/build-binary.ts stages it, with files that a trial does not need."""
        payload = self.root / name
        files = {
            "flywheel-bin": (b"executable", 0o755), "build.json": (b"{}", 0o644), "webview/local/index.html": (b"html", 0o644), "fonts/font.otf": (b"font", 0o644),
            "native/linux-x64/claude": (b"engine", 0o755), "native/linux-x64/libopentui.so": (b"library", 0o664),
            "native/linux-x64/node_modules/sharp/package.json": (b"{}", 0o600),
            **{legal: (b"legal", 0o644) for legal in package.LEGAL_FILES},
        }
        for path, (payload_bytes, mode) in files.items():
            (payload / path).parent.mkdir(parents=True, exist_ok=True)
            (payload / path).write_bytes(payload_bytes)
            (payload / path).chmod(mode)
        return payload

    def _members(self, archive: Path) -> dict[str, tuple[bytes, int]]:
        with tarfile.open(archive, "r:xz") as opened:
            return {member.name: (opened.extractfile(member).read(), member.mode) for member in opened.getmembers()}

    def test_keeps_the_executable_its_native_files_and_legal_files_in_the_same_bytes_again(self) -> None:
        first, second = self._payload("first"), self._payload("second")
        os.utime(second / "flywheel-bin", (1, 1))
        package.write_executable_archive(first, self.root / "first.tar.xz")
        package.write_executable_archive(second, self.root / "second.tar.xz")
        self.assertEqual((self.root / "first.tar.xz").read_bytes(), (self.root / "second.tar.xz").read_bytes())
        # The archive is xz throughout, as the shim opens it.
        lzma.decompress((self.root / "first.tar.xz").read_bytes())
        self.assertEqual(self._members(self.root / "first.tar.xz"), {
            "flywheel-bin": (b"executable", 0o755),
            "native/linux-x64/libopentui.so": (b"library", 0o644),
            "native/linux-x64/node_modules/sharp/package.json": (b"{}", 0o644),
            **{legal: (b"legal", 0o644) for legal in package.LEGAL_FILES},
        })

    def test_refuses_a_link_in_the_payload(self) -> None:
        payload = self._payload("linked")
        (payload / "native" / "linux-x64" / "link.so").symlink_to(payload / "native" / "linux-x64" / "libopentui.so")
        with self.assertRaisesRegex(RuntimeError, "not a regular file: native/linux-x64/link.so"):
            package.write_executable_archive(payload, self.root / "archive.tar.xz")


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
