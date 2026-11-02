import asyncio
import fcntl
import hashlib
import gzip
import io
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import types
import tarfile
import threading
import unittest
import time
import zipfile
from pathlib import Path
from unittest.mock import patch


def _root_stdout(command):
    if command == "pwd -P":
        return "/workspace\n"
    if "_export_settled_sqlite" in command:
        return json.dumps({"sha256": "f" * 64, "size": 1})
    return ""

class _BaseInstalledAgent:
    async def exec_as_root(self, environment, **kwargs):
        return types.SimpleNamespace(stdout=_root_stdout(kwargs.get("command")))


def _with_prompt_template(function):
    return function


harbor = types.ModuleType("harbor")
modules = {
    "harbor": harbor,
    "harbor.agents": types.ModuleType("harbor.agents"),
    "harbor.agents.installed": types.ModuleType("harbor.agents.installed"),
    "harbor.agents.installed.base": types.ModuleType("harbor.agents.installed.base"),
    "harbor.environments": types.ModuleType("harbor.environments"),
    "harbor.environments.base": types.ModuleType("harbor.environments.base"),
    "harbor.models": types.ModuleType("harbor.models"),
    "harbor.models.agent": types.ModuleType("harbor.models.agent"),
    "harbor.models.agent.context": types.ModuleType("harbor.models.agent.context"),
}
modules["harbor.agents.installed.base"].BaseInstalledAgent = _BaseInstalledAgent
modules["harbor.agents.installed.base"].with_prompt_template = _with_prompt_template
modules["harbor.environments.base"].BaseEnvironment = object
modules["harbor.models.agent.context"].AgentContext = object
sys.modules.update(modules)


try:
    from . import flywheel_agent
    from .flywheel_agent import HARNESS_DIR, RUN_LOG, STATE_DIR, FlywheelHeadless, build_task_command
except ImportError:
    import flywheel_agent
    from flywheel_agent import HARNESS_DIR, RUN_LOG, STATE_DIR, FlywheelHeadless, build_task_command
TEST_DISABLED_TOOLS = json.dumps(["web"])
# Real Git runs read no global or system configuration, the same isolation that
# .env.test gives `bun test`. A global trace2 daemon can otherwise write into a
# temporary repository after the test removes it.
HERMETIC_GIT_ENVIRONMENT = {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}


def _init_git_repository(repository: Path) -> None:
    for arguments in (["init", "-q"], ["config", "user.email", "test@example.com"], ["config", "user.name", "Test"]):
        subprocess.run(["git", *arguments], cwd=repository, check=True)


def _tar_bytes(payload: bytes) -> bytes:
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as archive:
        info = tarfile.TarInfo("source.txt")
        info.size = len(payload)
        archive.addfile(info, io.BytesIO(payload))
    return output.getvalue()


def _assert_synthetic_source_archive(
    test_case: unittest.TestCase, compressed_bytes: bytes, source_payload: bytes
) -> None:
    asset_paths = (
        Path("crates/ripgrep/flywheel-ripgrep.linux-arm64.node"),
        Path("crates/ripgrep/flywheel-ripgrep.linux-x64.node"),
        Path("crates/tokenizer/flywheel-tokenizer.wasm.zst"),
        Path("crates/tokenizer/tokenizer-prebuilt.json"),
    )
    with tarfile.open(fileobj=io.BytesIO(compressed_bytes), mode="r:gz") as archive:
        test_case.assertEqual(
            archive.getnames(),
            ["source.txt", *(path.as_posix() for path in asset_paths)],
        )
        test_case.assertEqual(archive.extractfile("source.txt").read(), source_payload)
        for asset_path in asset_paths:
            test_case.assertEqual(
                archive.extractfile(asset_path.as_posix()).read(),
                (flywheel_agent.REPO_ROOT / asset_path).read_bytes(),
            )


def _write_synthetic_repository(repository: Path, source_payload: bytes) -> None:
    (repository / "source.txt").parent.mkdir(parents=True, exist_ok=True)
    (repository / "source.txt").write_bytes(source_payload)
    for asset_path in flywheel_agent.RUNTIME_ASSET_ARCHIVE_PATHS:
        asset = repository / asset_path
        asset.parent.mkdir(parents=True, exist_ok=True)
        asset.write_bytes((flywheel_agent.REPO_ROOT / asset_path).read_bytes())


def _transaction_fixture(root: Path, *, blocking_bun: bool = False):
    release = root / "release"
    release.mkdir()
    architecture = os.uname().machine
    asset = "bun-linux-test.zip"
    bun_directory = asset.removesuffix(".zip")
    gate = root / "bun-release"
    bun_log = root / "bun.log"
    wait = (
        'printf "started\\n" >> "$BUN_TEST_LOG"\n'
        'while test ! -e "$BUN_TEST_GATE"; do sleep 0.01; done\n'
        if blocking_bun
        else ""
    )
    bun_script = f"#!/bin/sh\nset -eu\n{wait}test \"$1 $2 $3\" = 'install --frozen-lockfile --ignore-scripts'\n"
    archive = release / asset
    with zipfile.ZipFile(archive, "w") as bundle:
        info = zipfile.ZipInfo(f"{bun_directory}/bun")
        info.external_attr = 0o755 << 16
        bundle.writestr(info, bun_script)
    asset_digest = hashlib.sha256(archive.read_bytes()).hexdigest()

    harness = root / "harness.tar.gz"
    with tarfile.open(harness, "w:gz") as bundle:
        for name, payload in (("package.json", b"{}"), ("marker", b"new harness")):
            info = tarfile.TarInfo(name)
            info.size = len(payload)
            bundle.addfile(info, io.BytesIO(payload))
    return release, {architecture: (asset, asset_digest)}, harness, gate, bun_log


def _flock_fixture(root: Path) -> Path:
    bin_dir = root / "test-bin"
    bin_dir.mkdir()
    flock = bin_dir / "flock"
    flock.write_text(
        "#!/usr/bin/env python3\n"
        "import fcntl, os, sys\n"
        "if sys.argv[1:] == ['-x', '9']:\n"
        "    fcntl.flock(9, fcntl.LOCK_EX)\n"
        "elif len(sys.argv) == 4 and sys.argv[1] == '-n':\n"
        "    descriptor = os.open(sys.argv[2], os.O_RDWR)\n"
        "    try:\n"
        "        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)\n"
        "    except BlockingIOError:\n"
        "        raise SystemExit(1)\n"
        "else:\n"
        "    raise SystemExit(2)\n"
    )
    flock.chmod(0o755)
    return bin_dir

class BuildTaskCommandTest(unittest.TestCase):
    def test_builds_persistent_headless_task_invocation(self) -> None:
        instruction = "repair the user's file"

        command = build_task_command(instruction, "bench-profile", "/tmp/flywheel-auth-bundle-x/auth.json", ("web", "read"))
        tokens = shlex.split(command)
        self.assertEqual(tokens[:3], ["/bin/bash", "-o", "pipefail"])
        inner_tokens = shlex.split(tokens[-1])

        self.assertEqual(inner_tokens.count("--allow-persistent-processes"), 1)
        self.assertEqual(inner_tokens.count("--headless"), 1)
        self.assertEqual(inner_tokens.count("--task"), 1)
        self.assertEqual(inner_tokens[inner_tokens.index("--task") + 1], instruction)
        self.assertEqual([inner_tokens[index + 1] for index, token in enumerate(inner_tokens) if token == "--disable-tool"], ["web", "read"])
        self.assertNotIn("--interaction-profile", inner_tokens)
        self.assertNotIn(f'mkdir -p {STATE_DIR}', command)
        self.assertIn('export FLYWHEEL_PROJECT_ROOT="$PWD"', command)
        self.assertNotIn("flywheel.sqlite", command)
        self.assertIn(
            f'bun --conditions=browser {HARNESS_DIR}/src/cli/index.ts', command
        )
        self.assertIn(f"2>&1 | tee {RUN_LOG}; status=${{PIPESTATUS[0]}}", tokens[-1])

    def test_passes_system_prompt_as_one_quoted_argument(self) -> None:
        prompt = "literal prompt\nwith 'quotes' and $shell\n\n"
        command = build_task_command("task", "bench-profile", "/tmp/auth.json", system_prompt=prompt)
        inner_tokens = shlex.split(shlex.split(command)[-1])
        self.assertEqual(inner_tokens.count("--system-prompt"), 1)
        self.assertEqual(inner_tokens[inner_tokens.index("--system-prompt") + 1], prompt)


    def test_rejects_a_malformed_profile_digest_and_execution_contract(self) -> None:
        self.assertEqual(FlywheelHeadless(profile_sha256="a" * 64).profile_sha256, "a" * 64)
        with self.assertRaisesRegex(ValueError, "profile_sha256"):
            FlywheelHeadless(profile_sha256="bad")
        with self.assertRaisesRegex(ValueError, "execution contract"):
            FlywheelHeadless(project_root_mode="logs")
    def test_reads_exact_private_prompt_payload_and_rejects_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            payload = Path(directory) / "prompt"
            prompt = "literal prompt\n\n"
            payload.write_bytes(prompt.encode("utf-8"))
            payload.chmod(0o600)
            digest = hashlib.sha256(prompt.encode("utf-8")).hexdigest()
            self.assertEqual(flywheel_agent._read_system_prompt_payload(str(payload), digest), prompt)
            with self.assertRaisesRegex(RuntimeError, "SHA-256 mismatch"):
                flywheel_agent._read_system_prompt_payload(str(payload), "0" * 64)
            payload.chmod(0o644)
            with self.assertRaisesRegex(RuntimeError, "mode-0600"):
                flywheel_agent._read_system_prompt_payload(str(payload), digest)

    def test_adds_deadline_without_changing_pipefail_or_flags(self) -> None:
        command = build_task_command("task", "bench-profile", "/tmp/flywheel-auth-bundle-x/auth.json", deadline_seconds=95)
        tokens = shlex.split(command)
        inner_tokens = shlex.split(tokens[-1])
        self.assertEqual(tokens[:3], ["/bin/bash", "-o", "pipefail"])
        self.assertEqual(inner_tokens[inner_tokens.index("--deadline-seconds") + 1], "95")
        self.assertEqual(inner_tokens.count("--headless"), 1)
        self.assertEqual(inner_tokens.count("--task"), 1)

    def test_returns_producer_failure_while_tee_keeps_live_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bin_dir = root / "opt" / "flywheel-bun" / "bin"
            bin_dir.mkdir(parents=True)
            bun = bin_dir / "bun"
            bun.write_text("#!/bin/sh\nprintf 'producer output\\n'\nexit 23\n")
            bun.chmod(0o755)
            run_log = root / "flywheel.txt"
            state_dir = root / "state"
            with patch.object(flywheel_agent, "RUN_LOG", str(run_log)), patch.object(
                flywheel_agent, "STATE_DIR", str(state_dir)
            ), patch.object(flywheel_agent, "ROOT_BUN_BIN_DIR", str(bin_dir)):
                result = subprocess.run(
                    build_task_command("task", "bench-profile", "/tmp/flywheel-auth-bundle-x/auth.json"),
                    shell=True,
                    executable="/bin/sh",
                    env={"PATH": os.environ["PATH"]},
                    capture_output=True,
                    text=True,
                )

            self.assertEqual(result.returncode, 23)
            self.assertEqual(result.stdout, "producer output\n")
            self.assertEqual(run_log.read_text(), "producer output\n")


class FinalizationProfileTest(unittest.TestCase):
    DIGEST = "sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a"

    def test_profiles_pin_one_ordinary_task_attempt(self) -> None:
        profiles_dir = Path(__file__).parent / "profiles"
        for task_name in ("prove-plus-comm", "kv-store-grpc"):
            with self.subTest(task_name=task_name):
                profile = (profiles_dir / f"finalization-{task_name}.yaml").read_text()
                self.assertIn(f"  ref: {self.DIGEST}\n", profile)
                self.assertIn(f"  - terminal-bench/{task_name}\n", profile)
                self.assertIn("n_attempts: 1\n", profile)
                self.assertIn("n_concurrent_trials: 1\n", profile)
                self.assertEqual(profile.count("  - terminal-bench/"), 1)
                self.assertNotIn("experiment", profile.lower())
                self.assertNotIn("adapter", profile.lower())



