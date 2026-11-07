import json
import os
import signal
import sqlite3
import stat
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

try:
    from .harbor_agent.flywheel_harbor_agent import shim
except ImportError:
    from harbor_agent.flywheel_harbor_agent import shim

ACCESS_TOKEN = "access-" + "a" * 5000
API_KEY = "sk-test-" + "k" * 40
SNAPSHOT = {
    "profile": "benchmark",
    "credentials": {
        "chatgpt": [{"id": "one", "identity": "person@example.com", "lineageId": "11111111-1111-4111-8111-111111111111", "credential": {"type": "oauth", "access": ACCESS_TOKEN, "expires": 1}}],
        "openai_api": {"type": "api_key", "key": API_KEY},
    },
    "modelAccess": [],
}


def _store(project: Path, value: str) -> None:
    flywheel = project / ".flywheel"
    flywheel.mkdir(mode=0o700, parents=True)
    connection = sqlite3.connect(flywheel / "flywheel.sqlite")
    connection.execute("create table event (payload text)")
    connection.execute("insert into event values (?)", (value,))
    connection.commit()
    connection.close()


class TakeSnapshotTest(unittest.TestCase):
    def test_moves_the_snapshot_out_of_the_environment_into_a_private_stage(self) -> None:
        environ = {shim.SNAPSHOT_ENV: json.dumps(SNAPSHOT), "KEEP": "1"}
        stage_file, profile, secrets_ = shim.take_snapshot(environ)
        try:
            self.assertEqual(environ, {"KEEP": "1"})
            self.assertEqual(profile, "benchmark")
            self.assertEqual(secrets_, frozenset({ACCESS_TOKEN, API_KEY}))
            self.assertEqual(stage_file.name, "auth.json")
            self.assertTrue(stage_file.parent.name.startswith("flywheel-auth-bundle-"))
            self.assertEqual(stat.S_IMODE(stage_file.parent.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(stage_file.stat().st_mode), 0o600)
            self.assertEqual(json.loads(stage_file.read_text()), SNAPSHOT)
        finally:
            stage_file.unlink()
            stage_file.parent.rmdir()

    def test_refuses_a_missing_snapshot(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "FLYWHEEL_AUTH_SNAPSHOT is unset"):
            shim.take_snapshot({})

    def test_the_child_environment_carries_no_snapshot(self) -> None:
        shim_bin = str(Path(sys.executable).parent)
        environment = shim.child_environment({shim.SNAPSHOT_ENV: "x", shim.PROFILE_SHA256_ENV: "y", "TASK_VAR": "z", "PATH": f"{shim_bin}:/opt/task/bin:/usr/bin"}, Path("/home"), Path("/bun/bin"), Path("/app"), "d" * 64)
        self.assertNotIn(shim.SNAPSHOT_ENV, environment)
        self.assertNotIn(shim.PROFILE_SHA256_ENV, environment)
        self.assertEqual(environment["TASK_VAR"], "z")
        self.assertEqual(environment["FLYWHEEL_PROJECT_ROOT"], "/app")
        # The task image's PATH stays; only the shim's own virtual environment leaves it.
        self.assertEqual(environment["PATH"], "/bun/bin:/opt/task/bin:/usr/bin")


class ExportEvidenceTest(unittest.TestCase):
    def test_publishes_a_clean_store_owner_only_with_its_digest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            _store(root / "project", "ordinary event")
            logs = root / "logs"
            logs.mkdir()
            publication, withheld = shim.export_evidence(root / "project", logs, frozenset({API_KEY}))
            published = logs / "state" / ".flywheel" / "flywheel.sqlite"
            self.assertIsNone(withheld)
            self.assertEqual(publication.size, published.stat().st_size)
            self.assertEqual(publication.sha256, shim._sha256_file(published))
            self.assertEqual(stat.S_IMODE(published.stat().st_mode), 0o600)
            connection = sqlite3.connect(published)
            self.assertEqual(connection.execute("select payload from event").fetchall(), [("ordinary event",)])
            connection.close()

    def test_withholds_a_store_that_holds_a_snapshot_secret(self) -> None:
        for secret in (API_KEY, ACCESS_TOKEN):
            with self.subTest(length=len(secret)), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                _store(root / "project", f"prefix {secret} suffix")
                logs = root / "logs"
                logs.mkdir()
                publication, withheld = shim.export_evidence(root / "project", logs, frozenset({API_KEY, ACCESS_TOKEN}))
                self.assertIsNone(publication)
                self.assertEqual(withheld, "credential_bytes")
                self.assertFalse((logs / "state").exists())

    def test_finds_a_secret_that_spans_overflow_pages(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "store.sqlite"
            connection = sqlite3.connect(path)
            connection.execute("create table event (payload text)")
            connection.execute("insert into event values (?)", (ACCESS_TOKEN,))
            connection.commit()
            connection.close()
            self.assertNotIn(ACCESS_TOKEN.encode(), path.read_bytes())
            self.assertTrue(shim.store_holds_secret(path, frozenset({ACCESS_TOKEN})))


class RunShutdownTest(unittest.TestCase):
    """Drives `shim.run` with a stub child, as Flywheel behaves when Harbor closes stdin or sends SIGTERM."""

    def _run(self, root: Path, export_command: list[str] | None = None, child_code: str = "pass", export_budget: float = 0.5) -> tuple[int, dict, float]:
        project, logs = root / "project", root / "logs"
        logs.mkdir()
        stubs = [
            patch.object(shim, "read_build_record", lambda _root: {"build_id": "b" * 12, "flywheel_source": {"commit": "c" * 40}, "runtime_archive": {"path": "archive", "sha256": "d" * 64}, "flywheel_config": {"path": "config"}}),
            patch.object(shim, "_install_bun", lambda work: work),
            patch.object(shim, "_install_runtime", lambda work, _archive, _bin: work),
            patch.object(shim, "_install_home", lambda work, _config, _profile: work / "home"),
            patch.object(shim, "_child_command", lambda *_: [sys.executable, "-c", child_code]),
            patch.object(shim, "_EXPORT_BUDGET_SECONDS", export_budget),
        ]
        self.addCleanup(signal.signal, signal.SIGTERM, signal.getsignal(signal.SIGTERM))
        if export_command is not None:
            stubs.append(patch.object(shim, "_export_command", lambda: export_command))
        for stub in stubs:
            stub.start()
            self.addCleanup(stub.stop)
        started = time.monotonic()
        status = shim.run({shim.SNAPSHOT_ENV: json.dumps(SNAPSHOT)}, project, logs, root)
        elapsed = time.monotonic() - started
        return status, json.loads((logs / "flywheel-run-summary.json").read_text()), elapsed

    def test_publishes_the_settled_store_through_the_export_process(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            _store(root / "project", "ordinary event")
            status, summary, _ = self._run(root)
            published = root / "logs" / "state" / ".flywheel" / "flywheel.sqlite"
            self.assertEqual(status, 0)
            self.assertNotIn("evidence_withheld", summary)
            self.assertEqual(summary["evidence_sha256"], shim._sha256_file(published))

    def test_a_slow_export_is_cut_at_its_deadline_and_the_summary_is_still_written(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            _store(root / "project", "ordinary event")
            status, summary, elapsed = self._run(root, [sys.executable, "-c", "import time; time.sleep(30)"])
            self.assertEqual(status, 0)
            self.assertLess(elapsed, 3)
            self.assertEqual(summary["evidence_withheld"], "export_deadline")
            self.assertIsNone(summary["evidence_sha256"])
            self.assertFalse((root / "logs" / "state").exists())

    def test_a_sigterm_during_the_child_run_bounds_the_export_from_the_sigterm(self) -> None:
        # Harbor sends SIGKILL two seconds after SIGTERM, so the summary must land
        # inside that window even when the child is still running at SIGTERM.
        sigterm_delay = 0.3
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            _store(root / "project", "ordinary event")
            sender = threading.Timer(sigterm_delay, os.kill, (os.getpid(), signal.SIGTERM))
            sender.start()
            self.addCleanup(sender.cancel)
            status, summary, elapsed = self._run(root, [sys.executable, "-c", "import time; time.sleep(30)"], "import time; time.sleep(30)", export_budget=30)
            self.assertEqual(status, 143)
            self.assertLess(elapsed - sigterm_delay, 2)
            self.assertEqual(summary["adapter_settlement"], "harbor-cancellation")
            self.assertEqual(summary["evidence_withheld"], "export_deadline")


if __name__ == "__main__":
    unittest.main()
