import json
import os
import tempfile
import unittest
from pathlib import Path

from verifier_wheelhouse import (
    WheelhousePolicy,
    extract_requirements,
    prepare_wheelhouse,
    validate_wheelhouse,
)


class VerifierWheelhouseTest(unittest.TestCase):
    def test_extracts_pip_and_uvx_pins(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pip_script = root / "pip.sh"
            uvx_script = root / "uvx.sh"
            pip_script.write_text(
                "pip install pytest==8.4.1 requests==2.32.4 --break-system-packages\n",
                encoding="utf-8",
            )
            uvx_script.write_text(
                "uvx \\\n  -p 3.13 \\\n  -w pytest==8.4.1 \\\n  -w numpy==2.3.4 \\\n  pytest tests.py\n",
                encoding="utf-8",
            )

            self.assertEqual(
                extract_requirements([pip_script, uvx_script]),
                ("numpy==2.3.4", "pytest==8.4.1", "requests==2.32.4"),
            )

    def test_extracts_all_install_segments_and_with_equals(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / "test.sh"
            script.write_text(
                "pip install first==1 && pip install second==2\n"
                "uvx -p 3.13 --with=third==3 pytest tests.py\n",
                encoding="utf-8",
            )

            self.assertEqual(
                extract_requirements([script]),
                ("first==1", "second==2", "third==3"),
            )

    def test_rejects_unsupported_uvx_python(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / "test.sh"
            script.write_text("uvx -p 3.11 -w pytest==8.4.1 pytest tests.py\n", encoding="utf-8")

            with self.assertRaisesRegex(RuntimeError, "only 3.13 is sealed"):
                extract_requirements([script])

    def test_rejects_package_source_and_interpreter_overrides(self) -> None:
        commands = (
            "uvx --index https://example.invalid/simple -p 3.13 -w pytest==8.4.1 pytest tests.py\n",
            "pip install --python-version=3.11 pytest==8.4.1\n",
            "pip install --editable=git+https://example.invalid/package pytest==8.4.1\n",
        )
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / "test.sh"
            for command in commands:
                with self.subTest(command=command):
                    script.write_text(command, encoding="utf-8")
                    with self.assertRaisesRegex(RuntimeError, "unsupported"):
                        extract_requirements([script])

    def test_rejects_unpinned_verifier_dependency(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / "test.sh"
            script.write_text("pip install pytest\n", encoding="utf-8")

            with self.assertRaisesRegex(RuntimeError, "exact package pin"):
                extract_requirements([script])

    def test_rejects_missing_or_digest_mismatched_wheel(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            policy = WheelhousePolicy(("pytest==8.4.1",), ("manylinux_2_28_x86_64",))

            def download(requirement: str, platform: str, destination: Path) -> None:
                (destination / f"{requirement.split('==')[0]}-{platform}.whl").write_bytes(b"wheel")

            wheelhouse = prepare_wheelhouse(root, policy, download)
            validate_wheelhouse(wheelhouse, policy)
            manifest = json.loads((wheelhouse / "manifest.json").read_text(encoding="utf-8"))
            wheel = wheelhouse / manifest["files"][0]["name"]
            wheel.chmod(0o644)
            wheel.write_bytes(b"other")
            wheel.chmod(0o444)

            with self.assertRaisesRegex(RuntimeError, "digest"):
                validate_wheelhouse(wheelhouse, policy)

    def test_published_wheelhouse_is_read_only_and_reusable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            policy = WheelhousePolicy(("pytest==8.4.1",), ("manylinux_2_28_x86_64",))
            calls: list[tuple[str, str]] = []

            def download(requirement: str, platform: str, destination: Path) -> None:
                calls.append((requirement, platform))
                (destination / "pytest-8.4.1-py3-none-any.whl").write_bytes(b"wheel")

            first = prepare_wheelhouse(root, policy, download)
            second = prepare_wheelhouse(root, policy, download)

            self.assertEqual(first, second)
            self.assertEqual(calls, [("pytest==8.4.1", "manylinux_2_28_x86_64")])
            self.assertEqual(os.stat(first).st_mode & 0o777, 0o555)
            self.assertEqual(os.stat(first / "manifest.json").st_mode & 0o777, 0o444)
            self.assertEqual(os.stat(first / "pytest-8.4.1-py3-none-any.whl").st_mode & 0o777, 0o444)

    def test_removes_abandoned_stage_before_publication(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            policy = WheelhousePolicy(("pytest==8.4.1",), ("manylinux_2_28_x86_64",))
            abandoned = root / f".{policy.digest()}.interrupted"
            abandoned.mkdir()
            (abandoned / "partial.whl").write_bytes(b"partial")

            def download(_requirement: str, _platform: str, destination: Path) -> None:
                (destination / "pytest-8.4.1-py3-none-any.whl").write_bytes(b"wheel")

            prepare_wheelhouse(root, policy, download)

            self.assertFalse(abandoned.exists())

    def test_rebuilds_invalid_published_cache(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            policy = WheelhousePolicy(("pytest==8.4.1",), ("manylinux_2_28_x86_64",))
            invalid = root / policy.digest()
            invalid.mkdir()
            (invalid / "partial.whl").write_bytes(b"partial")

            def download(_requirement: str, _platform: str, destination: Path) -> None:
                (destination / "pytest-8.4.1-py3-none-any.whl").write_bytes(b"wheel")

            published = prepare_wheelhouse(root, policy, download)

            validate_wheelhouse(published, policy)

    def test_runner_consumes_the_typescript_preparation_plan(self) -> None:
        runner = (Path(__file__).parent / "run-harbor.sh").read_text(encoding="utf-8")
        authority = (Path(__file__).parent / "run-harbor.ts").read_text(encoding="utf-8")

        self.assertIn('array_field "$PLAN" wheelhouse_command', runner)
        self.assertIn('run-local "$PLAN"', runner)
        self.assertIn("verifier_wheelhouse.py", authority)
        self.assertIn('PIP_NO_INDEX: "1"', authority)
        self.assertIn('UV_NO_CONFIG: "1"', authority)
        self.assertNotIn("yaml", runner.lower())

    def test_runner_is_executable(self) -> None:
        runner = Path(__file__).parent / "run-harbor.sh"

        self.assertTrue(runner.stat().st_mode & 0o100)

    def test_runner_has_no_parallel_harbor_argument_path(self) -> None:
        runner = (Path(__file__).parent / "run-harbor.sh").read_text(encoding="utf-8")

        self.assertNotIn("HARBOR_ARGS", runner)
        self.assertNotIn("harbor run", runner)


if __name__ == "__main__":
    unittest.main()