class DeadlineAuthorityTest(unittest.TestCase):
    def test_resolves_exact_executed_digest_from_trial_lock(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            logs = root / "task-name__trialhash" / "agent"
            logs.mkdir(parents=True)
            digest = "a" * 64
            (logs.parent / "lock.json").write_text(json.dumps({"task": {"name": "terminal-bench/task-name", "digest": f"sha256:{digest}"}}))
            task_dir = root / "cache" / "terminal-bench" / "task-name" / digest
            task_dir.mkdir(parents=True)
            (task_dir / "task.toml").write_text("[agent]\ntimeout_sec = 1200\n")

            authority = flywheel_agent._resolve_deadline_authority(
                logs, "terminal-bench/terminal-bench-2-1", root / "cache"
            )

            self.assertEqual(authority.cap_seconds, 1200)
            self.assertEqual(authority.task_digest, f"sha256:{digest}")
            self.assertEqual(authority.provenance, "executed-task-digest")

    def test_refuses_name_only_dataset_and_records_deadline_blind_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            logs = root / "task-name__trialhash" / "agent"
            logs.mkdir(parents=True)
            authority = flywheel_agent._resolve_deadline_authority(logs, "terminal-bench-2-1", root)
            self.assertIsNone(authority.cap_seconds)
            self.assertEqual(authority.provenance, "deadline-blind:dataset-identity-ambiguous")


class RunSummaryTest(unittest.TestCase):
    def test_uses_latest_complete_summary_and_writes_canonical_evidence_atomically(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            logs = Path(directory)
            first = {"version": 1, "termination": {"kind": "failure"}, "usage": {"costUsd": 1}}
            latest = {"version": 1, "termination": {"kind": "deadline", "deadlineSeconds": 95}, "usage": {"costUsd": 2, "inputTokens": 3, "cacheReadTokens": 4, "outputTokens": 5}}
            (logs / "flywheel.txt").write_text(f"{json.dumps(first)}\n{{broken\n{json.dumps(latest)}\npartial")

            evidence = flywheel_agent._write_run_summary(
                logs,
                flywheel_agent.AdapterSettlement("flywheel-deadline", False),
                flywheel_agent.DeadlineAuthority(1200, "sha256:" + "a" * 64, "executed-task-digest"),
            )

            self.assertEqual(evidence["termination"], latest["termination"])
            self.assertEqual(evidence["usage"], latest["usage"])
            self.assertFalse(evidence["captured_after_cancellation"])
            self.assertEqual(json.loads((logs / "flywheel-run-summary.json").read_text()), evidence)

    def test_reads_the_fired_deadline_from_each_termination_version_by_its_one_key(self) -> None:
        self.assertTrue(flywheel_agent._deadline_fired({"termination": {"version": 1, "deadline_expired": True, "deadlineFired": False}}))
        self.assertTrue(flywheel_agent._deadline_fired({"termination": {"version": 2, "deadlineFired": True}}))
        self.assertFalse(flywheel_agent._deadline_fired({"termination": {"version": 2, "deadline_expired": True, "deadlineFired": False}}))
        self.assertFalse(flywheel_agent._deadline_fired(None))

    def test_marks_capture_only_for_observed_cancellation_or_hard_timeout(self) -> None:
        self.assertTrue(flywheel_agent.AdapterSettlement("harbor-cancellation", True).captured_after_cancellation)
        self.assertTrue(flywheel_agent.AdapterSettlement("adapter-timeout", True).captured_after_cancellation)
        self.assertFalse(flywheel_agent.AdapterSettlement("failure", False).captured_after_cancellation)
class AuthSnapshotExportTest(unittest.IsolatedAsyncioTestCase):
    COMMIT = "a" * 40

    def _blobs(self) -> tuple[flywheel_agent._GitBlob, ...]:
        return (
            flywheel_agent._GitBlob(Path("bun.lock"), "0" * 40, 0, 0o100644, b""),
            flywheel_agent._GitBlob(Path("package.json"), "1" * 40, 2, 0o100644, b"{}"),
            flywheel_agent._GitBlob(
                Path("src/cli/index.ts"), "2" * 40, 26, 0o100755, b"committed entrypoint bytes"
            ),
        )

    def test_materializes_exact_blob_bytes_outside_repository_and_cleans(self) -> None:
        with tempfile.TemporaryDirectory() as directory, patch.object(
            flywheel_agent, "REPO_ROOT", Path(directory)
        ), patch.object(flywheel_agent, "_pinned_git_blobs", return_value=self._blobs()) as blobs:
            with flywheel_agent._materialized_pinned_runtime(self.COMMIT) as runtime_root:
                entrypoint = runtime_root / "src/cli/index.ts"
                self.assertEqual(entrypoint.read_bytes(), b"committed entrypoint bytes")
                self.assertEqual(entrypoint.stat().st_mode & 0o777, 0o700)
                self.assertEqual(runtime_root.stat().st_mode & 0o777, 0o700)
                self.assertNotIn(Path(directory).resolve(), runtime_root.resolve().parents)
                materialized_root = runtime_root
            self.assertFalse(materialized_root.exists())
        blobs.assert_called_once_with(self.COMMIT)

    def test_materialization_rejects_file_directory_collision_and_cleans(self) -> None:
        blobs = (
            flywheel_agent._GitBlob(Path("src"), "1" * 40, 4, 0o100644, b"file"),
            flywheel_agent._GitBlob(Path("src/cli/index.ts"), "2" * 40, 5, 0o100644, b"entry"),
        )
        staged = []
        real_mkdtemp = tempfile.mkdtemp

        def capture_stage(*args, **kwargs):
            path = real_mkdtemp(*args, **kwargs)
            staged.append(Path(path))
            return path

        with tempfile.TemporaryDirectory() as directory, patch.object(
            flywheel_agent, "REPO_ROOT", Path(directory)
        ), patch.object(flywheel_agent, "_pinned_git_blobs", return_value=blobs), patch.object(
            flywheel_agent.tempfile, "mkdtemp", side_effect=capture_stage
        ):
            with self.assertRaisesRegex(RuntimeError, "non-directory"):
                with flywheel_agent._materialized_pinned_runtime(self.COMMIT):
                    self.fail("unsafe tree was materialized")
        self.assertEqual(len(staged), 1)
        self.assertFalse(staged[0].exists())

    def test_replacement_ref_cannot_change_pinned_blob_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, HERMETIC_GIT_ENVIRONMENT):
            repository = Path(directory)
            _init_git_repository(repository)
            for path in (*flywheel_agent.RIPGREP_ADDON_ARCHIVE_PATHS, Path("src/cli/index.ts")):
                target = repository / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(b"original" if path == Path("src/cli/index.ts") else b"addon")
            subprocess.run(["git", "add", "."], cwd=repository, check=True)
            subprocess.run(["git", "commit", "-qm", "original"], cwd=repository, check=True)
            pin = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repository, check=True, capture_output=True, text=True).stdout.strip()
            (repository / "src/cli/index.ts").write_bytes(b"replacement")
            subprocess.run(["git", "commit", "-qam", "replacement"], cwd=repository, check=True)
            replacement = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repository, check=True, capture_output=True, text=True).stdout.strip()
            replace_ref = repository / ".git" / "refs" / "replace" / pin
            replace_ref.parent.mkdir(parents=True)
            replace_ref.write_text(replacement + "\n")
            with patch.object(flywheel_agent, "REPO_ROOT", repository):
                blobs = flywheel_agent._pinned_git_blobs(pin)
        entrypoint = next(blob for blob in blobs if blob.relative_path == Path("src/cli/index.ts"))
        self.assertEqual(entrypoint.payload, b"original")

    def test_rev_parse_and_ls_tree_receive_remaining_deadline(self) -> None:
        deadline = time.monotonic() + 10
        with patch.object(subprocess, "run", side_effect=subprocess.TimeoutExpired("git", 0.01)) as run:
            with self.assertRaisesRegex(RuntimeError, "Git object query failed"):
                flywheel_agent._resolve_runtime_source_commit(self.COMMIT, deadline)
        self.assertGreater(run.call_args.kwargs["timeout"], 0)
        self.assertLessEqual(run.call_args.kwargs["timeout"], 10)

        with patch.object(flywheel_agent, "_git_object_command", side_effect=RuntimeError("stalled")) as query:
            with self.assertRaisesRegex(RuntimeError, "stalled"):
                flywheel_agent._pinned_git_blobs(self.COMMIT, deadline)
        self.assertEqual(query.call_args.kwargs["deadline"], deadline)
        self.assertEqual(query.call_args.args[0][0], "ls-tree")

    def test_cat_file_timeout_kills_and_reaps_process(self) -> None:
        addon_records = b"".join(
            f"100644 blob {'1' * 40}\t{path.as_posix()}\0".encode()
            for path in flywheel_agent.RIPGREP_ADDON_ARCHIVE_PATHS
        )

        class Process:
            returncode = None
            killed = False
            waited = False

            def communicate(self, _requests, *, timeout):
                self.timeout = timeout
                raise subprocess.TimeoutExpired("git cat-file", timeout)

            def kill(self):
                self.killed = True
                self.returncode = -9

            def wait(self):
                self.waited = True
                return self.returncode

        process = Process()
        with patch.object(flywheel_agent, "_git_object_command", return_value=addon_records), patch.object(
            subprocess, "Popen", return_value=process
        ):
            with self.assertRaisesRegex(RuntimeError, "Git object read failed"):
                flywheel_agent._pinned_git_blobs(self.COMMIT, time.monotonic() + 10)
        self.assertTrue(process.killed)
        self.assertTrue(process.waited)
        self.assertGreater(process.timeout, 0)
        self.assertLessEqual(process.timeout, 10)


    async def test_pinned_install_precedes_export_with_exact_argv_and_cwd(self) -> None:
        calls = []
        install_directories = {}

        class Process:
            returncode = 0

            def __init__(self, stdout):
                self.stdout = stdout

            async def communicate(self):
                return self.stdout, b"secret failure output"

        async def create(*argv, **kwargs):
            calls.append((argv, kwargs))
            if argv[:2] == ("bun", "install"):
                environment = kwargs["env"]
                for name in ("HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "TMPDIR"):
                    install_directories[name] = Path(environment[name]).stat().st_mode & 0o777
            return Process(b"bench-profile\n" if argv[1] == "--conditions=browser" else b"install output")

        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory)
            with patch.object(flywheel_agent, "REPO_ROOT", repository), patch.object(
                flywheel_agent, "_pinned_git_blobs", return_value=self._blobs()
            ), patch.object(asyncio, "create_subprocess_exec", side_effect=create), patch.dict(
                os.environ,
                {
                    flywheel_agent.AUTH_PROFILE_ENV: "secret selector",
                    flywheel_agent.SYSTEM_PROMPT_PATH_ENV: "/secret/prompt",
                    flywheel_agent.SYSTEM_PROMPT_SHA256_ENV: "secret digest",
                    "GENERIC_SECRET": "must-not-leak",
                    "NPM_TOKEN": "must-not-leak",
                    "HTTPS_PROXY": "https://user:password@example.test",
                    "SSL_CERT_FILE": "/public/ca.pem",
                },
            ):
                profile = await flywheel_agent._export_auth_snapshot(
                    "bench-profile", repository / "auth.json", None, self.COMMIT
                )
            runtime_root = Path(calls[0][1]["cwd"])
        self.assertEqual(profile, "bench-profile")
        self.assertEqual(calls[0][0], ("bun", "install", "--frozen-lockfile", "--ignore-scripts"))
        self.assertEqual(calls[1][0], (
            "bun", "--conditions=browser", str(runtime_root / "src/cli/index.ts"),
            "headless", "snapshot-auth", "--auth-profile", "bench-profile", "--output", str(repository / "auth.json"),
        ))
        self.assertEqual(calls[0][1]["cwd"], runtime_root)
        self.assertEqual(calls[1][1]["cwd"], runtime_root)
        self.assertNotIn(repository.resolve(), runtime_root.resolve().parents)
        self.assertNotIn(flywheel_agent.AUTH_PROFILE_ENV, calls[0][1]["env"])
        self.assertNotIn(flywheel_agent.SYSTEM_PROMPT_PATH_ENV, calls[0][1]["env"])
        self.assertNotIn(flywheel_agent.SYSTEM_PROMPT_SHA256_ENV, calls[0][1]["env"])
        self.assertEqual(
            set(calls[0][1]["env"]),
            {"PATH", "HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "TMPDIR", "SSL_CERT_FILE"},
        )
        self.assertEqual(calls[0][1]["env"]["SSL_CERT_FILE"], "/public/ca.pem")
        self.assertEqual(install_directories, {name: 0o700 for name in ("HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "TMPDIR")})
        self.assertTrue(all(Path(calls[0][1]["env"][name]).is_relative_to(runtime_root) for name in install_directories))
        self.assertFalse(runtime_root.exists())

    async def test_unpinned_export_preserves_exact_argv_and_cwd(self) -> None:
        observed = {}

        class Process:
            returncode = 0

            async def communicate(self):
                return b"bench-profile\n", b""

        async def create(*argv, **kwargs):
            observed.update(argv=argv, kwargs=kwargs)
            return Process()

        output = Path("auth.json")
        with patch.object(asyncio, "create_subprocess_exec", side_effect=create):
            await flywheel_agent._export_auth_snapshot("bench-profile", output, None)
        self.assertEqual(observed["argv"], (
            "bun", "--conditions=browser", str(flywheel_agent.REPO_ROOT / "src/cli/index.ts"),
            "headless", "snapshot-auth", "--auth-profile", "bench-profile", "--output", str(output),
        ))
        self.assertEqual(observed["kwargs"]["cwd"], flywheel_agent.REPO_ROOT)
        self.assertNotIn("env", observed["kwargs"])

    async def test_pinned_install_failure_timeout_and_cancellation_clean_stage(self) -> None:
        for outcome in ("failure", "timeout", "cancellation"):
            with self.subTest(outcome=outcome), tempfile.TemporaryDirectory() as directory:
                repository = Path(directory)
                stages = []

                class Process:
                    returncode = None
                    killed = False

                    async def communicate(self):
                        if outcome == "timeout":
                            await asyncio.sleep(60)
                        if outcome == "cancellation":
                            raise asyncio.CancelledError
                        self.returncode = 1
                        return b"install output", b"secret failure output"

                    def kill(self):
                        self.killed = True
                        self.returncode = -9

                    async def wait(self):
                        return self.returncode

                async def create(*_argv, **kwargs):
                    stages.append(Path(kwargs["cwd"]))
                    return Process()

                expected = asyncio.CancelledError if outcome == "cancellation" else RuntimeError
                timeout = 0.1 if outcome == "timeout" else None
                with patch.object(flywheel_agent, "REPO_ROOT", repository), patch.object(
                    flywheel_agent, "_pinned_git_blobs", return_value=self._blobs()
                ), patch.object(asyncio, "create_subprocess_exec", side_effect=create):
                    with self.assertRaises(expected):
                        await flywheel_agent._export_auth_snapshot(
                            "bench-profile", repository / "auth.json", timeout, self.COMMIT
                        )
                self.assertEqual(len(stages), 1)
                self.assertFalse(stages[0].exists())

    async def test_materialization_deadline_stops_worker_cleans_stage_and_skips_subprocess(self) -> None:
        stages = []
        subprocess_starts = 0
        real_write = os.write

        def slow_write(descriptor, payload):
            time.sleep(0.01)
            return real_write(descriptor, payload)

        async def create(*_argv, **_kwargs):
            nonlocal subprocess_starts
            subprocess_starts += 1
            raise AssertionError("subprocess must not start after materialization timeout")

        real_mkdtemp = tempfile.mkdtemp

        def capture_stage(*args, **kwargs):
            path = real_mkdtemp(*args, **kwargs)
            stages.append(Path(path))
            return path

        payload = b"x" * (1024 * 1024)
        blob = flywheel_agent._GitBlob(Path("src/cli/index.ts"), "1" * 40, len(payload), 0o100755, payload)
        started = time.monotonic()
        with patch.object(flywheel_agent, "_pinned_git_blobs", return_value=(blob,)), patch.object(
            flywheel_agent.os, "write", side_effect=slow_write
        ), patch.object(flywheel_agent.tempfile, "mkdtemp", side_effect=capture_stage), patch.object(
            asyncio, "create_subprocess_exec", side_effect=create
        ):
            with self.assertRaisesRegex(RuntimeError, "auth snapshot export failed"):
                await flywheel_agent._export_auth_snapshot("bench-profile", Path("auth.json"), 0.05, self.COMMIT)
        elapsed = time.monotonic() - started

        self.assertLess(elapsed, 1)
        self.assertTrue(stages)
        self.assertTrue(all(not stage.exists() for stage in stages))
        self.assertEqual(subprocess_starts, 0)


    async def test_cancellation_waits_for_materialization_before_stage_cleanup(self) -> None:
        started = threading.Event()
        release = threading.Event()
        stages = []

        def populate(runtime_root, _commit, _deadline):
            stages.append(runtime_root)
            started.set()
            release.wait(2)
            (runtime_root / "settled").write_text("yes")

        with patch.object(flywheel_agent, "_populate_pinned_runtime", side_effect=populate):
            running = asyncio.create_task(
                flywheel_agent._export_auth_snapshot("bench-profile", Path("auth.json"), 5, self.COMMIT)
            )
            await asyncio.to_thread(started.wait, 1)
            running.cancel()
            await asyncio.sleep(0)
            self.assertTrue(stages[0].exists())
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await running
        self.assertFalse(stages[0].exists())

    async def test_repeated_cancellation_reaps_export_child(self) -> None:
        wait_started = asyncio.Event()
        release_wait = asyncio.Event()
        reaped = False

        class Process:
            returncode = None

            def kill(self):
                self.returncode = -9

            async def wait(self):
                nonlocal reaped
                wait_started.set()
                await release_wait.wait()
                reaped = True

        running = asyncio.create_task(flywheel_agent._kill_and_reap(Process()))
        await wait_started.wait()
        running.cancel()
        await asyncio.sleep(0)
        running.cancel()
        release_wait.set()
        with self.assertRaises(asyncio.CancelledError):
            await running
        self.assertTrue(reaped)

class RunTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        self.test_home = Path(self.home.name).resolve()
        self.path_home = patch.object(Path, "home", return_value=self.test_home)
        self.path_home.start()
        self.addCleanup(self.path_home.stop)
        self.profile_root = self.test_home / ".flywheel" / "auth" / "profiles"
        self.profile_root.mkdir(parents=True, mode=0o700)
        profile = self.profile_root / "bench-profile"
        profile.mkdir(mode=0o700)
        (profile / "profile.json").write_text(json.dumps({"displayName": "bench-profile"}))
        (profile / "profile.json").chmod(0o600)
        self.snapshot_bundle = {
            "profile": "bench-profile",
            "credentials": {
                "openai_api": {"type": "api_key", "key": "openai-key"},
                "anthropic_api": {"type": "api_key", "key": "anthropic-key"},
                "opencode_go": {"type": "api_key", "key": "go-key"},
                "github_copilot": {"type": "oauth", "access": "copilot-token", "refresh": "github-token", "expires": 1},
            },
        }
        (profile / "auth.json").write_text(json.dumps(self.snapshot_bundle["credentials"]))
        (profile / "auth.json").chmod(0o600)
        self.profile_environment = patch.dict(os.environ, {flywheel_agent.AUTH_PROFILE_ENV: "bench-profile", flywheel_agent.DISABLED_TOOLS_ENV: TEST_DISABLED_TOOLS, "HOME": self.home.name})
        self.profile_environment.start()
        self.addCleanup(self.profile_environment.stop)
        async def export_auth_snapshot(selector, output, timeout, runtime_source_commit=None):
            output.write_text(json.dumps(self.snapshot_bundle))
            output.chmod(0o600)
            return "bench-profile"
        self.export_snapshot = patch.object(flywheel_agent, "_export_auth_snapshot", side_effect=export_auth_snapshot)
        self.export_snapshot_mock = self.export_snapshot.start()
        self.addCleanup(self.export_snapshot.stop)
        async def upload_file(source, destination):
            return None
        self.environment = types.SimpleNamespace(upload_file=upload_file, default_user="root")


    async def test_missing_profile_still_publishes_summary_and_attempts_cleanup(self) -> None:
        calls = []
        agent = FlywheelHeadless()
        agent._source_archive_sha256 = "a" * 64
        async def exec_as_agent(environment, **kwargs):
            calls.append(kwargs)
        agent.exec_as_agent = exec_as_agent
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {flywheel_agent.AUTH_PROFILE_ENV: "Missing", flywheel_agent.DISABLED_TOOLS_ENV: TEST_DISABLED_TOOLS, "HOME": self.home.name}, clear=True), patch.object(
            flywheel_agent, "_export_auth_snapshot", side_effect=RuntimeError("Flywheel auth snapshot export failed")
        ):
            agent.logs_dir = Path(directory)
            with self.assertRaisesRegex(RuntimeError, "snapshot export failed"):
                await agent.run("task", self.environment, object())
            summary = json.loads((Path(directory) / "flywheel-run-summary.json").read_text())

        self.assertEqual(summary["adapter_settlement"], "other-failure")
        self.assertTrue(any(call["command"].startswith("rm -rf --") for call in calls))
    async def test_transfers_provider_environment_without_exposing_secrets_to_harbor_logs(self) -> None:
        calls = []
        root_calls = []
        uploads = []
        agent = FlywheelHeadless()
        agent.flywheel_model = "test-model"
        agent._source_archive_sha256 = "a" * 64
        agent.runtime_source_commit = "a" * 40

        async def exec_as_agent(environment, **kwargs):
            calls.append(kwargs)
            if kwargs["command"].startswith("printf '%s:%s'"):
                return types.SimpleNamespace(stdout="1001:1002")

        async def exec_as_root(environment, **kwargs):
            root_calls.append(kwargs)
            return types.SimpleNamespace(stdout=_root_stdout(kwargs["command"]))

        async def upload_file(source, destination):
            path = Path(source)
            uploads.append((path.read_text(), destination, path.stat().st_mode & 0o777))

        agent.exec_as_agent = exec_as_agent
        agent.exec_as_root = exec_as_root
        environment = types.SimpleNamespace(upload_file=upload_file, default_user=None)
        with patch.dict(
            os.environ,
            {flywheel_agent.AUTH_PROFILE_ENV: "bench-profile", flywheel_agent.DISABLED_TOOLS_ENV: TEST_DISABLED_TOOLS},
            clear=True,
        ):
            await agent.run("task", environment, object())
        self.assertEqual(self.export_snapshot_mock.await_args.args[3], agent.runtime_source_commit)

        task_call = next(call for call in calls if "bun --conditions=browser" in call["command"])
        self.assertEqual(len(uploads), 1)
        auth_bundle, destination, mode = uploads[0]
        self.assertNotIn("FLYWHEEL_AUTH_PROFILE", task_call["env"])
        self.assertNotIn("FLYWHEEL_BENCHMARK_AUTH_FILE", task_call["env"])
        self.assertTrue(task_call["env"]["HOME"].startswith(flywheel_agent.ISOLATED_HOME_PREFIX))
        self.assertNotIn(flywheel_agent.DISABLED_TOOLS_ENV, task_call["env"])
        self.assertNotIn("FLYWHEEL_PROJECT_ROOT", task_call["env"])
        self.assertEqual(task_call["env"]["FLYWHEEL_CHAT_MODEL"], "test-model")
        self.assertEqual(task_call["env"]["PATH"], f"{flywheel_agent.ROOT_BUN_BIN_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
        self.assertEqual(task_call["env"]["BASH_ENV"], "/dev/null")
        self.assertEqual(task_call["env"]["ENV"], "/dev/null")
        self.assertNotIn("OPENAI_API_KEY", task_call["env"])
        self.assertNotIn("ANTHROPIC_API_KEY", task_call["env"])
        self.assertNotIn("OPENCODE_GO_API_KEY", task_call["env"])
        self.assertNotIn("timeout_sec", task_call)
        self.assertNotIn("provider.env", task_call["command"])
        self.assertIn("--auth-profile bench-profile", task_call["command"])
        self.assertIn("--allow-persistent-processes", task_call["command"])
        self.assertIn(f"--auth-snapshot {destination}", task_call["command"])
        self.assertNotIn("openai-key", json.dumps(calls))
        self.assertNotIn("anthropic-key", json.dumps(calls))
        self.assertNotIn("go-key", json.dumps(calls))
        self.assertNotIn("copilot-token", json.dumps(task_call["env"]))
        self.assertNotIn("github-token", json.dumps(task_call["env"]))
        self.assertEqual(mode, 0o600)
        self.assertEqual(len(root_calls), 4)
        self.assertIn("mkdir -m 700", root_calls[0]["command"])
        self.assertNotIn("chown", root_calls[0]["command"])
        self.assertIn("test -f", root_calls[1]["command"])
        self.assertIn("! test -L", root_calls[1]["command"])
        self.assertIn("chown 1001:1002", root_calls[1]["command"])
        self.assertIn("chmod 600", root_calls[1]["command"])
        self.assertTrue(destination.endswith("/auth.json"))
        self.assertEqual(json.loads(auth_bundle), self.snapshot_bundle)
        home_setup = next(call for call in calls if "mkdir -p -m 700" in call["command"])
        self.assertNotIn("flywheel.toml", home_setup["command"])
        self.assertLess(calls.index(home_setup), calls.index(task_call))

    def test_launcher_disabled_tools_are_required_and_strict(self) -> None:
        self.assertEqual(flywheel_agent._require_disabled_tools(TEST_DISABLED_TOOLS), ("web",))
        self.assertEqual(flywheel_agent._require_disabled_tools("[]"), ())
        for invalid in (None, "", "{}", '["web","web"]', '["../web"]', '["Web"]', '[""]'):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(RuntimeError, flywheel_agent.DISABLED_TOOLS_ENV):
                flywheel_agent._require_disabled_tools(invalid)

    async def test_provider_upload_consumes_the_authoritative_deadline(self) -> None:
        agent = FlywheelHeadless()
        agent._source_archive_sha256 = "a" * 64
        calls = []

        async def exec_as_agent(environment, **kwargs):
            calls.append(kwargs)

        async def upload_file(source, destination):
            await asyncio.sleep(1)

        agent.exec_as_agent = exec_as_agent
        environment = types.SimpleNamespace(upload_file=upload_file, default_user="root")
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {flywheel_agent.AUTH_PROFILE_ENV: "bench-profile", flywheel_agent.DISABLED_TOOLS_ENV: TEST_DISABLED_TOOLS}, clear=True), patch.object(
            flywheel_agent,
            "_resolve_deadline_authority",
            return_value=flywheel_agent.DeadlineAuthority(0.02, "sha256:" + "b" * 64, "test"),
        ):
            agent.logs_dir = Path(directory)
            with self.assertRaises(TimeoutError):
                await agent.run("task", environment, object())

        self.assertFalse(any("bun --conditions=browser" in call["command"] for call in calls))
        self.assertTrue(any(call["command"].startswith("rm -rf --") for call in calls))

    async def test_cancellation_during_provider_upload_records_capture_and_cleans_up(self) -> None:
        agent = FlywheelHeadless()
        agent._source_archive_sha256 = "a" * 64
        calls = []

        async def exec_as_agent(environment, **kwargs):
            calls.append(kwargs)

        async def upload_file(source, destination):
            raise asyncio.CancelledError()

        agent.exec_as_agent = exec_as_agent
        environment = types.SimpleNamespace(upload_file=upload_file, default_user="root")
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {flywheel_agent.AUTH_PROFILE_ENV: "bench-profile", flywheel_agent.DISABLED_TOOLS_ENV: TEST_DISABLED_TOOLS}, clear=True), patch.object(
            flywheel_agent,
            "_resolve_deadline_authority",
            return_value=flywheel_agent.DeadlineAuthority(10, "sha256:" + "b" * 64, "test"),
        ):
            agent.logs_dir = Path(directory)
            with self.assertRaises(asyncio.CancelledError):
                await agent.run("task", environment, object())
            summary = json.loads((Path(directory) / "flywheel-run-summary.json").read_text())

        self.assertEqual(summary["adapter_settlement"], "harbor-cancellation")
        self.assertTrue(summary["captured_after_cancellation"])
        self.assertTrue(any(call["command"].startswith("rm -rf --") for call in calls))

    async def test_repeated_cancellation_cannot_interrupt_cleanup_fallback(self) -> None:
        agent = FlywheelHeadless()
        agent._source_archive_sha256 = "a" * 64
        agent_cleanup_started = asyncio.Event()
        release_agent_cleanup = asyncio.Event()
        root_cleanup_started = asyncio.Event()
        release_root_cleanup = asyncio.Event()
        root_cleanup_completed = False

        async def exec_as_agent(environment, **kwargs):
            if kwargs["command"].startswith("rm -rf --"):
                agent_cleanup_started.set()
                await release_agent_cleanup.wait()
                raise RuntimeError("agent cleanup failed")

        async def exec_as_root(environment, **kwargs):
            nonlocal root_cleanup_completed
            if kwargs["command"].startswith("rm -rf --"):
                root_cleanup_started.set()
                await release_root_cleanup.wait()
                root_cleanup_completed = True
            return types.SimpleNamespace(stdout=_root_stdout(kwargs["command"]))

        async def upload_file(source, destination):
            raise asyncio.CancelledError()

        agent.exec_as_agent = exec_as_agent
        agent.exec_as_root = exec_as_root
        environment = types.SimpleNamespace(upload_file=upload_file, default_user="root")
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {flywheel_agent.AUTH_PROFILE_ENV: "bench-profile", flywheel_agent.DISABLED_TOOLS_ENV: TEST_DISABLED_TOOLS}, clear=True), patch.object(
            flywheel_agent,
            "_resolve_deadline_authority",
            return_value=flywheel_agent.DeadlineAuthority(10, "sha256:" + "b" * 64, "test"),
        ):
            agent.logs_dir = Path(directory)
            running = asyncio.create_task(agent.run("task", environment, object()))
            await agent_cleanup_started.wait()
            running.cancel()
            release_agent_cleanup.set()
            await root_cleanup_started.wait()
            running.cancel()
            release_root_cleanup.set()
            with self.assertRaises(asyncio.CancelledError):
                await running

        self.assertTrue(root_cleanup_completed)

    async def test_cancellation_that_starts_during_cleanup_waits_for_root_fallback(self) -> None:
        agent = FlywheelHeadless()
        agent._source_archive_sha256 = "a" * 64
        agent_cleanup_started = asyncio.Event()
        release_agent_cleanup = asyncio.Event()
        root_cleanup_started = asyncio.Event()
        release_root_cleanup = asyncio.Event()
        root_cleanup_completed = False

        async def exec_as_agent(environment, **kwargs):
            command = kwargs["command"]
            if command.startswith("rm -rf --"):
                agent_cleanup_started.set()
                await release_agent_cleanup.wait()
                raise RuntimeError("agent cleanup failed")
            return types.SimpleNamespace(stdout=_root_stdout(kwargs["command"]))

        async def exec_as_root(environment, **kwargs):
            nonlocal root_cleanup_completed
            if kwargs["command"].startswith("rm -rf --"):
                root_cleanup_started.set()
                await release_root_cleanup.wait()
                root_cleanup_completed = True
            return types.SimpleNamespace(stdout=_root_stdout(kwargs["command"]))

        async def upload_file(source, destination):
            return None

        agent.exec_as_agent = exec_as_agent
        agent.exec_as_root = exec_as_root
        environment = types.SimpleNamespace(upload_file=upload_file, default_user="root")
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {flywheel_agent.AUTH_PROFILE_ENV: "bench-profile", flywheel_agent.DISABLED_TOOLS_ENV: TEST_DISABLED_TOOLS}, clear=True), patch.object(
            flywheel_agent,
            "_resolve_deadline_authority",
            return_value=flywheel_agent.DeadlineAuthority(10, "sha256:" + "b" * 64, "test"),
        ):
            agent.logs_dir = Path(directory)
            running = asyncio.create_task(agent.run("task", environment, object()))
            await agent_cleanup_started.wait()
            running.cancel()
            release_agent_cleanup.set()
            await root_cleanup_started.wait()
            running.cancel()
            release_root_cleanup.set()
            with self.assertRaises(asyncio.CancelledError):
                await running
            summary = json.loads((Path(directory) / "flywheel-run-summary.json").read_text())

        self.assertTrue(root_cleanup_completed)
        self.assertEqual(summary["adapter_settlement"], "harbor-cancellation")

    async def test_root_cleanup_fallback_and_summary_failure_do_not_replace_the_task_failure(self) -> None:
        agent = FlywheelHeadless()
        agent._source_archive_sha256 = "a" * 64
        agent.model_name = None
        root_calls = []
        async def exec_as_agent(environment, **kwargs):
            command = kwargs["command"]
            if "bun --conditions=browser" in command:
                raise RuntimeError("primary task failure")
            if command.startswith("rm -rf --"):
                raise RuntimeError("cleanup failure")

        async def exec_as_root(environment, **kwargs):
            root_calls.append(kwargs)
            return types.SimpleNamespace(stdout=_root_stdout(kwargs["command"]))

        async def upload_file(source, destination):
            return None

        agent.exec_as_agent = exec_as_agent
        agent.exec_as_root = exec_as_root
        environment = types.SimpleNamespace(upload_file=upload_file, default_user="root")
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {flywheel_agent.AUTH_PROFILE_ENV: "bench-profile", flywheel_agent.DISABLED_TOOLS_ENV: TEST_DISABLED_TOOLS}, clear=True), patch.object(
            flywheel_agent,
            "_resolve_deadline_authority",
            return_value=flywheel_agent.DeadlineAuthority(None, None, "test"),
        ), patch.object(flywheel_agent, "_write_run_summary", side_effect=RuntimeError("summary failure")):
            agent.logs_dir = Path(directory)
            with self.assertRaisesRegex(RuntimeError, "primary task failure") as raised:
                await agent.run("task", environment, object())

        notes = " ".join(raised.exception.__notes__)
        self.assertNotIn("cleanup failure", notes)
        self.assertIn("summary failure", notes)
        self.assertTrue(root_calls[-1]["command"].startswith("rm -rf --"))
    async def test_forwards_lifecycle_trace_only_when_explicitly_enabled(self) -> None:
        calls = []
        agent = FlywheelHeadless()
        agent.model_name = None
        agent._source_archive_sha256 = "a" * 64

        async def exec_as_agent(environment, **kwargs):
            calls.append(kwargs)

        agent.exec_as_agent = exec_as_agent
        for supplied_value, expected_value in (("1", "1"), ("true", None), ("0", None), ("", None)):
            calls.clear()
            with self.subTest(supplied_value=supplied_value), patch.dict(
                os.environ,
                {flywheel_agent.AUTH_PROFILE_ENV: "bench-profile", flywheel_agent.DISABLED_TOOLS_ENV: TEST_DISABLED_TOOLS, "FLYWHEEL_TOOL_LIFECYCLE_TRACE": supplied_value},
                clear=True,
            ):
                await agent.run("task", self.environment, object())
                actual = next(call for call in calls if "env" in call)["env"].get("FLYWHEEL_TOOL_LIFECYCLE_TRACE")
                self.assertEqual(actual, expected_value)

    async def test_install_skips_apt_when_bootstrap_dependencies_exist(self) -> None:
        root_calls = []
        agent_calls = []
        agent = FlywheelHeadless()

        async def exec_as_root(environment, **kwargs):
            root_calls.append(kwargs)
            return types.SimpleNamespace(stdout="ready\n", return_code=0)

        async def exec_as_agent(environment, **kwargs):
            agent_calls.append(kwargs)
            return types.SimpleNamespace(stdout="", return_code=0)

        async def upload_harness(environment):
            agent._source_archive_sha256 = "a" * 64

        agent.exec_as_root = exec_as_root
        agent.exec_as_agent = exec_as_agent
        agent._upload_harness = upload_harness

        await agent.install(object())

        self.assertEqual(root_calls[0]["command"], flywheel_agent.BOOTSTRAP_PROBE_COMMAND)
        self.assertFalse(any("apt-get" in call["command"] for call in root_calls))
        transaction = root_calls[-2]["command"]
        self.assertIn(flywheel_agent.BUN_RELEASE_BASE_URL, transaction)
        self.assertIn("bun-v1.4.4", transaction)
        self.assertNotIn("bun.sh/install", transaction)
        self.assertFalse(agent_calls)


    async def test_install_publishes_from_root_verified_archive_and_cleans_private_stage(self) -> None:
        root_calls = []
        agent_calls = []
        agent = FlywheelHeadless()

        async def exec_as_root(environment, **kwargs):
            root_calls.append(kwargs)
            return types.SimpleNamespace(stdout="ready\n", return_code=0)

        async def exec_as_agent(environment, **kwargs):
            agent_calls.append(kwargs)
            return types.SimpleNamespace(stdout="", return_code=0)

        async def upload_harness(environment):
            agent._source_archive_sha256 = "a" * 64

        agent.exec_as_root = exec_as_root
        agent.exec_as_agent = exec_as_agent
        agent._upload_harness = upload_harness

        await agent.install(object())

        stage = agent._harness_staging_dir
        self.assertIsNotNone(stage)
        publish = root_calls[-2]["command"]
        ownership_index = publish.index(f"chown -R root:root {stage}")
        verify_index = publish.index("sha256sum -c -", publish.index("sha256sum -c -") + 1)
        extract_index = publish.index("tar xzf")
        dependency_index = publish.index("bun install --frozen-lockfile --ignore-scripts")
        self.assertLess(ownership_index, verify_index)
        self.assertLess(verify_index, extract_index)
        self.assertLess(extract_index, dependency_index)
        self.assertIn(flywheel_agent.ROOT_BUN_BIN_DIR, publish)
        self.assertNotIn("cp -a", publish)
        self.assertNotIn(f"{stage}/node_modules", publish)
        self.assertIn(f"mv -- {HARNESS_DIR}", publish)
        self.assertRegex(publish, r"mv -- /opt/\.flywheel-harness-[a-f0-9]{32} /opt/flywheel-harness")
        self.assertIn("chmod -R u=rwX,go=rX", publish)
        self.assertIn("trap", publish)
        self.assertIn("rm -rf --", root_calls[-1]["command"])
        self.assertFalse(agent_calls)

    async def test_each_install_uses_a_unique_unpredictable_stage(self) -> None:
        stages = []
        agent = FlywheelHeadless()

        async def exec_as_root(environment, **kwargs):
            return types.SimpleNamespace(stdout="ready\n", return_code=0)

        async def exec_as_agent(environment, **kwargs):
            return types.SimpleNamespace(stdout="", return_code=0)

        async def upload_harness(environment):
            agent._source_archive_sha256 = "a" * 64

        agent.exec_as_root = exec_as_root
        agent.exec_as_agent = exec_as_agent
        agent._upload_harness = upload_harness
        for _ in range(2):
            await agent.install(object())
            stages.append(agent._harness_staging_dir)

        self.assertEqual(len(set(stages)), 2)
        for stage in stages:
            self.assertRegex(stage, r"^/tmp/flywheel-harness-[a-f0-9]{32}$")

    async def test_publication_failure_cleans_stage(self) -> None:
        root_calls = []
        agent = FlywheelHeadless()

        async def exec_as_root(environment, **kwargs):
            root_calls.append(kwargs)
            if len(root_calls) == 2:
                raise RuntimeError("publication failed")
            return types.SimpleNamespace(stdout="ready\n", return_code=0)

        async def exec_as_agent(environment, **kwargs):
            return types.SimpleNamespace(stdout="", return_code=0)

        async def upload_harness(environment):
            agent._source_archive_sha256 = "a" * 64

        agent.exec_as_root = exec_as_root
        agent.exec_as_agent = exec_as_agent
        agent._upload_harness = upload_harness

        with self.assertRaisesRegex(RuntimeError, "publication failed"):
            await agent.install(object())

        self.assertIn(agent._harness_staging_dir, root_calls[-1]["command"])
        self.assertIn("rm -rf --", root_calls[-1]["command"])

    def test_cleanup_restores_backup_over_an_uncommitted_replacement(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            final = root / "final"
            backup = root / "backup"
            stage = root / "stage"
            publish = root / "publish"
            final.mkdir()
            (final / "marker").write_text("replacement harness")
            backup.mkdir()
            (backup / "marker").write_text("old harness")
            stage.mkdir()
            publish.mkdir()

            test_bin = _flock_fixture(root)
            result = subprocess.run(
                flywheel_agent._cleanup_install_command(
                    stage,
                    publish,
                    backup,
                    final,
                    lock_path=root / "install.lock",
                    owner=f"{os.getuid()}:{os.getgid()}",
                ),
                shell=True,
                executable="/bin/sh",
                env={**os.environ, "PATH": f"{test_bin}:{os.environ['PATH']}"},
                capture_output=True,
                text=True,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((final / "marker").read_text(), "old harness")
            self.assertFalse(stage.exists())
            self.assertFalse(publish.exists())
            self.assertFalse(backup.exists())

    def test_cleanup_restores_backup_when_publication_stopped_before_final_move(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            final = root / "final"
            backup = root / "backup"
            stage = root / "stage"
            publish = root / "publish"
            backup.mkdir()
            (backup / "marker").write_text("old harness")
            stage.mkdir()
            publish.mkdir()
            Path(f"{backup}.publication").write_text("interrupted publication\n")

            test_bin = _flock_fixture(root)
            result = subprocess.run(
                flywheel_agent._cleanup_install_command(
                    stage,
                    publish,
                    backup,
                    final,
                    lock_path=root / "install.lock",
                    owner=f"{os.getuid()}:{os.getgid()}",
                ),
                shell=True,
                executable="/bin/sh",
                env={**os.environ, "PATH": f"{test_bin}:{os.environ['PATH']}"},
                capture_output=True,
                text=True,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((final / "marker").read_text(), "old harness")
            self.assertFalse(backup.exists())
            self.assertFalse(publish.exists())

    def test_fallback_cleanup_waits_and_preserves_a_newer_publication(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            final = root / "final"
            backup = root / "backup"
            stage = root / "stage"
            publish = root / "publish"
            newer = root / "newer"
            lock_path = root / "install.lock"
            gate = root / "release-lock"
            ready = root / "lock-held"
            for path, marker in (
                (final, "uncommitted harness"),
                (backup, "old harness"),
                (stage, "stage"),
                (publish, "publish"),
                (newer, "newer harness"),
            ):
                path.mkdir()
                (path / "marker").write_text(marker)
            publication_marker = Path(f"{backup}.publication")
            final_marker = final / ".flywheel-install-publication"
            publication_marker.write_text("old publication\n")
            final_marker.write_text("old publication\n")
            lock_path.touch()
            test_bin = _flock_fixture(root)
            holder = subprocess.Popen(
                [
                    "bash",
                    "-c",
                    (
                        f"exec 9<> {shlex.quote(str(lock_path))}; flock -x 9; "
                        f"touch {shlex.quote(str(ready))}; "
                        f"while test ! -e {shlex.quote(str(gate))}; do sleep 0.01; done; "
                        f"rm -rf -- {shlex.quote(str(final))}; "
                        f"mv -- {shlex.quote(str(newer))} {shlex.quote(str(final))}"
                    ),
                ],
                env={**os.environ, "PATH": f"{test_bin}:{os.environ['PATH']}"},
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            cleanup = None
            try:
                deadline = time.monotonic() + 5
                while not ready.exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(ready.exists())
                cleanup = subprocess.Popen(
                    [
                        "bash",
                        "-c",
                        flywheel_agent._cleanup_install_command(
                            stage,
                            publish,
                            backup,
                            final,
                            lock_path=lock_path,
                            owner=f"{os.getuid()}:{os.getgid()}",
                        ),
                    ],
                    env={**os.environ, "PATH": f"{test_bin}:{os.environ['PATH']}"},
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                )
                time.sleep(0.05)
                self.assertIsNone(cleanup.poll())
                self.assertEqual((final / "marker").read_text(), "uncommitted harness")
                gate.touch()
                holder_stdout, holder_stderr = holder.communicate(timeout=5)
                cleanup_stdout, cleanup_stderr = cleanup.communicate(timeout=5)
                self.assertEqual(holder.returncode, 0, holder_stdout + holder_stderr)
                self.assertEqual(cleanup.returncode, 0, cleanup_stdout + cleanup_stderr)
                self.assertEqual((final / "marker").read_text(), "newer harness")
                self.assertFalse(backup.exists())
                self.assertFalse(stage.exists())
                self.assertFalse(publish.exists())
                self.assertFalse(publication_marker.exists())
            finally:
                gate.touch()
                if holder.poll() is None:
                    holder.kill()
                    holder.communicate()
                if cleanup is not None and cleanup.poll() is None:
                    cleanup.kill()
                    cleanup.communicate()

    def test_generated_transaction_restores_old_final_after_post_move_failure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            release, assets, harness, _, _ = _transaction_fixture(root)
            stage = root / "stage"
            stage.mkdir()
            (stage / "harness.tar.gz").write_bytes(harness.read_bytes())
            final = root / "final"
            final.mkdir()
            (final / "marker").write_text("old harness")
            publish = root / "publish"
            backup = root / "backup"
            bun_dir = root / "bun"
            command = flywheel_agent._install_transaction_command(
                stage,
                publish,
                backup,
                hashlib.sha256(harness.read_bytes()).hexdigest(),
                final=final,
                bun_dir=bun_dir,
                lock_path=root / "install.lock",
                release_base_url=release.as_uri(),
                release_assets=assets,
                owner=f"{os.getuid()}:{os.getgid()}",
                fail_after_final_move=True,
            )

            test_bin = _flock_fixture(root)
            result = subprocess.run(
                ["bash", "-c", command],
                env={**os.environ, "PATH": f"{test_bin}:{os.environ['PATH']}"},
                capture_output=True,
                text=True,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((final / "marker").read_text(), "old harness")
            self.assertFalse(backup.exists())
            self.assertFalse(publish.exists())
            self.assertTrue((bun_dir / "bin" / "bun").is_file())

    def test_generated_transaction_holds_one_lock_through_install_and_publication(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            release, assets, harness, gate, bun_log = _transaction_fixture(
                root, blocking_bun=True
            )
            stage = root / "stage"
            stage.mkdir()
            (stage / "harness.tar.gz").write_bytes(harness.read_bytes())
            final = root / "final"
            final.mkdir()
            (final / "marker").write_text("old harness")
            lock_path = root / "install.lock"
            command = flywheel_agent._install_transaction_command(
                stage,
                root / "publish",
                root / "backup",
                hashlib.sha256(harness.read_bytes()).hexdigest(),
                final=final,
                bun_dir=root / "bun",
                lock_path=lock_path,
                release_base_url=release.as_uri(),
                release_assets=assets,
                owner=f"{os.getuid()}:{os.getgid()}",
            )
            test_bin = _flock_fixture(root)
            process = subprocess.Popen(
                ["bash", "-c", command],
                env={
                    **os.environ,
                    "PATH": f"{test_bin}:{os.environ['PATH']}",
                    "BUN_TEST_GATE": str(gate),
                    "BUN_TEST_LOG": str(bun_log),
                },
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            try:
                deadline = time.monotonic() + 5
                while not bun_log.exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(bun_log.exists())
                contender = subprocess.run(
                    [str(test_bin / "flock"), "-n", str(lock_path), "true"],
                    capture_output=True,
                    text=True,
                )
                self.assertNotEqual(contender.returncode, 0)
                self.assertEqual((final / "marker").read_text(), "old harness")

                gate.touch()
                stdout, stderr = process.communicate(timeout=5)

                self.assertEqual(process.returncode, 0, stdout + stderr)
                self.assertEqual((final / "marker").read_text(), "new harness")
                self.assertFalse((root / "backup").exists())
            finally:
                if process.poll() is None:
                    process.kill()
                    process.communicate()

    async def test_install_uses_bounded_apt_fallback_when_dependencies_are_missing(self) -> None:
        root_calls = []
        agent = FlywheelHeadless()

        async def exec_as_root(environment, **kwargs):
            root_calls.append(kwargs)
            output = "missing\n" if len(root_calls) == 1 else ""
            return types.SimpleNamespace(stdout=output, return_code=0)

        async def exec_as_agent(environment, **kwargs):
            return types.SimpleNamespace(stdout="", return_code=0)

        async def upload_harness(environment):
            agent._source_archive_sha256 = "a" * 64

        agent.exec_as_root = exec_as_root
        agent.exec_as_agent = exec_as_agent
        agent._upload_harness = upload_harness

        await agent.install(object())

        apt_calls = [call for call in root_calls if "apt-get" in call["command"]]
        self.assertEqual(len(apt_calls), 1)
        self.assertEqual(apt_calls[0]["command"], flywheel_agent.APT_BOOTSTRAP_COMMAND)
        self.assertEqual(apt_calls[0]["timeout_sec"], 300)
        self.assertEqual(apt_calls[0]["env"], {"DEBIAN_FRONTEND": "noninteractive"})

    async def test_does_not_forward_retired_experiment_profile_or_override_cwd(self) -> None:
        calls = []
        agent = FlywheelHeadless()
        agent.model_name = None
        agent._source_archive_sha256 = "b" * 64

        async def exec_as_agent(environment, **kwargs):
            calls.append(kwargs)

        agent.exec_as_agent = exec_as_agent
        with patch.dict(
            os.environ,
            {flywheel_agent.AUTH_PROFILE_ENV: "bench-profile", flywheel_agent.DISABLED_TOOLS_ENV: TEST_DISABLED_TOOLS, "FLYWHEEL_HEADLESS_EXPERIMENT_PROFILE": "retired-selector"},
            clear=True,
        ):
            await agent.run("task", self.environment, object())

        task_call = next(call for call in calls if "env" in call)
        self.assertNotIn("FLYWHEEL_HEADLESS_EXPERIMENT_PROFILE", task_call["env"])
        self.assertNotIn("cwd", task_call)

    async def test_fails_closed_when_archive_identity_is_absent(self) -> None:
        agent = FlywheelHeadless()
        agent.model_name = None
        agent._source_archive_sha256 = None
        agent.exec_as_agent = lambda *args, **kwargs: None

        with self.assertRaisesRegex(RuntimeError, "archive identity"):
            await agent.run("task", object(), object())

    async def test_hashes_exact_uploaded_archive_bytes_and_forwards_digest(self) -> None:
        agent = FlywheelHeadless()
        agent.model_name = None
        calls = []
        root_calls = []

        async def upload_file(source, destination):
            calls.append(("upload", Path(source).read_bytes(), destination))

        async def exec_as_agent(environment, **kwargs):
            calls.append(("exec", kwargs))

        async def exec_as_root(environment, **kwargs):
            root_calls.append(kwargs)
            return types.SimpleNamespace(stdout=_root_stdout(kwargs["command"]))

        environment = types.SimpleNamespace(upload_file=upload_file, default_user="root")
        agent.exec_as_agent = exec_as_agent
        agent.exec_as_root = exec_as_root
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            log_dir = root / "job" / "trial" / "agent"
            repository = root / "repository"
            _write_synthetic_repository(repository, b"exact tar bytes\x00\xff")
            agent.logs_dir = log_dir

            with patch.object(flywheel_agent, "REPO_ROOT", repository), patch.object(
                flywheel_agent, "_source_archive_paths", return_value=(Path("source.txt"),)
            ):
                await agent._upload_harness(environment)
            with patch.dict(os.environ, {flywheel_agent.AUTH_PROFILE_ENV: "bench-profile", flywheel_agent.DISABLED_TOOLS_ENV: TEST_DISABLED_TOOLS}, clear=True):
                await agent.run("task", environment, object())

            uploaded_bytes = calls[1][1]
            expected_digest = hashlib.sha256(uploaded_bytes).hexdigest()
            _assert_synthetic_source_archive(self, uploaded_bytes, b"exact tar bytes\x00\xff")
            self.assertEqual(agent._source_archive_sha256, expected_digest)
            self.assertEqual(
                (Path(log_dir) / "source-archive.sha256").read_text(),
                f"{expected_digest}\n",
            )

        stage = agent._harness_staging_dir
        self.assertEqual(calls[1][2], f"{stage}/harness.tar.gz")
        staging_command = calls[0][1]["command"]
        self.assertIn("umask 077", staging_command)
        self.assertIn(f"mkdir -m 700 -- {stage}", staging_command)
        self.assertEqual(len([call for call in calls if call[0] == "exec"]), 4)
        self.assertEqual(len(root_calls), 4)
        self.assertIn("chown root", root_calls[1]["command"])
        self.assertFalse(any("bun install" in call[1]["command"] for call in calls if call[0] == "exec"))
        task_call = next(call[1] for call in calls if call[0] == "exec" and "env" in call[1])
        self.assertEqual(task_call["env"]["FLYWHEEL_SOURCE_ARCHIVE_SHA256"], expected_digest)

    async def test_concurrent_trials_snapshot_one_locked_job_archive(self) -> None:
        tar_builds = 0
        uploads = {}
        builder_holds_lock = threading.Event()
        contender_started = threading.Event()
        release_builder = threading.Event()
        flock_calls = 0
        flock_calls_lock = threading.Lock()
        real_flock = fcntl.flock

        def observed_flock(file_descriptor, operation):
            nonlocal flock_calls
            if operation == fcntl.LOCK_EX:
                with flock_calls_lock:
                    flock_calls += 1
                    if flock_calls == 2:
                        contender_started.set()
            return real_flock(file_descriptor, operation)

        real_write = flywheel_agent._write_pinned_source_tar

        def create_archive(tar_file, pinned):
            nonlocal tar_builds
            tar_builds += 1
            builder_holds_lock.set()
            self.assertTrue(release_builder.wait(timeout=5))
            real_write(tar_file, pinned)

        async def exec_as_agent(environment, **kwargs):
            return None

        with tempfile.TemporaryDirectory() as directory:
            job_dir = Path(directory).resolve() / "job"
            stale_temp = job_dir / "source-archive.tmp-interrupted.tar.gz"
            job_dir.mkdir()
            stale_temp.write_bytes(b"stale")
            repository = Path(directory).resolve() / "repository"
            _write_synthetic_repository(repository, b"first source snapshot")
            agents = []
            environments = []
            for trial in ("trial-1", "trial-2"):
                agent = FlywheelHeadless()
                agent.logs_dir = job_dir / trial / "agent"
                agent.exec_as_agent = exec_as_agent
                agents.append(agent)

                async def upload_file(source, destination, trial=trial):
                    uploads[trial] = (Path(source).read_bytes(), destination, Path(source))

                environments.append(types.SimpleNamespace(upload_file=upload_file, default_user="root"))

            with patch("fcntl.flock", side_effect=observed_flock), patch.object(
                flywheel_agent, "REPO_ROOT", repository
            ), patch.object(
                flywheel_agent, "_source_archive_paths", return_value=(Path("source.txt"),)
            ), patch.object(
                flywheel_agent, "_validate_archive_manifest_file", wraps=flywheel_agent._validate_archive_manifest_file
            ) as validate_archive, patch.object(
                flywheel_agent, "_sha256_fileobj", wraps=flywheel_agent._sha256_fileobj
            ) as hash_archive, patch.object(
                flywheel_agent, "_write_pinned_source_tar", side_effect=create_archive
            ):
                first = asyncio.create_task(agents[0]._upload_harness(environments[0]))
                self.assertTrue(await asyncio.to_thread(builder_holds_lock.wait, 5))
                second = asyncio.create_task(agents[1]._upload_harness(environments[1]))
                self.assertTrue(await asyncio.to_thread(contender_started.wait, 5))
                self.assertFalse(first.done())
                self.assertFalse(second.done())
                release_builder.set()
                await asyncio.gather(first, second)

            canonical = job_dir / "source-archive.tar.gz"
            canonical_stat = canonical.stat()
            first_bytes, first_destination, first_snapshot = uploads["trial-1"]
            second_bytes, second_destination, second_snapshot = uploads["trial-2"]
            expected_digest = hashlib.sha256(first_bytes).hexdigest()
            self.assertEqual(tar_builds, 1)
            self.assertFalse(stale_temp.exists())
            self.assertEqual(first_bytes, second_bytes)
            _assert_synthetic_source_archive(self, second_bytes, b"first source snapshot")
            self.assertNotEqual(first_destination, second_destination)
            self.assertRegex(first_destination, r"^/tmp/flywheel-harness-[a-f0-9]{32}/harness.tar.gz$")
            self.assertRegex(second_destination, r"^/tmp/flywheel-harness-[a-f0-9]{32}/harness.tar.gz$")
            self.assertEqual(first_snapshot.stat().st_ino, canonical_stat.st_ino)
            self.assertEqual(second_snapshot.stat().st_ino, canonical_stat.st_ino)
            self.assertEqual(agents[0]._source_archive_sha256, expected_digest)
            self.assertEqual(agents[1]._source_archive_sha256, expected_digest)
            self.assertEqual(validate_archive.call_count, 1)
            self.assertEqual(hash_archive.call_count, 1)
            for trial in ("trial-1", "trial-2"):
                self.assertEqual(
                    (job_dir / trial / "agent" / "source-archive.sha256").read_text(),
                    f"{expected_digest}\n",
                )

    async def test_trusted_archive_reuse_skips_stale_temp_cleanup(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            job_dir = root / "job"
            repository = root / "repository"
            _write_synthetic_repository(repository, b"trusted source")
            agent = FlywheelHeadless()
            agent.logs_dir = job_dir / "trial" / "agent"
            agent.exec_as_agent = unittest.mock.AsyncMock()
            environment = types.SimpleNamespace(upload_file=unittest.mock.AsyncMock())

            with patch.object(flywheel_agent, "REPO_ROOT", repository), patch.object(
                flywheel_agent, "_source_archive_paths", return_value=(Path("source.txt"),)
            ), patch.object(
                flywheel_agent, "_cleanup_stale_archive_temps", wraps=flywheel_agent._cleanup_stale_archive_temps
            ) as cleanup:
                await agent._upload_harness(environment)
                await agent._upload_harness(environment)

            self.assertEqual(cleanup.call_count, 1)

    async def test_rebuilds_preseeded_zero_length_and_corrupt_canonical_archives(self) -> None:
        valid_preseed_tar = io.BytesIO()
        with tarfile.open(fileobj=valid_preseed_tar, mode="w") as archive:
            source = tarfile.TarInfo("source.txt")
            source.size = len(b"preseeded")
            archive.addfile(source, io.BytesIO(b"preseeded"))
            for addon_path in flywheel_agent.RUNTIME_ASSET_ARCHIVE_PATHS:
                addon = tarfile.TarInfo(addon_path.as_posix())
                addon.size = len(b"preseeded addon")
                archive.addfile(addon, io.BytesIO(b"preseeded addon"))
        valid_preseed = io.BytesIO()
        with gzip.GzipFile(filename="", mode="wb", fileobj=valid_preseed, mtime=0) as compressed:
            compressed.write(valid_preseed_tar.getvalue())
        for invalid_bytes in (valid_preseed.getvalue(), b"", b"not gzip"):
            with self.subTest(invalid_bytes=invalid_bytes), tempfile.TemporaryDirectory() as directory:
                job_dir = Path(directory).resolve() / "job"
                job_dir.mkdir()
                repository = Path(directory).resolve() / "repository"
                _write_synthetic_repository(repository, b"rebuilt")
                canonical = job_dir / "source-archive.tar.gz"
                canonical.write_bytes(invalid_bytes)
                canonical.chmod(0o444)
                agent = FlywheelHeadless()
                agent.logs_dir = job_dir / "trial" / "agent"
                agent.exec_as_agent = unittest.mock.AsyncMock()
                environment = types.SimpleNamespace(upload_file=unittest.mock.AsyncMock())
                builds = 0

                real_write = flywheel_agent._write_pinned_source_tar

                def count_archive(tar_file, pinned):
                    nonlocal builds
                    builds += 1
                    real_write(tar_file, pinned)

                with patch.object(flywheel_agent, "REPO_ROOT", repository), patch.object(
                    flywheel_agent, "_source_archive_paths", return_value=(Path("source.txt"),)
                ), patch.object(
                    flywheel_agent, "_write_pinned_source_tar", side_effect=count_archive
                ):
                    await agent._upload_harness(environment)

                self.assertEqual(builds, 1)
                _assert_synthetic_source_archive(self, canonical.read_bytes(), b"rebuilt")

    async def test_normalizes_relative_harbor_logs_dir(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            logs_dir = root / "job" / "trial" / "agent"
            logs_dir.mkdir(parents=True)
            with patch.object(Path, "cwd", return_value=root):
                job_dir, normalized_logs_dir = flywheel_agent._require_safe_logs_dir(Path("job/trial/agent"))

            self.assertEqual(job_dir, root / "job")
            self.assertEqual(normalized_logs_dir, logs_dir)

    async def test_rejects_relative_traversal_and_symlink_logs_paths(self) -> None:
        invalid_paths = (
            Path("../job/trial/agent"),
            Path("job/agent"),
            Path("/tmp/job/trial/../trial/agent"),
        )
        for logs_dir in invalid_paths:
            with self.subTest(logs_dir=logs_dir):
                agent = FlywheelHeadless()
                agent.logs_dir = logs_dir
                with self.assertRaisesRegex(RuntimeError, "<job>/<trial>/agent"):
                    await agent._upload_harness(object())

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            real_job = root / "real-job"
            real_job.mkdir()
            linked_job = root / "linked-job"
            linked_job.symlink_to(real_job, target_is_directory=True)
            agent = FlywheelHeadless()
            agent.logs_dir = linked_job / "trial" / "agent"
            with self.assertRaisesRegex(RuntimeError, "symlink"):
                await agent._upload_harness(object())

    async def test_rejects_symlink_canonical_and_mismatched_retry_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            job_dir = Path(directory).resolve() / "job"
            job_dir.mkdir()
            target = job_dir / "target"
            target.write_bytes(b"unsafe target")
            (job_dir / "source-archive.tar.gz").symlink_to(target)
            agent = FlywheelHeadless()
            agent.logs_dir = job_dir / "trial" / "agent"
            with self.assertRaisesRegex(RuntimeError, "unsafe"):
                await agent._upload_harness(object())

        with tempfile.TemporaryDirectory() as directory:
            job_dir = Path(directory).resolve() / "job"
            repository = Path(directory).resolve() / "repository"
            _write_synthetic_repository(repository, b"canonical")
            agent = FlywheelHeadless()
            agent.logs_dir = job_dir / "trial" / "agent"
            agent.exec_as_agent = unittest.mock.AsyncMock()
            environment = types.SimpleNamespace(upload_file=unittest.mock.AsyncMock())

            with patch.object(flywheel_agent, "REPO_ROOT", repository), patch.object(
                flywheel_agent, "_source_archive_paths", return_value=(Path("source.txt"),)
            ):
                await agent._upload_harness(environment)
            snapshot = agent.logs_dir / "source-archive.tar.gz"
            snapshot.unlink()
            snapshot.write_bytes(b"different inode")

            with self.assertRaisesRegex(RuntimeError, "does not match"):
                await agent._upload_harness(environment)

    async def test_requires_logs_dir_with_harbor_job_ownership(self) -> None:
        agent = FlywheelHeadless()

        with self.assertRaisesRegex(RuntimeError, "<job>/<trial>/agent"):
            await agent._upload_harness(object())

    def test_reproducible_gzip_has_identical_bytes_and_digest(self) -> None:
        tar_bytes = _tar_bytes(b"synthetic stable tar bytes\x00\xff")
        first = io.BytesIO()
        second = io.BytesIO()

        flywheel_agent._gzip_reproducibly_files(io.BytesIO(tar_bytes), first)
        flywheel_agent._gzip_reproducibly_files(io.BytesIO(tar_bytes), second)

        self.assertEqual(first.getvalue(), second.getvalue())
        self.assertEqual(
            hashlib.sha256(first.getvalue()).hexdigest(),
            hashlib.sha256(second.getvalue()).hexdigest(),
        )
        self.assertEqual(gzip.decompress(first.getvalue()), tar_bytes)

    async def test_rejects_malformed_archive_identity_before_provider_setup(self) -> None:
        for digest in ("a" * 63, "g" * 64, "A" * 64):
            with self.subTest(digest=digest):
                agent = FlywheelHeadless()
                agent.model_name = None
                agent._source_archive_sha256 = digest
                calls = []

                async def exec_as_agent(environment, **kwargs):
                    calls.append(kwargs)

                agent.exec_as_agent = exec_as_agent
                with self.assertRaisesRegex(RuntimeError, "64 lowercase hexadecimal"):
                    await agent.run("task", object(), object())
                self.assertEqual(calls, [])

    def test_source_archive_adds_exact_runtime_assets_from_crates(self) -> None:
        addon_payloads = {
            Path("crates/ripgrep/flywheel-ripgrep.linux-arm64.node"): b"tracked linux arm64 addon",
            Path("crates/ripgrep/flywheel-ripgrep.linux-x64.node"): b"tracked linux x64 addon",
            Path("crates/tokenizer/flywheel-tokenizer.wasm.zst"): b"tracked tokenizer artifact",
            Path("crates/tokenizer/tokenizer-prebuilt.json"): b"tracked tokenizer fingerprint",
        }

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            repository = root / "repository"
            repository.mkdir()
            (repository / "package.json").write_bytes(b"source")
            for addon_path, addon_bytes in addon_payloads.items():
                addon = repository / addon_path
                addon.parent.mkdir(parents=True, exist_ok=True)
                addon.write_bytes(addon_bytes)
            (repository / "crates" / "ripgrep" / "Cargo.toml").write_text("excluded")
            (repository / "crates" / "tokenizer" / "Cargo.toml").write_text("excluded")
            archive_path = root / "source-archive.tar.gz"

            git_results = [
                types.SimpleNamespace(stdout=b"package.json\0"),
                types.SimpleNamespace(stdout=b""),
            ]
            with patch.object(flywheel_agent, "REPO_ROOT", repository), patch(
                "subprocess.run", side_effect=git_results * 2
            ) as list_source_paths:
                flywheel_agent._build_archive(root, archive_path)

            with tarfile.open(archive_path, mode="r:gz") as archive:
                names = archive.getnames()
                self.assertEqual(archive.extractfile("package.json").read(), b"source")
                for addon_path, addon_bytes in addon_payloads.items():
                    with self.subTest(addon_path=addon_path):
                        self.assertEqual(names.count(addon_path.as_posix()), 1)
                        self.assertEqual(
                            archive.extractfile(addon_path.as_posix()).read(), addon_bytes
                        )
                self.assertNotIn("crates/ripgrep/Cargo.toml", names)
                self.assertNotIn("crates/tokenizer/Cargo.toml", names)

        self.assertEqual(list_source_paths.call_count, 4)
        for offset in (0, 2):
            self.assertEqual(
                list_source_paths.call_args_list[offset].args[0],
                ["git", "ls-files", "-z", "--cached"],
            )
            self.assertEqual(
                list_source_paths.call_args_list[offset + 1].args[0],
                ["git", "ls-files", "-z", "--others", "--exclude-standard", "--", *flywheel_agent.SOURCE_ARCHIVE_MEMBERS],
            )

    def test_group_writable_tracked_source_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory) / "repository"
            repository.mkdir()
            source = repository / "package.json"
            source.write_bytes(b"group writable source")
            source.chmod(0o664)
            root_descriptor = os.open(repository, os.O_RDONLY | os.O_DIRECTORY)
            try:
                with self.assertRaisesRegex(RuntimeError, "unsafe"):
                    flywheel_agent._open_repository_file(
                        root_descriptor, Path("package.json")
                    )
            finally:
                os.close(root_descriptor)

    def test_hard_linked_source_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory) / "repository"
            repository.mkdir()
            source = repository / "package.json"
            source.write_bytes(b"source")
            os.link(source, repository / "second-link")
            root_descriptor = os.open(repository, os.O_RDONLY | os.O_DIRECTORY)
            try:
                with self.assertRaisesRegex(RuntimeError, "link identity"):
                    flywheel_agent._open_repository_file(
                        root_descriptor, Path("package.json")
                    )
            finally:
                os.close(root_descriptor)

    def test_source_archive_rejects_symlinked_ripgrep_addon(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            repository = root / "repository"
            repository.mkdir()
            (repository / "source.txt").write_bytes(b"source")
            addon = repository / Path("crates/ripgrep/flywheel-ripgrep.linux-x64.node")
            addon.parent.mkdir(parents=True)
            (addon.parent / "flywheel-ripgrep.linux-arm64.node").write_bytes(b"safe addon")
            target = root / "outside.node"
            target.write_bytes(b"unsafe addon")
            addon.symlink_to(target)

            with patch.object(flywheel_agent, "REPO_ROOT", repository), patch.object(
                flywheel_agent, "_source_archive_paths", return_value=(Path("source.txt"),)
            ), self.assertRaisesRegex(RuntimeError, "unsafe"):
                flywheel_agent._build_archive(root, root / "source-archive.tar.gz")

    def test_tracked_runtime_source_is_filtered_and_reproducible(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            repository = root / "repository"
            repository.mkdir()
            included_paths = (
                Path("package.json"),
                Path("scripts/patch-deps.ts"),
                Path("src/cli/auth.ts"),
                Path("src/main.ts"),
                Path("src/token-counter.ts"),
            )
            excluded_paths = (
                Path(".env"),
                Path("README.md"),
                Path("src/.env.local"),
                Path("src/certificate.pem"),
                Path("src/SecretValue"),
                Path("terminal-bench-2-1/task/solution/solve.sh"),
            )
            listed_paths = (*included_paths, *excluded_paths)
            for path in listed_paths:
                source = repository / path
                source.parent.mkdir(parents=True, exist_ok=True)
                source.write_text(path.as_posix())
            git_results = [
                types.SimpleNamespace(stdout=b"\0".join(os.fsencode(path) for path in listed_paths) + b"\0"),
                types.SimpleNamespace(stdout=b""),
            ]
            first_tar = root / "first.tar"
            second_tar = root / "second.tar"

            with patch.object(flywheel_agent, "REPO_ROOT", repository), patch(
                "subprocess.run", side_effect=git_results * 2
            ), patch.dict(os.environ, {}, clear=True):
                first_paths = flywheel_agent._source_archive_paths()
                first_pinned = flywheel_agent._pin_repository_files(first_paths)
                try:
                    with first_tar.open("w+b") as tar_file:
                        flywheel_agent._write_pinned_source_tar(tar_file, first_pinned)
                finally:
                    flywheel_agent._close_pinned_repository_files(first_pinned)
                second_paths = flywheel_agent._source_archive_paths()
                second_pinned = flywheel_agent._pin_repository_files(second_paths)
                try:
                    with second_tar.open("w+b") as tar_file:
                        flywheel_agent._write_pinned_source_tar(tar_file, second_pinned)
                finally:
                    flywheel_agent._close_pinned_repository_files(second_pinned)

            self.assertEqual(first_tar.read_bytes(), second_tar.read_bytes())
            with tarfile.open(first_tar, mode="r") as archive:
                self.assertEqual(archive.getnames(), [path.as_posix() for path in included_paths])

    def test_deleted_tracked_runtime_source_is_absent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory) / "repository"
            repository.mkdir()
            (repository / "package.json").write_text("{}")
            (repository / "src").mkdir()
            git_results = [
                types.SimpleNamespace(stdout=b"package.json\0src/deleted.ts\0"),
                types.SimpleNamespace(stdout=b""),
            ]

            with patch.object(flywheel_agent, "REPO_ROOT", repository), patch(
                "subprocess.run", side_effect=git_results
            ), patch.dict(os.environ, {}, clear=True):
                self.assertEqual(flywheel_agent._source_archive_paths(), (Path("package.json"),))

    def test_tracked_path_probe_rejects_symlinked_intermediate_but_selects_unsafe_final(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repository = root / "repository"
            repository.mkdir()
            real_src = root / "real-src"
            real_src.mkdir()
            (real_src / "module.ts").write_text("source")
            (repository / "src").symlink_to(real_src, target_is_directory=True)
            with patch.object(flywheel_agent, "REPO_ROOT", repository), self.assertRaisesRegex(
                RuntimeError, "unsafe"
            ):
                flywheel_agent._tracked_worktree_path_exists(Path("src/module.ts"))

            (repository / "src").unlink()
            (repository / "src").mkdir()
            (repository / "src" / "module.ts").symlink_to(real_src / "module.ts")
            with patch.object(flywheel_agent, "REPO_ROOT", repository):
                self.assertTrue(
                    flywheel_agent._tracked_worktree_path_exists(Path("src/module.ts"))
                )

    def test_untracked_runtime_source_filters_secret_names_and_keeps_safe_source(self) -> None:
        excluded_names = (
            ".netrc", "netrc", "id_rsa", "id_rsa_backup", "id_dsa", "id_ecdsa-old",
            "id_ed25519", "id_ed25519.pub", "client_api_key.json", "client-api-key.txt",
            "client_apikey", "client_secret.json", "client-secret.txt", "clientsecret.json",
            "client_secret.ts", "client-secret.tsx", "service-account.json", "service_account.toml",
            "serviceaccount", "private-key.txt", "private_key.json",
        )
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory) / "repository"
            included = (Path("package.json"), Path("src/auth-client.ts"), Path("src/ordinary-module.ts"))
            excluded = tuple(Path("src") / name for name in excluded_names)
            for path in (*included, *excluded):
                source = repository / path
                source.parent.mkdir(parents=True, exist_ok=True)
                source.write_text(path.as_posix())
            git_results = [
                types.SimpleNamespace(stdout=b"package.json\0"),
                types.SimpleNamespace(stdout=b"\0".join(os.fsencode(path) for path in (*included[1:], *excluded)) + b"\0"),
            ]

            with patch.object(flywheel_agent, "REPO_ROOT", repository), patch(
                "subprocess.run", side_effect=git_results
            ), patch.dict(os.environ, {}, clear=True):
                self.assertEqual(flywheel_agent._source_archive_paths(), included)

    def test_unsafe_untracked_sources_are_omitted_while_safe_source_is_selected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repository = root / "repository"
            src = repository / "src"
            src.mkdir(parents=True)
            safe = src / "safe.ts"
            safe.write_text("safe")
            symlink = src / "symlink.ts"
            symlink.symlink_to(safe)
            hard_link = src / "hard-link.ts"
            os.link(safe, hard_link)
            writable = src / "writable.ts"
            writable.write_text("writable")
            writable.chmod(0o666)
            candidates = (Path("src/safe.ts"), Path("src/symlink.ts"), Path("src/hard-link.ts"), Path("src/writable.ts"))
            git_results = [
                types.SimpleNamespace(stdout=b""),
                types.SimpleNamespace(stdout=b"\0".join(os.fsencode(path) for path in candidates) + b"\0"),
            ]

            with patch.object(flywheel_agent, "REPO_ROOT", repository), patch(
                "subprocess.run", side_effect=git_results
            ):
                self.assertEqual(flywheel_agent._source_archive_paths(), ())

            hard_link.unlink()
            git_results = [
                types.SimpleNamespace(stdout=b""),
                types.SimpleNamespace(stdout=b"\0".join(os.fsencode(path) for path in candidates) + b"\0"),
            ]
            with patch.object(flywheel_agent, "REPO_ROOT", repository), patch(
                "subprocess.run", side_effect=git_results
            ):
                self.assertEqual(flywheel_agent._source_archive_paths(), (Path("src/safe.ts"),))

    def test_malformed_untracked_runtime_path_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory) / "repository"
            repository.mkdir()
            git_results = [types.SimpleNamespace(stdout=b""), types.SimpleNamespace(stdout=b"src/../escape.ts\0")]
            with patch.object(flywheel_agent, "REPO_ROOT", repository), patch(
                "subprocess.run", side_effect=git_results
            ), patch.dict(os.environ, {}, clear=True), self.assertRaisesRegex(RuntimeError, "unsafe"):
                flywheel_agent._source_archive_paths()



class ArchiveSecurityTest(unittest.TestCase):
    def _write_archive(self, path: Path, entries: list[tuple[tarfile.TarInfo, bytes]]) -> None:
        if path.exists():
            path.chmod(0o600)
        with tarfile.open(path, mode="w:gz") as archive:
            for member, payload in entries:
                member.size = len(payload) if member.isfile() else 0
                archive.addfile(member, io.BytesIO(payload) if member.isfile() else None)
        path.chmod(0o444)

    def test_archive_manifest_accepts_exact_regular_members_only(self) -> None:
        expected = (Path("source.txt"), Path("addon.node"))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive_path = root / "archive.tar.gz"
            exact_entries = [
                (tarfile.TarInfo("source.txt"), b"source"),
                (tarfile.TarInfo("addon.node"), b"addon"),
            ]
            self._write_archive(archive_path, exact_entries)
            with archive_path.open("rb") as archive_file:
                self.assertTrue(
                    flywheel_agent._validate_archive_manifest_file(archive_file, expected)
                )

            invalid_entries = {
                "extra": [*exact_entries, (tarfile.TarInfo("extra"), b"extra")],
                "missing": exact_entries[:1],
                "duplicate": [exact_entries[0], exact_entries[0], exact_entries[1]],
                "symlink": [(tarfile.TarInfo("source.txt"), b"source"), (tarfile.TarInfo("addon.node"), b"")],
                "hardlink": [(tarfile.TarInfo("source.txt"), b"source"), (tarfile.TarInfo("addon.node"), b"")],
                "device": [(tarfile.TarInfo("source.txt"), b"source"), (tarfile.TarInfo("addon.node"), b"")],
                "absolute": [(tarfile.TarInfo("/source.txt"), b"source"), exact_entries[1]],
                "traversal": [(tarfile.TarInfo("../source.txt"), b"source"), exact_entries[1]],
            }
            invalid_entries["symlink"][1][0].type = tarfile.SYMTYPE
            invalid_entries["symlink"][1][0].linkname = "source.txt"
            invalid_entries["hardlink"][1][0].type = tarfile.LNKTYPE
            invalid_entries["hardlink"][1][0].linkname = "source.txt"
            invalid_entries["device"][1][0].type = tarfile.CHRTYPE
            for name, entries in invalid_entries.items():
                with self.subTest(name=name):
                    self._write_archive(archive_path, entries)
                    with archive_path.open("rb") as archive_file:
                        self.assertFalse(
                            flywheel_agent._validate_archive_manifest_file(
                                archive_file, expected
                            )
                        )

            archive_path.chmod(0o600)
            archive_path.write_bytes(b"malformed")
            archive_path.chmod(0o444)
            with archive_path.open("rb") as archive_file:
                self.assertFalse(
                    flywheel_agent._validate_archive_manifest_file(archive_file, expected)
                )


    def test_all_selected_files_are_pinned_before_path_replacement(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repository = root / "repository"
            _write_synthetic_repository(repository, b"selected source")
            source = repository / "source.txt"
            credential = root / "credential"
            credential.write_bytes(b"credential bytes")
            real_write = flywheel_agent._write_pinned_source_tar

            def replace_then_write(tar_file, pinned):
                source.rename(repository / "selected-source")
                os.link(credential, source)
                real_write(tar_file, pinned)

            archive_path = root / "source-archive.tar.gz"
            with patch.object(flywheel_agent, "REPO_ROOT", repository), patch.object(
                flywheel_agent, "_source_archive_paths", return_value=(Path("source.txt"),)
            ), patch.object(
                flywheel_agent, "_write_pinned_source_tar", side_effect=replace_then_write
            ), self.assertRaisesRegex(RuntimeError, "selected inode changed"):
                flywheel_agent._build_archive(root, archive_path)

            self.assertFalse(archive_path.exists())

    def test_same_inode_write_during_full_source_pass_prevents_publication(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repository = root / "repository"
            _write_synthetic_repository(repository, b"selected source")
            source = repository / "source.txt"
            archive_path = root / "source-archive.tar.gz"
            real_addfile = tarfile.TarFile.addfile
            copied = 0

            def mutate_after_copy(archive, member, source_file=None):
                nonlocal copied
                real_addfile(archive, member, source_file)
                copied += 1
                if copied == 1:
                    source.write_bytes(b"modified source")

            with patch.object(flywheel_agent, "REPO_ROOT", repository), patch.object(
                flywheel_agent, "_source_archive_paths", return_value=(Path("source.txt"),)
            ), patch.object(
                tarfile.TarFile, "addfile", autospec=True, side_effect=mutate_after_copy
            ), self.assertRaisesRegex(RuntimeError, "selected inode changed"):
                flywheel_agent._build_archive(root, archive_path)

            self.assertFalse(archive_path.exists())

    def test_source_parent_swap_after_tar_read_prevents_publication(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repository = root / "repository"
            source = repository / "src" / "source.txt"
            source.parent.mkdir(parents=True)
            source.write_bytes(b"selected source")
            for addon_path in flywheel_agent.RUNTIME_ASSET_ARCHIVE_PATHS:
                addon = repository / addon_path
                addon.parent.mkdir(parents=True, exist_ok=True)
                addon.write_bytes(b"addon")
            replacement = root / "replacement-src"
            replacement.mkdir()
            (replacement / "source.txt").write_bytes(b"replacement source")
            real_gzip = flywheel_agent._gzip_reproducibly_files

            def swap_parent_then_compress(tar_file, archive_file):
                (repository / "src").rename(root / "original-src")
                (repository / "src").symlink_to(replacement, target_is_directory=True)
                real_gzip(tar_file, archive_file)

            archive_path = root / "source-archive.tar.gz"
            with patch.object(flywheel_agent, "REPO_ROOT", repository), patch.object(
                flywheel_agent, "_source_archive_paths", return_value=(Path("src/source.txt"),)
            ), patch.object(
                flywheel_agent,
                "_gzip_reproducibly_files",
                side_effect=swap_parent_then_compress,
            ), self.assertRaisesRegex(RuntimeError, "remapped|unsafe"):
                flywheel_agent._build_archive(root, archive_path)

            self.assertFalse(archive_path.exists())

    def test_logs_ancestor_swap_cannot_redirect_archive_publication(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            job_dir = root / "job"
            repository = root / "repository"
            outside = root / "outside"
            outside.mkdir()
            _write_synthetic_repository(repository, b"selected source")
            real_write = flywheel_agent._write_pinned_source_tar

            def swap_job_then_write(tar_file, pinned):
                job_dir.rename(root / "original-job")
                job_dir.symlink_to(outside, target_is_directory=True)
                real_write(tar_file, pinned)

            with patch.object(flywheel_agent, "REPO_ROOT", repository), patch.object(
                flywheel_agent, "_source_archive_paths", return_value=(Path("source.txt"),)
            ), patch.object(
                flywheel_agent, "_write_pinned_source_tar", side_effect=swap_job_then_write
            ), self.assertRaisesRegex(RuntimeError, "unsafe|identity"):
                flywheel_agent._prepare_trial_snapshot(job_dir / "trial" / "agent")

            self.assertFalse((outside / flywheel_agent.SOURCE_ARCHIVE_NAME).exists())
            self.assertFalse(
                (outside / "trial" / "agent" / flywheel_agent.SOURCE_ARCHIVE_SNAPSHOT_NAME).exists()
            )

    def test_new_untracked_runtime_path_during_build_prevents_publication(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repository = root / "repository"
            _write_synthetic_repository(repository, b"selected source")
            archive_path = root / "source-archive.tar.gz"
            query_count = 0

            def list_paths(command, **kwargs):
                nonlocal query_count
                query_count += 1
                if command[3] == "--cached":
                    return types.SimpleNamespace(stdout=b"source.txt\0")
                if query_count == 2:
                    module = repository / "src" / "new-module.ts"
                    module.parent.mkdir()
                    module.write_text("export const value = 1")
                    return types.SimpleNamespace(stdout=b"")
                return types.SimpleNamespace(stdout=b"src/new-module.ts\0")

            with patch.object(flywheel_agent, "REPO_ROOT", repository), patch(
                "subprocess.run", side_effect=list_paths
            ), patch.dict(os.environ, {}, clear=True), self.assertRaisesRegex(RuntimeError, "path selection changed"):
                flywheel_agent._build_archive(root, archive_path)

            self.assertEqual(query_count, 4)
            self.assertFalse(archive_path.exists())

    def test_new_untracked_runtime_path_during_hash_prevents_publication(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repository = root / "repository"
            _write_synthetic_repository(repository, b"selected source")
            archive_path = root / "source-archive.tar.gz"
            real_hash = flywheel_agent._sha256_fileobj
            source_selections = 0

            def list_paths(command, **kwargs):
                nonlocal source_selections
                if command[3] == "--cached":
                    source_selections += 1
                    return types.SimpleNamespace(stdout=b"source.txt\0")
                paths = b"src/runtime.ts\0" if (repository / "src" / "runtime.ts").exists() else b""
                return types.SimpleNamespace(stdout=paths)

            def add_runtime_then_hash(archive_file):
                module = repository / "src" / "runtime.ts"
                module.parent.mkdir()
                module.write_text("export const runtime = true")
                return real_hash(archive_file)

            with patch.object(flywheel_agent, "REPO_ROOT", repository), patch(
                "subprocess.run", side_effect=list_paths
            ), patch.object(
                flywheel_agent, "_sha256_fileobj", side_effect=add_runtime_then_hash
            ), self.assertRaisesRegex(RuntimeError, "path selection changed"):
                flywheel_agent._build_archive(root, archive_path)

            self.assertFalse(archive_path.exists())

    def test_archive_validation_and_hash_use_held_inode_after_path_replacement(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repository = root / "repository"
            repository.mkdir()
            files = (
                (Path("source.txt"), b"source"),
                *((path, b"addon") for path in flywheel_agent.RUNTIME_ASSET_ARCHIVE_PATHS),
            )
            for relative_path, payload in files:
                path = repository / relative_path
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(payload)
            observed_digests = []
            real_validate = flywheel_agent._validate_archive_manifest_file
            real_hash = flywheel_agent._sha256_fileobj

            def replace_then_validate(archive_file, expected_paths):
                pending = next(root.glob("source-archive.tmp-*.tar.gz"))
                replacement = root / "replacement"
                replacement.write_bytes(b"attacker archive")
                os.replace(replacement, pending)
                return real_validate(archive_file, expected_paths)

            def observe_hash(archive_file):
                digest = real_hash(archive_file)
                observed_digests.append(digest)
                return digest

            with patch.object(flywheel_agent, "REPO_ROOT", repository), patch.object(
                flywheel_agent, "_source_archive_paths", return_value=(Path("source.txt"),)
            ), patch.object(
                flywheel_agent, "_validate_archive_manifest_file", side_effect=replace_then_validate
            ), patch.object(
                flywheel_agent, "_sha256_fileobj", side_effect=observe_hash
            ), self.assertRaisesRegex(RuntimeError, "canonical identity changed"):
                flywheel_agent._build_archive(root, root / "source-archive.tar.gz")

            self.assertEqual(len(observed_digests), 1)
            self.assertNotEqual(observed_digests[0], hashlib.sha256(b"attacker archive").hexdigest())

    def test_pinned_archive_reads_only_committed_git_objects(self) -> None:
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, HERMETIC_GIT_ENVIRONMENT):
            root = Path(directory)
            repository = root / "repository"
            repository.mkdir()
            _init_git_repository(repository)
            committed = {Path("package.json"): b"committed package", Path("src/main.ts"): b"committed source"}
            committed.update({path: b"committed addon" for path in flywheel_agent.RIPGREP_ADDON_ARCHIVE_PATHS})
            for path, payload in committed.items():
                target = repository / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(payload)
            subprocess.run(["git", "add", "."], cwd=repository, check=True)
            subprocess.run(["git", "commit", "-qm", "runtime"], cwd=repository, check=True)
            sha = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repository, check=True, capture_output=True, text=True).stdout.strip()
            (repository / "package.json").write_bytes(b"modified worktree")
            (repository / "src/main.ts").unlink()
            (repository / "src/untracked.ts").write_bytes(b"untracked")
            addon = repository / flywheel_agent.RIPGREP_ADDON_ARCHIVE_PATHS[0]
            addon.unlink()
            addon.symlink_to(repository / "package.json")
            archive_path = root / "source-archive.tar.gz"
            with patch.object(flywheel_agent, "REPO_ROOT", repository), patch.object(
                flywheel_agent, "_source_archive_paths", side_effect=AssertionError("worktree selector called")
            ), patch.object(
                flywheel_agent, "_pin_repository_files", side_effect=AssertionError("worktree opener called")
            ):
                self.assertEqual(flywheel_agent._resolve_runtime_source_commit(sha), sha)
                flywheel_agent._build_archive(root, archive_path, runtime_source_commit=sha)
            with tarfile.open(archive_path, "r:gz") as archive:
                self.assertEqual(archive.extractfile("package.json").read(), b"committed package")
                self.assertEqual(archive.extractfile("src/main.ts").read(), b"committed source")
                self.assertNotIn("src/untracked.ts", archive.getnames())
                for path in flywheel_agent.RIPGREP_ADDON_ARCHIVE_PATHS:
                    self.assertEqual(archive.extractfile(path.as_posix()).read(), b"committed addon")

    def test_pinned_archive_takes_tokenizer_assets_only_as_a_complete_pair(self) -> None:
        cases = (
            ("complete", flywheel_agent.TOKENIZER_ASSET_ARCHIVE_PATHS, None),
            ("partial", flywheel_agent.TOKENIZER_ASSET_ARCHIVE_PATHS[1:], "missing a required runtime asset"),
        )
        for name, tokenizer_paths, error in cases:
            with self.subTest(name), tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, HERMETIC_GIT_ENVIRONMENT):
                root = Path(directory)
                repository = root / "repository"
                repository.mkdir()
                _init_git_repository(repository)
                committed = {Path("package.json"): b"package", Path("crates/tokenizer/Cargo.toml"): b"excluded"}
                committed.update({path: b"addon" for path in flywheel_agent.RIPGREP_ADDON_ARCHIVE_PATHS})
                committed.update({path: path.name.encode() for path in tokenizer_paths})
                for path, payload in committed.items():
                    target = repository / path
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(payload)
                subprocess.run(["git", "add", "."], cwd=repository, check=True)
                subprocess.run(["git", "commit", "-qm", "runtime"], cwd=repository, check=True)
                sha = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repository, check=True, capture_output=True, text=True).stdout.strip()
                archive_path = root / "source-archive.tar.gz"
                with patch.object(flywheel_agent, "REPO_ROOT", repository):
                    if error is not None:
                        with self.assertRaisesRegex(RuntimeError, error):
                            flywheel_agent._build_archive(root, archive_path, runtime_source_commit=sha)
                        self.assertFalse(archive_path.exists())
                        continue
                    flywheel_agent._build_archive(root, archive_path, runtime_source_commit=sha)
                with tarfile.open(archive_path, "r:gz") as archive:
                    self.assertNotIn("crates/tokenizer/Cargo.toml", archive.getnames())
                    for path in tokenizer_paths:
                        self.assertEqual(archive.extractfile(path.as_posix()).read(), path.name.encode())

    def test_archive_covers_the_runtime_source_file_set(self) -> None:
        source = (flywheel_agent.REPO_ROOT / "src/infra/source-snapshot.ts").read_text()
        declaration = re.search(r"export const SOURCE_FILE_SET = \[(.*?)\] as const", source, re.S)
        self.assertIsNotNone(declaration, "SOURCE_FILE_SET declaration moved; update this parser")
        members = re.findall(r'"([^"]+)"', declaration.group(1))
        self.assertIn("src", members)
        uncovered = [
            member for member in members
            if not flywheel_agent._is_source_archive_path_allowed(Path(member))
            and Path(member) not in flywheel_agent.RUNTIME_ASSET_ARCHIVE_PATHS
        ]
        self.assertEqual(uncovered, [], "the source archive omits runtime source files")

    def test_pinned_runtime_rejects_malformed_commit(self) -> None:
        for value in ("abc", "A" * 40, "a" * 39, "a" * 40 + " "):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "exact lowercase"):
                flywheel_agent._resolve_runtime_source_commit(value)

class SettledEvidenceExportTest(unittest.TestCase):
    def _workspace(self, root: Path) -> tuple[Path, Path, Path]:
        workspace = root.resolve() / "workspace"
        database = workspace / ".flywheel" / "flywheel.sqlite"
        evidence = root / "logs" / "agent" / "state"
        database.parent.mkdir(parents=True)
        evidence.mkdir(parents=True)
        connection = flywheel_agent.sqlite3.connect(database)
        connection.execute("CREATE TABLE facts (value TEXT NOT NULL)")
        connection.execute("INSERT INTO facts VALUES ('trusted')")
        connection.commit()
        connection.close()
        return workspace, database, evidence

    def test_publishes_verified_sqlite_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace, _, evidence = self._workspace(Path(directory))
            publication = flywheel_agent._export_settled_sqlite(workspace, evidence)
            exported = evidence / ".flywheel" / "flywheel.sqlite"
            self.assertEqual(publication.sha256, hashlib.sha256(exported.read_bytes()).hexdigest())
            self.assertEqual(exported.stat().st_mode & 0o777, 0o600)
            connection = flywheel_agent.sqlite3.connect(exported)
            self.assertEqual(connection.execute("SELECT value FROM facts").fetchone(), ("trusted",))
            connection.close()

    def test_publishes_committed_rows_that_exist_only_in_wal(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace, database, evidence = self._workspace(Path(directory))
            connection = flywheel_agent.sqlite3.connect(database)
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA wal_autocheckpoint=0")
            connection.execute("INSERT INTO facts VALUES ('wal-only')")
            connection.commit()
            self.assertTrue(database.with_name(f"{database.name}-wal").exists())

            flywheel_agent._export_settled_sqlite(workspace, evidence)

            exported = flywheel_agent.sqlite3.connect(evidence / ".flywheel" / "flywheel.sqlite")
            try:
                self.assertEqual(
                    exported.execute("SELECT value FROM facts ORDER BY rowid").fetchall(),
                    [("trusted",), ("wal-only",)],
                )
            finally:
                exported.close()
                connection.close()

    def test_rejects_unsafe_wal_sidecar_without_publication(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace, database, evidence = self._workspace(Path(directory))
            connection = flywheel_agent.sqlite3.connect(database)
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("INSERT INTO facts VALUES ('wal-only')")
            connection.commit()
            wal = database.with_name(f"{database.name}-wal")
            wal.chmod(0o666)
            try:
                with self.assertRaisesRegex(RuntimeError, "sidecar"):
                    flywheel_agent._export_settled_sqlite(workspace, evidence)
            finally:
                connection.close()
            self.assertFalse((evidence / ".flywheel" / "flywheel.sqlite").exists())

    def test_rejects_wal_replacement_during_backup_without_publication(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace, database, evidence = self._workspace(root)
            connection = flywheel_agent.sqlite3.connect(database)
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("INSERT INTO facts VALUES ('wal-only')")
            connection.commit()
            wal = database.with_name(f"{database.name}-wal")
            replacement = root / "replacement-wal"
            replacement.write_bytes(wal.read_bytes())
            real_backup = flywheel_agent._backup_sqlite

            def replace_wal_then_backup(source_path, destination_path):
                os.replace(replacement, wal)
                real_backup(source_path, destination_path)

            try:
                with patch.object(flywheel_agent, "_backup_sqlite", side_effect=replace_wal_then_backup), self.assertRaisesRegex(RuntimeError, "sidecar"):
                    flywheel_agent._export_settled_sqlite(workspace, evidence)
            finally:
                connection.close()
            self.assertFalse((evidence / ".flywheel" / "flywheel.sqlite").exists())

    def test_rejects_source_symlink_and_missing_database(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace, database, evidence = self._workspace(root)
            target = root / "attacker.sqlite"
            database.rename(target)
            database.symlink_to(target)
            with self.assertRaisesRegex(RuntimeError, "source"):
                flywheel_agent._export_settled_sqlite(workspace, evidence)
            database.unlink()
            with self.assertRaisesRegex(RuntimeError, "missing"):
                flywheel_agent._export_settled_sqlite(workspace, evidence)

    def test_rejects_destination_symlink(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace, _, evidence = self._workspace(root)
            outside = root / "outside"
            outside.mkdir()
            (evidence / ".flywheel").symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(RuntimeError, "destination"):
                flywheel_agent._export_settled_sqlite(workspace, evidence)
            self.assertEqual(list(outside.iterdir()), [])

    def test_backup_failure_does_not_publish(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace, _, evidence = self._workspace(Path(directory))
            with patch.object(flywheel_agent, "_backup_sqlite", side_effect=RuntimeError("backup failed")), self.assertRaisesRegex(RuntimeError, "backup failed"):
                flywheel_agent._export_settled_sqlite(workspace, evidence)
            self.assertFalse((evidence / ".flywheel" / "flywheel.sqlite").exists())

    def test_summary_ignores_forged_marker_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            logs = Path(directory)
            state = logs / "state"
            state.mkdir()
            (state / "project-root").write_text("/forged")
            (state / "evidence-exported").write_text("true")
            summary = flywheel_agent._write_run_summary(
                logs,
                flywheel_agent.AdapterSettlement("normal", False),
                flywheel_agent.DeadlineAuthority(None, None, "test"),
                project_root="/trusted",
                evidence_publication=None,
            )
            self.assertEqual(summary["project_root"], "/trusted")
            self.assertFalse(summary["evidence_exported"])

if __name__ == "__main__":
    unittest.main()
